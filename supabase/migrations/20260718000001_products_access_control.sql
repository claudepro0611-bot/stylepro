-- Phase 4: schema cleanup and access control completion.
--
-- Step 1 (audit finding M1): products.stock is a vestigial column. Verified
-- via grep across app/ that every `.stock` reference resolves to either
-- product_sizes.stock (the real, live quantity — pos/chiqim/brak/inventory/
-- dashboard all read stock through product_sizes, never products.stock) or
-- to the unrelated products.min_stock. Several pages `.select('*')` on
-- products, which incidentally fetches the column, but none ever assign or
-- read it. Safe to drop.
ALTER TABLE public.products DROP COLUMN IF EXISTS stock;

-- Step 2 (audit finding L1): product_sizes.warehouse_id backfill (prior
-- migration 20260709000003_seed_warehouses.sql) is confirmed complete —
-- `SELECT count(*) FROM product_sizes WHERE warehouse_id IS NULL` returned 0
-- immediately before this migration was written. No further backfill
-- needed; go straight to the NOT NULL constraint.
ALTER TABLE public.product_sizes ALTER COLUMN warehouse_id SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Step 3: gate product / product-group mutations behind has_permission().
--
-- Write-path inventory (from a full read of both pages):
--   mahsulotlar/page.tsx:     saveAdd -> products insert, saveEdit -> products
--                             update. No delete UI exists, but delete_product
--                             is still built per the brief, for parity with
--                             the other five and for any future delete button.
--   mahsulot-guruhi/page.tsx: saveGroup -> product_groups insert/update,
--                             toggleStatus -> product_groups update (status
--                             only), executeDelete -> product_groups delete.
--
-- Unplanned discovery while reading the two pages in full: both
-- components/mahsulotlar/ImportModal.tsx and BarcodeModal.tsx (imported by
-- mahsulotlar/page.tsx but living under components/, outside the original
-- Phase 1 grep scope of app/) write directly to products/product_groups/
-- product_sizes. ImportModal's product_sizes upsert and BarcodeModal's
-- barcode UPDATE have been silently broken (permission denied) since
-- 20260715000004_revoke_direct_stock_writes.sql already revoked write
-- grants on product_sizes from `authenticated` — a gap from Phase 1's
-- app/-only sweep, not something this migration introduces. Since this
-- migration's REVOKE below newly removes ImportModal's remaining direct
-- write path (products/product_groups), it is being rewired to the RPCs
-- below in the same change, and a small 7th RPC (set_product_size_barcode)
-- is added to fix BarcodeModal's pre-existing break too, following the same
-- has_permission()-gated pattern as everything else here.

-- ─── create_product ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_product(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
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

  INSERT INTO public.products (
    company_id, name, sku, category, price, min_stock, colors, description, status
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
    COALESCE(p_data->>'status', 'active')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product(jsonb) TO authenticated;

-- ─── update_product ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_product(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
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
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_product(uuid, jsonb) TO authenticated;

-- ─── delete_product ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_product(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.products WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_product(uuid) TO authenticated;

-- ─── create_product_group ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_product_group(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulot_guruhi') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Group name is required';
  END IF;

  INSERT INTO public.product_groups (company_id, name, description, status, size_type)
  VALUES (
    v_company_id,
    trim(p_data->>'name'),
    p_data->>'description',
    COALESCE(p_data->>'status', 'active'),
    COALESCE(p_data->>'size_type', 'clothing')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product_group(jsonb) TO authenticated;

-- ─── update_product_group ─────────────────────────────────────────────────
-- Partial-update by design: mahsulot-guruhi/page.tsx's toggleStatus() only
-- ever sends {status}, while saveGroup() sends all four fields — both call
-- through this same RPC, so only keys present in p_data are touched.
CREATE OR REPLACE FUNCTION public.update_product_group(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulot_guruhi') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  UPDATE public.product_groups SET
    name = CASE WHEN p_data ? 'name' THEN trim(p_data->>'name') ELSE name END,
    description = CASE WHEN p_data ? 'description' THEN p_data->>'description' ELSE description END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END,
    size_type = CASE WHEN p_data ? 'size_type' THEN p_data->>'size_type' ELSE size_type END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product group not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_product_group(uuid, jsonb) TO authenticated;

-- ─── delete_product_group ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_product_group(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulot_guruhi') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.product_groups WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product group not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_product_group(uuid) TO authenticated;

-- ─── set_product_size_barcode (bonus fix, see note above) ────────────────
-- Narrow, single-field RPC replacing BarcodeModal.tsx's direct
-- product_sizes.update({barcode}) call, which has been dead since Phase 2
-- revoked table writes. Gated by 'mahsulotlar' since barcode assignment is
-- part of product management, not stock quantity (stock_in/stock_out
-- already own the quantity side of product_sizes).
CREATE OR REPLACE FUNCTION public.set_product_size_barcode(p_id uuid, p_barcode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_barcode IS NULL OR trim(p_barcode) = '' THEN
    RAISE EXCEPTION 'Barcode is required';
  END IF;

  UPDATE public.product_sizes
  SET barcode = p_barcode, updated_at = now()
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product size not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_product_size_barcode(uuid, text) TO authenticated;

-- ─── Revoke direct client writes ──────────────────────────────────────────
-- Matches the Phase 2 posture on stock tables: RLS alone isn't enough since
-- Supabase's schema-level default privileges grant `authenticated` full
-- CRUD regardless of policy. Every product/group write now goes through the
-- SECURITY DEFINER RPCs above.
REVOKE INSERT, UPDATE, DELETE ON public.products FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.product_groups FROM authenticated;
