-- Server-side mirror of lib/permissions.ts's withDefaultPermissions(), so
-- the RPCs (and any future server-side check) enforce the exact same
-- authorization the UI already promises, not a stricter or looser copy of it.
CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_role text;
  v_permissions jsonb;
BEGIN
  SELECT role, permissions INTO v_role, v_permissions
  FROM public.users
  WHERE id = auth.uid();

  -- No matching user row — auth.uid() didn't resolve, or the row is gone.
  -- Fail closed: no default-allow fallback for this case.
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Owners bypass the permission system entirely, matching the app's own
  -- convention (lib/permissions.ts, Sidebar.tsx, every page-level guard).
  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  -- A key genuinely absent from the jsonb (a legacy row predating that
  -- permission's introduction) defaults to true, mirroring
  -- withDefaultPermissions() client-side. A key that is present and
  -- explicitly false stays false.
  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;
