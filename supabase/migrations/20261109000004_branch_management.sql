-- Branches (filiallar) - PHASE 2 (DB): branch management RPCs, warehouse
-- RPCs gain a branch, and the companies plan/billing column guard is
-- extended.
--
-- Contents
--   0) branch_require_admin()         internal: owner/admin gate -> company_id
--   1) create_branch(name, address, phone)          -> uuid
--   2) update_branch(id, name, address, phone)      -> void
--   3) set_branch_active(id, active)                -> void
--   4) set_default_branch(id)                       -> void
--   5) delete_branch(id)                            -> void
--   6) branch_overview()                            -> TABLE (any company user)
--   7) create_warehouse / update_warehouse + p_branch_id uuid DEFAULT NULL
--   8) check_companies_billing_column_access: every plan/limit/billing
--      column is service-role only (closes the owner warehouse_limit /
--      user_limit self-raise gap found in Phase 1).
--
-- Access model: public.branches keeps INSERT/UPDATE/DELETE revoked from
-- authenticated (20261109000001). Every write below is a SECURITY DEFINER
-- RPC with search_path pinned; company_id always comes from the caller's
-- users row, never from arguments; every lookup is scoped by company_id.
--
-- Gate: the branch write RPCs are role-gated (owner or admin, status
-- 'active') rather than has_permission()-gated: branch management is a
-- company-structure operation reserved for the all-branch roles, and a
-- permission key would let a manager with that key reconfigure branches
-- they cannot even see. Non-owner/admin -> 'forbidden'.
--
-- Locking (no read-then-write without a row lock):
--   * set_branch_active(false) and delete_branch take FOR UPDATE on the
--     branch row. Every insert/FK-column update in a child table takes
--     FOR KEY SHARE on the referenced branch row (composite FK check), and
--     FOR UPDATE conflicts with it - so no shift/user/row can be attached
--     to the branch between our emptiness check and our write.
--   * update_branch / reactivation / set_default_branch take
--     FOR NO KEY UPDATE (they never change id/company_id, so they do not
--     block concurrent sales in that branch).
--   * set_default_branch locks all of the company's branch rows in id
--     order, so two concurrent swaps serialize without deadlocking.
--   * update_warehouse locks the warehouse row FOR UPDATE before its
--     emptiness check (same FK KEY SHARE argument for product_sizes etc.).
--
-- WARNING - DROP FUNCTION (no data loss): create_warehouse(text, text) and
-- update_warehouse(uuid, text, text) are dropped and re-created with an
-- extra trailing p_branch_id uuid DEFAULT NULL. Both happen inside this
-- transaction, so there is no window without the function. Existing
-- named-arg calls ({p_name, p_type} / {p_id, p_name, p_type}) resolve to
-- the new signatures unchanged. PostgREST schema cache is reloaded at the
-- end (NOTIFY pgrst).
--
-- Runs as one transaction (BEGIN/COMMIT).

BEGIN;

-- ─── 0) Internal gate ──────────────────────────────────────────────────────
-- Returns the caller's company_id if the caller is an active owner/admin of
-- a company; otherwise 'forbidden'. Not callable by clients (EXECUTE is
-- checked against the definer when called from another SECURITY DEFINER
-- function).

CREATE OR REPLACE FUNCTION public.branch_require_admin()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT u.company_id INTO v_company_id
  FROM public.users u
  WHERE u.id = auth.uid()
    AND u.role IN ('owner', 'admin')
    AND u.status = 'active';

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN v_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.branch_require_admin() FROM PUBLIC, anon, authenticated;

