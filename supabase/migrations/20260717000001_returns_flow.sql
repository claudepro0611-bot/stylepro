-- ═══════════════════════════════════════════════════════════════════════
-- PHASE 3 DESIGN PLAN (audit finding H4: returns/refunds)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Current state read before writing any DDL:
--   - transactions: id, company_id, customer_id, customer_name, total_amount,
--     date, payment_method, invoice_id, status ('completed'|'pending'|
--     'cancelled'), shift_id, cashier_id, cashier_name, created_at.
--     'cancelled' exists but nothing in the app ever sets it (confirmed via
--     the Phase 1 audit).
--   - transaction_items: id, company_id, transaction_id, product_id,
--     product_name, quantity, price, purchase_price. NO size/variant
--     reference at all — this is the load-bearing gap for this whole
--     feature and is addressed below.
--   - sell_cart (Phase 1/2) already stamps stock_out_entries.product_size_id
--     for every sale line, but never wrote that back onto transaction_items.
--
-- Schema gap and the decision made about it (not explicitly in the Phase 3
-- brief's table list, but required for line-level returns to be possible
-- at all — flagging it the same way the Phase 2 SECURITY DEFINER deviation
-- was flagged):
--   transaction_items has no product_size_id, so there is no reliable way
--   to know which exact variant (size) a sold line came from. return_items
--   is specified with its own product_size_id column, but if that's taken
--   on faith from the client at return time, a buggy or malicious client
--   could restock an unrelated size. Fix: add product_size_id to
--   transaction_items too. sell_cart is updated to populate it for every
--   future sale. Existing rows are backfilled heuristically by pairing
--   against stock_out_entries (entry_type='sale', which already carries
--   product_size_id) on (company_id, product_id, quantity, price, date) —
--   but ONLY where that combination resolves to an equal, 1:1 count on
--   both sides, to avoid mispairing when a transaction has two lines with
--   identical product/qty/price/date (plausible for two different sizes of
--   a uniformly-priced item sold the same day). Anything left unmatched
--   stays NULL, and return_items.transaction_item_id validation below
--   refuses to process a return for a line whose product_size_id is NULL
--   — such historical sales simply cannot be returned at the line level
--   until/unless a human reconciles them, which is safer than guessing.
--
-- New tables:
--   returns (id, company_id, transaction_id FK, created_by FK users,
--            reason, created_at)
--   return_items (id, return_id FK, transaction_item_id FK,
--                 product_size_id FK, quantity, refund_amount)
--   Both get RLS with a company-isolation SELECT policy but NO
--   INSERT/UPDATE/DELETE grant to `authenticated` — consistent with the
--   Phase 2 architecture, every write goes through the return_items() RPC
--   (SECURITY DEFINER), never direct client writes.
--
-- Schema additions:
--   transaction_items.returned_quantity int default 0 (running total,
--   mirrors product_sizes.stock's "mutable counter" role)
--   transaction_items.product_size_id uuid references product_sizes(id)
--   stock_in_entries.entry_type text default 'purchase' check in
--   ('purchase','return') — this column didn't exist before (only
--   stock_out_entries had entry_type); a return is a compensating
--   stock-IN event and needs the same ledger distinction kirim/brak/sale
--   already have on the stock-out side.
--
-- RPC: public.return_items(p_transaction_id uuid, p_items jsonb, p_reason text)
--   RETURNS uuid (the new returns.id)
--   SECURITY DEFINER, SET search_path = public, pg_temp (matching the
--   20260716 hardening), gated by has_permission('pos') — no dedicated
--   'returns' key exists in lib/permissions.ts's PERMISSION_KEYS, and the
--   brief says fall back to 'pos' when that's the case.
--   p_items is [{transaction_item_id, quantity}] ONLY. product_size_id and
--   refund_amount are deliberately NOT accepted from the client — both are
--   derived server-side from the transaction_items row itself (its stored
--   product_size_id and price), the same "don't trust client-supplied
--   money or variant identity when an authoritative source already exists"
--   principle used throughout Phase 1/2.
--   One transaction, in order: validate the transaction belongs to
--   get_company_id() and is status='completed' -> insert the returns
--   header -> per item: look up the transaction_item (must belong to this
--   transaction/company, must have a non-null product_size_id), validate
--   quantity + returned_quantity <= sold quantity (RAISE EXCEPTION naming
--   the line otherwise), insert return_items, insert a compensating
--   stock_in_entries row (entry_type='return'), increment
--   product_sizes.stock, increment transaction_items.returned_quantity ->
--   after the loop, if every line on the transaction is now fully
--   returned, flip transactions.status to 'cancelled' -> return the new
--   returns.id.
--
-- Net revenue for reports:
--   A new view, public.transactions_net (security_invoker = true, same
--   pattern as employees_safe), exposes every transactions column plus
--   returned_amount (sum of return_items.refund_amount for that
--   transaction) and net_amount (total_amount - returned_amount). Every
--   revenue/sales aggregation site in the app switches from
--   .from('transactions') + total_amount to .from('transactions_net') +
--   net_amount, so a partial return is reflected without each page having
--   to separately fetch and join returns data itself. Fully-cancelled
--   transactions are additionally excluded by their existing
--   status='completed' filters, which every one of these pages already
--   applies — net_amount and the status filter are complementary, not
--   redundant: net_amount handles PARTIAL returns on still-'completed'
--   transactions, the status filter handles FULLY-returned ones.
-- END OF PLAN — DDL follows below.

