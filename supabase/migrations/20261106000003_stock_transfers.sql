-- Stock transfers ("Перемещение") between warehouses.
--
-- Until now a variant (product + size + color) could exist in exactly one
-- warehouse: UNIQUE (company_id, product_id, size, color) on product_sizes.
-- A partial transfer ("move 5 of these from A to B") needs the same variant
-- to hold stock in several warehouses at once, so:
--
--   1) The variant key becomes (company_id, product_id, size, color,
--      warehouse_id) — one product_sizes row per variant PER warehouse.
--      Every stock RPC already works on a concrete product_sizes.id, so
--      sell_cart / stock_out / return_items / stock counts are unaffected.
--   2) A barcode identifies a variant, not a warehouse row: sibling rows of
--      the same variant share it. Uniqueness moves to (company_id,
--      warehouse_id, barcode), plus a trigger that refuses a barcode already
--      used by a DIFFERENT variant (keeps the old "one barcode = one item"
--      guarantee that the per-company unique index used to provide).
--   3) stock_in upserts on the new key (kirim into warehouse B no longer
--      silently adds stock to the variant's row in warehouse A), reuses the
--      sibling barcode for a new warehouse row, and keeps purchase/selling
--      price in sync across a variant's warehouse rows.
--   4) set_product_size_barcode and set_price_list_item apply to every
--      warehouse row of the variant.
--   5) stock_transfers / stock_transfer_items + create_stock_transfer RPC.
--   6) has_permission whitelist: 'peremeshenie', 'reports_peremeshenie'.

-- ─── 1) Variant key includes the warehouse ────────────────────────────────

ALTER TABLE public.product_sizes
  DROP CONSTRAINT IF EXISTS product_sizes_company_id_product_id_size_color_key;

ALTER TABLE public.product_sizes
  ADD CONSTRAINT product_sizes_variant_warehouse_key
  UNIQUE (company_id, product_id, size, color, warehouse_id);

-- ─── 2) Barcodes: shared by a variant's warehouse rows ────────────────────

DROP INDEX IF EXISTS public.product_sizes_barcode_lookup;

CREATE UNIQUE INDEX product_sizes_barcode_warehouse_key
  ON public.product_sizes (company_id, warehouse_id, barcode)
  WHERE barcode IS NOT NULL AND barcode <> '';

CREATE INDEX product_sizes_barcode_lookup
  ON public.product_sizes (company_id, barcode)
  WHERE barcode IS NOT NULL AND barcode <> '';

CREATE OR REPLACE FUNCTION public.product_sizes_barcode_variant_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.barcode IS NOT NULL AND NEW.barcode <> '' AND EXISTS (
    SELECT 1 FROM public.product_sizes ps
    WHERE ps.company_id = NEW.company_id
      AND ps.barcode = NEW.barcode
      AND ps.id <> NEW.id
      AND (ps.product_id, ps.size, ps.color) IS DISTINCT FROM (NEW.product_id, NEW.size, NEW.color)
  ) THEN
    -- 23505 + "barcode" in the message: mahsulotlar/page.tsx already maps
    -- exactly that to its "barcode already used" toast.
    RAISE EXCEPTION 'duplicate barcode: already used by another variant'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_sizes_barcode_variant_check ON public.product_sizes;
CREATE TRIGGER product_sizes_barcode_variant_check
  BEFORE INSERT OR UPDATE OF barcode, product_id, size, color ON public.product_sizes
  FOR EACH ROW EXECUTE FUNCTION public.product_sizes_barcode_variant_check();

-- ─── 3) stock_in on the new key ───────────────────────────────────────────
-- Based on 20260720000001_barcode_autogen.sql. Changes: warehouse_id is
-- required, ON CONFLICT includes it, a new warehouse row inherits the
-- variant's existing barcode, prices are synced to sibling rows.

