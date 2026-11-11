-- Production wave 4: wholesale sales (nakladnoy), sale returns, B2B
-- customers, price lists, customer payments, receivables / ageing.
--
-- Why: the plant can buy, produce, count and write off, but it cannot SELL:
-- there is no dispatch document, so finished goods leave the warehouse only
-- through write-offs, there is no customer ledger (who owes us what, since
-- when) and no COGS / margin per sale. Retail public.customers is not used
-- on purpose (B2B fields: legal name, INN, VAT payer, terms, credit limit,
-- own price list, own ledger).
--
-- This file adds / changes:
--   1) prod_price_lists (+ items)          at most one default per company
--   2) prod_customers                      ci-unique name, unique INN
--   3) prod_sales (+ items)                doc_type 'sale' (lot consumption,
--                                          strict hold mode, exact COGS)
--   4) prod_sale_returns (+ items)         doc_type 'sale_return' (restock
--                                          into new lots or loss)
--   5) prod_customer_payments
--   6) views prod_item_prices, prod_customer_balances, prod_customer_ageing,
--      prod_sales_lines_v, prod_sale_item_returnable
--   7) permission keys 'prod_sales', 'prod_customer_payments'
--   8) doc_type CHECKs extended; prod_cancel_document handles the new types
--
-- Objects:
--   NEW tables:  prod_price_lists, prod_price_list_items, prod_customers,
--                prod_sales, prod_sale_items, prod_sale_returns,
--                prod_sale_return_items, prod_customer_payments
--   NEW views:   prod_item_prices, prod_customer_balances,
--                prod_customer_ageing, prod_sales_lines_v,
--                prod_sale_item_returnable
--   NEW internal helper (EXECUTE revoked from every client role):
--                prod_customer_balance(company, customer)
--   NEW RPCs:    prod_save_price_list, prod_save_customer, prod_create_sale,
--                prod_create_sale_return, prod_create_customer_payment,
--                prod_cancel_customer_payment
--   REPLACED (same signatures, same return shapes):
--                has_permission       (latest = 20261110000010) + 2 keys
--                prod_cancel_document (latest = 20261110000014) + 'sale',
--                                     'sale_return'
--   NOT replaced (called unchanged): prod_consume (8-arg, mode 'strict'),
--     prod_add_lot, prod_reverse_document, prod_require_warehouse,
--     prod_lock_stock, prod_lot_remaining.
--
-- ── Pricing ───────────────────────────────────────────────────────────────
--   Line price is per unit WITHOUT VAT. Explicit items[i].price = manual
--   (negotiated) price, entered by the user like a receipt purchase price.
--   Omitted / null -> first match, per item, in this order (inactive lists
--   are skipped):
--     1. the sale's price_list_id (input; must be an ACTIVE list of the
--        company, else not_found / invalid_input)
--     2. the customer's price_list_id
--     3. the company's default list
--     4. prod_items.sale_price
--     5. none -> invalid_input DETAIL 'no_price'
--   prod_sales.price_list_id = the first non-null list of 1..3 (header
--   info); prod_sale_items.price_source tells where each price came from
--   ('manual' | 'sale_list' | 'customer_list' | 'default_list' | 'item').
--   amount = round(qty * price * (1 - discount_pct / 100), 2)
--   vat_amount = round(amount * vat_rate / 100, 2), total = amount + vat
--   header subtotal / vat_amount / total = sums of the lines.
--   vat_rate is NOT derived from customer.vat_payer (default 0; the client
--   pre-fills it).
--
-- ── Costing ───────────────────────────────────────────────────────────────
--   Each line consumes lots via prod_consume(..., 'sale', sale_id, lots,
--   'strict'): FEFO over FREE lots, or the user's picks (a held / blocked
--   pick -> invalid_input DETAIL 'lot_on_hold'). line cost = exact lot cost,
--   unit_cost = round(cost / qty, 2); the consumed lots are stored on the
--   line (prod_sale_items.lots = [{lot_id, lot_no, qty, unit_cost}]) so a
--   return knows which lots THIS line used (the same item may appear on
--   several lines). cost_total = sum, margin = subtotal - cost_total.
--
-- ── Credit limit ──────────────────────────────────────────────────────────
--   balance_before = customer balance (sales - returns - payments, posted)
--   read under the customer row lock (FOR NO KEY UPDATE: serialises the
--   sales of one customer; payments / returns only take KEY SHARE through
--   their FK and are not blocked). balance_after = before + total. If the
--   customer has a credit_limit and balance_after > limit:
--   p_data.enforce_credit_limit = true -> invalid_input DETAIL
--   'credit_limit' (nothing written); otherwise the sale is posted and
--   credit_warning {limit, balance_before, balance_after} is returned.
--   Only an inactive customer is refused for a sale (invalid_input);
--   payments / returns of an inactive customer are allowed.
--
-- ── Due date / ageing ─────────────────────────────────────────────────────
--   prod_sales.due_date = business date (Asia/Tashkent) of doc_date +
--   customer.payment_terms_days, NULL when the customer has no terms.
--   prod_customer_ageing: charges = posted sales (total incl. VAT), due =
--   due_date else the business date of doc_date. Credits = posted returns
--   (total) + posted payments, summed and allocated FIFO to the oldest
--   charges (due, doc_date, number, id). Buckets by days past due (today in
--   Tashkent): <= 0 not_due, 1..15, 16..30, 31+. balance = charges -
--   credits (= prod_customer_balances.balance; negative = advance, all
--   buckets 0).
--
-- ── Returns ───────────────────────────────────────────────────────────────
--   Lines reference prod_sale_items (of THAT sale). qty <= sold - already
--   returned by POSTED returns (else invalid_input DETAIL 'over_return').
--   Lot split of a line return: per original lot, avail = consumed qty -
--   already returned from it; take = trunc(qty * avail / sum(avail), 3),
--   the remainder is added 0.001 at a time to the lots in consumption order
--   (round robin, only lots with spare avail): the split always sums to qty
--   exactly and a final return takes exactly what is left of each lot.
--   restock = true (default): one NEW lot per original lot in the return
--   warehouse (default = sale warehouse, any active warehouse of the
--   company allowed), same unit_cost / fat / protein / supplier / expiry /
--   received_at, origin_lot_id = original lot, hold_status 'free',
--   source_doc_type 'sale_return'. restock = false: no stock movement, the
--   cost is recorded as loss (loss_cost).
--   Credit = the sale line's price incl. discount and the sale's vat_rate:
--   amount = round(qty * price * (1 - discount_pct/100), 2), vat =
--   round(amount * vat_rate / 100, 2), both capped by what is still
--   uncredited on the line; the return that completes a line credits
--   exactly the rest (the sum of returns never differs from the line by a
--   rounding cent).
--   prod_sale_items.unit = the item's unit at sale time. A restock line of
--   an item whose CURRENT unit differs (prod_change_item_unit after the
--   sale) -> invalid_input DETAIL 'unit_changed' (the sale qty is in the old
--   unit). Same guard on cancelling such a sale. Non-restock returns are
--   allowed (no stock moves).
--   Cancel a return: 1:1 reversal; a restocked lot already used ->
--   insufficient_stock (DETAIL item id). Cancel a sale with a posted return
--   -> invalid_input DETAIL 'has_returns'.
--   prod_create_price_correction does not revalue return lots (they are not
--   receipt lots) - by design, same as transfer lots of 14.
--
-- ── Reports (prod_sales_lines_v) ──────────────────────────────────────────
--   One row per posted sale line (row_kind 'sale') and per posted return
--   line (row_kind 'return', qty / amount / vat / total NEGATIVE). cost of a
--   return row = -cost when restocked (goods came back), 0 when not (the
--   COGS of lost goods stays). margin = amount - cost. So sum(amount) = net
--   revenue, sum(cost) = net COGS, sum(margin) = net margin.
--
-- ── Permissions ───────────────────────────────────────────────────────────
--   'prod_sales': customers, price lists, sales, returns, cancel of sale /
--   sale_return (+ owner / admin role, as every cancel).
--   'prod_customer_payments': create payments; cancel (+ owner / admin).
--   Both are prod keys in has_permission: production-module gate, owners
--   bypass, non-owners fail closed unless explicitly granted.
--   lib/permissions.ts must learn both keys before staff can be granted
--   them (until then only owners can use the module - safe).
--
-- ── Lock order (unchanged global order of 13 / 14) ────────────────────────
--   catalog locks 'prod_customer_save:<co>' / 'prod_price_list_save:<co>'
--     (only their save RPCs) -> row FOR UPDATE; nothing taken after them.
--   prod_create_sale: customer row FOR NO KEY UPDATE -> warehouse FOR SHARE
--     -> stock keys (one warehouse, ascending item_id) -> 'prod_sale_no'.
--   prod_create_sale_return: sale row FOR UPDATE -> warehouse FOR SHARE ->
--     'prod_sale_return_no' -> 'prod_lot_no' (inflows only, no stock key).
--   prod_cancel_document('sale'): sale row FOR UPDATE -> stock keys.
--   prod_cancel_document('sale_return'): sale row FOR UPDATE -> return row
--     FOR UPDATE -> stock keys (same order as create).
--   payments: customer row FOR KEY SHARE -> 'prod_customer_payment_no'.
--
-- ── Destructive / blocking statements ─────────────────────────────────────
--   WARNING: prod_stock_movements_doc_type_check and
--   prod_lots_source_doc_type_check are DROPped and re-ADDed (same names,
--   strictly wider sets: + 'sale', 'sale_return'). No data changed or lost;
--   the re-ADD re-validates existing rows under an ACCESS EXCLUSIVE lock on
--   the ledger / lots until COMMIT (production writes wait for the
--   migration).
--   Everything else: CREATE TABLE / VIEW / INDEX, CREATE OR REPLACE
--   FUNCTION. No existing row is deleted or rewritten, no backfill.
--
-- Client deploy: NOT required for safety. Replaced signatures / return
-- shapes are unchanged; all new objects are unused until the new pages
-- ship. Pending client work: see "Frontend contract" in the spec.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) doc types. WARNING: DROP + re-ADD (see header). ───────────────────

