-- Branches (filiallar) - PHASE 1, file 2 of 3: branch_id columns,
-- backfill, branch helper functions, legacy-compatible fill triggers,
-- NOT NULL + composite FKs, indexes, handle_new_company v2 and the
-- branch_id guard in prevent_role_escalation.
--
-- WHY THE HELPERS LIVE HERE (and not in file 3):
--   The fill triggers below call resolve_branch_id(), and the moment
--   branch_id becomes NOT NULL every live write path (sell_cart, stock_in,
--   POS shift insert, ...) depends on those triggers. If the helpers were in
--   a later file there would be a window (file 2 applied, file 3 not yet)
--   in which every sale fails. The helpers are LANGUAGE sql/plpgsql bodies
--   that read users.branch_id, so they must come AFTER the column is added.
--   Likewise the prevent_role_escalation branch_id guard must go live in
--   the same transaction that makes users.branch_id writable, otherwise a
--   staff user could change their own branch through the
--   "Users can update own profile" policy in the window. File 3 therefore
--   only re-creates the transactions_net view.
--
-- Zero behaviour change:
--   * Nothing that exists today passes branch_id. Every insert path keeps
--     working because a BEFORE INSERT trigger fills branch_id from the
--     parent row (warehouse / product_size / transaction / customer), else
--     from resolve_branch_id(NULL) for the calling user, else the company's
--     default branch (service-role / no-JWT writers, e.g. telegram webhook).
--   * No existing RLS policy is changed. No grant on an existing table is
--     changed. Existing RPC bodies are not changed.
--   * Backfill does not bump updated_at (updated_at triggers are disabled
--     for the backfill only, inside this transaction).
--
-- FK choice: ON DELETE NO ACTION (not RESTRICT). Deleting a company
-- cascades both to branches and to every child table in the SAME
-- statement; RESTRICT is checked immediately during the cascade and can
-- fail depending on cascade order (super-admin deleteFirm would break).
-- NO ACTION is checked at end of statement, after all cascades are done.
-- For a direct DELETE of a branch that still has rows, both behave the
-- same: the delete is rejected.
--
-- Runs as one transaction (BEGIN/COMMIT).

BEGIN;

-- ─── 0) Preflight ──────────────────────────────────────────────────────────

DO $preflight$
DECLARE
  v_t text;
  v_missing int;
BEGIN
  FOREACH v_t IN ARRAY ARRAY[
    'branches', 'users', 'warehouses', 'product_sizes', 'transactions',
    'transaction_items', 'stock_out_entries', 'stock_in_entries', 'shifts',
    'returns', 'customers', 'nasiya_transactions', 'loyalty_transactions',
    'expenses', 'stock_counts', 'supplier_returns', 'requests', 'stock_transfers'
  ] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE EXCEPTION 'branch_columns preflight: table public.% does not exist', v_t;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_missing
  FROM public.companies c
  WHERE (SELECT count(*) FROM public.branches b
         WHERE b.company_id = c.id AND b.is_default) <> 1;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'branch_columns preflight: % companies without exactly one default branch (apply 20261109000001 first)', v_missing;
  END IF;
END
$preflight$;

-- ─── 1) Columns (nullable for now) ─────────────────────────────────────────

ALTER TABLE public.users                ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.warehouses           ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.product_sizes        ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.transactions         ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.transaction_items    ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.stock_out_entries    ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.stock_in_entries     ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.shifts               ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.returns              ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.customers            ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.nasiya_transactions  ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.loyalty_transactions ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.expenses             ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.stock_counts         ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.supplier_returns     ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.requests             ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.stock_transfers
  ADD COLUMN IF NOT EXISTS from_branch_id uuid,
  ADD COLUMN IF NOT EXISTS to_branch_id uuid;

COMMENT ON COLUMN public.users.branch_id IS
  'Home branch. manager/staff are locked to it; owner/admin see all branches. '
  'NULL only while company_id IS NULL. Changeable only by owner/admin of the '
  'same company or the service role (prevent_role_escalation).';
