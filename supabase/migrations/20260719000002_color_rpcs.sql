-- Phase 5 step 2/3: stock_in now creates/increments product_sizes keyed by
-- (company_id, product_id, size, color) instead of (company_id, product_id,
-- size). stock_out's ledger insert now derives color from the product_sizes
-- row itself (authoritative) rather than trusting whatever the client
-- happened to pass — the same "don't trust a client-supplied value when an
-- authoritative source already exists" principle used for return_items.
--
-- sell_cart and return_items are intentionally NOT touched here (per the
-- brief: "product_size_id (PK) unchanged... confirm they still compile").
-- Both already resolve everything by product_sizes.id, which this migration
-- does not change, so both continue to work as-is with no SQL edits needed.
--
-- Minor, low-risk addition beyond the brief's literal snippet: `updated_at
-- = now()` is kept in stock_in's ON CONFLICT DO UPDATE (it was already
-- there pre-Phase-5 and every other RPC in this file does the same on
-- write) — dropping it would silently stop refreshing the timestamp on
-- restock for no reason the brief asked for.
--
-- Scope reduction, flagged: the brief's literal INSERT/DO UPDATE column
-- list for stock_in omits `sku` and `barcode` (both of which the pre-
-- Phase-5 version wrote). Barcode assignment already lives entirely in
-- BarcodeModal.tsx (set_product_size_barcode, added in Phase 4) and POS
-- already falls back to products.sku when product_sizes.sku is null, so
-- dropping both from stock_in's writes is safe — not a functional loss,
-- just moving sku/barcode out of the kirim flow entirely, matching the
-- brief's exact SQL and the redesigned kirim UI (Step 4) which no longer
-- collects either field.

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
  v_color text;
  v_product_size_id uuid;
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
    -- Color defaults to '' when not supplied, so any caller written before
    -- this migration (none remain after Step 4, but kept for safety) does
    -- not break.
    v_color := COALESCE(v_entry->>'color', '');

    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-in quantity: %', v_entry;
    END IF;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, color, stock, warehouse_id,
      purchase_price, selling_price, updated_at
    ) VALUES (
      v_company_id,
      (v_entry->>'product_id')::uuid,
      v_entry->>'size',
      v_color,
      v_quantity,
      NULLIF(v_entry->>'warehouse_id', '')::uuid,
      v_purchase_price,
      COALESCE((v_entry->>'selling_price')::numeric, 0),
      now()
    )
    ON CONFLICT (company_id, product_id, size, color) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          purchase_price = excluded.purchase_price,
          selling_price = excluded.selling_price,
          updated_at = now()
    RETURNING id INTO v_product_size_id;

    INSERT INTO public.stock_in_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, unit_price, purchase_price, selling_price, total_amount,
      supplier, date, note, product_size_id
    ) VALUES (
      v_company_id,
      (v_entry->>'product_id')::uuid,
      v_entry->>'product_name',
      v_entry->>'category',
      v_entry->>'size',
      v_color,
      v_quantity,
      v_purchase_price,
      v_purchase_price,
      COALESCE((v_entry->>'selling_price')::numeric, 0),
      v_purchase_price * v_quantity,
      v_entry->>'supplier',
      COALESCE((v_entry->>'date')::date, current_date),
      v_entry->>'note',
      v_product_size_id
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stock_in(jsonb) TO authenticated;

-- ─── stock_out: derive ledger color from the product_sizes row itself ──

CREATE OR REPLACE FUNCTION public.stock_out(
  p_entries jsonb,
  p_entry_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_entry jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_sell_price numeric;
  v_color text;
BEGIN
  IF p_entry_type NOT IN ('sale', 'brak', 'manual') THEN
    RAISE EXCEPTION 'Invalid entry_type: %', p_entry_type;
  END IF;

  IF p_entry_type = 'manual' AND NOT public.has_permission('chiqim') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_entry_type = 'brak' AND NOT public.has_permission('brak') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_entry_type = 'sale' AND NOT public.has_permission('pos') THEN
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
    v_product_size_id := NULLIF(v_entry->>'product_size_id', '')::uuid;
    v_quantity := (v_entry->>'quantity')::integer;
    v_sell_price := COALESCE((v_entry->>'sell_price')::numeric, 0);

    IF v_product_size_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-out entry: %', v_entry;
    END IF;

    SELECT color INTO v_color
    FROM public.product_sizes
    WHERE id = v_product_size_id AND company_id = v_company_id;

    INSERT INTO public.stock_out_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, sell_price, total_amount, customer_id, customer_name,
      payment_method, date, note, entry_type, product_size_id
    ) VALUES (
      v_company_id,
      NULLIF(v_entry->>'product_id', '')::uuid,
      v_entry->>'product_name',
      v_entry->>'category',
      v_entry->>'size',
      COALESCE(v_color, ''),
      v_quantity,
      v_sell_price,
      v_sell_price * v_quantity,
      NULLIF(v_entry->>'customer_id', '')::uuid,
      v_entry->>'customer_name',
      v_entry->>'payment_method',
      COALESCE((v_entry->>'date')::date, current_date),
      v_entry->>'note',
      p_entry_type,
      v_product_size_id
    );

    UPDATE public.product_sizes
    SET stock = stock - v_quantity, updated_at = now()
    WHERE id = v_product_size_id
      AND company_id = v_company_id
      AND stock >= v_quantity;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient stock for product_size %', v_product_size_id
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stock_out(jsonb, text) TO authenticated;