ALTER TABLE public.prod_stock_movements
  DROP CONSTRAINT prod_stock_movements_doc_type_check;
ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_doc_type_check
  CHECK (doc_type IN ('receipt', 'production', 'processing', 'transfer', 'conversion', 'separation',
                      'writeoff', 'stock_count', 'opening_balance', 'price_correction',
                      'sale', 'sale_return'));

ALTER TABLE public.prod_lots
  DROP CONSTRAINT prod_lots_source_doc_type_check;
ALTER TABLE public.prod_lots
  ADD CONSTRAINT prod_lots_source_doc_type_check CHECK (
    source_doc_type IS NULL OR source_doc_type IN (
      'opening', 'receipt', 'production', 'processing', 'transfer', 'conversion',
      'separation', 'legacy_reversal',
      'writeoff', 'stock_count', 'opening_balance', 'price_correction',
      'sale', 'sale_return'
    )
  );

-- ─── 2) New tables ────────────────────────────────────────────────────────
-- Access model for ALL of them (same as 03..14): company_id NOT NULL ->
-- companies ON DELETE CASCADE; RLS on with ONE company-scoped SELECT policy;
-- REVOKE ALL from authenticated + anon (default-grant leak), GRANT SELECT to
-- authenticated. Writes ONLY via the SECURITY DEFINER RPCs below.

-- 1) Price lists
CREATE TABLE public.prod_price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'UZS',
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_price_lists_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_price_lists_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT prod_price_lists_currency_check CHECK (currency = 'UZS'),
  CONSTRAINT prod_price_lists_default_active_check CHECK (NOT is_default OR is_active),
  CONSTRAINT prod_price_lists_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_price_lists IS
  'Production wholesale price lists (prices without VAT, UZS). At most one default per company. '
  'Read via RLS; write ONLY via prod_save_price_list.';

CREATE UNIQUE INDEX prod_price_lists_company_name_ci_key ON public.prod_price_lists (company_id, lower(btrim(name)));
CREATE UNIQUE INDEX prod_price_lists_company_default_key ON public.prod_price_lists (company_id) WHERE is_default;

CREATE TABLE public.prod_price_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL,
  item_id uuid NOT NULL,
  price numeric(14,2) NOT NULL,
  CONSTRAINT prod_price_list_items_list_fk FOREIGN KEY (price_list_id, company_id)
    REFERENCES public.prod_price_lists (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_price_list_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_price_list_items_list_item_key UNIQUE (price_list_id, item_id),
  CONSTRAINT prod_price_list_items_price_check CHECK (price >= 0)
);

COMMENT ON TABLE public.prod_price_list_items IS
  'Item prices of a production price list. Read via RLS; write ONLY via prod_save_price_list.';

CREATE INDEX prod_price_list_items_item_idx ON public.prod_price_list_items (item_id, company_id);

-- 2) Customers (B2B, separate from retail public.customers)
CREATE TABLE public.prod_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  legal_name text NULL,
  inn text NULL,
  phone text NULL,
  address text NULL,
  contact_person text NULL,
  price_list_id uuid NULL,
  credit_limit numeric(14,2) NULL,
  payment_terms_days integer NULL,
  vat_payer boolean NOT NULL DEFAULT false,
  note text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_customers_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_customers_price_list_fk FOREIGN KEY (price_list_id, company_id)
    REFERENCES public.prod_price_lists (id, company_id),
  CONSTRAINT prod_customers_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT prod_customers_legal_name_check CHECK (legal_name IS NULL OR length(legal_name) <= 300),
  CONSTRAINT prod_customers_inn_check CHECK (inn IS NULL OR length(inn) BETWEEN 1 AND 20),
  CONSTRAINT prod_customers_phone_check CHECK (phone IS NULL OR length(phone) <= 30),
  CONSTRAINT prod_customers_address_check CHECK (address IS NULL OR length(address) <= 300),
  CONSTRAINT prod_customers_contact_check CHECK (contact_person IS NULL OR length(contact_person) <= 200),
  CONSTRAINT prod_customers_credit_limit_check CHECK (credit_limit IS NULL OR credit_limit >= 0),
  CONSTRAINT prod_customers_terms_check CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  CONSTRAINT prod_customers_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_customers IS
  'Production wholesale (B2B) customers. Separate from retail public.customers. Read via RLS; '
  'write ONLY via prod_save_customer.';

CREATE UNIQUE INDEX prod_customers_company_name_ci_key ON public.prod_customers (company_id, lower(btrim(name)));
CREATE UNIQUE INDEX prod_customers_company_inn_key ON public.prod_customers (company_id, inn) WHERE inn IS NOT NULL;
CREATE INDEX prod_customers_price_list_idx ON public.prod_customers (price_list_id, company_id)
  WHERE price_list_id IS NOT NULL;

-- 3) Sales (dispatch / nakladnoy)
CREATE TABLE public.prod_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  customer_id uuid NOT NULL,
  customer_name text NOT NULL,
  warehouse_id uuid NOT NULL,
  price_list_id uuid NULL,
  due_date date NULL,
  vat_rate numeric(5,2) NOT NULL DEFAULT 0,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  cost_total numeric(14,2) NOT NULL DEFAULT 0,
  margin numeric(14,2) NOT NULL DEFAULT 0,
  vehicle_no text NULL,
  driver text NULL,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_sales_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_sales_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_sales_customer_fk FOREIGN KEY (customer_id, company_id)
    REFERENCES public.prod_customers (id, company_id),
  CONSTRAINT prod_sales_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_sales_price_list_fk FOREIGN KEY (price_list_id, company_id)
    REFERENCES public.prod_price_lists (id, company_id),
  CONSTRAINT prod_sales_number_check CHECK (number > 0),
  CONSTRAINT prod_sales_vat_rate_check CHECK (vat_rate BETWEEN 0 AND 100),
  CONSTRAINT prod_sales_amounts_check CHECK (subtotal >= 0 AND vat_amount >= 0 AND cost_total >= 0
                                             AND total = subtotal + vat_amount AND margin = subtotal - cost_total),
  CONSTRAINT prod_sales_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_sales_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_sales_vehicle_check CHECK (vehicle_no IS NULL OR length(vehicle_no) <= 30),
  CONSTRAINT prod_sales_driver_check CHECK (driver IS NULL OR length(driver) <= 100),
  CONSTRAINT prod_sales_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_sales IS
  'Production wholesale sales (nakladnoy), doc_type ''sale''. Read via RLS; write ONLY via '
  'prod_create_sale / prod_cancel_document.';

CREATE INDEX prod_sales_company_date_idx ON public.prod_sales (company_id, doc_date DESC);
CREATE INDEX prod_sales_customer_idx ON public.prod_sales (customer_id, company_id);
CREATE INDEX prod_sales_warehouse_idx ON public.prod_sales (warehouse_id, company_id);
CREATE INDEX prod_sales_price_list_idx ON public.prod_sales (price_list_id, company_id) WHERE price_list_id IS NOT NULL;

CREATE TABLE public.prod_sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  item_id uuid NOT NULL,
  unit text NOT NULL,
  qty numeric(14,3) NOT NULL,
  price numeric(14,2) NOT NULL,
  discount_pct numeric(5,2) NOT NULL DEFAULT 0,
  price_source text NOT NULL,
  amount numeric(14,2) NOT NULL,
  vat_amount numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  cost numeric(14,2) NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  lots jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT prod_sale_items_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_sale_items_sale_fk FOREIGN KEY (sale_id, company_id)
    REFERENCES public.prod_sales (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_sale_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_sale_items_qty_check CHECK (qty > 0),
  CONSTRAINT prod_sale_items_price_check CHECK (price >= 0),
  CONSTRAINT prod_sale_items_discount_check CHECK (discount_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_sale_items_source_check CHECK (price_source IN ('manual', 'sale_list', 'customer_list', 'default_list', 'item')),
  CONSTRAINT prod_sale_items_amounts_check CHECK (amount >= 0 AND vat_amount >= 0 AND total = amount + vat_amount
                                                  AND cost >= 0 AND unit_cost >= 0),
  CONSTRAINT prod_sale_items_lots_check CHECK (jsonb_typeof(lots) = 'array'),
  CONSTRAINT prod_sale_items_sort_check CHECK (sort_order >= 0)
);

COMMENT ON TABLE public.prod_sale_items IS
  'Lines of a production sale. unit = item unit at sale time; price per unit without VAT; cost = exact '
  'cost of the consumed lots (lots = [{lot_id, lot_no, qty, unit_cost}]). Read via RLS; write ONLY via prod_create_sale.';

CREATE INDEX prod_sale_items_sale_idx ON public.prod_sale_items (sale_id, company_id);
CREATE INDEX prod_sale_items_item_idx ON public.prod_sale_items (item_id, company_id);

-- 4) Sale returns
CREATE TABLE public.prod_sale_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  sale_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  reason text NULL,
  note text NULL,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  cost_total numeric(14,2) NOT NULL DEFAULT 0,
  loss_cost numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_sale_returns_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_sale_returns_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_sale_returns_sale_fk FOREIGN KEY (sale_id, company_id)
    REFERENCES public.prod_sales (id, company_id),
  CONSTRAINT prod_sale_returns_customer_fk FOREIGN KEY (customer_id, company_id)
    REFERENCES public.prod_customers (id, company_id),
  CONSTRAINT prod_sale_returns_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_sale_returns_number_check CHECK (number > 0),
  CONSTRAINT prod_sale_returns_amounts_check CHECK (subtotal >= 0 AND vat_amount >= 0 AND total = subtotal + vat_amount
                                                    AND cost_total >= 0 AND loss_cost >= 0 AND loss_cost <= cost_total),
  CONSTRAINT prod_sale_returns_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_sale_returns_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_sale_returns_reason_check CHECK (reason IS NULL OR length(reason) <= 200),
  CONSTRAINT prod_sale_returns_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_sale_returns IS
  'Returns of a production sale, doc_type ''sale_return''. total = credit to the customer. '
  'Read via RLS; write ONLY via prod_create_sale_return / prod_cancel_document.';

