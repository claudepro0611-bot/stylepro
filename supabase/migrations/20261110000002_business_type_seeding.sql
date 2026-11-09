-- Production company type, file 2 of 5: per-type seeding of new companies.
--
--   1) handle_new_company(): default branch for every firm (unchanged);
--      retail -> the two retail warehouses exactly as before;
--      production -> NO retail warehouses, one prod_warehouse 'Asosiy ombor'
--      (all storage types) instead, and
--      company_settings.product.unit_types = ["kg","l","dona"].
--   2) feature_definitions.business_types: which firm types a feature
--      applies to; new core feature 'production'.
--   3) AFTER INSERT ON companies: auto-create company_features rows for the
--      core features of the new firm's type (+ backfill for existing firms).
--
-- Ordering note: handle_new_company references public.prod_warehouses,
-- which is created in the NEXT file (20261110000003_production_core.sql).
-- PL/pgSQL resolves table names at execution time, not at CREATE time, so
-- this file applies cleanly on its own. Between this file and file 3 the
-- retail branch works normally; inserting a PRODUCTION company in that
-- window fails with "relation prod_warehouses does not exist" and the whole
-- company INSERT rolls back (fail-closed, no half-seeded firm). Once file 3
-- is applied the final state is complete. All five files are meant to be
-- applied together in timestamp order.
--
-- Retail firms: the retail branch of handle_new_company is byte-for-byte
-- the 20261109000002 v2 body. handle_new_company_settings is NOT touched.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) handle_new_company v3 ─────────────────────────────────────────────
-- Based on the latest definition, 20261109000002_branch_columns.sql (v2).
--
-- Production settings: AFTER INSERT triggers on companies fire in name
-- order, so on_company_created (this function) runs BEFORE
-- on_company_created_settings (handle_new_company_settings, which inserts
-- the default row with ON CONFLICT DO NOTHING). We therefore insert the
-- production settings row here; the later settings trigger then no-ops.
-- The ON CONFLICT DO UPDATE branch makes this correct even if the trigger
-- order ever changes (it then overrides only product.unit_types).

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

  IF NEW.business_type = 'production' THEN
    -- One main warehouse holding every storage type: production and
    -- processing take inputs and put outputs in the SAME warehouse (there is
    -- no transfer document yet), so split raw/finished warehouses would make
    -- the first production run impossible. Firms can add more later.
    INSERT INTO public.prod_warehouses (company_id, name, storage_types)
    VALUES (NEW.id, 'Asosiy ombor',
            ARRAY['raw', 'finished', 'production', 'processing', 'return']::text[]);

    INSERT INTO public.company_settings (company_id, settings)
    VALUES (
      NEW.id,
      jsonb_build_object(
        'product', jsonb_build_object(
          'unit_types', '["kg","l","dona"]'::jsonb,
          'block_size', 1
        )
      )
    )
    ON CONFLICT (company_id) DO UPDATE
      SET settings = jsonb_set(
        public.company_settings.settings,
        '{product}',
        COALESCE(public.company_settings.settings->'product', '{}'::jsonb)
          || jsonb_build_object('unit_types', '["kg","l","dona"]'::jsonb),
        true
      );
  ELSE
    -- retail (CHECK constraint allows only retail|production): unchanged v2.
    INSERT INTO public.warehouses (company_id, branch_id, name, type)
    VALUES (NEW.id, v_branch_id, 'Kiyimlar ombori', 'clothing'),
           (NEW.id, v_branch_id, 'Oyoq kiyim ombori', 'footwear');
  END IF;

  RETURN NEW;
END;
$$;
-- Trigger on_company_created (AFTER INSERT ON public.companies) already
-- points at this function; CREATE OR REPLACE keeps it attached.

-- ─── 2) feature_definitions.business_types ────────────────────────────────

ALTER TABLE public.feature_definitions
  ADD COLUMN IF NOT EXISTS business_types text[] NOT NULL DEFAULT '{retail}';

ALTER TABLE public.feature_definitions
  DROP CONSTRAINT IF EXISTS feature_definitions_business_types_check;
ALTER TABLE public.feature_definitions
  ADD CONSTRAINT feature_definitions_business_types_check
  CHECK (
    cardinality(business_types) > 0
    AND business_types <@ ARRAY['retail', 'production']::text[]
  );

COMMENT ON COLUMN public.feature_definitions.business_types IS
  'Firm types this feature applies to (retail, production). Core features '
  'are auto-enabled for new firms whose business_type is listed here.';

-- Retail-only (pos, warehouse, barcode, excel_import, marketing,
-- shift_system and any super-admin-created feature) keep the '{retail}'
-- default. Shared modules:
UPDATE public.feature_definitions
SET business_types = ARRAY['retail', 'production']::text[]
WHERE key IN ('hr', 'reports', 'expenses');

INSERT INTO public.feature_definitions (key, name, description, price_usd, is_core, business_types)
VALUES (
  'production',
  'Ishlab chiqarish',
  'Ishlab chiqarish, qayta ishlash, xom ashyo kirimi, qoldiq va ta''minot moduli',
  0,
  true,
  ARRAY['production']::text[]
)
ON CONFLICT (key) DO NOTHING;

-- ─── 3) Core features for new companies ───────────────────────────────────
-- Until now nothing created company_features rows for companies created
-- after 20260712000003 (that migration only backfilled the firms existing
-- at the time). For retail this adds active 'pos' and 'warehouse' rows;
-- no UI gates on those two keys today (Sidebar featureKeys are hr,
-- reports, expenses, marketing), so retail behaviour is unchanged.
-- ON CONFLICT DO NOTHING: a row super-admin already deactivated stays so.

CREATE OR REPLACE FUNCTION public.handle_new_company_features()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.company_features (company_id, feature_key, is_active, activated_at)
  SELECT NEW.id, fd.key, true, now()
  FROM public.feature_definitions fd
  WHERE fd.is_core
    AND NEW.business_type = ANY (fd.business_types)
  ON CONFLICT (company_id, feature_key) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_company_features() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_company_created_features ON public.companies;
CREATE TRIGGER on_company_created_features
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_company_features();

-- Backfill: existing companies (all retail at this point) missing a row for
-- a core feature of their type.
INSERT INTO public.company_features (company_id, feature_key, is_active, activated_at)
SELECT c.id, fd.key, true, now()
FROM public.companies c
JOIN public.feature_definitions fd
  ON fd.is_core AND c.business_type = ANY (fd.business_types)
ON CONFLICT (company_id, feature_key) DO NOTHING;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- SELECT key, is_core, business_types FROM public.feature_definitions ORDER BY key;
-- -- every company has every core feature of its type (expect 0 rows):
-- SELECT c.id, fd.key FROM public.companies c
-- JOIN public.feature_definitions fd ON fd.is_core AND c.business_type = ANY (fd.business_types)
-- LEFT JOIN public.company_features cf ON cf.company_id = c.id AND cf.feature_key = fd.key
-- WHERE cf.id IS NULL;
