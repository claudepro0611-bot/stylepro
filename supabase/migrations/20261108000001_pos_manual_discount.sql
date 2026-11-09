-- POS manual cheque-level discount (fixed amount in so'm).
--
-- The cashier types a discount amount for the whole cheque. The frontend
-- already sends it as p_payment->>'manual_discount'; sell_cart's signature
-- is unchanged.
--
--  1) transactions.manual_discount (numeric(14,2), NOT NULL DEFAULT 0,
--     CHECK >= 0). It stores the discount that was actually applied, so
--     total_amount + manual_discount = the paid total before the discount.
--  2) sell_cart is restructured into two passes:
--       pass 1: lock + validate every line and compute its server-side price
--               (price list / promo / VIP / gift, same rules as
--               20261106000001). Nothing is inserted yet.
--       checks: gift rules (against the PRE-discount paid total, same as
--               before), then discount <= paid total.
--       pass 2: insert the transaction, then transaction_items and
--               stock_out_entries with unit prices ALREADY lowered by the
--               discount, then decrement stock.
--     So no rows need to be updated afterwards, and we never have to find
--     "this call's" stock_out_entries rows (that table has no
--     transaction_id).
--
-- How the discount is spread: each non-gift line's unit price is scaled by
-- (paid - D) / paid and rounded to 2 decimals. One "absorbing" line (the
-- non-gift, non-zero-priced line with the smallest quantity) gets whatever
-- is left over, so the rounding error lands there. If that line's quantity
-- is 1 the total matches exactly. Otherwise a tiny rounding remainder
-- (< 0.005 * quantity of that line) can stay, and manual_discount then
-- records the discount that was actually applied (paid - sum of lines), not
-- the raw number the client sent. In every case
--   transactions.total_amount = SUM(transaction_items.price * quantity)
-- which keeps returns (refund = price * qty), transactions_net.net_amount,
-- customer purchase stats and profit reports consistent with what was
-- charged.
--
-- transaction_items.list_price and discount_percent keep their meaning
-- (catalog/price-list unit price and promo/VIP percent). `price` is now the
-- final charged unit price including the manual discount share, so
-- list_price - price includes the manual discount (reports/moliya reads it
-- that way, as the total discount given).
--
-- No permission limit on the discount amount, by product decision: anyone
-- with 'pos' may give it. The only limit is discount <= paid total.