CREATE INDEX prod_sale_returns_sale_idx ON public.prod_sale_returns (sale_id, company_id);
CREATE INDEX prod_sale_returns_customer_idx ON public.prod_sale_returns (customer_id, company_id);
CREATE INDEX prod_sale_returns_warehouse_idx ON public.prod_sale_returns (warehouse_id, company_id);
CREATE INDEX prod_sale_returns_company_date_idx ON public.prod_sale_returns (company_id, doc_date DESC);

-- lots = [{origin_lot_id, lot_id (new lot, NULL when not restocked), qty, unit_cost}]
CREATE TABLE public.prod_sale_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  return_id uuid NOT NULL,
  sale_item_id uuid NOT NULL,
  item_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  qty numeric(14,3) NOT NULL,
  restock boolean NOT NULL,
  price numeric(14,2) NOT NULL,
  discount_pct numeric(5,2) NOT NULL,
  amount numeric(14,2) NOT NULL,
  vat_amount numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  cost numeric(14,2) NOT NULL,
  lots jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT prod_sale_return_items_return_fk FOREIGN KEY (return_id, company_id)
    REFERENCES public.prod_sale_returns (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_sale_return_items_sale_item_fk FOREIGN KEY (sale_item_id, company_id)
    REFERENCES public.prod_sale_items (id, company_id),
  CONSTRAINT prod_sale_return_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_sale_return_items_return_line_key UNIQUE (return_id, sale_item_id),
  CONSTRAINT prod_sale_return_items_qty_check CHECK (qty > 0),
  CONSTRAINT prod_sale_return_items_amounts_check CHECK (price >= 0 AND discount_pct BETWEEN 0 AND 100
                                                         AND amount >= 0 AND vat_amount >= 0
                                                         AND total = amount + vat_amount AND cost >= 0),
  CONSTRAINT prod_sale_return_items_lots_check CHECK (jsonb_typeof(lots) = 'array'),
  CONSTRAINT prod_sale_return_items_sort_check CHECK (sort_order >= 0)
);

COMMENT ON TABLE public.prod_sale_return_items IS
  'Lines of a production sale return (sale_item_id = returned sale line). Read via RLS; write ONLY '
  'via prod_create_sale_return.';

CREATE INDEX prod_sale_return_items_return_idx ON public.prod_sale_return_items (return_id, company_id);
CREATE INDEX prod_sale_return_items_sale_item_idx ON public.prod_sale_return_items (sale_item_id, company_id);
CREATE INDEX prod_sale_return_items_item_idx ON public.prod_sale_return_items (item_id, company_id);

-- 5) Customer payments (money received). Never edited / deleted, only cancelled.
CREATE TABLE public.prod_customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  customer_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  method text NOT NULL DEFAULT 'cash',
  pay_date date NOT NULL,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_customer_payments_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_customer_payments_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_customer_payments_customer_fk FOREIGN KEY (customer_id, company_id)
    REFERENCES public.prod_customers (id, company_id),
  CONSTRAINT prod_customer_payments_number_check CHECK (number > 0),
  CONSTRAINT prod_customer_payments_amount_check CHECK (amount > 0),
  CONSTRAINT prod_customer_payments_method_check CHECK (method IN ('cash', 'card', 'transfer')),
  CONSTRAINT prod_customer_payments_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_customer_payments_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_customer_payments_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_customer_payments IS
  'Payments received from production customers. Read via RLS; write ONLY via '
  'prod_create_customer_payment / prod_cancel_customer_payment.';