COMMENT ON COLUMN public.product_sizes.branch_id IS
  'Denormalized from warehouses.branch_id (always re-derived by trigger).';
COMMENT ON COLUMN public.transaction_items.branch_id IS
  'Denormalized from transactions.branch_id (always re-derived by trigger).';

-- ─── 2) Backfill ───────────────────────────────────────────────────────────
-- Suppress updated_at bumps for the backfill only (re-enabled below, same
-- transaction).
ALTER TABLE public.users        DISABLE TRIGGER users_set_updated_at;
ALTER TABLE public.customers    DISABLE TRIGGER customers_set_updated_at;
ALTER TABLE public.requests     DISABLE TRIGGER requests_set_updated_at;
ALTER TABLE public.stock_counts DISABLE TRIGGER stock_counts_set_updated_at;

-- 2a) Company default branch for every directly-owned table.
DO $backfill$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY[
    'warehouses', 'transactions', 'stock_out_entries', 'stock_in_entries',
    'shifts', 'returns', 'customers', 'nasiya_transactions',
    'loyalty_transactions', 'expenses', 'requests'
  ] LOOP
    EXECUTE format(
      'UPDATE public.%I t SET branch_id = b.id
         FROM public.branches b
        WHERE b.company_id = t.company_id AND b.is_default
          AND t.branch_id IS NULL', v_t);
  END LOOP;
END
$backfill$;

-- users: only rows that belong to a company (super admin / onboarding
-- users with company_id IS NULL stay NULL). prevent_role_escalation fires
-- here; in a migration auth.uid() is NULL so it is a no-op, as designed.
UPDATE public.users u
SET branch_id = b.id
FROM public.branches b
WHERE u.company_id IS NOT NULL
  AND b.company_id = u.company_id AND b.is_default
  AND u.branch_id IS NULL;

-- 2b) Parent-derived (denormalized) columns.
UPDATE public.product_sizes ps
SET branch_id = w.branch_id
FROM public.warehouses w
WHERE w.id = ps.warehouse_id AND ps.branch_id IS NULL;

UPDATE public.transaction_items ti
SET branch_id = t.branch_id
FROM public.transactions t
WHERE t.id = ti.transaction_id AND ti.branch_id IS NULL;

UPDATE public.stock_counts sc
SET branch_id = w.branch_id
FROM public.warehouses w
WHERE w.id = sc.warehouse_id AND sc.branch_id IS NULL;

UPDATE public.supplier_returns sr
SET branch_id = w.branch_id
FROM public.warehouses w
WHERE w.id = sr.warehouse_id AND sr.branch_id IS NULL;

UPDATE public.stock_transfers st
SET from_branch_id = wf.branch_id,
    to_branch_id   = wt.branch_id
FROM public.warehouses wf, public.warehouses wt
WHERE wf.id = st.from_warehouse_id
  AND wt.id = st.to_warehouse_id
  AND (st.from_branch_id IS NULL OR st.to_branch_id IS NULL);

ALTER TABLE public.users        ENABLE TRIGGER users_set_updated_at;
ALTER TABLE public.customers    ENABLE TRIGGER customers_set_updated_at;
ALTER TABLE public.requests     ENABLE TRIGGER requests_set_updated_at;
ALTER TABLE public.stock_counts ENABLE TRIGGER stock_counts_set_updated_at;

-- ─── 3) Branch helper functions ────────────────────────────────────────────
-- Modeled on get_company_id(): SECURITY DEFINER (reads public.users past
-- its RLS), STABLE, search_path pinned. ALL-BRANCH roles = owner, admin.