-- ─── 1) create_branch ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_branch(
  p_name text,
  p_address text DEFAULT NULL,
  p_phone text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_name text;
  v_id uuid;
BEGIN
  v_company_id := public.branch_require_admin();

  v_name := btrim(COALESCE(p_name, ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'branch_name_required';
  END IF;

  -- Clean error for the common case; the unique index
  -- branches_company_name_key is the real (race-proof) guard below.
  IF EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.company_id = v_company_id
      AND lower(btrim(b.name)) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'branch_name_taken';
  END IF;

  BEGIN
    -- enforce_branch_limit (BEFORE INSERT) locks the companies row and
    -- raises 'branch_limit_reached: max % branches allowed'.
    INSERT INTO public.branches (company_id, name, address, phone, is_default, is_active)
    VALUES (v_company_id, v_name,
            NULLIF(btrim(p_address), ''), NULLIF(btrim(p_phone), ''),
            false, true)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- is_default = false, so the only index that can fire is the name one.
      RAISE EXCEPTION 'branch_name_taken';
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'branch_limit_reached%' THEN
        RAISE EXCEPTION 'branch_limit_reached';
      END IF;
      RAISE;
  END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_branch(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_branch(text, text, text) TO authenticated;

-- ─── 2) update_branch ──────────────────────────────────────────────────────
-- Full replace: address/phone NULL or blank clears the field.

CREATE OR REPLACE FUNCTION public.update_branch(
  p_id uuid,
  p_name text,
  p_address text DEFAULT NULL,
  p_phone text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_name text;
BEGIN
  v_company_id := public.branch_require_admin();

  v_name := btrim(COALESCE(p_name, ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'branch_name_required';
  END IF;

  PERFORM 1 FROM public.branches b
  WHERE b.id = p_id AND b.company_id = v_company_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch_not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.company_id = v_company_id
      AND b.id <> p_id
      AND lower(btrim(b.name)) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'branch_name_taken';
  END IF;

  BEGIN
    UPDATE public.branches
    SET name = v_name,
        address = NULLIF(btrim(p_address), ''),
        phone = NULLIF(btrim(p_phone), '')
    WHERE id = p_id AND company_id = v_company_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'branch_name_taken';
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.update_branch(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_branch(uuid, text, text, text) TO authenticated;

-- ─── 3) set_branch_active ──────────────────────────────────────────────────
-- Deactivate: not the default, no open shift (shifts.status 'active'), no
-- active manager/staff homed there (they are locked to their branch and
-- resolve_branch_id does not re-check is_active for them). Reactivate:
-- always allowed. Same-state calls are no-ops.

CREATE OR REPLACE FUNCTION public.set_branch_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_is_default boolean;
  v_is_active boolean;
BEGIN
  v_company_id := public.branch_require_admin();

  IF p_active IS NULL THEN
    RAISE EXCEPTION 'p_active is required';
  END IF;

  IF p_active THEN
    UPDATE public.branches
    SET is_active = true
    WHERE id = p_id AND company_id = v_company_id
      AND NOT is_active;
    IF NOT FOUND AND NOT EXISTS (
      SELECT 1 FROM public.branches b
      WHERE b.id = p_id AND b.company_id = v_company_id
    ) THEN
      RAISE EXCEPTION 'branch_not_found';
    END IF;
    RETURN;
  END IF;

  -- FOR UPDATE (not NO KEY): blocks concurrent FK attachments (new shift,
  -- user moved in) until we commit.
  SELECT b.is_default, b.is_active INTO v_is_default, v_is_active
  FROM public.branches b
  WHERE b.id = p_id AND b.company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch_not_found';
  END IF;

  IF NOT v_is_active THEN
    RETURN;
  END IF;

  IF v_is_default THEN
    RAISE EXCEPTION 'branch_is_default';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.company_id = v_company_id
      AND s.branch_id = p_id
      AND s.status = 'active'
  ) THEN
    RAISE EXCEPTION 'branch_has_open_shift';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.company_id = v_company_id
      AND u.branch_id = p_id
      AND u.status = 'active'
      AND u.role NOT IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'branch_has_users';
  END IF;

  UPDATE public.branches
  SET is_active = false
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_branch_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_branch_active(uuid, boolean) TO authenticated;

-- ─── 4) set_default_branch ─────────────────────────────────────────────────
-- Unset old default first (partial unique index is not deferrable), then
-- set the new one. branches_default_is_active holds because the target
-- is checked active under lock.

CREATE OR REPLACE FUNCTION public.set_default_branch(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_is_default boolean;
  v_is_active boolean;
BEGIN
  v_company_id := public.branch_require_admin();

  -- Serialize all default/active changes for this company; id order
  -- prevents deadlocks between concurrent callers.
  PERFORM 1 FROM public.branches b
  WHERE b.company_id = v_company_id
  ORDER BY b.id
  FOR NO KEY UPDATE;

  SELECT b.is_default, b.is_active INTO v_is_default, v_is_active
  FROM public.branches b
  WHERE b.id = p_id AND b.company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch_not_found';
  END IF;

  IF v_is_default THEN
    RETURN;
  END IF;

  IF NOT v_is_active THEN
    RAISE EXCEPTION 'branch_inactive';
  END IF;

  UPDATE public.branches
  SET is_default = false
  WHERE company_id = v_company_id AND is_default;

  UPDATE public.branches
  SET is_default = true
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_default_branch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_default_branch(uuid) TO authenticated;

-- ─── 5) delete_branch ──────────────────────────────────────────────────────
-- 'branch_not_empty' if any row in any table with a foreign key to
-- public.branches references it. The table list is read from pg_constraint
-- (covers every Phase 1 table - users, warehouses, product_sizes,
-- transactions, transaction_items, stock_in/out_entries, shifts, returns,
-- customers, nasiya/loyalty_transactions, expenses, stock_counts,
-- supplier_returns, requests, stock_transfers from/to - and any future one).
-- The composite FKs (NO ACTION) remain the hard backstop.

CREATE OR REPLACE FUNCTION public.delete_branch(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_is_default boolean;
  v_ref record;
  v_found boolean;
BEGIN
  v_company_id := public.branch_require_admin();

  SELECT b.is_default INTO v_is_default
  FROM public.branches b
  WHERE b.id = p_id AND b.company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch_not_found';
  END IF;

  IF v_is_default THEN
    RAISE EXCEPTION 'branch_is_default';
  END IF;

  FOR v_ref IN
    SELECT c.conrelid::regclass::text AS tbl,
           max(a.attname::text) FILTER (WHERE fa.attname = 'id')         AS id_col,
           max(a.attname::text) FILTER (WHERE fa.attname = 'company_id') AS company_col
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(ck, fk)
    JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fk
    JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = k.ck
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.branches'::regclass
    GROUP BY c.oid, c.conrelid
  LOOP
    IF v_ref.id_col IS NULL THEN
      CONTINUE;
    END IF;

    IF v_ref.company_col IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1 AND %I = $2)',
                     v_ref.tbl, v_ref.id_col, v_ref.company_col)
        INTO v_found USING p_id, v_company_id;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)',
                     v_ref.tbl, v_ref.id_col)
        INTO v_found USING p_id;
    END IF;

    IF v_found THEN
      RAISE EXCEPTION 'branch_not_empty';
    END IF;
  END LOOP;

  DELETE FROM public.branches
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_branch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_branch(uuid) TO authenticated;

-- ─── 6) branch_overview ────────────────────────────────────────────────────
-- Any user of a company. Caller without a company -> zero rows.
-- user_count = users with status 'active' homed in the branch (all roles).

