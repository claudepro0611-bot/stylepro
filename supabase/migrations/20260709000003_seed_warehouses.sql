-- Fix schema drift: product_groups.size_type is used by the app but was never migrated
ALTER TABLE public.product_groups
  ADD COLUMN IF NOT EXISTS size_type text NOT NULL DEFAULT 'clothing'
    CHECK (size_type IN ('clothing', 'shoe', 'universal'));

-- One warehouse per (company, type)
ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_company_type_key UNIQUE (company_id, type);

-- Backfill: create the two default warehouses for every existing company
INSERT INTO public.warehouses (company_id, name, type)
SELECT id, 'Kiyimlar ombori', 'clothing' FROM public.companies
ON CONFLICT (company_id, type) DO NOTHING;

INSERT INTO public.warehouses (company_id, name, type)
SELECT id, 'Oyoq kiyim ombori', 'footwear' FROM public.companies
ON CONFLICT (company_id, type) DO NOTHING;

-- Auto-provision both warehouses whenever a new company is created
CREATE OR REPLACE FUNCTION public.handle_new_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.warehouses (company_id, name, type)
  VALUES (NEW.id, 'Kiyimlar ombori', 'clothing'), (NEW.id, 'Oyoq kiyim ombori', 'footwear');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_company_created
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_company();

-- Backfill product_sizes.warehouse_id for existing rows from product category -> size_type
UPDATE public.product_sizes ps
SET warehouse_id = w.id
FROM public.products p
LEFT JOIN public.product_groups pg ON pg.company_id = p.company_id AND pg.name = p.category
JOIN public.warehouses w ON w.company_id = ps.company_id
  AND w.type = CASE WHEN pg.size_type = 'shoe' THEN 'footwear' ELSE 'clothing' END
WHERE ps.product_id = p.id AND ps.warehouse_id IS NULL;
