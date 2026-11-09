-- Branches (filiallar) - PHASE 1, file 3 of 3: re-create transactions_net
-- so it exposes the current transactions columns (branch_id, gift_amount,
-- manual_discount, ...).
--
-- (The branch helper functions and the prevent_role_escalation branch_id
-- guard originally planned for this file live in 20261109000002 - they must
-- go live in the same transaction that adds/NOT NULLs branch_id, see the
-- header of that file.)
--
-- WARNING - DROP VIEW: public.transactions_net is dropped and re-created.
-- No data loss (it is a plain view). Why not CREATE OR REPLACE: the view
-- was defined as "t.*", which Postgres froze to the transactions column
-- list of 20260717000001. Columns added to transactions since then
-- (gift_amount, manual_discount, branch_id) would have to be inserted
-- BEFORE returned_amount/net_amount,
-- and CREATE OR REPLACE VIEW only allows appending columns at the end, so
-- it errors. DROP is RESTRICT (no CASCADE): if anything in the live DB
-- depends on the view the whole file aborts and nothing changes.
--
-- Definition is unchanged from 20260717000001 (security_invoker = true,
-- same LEFT JOIN on returns/return_items); only the expansion of t.* is new.
-- Every existing column keeps its name and type, so every current
-- .from('transactions_net') select keeps working; new columns are additive.
--
-- Grants: the original migration did GRANT SELECT TO authenticated and
-- REVOKE INSERT/UPDATE/DELETE FROM authenticated (no later migration
-- touches it). Restored here explicitly, plus anon is revoked (anon could
-- never see rows - security_invoker + RLS on transactions - but a re-created
-- view would otherwise silently re-receive Supabase's default anon grants).
--
-- Runs as one transaction (BEGIN/COMMIT).

BEGIN;

DO $preflight$
DECLARE
  v_deps text;
  v_funcs text;
BEGIN
  IF to_regclass('public.transactions_net') IS NOT NULL THEN
    SELECT string_agg(DISTINCT dep.oid::regclass::text, ', ')
    INTO v_deps
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class dep ON dep.oid = r.ev_class
    WHERE d.refobjid = 'public.transactions_net'::regclass
      AND dep.oid <> 'public.transactions_net'::regclass;

    IF v_deps IS NOT NULL THEN
      RAISE EXCEPTION 'transactions_net has dependent views (%); handle them before re-creating it', v_deps;
    END IF;
  END IF;

  -- plpgsql bodies are not tracked by pg_depend; report them (only
  -- columns are added, so they keep working).
  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO v_funcs
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosrc ILIKE '%transactions_net%';

  IF v_funcs IS NOT NULL THEN
    RAISE NOTICE 'functions referencing transactions_net (unaffected, columns only added): %', v_funcs;
  END IF;
END
$preflight$;

DROP VIEW IF EXISTS public.transactions_net;

CREATE VIEW public.transactions_net
WITH (security_invoker = true) AS
SELECT
  t.*,
  COALESCE(r.returned_amount, 0) AS returned_amount,
  t.total_amount - COALESCE(r.returned_amount, 0) AS net_amount
FROM public.transactions t
LEFT JOIN (
  SELECT ret.transaction_id, sum(ri.refund_amount) AS returned_amount
  FROM public.returns ret
  JOIN public.return_items ri ON ri.return_id = ret.id
  GROUP BY ret.transaction_id
) r ON r.transaction_id = t.id;

COMMENT ON VIEW public.transactions_net IS
  'transactions + returned_amount + net_amount (revenue net of returns). '
  'security_invoker: honours the caller''s RLS on transactions/returns/return_items. '
  'Uses t.* - must be DROPped and re-created whenever transactions gains columns.';

REVOKE ALL ON public.transactions_net FROM anon, authenticated;
GRANT SELECT ON public.transactions_net TO authenticated;
GRANT SELECT ON public.transactions_net TO service_role;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- new columns visible (expect branch_id, gift_amount, manual_discount, returned_amount, net_amount)
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'transactions_net'
-- ORDER BY ordinal_position;
--
-- -- security_invoker still on (expect {security_invoker=true})
-- SELECT reloptions FROM pg_class WHERE oid = 'public.transactions_net'::regclass;
--
-- -- grants (expect authenticated: SELECT only; no anon row)
-- SELECT grantee, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND table_name = 'transactions_net' GROUP BY grantee;
--
-- -- totals unchanged vs. the base table (expect 0)
-- SELECT count(*) FROM public.transactions_net v JOIN public.transactions t ON t.id = v.id
-- WHERE v.total_amount <> t.total_amount;
