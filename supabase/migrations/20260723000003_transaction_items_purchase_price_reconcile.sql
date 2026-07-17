-- ═══════════════════════════════════════════════════════════════════════
-- Reconcile migration: brings the LIVE database up to date with the intent
-- of 20260723000002_sell_cart_price_integrity.sql.
--
-- Context: an earlier version of 20260723000002 ("v1") was already applied
-- to the live DB by hand via the Supabase SQL Editor, and its
-- discount-validation pricing math (list_price derivation, max_discount_percent
-- enforcement, unit_price/line_total/total_amount computation) was manually
-- verified there (260000 subtotal @ 10% discount -> 234000 total). That math
-- is NOT changed by this migration.
--
-- What v1 was missing, discovered during code review AFTER v1 was applied:
--   1. transaction_items.purchase_price was never added by v1 (v1 only
--      added discount_percent/list_price), even though sell_cart's INSERT
--      into transaction_items has referenced a purchase_price value going
--      all the way back to the original 20260714000004_stock_rpcs.sql, and
--      app/(dashboard)/reports/page.tsx:129 reads it back out. No migration
--      in this repo's history ever actually created this column (only
--      product_sizes.purchase_price and stock_in_entries.purchase_price
--      exist). Net effect: right now, on live, every real sell_cart() call
--      fails at the transaction_items INSERT with
--      "column \"purchase_price\" of relation \"transaction_items\" does
--      not exist" — this migration is the fix.
--   2. Because product_sizes.purchase_price is nullable and the new
--      transaction_items.purchase_price column below is NOT NULL, the
--      INSERT must COALESCE(v_row.purchase_price, 0) rather than insert the
--      raw (possibly NULL) value — otherwise a variant with no recorded
--      purchase_price would violate the NOT NULL constraint on every sale.
--
-- This migration does NOT re-declare transaction_items.discount_percent or
-- transaction_items.list_price — those already exist live from v1 with the
-- same definition this migration would otherwise add, so doing so again
-- here would be redundant. Only the genuinely missing column is added.
--
-- The CREATE OR REPLACE FUNCTION below is inherently idempotent/safe to
-- rerun and is included in full (rather than as a patch) for clarity and to
-- guarantee the live function matches this repo's source of truth exactly.
-- It is byte-for-byte identical to v1's pricing/discount-validation logic
-- except for the single COALESCE fix described above (search for
-- "COALESCE(v_row.purchase_price, 0)" below) — no other behavior changes.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── transaction_items: add the missing purchase_price column ──────────
ALTER TABLE public.transaction_items
  ADD COLUMN IF NOT EXISTS purchase_price numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.transaction_items.purchase_price IS
  'Cost basis of this line at time of sale, copied from product_sizes.purchase_price (COALESCEd to 0 when unset) by sell_cart(). Ledger/reporting column, read by app/(dashboard)/reports/page.tsx.';

-- ─── sell_cart: same as v1, plus COALESCE(v_row.purchase_price, 0) ──────
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
