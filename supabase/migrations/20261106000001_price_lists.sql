-- Price lists ("Prays-list"): named price types such as Ulgurji (wholesale)
-- or Diler. Each list derives a price for every variant from a base
-- (retail selling price or purchase cost) plus a percent adjustment and
-- rounding, with optional manual per-variant overrides. A customer can be
-- attached to a list; sell_cart then charges that list's price for them.

CREATE TABLE IF NOT EXISTS public.price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  base text NOT NULL DEFAULT 'selling' CHECK (base IN ('selling', 'purchase')),
  adjust_percent numeric(7,2) NOT NULL DEFAULT 0 CHECK (adjust_percent > -100 AND adjust_percent <= 1000),
  rounding integer NOT NULL DEFAULT 0 CHECK (rounding IN (0, 100, 500, 1000)),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_lists_company_idx ON public.price_lists(company_id);

CREATE TABLE IF NOT EXISTS public.price_list_items (
  price_list_id uuid NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
  product_size_id uuid NOT NULL REFERENCES public.product_sizes(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  price numeric(14,2) NOT NULL CHECK (price >= 0),
  PRIMARY KEY (price_list_id, product_size_id)
);
CREATE INDEX IF NOT EXISTS price_list_items_company_idx ON public.price_list_items(company_id);

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS price_list_id uuid REFERENCES public.price_lists(id) ON DELETE SET NULL;

ALTER TABLE public.price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company isolation" ON public.price_lists;
CREATE POLICY "Company isolation" ON public.price_lists
  FOR SELECT USING (company_id = public.get_company_id());
DROP POLICY IF EXISTS "Company isolation" ON public.price_list_items;
CREATE POLICY "Company isolation" ON public.price_list_items
  FOR SELECT USING (company_id = public.get_company_id());

-- Reads only; every write goes through the SECURITY DEFINER RPCs below.
GRANT SELECT ON public.price_lists, public.price_list_items TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.price_lists, public.price_list_items FROM authenticated, anon;

-- ─── Price of one variant in one list (NULL if list/variant invalid) ─────
CREATE OR REPLACE FUNCTION public.price_list_price(p_price_list_id uuid, p_product_size_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
  v_pl RECORD;
  v_override numeric;
  v_base numeric;
  v_price numeric;
BEGIN
  SELECT * INTO v_pl FROM public.price_lists
  WHERE id = p_price_list_id AND company_id = v_company_id AND is_active;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT price INTO v_override FROM public.price_list_items
  WHERE price_list_id = p_price_list_id AND product_size_id = p_product_size_id;
  IF FOUND THEN
    RETURN v_override;
  END IF;

  SELECT CASE
           WHEN v_pl.base = 'purchase' THEN COALESCE(ps.purchase_price, 0)
           WHEN ps.selling_price > 0 THEN ps.selling_price
           ELSE p.price
         END
    INTO v_base
  FROM public.product_sizes ps
  JOIN public.products p ON p.id = ps.product_id
  WHERE ps.id = p_product_size_id AND ps.company_id = v_company_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_price := v_base * (1 + v_pl.adjust_percent / 100);
  IF v_pl.rounding > 0 THEN
    v_price := round(v_price / v_pl.rounding) * v_pl.rounding;
  END IF;
  RETURN round(GREATEST(v_price, 0), 2);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.price_list_price(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.price_list_price(uuid, uuid) TO authenticated;

-- ─── Create / update a list ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_price_list(
  p_id uuid, p_name text, p_base text, p_adjust_percent numeric, p_rounding integer, p_is_active boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
  v_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.price_lists (company_id, name, base, adjust_percent, rounding, is_active)
    VALUES (v_company_id, trim(p_name), p_base, COALESCE(p_adjust_percent, 0), COALESCE(p_rounding, 0), COALESCE(p_is_active, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.price_lists
    SET name = trim(p_name), base = p_base, adjust_percent = COALESCE(p_adjust_percent, 0),
        rounding = COALESCE(p_rounding, 0), is_active = COALESCE(p_is_active, true)
    WHERE id = p_id AND company_id = v_company_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Price list not found';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.save_price_list(uuid, text, text, numeric, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_price_list(uuid, text, text, numeric, integer, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_price_list(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  DELETE FROM public.price_lists WHERE id = p_id AND company_id = public.get_company_id();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.delete_price_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_price_list(uuid) TO authenticated;

-- ─── Manual price for one variant (NULL removes the override) ────────────
CREATE OR REPLACE FUNCTION public.set_price_list_item(p_price_list_id uuid, p_product_size_id uuid, p_price numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.price_lists WHERE id = p_price_list_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Price list not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_sizes WHERE id = p_product_size_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Invalid product_size_id';
  END IF;

  IF p_price IS NULL THEN
    DELETE FROM public.price_list_items
    WHERE price_list_id = p_price_list_id AND product_size_id = p_product_size_id;
  ELSE
    IF p_price < 0 THEN
      RAISE EXCEPTION 'Invalid price';
    END IF;
    INSERT INTO public.price_list_items (price_list_id, product_size_id, company_id, price)
    VALUES (p_price_list_id, p_product_size_id, v_company_id, p_price)
    ON CONFLICT (price_list_id, product_size_id) DO UPDATE SET price = EXCLUDED.price;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_price_list_item(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_price_list_item(uuid, uuid, numeric) TO authenticated;

-- ─── Attach / detach a customer ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_customer_price_list(p_customer_id uuid, p_price_list_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
BEGIN
  IF NOT (public.has_permission('mahsulotlar') OR public.has_permission('customers')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_price_list_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.price_lists WHERE id = p_price_list_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Price list not found';
  END IF;
  UPDATE public.customers SET price_list_id = p_price_list_id
  WHERE id = p_customer_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_customer_price_list(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_price_list(uuid, uuid) TO authenticated;

-- ─── sell_cart (body from 20261105000007 + price lists) ──────────────────
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

  IF p_customer_id IS NOT NULL THEN
    SELECT COALESCE(vip_discount_percent, 0), price_list_id INTO v_vip_discount_percent, v_price_list_id
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