CREATE INDEX prod_customer_payments_customer_idx ON public.prod_customer_payments (customer_id, company_id);
CREATE INDEX prod_customer_payments_company_date_idx ON public.prod_customer_payments (company_id, pay_date DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'prod_price_lists', 'prod_price_list_items', 'prod_customers', 'prod_sales', 'prod_sale_items',
    'prod_sale_returns', 'prod_sale_return_items', 'prod_customer_payments'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "Company isolation (select)" ON public.%I '
      'FOR SELECT TO authenticated '
      'USING (company_id = (SELECT public.get_company_id()))',
      t
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated, anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END;
$$;

-- ─── 3) Views (security_invoker: the caller's RLS on the base tables) ────

-- Every price list x every item of the company: list_price (NULL = not in
-- the list), default_price (active default list), item_sale_price, price =
-- what a sale with that list would use for the item (customer list aside).
CREATE VIEW public.prod_item_prices
WITH (security_invoker = true)
AS
SELECT
  pl.id AS price_list_id,
  pl.company_id,
  pl.name AS price_list_name,
  pl.is_default,
  pl.is_active,
  i.id AS item_id,
  i.name AS item_name,
  i.unit AS item_unit,
  i.group_id,
  i.is_active AS item_is_active,
  pli.price AS list_price,
  d.price AS default_price,
  i.sale_price AS item_sale_price,
  COALESCE(pli.price, d.price, i.sale_price) AS price
FROM public.prod_price_lists pl
JOIN public.prod_items i ON i.company_id = pl.company_id
LEFT JOIN public.prod_price_list_items pli
  ON pli.price_list_id = pl.id AND pli.item_id = i.id AND pli.company_id = pl.company_id
LEFT JOIN (
  SELECT dl.company_id, dli.item_id, dli.price
  FROM public.prod_price_lists dl
  JOIN public.prod_price_list_items dli ON dli.price_list_id = dl.id AND dli.company_id = dl.company_id
  WHERE dl.is_default AND dl.is_active
) d ON d.company_id = i.company_id AND d.item_id = i.id;

COMMENT ON VIEW public.prod_item_prices IS
  'Per price list x item: list_price, default_price, item_sale_price and the resolved price '
  '(list -> default list -> item.sale_price).';

CREATE VIEW public.prod_customer_balances
WITH (security_invoker = true)
AS
SELECT
  c.id AS customer_id,
  c.company_id,
  c.name,
  COALESCE(s.sales_total, 0)::numeric(14,2) AS sales_total,
  COALESCE(r.returns_total, 0)::numeric(14,2) AS returns_total,
  COALESCE(p.payments_total, 0)::numeric(14,2) AS payments_total,
  (COALESCE(s.sales_total, 0) - COALESCE(r.returns_total, 0) - COALESCE(p.payments_total, 0))::numeric(14,2) AS balance,
  s.last_sale_at,
  p.last_payment_at,
  c.credit_limit
FROM public.prod_customers c
LEFT JOIN (
  SELECT customer_id, company_id, sum(total) AS sales_total, max(doc_date) AS last_sale_at
  FROM public.prod_sales
  WHERE status = 'posted'
  GROUP BY customer_id, company_id
) s ON s.customer_id = c.id AND s.company_id = c.company_id
LEFT JOIN (
  SELECT customer_id, company_id, sum(total) AS returns_total
  FROM public.prod_sale_returns
  WHERE status = 'posted'
  GROUP BY customer_id, company_id
) r ON r.customer_id = c.id AND r.company_id = c.company_id
LEFT JOIN (
  SELECT customer_id, company_id, sum(amount) AS payments_total, max(pay_date) AS last_payment_at
  FROM public.prod_customer_payments
  WHERE status = 'posted'
  GROUP BY customer_id, company_id
) p ON p.customer_id = c.id AND p.company_id = c.company_id;

COMMENT ON VIEW public.prod_customer_balances IS
  'Per production customer: posted sales, returns, payments; balance = sales - returns - payments '
  '(positive = the customer owes us, negative = advance).';

CREATE VIEW public.prod_customer_ageing
WITH (security_invoker = true)
AS
WITH cr AS (
  SELECT x.customer_id, x.company_id, sum(x.amount) AS credited
  FROM (
    SELECT customer_id, company_id, amount FROM public.prod_customer_payments WHERE status = 'posted'
    UNION ALL
    SELECT customer_id, company_id, total FROM public.prod_sale_returns WHERE status = 'posted'
  ) x
  GROUP BY x.customer_id, x.company_id
),
ch AS (
  SELECT s.company_id, s.customer_id, s.id, s.number, s.doc_date, s.total AS amount,
         COALESCE(s.due_date, (s.doc_date AT TIME ZONE 'Asia/Tashkent')::date) AS due
  FROM public.prod_sales s
  WHERE s.status = 'posted'
),
al AS (
  SELECT ch.company_id, ch.customer_id, ch.amount,
         (now() AT TIME ZONE 'Asia/Tashkent')::date - ch.due AS days_overdue,
         GREATEST(LEAST(
           ch.amount,
           sum(ch.amount) OVER (
             PARTITION BY ch.company_id, ch.customer_id
             ORDER BY ch.due, ch.doc_date, ch.number, ch.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) - COALESCE(cr.credited, 0)
         ), 0) AS open_amount
  FROM ch
  LEFT JOIN cr ON cr.customer_id = ch.customer_id AND cr.company_id = ch.company_id
),
agg AS (
  SELECT al.company_id, al.customer_id,
         sum(al.amount) AS charged,
         sum(al.open_amount) FILTER (WHERE al.days_overdue <= 0) AS not_due,
         sum(al.open_amount) FILTER (WHERE al.days_overdue BETWEEN 1 AND 15) AS overdue_1_15,
         sum(al.open_amount) FILTER (WHERE al.days_overdue BETWEEN 16 AND 30) AS overdue_16_30,
         sum(al.open_amount) FILTER (WHERE al.days_overdue >= 31) AS overdue_31_plus
  FROM al
  GROUP BY al.company_id, al.customer_id
)
SELECT
  c.id AS customer_id,
  c.company_id,
  c.name,
  (COALESCE(agg.charged, 0) - COALESCE(cr.credited, 0))::numeric(14,2) AS balance,
  COALESCE(agg.not_due, 0)::numeric(14,2) AS not_due,
  COALESCE(agg.overdue_1_15, 0)::numeric(14,2) AS overdue_1_15,
  COALESCE(agg.overdue_16_30, 0)::numeric(14,2) AS overdue_16_30,
  COALESCE(agg.overdue_31_plus, 0)::numeric(14,2) AS overdue_31_plus
FROM public.prod_customers c
LEFT JOIN agg ON agg.customer_id = c.id AND agg.company_id = c.company_id
LEFT JOIN cr ON cr.customer_id = c.id AND cr.company_id = c.company_id;

COMMENT ON VIEW public.prod_customer_ageing IS
  'Per production customer: balance (= prod_customer_balances.balance) and the open sale amounts after '
  'FIFO allocation of posted payments + returns, bucketed by days past due (Asia/Tashkent date).';

-- Sales report lines (see header "Reports").
CREATE VIEW public.prod_sales_lines_v
WITH (security_invoker = true)
AS
SELECT
  'sale'::text AS row_kind,
  si.company_id,
  s.id AS sale_id,
  s.number AS sale_number,
  NULL::uuid AS return_id,
  NULL::integer AS return_number,
  si.id AS sale_item_id,
  s.doc_date,
  s.customer_id,
  c.name AS customer_name,
  s.warehouse_id,
  si.item_id,
  i.name AS item_name,
  si.unit AS item_unit,
  i.group_id,
  g.name AS group_name,
  si.qty,
  si.price,
  si.discount_pct,
  si.amount,
  si.vat_amount,
  si.total,
  si.cost,
  (si.amount - si.cost) AS margin
FROM public.prod_sale_items si
JOIN public.prod_sales s ON s.id = si.sale_id AND s.company_id = si.company_id
LEFT JOIN public.prod_customers c ON c.id = s.customer_id
LEFT JOIN public.prod_items i ON i.id = si.item_id
LEFT JOIN public.prod_item_groups g ON g.id = i.group_id
WHERE s.status = 'posted'
UNION ALL
SELECT
  'return'::text,
  ri.company_id,
  s.id,
  s.number,
  r.id,
  r.number,
  ri.sale_item_id,
  r.doc_date,
  r.customer_id,
  c.name,
  r.warehouse_id,
  ri.item_id,
  i.name,
  si.unit,
  i.group_id,
  g.name,
  -ri.qty,
  ri.price,
  ri.discount_pct,
  -ri.amount,
  -ri.vat_amount,
  -ri.total,
  CASE WHEN ri.restock THEN -ri.cost ELSE 0 END,
  (-ri.amount) - CASE WHEN ri.restock THEN -ri.cost ELSE 0 END
FROM public.prod_sale_return_items ri
JOIN public.prod_sale_returns r ON r.id = ri.return_id AND r.company_id = ri.company_id
JOIN public.prod_sales s ON s.id = r.sale_id AND s.company_id = r.company_id
JOIN public.prod_sale_items si ON si.id = ri.sale_item_id AND si.company_id = ri.company_id
LEFT JOIN public.prod_customers c ON c.id = r.customer_id
LEFT JOIN public.prod_items i ON i.id = ri.item_id
LEFT JOIN public.prod_item_groups g ON g.id = i.group_id
WHERE r.status = 'posted';

COMMENT ON VIEW public.prod_sales_lines_v IS
  'Posted sale lines (row_kind sale) and posted return lines (row_kind return, negative qty / amount / '
  'vat / total; cost negative only when restocked). Sums = net revenue / net COGS / net margin.';

-- Returnable qty per sale line (for the return form).
CREATE VIEW public.prod_sale_item_returnable
WITH (security_invoker = true)
AS
SELECT
  si.id AS sale_item_id,
  si.company_id,
  si.sale_id,
  si.item_id,
  si.qty,
  COALESCE(rt.qty, 0) AS returned_qty,
  si.qty - COALESCE(rt.qty, 0) AS returnable_qty,
  COALESCE(rt.amount, 0) AS returned_amount,
  si.amount - COALESCE(rt.amount, 0) AS returnable_amount
FROM public.prod_sale_items si
LEFT JOIN (
  SELECT ri.sale_item_id, ri.company_id, sum(ri.qty) AS qty, sum(ri.amount) AS amount
  FROM public.prod_sale_return_items ri
  JOIN public.prod_sale_returns r ON r.id = ri.return_id AND r.company_id = ri.company_id
  WHERE r.status = 'posted'
  GROUP BY ri.sale_item_id, ri.company_id
) rt ON rt.sale_item_id = si.id AND rt.company_id = si.company_id;

COMMENT ON VIEW public.prod_sale_item_returnable IS
  'Per sale line: sold qty, qty / amount already returned by posted returns, what can still be returned.';

REVOKE ALL ON public.prod_item_prices FROM authenticated, anon;
GRANT SELECT ON public.prod_item_prices TO authenticated;
REVOKE ALL ON public.prod_customer_balances FROM authenticated, anon;
GRANT SELECT ON public.prod_customer_balances TO authenticated;
REVOKE ALL ON public.prod_customer_ageing FROM authenticated, anon;
GRANT SELECT ON public.prod_customer_ageing TO authenticated;
REVOKE ALL ON public.prod_sales_lines_v FROM authenticated, anon;
GRANT SELECT ON public.prod_sales_lines_v TO authenticated;
REVOKE ALL ON public.prod_sale_item_returnable FROM authenticated, anon;
GRANT SELECT ON public.prod_sale_item_returnable TO authenticated;

-- ─── 4) Internal helper ───────────────────────────────────────────────────
-- Balance of one customer with explicit company scoping (same formula as
-- prod_customer_balances, without relying on RLS). VOLATILE: read after the
-- caller's customer row lock.
CREATE OR REPLACE FUNCTION public.prod_customer_balance(p_company_id uuid, p_customer_id uuid)
RETURNS numeric
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE((SELECT sum(s.total) FROM public.prod_sales s
              WHERE s.company_id = p_company_id AND s.customer_id = p_customer_id AND s.status = 'posted'), 0)
  - COALESCE((SELECT sum(r.total) FROM public.prod_sale_returns r
              WHERE r.company_id = p_company_id AND r.customer_id = p_customer_id AND r.status = 'posted'), 0)
  - COALESCE((SELECT sum(p.amount) FROM public.prod_customer_payments p
              WHERE p.company_id = p_company_id AND p.customer_id = p_customer_id AND p.status = 'posted'), 0)
$$;

REVOKE EXECUTE ON FUNCTION public.prod_customer_balance(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ─── 5) has_permission ────────────────────────────────────────────────────
-- Copied verbatim from 20261110000010 (latest definition). ONLY change:
-- 'prod_sales' and 'prod_customer_payments' added to v_prod_keys
-- (production-module gate + fail-closed for non-owners) and v_valid_keys.
CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_role text;
  v_permissions jsonb;
  v_business_type text;
  v_prod_keys text[] := ARRAY[
    'prod_catalog', 'prod_production', 'prod_processing',
    'prod_receipts', 'prod_stock', 'prod_supply', 'prod_suppliers',
    'prod_milk', 'prod_lab',
    'prod_sales', 'prod_customer_payments'
  ];
  v_shared_keys text[] := ARRAY[
    'dashboard', 'xarajatlar', 'hr', 'jamoa', 'sozlamalar'
  ];
  v_valid_keys text[] := ARRAY[
    'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
    'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
    'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
    'reports_moliya', 'reports_foyda', 'reports_sotuvlar', 'reports_mijozlar',
    'reports_yetkazuvchilar', 'reports_kirim', 'reports_spisaniya',
    'reports_xarajatlar', 'reports_inventar',
    'peremeshenie', 'reports_peremeshenie',
    'yetkazuvchilar',
    'prod_catalog', 'prod_production', 'prod_processing',
    'prod_receipts', 'prod_stock', 'prod_supply', 'prod_suppliers',
    'prod_milk', 'prod_lab',
    'prod_sales', 'prod_customer_payments'
  ];
