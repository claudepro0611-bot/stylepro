-- Production as an ADD-ON module, not only a firm type.
--
-- Product decision (2026-11-10): the super admin must be able to switch the
-- "Ishlab chiqarish" module on for ANY firm (e.g. a retail shop that also
-- produces), from super-admin → Firma → Modullar. Production-type firms keep
-- the module permanently.
--
--   1) feature_definitions 'production': no longer core, offered to both types.
--   2) public.production_enabled(): firm is production-type OR has an active,
--      unexpired 'production' company_features row.
--   3) assert_business_type('production') now means "production module
--      enabled" (all 9 production RPCs call it, so they need no rewrite).
--      assert_business_type('retail') keeps its strict meaning.
--   4) has_permission(): for retail firms prod_* keys are allowed only when the
--      module is enabled (still fail-closed for non-owners). Production firms:
--      unchanged (retail keys blocked).
--   5) Turning the module on seeds an 'Asosiy ombor' prod_warehouse if the firm
--      has none, so the first document can be posted immediately.

BEGIN;

-- ─── 1) feature catalog ────────────────────────────────────────────────────
UPDATE public.feature_definitions
SET is_core = false,
    business_types = ARRAY['retail', 'production']::text[]
WHERE key = 'production';

-- ─── 2) production_enabled() ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.production_enabled()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT COALESCE((
    SELECT c.business_type = 'production'
        OR EXISTS (
             SELECT 1 FROM public.company_features cf
             WHERE cf.company_id = c.id
               AND cf.feature_key = 'production'
               AND cf.is_active
               AND (cf.expires_at IS NULL OR cf.expires_at > now())
           )
    FROM public.users u
    JOIN public.companies c ON c.id = u.company_id
    WHERE u.id = auth.uid()
  ), false)
$$;

REVOKE EXECUTE ON FUNCTION public.production_enabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_enabled() TO authenticated;

-- ─── 3) assert_business_type ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assert_business_type(p text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF p = 'production' THEN
    IF NOT public.production_enabled() THEN
      RAISE EXCEPTION 'wrong_business_type';
    END IF;
    RETURN;
  END IF;

  IF p IS NULL OR public.get_business_type() IS DISTINCT FROM p THEN
    RAISE EXCEPTION 'wrong_business_type';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_business_type(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_business_type(text) TO authenticated;

-- ─── 4) has_permission ─────────────────────────────────────────────────────
-- Based on 20261110000005. Only change: retail firm + prod_* key is allowed
-- when production_enabled() (instead of always false).
CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_role text;
  v_permissions jsonb;
  v_business_type text;
  v_prod_keys text[] := ARRAY[
    'prod_catalog', 'prod_production', 'prod_processing',
    'prod_receipts', 'prod_stock', 'prod_supply'
  ];
  v_shared_keys text[] := ARRAY[
    'dashboard', 'xarajatlar', 'hr', 'jamoa', 'sozlamalar'
  ];
  v_valid_keys text[] := ARRAY[
    'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
    'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
    'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
    'reports_moliya', 'reports_foyda', 'reports_sotuvlar', 'reports_mijozlar',
    'reports_yetkazuvchilar', 'reports_kirim', 'reports_spisaniya',
    'reports_xarajatlar', 'reports_inventar',
    'peremeshenie', 'reports_peremeshenie',
    'yetkazuvchilar',
    'prod_catalog', 'prod_production', 'prod_processing',
    'prod_receipts', 'prod_stock', 'prod_supply'
  ];
BEGIN
  IF NOT (p_key = ANY(v_valid_keys)) THEN
    RETURN false;
  END IF;

  SELECT u.role, u.permissions, c.business_type
  INTO v_role, v_permissions, v_business_type
  FROM public.users u
  LEFT JOIN public.companies c ON c.id = u.company_id
  WHERE u.id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Business-type / module gate (before the owner shortcut).
  IF COALESCE(v_business_type, 'retail') = 'production' THEN
    IF NOT (p_key = ANY(v_prod_keys || v_shared_keys)) THEN
      RETURN false;
    END IF;
  ELSE
    IF p_key = ANY(v_prod_keys) AND NOT public.production_enabled() THEN
      RETURN false;
    END IF;
  END IF;

  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  -- prod_* keys: fail closed when not explicitly granted.
  IF p_key = ANY(v_prod_keys) THEN
    IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
      RETURN false;
    END IF;
    RETURN COALESCE((v_permissions->>p_key)::boolean, false);
  END IF;

  -- Retail / shared keys: legacy semantics (missing key = allowed).
  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;

-- ─── 5) seed a warehouse when the module is switched on ────────────────────
CREATE OR REPLACE FUNCTION public.handle_production_feature_enabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.feature_key = 'production' AND NEW.is_active
     AND NOT EXISTS (SELECT 1 FROM public.prod_warehouses WHERE company_id = NEW.company_id) THEN
    INSERT INTO public.prod_warehouses (company_id, name, storage_types)
    VALUES (NEW.company_id, 'Asosiy ombor',
            ARRAY['raw', 'finished', 'production', 'processing', 'return']::text[])
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_production_feature_enabled() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_production_feature_enabled ON public.company_features;
CREATE TRIGGER on_production_feature_enabled
  AFTER INSERT OR UPDATE OF is_active ON public.company_features
  FOR EACH ROW EXECUTE FUNCTION public.handle_production_feature_enabled();

COMMIT;
