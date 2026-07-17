-- Extends the column-security pattern from 20260712000009_column_security.sql
-- to public.position_history, which was found to have its own unmasked
-- salary column: employees_safe hides the employee's *current* salary from
-- non-owners, but the "ish tarixi" (work history) panel read raw
-- position_history directly, leaking every historical salary value
-- regardless of role.

-- 1. Only the owner may change a historical salary entry. Insert is left
-- unguarded on purpose, same as employees: anyone with HR access can create
-- a new history row (e.g. hiring an employee, per addEmployee's existing
-- flow) with an initial salary, but nobody but the owner may retroactively
-- edit one via a direct UPDATE call.
CREATE OR REPLACE FUNCTION check_position_history_column_access()
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

DROP TRIGGER IF EXISTS check_position_history_column_access ON public.position_history;
CREATE TRIGGER check_position_history_column_access
BEFORE UPDATE ON public.position_history
FOR EACH ROW EXECUTE FUNCTION check_position_history_column_access();

-- 2. Read-side masking, same security_invoker requirement as employees_safe
-- (without it, the view would run against the underlying table as its
-- owner, bypassing the company_id isolation policy entirely).
CREATE OR REPLACE VIEW public.position_history_safe
WITH (security_invoker = true) AS
SELECT
  id, company_id, employee_id, date, position_name, department_name, note, created_at,
  CASE
    WHEN (SELECT role FROM public.users WHERE id = auth.uid()) = 'owner'
    THEN salary
    ELSE NULL
  END AS salary
FROM public.position_history;

GRANT SELECT ON public.position_history_safe TO authenticated;
