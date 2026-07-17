-- Bug: warehouse types broken after adding a third (accessory) warehouse.
--
-- Diagnosis (reported before any change was made):
-- a) warehouses.type CHECK was `type = ANY (ARRAY['clothing','footwear',
--    'other'])` — already three values, not the two the brief assumed.
--    The mislabeled row already existed as ('Aksesuar', 'other').
-- b) UI bug #1: kirim/page.tsx's warehouse selector button hardcoded
--    `w.type === 'clothing' ? 'Kiyimlar ombori' : 'Oyoq kiyim ombori'` —
--    ignoring w.name entirely and treating any non-'clothing' type
--    (footwear AND other) as "footwear", which is exactly the reported
--    "two display as footwear" symptom. Fixed client-side (this migration
--    only touches the database).
-- c) Product-per-warehouse filtering in kirim/chiqim/brak used
--    warehouseTypeForSizeType(product_group.size_type) === warehouse.type
--    to decide which products even show up in the product picker, with a
--    `type === 'other' -> return all products` special case. That special
--    case is exactly "warehouse 3 shows everything". The "warehouse 2
--    mixes footwear and accessories" symptom traces to the accessory
--    product group ("Rolex") having size_type = 'shoe' (there is no
--    accessory size_type — clothing/shoe/universal are the only options),
--    so warehouseTypeForSizeType('shoe') routed it to the 'footwear'
--    warehouse's product list. All three symptoms were UI-layer
--    type-matching bugs; product_sizes.warehouse_id (set explicitly by the
--    user at kirim time) was never wrong and is now the only thing any
--    page filters by. Fixed client-side.
-- d) The third warehouse was created via inventory/page.tsx's existing
--    (undocumented) warehouse-management UI, which called
--    `supabase.from('warehouses').insert(...)` directly from the client —
--    no RPC, no permission gate. Confirmed `authenticated` still has
--    direct INSERT/UPDATE/DELETE on warehouses; revoked below after
--    replacing those calls with SECURITY DEFINER RPCs.

-- Step 2a: relax the type constraint. Additive only — 'other' is kept
-- (not dropped) since existing/future rows may still use it; 'accessory'
-- and 'general' are added as first-class values.
ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS warehouses_type_check;
ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_type_check
  CHECK (type = ANY (ARRAY['clothing', 'footwear', 'accessory', 'general', 'other']));

-- Step 2b: relabel the specific mislabeled row from this incident.
UPDATE public.warehouses
SET type = 'accessory'
WHERE id = 'd5fbe130-2745-465c-a47e-1500a929504f' AND type = 'other';

-- Step 4: SECURITY DEFINER RPCs for warehouse management, replacing the
-- direct client-side insert/delete in inventory/page.tsx. Gated on
-- has_permission('inventory') since that's the page this UI lives on.

CREATE OR REPLACE FUNCTION public.create_warehouse(p_name text, p_type text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_limit integer;
  v_count integer;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Warehouse name is required';
  END IF;

  SELECT warehouse_limit INTO v_limit FROM public.companies WHERE id = v_company_id;
  SELECT count(*) INTO v_count FROM public.warehouses WHERE company_id = v_company_id;
  IF v_count >= COALESCE(v_limit, 2) THEN
    RAISE EXCEPTION 'Warehouse limit reached' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.warehouses (company_id, name, type)
  VALUES (v_company_id, trim(p_name), p_type)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_warehouse(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_warehouse(p_id uuid, p_name text, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Warehouse name is required';
  END IF;

  UPDATE public.warehouses
  SET name = trim(p_name), type = COALESCE(p_type, type)
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_warehouse(uuid, text, text) TO authenticated;

-- product_sizes.warehouse_id is the real reference check — any row
-- referencing this warehouse blocks deletion, regardless of its current
-- stock level (the client's old "isEmpty" check summed stock quantity,
-- which is a different, weaker condition than row existence and could let
-- the client attempt a delete the FK would reject anyway).
CREATE OR REPLACE FUNCTION public.delete_warehouse(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_ref_count integer;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT count(*) INTO v_ref_count
  FROM public.product_sizes
  WHERE warehouse_id = p_id AND company_id = v_company_id;

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION 'Warehouse has % linked product size row(s)', v_ref_count
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.warehouses WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_warehouse(uuid) TO authenticated;

-- Every warehouse write now goes through the RPCs above.
REVOKE INSERT, UPDATE, DELETE ON public.warehouses FROM authenticated;