CREATE OR REPLACE FUNCTION public.branch_overview()
RETURNS TABLE (
  id uuid,
  name text,
  address text,
  phone text,
  is_default boolean,
  is_active boolean,
  created_at timestamptz,
  warehouse_count int,
  user_count int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT b.id, b.name, b.address, b.phone, b.is_default, b.is_active, b.created_at,
         (SELECT count(*)::int FROM public.warehouses w
          WHERE w.company_id = b.company_id AND w.branch_id = b.id),
         (SELECT count(*)::int FROM public.users u
          WHERE u.company_id = b.company_id AND u.branch_id = b.id
            AND u.status = 'active')
  FROM public.branches b
  WHERE b.company_id = (SELECT public.get_company_id())
  ORDER BY b.is_default DESC, lower(b.name), b.id;
$$;

REVOKE ALL ON FUNCTION public.branch_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.branch_overview() TO authenticated;

-- ─── 7a) create_warehouse + p_branch_id ────────────────────────────────────
-- Based on the only definition, 20260721000001_warehouse_types.sql. Same
-- permission ('inventory'), same error strings, same warehouse_limit check.
-- Added: branch = resolve_branch_id(p_branch_id) (owner/admin: active
-- branch of the company, NULL -> own active branch -> default; manager/
-- staff: always their own branch, another one -> 'branch_forbidden'),
-- passed explicitly on insert.

