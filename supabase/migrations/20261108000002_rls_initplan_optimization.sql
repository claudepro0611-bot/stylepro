-- RLS initPlan optimization (pure performance change, no semantic change).
--
-- Problem
--   Almost every RLS policy in public is written as
--     company_id = public.get_company_id()
--   (plus id = auth.uid(), public.is_super_admin(), ...). get_company_id() is a
--   SECURITY DEFINER SQL function, so the planner cannot inline it, and because
--   it appears as a plain function call in the qual it is evaluated once PER
--   ROW scanned. On large tables (transactions, transaction_items,
--   stock_out_entries, ...) that is one extra SELECT on public.users per row.
--
-- Fix (Supabase-recommended)
--   Wrap each such call in a scalar sub-select:
--     company_id = (SELECT public.get_company_id())
--   An uncorrelated scalar sub-select becomes an InitPlan that is evaluated
--   ONCE per statement and its result reused for every row. All wrapped
--   functions are STABLE and take no row columns (zero-arg, or has_permission
--   with a string literal), so their value is constant within a statement and
--   the result of every policy is identical; only the evaluation count changes.
--
-- Approach: dynamic rewrite over pg_policies (not hand-written ALTERs)
--   * It operates on the LIVE policy definitions, so it is correct even if a
--     policy was later dropped/recreated by another migration or edited in the
--     dashboard, and it automatically covers every table instead of relying on
--     a hand-maintained list of ~50 policies.
--   * pg_policies.qual / with_check are deparsed expressions, e.g.
--       (company_id = get_company_id())
--       ( SELECT get_company_id() AS get_company_id)      <- already wrapped
--       (( SELECT users.role FROM users WHERE (users.id = auth.uid())) = 'owner'::text)
--     The regexes below match that deparsed form. search_path is pinned to
--     `public` for the duration of the block so that deparse (reading
--     pg_policies) and re-parse (ALTER POLICY) resolve names identically.
--   * Rewrite per expression:
--       1. Detect: strip every already-wrapped form "( SELECT f(...) [AS x])",
--          then look for any remaining bare call. No bare call -> untouched.
--       2. Rewrite: unwrap already-wrapped forms back to bare calls, then wrap
--          every bare call as "(SELECT f(...))". This guarantees no
--          double-wrapping ((SELECT (SELECT f()))) on any mix of forms.
--   * A bare call is only matched when it is not preceded by an identifier
--     char or '.', so e.g. "my_get_company_id()" or "other.uid()" never match.
--   * has_permission(...) is wrapped ONLY when its argument is a string
--     literal ('key'::text). Any other argument (could be a column) is left
--     alone and reported with a NOTICE. (No current policy uses it.)
--   * Only the clauses that changed are re-specified: USING only if the policy
--     had a USING (qual) and it changed; WITH CHECK only if it had one and it
--     changed. Command (FOR ...), roles (TO ...) and PERMISSIVE/RESTRICTIVE
--     are untouched (ALTER POLICY without TO keeps roles).
--   * A post-check re-reads pg_policies and aborts the whole block (rolling
--     back every ALTER) if any public policy still contains a bare call.
--
-- Scope
--   schemaname = 'public' ONLY. storage.objects policies
--   (product_images_company_insert/update/delete, 20261105000002) also call
--   public.get_company_id(), but storage.objects is owned by the storage admin
--   role and is intentionally NOT touched here.
--
-- Idempotency
--   Re-running is a no-op: after the first run every call is in the wrapped
--   deparsed form "( SELECT get_company_id() AS get_company_id)", which the
--   detect step strips, so no policy is altered again. No DROP / CREATE.
--
-- No app code change, no grant change, no client deploy dependency.

