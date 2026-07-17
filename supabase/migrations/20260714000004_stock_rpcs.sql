-- Atomic stock-mutation RPCs. Each runs SECURITY INVOKER (the caller's own
-- privileges/RLS apply — this phase does not touch RLS or permissions) and
-- does its ledger insert + stock mutation in a single statement/transaction,
-- so a failure partway through rolls back everything the call did.

-- ─── sell_cart: POS checkout ───────────────────────────────────────────────
-- p_items: jsonb array of
--   { product_size_id, product_id, product_name, category, size, color,
--     quantity, unit_price, purchase_price }
-- p_payment: jsonb object of
--   { customer_name, payment_method, total_amount, date?, shift_id?,
--     cashier_id?, cashier_name? }
CREATE OR REPLACE FUNCTION public.sell_cart(
  p_items jsonb,
  p_customer_id uuid,
  p_payment jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_transaction_id uuid;
  v_item jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_unit_price numeric;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;

  INSERT INTO public.transactions (
    company_id, customer_id, customer_name, total_amount, date,
    payment_method, status, shift_id, cashier_id, cashier_name
  ) VALUES (
    v_company_id,
    p_customer_id,
    p_payment->>'customer_name',
    COALESCE((p_payment->>'total_amount')::numeric, 0),
    COALESCE((p_payment->>'date')::date, current_date),
    p_payment->>'payment_method',
    'completed',
    NULLIF(p_payment->>'shift_id', '')::uuid,
    NULLIF(p_payment->>'cashier_id', '')::uuid,
    p_payment->>'cashier_name'
  )
  RETURNING id INTO v_transaction_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_size_id := NULLIF(v_item->>'product_size_id', '')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_unit_price := COALESCE((v_item->>'unit_price')::numeric, 0);

    IF v_product_size_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid cart line: %', v_item;
    END IF;

    INSERT INTO public.transaction_items (
      company_id, transaction_id, product_id, product_name, quantity, price, purchase_price
    ) VALUES (
      v_company_id, v_transaction_id,
      NULLIF(v_item->>'product_id', '')::uuid,
      v_item->>'product_name',
      v_quantity,
      v_unit_price,
      NULLIF(v_item->>'purchase_price', '')::numeric
    );

    INSERT INTO public.stock_out_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, sell_price, total_amount, product_size_id,
      customer_id, customer_name, payment_method, date, note, entry_type
    ) VALUES (
      v_company_id,
      NULLIF(v_item->>'product_id', '')::uuid,
      v_item->>'product_name',
      v_item->>'category',
      v_item->>'size',
      v_item->>'color',
      v_quantity,
      v_unit_price,
      v_unit_price * v_quantity,
      v_product_size_id,
      p_customer_id,
      p_payment->>'customer_name',
      p_payment->>'payment_method',
      COALESCE((p_payment->>'date')::date, current_date),
      '',
      'sale'
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

  RETURN v_transaction_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) TO authenticated;

-- ─── stock_in: kirim ────────────────────────────────────────────────────────
-- p_entries: jsonb array of
--   { product_id, product_name, category, size, color, quantity,
--     purchase_price, selling_price, sku?, barcode?, warehouse_id?, supplier?,
--     date?, note? }
-- Creates the product_sizes row if this is the first time the size is
-- stocked, or atomically increments it if it already exists — either way in
-- one INSERT ... ON CONFLICT statement, with no client-side read of `stock`.
CREATE OR REPLACE FUNCTION public.stock_in(p_entries jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_entry jsonb;
  v_quantity integer;
  v_purchase_price numeric;
  v_product_size_id uuid;
BEGIN
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

    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-in quantity: %', v_entry;
    END IF;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, stock, purchase_price, selling_price,
      sku, barcode, warehouse_id, updated_at
    ) VALUES (
      v_company_id,
      (v_entry->>'product_id')::uuid,
      v_entry->>'size',
      v_quantity,
      v_purchase_price,
      COALESCE((v_entry->>'selling_price')::numeric, 0),
      v_entry->>'sku',
      v_entry->>'barcode',
      NULLIF(v_entry->>'warehouse_id', '')::uuid,
      now()
    )
    ON CONFLICT (company_id, product_id, size) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          purchase_price = excluded.purchase_price,
          selling_price = excluded.selling_price,
          sku = excluded.sku,
          barcode = COALESCE(public.product_sizes.barcode, excluded.barcode),
          warehouse_id = excluded.warehouse_id,
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
      v_entry->>'color',
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

-- ─── stock_out: manual chiqim / brak ───────────────────────────────────────
-- p_entries: jsonb array of
--   { product_size_id, product_id, product_name, category, size, color,
--     quantity, sell_price, customer_id?, customer_name?, payment_method?,
--     date?, note? }
-- p_entry_type: 'sale' (chiqim) or 'brak' — matches the existing
-- stock_out_entries.entry_type CHECK constraint.
CREATE OR REPLACE FUNCTION public.stock_out(
  p_entries jsonb,
  p_entry_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_entry jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_sell_price numeric;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_entry_type NOT IN ('sale', 'brak') THEN
    RAISE EXCEPTION 'Invalid entry_type: %', p_entry_type;
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
      v_entry->>'color',
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
