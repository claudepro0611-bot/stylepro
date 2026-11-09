-- Per-report permissions: each Hisobotlar page gets its own key
-- (reports_<slug>) on top of the existing 'reports' master key. See
-- lib/permissions.ts (PERMISSION_KEYS) and lib/supabase/middleware.ts
-- (ROUTE_PERMISSIONS), which checks both the parent and the child key.
--
-- Reproduced verbatim from 20260723000007_loyalty_nasiya.sql — only the
-- nine reports_* keys appended to v_valid_keys. Without this, has_permission
-- fails closed on the new keys and non-owners could never open any report.
-- Absent keys still default to true, so existing staff keep access to every
-- report until an owner switches one off.

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
  v_valid_keys text[] := ARRAY[
    'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
    'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
    'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
    'reports_moliya', 'reports_foyda', 'reports_sotuvlar', 'reports_mijozlar',
    'reports_yetkazuvchilar', 'reports_kirim', 'reports_spisaniya',
    'reports_xarajatlar', 'reports_inventar'
  ];
BEGIN
  IF NOT (p_key = ANY(v_valid_keys)) THEN
    RETURN false;
  END IF;

  SELECT role, permissions INTO v_role, v_permissions
  FROM public.users
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;
