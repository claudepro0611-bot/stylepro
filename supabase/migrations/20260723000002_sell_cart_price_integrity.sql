-- ═══════════════════════════════════════════════════════════════════════
-- CRITICAL audit fix: sell_cart accepted client-supplied unit_price and
-- p_payment.total_amount with no validation against the catalog. Any
-- authenticated 'pos'-permitted user could call the RPC directly (bypassing
-- the UI entirely) with a fabricated low/zero/negative price and record a
-- fraudulent sale while stock still correctly decremented.
--
-- ─── Investigation: which column is the authoritative selling price? ───
-- Read before writing any DDL:
--   - products.price: a per-product *default* price. Set at product
--     creation/update (create_product/update_product), not variant-aware.
--   - product_sizes.selling_price: added in 20260709000001_fix_schema_drift
--     (schema drift fix — the app already queried it before the column
--     existed), and is the column stock_in() actually writes on every
--     kirim (ON CONFLICT ... DO UPDATE SET selling_price = excluded...,
--     20260714000004_stock_rpcs.sql / 20260715000003_harden_stock_rpcs.sql).
--     It is the live, current, per-variant (size+color+warehouse row)
--     selling price — exactly "current selling price of this variant".
--   - stock_in_entries.selling_price / unit_price / purchase_price: ledger
--     rows, one per historical kirim event. This is a point-in-time
--     *record* of what selling_price/purchase_price were set to at that
--     moment, not a live/current value, and there can be many rows per
--     variant (cost/price history) — wrong source to price a sale against.
--   - stock_in_entries.purchase_price / product_sizes.purchase_price: cost
--     basis (what the shop paid), never a selling price.
--
--   Conclusion: product_sizes.selling_price is the authoritative "current
--   selling price of this variant". The client (app/(dashboard)/pos/page.tsx
--   line ~345) already treats it this way with a fallback:
--     price: sz.selling_price > 0 ? sz.selling_price : p.price
--   i.e. products.price is only a fallback for a variant that has never had
--   a selling_price set (0/NULL). sell_cart below reproduces that exact
--   fallback server-side so pricing behavior for legitimate carts is
--   unchanged — only the trust boundary moves server-side.
--
-- ─── Fix shape ───────────────────────────────────────────────────────────
--   1. sell_cart no longer reads p_items[].unit_price, p_items[].total_amount,
--      or p_payment.total_amount at all (not even as a fallback/default).
--   2. Each cart line's product_size_id is validated to belong to the
--      caller's own company (joined against product_sizes + products, both
--      scoped by company_id) before anything derived from it is trusted —
--      previously only the final stock-decrement UPDATE was company-scoped;
--      a mismatched product_size_id from another tenant would have silently
--      failed only at that last step (as "insufficient stock"), not been
--      rejected as invalid up front.
--   3. product_id/product_name/category/size/color/purchase_price for the
--      ledger rows are now all derived from that same validated
--      product_sizes/products row, not taken from client-supplied text, so
--      a spoofed product_name/category can no longer land in
--      transaction_items/stock_out_entries for a real, correctly-priced
--      stock decrement.
--   4. An optional per-line discount_percent is accepted, hard-validated
--      against companies.max_discount_percent (previous migration) and
--      against a plain [0, 100] range (rejects negative "discounts", i.e.
--      markups, too). Any line outside the cap aborts the WHOLE
--      transaction via RAISE EXCEPTION — no partial application, no
--      silent clamping.
--   5. Every line total and the transaction's total_amount are computed
--      from the derived unit_price and validated discount, never from
--      client input. total_amount is written once, after the loop, via a
--      single company_id-scoped UPDATE.
--   6. The applied discount_percent and the pre-discount catalog price
--      (list_price) are persisted per line on transaction_items for audit
--      (new columns, this migration).
--   7. Every existing guarantee is preserved: SECURITY DEFINER,
--      SET search_path = public, pg_temp, has_permission('pos'), the NULL
--      company_id guard, and the atomic conditional stock-decrement UPDATE
--      (... WHERE stock >= v_quantity, relying on the stock_non_negative
--      CHECK and raising the same "Insufficient stock for product_size %"
--      message the POS page's error handler already regex-matches on).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── transaction_items: audit columns for the applied discount ─────────
-- NOTE: purchase_price is added here too, unrelated to the discount audit
-- trail, because it turned out to be missing entirely from this table.
-- Every version of sell_cart back to 20260714000004_stock_rpcs.sql has
-- always INSERTed a purchase_price value into transaction_items, and
-- app/(dashboard)/reports/page.tsx:129 already SELECTs it back out — but no
-- migration ever added the column (only product_sizes.purchase_price and
-- stock_in_entries.purchase_price exist). That means every sell_cart call
-- has been one INSERT away from erroring with
-- "column \"purchase_price\" of relation \"transaction_items\" does not
-- exist" on any environment where this migration set was actually applied.
-- Fixing it here since this migration already alters this table and
-- sell_cart's INSERT depends on it.
ALTER TABLE public.transaction_items
  ADD COLUMN IF NOT EXISTS purchase_price numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 100),
  ADD COLUMN IF NOT EXISTS list_price numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.transaction_items.list_price IS
  'Server-derived catalog unit price (product_sizes.selling_price, falling back to products.price) at time of sale, before discount_percent was applied. Audit trail only — price is the actual per-unit amount charged.';
COMMENT ON COLUMN public.transaction_items.discount_percent IS
  'Per-line discount applied at sale time, validated server-side in sell_cart() against companies.max_discount_percent. price = round(list_price * (1 - discount_percent/100), 2).';

-- ─── sell_cart: rewritten with server-derived pricing ──────────────────
-- p_items: jsonb array of
--   { product_size_id, quantity, discount_percent? }
--   product_id/product_name/category/size/color/purchase_price/unit_price
--   are no longer read from here — see note above. discount_percent is
--   optional, defaults to 0, and is validated against the company's
--   max_discount_percent cap.
-- p_payment: jsonb object of
--   { customer_name, payment_method, date?, shift_id?, cashier_id?,
--     cashier_name? }
--   total_amount is no longer read from here — computed server-side.
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
  v_max_discount_percent numeric;
  v_transaction_id uuid;
  v_total_amount numeric := 0;
  v_item jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_discount_pct numeric;
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

  SELECT max_discount_percent INTO v_max_discount_percent
  FROM public.companies
  WHERE id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company configuration not found';
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
    v_discount_pct := COALESCE((v_item->>'discount_percent')::numeric, 0);

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

    -- Hard reject: discount_percent must be within [0, company cap].
    -- Negative values (markups above catalog price) and anything above the
    -- cap both abort the entire transaction — no silent clamping, no
    -- partial application of some lines but not others.
    IF v_discount_pct < 0 OR v_discount_pct > v_max_discount_percent THEN
      RAISE EXCEPTION 'Discount percent % is invalid for product_size % (must be between 0 and %)',
        v_discount_pct, v_product_size_id, v_max_discount_percent
        USING ERRCODE = 'P0001';
    END IF;

    v_unit_price := round(v_list_price * (1 - v_discount_pct / 100), 2);
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
      v_discount_pct,
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
