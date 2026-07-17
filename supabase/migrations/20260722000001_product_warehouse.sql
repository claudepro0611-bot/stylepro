-- Associate each product with a single warehouse, so kirim/chiqim/brak can
-- filter their product pickers by the selected warehouse instead of
-- showing every product regardless of where it's actually stocked.

-- Step 1a
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE SET NULL;

-- Step 1b: backfill from whichever warehouse holds the most of a product's
-- product_sizes rows. product_sizes.warehouse_id has been NOT NULL since
-- the Phase 4 migration, so every existing size row already has one;
-- products with zero product_sizes rows have no candidate and are left
-- NULL, matching the brief exactly ("if no product_sizes exist, leave
-- NULL"). Ties (a product split evenly across two warehouses) are broken
-- arbitrarily by row_number()'s stable-but-unspecified ordering — reported
-- separately if any existed at backfill time.
WITH ranked AS (
  SELECT
    product_id,
    warehouse_id,
    count(*) AS cnt,
    row_number() OVER (PARTITION BY product_id ORDER BY count(*) DESC) AS rn
  FROM public.product_sizes
  WHERE warehouse_id IS NOT NULL
  GROUP BY product_id, warehouse_id
)
UPDATE public.products p
SET warehouse_id = r.warehouse_id
FROM ranked r
WHERE r.product_id = p.id AND r.rn = 1;

-- Step 2: create_product / update_product now accept and store
-- warehouse_id. Client-supplied ids are validated against the caller's own
-- company (not just FK existence) before being trusted, same principle
-- used everywhere else client input touches a foreign key in this schema.

CREATE OR REPLACE FUNCTION public.create_product(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_warehouse_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Product name is required';
  END IF;

  v_warehouse_id := NULLIF(p_data->>'warehouse_id', '')::uuid;
  IF v_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouses WHERE id = v_warehouse_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid warehouse';
  END IF;

  INSERT INTO public.products (
    company_id, name, sku, category, price, min_stock, colors, description, status, warehouse_id
  ) VALUES (
    v_company_id,
    trim(p_data->>'name'),
    NULLIF(p_data->>'sku', ''),
    p_data->>'category',
    COALESCE((p_data->>'price')::numeric, 0),
    COALESCE((p_data->>'min_stock')::integer, 5),
    CASE WHEN p_data ? 'colors'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'colors'))
      ELSE '{}'::text[]
    END,
    p_data->>'description',
    COALESCE(p_data->>'status', 'active'),
    v_warehouse_id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_product(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_warehouse_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data ? 'warehouse_id' THEN
    v_warehouse_id := NULLIF(p_data->>'warehouse_id', '')::uuid;
    IF v_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'Warehouse is required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.warehouses WHERE id = v_warehouse_id AND company_id = v_company_id
    ) THEN
      RAISE EXCEPTION 'Invalid warehouse';
    END IF;
  END IF;

  UPDATE public.products SET
    name = CASE WHEN p_data ? 'name' THEN trim(p_data->>'name') ELSE name END,
    sku = CASE WHEN p_data ? 'sku' THEN NULLIF(p_data->>'sku', '') ELSE sku END,
    category = CASE WHEN p_data ? 'category' THEN p_data->>'category' ELSE category END,
    price = CASE WHEN p_data ? 'price' THEN COALESCE((p_data->>'price')::numeric, price) ELSE price END,
    min_stock = CASE WHEN p_data ? 'min_stock' THEN COALESCE((p_data->>'min_stock')::integer, min_stock) ELSE min_stock END,
    colors = CASE WHEN p_data ? 'colors'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'colors'))
      ELSE colors
    END,
    description = CASE WHEN p_data ? 'description' THEN p_data->>'description' ELSE description END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END,
    warehouse_id = CASE WHEN p_data ? 'warehouse_id' THEN v_warehouse_id ELSE warehouse_id END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_product(uuid, jsonb) TO authenticated;
