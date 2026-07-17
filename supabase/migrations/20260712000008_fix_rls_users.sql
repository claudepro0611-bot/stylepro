-- Column-level guard on public.users: RLS's "Users can update own profile"
-- policy (id = auth.uid()) protects rows, not columns, so any authenticated
-- user could otherwise self-escalate role/company_id/status via a direct
-- REST/JS call against their own row. This trigger blocks that regardless
-- of which client (browser or server) issues the UPDATE.
--
-- Service-role writes (server actions using supabaseServer, e.g. jamoa and
-- super-admin actions) are unaffected: those requests carry no user JWT, so
-- auth.uid() resolves to NULL, caller_role stays NULL, and
-- "caller_role != 'owner'" is NULL (not TRUE) — the guard is skipped and
-- those already-authorized writes proceed normally.
--
-- Uses IS DISTINCT FROM instead of != for the column comparisons: a
-- freshly-signed-up user has company_id IS NULL (assigned during
-- onboarding), and NEW.company_id != NULL evaluates to NULL (not TRUE) in
-- Postgres's three-valued logic, which would silently skip the check for
-- exactly the account that most needs it blocked.
CREATE OR REPLACE FUNCTION prevent_role_escalation()
RETURNS TRIGGER AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();

  IF caller_role != 'owner' THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR
       NEW.company_id IS DISTINCT FROM OLD.company_id OR
       NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Unauthorized: cannot change role, company_id or status';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS prevent_role_escalation ON public.users;
CREATE TRIGGER prevent_role_escalation
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION prevent_role_escalation();