-- ─── 1) Column ───────────────────────────────────────────────────────────
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS manual_discount numeric(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_manual_discount_nonneg'
      AND conrelid = 'public.transactions'::regclass
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_manual_discount_nonneg CHECK (manual_discount >= 0);
  END IF;
END
$$;

-- ─── 2) sell_cart (body from 20261106000001 + manual discount) ───────────
CREATE OR REPLACE FUNCTION public.sell_cart(
  p_items jsonb,
  p_customer_id uuid,
  p_payment jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_transaction_id uuid;
  v_total_amount numeric := 0;      -- paid total BEFORE manual discount
  v_final_total numeric := 0;       -- charged total AFTER manual discount
  v_gift_amount numeric := 0;
  v_vip_discount_percent numeric := 0;
  v_manual_discount numeric := 0;
  v_item jsonb;
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_idx integer := 0;
  v_absorb_idx integer := NULL;
  v_absorb_qty integer := NULL;
  v_absorb_price numeric := NULL;
  v_others_total numeric := 0;
  v_product_size_id uuid;
  v_quantity integer;
  v_is_gift boolean;
  v_promo_discount numeric;
  v_effective_discount numeric;
  v_list_price numeric;
  v_unit_price numeric;
  v_final_price numeric;
  v_line_total numeric;
  v_row RECORD;
  v_role text;
  v_max_gift_percent numeric;
  v_gift_staff_allowed boolean;
  v_price_list_id uuid;
  v_pl_price numeric;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;

  v_manual_discount := COALESCE(NULLIF(p_payment->>'manual_discount', '')::numeric, 0);
  IF v_manual_discount < 0 OR v_manual_discount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'invalid_discount';
  END IF;
  v_manual_discount := round(v_manual_discount, 2);

  IF p_customer_id IS NOT NULL THEN
    SELECT COALESCE(vip_discount_percent, 0), price_list_id INTO v_vip_discount_percent, v_price_list_id
    FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid customer_id for this company';
    END IF;
  END IF;

  -- ── Pass 1: lock, validate and price every line (no writes) ──────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_size_id := NULLIF(v_item->>'product_size_id', '')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_is_gift := COALESCE((v_item->>'is_gift')::boolean, false);

    IF v_product_size_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid cart line: %', v_item;
    END IF;

    SELECT
      ps.id, ps.product_id, ps.size, ps.color, ps.selling_price,
      ps.purchase_price, p.price AS product_price, p.category, p.name AS product_name
    INTO v_row
    FROM public.product_sizes ps
    JOIN public.products p ON p.id = ps.product_id AND p.company_id = v_company_id
    WHERE ps.id = v_product_size_id AND ps.company_id = v_company_id
    FOR UPDATE OF ps;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid product_size_id % for this company', v_product_size_id;
    END IF;

    v_list_price := CASE WHEN v_row.selling_price > 0 THEN v_row.selling_price ELSE v_row.product_price END;

    -- Customer's price list (e.g. wholesale) replaces the retail price and
    -- is final: promotions / VIP discounts do not stack on top of it.
    v_pl_price := NULL;
    IF v_price_list_id IS NOT NULL THEN
      v_pl_price := public.price_list_price(v_price_list_id, v_product_size_id);
      IF v_pl_price IS NOT NULL THEN
        v_list_price := v_pl_price;
      END IF;
    END IF;

    IF v_is_gift THEN
      v_effective_discount := 100;
      v_unit_price := 0;
      v_gift_amount := v_gift_amount + v_list_price * v_quantity;
    ELSIF v_pl_price IS NOT NULL THEN
      v_effective_discount := 0;
      v_unit_price := round(v_list_price, 2);
    ELSE
      v_promo_discount := public.get_best_promotion_discount(v_product_size_id, current_date);
      v_effective_discount := GREATEST(v_promo_discount, v_vip_discount_percent, 0);
      v_unit_price := round(v_list_price * (1 - v_effective_discount / 100), 2);
    END IF;

    v_total_amount := v_total_amount + v_unit_price * v_quantity;

    -- Absorbing line for the discount rounding remainder: the non-gift,
    -- non-zero-priced line with the smallest quantity (ties -> later line).
    IF NOT v_is_gift AND v_unit_price > 0
       AND (v_absorb_qty IS NULL OR v_quantity <= v_absorb_qty) THEN
      v_absorb_idx := v_idx;
      v_absorb_qty := v_quantity;
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_size_id', v_product_size_id,
      'product_id', v_row.product_id,
      'product_name', v_row.product_name,
      'category', v_row.category,
      'size', v_row.size,
      'color', v_row.color,
      'purchase_price', COALESCE(v_row.purchase_price, 0),
      'quantity', v_quantity,
      'is_gift', v_is_gift,
      'list_price', v_list_price,
      'effective_discount', v_effective_discount,
      'unit_price', v_unit_price
    ));
    v_idx := v_idx + 1;
  END LOOP;

  -- Gift rules: who may give, and how much relative to the paid total.
  -- Deliberately measured against the PRE-discount paid total.
  IF v_gift_amount > 0 THEN
    SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
    SELECT max_gift_percent, gift_staff_allowed
      INTO v_max_gift_percent, v_gift_staff_allowed
    FROM public.companies WHERE id = v_company_id;

    IF v_role IS NULL OR (v_role = 'staff' AND NOT COALESCE(v_gift_staff_allowed, false)) THEN
      RAISE EXCEPTION 'gift_forbidden';
    END IF;

    IF v_total_amount <= 0 THEN
      RAISE EXCEPTION 'gift_requires_paid_item';
    END IF;

    IF v_gift_amount > round(v_total_amount * COALESCE(v_max_gift_percent, 0) / 100, 2) THEN
      RAISE EXCEPTION 'gift_limit_exceeded: max % %%', COALESCE(v_max_gift_percent, 0);
    END IF;
  END IF;

  -- Manual discount: no role limit, only "not more than the paid total".
  IF v_manual_discount > v_total_amount THEN
    RAISE EXCEPTION 'discount_exceeds_total';
  END IF;

  -- Discounted price for the absorbing line = whatever remains of the
  -- target total after every other line has been scaled + rounded.
  IF v_manual_discount > 0 THEN
    v_idx := 0;
    FOR v_line IN SELECT value FROM jsonb_array_elements(v_lines)
    LOOP
      IF NOT (v_line->>'is_gift')::boolean AND v_idx IS DISTINCT FROM v_absorb_idx THEN
        v_others_total := v_others_total
          + round((v_line->>'unit_price')::numeric * (v_total_amount - v_manual_discount) / v_total_amount, 2)
            * (v_line->>'quantity')::integer;
      END IF;
      v_idx := v_idx + 1;
    END LOOP;

    v_line := v_lines->v_absorb_idx;
    v_absorb_price := GREATEST(0, LEAST(
      (v_line->>'unit_price')::numeric,
      round(((v_total_amount - v_manual_discount) - v_others_total) / v_absorb_qty, 2)
    ));
  END IF;

  -- ── Pass 2: write ─────────────────────────────────────────────────────
  INSERT INTO public.transactions (
    company_id, customer_id, customer_name, total_amount, date,
    payment_method, status, shift_id, cashier_id, cashier_name
  ) VALUES (
    v_company_id,
    p_customer_id,
    p_payment->>'customer_name',
    0,
    COALESCE((p_payment->>'date')::date, current_date),
    p_payment->>'payment_method',
    'completed',
    NULLIF(p_payment->>'shift_id', '')::uuid,
    NULLIF(p_payment->>'cashier_id', '')::uuid,
    p_payment->>'cashier_name'
  )
  RETURNING id INTO v_transaction_id;

  v_idx := 0;
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_lines)
  LOOP
    v_product_size_id := (v_line->>'product_size_id')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_is_gift := (v_line->>'is_gift')::boolean;
    v_unit_price := (v_line->>'unit_price')::numeric;

    IF v_is_gift THEN
      v_final_price := 0;
    ELSIF v_manual_discount = 0 THEN
      v_final_price := v_unit_price;
    ELSIF v_idx = v_absorb_idx THEN
      v_final_price := v_absorb_price;
    ELSE
      v_final_price := round(v_unit_price * (v_total_amount - v_manual_discount) / v_total_amount, 2);
    END IF;

    v_line_total := v_final_price * v_quantity;
    v_final_total := v_final_total + v_line_total;

    INSERT INTO public.transaction_items (
      company_id, transaction_id, product_id, product_name, quantity, price,
      purchase_price, product_size_id, discount_percent, list_price, is_gift
    ) VALUES (
      v_company_id, v_transaction_id,
      (v_line->>'product_id')::uuid,
      v_line->>'product_name',
      v_quantity,
      v_final_price,
      (v_line->>'purchase_price')::numeric,
      v_product_size_id,
      (v_line->>'effective_discount')::numeric,
      (v_line->>'list_price')::numeric,
      v_is_gift
    );

    INSERT INTO public.stock_out_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, sell_price, total_amount, product_size_id,
      customer_id, customer_name, payment_method, date, note, entry_type
    ) VALUES (
      v_company_id,
      (v_line->>'product_id')::uuid,
      v_line->>'product_name',
      v_line->>'category',
      v_line->>'size',
      v_line->>'color',
      v_quantity,
      v_final_price,
      v_line_total,
      v_product_size_id,
      p_customer_id,
      p_payment->>'customer_name',
      p_payment->>'payment_method',
      COALESCE((p_payment->>'date')::date, current_date),
      CASE WHEN v_is_gift THEN 'Sovg''a' ELSE '' END,
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

    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.transactions
  SET total_amount = v_final_total,
      gift_amount = v_gift_amount,
      manual_discount = v_total_amount - v_final_total
  WHERE id = v_transaction_id AND company_id = v_company_id;

  IF p_customer_id IS NOT NULL THEN
    PERFORM public.earn_loyalty(p_customer_id, v_transaction_id, v_final_total);
  END IF;

  RETURN v_transaction_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) TO authenticated;