-- NULL = all branches (owner/admin). Otherwise the user's own branch.
-- Fail closed: no user row, or a scoped user without a branch, gets a
-- sentinel uuid that matches no branch.
CREATE OR REPLACE FUNCTION public.get_branch_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT CASE
           WHEN u.id IS NULL THEN '00000000-0000-0000-0000-000000000000'::uuid
           WHEN u.role IN ('owner', 'admin') THEN NULL::uuid
           ELSE COALESCE(u.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         END
  FROM (SELECT 1) AS one
  LEFT JOIN public.users u ON u.id = auth.uid()
$$;

-- Branches the caller may READ. owner/admin: every branch of the company
-- (inactive ones included, so historical data stays visible). Scoped user:
-- their own branch. Anything else: empty array.
CREATE OR REPLACE FUNCTION public.get_branch_ids()
RETURNS uuid[]
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT CASE
           WHEN u.id IS NULL OR u.company_id IS NULL THEN '{}'::uuid[]
           WHEN u.role IN ('owner', 'admin') THEN COALESCE(
             (SELECT array_agg(b.id ORDER BY b.is_default DESC, b.created_at)
              FROM public.branches b
              WHERE b.company_id = u.company_id),
             '{}'::uuid[])
           WHEN u.branch_id IS NULL THEN '{}'::uuid[]
           ELSE ARRAY[u.branch_id]
         END
  FROM (SELECT 1) AS one
  LEFT JOIN public.users u ON u.id = auth.uid()
$$;

-- Branch a WRITE by the caller should land in.
--   scoped user (manager/staff): always own branch; a different requested
--     branch -> 'branch_forbidden'; no own branch -> 'branch_forbidden'.
--   owner/admin: requested branch must be an ACTIVE branch of the company
--     (else 'branch_forbidden'); NULL -> own active branch -> company default.
CREATE OR REPLACE FUNCTION public.resolve_branch_id(p_requested uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_branch_id uuid;
  v_result uuid;
BEGIN
  SELECT company_id, role, branch_id
  INTO v_company_id, v_role, v_branch_id
  FROM public.users
  WHERE id = auth.uid();

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    IF v_branch_id IS NULL THEN
      RAISE EXCEPTION 'branch_forbidden';
    END IF;
    IF p_requested IS NOT NULL AND p_requested <> v_branch_id THEN
      RAISE EXCEPTION 'branch_forbidden';
    END IF;
    RETURN v_branch_id;
  END IF;

  IF p_requested IS NOT NULL THEN
    SELECT b.id INTO v_result
    FROM public.branches b
    WHERE b.id = p_requested
      AND b.company_id = v_company_id
      AND b.is_active;
    IF v_result IS NULL THEN
      RAISE EXCEPTION 'branch_forbidden';
    END IF;
    RETURN v_result;
  END IF;

  IF v_branch_id IS NOT NULL THEN
    SELECT b.id INTO v_result
    FROM public.branches b
    WHERE b.id = v_branch_id
      AND b.company_id = v_company_id
      AND b.is_active;
  END IF;

  IF v_result IS NULL THEN
    SELECT b.id INTO v_result
    FROM public.branches b
    WHERE b.company_id = v_company_id
      AND b.is_default;
  END IF;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'no_default_branch';
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_branch_access(p_branch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF p_branch_id IS NULL OR NOT (p_branch_id = ANY (public.get_branch_ids())) THEN
    RAISE EXCEPTION 'branch_forbidden';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_branch_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_branch_ids() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.resolve_branch_id(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assert_branch_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_branch_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_branch_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_branch_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_branch_access(uuid) TO authenticated;

-- INTERNAL (trigger use only, not callable by clients). Branch for a legacy
-- write into p_company_id that did not specify one:
--   * caller is a user of that same company -> resolve_branch_id(NULL)
--   * anything else (service role, cron, telegram webhook, migrations)
--     -> the company's default branch.
CREATE OR REPLACE FUNCTION public.branch_default_for_write(p_company_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_caller_company uuid;
  v_result uuid;
BEGIN
  IF p_company_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT company_id INTO v_caller_company
  FROM public.users
  WHERE id = auth.uid();

  IF v_caller_company IS NOT NULL AND v_caller_company = p_company_id THEN
    RETURN public.resolve_branch_id(NULL);
  END IF;

  SELECT b.id INTO v_result
  FROM public.branches b
  WHERE b.company_id = p_company_id
    AND b.is_default;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'no_default_branch for company %', p_company_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.branch_default_for_write(uuid) FROM PUBLIC, anon, authenticated;

-- ─── 4) Fill triggers (keep every existing writer working) ────────────────
-- Generic BEFORE trigger. TG_ARGV:
--   [0] parent kind: 'context' | 'warehouse' | 'product_size' | 'transaction' | 'customer'
--   [1] name of the parent FK column on NEW (ignored for 'context')
--   [2] 'force'   = always derive from the parent (pure denormalization:
--                   product_sizes, transaction_items, stock_counts,
--                   supplier_returns) - a caller-supplied value is
--                   overwritten so the copy can never drift;
--       'if_null' = only fill when the caller did not supply branch_id.
-- Parent lookups are scoped by NEW.company_id. If the parent is missing or
-- unresolvable: keep a caller-supplied value, else branch_default_for_write.
-- SECURITY DEFINER so direct client inserts (POS shifts) can call the
-- internal helper and read parents regardless of the caller's RLS.
CREATE OR REPLACE FUNCTION public.branch_fill_from_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text := TG_ARGV[0];
  v_force boolean := COALESCE(TG_ARGV[2], 'if_null') = 'force';
  v_parent_id uuid;
  v_branch uuid;
BEGIN
  IF NEW.branch_id IS NOT NULL AND NOT v_force THEN
    RETURN NEW;
  END IF;

  IF v_kind <> 'context' THEN
    v_parent_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[1], '')::uuid;

    IF v_parent_id IS NOT NULL THEN
      CASE v_kind
        WHEN 'warehouse' THEN
          SELECT w.branch_id INTO v_branch
          FROM public.warehouses w
          WHERE w.id = v_parent_id AND w.company_id = NEW.company_id;
        WHEN 'product_size' THEN
          SELECT ps.branch_id INTO v_branch
          FROM public.product_sizes ps
          WHERE ps.id = v_parent_id AND ps.company_id = NEW.company_id;
        WHEN 'transaction' THEN
          SELECT t.branch_id INTO v_branch
          FROM public.transactions t
          WHERE t.id = v_parent_id AND t.company_id = NEW.company_id;
        WHEN 'customer' THEN
          SELECT c.branch_id INTO v_branch
          FROM public.customers c
          WHERE c.id = v_parent_id AND c.company_id = NEW.company_id;
        ELSE
          RAISE EXCEPTION 'branch_fill_from_parent: unknown parent kind %', v_kind;
      END CASE;
    END IF;
  END IF;

  IF v_branch IS NULL THEN
    IF NEW.branch_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_branch := public.branch_default_for_write(NEW.company_id);
  END IF;

  NEW.branch_id := v_branch;
  RETURN NEW;
END;
$$;

-- No parent: the writer's context decides.
DROP TRIGGER IF EXISTS warehouses_fill_branch_id ON public.warehouses;
CREATE TRIGGER warehouses_fill_branch_id
  BEFORE INSERT ON public.warehouses
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('context');

DROP TRIGGER IF EXISTS transactions_fill_branch_id ON public.transactions;
CREATE TRIGGER transactions_fill_branch_id
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('context');

DROP TRIGGER IF EXISTS shifts_fill_branch_id ON public.shifts;
CREATE TRIGGER shifts_fill_branch_id
  BEFORE INSERT ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('context');

DROP TRIGGER IF EXISTS customers_fill_branch_id ON public.customers;
CREATE TRIGGER customers_fill_branch_id
  BEFORE INSERT ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('context');

DROP TRIGGER IF EXISTS expenses_fill_branch_id ON public.expenses;
CREATE TRIGGER expenses_fill_branch_id
  BEFORE INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('context');

-- From warehouse (forced; re-derived when the warehouse changes).
DROP TRIGGER IF EXISTS product_sizes_fill_branch_id ON public.product_sizes;
CREATE TRIGGER product_sizes_fill_branch_id
  BEFORE INSERT OR UPDATE OF warehouse_id ON public.product_sizes
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('warehouse', 'warehouse_id', 'force');

DROP TRIGGER IF EXISTS stock_counts_fill_branch_id ON public.stock_counts;
CREATE TRIGGER stock_counts_fill_branch_id
  BEFORE INSERT OR UPDATE OF warehouse_id ON public.stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('warehouse', 'warehouse_id', 'force');

DROP TRIGGER IF EXISTS supplier_returns_fill_branch_id ON public.supplier_returns;
CREATE TRIGGER supplier_returns_fill_branch_id
  BEFORE INSERT OR UPDATE OF warehouse_id ON public.supplier_returns
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('warehouse', 'warehouse_id', 'force');

-- From transaction.
DROP TRIGGER IF EXISTS transaction_items_fill_branch_id ON public.transaction_items;
CREATE TRIGGER transaction_items_fill_branch_id
  BEFORE INSERT OR UPDATE OF transaction_id ON public.transaction_items
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('transaction', 'transaction_id', 'force');

DROP TRIGGER IF EXISTS returns_fill_branch_id ON public.returns;
CREATE TRIGGER returns_fill_branch_id
  BEFORE INSERT ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('transaction', 'transaction_id', 'if_null');

-- From product_size (stock ledgers).
DROP TRIGGER IF EXISTS stock_out_entries_fill_branch_id ON public.stock_out_entries;
CREATE TRIGGER stock_out_entries_fill_branch_id
  BEFORE INSERT ON public.stock_out_entries
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('product_size', 'product_size_id', 'if_null');

DROP TRIGGER IF EXISTS stock_in_entries_fill_branch_id ON public.stock_in_entries;
CREATE TRIGGER stock_in_entries_fill_branch_id
  BEFORE INSERT ON public.stock_in_entries
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('product_size', 'product_size_id', 'if_null');

-- From customer.
DROP TRIGGER IF EXISTS nasiya_transactions_fill_branch_id ON public.nasiya_transactions;
CREATE TRIGGER nasiya_transactions_fill_branch_id
  BEFORE INSERT ON public.nasiya_transactions
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('customer', 'customer_id', 'if_null');

DROP TRIGGER IF EXISTS loyalty_transactions_fill_branch_id ON public.loyalty_transactions;
CREATE TRIGGER loyalty_transactions_fill_branch_id
  BEFORE INSERT ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('customer', 'customer_id', 'if_null');

DROP TRIGGER IF EXISTS requests_fill_branch_id ON public.requests;
CREATE TRIGGER requests_fill_branch_id
  BEFORE INSERT ON public.requests
  FOR EACH ROW EXECUTE FUNCTION public.branch_fill_from_parent('customer', 'customer_id', 'if_null');

-- stock_transfers: both sides always derived from their warehouses.
CREATE OR REPLACE FUNCTION public.stock_transfers_fill_branch_ids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.from_branch_id := COALESCE(
    (SELECT w.branch_id FROM public.warehouses w
     WHERE w.id = NEW.from_warehouse_id AND w.company_id = NEW.company_id),
    NEW.from_branch_id,
    public.branch_default_for_write(NEW.company_id));

  NEW.to_branch_id := COALESCE(
    (SELECT w.branch_id FROM public.warehouses w
     WHERE w.id = NEW.to_warehouse_id AND w.company_id = NEW.company_id),
    NEW.to_branch_id,
    public.branch_default_for_write(NEW.company_id));

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_transfers_fill_branch_ids ON public.stock_transfers;
CREATE TRIGGER stock_transfers_fill_branch_ids
  BEFORE INSERT OR UPDATE OF from_warehouse_id, to_warehouse_id ON public.stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.stock_transfers_fill_branch_ids();

-- users: whenever a row belongs to a company and has no branch, give it the
-- company's default branch. Covers super-admin createFirm and jamoa
-- createTeamUser (both UPDATE company_id after handle_new_user inserted the
-- row with company_id NULL). A company_id change without an explicit new
-- branch_id moves the user to the new company's default branch (the old
-- branch would violate the composite FK). company_id NULL -> branch_id NULL.
-- Name sorts after prevent_role_escalation, so that guard sees the
-- caller's requested values, not the derived ones.
CREATE OR REPLACE FUNCTION public.users_fill_branch_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    NEW.branch_id := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.company_id IS DISTINCT FROM OLD.company_id
     AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id THEN
    NEW.branch_id := NULL;
  END IF;

  IF NEW.branch_id IS NULL THEN
    SELECT b.id INTO NEW.branch_id
    FROM public.branches b
    WHERE b.company_id = NEW.company_id
      AND b.is_default;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_fill_branch_id ON public.users;
CREATE TRIGGER users_fill_branch_id
  BEFORE INSERT OR UPDATE OF company_id, branch_id ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_fill_branch_id();

-- ─── 5) NOT NULL ───────────────────────────────────────────────────────────
-- Fails (and rolls back the whole file) if any backfill left a NULL.

ALTER TABLE public.warehouses           ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.product_sizes        ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.transactions         ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.transaction_items    ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.stock_out_entries    ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.stock_in_entries     ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.shifts               ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.returns              ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.customers            ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.nasiya_transactions  ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.loyalty_transactions ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.expenses             ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.stock_counts         ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.supplier_returns     ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.requests             ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE public.stock_transfers      ALTER COLUMN from_branch_id SET NOT NULL;
ALTER TABLE public.stock_transfers      ALTER COLUMN to_branch_id SET NOT NULL;

-- users: super admin / freshly signed-up users have no company (and so no
-- branch); every company member must have one.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_branch_required;
ALTER TABLE public.users
  ADD CONSTRAINT users_branch_required CHECK (company_id IS NULL OR branch_id IS NOT NULL);

-- ─── 6) Composite FKs -> branches(id, company_id) ─────────────────────────
-- A row can only point at a branch of its own company. NO ACTION (see
-- header for why not RESTRICT).