-- ─── Schema additions ───────────────────────────────────────────────────

ALTER TABLE public.transaction_items
  ADD COLUMN IF NOT EXISTS returned_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS product_size_id uuid REFERENCES public.product_sizes(id);

ALTER TABLE public.stock_in_entries
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'purchase';

ALTER TABLE public.stock_in_entries
  DROP CONSTRAINT IF EXISTS stock_in_entries_entry_type_check;
ALTER TABLE public.stock_in_entries
  ADD CONSTRAINT stock_in_entries_entry_type_check
  CHECK (entry_type IN ('purchase', 'return'));

-- Heuristic backfill: pair transaction_items to stock_out_entries
-- (entry_type='sale') on (company_id, product_id, quantity, price, date),
-- only where that combination is a 1:1 match on both sides. Ambiguous or
-- unmatched rows are left NULL on purpose (see design note above).
WITH soe_groups AS (
  SELECT company_id, product_id, quantity, sell_price, date, product_size_id,
         count(*) OVER (PARTITION BY company_id, product_id, quantity, sell_price, date) AS grp_count
  FROM public.stock_out_entries
  WHERE entry_type = 'sale' AND product_size_id IS NOT NULL
)
UPDATE public.transaction_items ti
SET product_size_id = s.product_size_id
FROM public.transactions t, soe_groups s
WHERE ti.transaction_id = t.id
  AND ti.product_size_id IS NULL
  AND s.company_id = ti.company_id
  AND s.product_id = ti.product_id
  AND s.quantity = ti.quantity
  AND s.sell_price = ti.price
  AND s.date = t.date
  AND s.grp_count = 1
  AND (
    SELECT count(*) FROM public.transaction_items ti2
    JOIN public.transactions t2 ON t2.id = ti2.transaction_id
    WHERE ti2.company_id = ti.company_id AND ti2.product_id = ti.product_id
      AND ti2.quantity = ti.quantity AND ti2.price = ti.price
      AND t2.date = t.date
  ) = 1;

-- ─── returns / return_items ─────────────────────────────────────────────

CREATE TABLE public.returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX returns_company_id_idx ON public.returns(company_id);
CREATE INDEX returns_transaction_id_idx ON public.returns(transaction_id);

ALTER TABLE public.returns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation" ON public.returns
  FOR SELECT USING (company_id = public.get_company_id());

-- Supabase's schema-level default privileges grant new tables full CRUD to
-- `authenticated` automatically — explicitly revoke write access rather
-- than relying only on "RLS has no policy for it, so it's implicitly
-- denied," matching the explicit-revoke posture from the Phase 2 hardening.
-- Every write goes through return_items(), which runs SECURITY DEFINER.
GRANT SELECT ON public.returns TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.returns FROM authenticated;

CREATE TABLE public.return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.returns(id) ON DELETE CASCADE,
  transaction_item_id uuid NOT NULL REFERENCES public.transaction_items(id) ON DELETE CASCADE,
  product_size_id uuid REFERENCES public.product_sizes(id),
  quantity integer NOT NULL,
  refund_amount numeric(14, 2) NOT NULL DEFAULT 0
);

CREATE INDEX return_items_return_id_idx ON public.return_items(return_id);
CREATE INDEX return_items_transaction_item_id_idx ON public.return_items(transaction_item_id);

ALTER TABLE public.return_items ENABLE ROW LEVEL SECURITY;

-- return_items has no company_id of its own — isolate via its parent return.
CREATE POLICY "Company isolation via return" ON public.return_items
  FOR SELECT USING (
    return_id IN (SELECT id FROM public.returns WHERE company_id = public.get_company_id())
  );

GRANT SELECT ON public.return_items TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.return_items FROM authenticated;

-- ─── transactions_net: revenue net of returns ──────────────────────────

CREATE OR REPLACE VIEW public.transactions_net
WITH (security_invoker = true) AS
SELECT
  t.*,
  COALESCE(r.returned_amount, 0) AS returned_amount,
  t.total_amount - COALESCE(r.returned_amount, 0) AS net_amount
