-- Branches (filiallar) - PHASE 1, file 1 of 3: the branches table itself.
--
-- Zero behaviour change for the live app:
--   * Every company gets exactly one default branch ('Asosiy filial').
--   * companies.branch_limit defaults to 1 and a BEFORE INSERT trigger on
--     branches enforces it, so a 2nd branch cannot exist until a later phase
--     raises the limit AND ships a create-branch RPC.
--   * No existing table, policy or RPC is changed here except
--     handle_new_company, which now also creates the default branch first.
--
-- Access model for public.branches: RLS for reads (company-scoped SELECT,
-- plus super-admin read, same pattern as company_features), NO direct writes
-- for anon/authenticated. Writes only via future SECURITY DEFINER RPCs or
-- the service role (super-admin/actions.ts).
--
-- Dependency note: branch_id columns on warehouses etc. are added in
-- 20261109000002_branch_columns.sql. handle_new_company here therefore
-- creates the default branch and the warehouses WITHOUT branch_id; file 2
-- redefines it to pass branch_id explicitly once the column exists. Each
-- file is therefore safe to run (and to be live) on its own.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) Table ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NULL,
  phone text NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Target of every composite FK (branch_id, company_id) added in file 2:
  -- guarantees a row can never point at another company's branch.
  CONSTRAINT branches_id_company_key UNIQUE (id, company_id),
  CONSTRAINT branches_name_not_blank CHECK (length(btrim(name)) > 0),
  -- The default branch is the fallback for every legacy write path; it must
  -- never be deactivated (deactivate = first move the default elsewhere).
  CONSTRAINT branches_default_is_active CHECK (NOT is_default OR is_active)
);

COMMENT ON TABLE public.branches IS
  'Company branches (filiallar). Read via RLS (company-scoped SELECT); write '
  'ONLY via SECURITY DEFINER RPCs or the service role. Exactly one is_default '
  'row per company.';
COMMENT ON COLUMN public.branches.is_default IS
  'Fallback branch for legacy writes that do not know branch_id. Exactly one per company.';

-- Exactly one default branch per company (at most one via the index; at
-- least one via the backfill + handle_new_company).
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_default_per_company_idx
  ON public.branches (company_id)
  WHERE is_default;

-- Branch names unique per company, case/whitespace-insensitive
-- (same convention as suppliers_company_name_key).
CREATE UNIQUE INDEX IF NOT EXISTS branches_company_name_key
  ON public.branches (company_id, lower(btrim(name)));

DROP TRIGGER IF EXISTS branches_set_updated_at ON public.branches;
CREATE TRIGGER branches_set_updated_at
  BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 2) RLS + grants ───────────────────────────────────────────────────────

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company isolation (select)" ON public.branches;
CREATE POLICY "Company isolation (select)" ON public.branches
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()));

-- Same read pattern as "Super admin manages company features"
-- (20260712000003), read-only here. Super-admin writes go through the
-- service role.
DROP POLICY IF EXISTS "Super admin reads branches" ON public.branches;
CREATE POLICY "Super admin reads branches" ON public.branches
  FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()));

-- Close the Supabase default-grant leak immediately. REVOKE ALL (not just
-- INSERT/UPDATE/DELETE) also removes TRUNCATE/REFERENCES/TRIGGER.
REVOKE ALL ON public.branches FROM anon, authenticated;
GRANT SELECT ON public.branches TO authenticated;
GRANT ALL ON public.branches TO service_role;

-- ─── 3) companies.branch_limit ─────────────────────────────────────────────

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS branch_limit integer NOT NULL DEFAULT 1;

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_branch_limit_positive;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_branch_limit_positive CHECK (branch_limit >= 1);

COMMENT ON COLUMN public.companies.branch_limit IS
  'Max number of branches (active or not). Platform-controlled: only the '
  'service role may change it (check_companies_branch_limit_access).';

-- branch_limit is a plan/billing field. "Owner can update own company"
-- (20260715000005) would otherwise let an owner raise it from the client.
-- Same pattern as check_companies_billing_column_access: any real end-user
-- session is blocked; service role (auth.uid() NULL -> caller_role NULL)
-- passes. Separate trigger so the existing billing guard stays untouched.
CREATE OR REPLACE FUNCTION public.check_companies_branch_limit_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();

  IF caller_role IS NOT NULL
     AND NEW.branch_limit IS DISTINCT FROM OLD.branch_limit THEN
    RAISE EXCEPTION 'Unauthorized: only the platform can change branch_limit';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_companies_branch_limit_access ON public.companies;
CREATE TRIGGER check_companies_branch_limit_access
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.check_companies_branch_limit_access();

-- DB-level enforcement of branch_limit for every writer (incl. service role
-- and future RPCs). The companies row is locked FOR UPDATE so two
-- concurrent inserts cannot both pass the count check.
CREATE OR REPLACE FUNCTION public.enforce_branch_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer;
  v_count integer;
BEGIN
  SELECT branch_limit INTO v_limit
  FROM public.companies
  WHERE id = NEW.company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company % not found', NEW.company_id;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.branches
  WHERE company_id = NEW.company_id;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'branch_limit_reached: max % branches allowed', v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_branch_limit ON public.branches;
CREATE TRIGGER enforce_branch_limit
  BEFORE INSERT ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_limit();

-- ─── 4) Backfill: one default branch per existing company ──────────────────

INSERT INTO public.branches (company_id, name, is_default, is_active)
SELECT c.id, 'Asosiy filial', true, true
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.branches b
  WHERE b.company_id = c.id AND b.is_default
);

-- ─── 5) handle_new_company: default branch first, then warehouses ──────────
-- Based on the only definition, 20260709000003_seed_warehouses.sql. Same
-- two warehouses (names, types, order). Changes: the default branch is
-- created first; search_path pins pg_temp. Trigger on_company_created is
-- unchanged (AFTER INSERT ON companies). branch_id on the warehouses is
-- filled in file 2 (explicitly there, by the fill trigger in between).

CREATE OR REPLACE FUNCTION public.handle_new_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.branches (company_id, name, is_default, is_active)
  VALUES (NEW.id, 'Asosiy filial', true, true);

  INSERT INTO public.warehouses (company_id, name, type)
  VALUES (NEW.id, 'Kiyimlar ombori', 'clothing'), (NEW.id, 'Oyoq kiyim ombori', 'footwear');

  RETURN NEW;
END;
$$;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- every company has exactly one default branch (expect 0 rows)
-- SELECT c.id, c.name, count(b.id) FILTER (WHERE b.is_default) AS defaults
-- FROM public.companies c LEFT JOIN public.branches b ON b.company_id = c.id
-- GROUP BY c.id, c.name
-- HAVING count(b.id) FILTER (WHERE b.is_default) <> 1;
--
-- -- grants: authenticated = SELECT only, anon = nothing
-- SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND table_name = 'branches'
-- GROUP BY grantee;
--
-- -- policies are pre-wrapped (expect "( SELECT get_company_id() ...")
-- SELECT policyname, cmd, roles, qual FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'branches';
--
-- -- branch_limit present, default 1
-- SELECT id, name, branch_limit FROM public.companies;
