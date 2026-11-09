-- Production company type, file 1 of 5: companies.business_type + helpers.
--
-- A firm is either 'retail' (every existing firm, the default) or
-- 'production' (dairy / food plant). The type decides which modules,
-- permission keys and seed data a firm gets (files 2-5).
--
-- Zero behaviour change for retail firms: the column defaults to 'retail',
-- so every existing row and every insert that does not name the column
-- (super-admin/actions.ts today) stays retail.
--
-- business_type is IMMUTABLE after creation. Switching a firm between
-- retail and production would orphan one side's data (retail warehouses /
-- product_sizes vs prod_* ledger) and silently flip permission semantics,
-- so a BEFORE UPDATE trigger refuses any change - for every role, including
-- the service role (triggers are not bypassed by BYPASSRLS). The owner's
-- "Owner can update own company" UPDATE policy would otherwise allow it.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) Column ────────────────────────────────────────────────────────────
-- ADD COLUMN ... NOT NULL DEFAULT <constant> is a metadata-only change on
-- PG11+ (no table rewrite); existing rows read as 'retail'.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS business_type text NOT NULL DEFAULT 'retail';

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_business_type_check;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_business_type_check
  CHECK (business_type IN ('retail', 'production'));

COMMENT ON COLUMN public.companies.business_type IS
  'retail | production. Set once at creation (super-admin); immutable '
  'afterwards (trigger companies_business_type_immutable).';

-- ─── 2) Immutability trigger ──────────────────────────────────────────────
-- Not SECURITY DEFINER: it reads nothing, it only compares OLD/NEW.

CREATE OR REPLACE FUNCTION public.companies_business_type_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.business_type IS DISTINCT FROM OLD.business_type THEN
    RAISE EXCEPTION 'business_type_immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.companies_business_type_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS companies_business_type_immutable ON public.companies;
CREATE TRIGGER companies_business_type_immutable
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_business_type_immutable();

-- ─── 3) get_business_type() ───────────────────────────────────────────────
-- Business type of the caller's company (auth.uid() -> users.company_id).
-- NULL when the caller has no users row / no company (anon, super admin
-- without a company): every consumer must treat NULL as "not production".
-- SECURITY DEFINER so it works regardless of the caller's RLS on companies;
-- it only ever returns the caller's own company's type.

CREATE OR REPLACE FUNCTION public.get_business_type()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT c.business_type
  FROM public.users u
  JOIN public.companies c ON c.id = u.company_id
  WHERE u.id = auth.uid()
$$;

REVOKE EXECUTE ON FUNCTION public.get_business_type() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_business_type() TO authenticated;

-- ─── 4) assert_business_type(p) ───────────────────────────────────────────
-- Guard used as the first statement of every production RPC (file 4).
-- Fails closed: a caller without a company (NULL type) never matches.

CREATE OR REPLACE FUNCTION public.assert_business_type(p text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF p IS NULL OR public.get_business_type() IS DISTINCT FROM p THEN
    RAISE EXCEPTION 'wrong_business_type';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_business_type(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_business_type(text) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- SELECT business_type, count(*) FROM public.companies GROUP BY 1;  -- all 'retail'
-- -- expect ERROR business_type_immutable:
-- UPDATE public.companies SET business_type = 'production' WHERE id = '<some id>';
