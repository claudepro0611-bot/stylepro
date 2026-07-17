-- Fix audit finding L2: "Users can update own company" allowed ANY
-- authenticated user of a company (not just owner) to update company-level
-- fields directly via the client — including balance/monthly_fee, which
-- are billing fields the platform (super-admin) controls, not the company
-- itself. No page currently uses this path (grepped app/ for
-- .from('companies').update — zero matches; every write already goes
-- through super-admin/actions.ts's service-role client), so this only
-- closes an unused-but-exploitable gap, it doesn't change any working flow.

DROP POLICY IF EXISTS "Users can update own company" ON public.companies;

CREATE POLICY "Owner can update own company" ON public.companies
  FOR UPDATE
  USING (
    id = public.get_company_id()
    AND (SELECT role FROM public.users WHERE id = auth.uid()) = 'owner'
  )
  WITH CHECK (
    id = public.get_company_id()
    AND (SELECT role FROM public.users WHERE id = auth.uid()) = 'owner'
  );

-- Billing columns stay off-limits even to the owner. Only a service-role
-- call (super-admin/actions.ts's updateCompanyBilling, no auth.uid() in
-- context) may change them — mirrors the exact pattern already used for
-- users.permissions / employees.salary in 20260712000009_column_security.sql.
CREATE OR REPLACE FUNCTION check_companies_billing_column_access()
RETURNS TRIGGER AS $$
DECLARE
  caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.users WHERE id = auth.uid();

  -- caller_role IS NULL means auth.uid() didn't resolve — a service-role
  -- call (super-admin/actions.ts's updateCompanyBilling) with no user JWT.
  -- Any real end-user session (caller_role IS NOT NULL) is blocked from
  -- touching these two columns, regardless of role — not even the owner.
  IF caller_role IS NOT NULL THEN
    IF NEW.balance IS DISTINCT FROM OLD.balance
      OR NEW.monthly_fee IS DISTINCT FROM OLD.monthly_fee THEN
      RAISE EXCEPTION 'Unauthorized: only the platform can change billing fields';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS check_companies_billing_column_access ON public.companies;
CREATE TRIGGER check_companies_billing_column_access
BEFORE UPDATE ON public.companies
FOR EACH ROW EXECUTE FUNCTION check_companies_billing_column_access();