DO $rls_initplan$
DECLARE
  -- Call patterns (ARE regex, case-insensitive). Only zero-arg functions or
  -- has_permission with a string literal: none of them can reference a row.
  v_calls text[] := ARRAY[
    '(?:public\.)?get_company_id\(\)',
    '(?:public\.)?is_super_admin\(\)',
    '(?:public\.)?has_permission\(''(?:[^'']|'''')*''::text\)',
    'auth\.uid\(\)',
    'auth\.jwt\(\)'
  ];
  v_call        text;
  v_wrapped_re  text;
  v_bare_re     text;
  r             record;
  v_expr_in     text;
  v_expr_out    text;
  v_probe       text;
  v_needs       boolean;
  v_new_qual    text;
  v_new_check   text;
  v_sql         text;
  v_altered     int := 0;
  v_seen        int := 0;
  v_which       int;
BEGIN
  -- Pin name resolution for deparse (pg_policies) and re-parse (ALTER POLICY).
  -- is_local = true: reverts at end of this transaction.
  PERFORM set_config('search_path', 'public', true);

  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  LOOP
    v_seen      := v_seen + 1;
    v_new_qual  := NULL;
    v_new_check := NULL;

    -- Report has_permission calls with a non-literal argument (left as-is).
    IF coalesce(r.qual, '') || ' ' || coalesce(r.with_check, '') ~* 'has_permission\('
       AND regexp_replace(
             coalesce(r.qual, '') || ' ' || coalesce(r.with_check, ''),
             'has_permission\(''(?:[^'']|'''')*''::text\)', '', 'gi'
           ) ~* 'has_permission\(' THEN
      RAISE NOTICE 'rls_initplan: SKIP has_permission with non-literal argument in %.% policy "%" (left unwrapped)',
        r.schemaname, r.tablename, r.policyname;
    END IF;

    -- v_which = 1 -> USING (qual), 2 -> WITH CHECK (with_check)
    FOR v_which IN 1..2 LOOP
      v_expr_in := CASE v_which WHEN 1 THEN r.qual ELSE r.with_check END;
      CONTINUE WHEN v_expr_in IS NULL;

      -- 1. Detect: strip already-wrapped forms, look for remaining bare calls.
      v_probe := v_expr_in;
      FOREACH v_call IN ARRAY v_calls LOOP
        v_wrapped_re := '\(\s*SELECT\s+(' || v_call || ')(?:\s+AS\s+[[:alnum:]_"]+)?\s*\)';
        v_probe := regexp_replace(v_probe, v_wrapped_re, '', 'gi');
      END LOOP;

      v_needs := false;
      FOREACH v_call IN ARRAY v_calls LOOP
        v_bare_re := '(^|[^[:alnum:]_.])(' || v_call || ')';
        IF v_probe ~* v_bare_re THEN
          v_needs := true;
        END IF;
      END LOOP;

      CONTINUE WHEN NOT v_needs;

      -- 2. Rewrite: unwrap existing wrapped forms, then wrap every bare call.
      v_expr_out := v_expr_in;
      FOREACH v_call IN ARRAY v_calls LOOP
        v_wrapped_re := '\(\s*SELECT\s+(' || v_call || ')(?:\s+AS\s+[[:alnum:]_"]+)?\s*\)';
        v_expr_out := regexp_replace(v_expr_out, v_wrapped_re, '\1', 'gi');
      END LOOP;
      FOREACH v_call IN ARRAY v_calls LOOP
        v_bare_re := '(^|[^[:alnum:]_.])(' || v_call || ')';
        v_expr_out := regexp_replace(v_expr_out, v_bare_re, '\1(SELECT \2)', 'gi');
      END LOOP;

      IF v_which = 1 THEN
        v_new_qual := v_expr_out;
      ELSE
        v_new_check := v_expr_out;
      END IF;
    END LOOP;

    CONTINUE WHEN v_new_qual IS NULL AND v_new_check IS NULL;

    v_sql := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    IF v_new_qual IS NOT NULL THEN
      v_sql := v_sql || format(' USING (%s)', v_new_qual);
    END IF;
    IF v_new_check IS NOT NULL THEN
      v_sql := v_sql || format(' WITH CHECK (%s)', v_new_check);
    END IF;

    EXECUTE v_sql;
    v_altered := v_altered + 1;

    RAISE NOTICE 'rls_initplan: altered %.% policy "%"%',
      r.schemaname, r.tablename, r.policyname,
      CASE WHEN v_new_qual  IS NOT NULL THEN E'\n    USING      ' || r.qual       || E'\n            -> ' || v_new_qual  ELSE '' END
      || CASE WHEN v_new_check IS NOT NULL THEN E'\n    WITH CHECK ' || r.with_check || E'\n            -> ' || v_new_check ELSE '' END;
  END LOOP;

  -- Post-check: no public policy may still contain a bare (unwrapped) call.
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    v_probe := coalesce(r.qual, '') || ' ' || coalesce(r.with_check, '');
    FOREACH v_call IN ARRAY v_calls LOOP
      v_wrapped_re := '\(\s*SELECT\s+(' || v_call || ')(?:\s+AS\s+[[:alnum:]_"]+)?\s*\)';
      v_probe := regexp_replace(v_probe, v_wrapped_re, '', 'gi');
    END LOOP;
    FOREACH v_call IN ARRAY v_calls LOOP
      v_bare_re := '(^|[^[:alnum:]_.])(' || v_call || ')';
      IF v_probe ~* v_bare_re THEN
        RAISE EXCEPTION 'rls_initplan: post-check failed, %.% policy "%" still has an unwrapped call: %',
          r.schemaname, r.tablename, r.policyname, v_probe;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'rls_initplan: scanned % public policies, altered %', v_seen, v_altered;
END
$rls_initplan$;
