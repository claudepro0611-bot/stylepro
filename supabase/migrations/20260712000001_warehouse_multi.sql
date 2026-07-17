-- Allow companies to have more than one warehouse per type, and a third
-- free-form 'other' type, now that warehouse_limit is configurable per company.
ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS warehouses_company_type_key;

ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS warehouses_type_check;
ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_type_check CHECK (type IN ('clothing', 'footwear', 'other'));