DO $fks$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY[
    'users', 'warehouses', 'product_sizes', 'transactions', 'transaction_items',
    'stock_out_entries', 'stock_in_entries', 'shifts', 'returns', 'customers',
    'nasiya_transactions', 'loyalty_transactions', 'expenses', 'stock_counts',
    'supplier_returns', 'requests'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   v_t, v_t || '_branch_fkey');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I
         FOREIGN KEY (branch_id, company_id)
         REFERENCES public.branches (id, company_id)
         ON DELETE NO ACTION ON UPDATE NO ACTION',
      v_t, v_t || '_branch_fkey');
  END LOOP;
END
$fks$;

ALTER TABLE public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_from_branch_fkey;
ALTER TABLE public.stock_transfers
  ADD CONSTRAINT stock_transfers_from_branch_fkey
  FOREIGN KEY (from_branch_id, company_id)
  REFERENCES public.branches (id, company_id)
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_to_branch_fkey;
ALTER TABLE public.stock_transfers
  ADD CONSTRAINT stock_transfers_to_branch_fkey
  FOREIGN KEY (to_branch_id, company_id)
  REFERENCES public.branches (id, company_id)
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ─── 7) Indexes ────────────────────────────────────────────────────────────
-- (company_id, branch_id) everywhere; where a (company_id, branch_id, date)
-- or (..., created_at) index is created, it already covers the 2-column
-- prefix, so the 2-column one is not duplicated on that table.

