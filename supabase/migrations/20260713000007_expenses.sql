-- Expense categories (owner creates custom ones)
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text DEFAULT '#6366f1',
  created_at timestamptz DEFAULT now(),
  UNIQUE (company_id, name)
);

-- Expenses
CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.expense_categories(id),
  amount numeric(14,2) NOT NULL,
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'transfer')),
  date date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  -- ON DELETE SET NULL (not the default NO ACTION): without this, removing
  -- a staff account that ever logged an expense (deleteTeamUser -> auth
  -- admin.deleteUser) would fail with a foreign-key violation forever.
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation" ON public.expense_categories
  FOR ALL USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

CREATE POLICY "Company isolation" ON public.expenses
  FOR ALL USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

-- Default categories, auto-seeded for every new company.
-- SECURITY DEFINER + explicit schema qualification, matching every other
-- trigger function in this schema (get_company_id, handle_new_user,
-- handle_new_company_settings): without SECURITY DEFINER, this insert runs
-- as whoever triggered the companies INSERT. The "Authenticated users can
-- create a company" policy (helper_functions.sql) lets a plain authenticated
-- user create their own company row directly — at that exact moment their
-- own users.company_id is still the OLD value (linking happens in a
-- separate follow-up step), so get_company_id() would return the wrong
-- company and this seed insert's WITH CHECK would fail, aborting the whole
-- company-creation transaction.
CREATE OR REPLACE FUNCTION public.seed_expense_categories()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.expense_categories (company_id, name, color) VALUES
    (NEW.id, 'Ijara', '#6366f1'),
    (NEW.id, 'Maosh', '#22c55e'),
    (NEW.id, 'Kommunal', '#f59e0b'),
    (NEW.id, 'Transport', '#3b82f6'),
    (NEW.id, 'Reklama', '#ec4899'),
    (NEW.id, 'Ta''mirlash', '#f97316')
  ON CONFLICT (company_id, name) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_expense_categories ON public.companies;
CREATE TRIGGER seed_expense_categories
AFTER INSERT ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.seed_expense_categories();

-- Backfill for existing companies. Conflict target added (company_id, name)
-- backed by the UNIQUE constraint above — the original had a bare
-- "ON CONFLICT DO NOTHING" with nothing to conflict against (id is always a
-- fresh gen_random_uuid()), so re-running this migration would have
-- silently duplicated every default category for every company each time.
INSERT INTO public.expense_categories (company_id, name, color)
SELECT c.id, cat.name, cat.color
FROM public.companies c
CROSS JOIN (VALUES
  ('Ijara', '#6366f1'),
  ('Maosh', '#22c55e'),
  ('Kommunal', '#f59e0b'),
  ('Transport', '#3b82f6'),
  ('Reklama', '#ec4899'),
  ('Ta''mirlash', '#f97316')
) AS cat(name, color)
ON CONFLICT (company_id, name) DO NOTHING;
