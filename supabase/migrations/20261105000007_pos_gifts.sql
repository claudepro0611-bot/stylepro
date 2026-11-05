-- POS "Sovg'a" (gift): instead of discounting a cheque, the cashier marks
-- one or more cart lines as a free gift. Gift lines are sold at 0, stock is
-- still decremented, and the line's catalog value is recorded so reports
-- show the real cost of the gift.
--
--  1) companies.max_gift_percent  — gift value cap, % of the paid cheque
--                                   total (0 = gifts disabled).
--     companies.gift_staff_allowed — whether 'staff' role (cashiers) may
--                                   give gifts; owner/admin/manager always can.
--  2) transaction_items.is_gift, transactions.gift_amount.
--  3) sell_cart: lines accept `is_gift`; enforced server-side.
--  4) set_gift_settings RPC (owner only).

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS max_gift_percent numeric(5,2) NOT NULL DEFAULT 10
    CHECK (max_gift_percent >= 0 AND max_gift_percent <= 100),
  ADD COLUMN IF NOT EXISTS gift_staff_allowed boolean NOT NULL DEFAULT false;

ALTER TABLE public.transaction_items
  ADD COLUMN IF NOT EXISTS is_gift boolean NOT NULL DEFAULT false;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS gift_amount numeric(14,2) NOT NULL DEFAULT 0;

-- ─── sell_cart (body from 20260723000008 + gift lines) ───────────────────
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
  v_total_amount numeric := 0;
  v_gift_amount numeric := 0;
  v_vip_discount_percent numeric := 0;
  v_item jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_is_gift boolean;
  v_promo_discount numeric;
  v_effective_discount numeric;
  v_list_price numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_row RECORD;
  v_role text;
  v_max_gift_percent numeric;
  v_gift_staff_allowed boolean;
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

  IF p_customer_id IS NOT NULL THEN
    SELECT COALESCE(vip_discount_percent, 0) INTO v_vip_discount_percent
    FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid customer_id for this company';
    END IF;
  END IF;

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

    IF v_is_gift THEN
      v_effective_discount := 100;
      v_unit_price := 0;
      v_gift_amount := v_gift_amount + v_list_price * v_quantity;
    ELSE
      v_promo_discount := public.get_best_promotion_discount(v_product_size_id, current_date);
      v_effective_discount := GREATEST(v_promo_discount, v_vip_discount_percent, 0);
      v_unit_price := round(v_list_price * (1 - v_effective_discount / 100), 2);
    END IF;

    v_line_total := v_unit_price * v_quantity;
    v_total_amount := v_total_amount + v_line_total;

    INSERT INTO public.transaction_items (
      company_id, transaction_id, product_id, product_name, quantity, price,
      purchase_price, product_size_id, discount_percent, list_price, is_gift
    ) VALUES (
      v_company_id, v_transaction_id,
      v_row.product_id,
      v_row.product_name,
      v_quantity,
      v_unit_price,
      COALESCE(v_row.purchase_price, 0),
      v_product_size_id,
      v_effective_discount,
      v_list_price,
      v_is_gift
    );

    INSERT INTO public.stock_out_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, sell_price, total_amount, product_size_id,
      customer_id, customer_name, payment_method, date, note, entry_type
    ) VALUES (
      v_company_id,
      v_row.product_id,
      v_row.product_name,
      v_row.category,
      v_row.size,
      v_row.color,
      v_quantity,
      v_unit_price,
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
  END LOOP;

  -- Gift rules: who may give, and how much relative to the paid total.
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

  UPDATE public.transactions
  SET total_amount = v_total_amount,
      gift_amount = v_gift_amount
  WHERE id = v_transaction_id AND company_id = v_company_id;

  IF p_customer_id IS NOT NULL THEN
    PERFORM public.earn_loyalty(p_customer_id, v_transaction_id, v_total_amount);
  END IF;

  RETURN v_transaction_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) TO authenticated;

-- ─── set_gift_settings (owner only) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_gift_settings(
  p_max_gift_percent numeric,
  p_gift_staff_allowed boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'owner') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_max_gift_percent IS NULL OR p_max_gift_percent < 0 OR p_max_gift_percent > 100 THEN
    RAISE EXCEPTION 'Invalid max_gift_percent';
  END IF;

  UPDATE public.companies
  SET max_gift_percent = p_max_gift_percent,
      gift_staff_allowed = COALESCE(p_gift_staff_allowed, false)
  WHERE id = v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_gift_settings(numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_gift_settings(numeric, boolean) TO authenticated;
