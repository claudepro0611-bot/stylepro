CREATE TABLE IF NOT EXISTS public.company_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{
    "product": {
      "unit_type": "dona",
      "block_size": 1
    }
  }'::jsonb,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company reads own settings" ON public.company_settings
  FOR SELECT USING (company_id = public.get_company_id());

CREATE POLICY "Owner updates settings" ON public.company_settings
  FOR ALL USING (
    company_id = public.get_company_id() AND
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'owner'
  )
  WITH CHECK (
    company_id = public.get_company_id() AND
    (SELECT role FROM public.users WHERE id = auth.uid()) = 'owner'
  );

CREATE TRIGGER company_settings_set_updated_at
  BEFORE UPDATE ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auto-provision default settings for any company created after this
-- migration. The existing on_company_created trigger (seed_warehouses.sql)
-- only seeds warehouses — without this, every future company would have no
-- company_settings row at all, and useSettings()'s .single() call would
-- error for them.
CREATE OR REPLACE FUNCTION public.handle_new_company_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.company_settings (company_id)
  VALUES (NEW.id)
  ON CONFLICT (company_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_company_created_settings ON public.companies;
CREATE TRIGGER on_company_created_settings
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_company_settings();

-- Backfill default settings for existing companies.
INSERT INTO public.company_settings (company_id)
SELECT id FROM public.companies
ON CONFLICT (company_id) DO NOTHING;
