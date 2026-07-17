-- Column-level guards for sensitive HR fields.
--
-- Split into two trigger functions (not one shared "check_column_access")
-- because salary lives on public.employees and permissions lives on
-- public.users — a single function referencing NEW.salary would raise
-- "record NEW has no field salary" the instant it fired on a users UPDATE,
-- breaking every write to that table. Each function only references
-- columns that actually exist on the table it's attached to.
--
-- caller_role stays a plain "!=" comparison (not IS DISTINCT FROM): a NULL
-- caller_role means auth.uid() didn't resolve — i.e. a service-role call
-- (jamoa/actions.ts, super-admin/actions.ts) with no user JWT — and NULL !=
-- 'owner' evaluates to NULL, which is not TRUE, so the guard is correctly
-- skipped for those already-authorized server-side writes.

-- 1. Only the owner may change a colleague's permissions.
CREATE OR REPLACE FUNCTION check_users_column_access()
RETURNS TRIGGER AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();

  IF caller_role != 'owner' THEN
    IF NEW.permissions IS DISTINCT FROM OLD.permissions THEN
      RAISE EXCEPTION 'Unauthorized: only owner can change permissions';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS check_users_column_access ON public.users;
CREATE TRIGGER check_users_column_access
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION check_users_column_access();

-- 2. Only the owner may change an employee's salary.
CREATE OR REPLACE FUNCTION check_employees_column_access()
RETURNS TRIGGER AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();

  IF caller_role != 'owner' THEN
    IF NEW.salary IS DISTINCT FROM OLD.salary THEN
      RAISE EXCEPTION 'Unauthorized: only owner can change salary';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS check_employees_column_access ON public.employees;
CREATE TRIGGER check_employees_column_access
BEFORE UPDATE ON public.employees
FOR EACH ROW EXECUTE FUNCTION check_employees_column_access();

-- 3. Read-side masking: a view that nulls out salary for non-owners.
-- Built on public.employees (where salary actually lives), not public.users
-- (which has no salary column at all).
--
-- security_invoker = true is required here: without it, a view's queries
-- against the underlying table run as the view's OWNER, and RLS does not
-- apply to a table's owner by default (only FORCE ROW LEVEL SECURITY would
-- change that, which this schema doesn't use) — so an owner-privileged view
-- would leak every company's employee data through the company_id
-- isolation policy entirely, which is a far worse outcome than the problem
-- this migration is meant to fix. security_invoker makes the view honor the
-- RLS policies of whoever is actually querying it.
CREATE OR REPLACE VIEW public.employees_safe
WITH (security_invoker = true) AS
SELECT
  id, company_id, first_name, last_name, phone, birth_date, address,
  position_id, position_name, department_id, department_name,
  start_date, photo_url, status, created_at, updated_at,
  CASE
    WHEN (SELECT role FROM public.users WHERE id = auth.uid()) = 'owner'
    THEN salary
    ELSE NULL
  END AS salary
FROM public.employees;

GRANT SELECT ON public.employees_safe TO authenticated;