CREATE OR REPLACE FUNCTION public.stock_in(p_entries jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_entry jsonb;
  v_quantity integer;
  v_purchase_price numeric;
  v_selling_price numeric;
  v_color text;
  v_product_id uuid;
  v_warehouse_id uuid;
  v_product_size_id uuid;
  v_current_barcode text;
  v_sibling_barcode text;
  v_generated_barcode text;
BEGIN
  IF NOT public.has_permission('kirim') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_entries IS NULL OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'No entries to record';
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    v_quantity := (v_entry->>'quantity')::integer;
    v_purchase_price := COALESCE((v_entry->>'purchase_price')::numeric, 0);
    v_selling_price := COALESCE((v_entry->>'selling_price')::numeric, 0);
    v_color := COALESCE(v_entry->>'color', '');
    v_product_id := (v_entry->>'product_id')::uuid;
    v_warehouse_id := NULLIF(v_entry->>'warehouse_id', '')::uuid;

    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-in quantity: %', v_entry;
    END IF;

    IF v_warehouse_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.warehouses WHERE id = v_warehouse_id AND company_id = v_company_id
    ) THEN
      RAISE EXCEPTION 'Invalid warehouse';
    END IF;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, color, stock, warehouse_id,
      purchase_price, selling_price, updated_at
    ) VALUES (
      v_company_id, v_product_id, v_entry->>'size', v_color, v_quantity, v_warehouse_id,
      v_purchase_price, v_selling_price, now()
    )
    ON CONFLICT (company_id, product_id, size, color, warehouse_id) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          purchase_price = excluded.purchase_price,
          selling_price = excluded.selling_price,
          updated_at = now()
    RETURNING id, barcode INTO v_product_size_id, v_current_barcode;

    -- Keep one price per variant across warehouses.
    UPDATE public.product_sizes
    SET purchase_price = v_purchase_price, selling_price = v_selling_price, updated_at = now()
    WHERE company_id = v_company_id AND product_id = v_product_id
      AND size = v_entry->>'size' AND color = v_color AND id <> v_product_size_id;

    IF v_current_barcode IS NULL OR v_current_barcode = '' THEN
      SELECT barcode INTO v_sibling_barcode
      FROM public.product_sizes
      WHERE company_id = v_company_id AND product_id = v_product_id
        AND size = v_entry->>'size' AND color = v_color AND id <> v_product_size_id
        AND barcode IS NOT NULL AND barcode <> ''
      LIMIT 1;

      v_generated_barcode := COALESCE(
        v_sibling_barcode,
        lpad(extract(epoch FROM now())::bigint::text, 13, '0') || lpad(v_product_size_id::text, 4, '0')
      );
      UPDATE public.product_sizes
      SET barcode = v_generated_barcode
      WHERE id = v_product_size_id AND (barcode IS NULL OR barcode = '');
    END IF;

    INSERT INTO public.stock_in_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, unit_price, purchase_price, selling_price, total_amount,
      supplier, date, note, product_size_id
    ) VALUES (
      v_company_id,
      v_product_id,
      v_entry->>'product_name',
      v_entry->>'category',
      v_entry->>'size',
      v_color,
      v_quantity,
      v_purchase_price,
      v_purchase_price,
      v_selling_price,
      v_purchase_price * v_quantity,
      v_entry->>'supplier',
      COALESCE((v_entry->>'date')::date, current_date),
      v_entry->>'note',
      v_product_size_id
    );
  END LOOP;
END;
$$;

-- ─── 4) Barcode / price-list edits apply to the whole variant ─────────────