BEGIN
  IF NOT (p_key = ANY(v_valid_keys)) THEN
    RETURN false;
  END IF;

  SELECT u.role, u.permissions, c.business_type
  INTO v_role, v_permissions, v_business_type
  FROM public.users u
  LEFT JOIN public.companies c ON c.id = u.company_id
  WHERE u.id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Business-type / module gate (before the owner shortcut).
  IF COALESCE(v_business_type, 'retail') = 'production' THEN
    IF NOT (p_key = ANY(v_prod_keys || v_shared_keys)) THEN
      RETURN false;
    END IF;
  ELSE
    IF p_key = ANY(v_prod_keys) AND NOT public.production_enabled() THEN
      RETURN false;
    END IF;
  END IF;

  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  -- prod_* keys: fail closed when not explicitly granted.
  IF p_key = ANY(v_prod_keys) THEN
    IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
      RETURN false;
    END IF;
    RETURN COALESCE((v_permissions->>p_key)::boolean, false);
  END IF;

  -- Retail / shared keys: legacy semantics (missing key = allowed).
  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;

-- ─── 6) RPCs ──────────────────────────────────────────────────────────────

-- ═══ prod_save_price_list (new) ══════════════════════════════════════════
-- prod_sales. p_id NULL -> create, else update the company's list
-- (not_found). p_data: { name, is_default, is_active, note,
--   items: [{ item_id, price }] }
-- name required (<= 200, case-insensitive unique -> 'duplicate' DETAIL
-- 'name'). is_default / is_active / note: key absent -> unchanged on update
-- (create: false / true / NULL). is_default = true -> every other default
-- of the company is unset first; a default must be active (invalid_input).
-- items: key absent -> lines unchanged (create: none); present -> REPLACE
-- all lines (0..5000, item of the company else not_found, no duplicate
-- item, price >= 0 with 2 decimals). Lock: 'prod_price_list_save:<co>' ->
-- list row FOR UPDATE. Returns the id.
CREATE OR REPLACE FUNCTION public.prod_save_price_list(p_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
  v_name text;
  v_old_name text;
  v_old_default boolean;
  v_old_active boolean;
  v_default boolean;
  v_active boolean;
  v_note text;
  v_has_items boolean;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_prices numeric[] := '{}';
  v_item_id uuid;
  v_price numeric;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_name := public.prod_jtext(p_data, 'name', 200);
  v_default := public.prod_jbool(p_data, 'is_default');
  v_active := public.prod_jbool(p_data, 'is_active');
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_has_items := p_data ? 'items' AND jsonb_typeof(p_data->'items') <> 'null';

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_has_items THEN
    IF jsonb_typeof(p_data->'items') <> 'array' OR jsonb_array_length(p_data->'items') > 5000 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
    LOOP
      v_item_id := public.prod_juuid(v_line, 'item_id');
      v_price := public.prod_jnum(v_line, 'price', 2);
      IF v_item_id IS NULL OR v_price IS NULL OR v_price < 0 OR v_item_id = ANY (v_item_ids) THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      v_item_ids := v_item_ids || v_item_id;
      v_prices := v_prices || v_price;
    END LOOP;
    IF (SELECT count(*) FROM public.prod_items
        WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_price_list_save:' || v_company_id::text, 0));

  IF p_id IS NOT NULL THEN
    SELECT name, is_default, is_active INTO v_old_name, v_old_default, v_old_active
    FROM public.prod_price_lists
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  v_default := COALESCE(v_default, v_old_default, false);
  v_active := COALESCE(v_active, v_old_active, true);
  IF v_default AND NOT v_active THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF (p_id IS NULL OR lower(btrim(v_old_name)) <> lower(v_name)) AND EXISTS (
    SELECT 1 FROM public.prod_price_lists
    WHERE company_id = v_company_id AND lower(btrim(name)) = lower(v_name)
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END IF;

  IF v_default THEN
    UPDATE public.prod_price_lists
    SET is_default = false, updated_at = now()
    WHERE company_id = v_company_id AND is_default AND (p_id IS NULL OR id <> p_id);
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_price_lists (company_id, name, is_default, is_active, note)
      VALUES (v_company_id, v_name, v_default, v_active, v_note)
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_price_lists
      SET name = v_name,
          is_default = v_default,
          is_active = v_active,
          note = CASE WHEN p_data ? 'note' THEN v_note ELSE note END,
          updated_at = now()
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END;

  IF v_has_items THEN
    DELETE FROM public.prod_price_list_items
    WHERE price_list_id = v_id AND company_id = v_company_id;
    FOR i IN 1 .. cardinality(v_item_ids)
    LOOP
      INSERT INTO public.prod_price_list_items (company_id, price_list_id, item_id, price)
      VALUES (v_company_id, v_id, v_item_ids[i], v_prices[i]);
    END LOOP;
  END IF;

  RETURN v_id;
END;
$$;

-- ═══ prod_save_customer (new) ════════════════════════════════════════════
-- prod_sales. p_id NULL -> create, else update the company's customer.
-- p_data: { name, legal_name, inn, phone, address, contact_person,
--   price_list_id, credit_limit, payment_terms_days, vat_payer, note,
--   is_active }
-- name required (<= 200). Every other key: absent -> unchanged on update
-- (create: NULL / vat_payer false / is_active true); present + null ->
-- cleared. Duplicates (under 'prod_customer_save:<co>'): name
-- case-insensitive trimmed, inn exact (trimmed) -> 'duplicate' DETAIL
-- 'name' | 'inn' (checked on create and for a CHANGED value).
-- price_list_id: a list of the company (not_found); a NEWLY set list must be
-- active (invalid_input). credit_limit >= 0, payment_terms_days integer
-- 0..365. Returns the id.
CREATE OR REPLACE FUNCTION public.prod_save_customer(p_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
  v_old_name text;
  v_old_inn text;
  v_old_list uuid;
  v_name text;
  v_legal text;
  v_inn text;
  v_phone text;
  v_address text;
  v_contact text;
  v_list uuid;
  v_list_active boolean;
  v_limit numeric;
  v_terms numeric;
  v_vat boolean;
  v_note text;
  v_active boolean;
  v_con text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_name := public.prod_jtext(p_data, 'name', 200);
  v_legal := public.prod_jtext(p_data, 'legal_name', 300);
  v_inn := public.prod_jtext(p_data, 'inn', 20);
  v_phone := public.prod_jtext(p_data, 'phone', 30);
  v_address := public.prod_jtext(p_data, 'address', 300);
  v_contact := public.prod_jtext(p_data, 'contact_person', 200);
  v_list := public.prod_juuid(p_data, 'price_list_id');
  v_limit := public.prod_jnum(p_data, 'credit_limit', 2);
  v_terms := public.prod_jnum(p_data, 'payment_terms_days', 3);
  v_vat := public.prod_jbool(p_data, 'vat_payer');
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_active := public.prod_jbool(p_data, 'is_active');

  IF v_name IS NULL
     OR (v_limit IS NOT NULL AND v_limit < 0)
     OR (v_terms IS NOT NULL AND (v_terms <> trunc(v_terms) OR v_terms NOT BETWEEN 0 AND 365)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_customer_save:' || v_company_id::text, 0));

  IF p_id IS NOT NULL THEN
    SELECT name, inn, price_list_id INTO v_old_name, v_old_inn, v_old_list
    FROM public.prod_customers
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  IF v_list IS NOT NULL THEN
    SELECT is_active INTO v_list_active
    FROM public.prod_price_lists
    WHERE id = v_list AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_list_active AND (p_id IS NULL OR v_old_list IS DISTINCT FROM v_list) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;

  IF (p_id IS NULL OR lower(btrim(v_old_name)) <> lower(v_name)) AND EXISTS (
    SELECT 1 FROM public.prod_customers
    WHERE company_id = v_company_id AND lower(btrim(name)) = lower(v_name)
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END IF;

  IF v_inn IS NOT NULL AND (p_id IS NULL OR v_old_inn IS DISTINCT FROM v_inn) AND EXISTS (
    SELECT 1 FROM public.prod_customers
    WHERE company_id = v_company_id AND inn = v_inn
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'inn';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_customers (
        company_id, name, legal_name, inn, phone, address, contact_person, price_list_id,
        credit_limit, payment_terms_days, vat_payer, note, is_active
      ) VALUES (
        v_company_id, v_name, v_legal, v_inn, v_phone, v_address, v_contact, v_list,
        v_limit, v_terms::integer, COALESCE(v_vat, false), v_note, COALESCE(v_active, true)
      )
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_customers
      SET name = v_name,
          legal_name = CASE WHEN p_data ? 'legal_name' THEN v_legal ELSE legal_name END,
          inn = CASE WHEN p_data ? 'inn' THEN v_inn ELSE inn END,
          phone = CASE WHEN p_data ? 'phone' THEN v_phone ELSE phone END,
          address = CASE WHEN p_data ? 'address' THEN v_address ELSE address END,
          contact_person = CASE WHEN p_data ? 'contact_person' THEN v_contact ELSE contact_person END,
          price_list_id = CASE WHEN p_data ? 'price_list_id' THEN v_list ELSE price_list_id END,
          credit_limit = CASE WHEN p_data ? 'credit_limit' THEN v_limit ELSE credit_limit END,
          payment_terms_days = CASE WHEN p_data ? 'payment_terms_days' THEN v_terms::integer ELSE payment_terms_days END,
          vat_payer = COALESCE(v_vat, vat_payer),
          note = CASE WHEN p_data ? 'note' THEN v_note ELSE note END,
          is_active = COALESCE(v_active, is_active),
          updated_at = now()
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
      RAISE EXCEPTION 'duplicate' USING DETAIL = CASE WHEN v_con LIKE '%inn%' THEN 'inn' ELSE 'name' END;
  END;

  RETURN v_id;
END;
$$;

-- ═══ prod_create_sale (new) ══════════════════════════════════════════════
-- prod_sales. p_data: { doc_date, customer_id, warehouse_id, price_list_id,
--   vat_rate, vehicle_no, driver, note, enforce_credit_limit,
--   items: [{ item_id, qty, price, discount_pct, lots: [{lot_id, qty}] }] }
-- Pricing / costing / credit limit / due date: see header. 1..500 lines
-- (the same item may repeat); items of the company (inactive allowed),
-- else not_found; customer of the company (not_found) and active
-- (invalid_input). Lock order: customer row FOR NO KEY UPDATE -> warehouse
-- FOR SHARE -> stock keys -> 'prod_sale_no'.
-- Returns { id, number, subtotal, vat_amount, total, cost_total, margin,
--   due_date, credit_warning: {limit, balance_before, balance_after} | null }.
CREATE OR REPLACE FUNCTION public.prod_create_sale(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_customer_id uuid;
  v_cust record;
  v_wh uuid;
  v_sale_list uuid;
  v_cust_list uuid;
  v_def_list uuid;
  v_list_active boolean;
  v_vat_rate numeric;
  v_vehicle text;
  v_driver text;
  v_note text;
  v_enforce boolean;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_prices numeric[] := '{}';
  v_discs numeric[] := '{}';
  v_sources text[] := '{}';
  v_amounts numeric[] := '{}';
  v_vats numeric[] := '{}';
  v_picks jsonb[] := '{}';
  v_costs numeric[] := '{}';
  v_lots jsonb[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_price numeric;
  v_disc numeric;
  v_source text;
  v_amount numeric;
  v_vat numeric;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_total numeric;
  v_cost_total numeric := 0;
  v_res jsonb;
  v_balance numeric;
  v_warning jsonb;
  v_due date;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_doc_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());
  v_customer_id := public.prod_juuid(p_data, 'customer_id');
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_sale_list := public.prod_juuid(p_data, 'price_list_id');
  v_vat_rate := COALESCE(public.prod_jnum(p_data, 'vat_rate', 2), 0);
  v_vehicle := public.prod_jtext(p_data, 'vehicle_no', 30);
  v_driver := public.prod_jtext(p_data, 'driver', 100);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_enforce := COALESCE(public.prod_jbool(p_data, 'enforce_credit_limit'), false);

  IF v_customer_id IS NULL OR v_wh IS NULL OR v_vat_rate NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Customer row lock first (see header "Credit limit" / lock order).
  SELECT c.name, c.is_active, c.price_list_id, c.credit_limit, c.payment_terms_days INTO v_cust
  FROM public.prod_customers c
  WHERE c.id = v_customer_id AND c.company_id = v_company_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_cust.is_active THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);

  -- Price lists of the resolution chain (inactive lists are skipped).
  IF v_sale_list IS NOT NULL THEN
    SELECT is_active INTO v_list_active
    FROM public.prod_price_lists WHERE id = v_sale_list AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_list_active THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;
  SELECT id INTO v_cust_list
  FROM public.prod_price_lists
  WHERE id = v_cust.price_list_id AND company_id = v_company_id AND is_active;
  SELECT id INTO v_def_list
  FROM public.prod_price_lists
  WHERE company_id = v_company_id AND is_default AND is_active;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    v_price := public.prod_jnum(v_line, 'price', 2);
    v_disc := COALESCE(public.prod_jnum(v_line, 'discount_pct', 2), 0);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR (v_price IS NOT NULL AND v_price < 0)
       OR v_disc NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_prices := array_append(v_prices, v_price);
    v_discs := v_discs || v_disc;
    v_picks := array_append(v_picks, v_line->'lots');
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id IN (SELECT DISTINCT unnest(v_item_ids)))
     <> (SELECT count(DISTINCT x) FROM unnest(v_item_ids) AS t(x)) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Prices + amounts (server-side; see header "Pricing").
  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_price := v_prices[i];
    v_source := 'manual';
    IF v_price IS NULL AND v_sale_list IS NOT NULL THEN
      SELECT price INTO v_price FROM public.prod_price_list_items
      WHERE price_list_id = v_sale_list AND company_id = v_company_id AND item_id = v_item_ids[i];
      v_source := 'sale_list';
    END IF;
    IF v_price IS NULL AND v_cust_list IS NOT NULL THEN
      SELECT price INTO v_price FROM public.prod_price_list_items
      WHERE price_list_id = v_cust_list AND company_id = v_company_id AND item_id = v_item_ids[i];
      v_source := 'customer_list';
    END IF;
    IF v_price IS NULL AND v_def_list IS NOT NULL THEN
      SELECT price INTO v_price FROM public.prod_price_list_items
      WHERE price_list_id = v_def_list AND company_id = v_company_id AND item_id = v_item_ids[i];
      v_source := 'default_list';
    END IF;
    IF v_price IS NULL THEN
      SELECT sale_price INTO v_price FROM public.prod_items
      WHERE id = v_item_ids[i] AND company_id = v_company_id;
      v_source := 'item';
    END IF;
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'no_price';
    END IF;

    v_amount := round(v_qtys[i] * v_price * (1 - v_discs[i] / 100), 2);
    v_vat := round(v_amount * v_vat_rate / 100, 2);
    v_subtotal := v_subtotal + v_amount;
    v_vat_total := v_vat_total + v_vat;
    IF v_amount + v_vat >= 1e12 OR v_subtotal + v_vat_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_prices[i] := v_price;
    v_sources := v_sources || v_source;
    v_amounts := v_amounts || v_amount;
    v_vats := v_vats || v_vat;
  END LOOP;
  v_total := v_subtotal + v_vat_total;

  -- Credit limit (under the customer row lock).
  v_balance := public.prod_customer_balance(v_company_id, v_customer_id);
  IF v_cust.credit_limit IS NOT NULL AND v_balance + v_total > v_cust.credit_limit THEN
    IF v_enforce THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'credit_limit';
    END IF;
    v_warning := jsonb_build_object('limit', v_cust.credit_limit, 'balance_before', v_balance,
                                    'balance_after', v_balance + v_total);
  END IF;

  IF v_cust.payment_terms_days IS NOT NULL THEN
    v_due := (v_doc_date AT TIME ZONE 'Asia/Tashkent')::date + v_cust.payment_terms_days;
  END IF;

  -- Stock: all keys first (one warehouse, ascending item id), then consume.
  PERFORM public.prod_lock_stock(v_company_id, v_wh, v_item_ids);

  v_id := gen_random_uuid();

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_wh, v_item_ids[i], v_qtys[i],
                                 'sale', v_id, v_picks[i], 'strict');
    v_costs := v_costs || (v_res->>'cost')::numeric;
    v_lots := array_append(v_lots, v_res->'lots');
    v_cost_total := v_cost_total + (v_res->>'cost')::numeric;
    IF v_cost_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_sale_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_sales WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_sales (
    id, company_id, number, doc_date, customer_id, customer_name, warehouse_id, price_list_id,
    due_date, vat_rate, subtotal, vat_amount, total, cost_total, margin,
    vehicle_no, driver, note, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_customer_id, v_cust.name, v_wh,
    COALESCE(v_sale_list, v_cust_list, v_def_list),
    v_due, v_vat_rate, v_subtotal, v_vat_total, v_total, v_cost_total, v_subtotal - v_cost_total,
    v_vehicle, v_driver, v_note, 'posted', auth.uid(), v_user_name
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_sale_items (
      company_id, sale_id, sort_order, item_id, unit, qty, price, discount_pct, price_source,
      amount, vat_amount, total, cost, unit_cost, lots
    ) VALUES (
      v_company_id, v_id, i - 1, v_item_ids[i],
      (SELECT it.unit FROM public.prod_items it WHERE it.id = v_item_ids[i] AND it.company_id = v_company_id),
      v_qtys[i], v_prices[i], v_discs[i], v_sources[i],
      v_amounts[i], v_vats[i], v_amounts[i] + v_vats[i], v_costs[i], round(v_costs[i] / v_qtys[i], 2),
      COALESCE(v_lots[i], '[]'::jsonb)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number,
    'subtotal', v_subtotal, 'vat_amount', v_vat_total, 'total', v_total,
    'cost_total', v_cost_total, 'margin', v_subtotal - v_cost_total,
    'due_date', v_due,
    'credit_warning', v_warning
  );
END;
$$;

-- ═══ prod_create_sale_return (new) ═══════════════════════════════════════
-- prod_sales. p_data: { doc_date, sale_id, warehouse_id, reason, note,
--   items: [{ sale_item_id, qty, restock (default true) }] }
-- Rules: see header "Returns". The sale must be posted (invalid_input);
-- sale lines of THAT sale (else not_found), no duplicate line, 1..500
-- lines. warehouse_id default = the sale warehouse; when any line restocks
-- it must be an active warehouse of the company (prod_require_warehouse).
-- Lock order: sale row FOR UPDATE -> warehouse FOR SHARE ->
-- 'prod_sale_return_no' -> 'prod_lot_no'.
-- Returns { id, number, subtotal, vat_amount, total, cost_total, loss_cost }.
CREATE OR REPLACE FUNCTION public.prod_create_sale_return(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_sale_id uuid;
  v_sale record;
  v_wh uuid;
  v_reason text;
  v_note text;
  v_line jsonb;
  v_si_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_restocks boolean[] := '{}';
  v_any_restock boolean := false;
  v_si_id uuid;
  v_qty numeric;
  v_restock boolean;
  v_si record;
  v_done record;
  v_avail numeric;
  v_amount numeric;
  v_vat numeric;
  v_lot_ids uuid[];
  v_lot_av numeric[];
  v_lot_cost numeric[];
  v_take numeric[];
  v_sum_av numeric;
  v_left numeric;
  v_add numeric;
  v_pass integer;
  v_e record;
  v_line_cost numeric;
  v_line_lots jsonb;
  v_items_out jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_cost_total numeric := 0;
  v_loss numeric := 0;
  v_src record;
  v_new_lot uuid;
  v_out jsonb;
  v_lots_out jsonb;
  v_id uuid;
  v_number integer;
  i integer;
  k integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_doc_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());
  v_sale_id := public.prod_juuid(p_data, 'sale_id');
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_reason := public.prod_jtext(p_data, 'reason', 200);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_sale_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_si_id := public.prod_juuid(v_line, 'sale_item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    v_restock := COALESCE(public.prod_jbool(v_line, 'restock'), true);
    IF v_si_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_si_id = ANY (v_si_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_si_ids := v_si_ids || v_si_id;
    v_qtys := v_qtys || v_qty;
    v_restocks := v_restocks || v_restock;
    v_any_restock := v_any_restock OR v_restock;
  END LOOP;

  -- Sale row lock: serialises returns of this sale and its cancellation.
  SELECT s.id, s.status, s.customer_id, s.warehouse_id, s.vat_rate INTO v_sale
  FROM public.prod_sales s
  WHERE s.id = v_sale_id AND s.company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_sale.status <> 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_wh := COALESCE(v_wh, v_sale.warehouse_id);
  IF v_any_restock THEN
    PERFORM public.prod_require_warehouse(v_company_id, v_wh);
  ELSIF NOT EXISTS (SELECT 1 FROM public.prod_warehouses WHERE id = v_wh AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF (SELECT count(*) FROM public.prod_sale_items
      WHERE company_id = v_company_id AND sale_id = v_sale_id AND id = ANY (v_si_ids)) <> cardinality(v_si_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Plan every line (amounts, lot split) before writing anything.
  FOR i IN 1 .. cardinality(v_si_ids)
  LOOP
    SELECT si.id, si.item_id, si.unit, si.qty, si.price, si.discount_pct, si.amount, si.vat_amount, si.lots,
           it.unit AS cur_unit
    INTO v_si
    FROM public.prod_sale_items si
    JOIN public.prod_items it ON it.id = si.item_id AND it.company_id = si.company_id
    WHERE si.id = v_si_ids[i] AND si.company_id = v_company_id;

    SELECT COALESCE(sum(ri.qty), 0) AS qty, COALESCE(sum(ri.amount), 0) AS amount,
           COALESCE(sum(ri.vat_amount), 0) AS vat
    INTO v_done
    FROM public.prod_sale_return_items ri
    JOIN public.prod_sale_returns r ON r.id = ri.return_id AND r.company_id = ri.company_id
    WHERE ri.company_id = v_company_id AND ri.sale_item_id = v_si.id AND r.status = 'posted';

    v_avail := v_si.qty - v_done.qty;
    IF v_qtys[i] > v_avail THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
    END IF;

    IF v_restocks[i] AND v_si.cur_unit <> v_si.unit THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'unit_changed';
    END IF;

    -- Credit (capped by the uncredited rest; exact rest on completion).
    IF v_qtys[i] = v_avail THEN
      v_amount := v_si.amount - v_done.amount;
      v_vat := v_si.vat_amount - v_done.vat;
    ELSE
      v_amount := LEAST(round(v_qtys[i] * v_si.price * (1 - v_si.discount_pct / 100), 2), v_si.amount - v_done.amount);
      v_vat := LEAST(round(v_amount * v_sale.vat_rate / 100, 2), v_si.vat_amount - v_done.vat);
    END IF;
    v_amount := GREATEST(v_amount, 0);
    v_vat := GREATEST(v_vat, 0);

    -- Lot split: avail per original lot of this line.
    v_lot_ids := '{}';
    v_lot_av := '{}';
    v_lot_cost := '{}';
    v_sum_av := 0;
    FOR v_e IN
      SELECT (e.value->>'lot_id')::uuid AS lot_id,
             sum((e.value->>'qty')::numeric) AS qty,
             max((e.value->>'unit_cost')::numeric) AS unit_cost,
             min(e.ord) AS ord
      FROM jsonb_array_elements(v_si.lots) WITH ORDINALITY AS e(value, ord)
      GROUP BY 1
      ORDER BY min(e.ord)
    LOOP
      v_avail := v_e.qty - COALESCE((
        SELECT sum((x.value->>'qty')::numeric)
        FROM public.prod_sale_return_items ri
        JOIN public.prod_sale_returns r ON r.id = ri.return_id AND r.company_id = ri.company_id
        CROSS JOIN LATERAL jsonb_array_elements(ri.lots) AS x(value)
        WHERE ri.company_id = v_company_id AND ri.sale_item_id = v_si.id AND r.status = 'posted'
          AND (x.value->>'origin_lot_id')::uuid = v_e.lot_id
      ), 0);
      IF v_avail > 0 THEN
        v_lot_ids := v_lot_ids || v_e.lot_id;
        v_lot_av := v_lot_av || v_avail;
        v_lot_cost := v_lot_cost || v_e.unit_cost;
        v_sum_av := v_sum_av + v_avail;
      END IF;
    END LOOP;
    IF v_sum_av < v_qtys[i] THEN
      -- lots of the line disagree with its qty (cannot happen for lines
      -- written by prod_create_sale)
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
    END IF;

    v_take := '{}';
    v_left := v_qtys[i];
    FOR k IN 1 .. cardinality(v_lot_ids)
    LOOP
      v_take := v_take || trunc(v_qtys[i] * v_lot_av[k] / v_sum_av, 3);
      v_left := v_left - v_take[k];
    END LOOP;
    -- remainder (< 0.001 per lot): 0.001 at a time, lots in order, round robin
    v_pass := 0;
    WHILE v_left > 0 LOOP
      v_pass := v_pass + 1;
      IF v_pass > 1000 THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
      END IF;
      FOR k IN 1 .. cardinality(v_lot_ids)
      LOOP
        EXIT WHEN v_left <= 0;
        v_add := LEAST(v_left, 0.001, v_lot_av[k] - v_take[k]);
        v_take[k] := v_take[k] + v_add;
        v_left := v_left - v_add;
      END LOOP;
    END LOOP;
    IF v_left <> 0 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
    END IF;

    v_line_cost := 0;
    v_line_lots := '[]'::jsonb;
    FOR k IN 1 .. cardinality(v_lot_ids)
    LOOP
      CONTINUE WHEN v_take[k] <= 0;
      v_line_cost := v_line_cost + round(v_take[k] * v_lot_cost[k], 2);
      v_line_lots := v_line_lots || jsonb_build_array(jsonb_build_object(
        'origin_lot_id', v_lot_ids[k], 'qty', v_take[k], 'unit_cost', v_lot_cost[k]
      ));
    END LOOP;

    v_subtotal := v_subtotal + v_amount;
    v_vat_total := v_vat_total + v_vat;
    v_cost_total := v_cost_total + v_line_cost;
    IF NOT v_restocks[i] THEN
      v_loss := v_loss + v_line_cost;
    END IF;

    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_si.id, 'item_id', v_si.item_id, 'qty', v_qtys[i], 'restock', v_restocks[i],
      'price', v_si.price, 'discount_pct', v_si.discount_pct,
      'amount', v_amount, 'vat_amount', v_vat, 'cost', v_line_cost, 'lots', v_line_lots
    ));
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_sale_return_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_sale_returns WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  v_id := gen_random_uuid();
  INSERT INTO public.prod_sale_returns (
    id, company_id, number, doc_date, sale_id, customer_id, warehouse_id, reason, note,
    subtotal, vat_amount, total, cost_total, loss_cost, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_sale_id, v_sale.customer_id, v_wh, v_reason, v_note,
    v_subtotal, v_vat_total, v_subtotal + v_vat_total, v_cost_total, v_loss, 'posted', auth.uid(), v_user_name
  );

  -- Lines + restock lots ('prod_lot_no' is the last lock).
  i := 0;
  FOR v_out IN SELECT * FROM jsonb_array_elements(v_items_out)
  LOOP
    v_lots_out := '[]'::jsonb;
    FOR v_e IN SELECT * FROM jsonb_array_elements(v_out->'lots') AS x(value)
    LOOP
      v_new_lot := NULL;
      IF (v_out->>'restock')::boolean THEN
        SELECT l.id, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id, l.expiry_date, l.received_at
        INTO v_src
        FROM public.prod_lots l
        WHERE l.id = (v_e.value->>'origin_lot_id')::uuid AND l.company_id = v_company_id;
        v_new_lot := public.prod_add_lot(
          v_company_id, v_wh, (v_out->>'item_id')::uuid, (v_e.value->>'qty')::numeric, v_src.unit_cost,
          v_src.fat_pct, v_src.protein_pct, v_src.supplier_id, 'sale_return', v_id, v_src.id,
          v_src.expiry_date, v_src.received_at, NULL
        );
      END IF;
      v_lots_out := v_lots_out || jsonb_build_array(v_e.value || jsonb_build_object('lot_id', v_new_lot));
    END LOOP;

    INSERT INTO public.prod_sale_return_items (
      company_id, return_id, sale_item_id, item_id, sort_order, qty, restock, price, discount_pct,
      amount, vat_amount, total, cost, lots
    ) VALUES (
      v_company_id, v_id, (v_out->>'sale_item_id')::uuid, (v_out->>'item_id')::uuid, i,
      (v_out->>'qty')::numeric, (v_out->>'restock')::boolean, (v_out->>'price')::numeric,
      (v_out->>'discount_pct')::numeric, (v_out->>'amount')::numeric, (v_out->>'vat_amount')::numeric,
      (v_out->>'amount')::numeric + (v_out->>'vat_amount')::numeric, (v_out->>'cost')::numeric, v_lots_out
    );
    i := i + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number,
    'subtotal', v_subtotal, 'vat_amount', v_vat_total, 'total', v_subtotal + v_vat_total,
    'cost_total', v_cost_total, 'loss_cost', v_loss
  );
END;
$$;

-- ═══ prod_create_customer_payment (new) ══════════════════════════════════
-- prod_customer_payments. p_data: { customer_id, amount, method
-- ('cash'|'card'|'transfer', default 'cash'), pay_date (YYYY-MM-DD,
-- default = today in Asia/Tashkent), note }. amount > 0 (money actually
-- received). Overpayment allowed (advance). Inactive customers can pay.
-- Lock: customer row FOR KEY SHARE -> 'prod_customer_payment_no'.
-- Returns { id, number }.
CREATE OR REPLACE FUNCTION public.prod_create_customer_payment(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_customer_id uuid;
  v_amount numeric;
  v_method text;
  v_pay_date date;
  v_note text;
  v_id uuid;
  v_number integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_customer_payments') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_customer_id := public.prod_juuid(p_data, 'customer_id');
  v_amount := public.prod_jnum(p_data, 'amount', 2);
  v_method := COALESCE(public.prod_jtext(p_data, 'method', 20), 'cash');
  v_pay_date := COALESCE(public.prod_jdate(p_data, 'pay_date'), (now() AT TIME ZONE 'Asia/Tashkent')::date);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_customer_id IS NULL
     OR v_amount IS NULL OR v_amount <= 0
     OR v_method NOT IN ('cash', 'card', 'transfer') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM 1 FROM public.prod_customers
  WHERE id = v_customer_id AND company_id = v_company_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_customer_payment_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_customer_payments WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_customer_payments (
    company_id, number, customer_id, amount, method, pay_date, note,
    status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_customer_id, v_amount, v_method, v_pay_date, v_note,
    'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_cancel_customer_payment (new) ══════════════════════════════════
-- prod_customer_payments permission AND owner / admin role (same rule as
-- prod_cancel_supplier_payment). Row FOR UPDATE: a concurrent second cancel
-- waits, then gets 'already_cancelled'.
CREATE OR REPLACE FUNCTION public.prod_cancel_customer_payment(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_status text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_customer_payments') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT status INTO v_status
  FROM public.prod_customer_payments
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  UPDATE public.prod_customer_payments
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_cancel_document (replaced, same signature) ═════════════════════
-- Body copied from 20261110000014 (latest definition). Additions:
--   * 'sale' (prod_sales): a posted return -> invalid_input DETAIL
--     'has_returns'; a line whose item unit differs from the line's unit
--     snapshot -> invalid_input DETAIL 'unit_changed'. 1:1 reversal into the same lots.
--   * 'sale_return' (prod_sales): sale row FOR UPDATE BEFORE the return row
--     (same order as prod_create_sale_return). 1:1 reversal (restocked lots
--     must still hold their qty, else insufficient_stock).
-- Role (owner / admin), row lock, already_cancelled, reversal unchanged.
CREATE OR REPLACE FUNCTION public.prod_cancel_document(p_doc_type text, p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_key text;
  v_role text;
  v_status text;
  v_receipt_id uuid;
  v_corr_line uuid;
  v_corr_number integer;
  v_sale_id uuid;
BEGIN
  PERFORM public.assert_business_type('production');

  v_key := CASE p_doc_type
    WHEN 'receipt' THEN 'prod_receipts'
    WHEN 'production' THEN 'prod_production'
    WHEN 'processing' THEN 'prod_processing'
    WHEN 'transfer' THEN 'prod_stock'
    WHEN 'separation' THEN 'prod_production'
    WHEN 'writeoff' THEN 'prod_stock'
    WHEN 'stock_count' THEN 'prod_stock'
    WHEN 'opening_balance' THEN 'prod_stock'
    WHEN 'price_correction' THEN 'prod_receipts'
    WHEN 'sale' THEN 'prod_sales'
    WHEN 'sale_return' THEN 'prod_sales'
  END;
  IF v_key IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF NOT public.has_permission(v_key) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_doc_type = 'receipt' THEN
    SELECT status INTO v_status FROM public.prod_receipts
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'production' THEN
    SELECT status INTO v_status FROM public.prod_productions
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'processing' THEN
    SELECT status INTO v_status FROM public.prod_processings
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'separation' THEN
    SELECT status INTO v_status FROM public.prod_separations
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'writeoff' THEN
    SELECT status INTO v_status FROM public.prod_writeoffs
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'stock_count' THEN
    SELECT status INTO v_status FROM public.prod_stock_counts
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'opening_balance' THEN
    SELECT status INTO v_status FROM public.prod_openings
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'price_correction' THEN
    -- receipt_id is immutable: read it unlocked, lock the receipt, then the
    -- correction.
    SELECT receipt_id INTO v_receipt_id FROM public.prod_price_corrections
    WHERE id = p_id AND company_id = v_company_id;
    IF v_receipt_id IS NOT NULL THEN
      PERFORM 1 FROM public.prod_receipts
      WHERE id = v_receipt_id AND company_id = v_company_id FOR UPDATE;
    END IF;
    SELECT status, receipt_item_id, number INTO v_status, v_corr_line, v_corr_number
    FROM public.prod_price_corrections
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'sale' THEN
    SELECT status INTO v_status FROM public.prod_sales
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'sale_return' THEN
    -- sale_id is immutable: read it unlocked, lock the sale, then the return.
    SELECT sale_id INTO v_sale_id FROM public.prod_sale_returns
    WHERE id = p_id AND company_id = v_company_id;
    IF v_sale_id IS NOT NULL THEN
      PERFORM 1 FROM public.prod_sales
      WHERE id = v_sale_id AND company_id = v_company_id FOR UPDATE;
    END IF;
    SELECT status INTO v_status FROM public.prod_sale_returns
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSE
    SELECT status INTO v_status FROM public.prod_transfers
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  END IF;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF p_doc_type = 'stock_count' AND v_status <> 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_doc_type = 'receipt' AND EXISTS (
    SELECT 1 FROM public.prod_milk_intakes
    WHERE company_id = v_company_id AND receipt_id = p_id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_doc_type = 'receipt' AND EXISTS (
    SELECT 1 FROM public.prod_price_corrections
    WHERE company_id = v_company_id AND receipt_id = p_id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'has_price_correction';
  END IF;

  IF p_doc_type = 'price_correction' THEN
    IF EXISTS (
      SELECT 1 FROM public.prod_price_corrections c
      WHERE c.company_id = v_company_id AND c.receipt_item_id = v_corr_line
        AND c.status = 'posted' AND c.number > v_corr_number
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'not_latest';
    END IF;
  END IF;

  IF p_doc_type = 'sale' THEN
    IF EXISTS (
      SELECT 1 FROM public.prod_sale_returns
      WHERE company_id = v_company_id AND sale_id = p_id AND status = 'posted'
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'has_returns';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.prod_sale_items si
      JOIN public.prod_items it ON it.id = si.item_id AND it.company_id = si.company_id
      WHERE si.company_id = v_company_id AND si.sale_id = p_id AND it.unit <> si.unit
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'unit_changed';
    END IF;
  END IF;

  PERFORM public.prod_reverse_document(v_company_id, p_doc_type, p_id);

  IF p_doc_type = 'receipt' THEN
    UPDATE public.prod_receipts
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'production' THEN
    UPDATE public.prod_productions
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'processing' THEN
    UPDATE public.prod_processings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'separation' THEN
    UPDATE public.prod_separations
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'writeoff' THEN
    UPDATE public.prod_writeoffs
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'stock_count' THEN
    UPDATE public.prod_stock_counts
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), updated_at = now()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'opening_balance' THEN
    UPDATE public.prod_openings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'price_correction' THEN
    UPDATE public.prod_price_corrections
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'sale' THEN
    UPDATE public.prod_sales
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'sale_return' THEN
    UPDATE public.prod_sale_returns
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSE
    UPDATE public.prod_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated.

REVOKE EXECUTE ON FUNCTION public.prod_save_price_list(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_customer(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_sale(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_sale_return(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_customer_payment(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_customer_payment(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_price_list(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_customer(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_sale(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_sale_return(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_customer_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_customer_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on every new table:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_price_lists', 'prod_price_list_items', 'prod_customers', 'prod_sales',
--                     'prod_sale_items', 'prod_sale_returns', 'prod_sale_return_items', 'prod_customer_payments')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_price_lists', 'prod_price_list_items', 'prod_customers', 'prod_sales',
--                      'prod_sale_items', 'prod_sale_returns', 'prod_sale_return_items', 'prod_customer_payments',
--                      'prod_item_prices', 'prod_customer_balances', 'prod_customer_ageing',
--                      'prod_sales_lines_v', 'prod_sale_item_returnable');
-- -- ageing balance = balances balance (expect 0 rows):
-- SELECT a.customer_id FROM public.prod_customer_ageing a
-- JOIN public.prod_customer_balances b ON b.customer_id = a.customer_id WHERE a.balance <> b.balance;
