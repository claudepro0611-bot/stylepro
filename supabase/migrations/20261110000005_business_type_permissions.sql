-- Production company type, file 5 of 5: business-type-aware has_permission.
--
-- Based on the latest definition, 20261106000004_suppliers.sql (no later
-- migration redefines it). Changes:
--   * whitelist += prod_catalog, prod_production, prod_processing,
--     prod_receipts, prod_stock, prod_supply.
--   * The caller's company business_type is resolved in the same query as
--     role/permissions (users LEFT JOIN companies). A user without a company
--     is treated as retail (same result as before for every legacy key).
--   * Type gate BEFORE the owner shortcut, so it binds owners too:
--       production firm: only prod_* keys + shared keys (dashboard,
--         xarajatlar, hr, jamoa, sozlamalar) can be true; every other
--         (retail-only) key -> false.
--       retail firm: prod_* keys -> false.
--   * prod_* keys are FAIL-CLOSED for non-owners: missing in the
--     permissions jsonb (or permissions NULL) -> false.
--   * Retail/shared keys keep the legacy default-true for a missing key.
--
-- Retail firms: for every key that existed before, the result is identical
-- (the type gate cannot fire for them: retail keys pass it, and prod_* keys
-- were already false as unknown keys).
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

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

  -- Business-type gate (before the owner shortcut).
  IF COALESCE(v_business_type, 'retail') = 'production' THEN
    IF NOT (p_key = ANY(v_prod_keys || v_shared_keys)) THEN
      RETURN false;
    END IF;
  ELSE
    IF p_key = ANY(v_prod_keys) THEN
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

COMMIT;

-- ─── Verification (run manually after applying, as a test user) ───────────
-- retail owner:       has_permission('pos') = true,  has_permission('prod_stock') = false
-- production owner:   has_permission('pos') = false, has_permission('prod_stock') = true,
--                     has_permission('xarajatlar') = true
-- production staff with permissions = '{}':
--                     has_permission('prod_stock') = false, has_permission('hr') = true