FROM public.transactions t
LEFT JOIN (
  SELECT ret.transaction_id, sum(ri.refund_amount) AS returned_amount
  FROM public.returns ret
  JOIN public.return_items ri ON ri.return_id = ret.id
  GROUP BY ret.transaction_id
) r ON r.transaction_id = t.id;

GRANT SELECT ON public.transactions_net TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.transactions_net FROM authenticated;

-- ─── sell_cart: populate product_size_id on every future sale line ─────

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
  v_item jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_unit_price numeric;
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
      company_id, transaction_id, product_id, product_name, quantity, price,
      purchase_price, product_size_id
    ) VALUES (
      v_company_id, v_transaction_id,
      NULLIF(v_item->>'product_id', '')::uuid,
      v_item->>'product_name',
      v_quantity,
      v_unit_price,
      NULLIF(v_item->>'purchase_price', '')::numeric,
      v_product_size_id
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

-- ─── return_items RPC ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.return_items(
  p_transaction_id uuid,
  p_items jsonb,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_txn_status text;
  v_return_id uuid;
  v_item jsonb;
  v_transaction_item_id uuid;
  v_quantity integer;
  v_ti RECORD;
  v_size text;
  v_category text;
  v_refund_amount numeric;
  v_fully_returned boolean;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items to return';
  END IF;

  SELECT status INTO v_txn_status
  FROM public.transactions
  WHERE id = p_transaction_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF v_txn_status != 'completed' THEN
    RAISE EXCEPTION 'Only a completed transaction can be returned';
  END IF;

  INSERT INTO public.returns (company_id, transaction_id, created_by, reason)
  VALUES (v_company_id, p_transaction_id, auth.uid(), trim(p_reason))
  RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_transaction_item_id := NULLIF(v_item->>'transaction_item_id', '')::uuid;
    v_quantity := (v_item->>'quantity')::integer;

    IF v_transaction_item_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid return line: %', v_item;
    END IF;

    SELECT id, product_id, product_name, quantity AS sold_quantity,
           returned_quantity, price, product_size_id
    INTO v_ti
    FROM public.transaction_items
    WHERE id = v_transaction_item_id
      AND transaction_id = p_transaction_id
      AND company_id = v_company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction item not found: %', v_transaction_item_id;
    END IF;

    IF v_ti.product_size_id IS NULL THEN
      RAISE EXCEPTION 'Item % has no recorded variant and cannot be returned', v_ti.product_name;
    END IF;

    IF (v_ti.returned_quantity + v_quantity) > v_ti.sold_quantity THEN
      RAISE EXCEPTION 'Return quantity for % exceeds sold quantity (sold %, already returned %, requested %)',
        v_ti.product_name, v_ti.sold_quantity, v_ti.returned_quantity, v_quantity
        USING ERRCODE = 'P0001';
    END IF;

    v_refund_amount := v_ti.price * v_quantity;

    SELECT ps.size, p.category INTO v_size, v_category
    FROM public.product_sizes ps
    JOIN public.products p ON p.id = ps.product_id
    WHERE ps.id = v_ti.product_size_id;

    INSERT INTO public.return_items (
      return_id, transaction_item_id, product_size_id, quantity, refund_amount
    ) VALUES (
      v_return_id, v_transaction_item_id, v_ti.product_size_id, v_quantity, v_refund_amount
    );

    INSERT INTO public.stock_in_entries (
      company_id, product_id, product_name, category, size,
      quantity, unit_price, purchase_price, total_amount, date, note,
      entry_type, product_size_id
    ) VALUES (
      v_company_id, v_ti.product_id, v_ti.product_name, v_category, v_size,
      v_quantity, v_ti.price, v_ti.price, v_ti.price * v_quantity, current_date,
      trim(p_reason), 'return', v_ti.product_size_id
    );

    UPDATE public.product_sizes
    SET stock = stock + v_quantity, updated_at = now()
    WHERE id = v_ti.product_size_id AND company_id = v_company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_sizes row not found for %', v_ti.product_size_id;
    END IF;

    UPDATE public.transaction_items
    SET returned_quantity = returned_quantity + v_quantity
    WHERE id = v_transaction_item_id;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.transaction_items
    WHERE transaction_id = p_transaction_id AND returned_quantity < quantity
  ) INTO v_fully_returned;

  IF v_fully_returned THEN
    UPDATE public.transactions SET status = 'cancelled' WHERE id = p_transaction_id;
  END IF;

  RETURN v_return_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.return_items(uuid, jsonb, text) TO authenticated;
-- ═══════════════════════════════════════════════════════════════════════