CREATE OR REPLACE FUNCTION public.set_product_size_barcode(p_id uuid, p_barcode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_row public.product_sizes%ROWTYPE;
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

  SELECT * INTO v_row FROM public.product_sizes WHERE id = p_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product size not found';
  END IF;

  UPDATE public.product_sizes
  SET barcode = p_barcode, updated_at = now()
  WHERE company_id = v_company_id AND product_id = v_row.product_id
    AND size = v_row.size AND color = v_row.color;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_price_list_item(p_price_list_id uuid, p_product_size_id uuid, p_price numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
  v_row public.product_sizes%ROWTYPE;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.price_lists WHERE id = p_price_list_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Price list not found';
  END IF;
  SELECT * INTO v_row FROM public.product_sizes WHERE id = p_product_size_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid product_size_id';
  END IF;
  IF p_price IS NOT NULL AND p_price < 0 THEN
    RAISE EXCEPTION 'Invalid price';
  END IF;

  IF p_price IS NULL THEN
    DELETE FROM public.price_list_items pli
    USING public.product_sizes ps
    WHERE pli.price_list_id = p_price_list_id
      AND pli.product_size_id = ps.id
      AND ps.company_id = v_company_id AND ps.product_id = v_row.product_id
      AND ps.size = v_row.size AND ps.color = v_row.color;
  ELSE
    INSERT INTO public.price_list_items (price_list_id, product_size_id, company_id, price)
    SELECT p_price_list_id, ps.id, v_company_id, p_price
    FROM public.product_sizes ps
    WHERE ps.company_id = v_company_id AND ps.product_id = v_row.product_id
      AND ps.size = v_row.size AND ps.color = v_row.color
    ON CONFLICT (price_list_id, product_size_id) DO UPDATE SET price = EXCLUDED.price;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_price_list_item(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_price_list_item(uuid, uuid, numeric) TO authenticated;

-- ─── 5) Transfers ─────────────────────────────────────────────────────────

CREATE TABLE public.stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  from_warehouse_id uuid NOT NULL REFERENCES public.warehouses(id),
  to_warehouse_id uuid NOT NULL REFERENCES public.warehouses(id),
  date date NOT NULL DEFAULT current_date,
  note text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfers_company_number_key UNIQUE (company_id, number),
  CONSTRAINT stock_transfers_distinct_warehouses CHECK (from_warehouse_id <> to_warehouse_id)
);

COMMENT ON TABLE public.stock_transfers IS
  'Stock moved between warehouses (peremeshenie). Read via RLS (company-scoped '
  'SELECT); write ONLY via create_stock_transfer.';

CREATE INDEX stock_transfers_company_date_idx ON public.stock_transfers (company_id, date DESC);

CREATE TABLE public.stock_transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES public.stock_transfers(id) ON DELETE CASCADE,
  product_id uuid NULL REFERENCES public.products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  category text NULL,
  size text NOT NULL,
  color text NOT NULL DEFAULT '',
  quantity integer NOT NULL CHECK (quantity > 0),
  purchase_price numeric NOT NULL DEFAULT 0,
  from_product_size_id uuid NULL REFERENCES public.product_sizes(id) ON DELETE SET NULL,
  to_product_size_id uuid NULL REFERENCES public.product_sizes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stock_transfer_items_transfer_idx ON public.stock_transfer_items (transfer_id);

ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation (select)" ON public.stock_transfers
  FOR SELECT TO authenticated
  USING (company_id = public.get_company_id());

CREATE POLICY "Company isolation (select)" ON public.stock_transfer_items
  FOR SELECT TO authenticated
  USING (company_id = public.get_company_id());

REVOKE ALL ON public.stock_transfers FROM authenticated, anon;
REVOKE ALL ON public.stock_transfer_items FROM authenticated, anon;
GRANT SELECT ON public.stock_transfers TO authenticated;
GRANT SELECT ON public.stock_transfer_items TO authenticated;

-- p_items: [{ "product_size_id": uuid, "quantity": int }, ...] — every
-- product_size_id must be a row of p_from_warehouse_id. Each source row is
-- locked FOR UPDATE, decremented, and the matching row in the destination
-- warehouse is created (inheriting barcode, prices and price-list prices)
-- or incremented. All-or-nothing: any shortfall aborts the whole transfer.
CREATE OR REPLACE FUNCTION public.create_stock_transfer(
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_items jsonb,
  p_note text DEFAULT NULL,
  p_date date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_transfer_id uuid;
  v_number integer;
  v_item jsonb;
  v_quantity integer;
  v_src public.product_sizes%ROWTYPE;
  v_dest_id uuid;
  v_product_name text;
  v_category text;
  v_user_name text;
BEGIN
  IF NOT public.has_permission('peremeshenie') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_from_warehouse_id IS NULL OR p_to_warehouse_id IS NULL OR p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'Invalid warehouses';
  END IF;
  IF (SELECT count(*) FROM public.warehouses
      WHERE company_id = v_company_id AND id IN (p_from_warehouse_id, p_to_warehouse_id)) <> 2 THEN
    RAISE EXCEPTION 'Invalid warehouses';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items to transfer';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('stock_transfer:' || v_company_id::text));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.stock_transfers WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.stock_transfers (
    company_id, number, from_warehouse_id, to_warehouse_id, date, note, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, p_from_warehouse_id, p_to_warehouse_id,
    COALESCE(p_date, current_date), NULLIF(trim(p_note), ''), auth.uid(), v_user_name
  )
  RETURNING id INTO v_transfer_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity: %', v_item;
    END IF;

    SELECT * INTO v_src
    FROM public.product_sizes
    WHERE id = (v_item->>'product_size_id')::uuid
      AND company_id = v_company_id
      AND warehouse_id = p_from_warehouse_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid product_size_id: %', v_item->>'product_size_id';
    END IF;
    IF v_src.stock < v_quantity THEN
      RAISE EXCEPTION 'Insufficient stock for product_size %', v_src.id;
    END IF;

    UPDATE public.product_sizes
    SET stock = stock - v_quantity, updated_at = now()
    WHERE id = v_src.id;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, color, stock, warehouse_id,
      purchase_price, selling_price, sku, barcode, updated_at
    ) VALUES (
      v_company_id, v_src.product_id, v_src.size, v_src.color, v_quantity, p_to_warehouse_id,
      v_src.purchase_price, v_src.selling_price, v_src.sku, NULLIF(v_src.barcode, ''), now()
    )
    ON CONFLICT (company_id, product_id, size, color, warehouse_id) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          updated_at = now()
    RETURNING id INTO v_dest_id;

    -- Price-list prices follow the variant into the new warehouse row.
    INSERT INTO public.price_list_items (price_list_id, product_size_id, company_id, price)
    SELECT price_list_id, v_dest_id, company_id, price
    FROM public.price_list_items
    WHERE product_size_id = v_src.id
    ON CONFLICT (price_list_id, product_size_id) DO NOTHING;

    SELECT name, category INTO v_product_name, v_category
    FROM public.products WHERE id = v_src.product_id;

    INSERT INTO public.stock_transfer_items (
      company_id, transfer_id, product_id, product_name, category, size, color,
      quantity, purchase_price, from_product_size_id, to_product_size_id
    ) VALUES (
      v_company_id, v_transfer_id, v_src.product_id, COALESCE(v_product_name, '—'), v_category,
      v_src.size, v_src.color, v_quantity, COALESCE(v_src.purchase_price, 0), v_src.id, v_dest_id
    );
  END LOOP;

  RETURN v_transfer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_stock_transfer(uuid, uuid, jsonb, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_stock_transfer(uuid, uuid, jsonb, text, date) TO authenticated;

-- ─── 6) Permission whitelist ──────────────────────────────────────────────
-- Reproduced from 20261106000002_report_permissions.sql with the two new
-- keys appended.

CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_role text;
  v_permissions jsonb;
  v_valid_keys text[] := ARRAY[
    'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
    'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
    'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
    'reports_moliya', 'reports_foyda', 'reports_sotuvlar', 'reports_mijozlar',
    'reports_yetkazuvchilar', 'reports_kirim', 'reports_spisaniya',
    'reports_xarajatlar', 'reports_inventar',
    'peremeshenie', 'reports_peremeshenie'
  ];
BEGIN
  IF NOT (p_key = ANY(v_valid_keys)) THEN
    RETURN false;
  END IF;

  SELECT role, permissions INTO v_role, v_permissions
  FROM public.users
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;
