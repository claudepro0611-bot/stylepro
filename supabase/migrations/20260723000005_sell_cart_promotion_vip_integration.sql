-- ═══════════════════════════════════════════════════════════════════════
-- Integrates the promotions/VIP discount model (20260723000004) into
-- sell_cart, replacing the previous client-supplied-discount +
-- companies.max_discount_percent-cap model from
-- 20260723000002_sell_cart_price_integrity.sql /
-- 20260723000003_transaction_items_purchase_price_reconcile.sql.
--
-- ─── What changes ────────────────────────────────────────────────────────
--   1. p_items lines no longer carry a trusted discount_percent. The
--      function simply never reads v_item->>'discount_percent' anymore —
--      if a cashier's client still sends that key (e.g. before the
--      frontend is updated), it is silently ignored, never applied. Each
--      line is now only { product_size_id, quantity }.
--   2. p_payment never carried a discount_percent field in any prior
--      version of this function (verified by reading both
--      20260723000002 and 20260723000003 in full) — nothing to remove
--      there; noted for completeness against the request.
--   3. For every line, the discount is now computed entirely server-side:
--        v_promo_discount   := get_best_promotion_discount(product_size_id, current_date)
--        v_vip_discount     := customers.vip_discount_percent for p_customer_id
--                               (company-scoped, COALESCEd to 0; 0 for a
--                               guest sale with no p_customer_id)
--        effective_discount := GREATEST(v_promo_discount, v_vip_discount, 0)
--      i.e. highest-wins, never additive/stacked, per the explicit
--      stacking rule. Neither applying -> GREATEST(0, 0, 0) = 0.
--   4. unit_price = round(list_price * (1 - effective_discount / 100), 2),
--      same rounding convention as before. discount_percent (the applied,
--      effective value), list_price (catalog) and purchase_price
--      (COALESCEd to 0) are persisted on transaction_items exactly as
--      before — those columns already exist
--      (20260723000002/20260723000003).
--   5. companies.max_discount_percent is no longer read or enforced by
--      this function — the promotion/VIP model replaces it as the source
--      of truth for what discount a line may carry. The column itself
--      (companies.max_discount_percent, 20260723000001) is left in place
--      (dropping it is a separate, out-of-scope decision — nothing else
--      in this migration set reads it after this change, but that is not
--      verified/actioned here).
--   6. New trust boundary, added because it is now required to safely do
--      #3: p_customer_id, when non-null, is validated to belong to the
--      caller's own company (SELECT ... WHERE id = p_customer_id AND
--      company_id = v_company_id) before its vip_discount_percent is
--      read, and the whole sale is rejected (RAISE EXCEPTION) if it
--      doesn't match — same hard-reject-on-tenant-mismatch philosophy
--      already applied to product_size_id in this function. Previously
--      p_customer_id was never read back out of customers at all (only
--      written through, untouched, into transactions.customer_id /
--      stock_out_entries.customer_id), so this is a genuinely new
--      cross-tenant-read risk this migration introduces the guard for,
--      not scope creep — reading vip_discount_percent for a client-
--      supplied customer_id without a company_id scope would otherwise
--      leak another tenant's VIP discount into this sale's pricing.
--
-- ─── What is preserved unchanged ────────────────────────────────────────
--   - SECURITY DEFINER, SET search_path = public, pg_temp.
--   - has_permission('pos') check.
--   - NULL company_id guard immediately after get_company_id().
--   - product_size_id tenant validation + FOR UPDATE OF ps row lock
--     (guards against a concurrent stock_in() changing selling_price
--     between the read here and the stock decrement below).
--   - Atomic conditional stock decrement
--     (UPDATE ... WHERE stock >= v_quantity, relying on the
--     stock_non_negative CHECK) and its exact
--     "Insufficient stock for product_size %" error text, which
--     pos/page.tsx's error handler regex-matches on.
--   - Every field derived from the validated product_sizes/products row
--     (product_id, product_name, category, size, color, purchase_price,
--     catalog price) — never taken from client-supplied text.
--   - transactions.total_amount is still computed from server-derived
--     line totals only, written once after the loop via a single
--     company_id-scoped UPDATE.
--
-- The promotion/VIP reads (get_best_promotion_discount, the customers
-- lookup) are ordinary reads of price *inputs*, not a read-then-write of
-- a value this function itself mutates concurrently (unlike stock), so no
-- additional row locking is needed for them — the only value that needs
-- atomicity against concurrent writers is stock, which keeps its existing
-- conditional UPDATE guard.
-- ═══════════════════════════════════════════════════════════════════════

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
  v_vip_discount_percent numeric := 0;
  v_item jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_promo_discount numeric;
  v_effective_discount numeric;
  v_list_price numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_row RECORD;
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

  -- Resolve the customer's VIP discount once for the whole cart (same
  -- customer for every line). Company-scoped: a p_customer_id belonging
  -- to another tenant is hard-rejected, never silently treated as "no
  -- VIP discount" — see migration header note #6.
  IF p_customer_id IS NOT NULL THEN
    SELECT COALESCE(vip_discount_percent, 0) INTO v_vip_discount_percent
    FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid customer_id for this company';
    END IF;
  END IF;

  -- Inserted with a placeholder total_amount; corrected by a single
  -- company_id-scoped UPDATE once every line's server-derived total is
  -- known. The whole function body is one implicit transaction, so any
  -- RAISE EXCEPTION below rolls this insert back too — no partially-priced
  -- transaction row is ever left behind.
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

    -- discount_percent is intentionally never read from v_item here — any
    -- client-supplied discount is ignored, not just capped. Each line is
    -- now only { product_size_id, quantity }.
    IF v_product_size_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid cart line: %', v_item;
    END IF;

    -- Validate the product_size_id genuinely belongs to the caller's own
    -- company BEFORE trusting anything derived from it, and lock the row
    -- (FOR UPDATE) so a concurrent stock_in() cannot change selling_price
    -- underneath this sale between the read here and the stock decrement
    -- below. Every descriptive/priced field the ledger rows need
    -- (product_id, product_name, category, size, color, purchase_price,
    -- catalog price) comes from this validated row/join, never from the
    -- client.
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

    -- Authoritative current selling price of this variant: product_sizes
    -- .selling_price, falling back to products.price when unset/zero —
    -- matches the client's own display logic (pos/page.tsx), just enforced
    -- server-side instead of trusted from the client.
    v_list_price := CASE WHEN v_row.selling_price > 0 THEN v_row.selling_price ELSE v_row.product_price END;

    -- Server-derived discount: best active promotion for this exact
    -- variant vs. this customer's VIP discount, highest wins, never
    -- stacked. get_best_promotion_discount() already validates
    -- v_product_size_id against this same caller's company_id internally
    -- and returns 0 (never NULL) when nothing matches.
    v_promo_discount := public.get_best_promotion_discount(v_product_size_id, current_date);
    v_effective_discount := GREATEST(v_promo_discount, v_vip_discount_percent, 0);

    v_unit_price := round(v_list_price * (1 - v_effective_discount / 100), 2);
    v_line_total := v_unit_price * v_quantity;
    v_total_amount := v_total_amount + v_line_total;

    INSERT INTO public.transaction_items (
      company_id, transaction_id, product_id, product_name, quantity, price,
      purchase_price, product_size_id, discount_percent, list_price
    ) VALUES (
      v_company_id, v_transaction_id,
      v_row.product_id,
      v_row.product_name,
      v_quantity,
      v_unit_price,
      COALESCE(v_row.purchase_price, 0),
      v_product_size_id,
      v_effective_discount,
      v_list_price
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

  UPDATE public.transactions
  SET total_amount = v_total_amount
  WHERE id = v_transaction_id AND company_id = v_company_id;

  RETURN v_transaction_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) TO authenticated;
-- ═══════════════════════════════════════════════════════════════════════