DROP FUNCTION IF EXISTS public.create_warehouse(text, text);

CREATE FUNCTION public.create_warehouse(
  p_name text,
  p_type text,
  p_branch_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_limit integer;
  v_count integer;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Warehouse name is required';
  END IF;

  v_branch_id := public.resolve_branch_id(p_branch_id);

  SELECT warehouse_limit INTO v_limit FROM public.companies WHERE id = v_company_id;
  SELECT count(*) INTO v_count FROM public.warehouses WHERE company_id = v_company_id;
  IF v_count >= COALESCE(v_limit, 2) THEN
    RAISE EXCEPTION 'Warehouse limit reached' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.warehouses (company_id, branch_id, name, type)
  VALUES (v_company_id, v_branch_id, trim(p_name), p_type)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_warehouse(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_warehouse(text, text, uuid) TO authenticated;

-- ─── 7b) update_warehouse + p_branch_id ────────────────────────────────────
-- Based on 20260721000001. Same permission, error strings, name/type logic.
-- Added: p_branch_id NULL (or equal to the current branch) = branch
-- unchanged. A real move requires
--   * access to the warehouse's current branch (assert_branch_access) and
--     a valid target (resolve_branch_id) - together this means only
--     owner/admin can move, since a scoped user's only branch is their own;
--   * the warehouse to be empty: no product_sizes rows, and no
--     stock_counts / supplier_returns / stock_transfers rows (their
--     branch_id is a denormalized copy of the warehouse's branch and would
--     otherwise drift) -> else 'warehouse_not_empty'.
-- The warehouse row is locked FOR UPDATE before the check.

DROP FUNCTION IF EXISTS public.update_warehouse(uuid, text, text);

CREATE FUNCTION public.update_warehouse(
  p_id uuid,
  p_name text,
  p_type text,
  p_branch_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_current_branch uuid;
  v_target_branch uuid;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Warehouse name is required';
  END IF;

  SELECT w.branch_id INTO v_current_branch
  FROM public.warehouses w
  WHERE w.id = p_id AND w.company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;

  v_target_branch := v_current_branch;

  IF p_branch_id IS NOT NULL AND p_branch_id <> v_current_branch THEN
    PERFORM public.assert_branch_access(v_current_branch);
    v_target_branch := public.resolve_branch_id(p_branch_id);

    IF v_target_branch <> v_current_branch THEN
      IF EXISTS (SELECT 1 FROM public.product_sizes ps
                 WHERE ps.warehouse_id = p_id AND ps.company_id = v_company_id)
         OR EXISTS (SELECT 1 FROM public.stock_counts sc
                    WHERE sc.warehouse_id = p_id AND sc.company_id = v_company_id)
         OR EXISTS (SELECT 1 FROM public.supplier_returns sr
                    WHERE sr.warehouse_id = p_id AND sr.company_id = v_company_id)
         OR EXISTS (SELECT 1 FROM public.stock_transfers st
                    WHERE st.company_id = v_company_id
                      AND (st.from_warehouse_id = p_id OR st.to_warehouse_id = p_id))
      THEN
        RAISE EXCEPTION 'warehouse_not_empty';
      END IF;
    END IF;
  END IF;

  UPDATE public.warehouses
  SET name = trim(p_name),
      type = COALESCE(p_type, type),
      branch_id = v_target_branch
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_warehouse(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_warehouse(uuid, text, text, uuid) TO authenticated;

-- ─── 8) companies: every plan/limit/billing column is platform-only ───────
-- Based on 20260715000005_companies_owner_only_billing_guard.sql. Same
-- semantics (any real end-user session is blocked, regardless of role;
-- service role / pg_cron / migrations - no users row for auth.uid() -
-- pass), same error message. Changes:
--   * guarded columns: balance, monthly_fee (as before) PLUS
--     user_limit, warehouse_limit, status, billing_status,
--     next_payment_date, last_payment_date, payment_due_date,
--     has_contract, daily_penalty, penalty_days, total_penalty,
--     grace_period_start, max_grace_days.
--     (branch_limit keeps its own trigger, check_companies_branch_limit_access.)
--   * search_path pinned with pg_temp.
-- Still owner-editable via "Owner can update own company": name, slug,
-- phone, address, currency, max_discount_percent, max_gift_percent,
-- gift_staff_allowed. Every platform writer (super-admin/actions.ts
-- createFirm/updateCompany/updateCompanyBilling, daily-penalty-check cron)
-- runs without a user JWT, so nothing legitimate is blocked.
-- The trigger check_companies_billing_column_access already points at this
-- function; CREATE OR REPLACE keeps it attached.

CREATE OR REPLACE FUNCTION public.check_companies_billing_column_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();

  IF caller_role IS NOT NULL THEN
    IF NEW.balance            IS DISTINCT FROM OLD.balance
       OR NEW.monthly_fee        IS DISTINCT FROM OLD.monthly_fee
       OR NEW.user_limit         IS DISTINCT FROM OLD.user_limit
       OR NEW.warehouse_limit    IS DISTINCT FROM OLD.warehouse_limit
       OR NEW.status             IS DISTINCT FROM OLD.status
       OR NEW.billing_status     IS DISTINCT FROM OLD.billing_status
       OR NEW.next_payment_date  IS DISTINCT FROM OLD.next_payment_date
       OR NEW.last_payment_date  IS DISTINCT FROM OLD.last_payment_date
       OR NEW.payment_due_date   IS DISTINCT FROM OLD.payment_due_date
       OR NEW.has_contract       IS DISTINCT FROM OLD.has_contract
       OR NEW.daily_penalty      IS DISTINCT FROM OLD.daily_penalty
       OR NEW.penalty_days       IS DISTINCT FROM OLD.penalty_days
       OR NEW.total_penalty      IS DISTINCT FROM OLD.total_penalty
       OR NEW.grace_period_start IS DISTINCT FROM OLD.grace_period_start
       OR NEW.max_grace_days     IS DISTINCT FROM OLD.max_grace_days
    THEN
      RAISE EXCEPTION 'Unauthorized: only the platform can change billing fields';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- signatures + grants (authenticated true, anon false; branch_require_admin false/false)
-- SELECT p.oid::regprocedure,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
--        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
--        p.prosecdef, p.proconfig
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname IN
--   ('branch_require_admin','create_branch','update_branch','set_branch_active',
--    'set_default_branch','delete_branch','branch_overview','create_warehouse',
--    'update_warehouse','check_companies_billing_column_access')
-- ORDER BY 1;
--
-- -- exactly one create_warehouse and one update_warehouse overload (expect 1, 1)
-- SELECT proname, count(*) FROM pg_proc
-- WHERE pronamespace = 'public'::regnamespace AND proname IN ('create_warehouse','update_warehouse')
-- GROUP BY proname;
--
-- -- FK tables delete_branch will scan (expect the 17 Phase 1 constraints)
-- SELECT conrelid::regclass, conname FROM pg_constraint
-- WHERE contype = 'f' AND confrelid = 'public.branches'::regclass ORDER BY 1, 2;