-- (company_id, branch_id, date)
CREATE INDEX IF NOT EXISTS transactions_company_branch_date_idx
  ON public.transactions (company_id, branch_id, date);
CREATE INDEX IF NOT EXISTS stock_out_entries_company_branch_date_idx
  ON public.stock_out_entries (company_id, branch_id, date);
CREATE INDEX IF NOT EXISTS stock_in_entries_company_branch_date_idx
  ON public.stock_in_entries (company_id, branch_id, date);
CREATE INDEX IF NOT EXISTS expenses_company_branch_date_idx
  ON public.expenses (company_id, branch_id, date);

-- (company_id, branch_id, created_at)
CREATE INDEX IF NOT EXISTS shifts_company_branch_created_idx
  ON public.shifts (company_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS nasiya_transactions_company_branch_created_idx
  ON public.nasiya_transactions (company_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS loyalty_transactions_company_branch_created_idx
  ON public.loyalty_transactions (company_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS returns_company_branch_created_idx
  ON public.returns (company_id, branch_id, created_at);

-- (company_id, branch_id)
CREATE INDEX IF NOT EXISTS users_company_branch_idx
  ON public.users (company_id, branch_id);
CREATE INDEX IF NOT EXISTS warehouses_company_branch_idx
  ON public.warehouses (company_id, branch_id);
CREATE INDEX IF NOT EXISTS product_sizes_company_branch_idx
  ON public.product_sizes (company_id, branch_id);
CREATE INDEX IF NOT EXISTS transaction_items_company_branch_idx
  ON public.transaction_items (company_id, branch_id);
CREATE INDEX IF NOT EXISTS customers_company_branch_idx
  ON public.customers (company_id, branch_id);
CREATE INDEX IF NOT EXISTS stock_counts_company_branch_idx
  ON public.stock_counts (company_id, branch_id);
CREATE INDEX IF NOT EXISTS supplier_returns_company_branch_idx
  ON public.supplier_returns (company_id, branch_id);
CREATE INDEX IF NOT EXISTS requests_company_branch_idx
  ON public.requests (company_id, branch_id);
CREATE INDEX IF NOT EXISTS stock_transfers_company_from_branch_idx
  ON public.stock_transfers (company_id, from_branch_id);
CREATE INDEX IF NOT EXISTS stock_transfers_company_to_branch_idx
  ON public.stock_transfers (company_id, to_branch_id);

-- (branch_id) - also serves the composite FK check on branch delete.
CREATE INDEX IF NOT EXISTS product_sizes_branch_id_idx
  ON public.product_sizes (branch_id);
CREATE INDEX IF NOT EXISTS customers_branch_id_idx
  ON public.customers (branch_id);
CREATE INDEX IF NOT EXISTS transaction_items_branch_id_idx
  ON public.transaction_items (branch_id);
CREATE INDEX IF NOT EXISTS users_branch_id_idx
  ON public.users (branch_id);
CREATE INDEX IF NOT EXISTS warehouses_branch_id_idx
  ON public.warehouses (branch_id);

-- ─── 8) handle_new_company v2: default branch, then warehouses with it ────
-- Identical to the 20261109000001 version except branch_id is passed
-- explicitly (the warehouses fill trigger would also derive it).

CREATE OR REPLACE FUNCTION public.handle_new_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_branch_id uuid;
BEGIN
  INSERT INTO public.branches (company_id, name, is_default, is_active)
  VALUES (NEW.id, 'Asosiy filial', true, true)
  RETURNING id INTO v_branch_id;

  INSERT INTO public.warehouses (company_id, branch_id, name, type)
  VALUES (NEW.id, v_branch_id, 'Kiyimlar ombori', 'clothing'),
         (NEW.id, v_branch_id, 'Oyoq kiyim ombori', 'footwear');

  RETURN NEW;
END;
$$;

-- ─── 9) prevent_role_escalation: protect users.branch_id ──────────────────
-- Based on the only definition, 20260712000008_fix_rls_users.sql. The
-- role/company_id/status block is reproduced verbatim (same message, same
-- "caller_role != 'owner'" NULL-skips-for-service-role semantics).
-- Added: branch_id may only change when
--   * the caller is the service role (caller_role NULL, no JWT), or
--   * the caller is owner/admin AND the target row is in the caller's
--     company (owner/admin may move any colleague, incl. themselves; both
--     are all-branch roles so their own branch_id is only a "home").
-- manager/staff can never change branch_id (not even their own row, which
-- "Users can update own profile" would otherwise allow).
-- Only search_path changes: public -> public, pg_temp.

CREATE OR REPLACE FUNCTION public.prevent_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_role text;
  caller_company uuid;
BEGIN
  SELECT role, company_id INTO caller_role, caller_company
  FROM public.users WHERE id = auth.uid();

  IF caller_role != 'owner' THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR
       NEW.company_id IS DISTINCT FROM OLD.company_id OR
       NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Unauthorized: cannot change role, company_id or status';
    END IF;
  END IF;

  IF caller_role IS NOT NULL
     AND NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    IF caller_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Unauthorized: cannot change branch_id';
    END IF;
    IF OLD.company_id IS DISTINCT FROM caller_company THEN
      RAISE EXCEPTION 'Unauthorized: cannot change branch_id of another company''s user';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
-- Trigger prevent_role_escalation (BEFORE UPDATE ON public.users) already
-- points at this function; CREATE OR REPLACE keeps it attached.

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- 1) NULL branch counts (expect every n = 0)
-- SELECT 'users' t, count(*) n FROM public.users WHERE company_id IS NOT NULL AND branch_id IS NULL
-- UNION ALL SELECT 'warehouses', count(*) FROM public.warehouses WHERE branch_id IS NULL
-- UNION ALL SELECT 'product_sizes', count(*) FROM public.product_sizes WHERE branch_id IS NULL
-- UNION ALL SELECT 'transactions', count(*) FROM public.transactions WHERE branch_id IS NULL
-- UNION ALL SELECT 'transaction_items', count(*) FROM public.transaction_items WHERE branch_id IS NULL
-- UNION ALL SELECT 'stock_out_entries', count(*) FROM public.stock_out_entries WHERE branch_id IS NULL
-- UNION ALL SELECT 'stock_in_entries', count(*) FROM public.stock_in_entries WHERE branch_id IS NULL
-- UNION ALL SELECT 'shifts', count(*) FROM public.shifts WHERE branch_id IS NULL
-- UNION ALL SELECT 'returns', count(*) FROM public.returns WHERE branch_id IS NULL
-- UNION ALL SELECT 'customers', count(*) FROM public.customers WHERE branch_id IS NULL
-- UNION ALL SELECT 'nasiya_transactions', count(*) FROM public.nasiya_transactions WHERE branch_id IS NULL
-- UNION ALL SELECT 'loyalty_transactions', count(*) FROM public.loyalty_transactions WHERE branch_id IS NULL
-- UNION ALL SELECT 'expenses', count(*) FROM public.expenses WHERE branch_id IS NULL
-- UNION ALL SELECT 'stock_counts', count(*) FROM public.stock_counts WHERE branch_id IS NULL
-- UNION ALL SELECT 'supplier_returns', count(*) FROM public.supplier_returns WHERE branch_id IS NULL
-- UNION ALL SELECT 'requests', count(*) FROM public.requests WHERE branch_id IS NULL
-- UNION ALL SELECT 'stock_transfers', count(*) FROM public.stock_transfers WHERE from_branch_id IS NULL OR to_branch_id IS NULL;
--
-- -- 2) denormalized copies agree with their parents (expect 0, 0)
-- SELECT count(*) FROM public.product_sizes ps JOIN public.warehouses w ON w.id = ps.warehouse_id WHERE ps.branch_id <> w.branch_id;
-- SELECT count(*) FROM public.transaction_items ti JOIN public.transactions t ON t.id = ti.transaction_id WHERE ti.branch_id <> t.branch_id;
--
-- -- 3) constraints + triggers present
-- SELECT conrelid::regclass, conname FROM pg_constraint WHERE conname LIKE '%branch_fkey' OR conname = 'users_branch_required' ORDER BY 1;
-- SELECT tgrelid::regclass, tgname FROM pg_trigger WHERE tgname LIKE '%fill_branch%' ORDER BY 1;
--
-- -- 4) helper grants (authenticated = true, anon = false)
-- SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,
--        has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname IN
--   ('get_branch_id','get_branch_ids','resolve_branch_id','assert_branch_access','branch_default_for_write');
