-- Add warehouse_limit to companies table
ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS warehouse_limit integer NOT NULL DEFAULT 2;

-- Add check to ensure limit is positive
ALTER TABLE public.companies
ADD CONSTRAINT warehouse_limit_positive CHECK (warehouse_limit >= 0);

-- Function to enforce warehouse limit at DB level
CREATE OR REPLACE FUNCTION check_warehouse_limit()
RETURNS TRIGGER AS $$
DECLARE
  current_count integer;
  max_limit integer;
BEGIN
  SELECT COUNT(*) INTO current_count
  FROM public.warehouses
  WHERE company_id = NEW.company_id;

  SELECT warehouse_limit INTO max_limit
  FROM public.companies
  WHERE id = NEW.company_id;

  IF current_count >= max_limit THEN
    RAISE EXCEPTION 'Warehouse limit reached: max % warehouses allowed', max_limit;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger before insert
DROP TRIGGER IF EXISTS enforce_warehouse_limit ON public.warehouses;
CREATE TRIGGER enforce_warehouse_limit
BEFORE INSERT ON public.warehouses
FOR EACH ROW EXECUTE FUNCTION check_warehouse_limit();
