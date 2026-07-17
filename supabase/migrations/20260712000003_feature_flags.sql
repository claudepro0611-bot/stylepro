-- Feature flags: catalog of add-on features and per-company activation state
CREATE TABLE IF NOT EXISTS public.feature_definitions (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text,
  price_usd numeric(10,2) NOT NULL DEFAULT 0,
  is_core boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.company_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.feature_definitions(key) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE(company_id, feature_key)
);

CREATE INDEX IF NOT EXISTS company_features_company_id_idx ON public.company_features(company_id);

-- Seed feature catalog
INSERT INTO public.feature_definitions (key, name, description, price_usd, is_core) VALUES
  ('pos', 'Kassa (POS)', 'Savdo nuqtasi va kassa moduli', 0, true),
  ('warehouse', 'Ombor boshqaruvi', 'Ko''p omborli inventarizatsiya', 0, true),
  ('hr', 'HR va xodimlar', 'Xodimlar, ish jadvali, mukofot/jarima', 10, false),
  ('marketing', 'Marketing', 'Kampaniyalar va kuponlar', 10, false),
  ('reports', 'Hisobotlar', 'Kengaytirilgan hisobot va analitika', 5, false),
  ('barcode', 'Shtrix-kod', 'Shtrix-kod generatsiyasi va chop etish', 5, false),
  ('excel_import', 'Excel import', 'Mahsulotlarni Excel orqali import qilish', 5, false)
ON CONFLICT (key) DO NOTHING;

-- Helper: mirrors the app-level SUPER_ADMIN_EMAIL check (lib/supabase/middleware.ts)
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND lower(email) = 'admin@stylepro.local'
  )
$$;

ALTER TABLE public.feature_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_features ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read" ON public.feature_definitions
  FOR SELECT USING (true);

CREATE POLICY "Company reads own features" ON public.company_features
  FOR SELECT USING (company_id = public.get_company_id());

CREATE POLICY "Super admin manages company features" ON public.company_features
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- Auto-enable core features for all existing companies
INSERT INTO public.company_features (company_id, feature_key, is_active, activated_at)
SELECT c.id, fd.key, true, now()
FROM public.companies c
CROSS JOIN public.feature_definitions fd
WHERE fd.is_core = true
ON CONFLICT (company_id, feature_key) DO NOTHING;
