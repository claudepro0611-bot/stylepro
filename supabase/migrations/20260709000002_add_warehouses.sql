-- Warehouses (omborlar) - scoped to a company
CREATE TABLE IF NOT EXISTS public.warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('clothing', 'footwear')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warehouses_company_id_idx ON public.warehouses(company_id);

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation" ON public.warehouses
  FOR ALL USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

-- Link product_sizes rows to a warehouse
ALTER TABLE public.product_sizes
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id);
