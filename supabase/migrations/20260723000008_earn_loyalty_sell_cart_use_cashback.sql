-- ═══════════════════════════════════════════════════════════════════════
-- Two additions, both purely additive to the existing loyalty model from
-- 20260723000007_loyalty_nasiya.sql — neither touches any table schema or
-- any other RPC.
--
-- ─── 1) Wire earn_loyalty into sell_cart ───────────────────────────────
-- sell_cart's full CURRENT body (from
-- 20260723000005_sell_cart_promotion_vip_integration.sql) is reproduced
-- verbatim below via CREATE OR REPLACE, with exactly one addition: right
-- after the final `UPDATE public.transactions SET total_amount = ...`
-- and before `RETURN v_transaction_id;`, this block is inserted:
--
--   IF p_customer_id IS NOT NULL THEN
--     PERFORM public.earn_loyalty(p_customer_id, v_transaction_id, v_total_amount);
--   END IF;
--
-- Verified before writing this:
--   - earn_loyalty's signature is
--     (p_customer_id uuid, p_transaction_id uuid, p_purchase_amount numeric)
--     — matches (p_customer_id, v_transaction_id, v_total_amount)
--     positionally.
--   - earn_loyalty cannot spuriously RAISE EXCEPTION in this call site:
--     by the time this new block runs, sell_cart has already validated
--     p_customer_id belongs to its own v_company_id (the VIP-discount
--     lookup earlier in the same function), and v_transaction_id was just
--     INSERTed with that same v_company_id earlier in this same,
--     still-open transaction — so earn_loyalty's own internal
--     company_id-scoped existence checks on both ids (which independently
--     re-derive v_company_id via get_company_id() for the same
--     auth.uid() session) trivially pass. earn_loyalty's only other exit
--     paths are graceful no-ops (RETURN, not RAISE) when
--     p_purchase_amount <= 0 or loyalty is unconfigured/inactive for the
--     company — never a hard failure that would abort the sale.
--   - v_total_amount is the server-computed, post-promotion/VIP-discount
--     *charged* total (accumulated from each line's already-discounted
--     v_unit_price * v_quantity), not a pre-discount subtotal — so
--     earn_loyalty earns on what the customer actually paid.
--   - has_permission('pos') is an existing whitelisted key, matching
--     sell_cart's own gate.
--
-- Everything else in sell_cart (SECURITY DEFINER, search_path, has_permission
-- gate, NULL company_id guard, product_size_id tenant validation + row
-- lock, atomic conditional stock decrement, VIP/promotion discount
-- resolution, transaction_items/stock_out_entries inserts) is reproduced
-- unchanged from 20260723000005 — the old migration file itself is left
-- untouched; this is a new CREATE OR REPLACE in a new migration.
--
-- ─── 2) use_cashback RPC ────────────────────────────────────────────────
-- Thin, permission-gated wrapper around redeem_loyalty() intended as the
-- POS-facing entry point for spending loyalty balls at checkout. Per
-- explicit spec:
--   - has_permission('pos') + NULL company_id guard, same pattern as
--     every other RPC in this schema.
--   - p_customer_id tenant-validated the same way as every other
--     customer-scoped RPC here (give_nasiya, repay_nasiya, earn_loyalty,
--     redeem_loyalty all use this identical EXISTS check).
--   - Balance is checked twice, intentionally (defense-in-depth, not a
--     bug): once here via get_customer_loyalty_balance() with a simple
--     'Insufficient loyalty balance' message as a fast-fail before any
--     lock is taken, and again inside redeem_loyalty() with its own
--     advisory-lock-protected, more detailed message
--     ('Insufficient loyalty balance: has %, requested %'). The advisory
--     lock inside redeem_loyalty is the actual authoritative guard against
--     a concurrent-redemption race — this function's own check can only
--     ever be a courtesy fast-fail ahead of it.
--   - Does NOT independently re-query loyalty_config.redeem_rate or
--     recompute p_balls * redeem_rate — it captures and returns
--     redeem_loyalty's own return value directly. redeem_loyalty already
--     computes and returns round(p_balls * v_redeem_rate, 2) from the
--     same loyalty_config row it just used to authorize the redemption,
--     so re-deriving that value here would be a redundant second read of
--     loyalty_config with no benefit, and would risk silently diverging
--     from the ledger's own recorded value if the two computations were
--     ever changed out of sync later. Returning redeem_loyalty's value
--     verbatim guarantees byte-identical agreement with what was actually
--     recorded.
--   - p_transaction_id, when non-NULL, is NOT independently re-validated
--     against the caller's company here — redeem_loyalty() already
--     performs that exact check internally
--     (`p_transaction_id IS NOT NULL AND NOT EXISTS (...)`), and the user's
--     spec only explicitly asked for the balance check to be duplicated,
--     not this one. Judgment call: skip the redundant duplicate check for
--     transaction_id and let redeem_loyalty remain the sole validator for
--     that field, since duplicating it here would add no additional
--     safety (redeem_loyalty is always called, unconditionally, right
--     after) and only adds a second identical query.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1) sell_cart — reproduced verbatim from 20260723000005, plus the
--    earn_loyalty call described above.
-- ─────────────────────────────────────────────────────────────────────────
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

  -- ═══ New in this migration ═══════════════════════════════════════════
  -- Award loyalty balls on the actual, server-computed charged total for
  -- this sale, for logged-in customers only (guest sales, p_customer_id
  -- NULL, earn nothing — matches earn_loyalty's own hard requirement that
  -- p_customer_id not be NULL). p_customer_id was already validated above
  -- to belong to v_company_id, and v_transaction_id was just created in
  -- this same company/transaction, so earn_loyalty's own internal tenant
  -- checks on both ids trivially pass here. earn_loyalty itself never
  -- raises for "loyalty not configured" — it's a graceful no-op in that
  -- case — so this can never block a sale from completing.
  IF p_customer_id IS NOT NULL THEN
    PERFORM public.earn_loyalty(p_customer_id, v_transaction_id, v_total_amount);
  END IF;
  -- ═══════════════════════════════════════════════════════════════════

  RETURN v_transaction_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) use_cashback — POS-facing entry point for spending loyalty balls.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.use_cashback(
  p_customer_id uuid,
  p_balls numeric,
  p_transaction_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_balance numeric;
  v_result numeric;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  -- Fast-fail with a simple message before redeem_loyalty's own advisory
  -- lock is even taken. redeem_loyalty independently re-checks the
  -- balance below (with its own lock and its own more detailed error
  -- message) — that is intentional defense-in-depth, not redundant dead
  -- code: this check alone cannot prevent a concurrent-redemption race
  -- (no lock held here), only redeem_loyalty's advisory lock can.
  v_balance := public.get_customer_loyalty_balance(p_customer_id);

  IF p_balls > v_balance THEN
    RAISE EXCEPTION 'Insufficient loyalty balance';
  END IF;

  -- redeem_loyalty performs its own advisory-locked authoritative balance
  -- check, records the ledger row, and returns the so'm discount value
  -- (p_balls * redeem_rate, already rounded) computed from the same
  -- loyalty_config row it used to authorize the redemption. Returned
  -- here verbatim rather than recomputed, so this function's return value
  -- is always byte-identical to what was actually recorded in the ledger.
  -- p_transaction_id, when non-NULL, is not independently re-validated
  -- here — redeem_loyalty already validates it belongs to this company
  -- internally, and is the sole validator for that field by design (see
  -- migration header note above).
  v_result := public.redeem_loyalty(p_customer_id, p_transaction_id, p_balls);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.use_cashback(uuid, numeric, uuid) TO authenticated;
-- ═══════════════════════════════════════════════════════════════════════
