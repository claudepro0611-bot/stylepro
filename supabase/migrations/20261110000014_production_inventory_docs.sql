-- Production wave A: inventory documents & master-data fixes.
--
-- Why: the lot ledger (20261110000013) made stock exact, but the plant still
-- could not (a) write off spoiled / expired milk, (b) post a physical count
-- (inventarizatsiya), (c) enter opening balances as real lots, (d) correct a
-- wrong purchase price after posting, (e) quarantine a lot, (f) fix a lab
-- result, and master data had gaps (deactivating a warehouse that still holds
-- stock, case-variant duplicate names, no recipe history, no standard cost /
-- sale price / expiry warning, no supplier payment terms / ageing).
--
-- This file adds / changes:
--   1) prod_writeoffs (+ items)            doc_type 'writeoff'
--   2) prod_stock_counts (+ items)         doc_type 'stock_count' (draft -> posted)
--   3) prod_openings (+ items)             doc_type 'opening_balance'
--   4) prod_price_corrections              doc_type 'price_correction'
--   5) prod_lots.hold_status / hold_reason / hold_at / hold_by + prod_set_lot_hold
--   6) prod_amend_milk_lab                 lab re-entry with re-pricing
--   7) prod_save_warehouse                 refuses deactivation with stock
--   8) duplicate names / sku / barcode     RPC checks (+ unique indexes when
--                                          live data has no duplicates)
--   9) prod_recipe_versions                history of every recipe version
--  10) prod_items.standard_cost / sale_price / expiry_warn_days
--  11) prod_suppliers.payment_terms_days, prod_receipts.due_date (trigger),
--      view prod_supplier_ageing
--  12) doc_type CHECKs extended; prod_cancel_document handles the new types
--
-- Objects:
--   NEW tables:  prod_writeoffs, prod_writeoff_items, prod_stock_counts,
--                prod_stock_count_items, prod_openings, prod_opening_items,
--                prod_price_corrections, prod_recipe_versions
--   NEW views:   prod_supplier_ageing
--   REPLACED views (same columns, new ones appended at the END only):
--                prod_lot_stock (+ hold_status, hold_reason, hold_at, hold_by),
--                prod_supplier_balances (identical columns; purchased / debt
--                now include posted price corrections)
--   NEW internal helpers (EXECUTE revoked from every client role):
--                prod_consume(..., p_hold_mode text)  (8-arg overload),
--                prod_recipe_snapshot, prod_receipts_due_date (trigger fn)
--   REPLACED internal helpers (same signatures):
--                prod_consume (7-arg: now a wrapper = hold mode 'strict'),
--                prod_require_warehouse (now VOLATILE + FOR SHARE),
--                prod_cancel_receipt_internal (+ price-correction guard)
--   NEW RPCs:    prod_create_writeoff, prod_save_stock_count,
--                prod_post_stock_count, prod_delete_stock_count_draft,
--                prod_create_opening, prod_create_price_correction,
--                prod_set_lot_hold, prod_amend_milk_lab
--   REPLACED RPCs (same signatures, same return shapes, optional keys only):
--                prod_save_item       (latest = 13)  + standard_cost,
--                                     sale_price, expiry_warn_days, duplicates
--                prod_save_supplier   (latest = 10)  + payment_terms_days,
--                                     duplicates
--                prod_save_warehouse  (latest = 04)  + stock guard
--                prod_save_recipe     (latest = 08)  + version snapshot
--                prod_create_transfer (latest = 13)  + held lots by pick,
--                                     hold copied to destination lots
--                prod_change_item_unit (latest = 13) + hold copied, version
--                                     snapshots
--                prod_cancel_document (latest = 13)  + new doc types, guards
--   NOT replaced (unchanged, still correct): prod_create_receipt,
--     prod_milk_apply_lab (due_date comes from the prod_receipts trigger),
--     prod_create_production / processing / separation (they call the 7-arg
--     prod_consume = strict hold mode), prod_reverse_document, prod_add_lot.
--
-- ── Hold handling (prod_consume p_hold_mode) ──────────────────────────────
--   'strict' (production, processing, separation; the 7-arg wrapper):
--      FEFO uses free lots only; a manual pick of a non-free lot ->
--      invalid_input DETAIL 'lot_on_hold'. Not enough FREE stock ->
--      insufficient_stock (DETAIL item id, unchanged contract).
--   'pick'   (transfer): FEFO free lots only, but an explicit manual pick
--      may move a held / blocked lot (e.g. to a quarantine warehouse); the
--      destination lot copies hold_status / reason / at / by.
--   'any'    (write-off, stock-count shortage): FEFO takes free lots first,
--      then held / blocked ones (same FEFO order inside each group); picks
--      of any status allowed.
--   prod_set_lot_hold takes the lot's stock key, so it serialises with every
--   consumer of that key (they read hold_status under the same key).
--   Lots created from another lot (transfer, unit change, price correction)
--   inherit its hold; all other new lots start 'free'.
--
-- ── Price correction accounting ───────────────────────────────────────────
--   Input: receipt_id + (receipt_item_id or item_id) + new_price.
--   old_price = effective price of the line = new_price of the LATEST posted
--   correction of that line, else the line price (chain). qty = line qty.
--   (a) debt_delta = round((new_price - old_price) * qty, 2), stored on the
--       doc. Supplier debt = posted receipts total + posted corrections'
--       debt_delta of posted receipts: prod_supplier_balances (purchased /
--       debt) and prod_supplier_ageing include it. The akt-sverka page reads
--       tables directly, so it must ALSO read prod_price_corrections
--       (supplier_id, doc_date, number, debt_delta, status = 'posted'):
--       debt_delta > 0 = kredit, < 0 = debet.
--   (b) every lot of the line still in the receipt warehouse with remaining
--       > 0 (the receipt lot and the lots created by earlier posted
--       corrections of the line) is revalued: outflow of its remaining at
--       its own cost + a new lot (qty = remaining, unit_cost = new_price,
--       same fat / protein / supplier / expiry / received_at / hold,
--       origin_lot_id = old lot). stock_qty = sum moved, stock_delta = value
--       change of the moved stock.
--   (c) consumed_qty = qty - stock_qty (everything that left the receipt
--       lot: consumed, written off, transferred, converted);
--       consumed_variance = round((new_price - old_price) * consumed_qty, 2),
--       stored only (NOT pushed into downstream documents / lots).
--   Legacy receipts (posted before 13, no lot): stock_qty = 0, everything
--   counts as consumed_variance.
--   Cancel (prod_cancel_document): only the LATEST posted correction of a
--   line (else invalid_input DETAIL 'not_latest'); 1:1 reversal (new lots
--   must still hold their qty, else insufficient_stock). A receipt with a
--   posted correction cannot be cancelled (prod_cancel_document /
--   prod_cancel_milk_intake / prod_amend_milk_lab -> invalid_input DETAIL
--   'has_price_correction'): cancel the corrections first.
--
-- ── Supplier ageing (prod_supplier_ageing) ────────────────────────────────
--   Charges = posted receipts with a supplier, amount = total + posted
--   corrections of that receipt, due = due_date, else the receipt's business
--   date (Asia/Tashkent; i.e. no terms = due immediately). Posted payments
--   (sum) are allocated FIFO to the oldest receipts (doc_date, number, id):
--   open(i) = clamp(cum_amount(i) - paid, 0, amount(i)). Buckets by
--   days_overdue = today (Tashkent) - due: <= 0 not_due, 1..15, 16..30, 31+.
--   balance = charges - paid (= prod_supplier_balances.debt; negative =
--   advance, then every bucket is 0).
--   due_date is set by the BEFORE INSERT trigger prod_receipts_set_due_date
--   for EVERY receipt writer (prod_create_receipt, milk intake lab):
--   business date of doc_date + supplier.payment_terms_days (when not NULL).
--   Existing receipts keep due_date NULL.
--
-- ── Lot ageing / FIFO note ────────────────────────────────────────────────
--   New lots of a stock-count surplus / opening balance get received_at =
--   document date (FEFO age = that date); revaluation / transfer lots keep the
--   source lot's received_at.
--
-- ── Lock order (unchanged global order, see 13) ───────────────────────────
--   catalog save locks 'prod_item_save:<co>' / 'prod_supplier_save:<co>'
--     (only taken by prod_save_item / prod_save_supplier) -> item / supplier
--     row FOR UPDATE; nothing else is taken after them.
--   document row FOR UPDATE (receipt row BEFORE a price-correction row; milk
--     intake row before its receipt row) -> warehouse row FOR SHARE
--     (prod_require_warehouse) -> stock keys in ascending (item_id,
--     warehouse_id) -> document-number lock -> 'prod_lot_no' (always last).
--   prod_save_warehouse: warehouse row FOR NO KEY UPDATE, then reads lots
--     (no other lock). FOR SHARE (document writers) and FOR NO KEY UPDATE
--     conflict, so a deactivation waits for in-flight documents of that
--     warehouse and they wait for it; FK checks (KEY SHARE) do not conflict.
--     Cancellation reversals do not call prod_require_warehouse and can still
--     return stock into an inactive warehouse (by design: a cancel must work).
--
-- ── Duplicates (item 8) ───────────────────────────────────────────────────
--   Live data could NOT be inspected when this file was written. The unique
--   indexes are created inside a DO block ONLY when no duplicate exists for
--   that key; otherwise the duplicates are RAISE NOTICEd and only the RPC
--   check applies (existing duplicates stay editable: the check runs only
--   for new rows and for CHANGED name / sku / barcode). Error: 'duplicate'
--   with DETAIL 'name' | 'sku' | 'barcode' (was 'duplicate_name').
--
-- ── Destructive / blocking statements ─────────────────────────────────────
--   WARNING: prod_stock_movements_doc_type_check and
--   prod_lots_source_doc_type_check are DROPped and re-ADDed (same names,
--   strictly wider sets). No data changed or lost; the re-ADD re-validates
--   existing rows under an ACCESS EXCLUSIVE lock on the ledger / lots until
--   COMMIT (production writes wait for the migration).
--   Everything else: CREATE TABLE / VIEW / INDEX / TRIGGER, ADD COLUMN NULL
--   or with a constant default (metadata-only), ADD CONSTRAINT on new
--   columns, CREATE OR REPLACE FUNCTION / VIEW. No row is deleted or
--   rewritten (the only DML is the prod_recipe_versions backfill INSERT).
--
-- Client deploy: NOT required for safety. Every replaced signature / return
-- shape is unchanged, every new input key is optional. Behaviour changes old
-- clients will see: 'duplicate' (+ DETAIL) instead of 'duplicate_name' from
-- prod_save_item / prod_save_supplier (shown as the generic error until the
-- client maps it), and invalid_input with DETAIL for the new guards.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) Columns on existing tables ────────────────────────────────────────

-- 10) item master fields
ALTER TABLE public.prod_items
  ADD COLUMN standard_cost numeric(14,2) NULL,
  ADD COLUMN sale_price numeric(14,2) NULL,
  ADD COLUMN expiry_warn_days integer NULL;

ALTER TABLE public.prod_items
  ADD CONSTRAINT prod_items_standard_cost_check CHECK (standard_cost IS NULL OR standard_cost >= 0),
  ADD CONSTRAINT prod_items_sale_price_check CHECK (sale_price IS NULL OR sale_price >= 0),
  ADD CONSTRAINT prod_items_expiry_warn_check CHECK (expiry_warn_days IS NULL OR expiry_warn_days BETWEEN 1 AND 365);

-- 11) supplier payment terms + receipt due date
ALTER TABLE public.prod_suppliers
  ADD COLUMN payment_terms_days integer NULL;

ALTER TABLE public.prod_suppliers
  ADD CONSTRAINT prod_suppliers_payment_terms_check
    CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365);

ALTER TABLE public.prod_receipts
  ADD COLUMN due_date date NULL;

CREATE INDEX prod_receipts_supplier_due_idx
  ON public.prod_receipts (company_id, supplier_id, doc_date)
  WHERE supplier_id IS NOT NULL AND status = 'posted';

-- 5) lot hold. Constant default: metadata-only, no rewrite.
ALTER TABLE public.prod_lots
  ADD COLUMN hold_status text NOT NULL DEFAULT 'free',
  ADD COLUMN hold_reason text NULL,
  ADD COLUMN hold_at timestamptz NULL,
  ADD COLUMN hold_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.prod_lots
  ADD CONSTRAINT prod_lots_hold_status_check CHECK (hold_status IN ('free', 'hold', 'blocked')),
  ADD CONSTRAINT prod_lots_hold_reason_check CHECK (hold_reason IS NULL OR length(hold_reason) <= 500);

CREATE INDEX prod_lots_held_idx ON public.prod_lots (company_id, warehouse_id, item_id)
  WHERE hold_status <> 'free';

-- 6) lab amend bookkeeping
ALTER TABLE public.prod_milk_intakes
  ADD COLUMN lab_amended_at timestamptz NULL,
  ADD COLUMN lab_amend_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.prod_milk_intakes
  ADD CONSTRAINT prod_milk_intakes_lab_amend_check CHECK (lab_amend_count >= 0);

-- 12) doc types. WARNING: DROP + re-ADD (see header).
ALTER TABLE public.prod_stock_movements
  DROP CONSTRAINT prod_stock_movements_doc_type_check;
ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_doc_type_check
  CHECK (doc_type IN ('receipt', 'production', 'processing', 'transfer', 'conversion', 'separation',
                      'writeoff', 'stock_count', 'opening_balance', 'price_correction'));

ALTER TABLE public.prod_lots
  DROP CONSTRAINT prod_lots_source_doc_type_check;
ALTER TABLE public.prod_lots
  ADD CONSTRAINT prod_lots_source_doc_type_check CHECK (
    source_doc_type IS NULL OR source_doc_type IN (
      'opening', 'receipt', 'production', 'processing', 'transfer', 'conversion',
      'separation', 'legacy_reversal',
      'writeoff', 'stock_count', 'opening_balance', 'price_correction'
    )
  );

-- ─── 2) New tables ────────────────────────────────────────────────────────
-- Access model for ALL of them (same as 03..13): company_id NOT NULL ->
-- companies ON DELETE CASCADE; RLS on with ONE company-scoped SELECT policy;
-- REVOKE ALL from authenticated + anon (default-grant leak), GRANT SELECT to
-- authenticated. Writes ONLY via the SECURITY DEFINER RPCs below.

-- 1) Write-off (spisaniya)
CREATE TABLE public.prod_writeoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NOT NULL,
  reason text NOT NULL,
  note text NULL,
  total_cost numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_writeoffs_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_writeoffs_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_writeoffs_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_writeoffs_number_check CHECK (number > 0),
  CONSTRAINT prod_writeoffs_reason_check CHECK (reason IN ('spoiled', 'expired', 'damaged', 'lab_reject', 'sample', 'other')),
  CONSTRAINT prod_writeoffs_total_check CHECK (total_cost >= 0),
  CONSTRAINT prod_writeoffs_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_writeoffs_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_writeoffs_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_writeoffs IS
  'Production write-offs (spisaniya). Read via RLS; write ONLY via prod_create_writeoff / prod_cancel_document.';

CREATE INDEX prod_writeoffs_company_date_idx ON public.prod_writeoffs (company_id, doc_date DESC);
CREATE INDEX prod_writeoffs_warehouse_idx ON public.prod_writeoffs (warehouse_id, company_id);

CREATE TABLE public.prod_writeoff_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  writeoff_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  CONSTRAINT prod_writeoff_items_writeoff_fk FOREIGN KEY (writeoff_id, company_id)
    REFERENCES public.prod_writeoffs (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_writeoff_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_writeoff_items_writeoff_item_key UNIQUE (writeoff_id, item_id),
  CONSTRAINT prod_writeoff_items_qty_check CHECK (qty > 0),
  CONSTRAINT prod_writeoff_items_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT prod_writeoff_items_total_check CHECK (total >= 0)
);

COMMENT ON TABLE public.prod_writeoff_items IS
  'Lines of a production write-off (unit_cost = round(line cost / qty, 2), total = exact lot cost). '
  'Read via RLS; write ONLY via prod_create_writeoff.';

CREATE INDEX prod_writeoff_items_writeoff_idx ON public.prod_writeoff_items (writeoff_id, company_id);
CREATE INDEX prod_writeoff_items_item_idx ON public.prod_writeoff_items (item_id, company_id);

-- 2) Stock count (inventarizatsiya). posted_at is set once (cancel keeps it).
CREATE TABLE public.prod_stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NOT NULL,
  note text NULL,
  status text NOT NULL DEFAULT 'draft',
  shortage_value numeric(14,2) NOT NULL DEFAULT 0,
  surplus_value numeric(14,2) NOT NULL DEFAULT 0,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz NULL,
  posted_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  posted_by_name text NULL,
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_stock_counts_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_stock_counts_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_stock_counts_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_stock_counts_number_check CHECK (number > 0),
  CONSTRAINT prod_stock_counts_values_check CHECK (shortage_value >= 0 AND surplus_value >= 0),
  CONSTRAINT prod_stock_counts_status_check CHECK (status IN ('draft', 'posted', 'cancelled')),
  CONSTRAINT prod_stock_counts_posted_check CHECK ((status = 'draft') = (posted_at IS NULL)),
  CONSTRAINT prod_stock_counts_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_stock_counts_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_stock_counts IS
  'Production stock counts (inventarizatsiya): draft -> posted -> (cancelled). Read via RLS; write ONLY via '
  'prod_save_stock_count / prod_post_stock_count / prod_delete_stock_count_draft / prod_cancel_document.';

CREATE INDEX prod_stock_counts_company_date_idx ON public.prod_stock_counts (company_id, doc_date DESC);
CREATE INDEX prod_stock_counts_warehouse_idx ON public.prod_stock_counts (warehouse_id, company_id);

-- system_qty / diff_qty / diff_value are NULL until posted. unit_cost: input
-- (optional surplus valuation) on a draft, the cost actually used after posting.
CREATE TABLE public.prod_stock_count_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  count_id uuid NOT NULL,
  item_id uuid NOT NULL,
  counted_qty numeric(14,3) NOT NULL,
  system_qty numeric(14,3) NULL,
  diff_qty numeric(14,3) NULL,
  unit_cost numeric(14,2) NULL,
  diff_value numeric(14,2) NULL,
  CONSTRAINT prod_stock_count_items_count_fk FOREIGN KEY (count_id, company_id)
    REFERENCES public.prod_stock_counts (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_stock_count_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_stock_count_items_count_item_key UNIQUE (count_id, item_id),
  CONSTRAINT prod_stock_count_items_counted_check CHECK (counted_qty >= 0),
  CONSTRAINT prod_stock_count_items_unit_cost_check CHECK (unit_cost IS NULL OR unit_cost >= 0)
);

COMMENT ON TABLE public.prod_stock_count_items IS
  'Lines of a production stock count. Read via RLS; write ONLY via prod_save_stock_count / prod_post_stock_count.';

CREATE INDEX prod_stock_count_items_count_idx ON public.prod_stock_count_items (count_id, company_id);
CREATE INDEX prod_stock_count_items_item_idx ON public.prod_stock_count_items (item_id, company_id);

-- 3) Opening balance documents (NOT the 13 backfill 'opening' lots).
CREATE TABLE public.prod_openings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NOT NULL,
  note text NULL,
  total numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_openings_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_openings_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_openings_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_openings_number_check CHECK (number > 0),
  CONSTRAINT prod_openings_total_check CHECK (total >= 0),
  CONSTRAINT prod_openings_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_openings_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_openings_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_openings IS
  'Production opening-balance documents (each line = one lot). Read via RLS; write ONLY via '
  'prod_create_opening / prod_cancel_document.';

CREATE INDEX prod_openings_company_date_idx ON public.prod_openings (company_id, doc_date DESC);

CREATE TABLE public.prod_opening_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  opening_id uuid NOT NULL,
  item_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  qty numeric(14,3) NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  fat_pct numeric(6,3) NULL,
  protein_pct numeric(6,3) NULL,
  expiry_date date NULL,
  supplier_id uuid NULL,
  CONSTRAINT prod_opening_items_opening_fk FOREIGN KEY (opening_id, company_id)
    REFERENCES public.prod_openings (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_opening_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_opening_items_lot_fk FOREIGN KEY (lot_id, company_id)
    REFERENCES public.prod_lots (id, company_id),
  CONSTRAINT prod_opening_items_supplier_fk FOREIGN KEY (supplier_id, company_id)
    REFERENCES public.prod_suppliers (id, company_id),
  CONSTRAINT prod_opening_items_qty_check CHECK (qty > 0),
  CONSTRAINT prod_opening_items_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT prod_opening_items_total_check CHECK (total >= 0),
  CONSTRAINT prod_opening_items_fat_check CHECK (fat_pct IS NULL OR fat_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_opening_items_protein_check CHECK (protein_pct IS NULL OR protein_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_opening_items_sort_check CHECK (sort_order >= 0)
);

COMMENT ON TABLE public.prod_opening_items IS
  'Lines of a production opening-balance document (lot_id = the lot it created). Read via RLS; '
  'write ONLY via prod_create_opening.';

CREATE INDEX prod_opening_items_opening_idx ON public.prod_opening_items (opening_id, company_id);
CREATE INDEX prod_opening_items_item_idx ON public.prod_opening_items (item_id, company_id);
CREATE INDEX prod_opening_items_lot_idx ON public.prod_opening_items (lot_id, company_id);
CREATE INDEX prod_opening_items_supplier_idx ON public.prod_opening_items (supplier_id, company_id)
  WHERE supplier_id IS NOT NULL;

-- 4) Price corrections. lots = [{old_lot_id, new_lot_id, qty, old_unit_cost}].
CREATE TABLE public.prod_price_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  receipt_id uuid NOT NULL,
  receipt_item_id uuid NOT NULL REFERENCES public.prod_receipt_items(id),
  item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  supplier_id uuid NULL,
  qty numeric(14,3) NOT NULL,
  old_price numeric(14,2) NOT NULL,
  new_price numeric(14,2) NOT NULL,
  debt_delta numeric(14,2) NOT NULL,
  stock_qty numeric(14,3) NOT NULL DEFAULT 0,
  stock_delta numeric(14,2) NOT NULL DEFAULT 0,
  consumed_qty numeric(14,3) NOT NULL DEFAULT 0,
  consumed_variance numeric(14,2) NOT NULL DEFAULT 0,
  lots jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_price_corrections_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_price_corrections_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_price_corrections_receipt_fk FOREIGN KEY (receipt_id, company_id)
    REFERENCES public.prod_receipts (id, company_id),
  CONSTRAINT prod_price_corrections_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_price_corrections_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_price_corrections_supplier_fk FOREIGN KEY (supplier_id, company_id)
    REFERENCES public.prod_suppliers (id, company_id),
  CONSTRAINT prod_price_corrections_number_check CHECK (number > 0),
  CONSTRAINT prod_price_corrections_qty_check CHECK (qty > 0),
  CONSTRAINT prod_price_corrections_price_check CHECK (old_price >= 0 AND new_price >= 0 AND new_price <> old_price),
  CONSTRAINT prod_price_corrections_split_check CHECK (stock_qty >= 0 AND consumed_qty >= 0),
  CONSTRAINT prod_price_corrections_lots_check CHECK (jsonb_typeof(lots) = 'array'),
  CONSTRAINT prod_price_corrections_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_price_corrections_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_price_corrections_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_price_corrections IS
  'Purchase price corrections of a receipt line. debt_delta (posted) is part of the supplier debt; '
  'consumed_variance is informational. Read via RLS; write ONLY via prod_create_price_correction / '
  'prod_cancel_document.';

CREATE INDEX prod_price_corrections_receipt_idx ON public.prod_price_corrections (receipt_id, company_id);
CREATE INDEX prod_price_corrections_line_idx ON public.prod_price_corrections (receipt_item_id, number DESC);
CREATE INDEX prod_price_corrections_supplier_idx ON public.prod_price_corrections (supplier_id, company_id)
  WHERE supplier_id IS NOT NULL;
CREATE INDEX prod_price_corrections_company_date_idx ON public.prod_price_corrections (company_id, doc_date DESC);

-- 9) Recipe versions (append-only in practice: written by RPCs only).
CREATE TABLE public.prod_recipe_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL,
  version integer NOT NULL,
  output_item_id uuid NOT NULL,
  output_qty numeric(14,4) NOT NULL,
  lines jsonb NOT NULL,
  is_active boolean NULL,
  note text NULL,
  saved_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  saved_by_name text NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_recipe_versions_recipe_version_key UNIQUE (recipe_id, version),
  CONSTRAINT prod_recipe_versions_recipe_fk FOREIGN KEY (recipe_id, company_id)
    REFERENCES public.prod_recipes (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_recipe_versions_item_fk FOREIGN KEY (output_item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_recipe_versions_version_check CHECK (version >= 1),
  CONSTRAINT prod_recipe_versions_output_qty_check CHECK (output_qty > 0),
  CONSTRAINT prod_recipe_versions_lines_check CHECK (jsonb_typeof(lines) = 'array')
);

COMMENT ON TABLE public.prod_recipe_versions IS
  'Snapshot of every saved recipe version: lines = [{item_id, qty, sort_order, note}]. Read via RLS; '
  'write ONLY via prod_save_recipe / prod_change_item_unit.';

CREATE INDEX prod_recipe_versions_recipe_idx ON public.prod_recipe_versions (recipe_id, company_id);
CREATE INDEX prod_recipe_versions_item_idx ON public.prod_recipe_versions (output_item_id, company_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'prod_writeoffs', 'prod_writeoff_items', 'prod_stock_counts', 'prod_stock_count_items',
    'prod_openings', 'prod_opening_items', 'prod_price_corrections', 'prod_recipe_versions'
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

-- ─── 3) Duplicate guards (item 8) ─────────────────────────────────────────
-- Unique indexes only for keys without live duplicates (see header).

DO $$
DECLARE
  v_dups text;
BEGIN
  SELECT string_agg(format('%s:%s(x%s)', company_id, k, n), ', ') INTO v_dups
  FROM (SELECT company_id, lower(btrim(name)) AS k, count(*) AS n FROM public.prod_items
        GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dups IS NULL THEN
    CREATE UNIQUE INDEX prod_items_company_name_ci_key ON public.prod_items (company_id, lower(btrim(name)));
  ELSE
    RAISE NOTICE 'prod_items: case-insensitive duplicate names, unique index NOT created: %', v_dups;
    CREATE INDEX prod_items_company_name_ci_idx ON public.prod_items (company_id, lower(btrim(name)));
  END IF;

  SELECT string_agg(format('%s:%s(x%s)', company_id, sku, n), ', ') INTO v_dups
  FROM (SELECT company_id, sku, count(*) AS n FROM public.prod_items
        WHERE sku IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dups IS NULL THEN
    CREATE UNIQUE INDEX prod_items_company_sku_key ON public.prod_items (company_id, sku) WHERE sku IS NOT NULL;
  ELSE
    RAISE NOTICE 'prod_items: duplicate sku, unique index NOT created: %', v_dups;
  END IF;

  SELECT string_agg(format('%s:%s(x%s)', company_id, barcode, n), ', ') INTO v_dups
  FROM (SELECT company_id, barcode, count(*) AS n FROM public.prod_items
        WHERE barcode IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dups IS NULL THEN
    CREATE UNIQUE INDEX prod_items_company_barcode_key ON public.prod_items (company_id, barcode) WHERE barcode IS NOT NULL;
  ELSE
    RAISE NOTICE 'prod_items: duplicate barcode, unique index NOT created: %', v_dups;
  END IF;

  SELECT string_agg(format('%s:%s(x%s)', company_id, k, n), ', ') INTO v_dups
  FROM (SELECT company_id, lower(btrim(name)) AS k, count(*) AS n FROM public.prod_suppliers
        GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dups IS NULL THEN
    CREATE UNIQUE INDEX prod_suppliers_company_name_ci_key ON public.prod_suppliers (company_id, lower(btrim(name)));
  ELSE
    RAISE NOTICE 'prod_suppliers: case-insensitive duplicate names, unique index NOT created: %', v_dups;
    CREATE INDEX prod_suppliers_company_name_ci_idx ON public.prod_suppliers (company_id, lower(btrim(name)));
  END IF;
END;
$$;

-- ─── 4) Receipt due date trigger (item 11) ────────────────────────────────
-- Fires for every receipt writer. Explicit due_date (none today) is kept.
CREATE OR REPLACE FUNCTION public.prod_receipts_due_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_terms integer;
BEGIN
  IF NEW.due_date IS NULL AND NEW.supplier_id IS NOT NULL THEN
    SELECT s.payment_terms_days INTO v_terms
    FROM public.prod_suppliers s
    WHERE s.id = NEW.supplier_id AND s.company_id = NEW.company_id;
    IF v_terms IS NOT NULL THEN
      NEW.due_date := (NEW.doc_date AT TIME ZONE 'Asia/Tashkent')::date + v_terms;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_receipts_due_date() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prod_receipts_set_due_date
  BEFORE INSERT ON public.prod_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prod_receipts_due_date();

-- ─── 5) Views ─────────────────────────────────────────────────────────────

-- prod_lot_stock: body of 13 unchanged, hold columns APPENDED (CREATE OR
-- REPLACE may only add columns at the end; prod_stock / prod_stock_quality
-- depend on it and are untouched).
CREATE OR REPLACE VIEW public.prod_lot_stock
WITH (security_invoker = true)
AS
SELECT
  l.id,
  l.company_id,
  l.warehouse_id,
  w.name AS warehouse_name,
  l.item_id,
  i.name AS item_name,
  i.unit AS item_unit,
  l.lot_no,
  l.received_at,
  l.opening_qty,
  l.unit_cost,
  l.fat_pct,
  l.protein_pct,
  l.supplier_id,
  s.name AS supplier_name,
  l.source_doc_type,
  l.source_doc_id,
  l.origin_lot_id,
  l.expiry_date,
  l.is_opening,
  l.created_at,
  (l.opening_qty + COALESCE(m.qty, 0)) AS remaining_qty,
  round((l.opening_qty + COALESCE(m.qty, 0)) * l.unit_cost, 2) AS value,
  l.hold_status,
  l.hold_reason,
  l.hold_at,
  l.hold_by
FROM public.prod_lots l
LEFT JOIN (
  SELECT mv.lot_id, sum(mv.qty) AS qty
  FROM public.prod_stock_movements mv
  WHERE mv.lot_id IS NOT NULL
  GROUP BY mv.lot_id
) m ON m.lot_id = l.id
LEFT JOIN public.prod_warehouses w ON w.id = l.warehouse_id
LEFT JOIN public.prod_items i ON i.id = l.item_id
LEFT JOIN public.prod_suppliers s ON s.id = l.supplier_id;

COMMENT ON VIEW public.prod_lot_stock IS
  'Per lot: remaining_qty = opening_qty + sum of the lot''s ledger rows, value = '
  'round(remaining_qty * unit_cost, 2), names, hold_status (free | hold | blocked).';

-- prod_supplier_balances: same columns / types as 07; purchased now adds the
-- posted price corrections of posted receipts.
CREATE OR REPLACE VIEW public.prod_supplier_balances
WITH (security_invoker = true)
AS
SELECT
  s.id AS supplier_id,
  s.company_id,
  (COALESCE(r.purchased, 0) + COALESCE(c.adjusted, 0))::numeric(14,2) AS purchased,
  COALESCE(p.paid, 0)::numeric(14,2) AS paid,
  (COALESCE(r.purchased, 0) + COALESCE(c.adjusted, 0) - COALESCE(p.paid, 0))::numeric(14,2) AS debt,
  r.last_receipt_at,
  p.last_payment_at
FROM public.prod_suppliers s
LEFT JOIN (
  SELECT supplier_id, company_id,
         sum(total) AS purchased,
         max(doc_date) AS last_receipt_at
  FROM public.prod_receipts
  WHERE status = 'posted' AND supplier_id IS NOT NULL
  GROUP BY supplier_id, company_id
) r ON r.supplier_id = s.id AND r.company_id = s.company_id
LEFT JOIN (
  SELECT rc.supplier_id, rc.company_id, sum(pc.debt_delta) AS adjusted
  FROM public.prod_price_corrections pc
  JOIN public.prod_receipts rc ON rc.id = pc.receipt_id AND rc.company_id = pc.company_id
  WHERE pc.status = 'posted' AND rc.status = 'posted' AND rc.supplier_id IS NOT NULL
  GROUP BY rc.supplier_id, rc.company_id
) c ON c.supplier_id = s.id AND c.company_id = s.company_id
LEFT JOIN (
  SELECT supplier_id, company_id,
         sum(amount) AS paid,
         max(pay_date) AS last_payment_at
  FROM public.prod_supplier_payments
  WHERE status = 'posted'
  GROUP BY supplier_id, company_id
) p ON p.supplier_id = s.id AND p.company_id = s.company_id;

COMMENT ON VIEW public.prod_supplier_balances IS
  'Per production supplier: purchased (posted receipts + posted price corrections), paid (posted '
  'payments), debt = purchased - paid (negative = advance).';

-- prod_supplier_ageing (new): see header "Supplier ageing".
CREATE VIEW public.prod_supplier_ageing
WITH (security_invoker = true)
AS
WITH corr AS (
  SELECT pc.receipt_id, pc.company_id, sum(pc.debt_delta) AS delta
  FROM public.prod_price_corrections pc
  WHERE pc.status = 'posted'
  GROUP BY pc.receipt_id, pc.company_id
),
pay AS (
  SELECT sp.supplier_id, sp.company_id, sum(sp.amount) AS paid
  FROM public.prod_supplier_payments sp
  WHERE sp.status = 'posted'
  GROUP BY sp.supplier_id, sp.company_id
),
ch AS (
  SELECT r.company_id, r.supplier_id, r.id, r.number, r.doc_date,
         COALESCE(r.due_date, (r.doc_date AT TIME ZONE 'Asia/Tashkent')::date) AS due,
         r.total + COALESCE(corr.delta, 0) AS amount
  FROM public.prod_receipts r
  LEFT JOIN corr ON corr.receipt_id = r.id AND corr.company_id = r.company_id
  WHERE r.status = 'posted' AND r.supplier_id IS NOT NULL
),
al AS (
  SELECT ch.company_id, ch.supplier_id, ch.amount,
         (now() AT TIME ZONE 'Asia/Tashkent')::date - ch.due AS days_overdue,
         GREATEST(LEAST(
           ch.amount,
           sum(ch.amount) OVER (
             PARTITION BY ch.company_id, ch.supplier_id
             ORDER BY ch.doc_date, ch.number, ch.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) - COALESCE(pay.paid, 0)
         ), 0) AS open_amount
  FROM ch
  LEFT JOIN pay ON pay.supplier_id = ch.supplier_id AND pay.company_id = ch.company_id
),
agg AS (
  SELECT al.company_id, al.supplier_id,
         sum(al.amount) AS charged,
         sum(al.open_amount) FILTER (WHERE al.days_overdue <= 0) AS not_due,
         sum(al.open_amount) FILTER (WHERE al.days_overdue BETWEEN 1 AND 15) AS overdue_1_15,
         sum(al.open_amount) FILTER (WHERE al.days_overdue BETWEEN 16 AND 30) AS overdue_16_30,
         sum(al.open_amount) FILTER (WHERE al.days_overdue >= 31) AS overdue_31_plus
  FROM al
  GROUP BY al.company_id, al.supplier_id
)
SELECT
  s.id AS supplier_id,
  s.company_id,
  (COALESCE(agg.charged, 0) - COALESCE(pay.paid, 0))::numeric(14,2) AS balance,
  COALESCE(agg.not_due, 0)::numeric(14,2) AS not_due,
  COALESCE(agg.overdue_1_15, 0)::numeric(14,2) AS overdue_1_15,
  COALESCE(agg.overdue_16_30, 0)::numeric(14,2) AS overdue_16_30,
  COALESCE(agg.overdue_31_plus, 0)::numeric(14,2) AS overdue_31_plus
FROM public.prod_suppliers s
LEFT JOIN agg ON agg.supplier_id = s.id AND agg.company_id = s.company_id
LEFT JOIN pay ON pay.supplier_id = s.id AND pay.company_id = s.company_id;

COMMENT ON VIEW public.prod_supplier_ageing IS
  'Per production supplier: balance (= prod_supplier_balances.debt) and the open receipt amounts after '
  'FIFO allocation of posted payments, bucketed by days past due (Asia/Tashkent business date).';

REVOKE ALL ON public.prod_lot_stock FROM authenticated, anon;
GRANT SELECT ON public.prod_lot_stock TO authenticated;
REVOKE ALL ON public.prod_supplier_balances FROM authenticated, anon;
GRANT SELECT ON public.prod_supplier_balances TO authenticated;
REVOKE ALL ON public.prod_supplier_ageing FROM authenticated, anon;
GRANT SELECT ON public.prod_supplier_ageing TO authenticated;

-- ─── 6) Internal helpers ──────────────────────────────────────────────────

-- prod_require_warehouse (replaced, same signature): now VOLATILE and takes
-- the warehouse row FOR SHARE, so prod_save_warehouse's deactivation check
-- (FOR NO KEY UPDATE) cannot race a document posting into it.
CREATE OR REPLACE FUNCTION public.prod_require_warehouse(p_company_id uuid, p_warehouse_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active boolean;
BEGIN
  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT is_active INTO v_active
  FROM public.prod_warehouses
  WHERE id = p_warehouse_id AND company_id = p_company_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
END;
$$;

-- prod_consume with a hold mode (see header "Hold handling"). Body of 13
-- otherwise unchanged: PRECONDITION the caller holds the (warehouse, item)
-- stock key (re-taken here, re-entrant no-op).
-- p_hold_mode: 'strict' | 'pick' | 'any'.
CREATE OR REPLACE FUNCTION public.prod_consume(
  p_company_id uuid, p_warehouse_id uuid, p_item_id uuid, p_qty numeric,
  p_doc_type text, p_doc_id uuid, p_picks jsonb, p_hold_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_picks jsonb := p_picks;
  v_pick jsonb;
  v_lot_id uuid;
  v_q numeric;
  v_rem numeric;
  v_hold text;
  v_rec record;
  v_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_sum numeric := 0;
  v_left numeric;
  v_take numeric;
  v_line_cost numeric;
  v_cost numeric := 0;
  v_fat_q numeric := 0;
  v_fat_s numeric := 0;
  v_pro_q numeric := 0;
  v_pro_s numeric := 0;
  v_lots jsonb := '[]'::jsonb;
  i integer;
BEGIN
  IF p_company_id IS NULL OR p_warehouse_id IS NULL OR p_item_id IS NULL
     OR p_doc_type IS NULL OR p_doc_id IS NULL
     OR p_qty IS NULL OR p_qty <= 0
     OR p_hold_mode IS NULL OR p_hold_mode NOT IN ('strict', 'pick', 'any') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_lock_stock(p_company_id, p_warehouse_id, ARRAY[p_item_id]);

  IF v_picks IS NOT NULL AND jsonb_typeof(v_picks) = 'null' THEN
    v_picks := NULL;
  END IF;
  IF v_picks IS NOT NULL THEN
    IF jsonb_typeof(v_picks) <> 'array' THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF jsonb_array_length(v_picks) = 0 THEN
      v_picks := NULL;
    ELSIF jsonb_array_length(v_picks) > 500 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;

  IF v_picks IS NULL THEN
    -- FEFO plan. 'any': free lots first, then held / blocked ones.
    v_left := p_qty;
    FOR v_rec IN
      SELECT x.id, x.remaining
      FROM (
        SELECT l.id, l.expiry_date, l.received_at, l.lot_no, l.hold_status,
               l.opening_qty + COALESCE((
                 SELECT sum(m.qty) FROM public.prod_stock_movements m
                 WHERE m.lot_id = l.id AND m.company_id = l.company_id
               ), 0) AS remaining
        FROM public.prod_lots l
        WHERE l.company_id = p_company_id
          AND l.warehouse_id = p_warehouse_id
          AND l.item_id = p_item_id
      ) x
      WHERE x.remaining > 0
        AND (p_hold_mode = 'any' OR x.hold_status = 'free')
      ORDER BY (x.hold_status <> 'free'), x.expiry_date NULLS LAST, x.received_at, length(x.lot_no), x.lot_no
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_left, v_rec.remaining);
      v_ids := v_ids || v_rec.id;
      v_qtys := v_qtys || v_take;
      v_left := v_left - v_take;
    END LOOP;
    IF v_left > 0 THEN
      RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p_item_id::text;
    END IF;
  ELSE
    -- Manual plan.
    FOR v_pick IN SELECT * FROM jsonb_array_elements(v_picks)
    LOOP
      v_lot_id := public.prod_juuid(v_pick, 'lot_id');
      v_q := public.prod_jnum(v_pick, 'qty', 3);
      IF v_lot_id IS NULL OR v_q IS NULL OR v_q <= 0 OR v_lot_id = ANY (v_ids) THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      SELECT l.hold_status INTO v_hold
      FROM public.prod_lots l
      WHERE l.id = v_lot_id AND l.company_id = p_company_id
        AND l.warehouse_id = p_warehouse_id AND l.item_id = p_item_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      IF p_hold_mode = 'strict' AND v_hold <> 'free' THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'lot_on_hold';
      END IF;
      v_rem := public.prod_lot_remaining(p_company_id, v_lot_id);
      IF v_q > v_rem THEN
        RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p_item_id::text;
      END IF;
      v_ids := v_ids || v_lot_id;
      v_qtys := v_qtys || v_q;
      v_sum := v_sum + v_q;
    END LOOP;
    IF v_sum <> p_qty THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;

  -- Write the plan.
  FOR i IN 1 .. cardinality(v_ids)
  LOOP
    SELECT l.id, l.lot_no, l.unit_cost, l.fat_pct, l.protein_pct INTO v_rec
    FROM public.prod_lots l
    WHERE l.id = v_ids[i] AND l.company_id = p_company_id;

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
      fat_pct, protein_pct, lot_id
    ) VALUES (
      p_company_id, p_warehouse_id, p_item_id, -v_qtys[i], v_rec.unit_cost, p_doc_type, p_doc_id, false, auth.uid(),
      v_rec.fat_pct, v_rec.protein_pct, v_rec.id
    );

    v_line_cost := round(v_qtys[i] * v_rec.unit_cost, 2);
    v_cost := v_cost + v_line_cost;
    IF v_rec.fat_pct IS NOT NULL THEN
      v_fat_q := v_fat_q + v_qtys[i];
      v_fat_s := v_fat_s + v_qtys[i] * v_rec.fat_pct;
    END IF;
    IF v_rec.protein_pct IS NOT NULL THEN
      v_pro_q := v_pro_q + v_qtys[i];
      v_pro_s := v_pro_s + v_qtys[i] * v_rec.protein_pct;
    END IF;
    v_lots := v_lots || jsonb_build_array(jsonb_build_object(
      'lot_id', v_rec.id, 'lot_no', v_rec.lot_no, 'qty', v_qtys[i], 'unit_cost', v_rec.unit_cost
    ));
  END LOOP;

  IF v_cost >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  RETURN jsonb_build_object(
    'qty', p_qty,
    'cost', v_cost,
    'fat_pct', CASE WHEN v_fat_q > 0 THEN round(v_fat_s / v_fat_q, 3) END,
    'protein_pct', CASE WHEN v_pro_q > 0 THEN round(v_pro_s / v_pro_q, 3) END,
    'lots', v_lots
  );
END;
$$;

-- prod_consume (7-arg, replaced, same signature): = hold mode 'strict'.
-- Every existing caller (production, processing, separation) keeps calling
-- this one, so held / blocked lots are never consumed by them.
CREATE OR REPLACE FUNCTION public.prod_consume(
  p_company_id uuid, p_warehouse_id uuid, p_item_id uuid, p_qty numeric,
  p_doc_type text, p_doc_id uuid, p_picks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.prod_consume(p_company_id, p_warehouse_id, p_item_id, p_qty,
                             p_doc_type, p_doc_id, p_picks, 'strict'::text);
END;
$$;

-- Snapshot the CURRENT state of one recipe as prod_recipe_versions row
-- (recipe_id, version). Idempotent per version (ON CONFLICT DO NOTHING).
CREATE OR REPLACE FUNCTION public.prod_recipe_snapshot(p_company_id uuid, p_recipe_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_company_id IS NULL OR p_recipe_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  INSERT INTO public.prod_recipe_versions (
    company_id, recipe_id, version, output_item_id, output_qty, lines, is_active, note,
    saved_by, saved_by_name, saved_at
  )
  SELECT r.company_id, r.id, r.version, r.item_id, r.output_qty,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'item_id', l.item_id, 'qty', l.qty, 'sort_order', l.sort_order, 'note', l.note
                  ) ORDER BY l.sort_order, l.id)
           FROM public.prod_recipe_lines l
           WHERE l.recipe_id = r.id AND l.company_id = r.company_id
         ), '[]'::jsonb),
         r.is_active, r.note,
         auth.uid(), (SELECT u.full_name FROM public.users u WHERE u.id = auth.uid()), now()
  FROM public.prod_recipes r
  WHERE r.id = p_recipe_id AND r.company_id = p_company_id
  ON CONFLICT (recipe_id, version) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_require_warehouse(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_consume(uuid, uuid, uuid, numeric, text, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_consume(uuid, uuid, uuid, numeric, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_recipe_snapshot(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ─── 7) Recipe versions backfill: current version of every recipe ────────

INSERT INTO public.prod_recipe_versions (
  company_id, recipe_id, version, output_item_id, output_qty, lines, is_active, note,
  saved_by, saved_by_name, saved_at
)
SELECT r.company_id, r.id, r.version, r.item_id, r.output_qty,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'item_id', l.item_id, 'qty', l.qty, 'sort_order', l.sort_order, 'note', l.note
                ) ORDER BY l.sort_order, l.id)
         FROM public.prod_recipe_lines l
         WHERE l.recipe_id = r.id AND l.company_id = r.company_id
       ), '[]'::jsonb),
       r.is_active, r.note, r.created_by, r.created_by_name, r.updated_at
FROM public.prod_recipes r
ON CONFLICT (recipe_id, version) DO NOTHING;

-- ─── 8) RPCs ──────────────────────────────────────────────────────────────

-- ═══ prod_save_item (replaced, same signature) ═══════════════════════════
-- Body copied from 20261110000013. Additions:
--   * optional standard_cost, sale_price (>= 0, 2 decimals), expiry_warn_days
--     (integer 1..365): key ABSENT -> unchanged on update / NULL on create;
--     present + null -> cleared.
--   * duplicates (per company, under 'prod_item_save:<co>'): name
--     (case-insensitive, trimmed), sku, barcode (non-null) -> 'duplicate'
--     DETAIL 'name' | 'sku' | 'barcode'; checked on create and only for a
--     CHANGED value on update (existing live duplicates stay editable).
--     unique_violation (race / index) maps to the same code.
CREATE OR REPLACE FUNCTION public.prod_save_item(p_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
  v_name text;
  v_group_id uuid;
  v_sku text;
  v_barcode text;
  v_unit text;
  v_weight numeric;
  v_type text;
  v_min numeric;
  v_max numeric;
  v_active boolean;
  v_description text;
  v_old_unit text;
  v_old_name text;
  v_old_sku text;
  v_old_barcode text;
  v_has_shelf boolean;
  v_shelf numeric;
  v_has_std boolean;
  v_std numeric;
  v_has_sale boolean;
  v_sale numeric;
  v_has_warn boolean;
  v_warn numeric;
  v_con text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_catalog') THEN
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
  v_group_id := public.prod_juuid(p_data, 'group_id');
  v_sku := public.prod_jtext(p_data, 'sku', 100);
  v_barcode := public.prod_jtext(p_data, 'barcode', 100);
  v_unit := public.prod_jtext(p_data, 'unit', 10);
  v_weight := public.prod_jnum(p_data, 'weight_kg', 3);
  v_type := public.prod_jtext(p_data, 'item_type', 20);
  v_min := public.prod_jnum(p_data, 'min_stock', 3);
  v_max := public.prod_jnum(p_data, 'max_stock', 3);
  v_active := public.prod_jbool(p_data, 'is_active');
  v_description := public.prod_jtext(p_data, 'description', 500);
  v_has_shelf := p_data ? 'shelf_life_days';
  v_shelf := public.prod_jnum(p_data, 'shelf_life_days', 3);
  v_has_std := p_data ? 'standard_cost';
  v_std := public.prod_jnum(p_data, 'standard_cost', 2);
  v_has_sale := p_data ? 'sale_price';
  v_sale := public.prod_jnum(p_data, 'sale_price', 2);
  v_has_warn := p_data ? 'expiry_warn_days';
  v_warn := public.prod_jnum(p_data, 'expiry_warn_days', 3);

  IF v_name IS NULL
     OR v_unit IS NULL OR v_unit NOT IN ('kg', 'l', 'g', 'pcs', 'm')
     OR v_type IS NULL OR v_type NOT IN ('raw', 'semi', 'finished', 'packaging')
     OR (v_weight IS NOT NULL AND v_weight < 0)
     OR (v_min IS NOT NULL AND v_min < 0)
     OR (v_max IS NOT NULL AND v_max < 0)
     OR (v_min IS NOT NULL AND v_max IS NOT NULL AND v_max < v_min)
     OR (v_shelf IS NOT NULL AND (v_shelf <> trunc(v_shelf) OR v_shelf NOT BETWEEN 1 AND 3650))
     OR (v_std IS NOT NULL AND v_std < 0)
     OR (v_sale IS NOT NULL AND v_sale < 0)
     OR (v_warn IS NOT NULL AND (v_warn <> trunc(v_warn) OR v_warn NOT BETWEEN 1 AND 365)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.prod_item_groups WHERE id = v_group_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Serialise catalog saves of the company (duplicate check + write).
  PERFORM pg_advisory_xact_lock(hashtextextended('prod_item_save:' || v_company_id::text, 0));

  IF p_id IS NOT NULL THEN
    SELECT unit, name, sku, barcode INTO v_old_unit, v_old_name, v_old_sku, v_old_barcode
    FROM public.prod_items
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  IF (p_id IS NULL OR lower(btrim(v_old_name)) <> lower(v_name)) AND EXISTS (
    SELECT 1 FROM public.prod_items
    WHERE company_id = v_company_id AND lower(btrim(name)) = lower(v_name)
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END IF;
  IF v_sku IS NOT NULL AND (p_id IS NULL OR v_old_sku IS DISTINCT FROM v_sku) AND EXISTS (
    SELECT 1 FROM public.prod_items
    WHERE company_id = v_company_id AND sku = v_sku AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'sku';
  END IF;
  IF v_barcode IS NOT NULL AND (p_id IS NULL OR v_old_barcode IS DISTINCT FROM v_barcode) AND EXISTS (
    SELECT 1 FROM public.prod_items
    WHERE company_id = v_company_id AND barcode = v_barcode AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'barcode';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_items (
        company_id, group_id, name, sku, barcode, unit, weight_kg, item_type,
        min_stock, max_stock, is_active, description, shelf_life_days,
        standard_cost, sale_price, expiry_warn_days
      ) VALUES (
        v_company_id, v_group_id, v_name, v_sku, v_barcode, v_unit, v_weight, v_type,
        v_min, v_max, COALESCE(v_active, true), v_description, v_shelf::integer,
        v_std, v_sale, v_warn::integer
      )
      RETURNING id INTO v_id;
    ELSE
      IF v_old_unit <> v_unit AND (
        EXISTS (SELECT 1 FROM public.prod_stock_movements
                WHERE company_id = v_company_id AND item_id = p_id)
        OR EXISTS (SELECT 1 FROM public.prod_lots
                   WHERE company_id = v_company_id AND item_id = p_id)
      ) THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;

      UPDATE public.prod_items
      SET group_id = v_group_id,
          name = v_name,
          sku = v_sku,
          barcode = v_barcode,
          unit = v_unit,
          weight_kg = v_weight,
          item_type = v_type,
          min_stock = v_min,
          max_stock = v_max,
          is_active = COALESCE(v_active, is_active),
          description = v_description,
          shelf_life_days = CASE WHEN v_has_shelf THEN v_shelf::integer ELSE shelf_life_days END,
          standard_cost = CASE WHEN v_has_std THEN v_std ELSE standard_cost END,
          sale_price = CASE WHEN v_has_sale THEN v_sale ELSE sale_price END,
          expiry_warn_days = CASE WHEN v_has_warn THEN v_warn::integer ELSE expiry_warn_days END,
          updated_at = now()
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
      RAISE EXCEPTION 'duplicate' USING DETAIL = CASE
        WHEN v_con LIKE '%sku%' THEN 'sku'
        WHEN v_con LIKE '%barcode%' THEN 'barcode'
        ELSE 'name' END;
  END;

  RETURN v_id;
END;
$$;

-- ═══ prod_save_supplier (replaced, same signature) ═══════════════════════
-- Body copied from 20261110000010. Additions:
--   * optional payment_terms_days (integer 0..365): key ABSENT -> unchanged
--     on update / NULL on create; present + null -> cleared.
--   * duplicate name (case-insensitive, trimmed) on create / CHANGED name,
--     under 'prod_supplier_save:<co>' -> 'duplicate' DETAIL 'name'.
-- p_data: { name, phone, address, note, is_active, milk_price_per_kg,
--           payment_terms_days }
CREATE OR REPLACE FUNCTION public.prod_save_supplier(p_id uuid, p_data jsonb)
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
  v_phone text;
  v_address text;
  v_note text;
  v_active boolean;
  v_has_milk_price boolean;
  v_milk_price numeric;
  v_has_terms boolean;
  v_terms numeric;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_suppliers') THEN
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
  v_phone := public.prod_jtext(p_data, 'phone', 30);
  v_address := public.prod_jtext(p_data, 'address', 300);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_active := public.prod_jbool(p_data, 'is_active');
  v_has_milk_price := p_data ? 'milk_price_per_kg';
  v_milk_price := public.prod_jnum(p_data, 'milk_price_per_kg', 2);
  v_has_terms := p_data ? 'payment_terms_days';
  v_terms := public.prod_jnum(p_data, 'payment_terms_days', 3);

  IF v_name IS NULL OR (v_milk_price IS NOT NULL AND v_milk_price < 0)
     OR (v_terms IS NOT NULL AND (v_terms <> trunc(v_terms) OR v_terms NOT BETWEEN 0 AND 365)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_supplier_save:' || v_company_id::text, 0));

  IF p_id IS NOT NULL THEN
    SELECT name INTO v_old_name
    FROM public.prod_suppliers
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  IF (p_id IS NULL OR lower(btrim(v_old_name)) <> lower(v_name)) AND EXISTS (
    SELECT 1 FROM public.prod_suppliers
    WHERE company_id = v_company_id AND lower(btrim(name)) = lower(v_name)
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_suppliers (company_id, name, phone, address, note, is_active, milk_price_per_kg,
                                         payment_terms_days)
      VALUES (v_company_id, v_name, v_phone, v_address, v_note, COALESCE(v_active, true), v_milk_price,
              v_terms::integer)
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_suppliers
      SET name = v_name,
          phone = v_phone,
          address = v_address,
          note = v_note,
          is_active = COALESCE(v_active, is_active),
          milk_price_per_kg = CASE WHEN v_has_milk_price THEN v_milk_price ELSE milk_price_per_kg END,
          payment_terms_days = CASE WHEN v_has_terms THEN v_terms::integer ELSE payment_terms_days END,
          updated_at = now()
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END;

  RETURN v_id;
END;
$$;

-- ═══ prod_save_warehouse (replaced, same signature) ══════════════════════
-- Body copied from 20261110000004. Addition: deactivating (active ->
-- p_is_active = false) a warehouse whose lots hold remaining <> 0 ->
-- invalid_input DETAIL 'warehouse_has_stock'. Row taken FOR NO KEY UPDATE
-- first (conflicts with the FOR SHARE of prod_require_warehouse, see header).
-- An already inactive warehouse is not re-checked.
CREATE OR REPLACE FUNCTION public.prod_save_warehouse(
  p_id uuid, p_name text, p_storage_types text[], p_is_active boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_name text;
  v_types text[];
  v_id uuid;
  v_old_active boolean;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_catalog') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := NULLIF(btrim(p_name), '');
  IF v_name IS NULL OR length(v_name) > 100 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_storage_types IS NULL OR array_position(p_storage_types, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT array_agg(DISTINCT btrim(t) ORDER BY btrim(t))
  INTO v_types
  FROM unnest(p_storage_types) AS u(t);
  IF v_types IS NULL OR cardinality(v_types) = 0
     OR NOT (v_types <@ ARRAY['raw', 'finished', 'production', 'processing', 'return']::text[]) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT is_active INTO v_old_active
    FROM public.prod_warehouses
    WHERE id = p_id AND company_id = v_company_id
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;

    IF v_old_active AND p_is_active IS FALSE AND EXISTS (
      SELECT 1
      FROM public.prod_lots l
      WHERE l.company_id = v_company_id AND l.warehouse_id = p_id
        AND l.opening_qty + COALESCE((
              SELECT sum(m.qty) FROM public.prod_stock_movements m
              WHERE m.lot_id = l.id AND m.company_id = l.company_id
            ), 0) <> 0
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'warehouse_has_stock';
    END IF;
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_warehouses (company_id, name, storage_types, is_active)
      VALUES (v_company_id, v_name, v_types, COALESCE(p_is_active, true))
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_warehouses
      SET name = v_name,
          storage_types = v_types,
          is_active = COALESCE(p_is_active, is_active)
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate_name';
  END;

  RETURN v_id;
END;
$$;

-- ═══ prod_save_recipe (replaced, same signature) ═════════════════════════
-- Body copied from 20261110000008. ONLY addition: the saved version is
-- snapshotted into prod_recipe_versions (prod_recipe_snapshot).
CREATE OR REPLACE FUNCTION public.prod_save_recipe(p_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_id uuid;
  v_item_id uuid;
  v_output_qty numeric;
  v_note text;
  v_active boolean;
  v_out_type text;
  v_old_item_id uuid;
  v_old_active boolean;
  v_line jsonb;
  v_line_item uuid;
  v_line_qty numeric;
  v_line_note text;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_notes text[] := '{}';
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_catalog') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_item_id := public.prod_juuid(p_data, 'item_id');
  v_output_qty := public.prod_jnum(p_data, 'output_qty', 4);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_active := public.prod_jbool(p_data, 'is_active');

  IF v_item_id IS NULL OR v_output_qty IS NULL OR v_output_qty <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT item_type INTO v_out_type
  FROM public.prod_items
  WHERE id = v_item_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_out_type NOT IN ('finished', 'semi') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF jsonb_typeof(p_data->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'lines') NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'lines')
  LOOP
    v_line_item := public.prod_juuid(v_line, 'item_id');
    v_line_qty := public.prod_jnum(v_line, 'qty', 4);
    v_line_note := public.prod_jtext(v_line, 'note', 500);
    IF v_line_item IS NULL OR v_line_qty IS NULL OR v_line_qty <= 0
       OR v_line_item = v_item_id
       OR v_line_item = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_line_item;
    v_qtys := v_qtys || v_line_qty;
    v_notes := array_append(v_notes, v_line_note);
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT item_id, is_active INTO v_old_item_id, v_old_active
    FROM public.prod_recipes
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF v_old_item_id <> v_item_id THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;

  v_active := COALESCE(v_active, CASE WHEN p_id IS NULL THEN true ELSE v_old_active END);

  IF v_active AND EXISTS (
    SELECT 1 FROM public.prod_recipes
    WHERE company_id = v_company_id AND item_id = v_item_id AND is_active
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

      INSERT INTO public.prod_recipes (
        company_id, item_id, output_qty, version, is_active, note,
        created_by, created_by_name
      ) VALUES (
        v_company_id, v_item_id, v_output_qty, 1, v_active, v_note,
        auth.uid(), v_user_name
      )
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_recipes
      SET output_qty = v_output_qty,
          is_active = v_active,
          note = v_note,
          version = version + 1,
          updated_at = now()
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;

      DELETE FROM public.prod_recipe_lines
      WHERE recipe_id = v_id AND company_id = v_company_id;
    END IF;

    FOR i IN 1 .. cardinality(v_item_ids)
    LOOP
      INSERT INTO public.prod_recipe_lines (company_id, recipe_id, item_id, qty, sort_order, note)
      VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], i - 1, v_notes[i]);
    END LOOP;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'invalid_input';
  END;

  -- NEW: version history.
  PERFORM public.prod_recipe_snapshot(v_company_id, v_id);

  RETURN v_id;
END;
$$;

-- ═══ prod_set_lot_hold (new) ═════════════════════════════════════════════
-- prod_stock. p_status 'free' | 'hold' | 'blocked'; p_reason optional
-- (<= 500, cleared when 'free'). Takes the lot's stock key so it serialises
-- with every consumer of that key. hold_at / hold_by = last change.
CREATE OR REPLACE FUNCTION public.prod_set_lot_hold(p_lot_id uuid, p_status text, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_lot record;
  v_reason text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_reason := NULLIF(btrim(p_reason), '');
  IF p_lot_id IS NULL OR p_status IS NULL OR p_status NOT IN ('free', 'hold', 'blocked')
     OR (v_reason IS NOT NULL AND length(v_reason) > 500) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT l.warehouse_id, l.item_id INTO v_lot
  FROM public.prod_lots l
  WHERE l.id = p_lot_id AND l.company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM public.prod_lock_stock(v_company_id, v_lot.warehouse_id, ARRAY[v_lot.item_id]);

  UPDATE public.prod_lots
  SET hold_status = p_status,
      hold_reason = CASE WHEN p_status = 'free' THEN NULL ELSE v_reason END,
      hold_at = now(),
      hold_by = auth.uid()
  WHERE id = p_lot_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_create_writeoff (new) ══════════════════════════════════════════
-- prod_stock. p_data: { doc_date, warehouse_id, reason, note,
--   items: [{ item_id, qty, lots: [{lot_id, qty}] }] }
-- reason: spoiled | expired | damaged | lab_reject | sample | other.
-- Consumption: prod_consume hold mode 'any' (held / blocked lots allowed,
-- FEFO takes free lots first). Items need not be active. 1..500 lines, no
-- duplicate item. Lock order: warehouse FOR SHARE -> stock keys (one
-- warehouse, item order) -> 'prod_writeoff_no'.
-- Returns { id, number, total_cost }.
CREATE OR REPLACE FUNCTION public.prod_create_writeoff(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_wh uuid;
  v_reason text;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_picks jsonb[] := '{}';
  v_costs numeric[] := '{}';
  v_totals numeric[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_res jsonb;
  v_line_cost numeric;
  v_total numeric := 0;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
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
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_reason := public.prod_jtext(p_data, 'reason', 20);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_reason IS NULL OR v_reason NOT IN ('spoiled', 'expired', 'damaged', 'lab_reject', 'sample', 'other') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);

  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_picks := array_append(v_picks, v_line->'lots');
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM public.prod_lock_stock(v_company_id, v_wh, v_item_ids);

  v_id := gen_random_uuid();

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_wh, v_item_ids[i], v_qtys[i],
                                 'writeoff', v_id, v_picks[i], 'any');
    v_line_cost := (v_res->>'cost')::numeric;
    v_totals := v_totals || v_line_cost;
    v_costs := v_costs || round(v_line_cost / v_qtys[i], 2);
    v_total := v_total + v_line_cost;
    IF v_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_writeoff_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_writeoffs WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_writeoffs (
    id, company_id, number, doc_date, warehouse_id, reason, note, total_cost,
    status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_wh, v_reason, v_note, v_total,
    'posted', auth.uid(), v_user_name
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_writeoff_items (company_id, writeoff_id, item_id, qty, unit_cost, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], v_totals[i]);
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total_cost', v_total);
END;
$$;

-- ═══ prod_save_stock_count (new) ═════════════════════════════════════════
-- prod_stock. p_id NULL -> create a draft, else update the company's DRAFT
-- (posted -> invalid_input, cancelled -> already_cancelled). Lines are
-- replaced. p_data: { doc_date, warehouse_id, note,
--   items: [{ item_id, counted_qty (>= 0), unit_cost (optional, >= 0) }] }
-- 1..2000 lines, no duplicate item, items of the company (inactive allowed).
-- doc_date absent on update -> unchanged. Draft numbers come from
-- 'prod_stock_count_no' (a deleted draft leaves a gap). Returns the id.
CREATE OR REPLACE FUNCTION public.prod_save_stock_count(p_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_wh uuid;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_counts numeric[] := '{}';
  v_costs numeric[] := '{}';
  v_item_id uuid;
  v_counted numeric;
  v_cost numeric;
  v_status text;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_doc_date := public.prod_jts(p_data, 'doc_date');
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_note := public.prod_jtext(p_data, 'note', 500);

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);

  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_counted := public.prod_jnum(v_line, 'counted_qty', 3);
    v_cost := public.prod_jnum(v_line, 'unit_cost', 2);
    IF v_item_id IS NULL OR v_counted IS NULL OR v_counted < 0
       OR (v_cost IS NOT NULL AND v_cost < 0)
       OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_counts := v_counts || v_counted;
    v_costs := array_append(v_costs, v_cost);
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('prod_stock_count_no:' || v_company_id::text, 0));
    SELECT COALESCE(max(number), 0) + 1 INTO v_number
    FROM public.prod_stock_counts WHERE company_id = v_company_id;

    SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

    INSERT INTO public.prod_stock_counts (
      company_id, number, doc_date, warehouse_id, note, status, created_by, created_by_name
    ) VALUES (
      v_company_id, v_number, COALESCE(v_doc_date, now()), v_wh, v_note, 'draft', auth.uid(), v_user_name
    )
    RETURNING id INTO v_id;
  ELSE
    SELECT status INTO v_status
    FROM public.prod_stock_counts
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF v_status = 'cancelled' THEN
      RAISE EXCEPTION 'already_cancelled';
    END IF;
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    UPDATE public.prod_stock_counts
    SET doc_date = COALESCE(v_doc_date, doc_date),
        warehouse_id = v_wh,
        note = v_note,
        updated_at = now()
    WHERE id = p_id AND company_id = v_company_id
    RETURNING id INTO v_id;

    DELETE FROM public.prod_stock_count_items
    WHERE count_id = v_id AND company_id = v_company_id;
  END IF;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_stock_count_items (company_id, count_id, item_id, counted_qty, unit_cost)
    VALUES (v_company_id, v_id, v_item_ids[i], v_counts[i], v_costs[i]);
  END LOOP;

  RETURN v_id;
END;
$$;

-- ═══ prod_post_stock_count (new) ═════════════════════════════════════════
-- prod_stock. Draft row FOR UPDATE -> warehouse FOR SHARE -> stock keys of
-- every line item (one warehouse, item order) -> (surplus lots) 'prod_lot_no'.
-- Per line, under the lock: system_qty = current key qty (sum of lot
-- remaining), diff = counted - system.
--   diff < 0: shortage, prod_consume hold mode 'any' (FEFO, free lots first,
--             then held), doc_type 'stock_count'; unit_cost = round(cost /
--             qty, 2), diff_value = -cost.
--   diff > 0: surplus lot (prod_add_lot) at line unit_cost if given, else
--             the key's current weighted cost (avg_cost; 0 when the key has
--             no positive stock); fat / protein = current weighted values;
--             received_at = doc_date, expiry from shelf life;
--             diff_value = round(diff * unit_cost, 2).
--   diff = 0: nothing posted; unit_cost = given or current avg cost.
-- All shortages are posted before any surplus lot (lot-number lock last).
-- Returns { id, number, shortage_value, surplus_value }.
CREATE OR REPLACE FUNCTION public.prod_post_stock_count(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc record;
  v_item_ids uuid[];
  v_line record;
  v_stock record;
  v_q record;
  v_diff numeric;
  v_res jsonb;
  v_cost numeric;
  v_unit numeric;
  v_dv numeric;
  v_short numeric := 0;
  v_surplus numeric := 0;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, number, status, warehouse_id, doc_date INTO v_doc
  FROM public.prod_stock_counts
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_doc.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_doc.status <> 'draft' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_doc.warehouse_id);

  SELECT array_agg(item_id ORDER BY item_id) INTO v_item_ids
  FROM public.prod_stock_count_items
  WHERE count_id = p_id AND company_id = v_company_id;
  IF v_item_ids IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_lock_stock(v_company_id, v_doc.warehouse_id, v_item_ids);

  -- Pass 1: snapshot every line, post shortages.
  FOR v_line IN
    SELECT id, item_id, counted_qty, unit_cost
    FROM public.prod_stock_count_items
    WHERE count_id = p_id AND company_id = v_company_id
    ORDER BY item_id
  LOOP
    SELECT * INTO v_stock FROM public.prod_current_stock(v_company_id, v_doc.warehouse_id, v_line.item_id);
    v_diff := v_line.counted_qty - v_stock.qty;

    IF v_diff < 0 THEN
      v_res := public.prod_consume(v_company_id, v_doc.warehouse_id, v_line.item_id, -v_diff,
                                   'stock_count', p_id, NULL, 'any');
      v_cost := (v_res->>'cost')::numeric;
      v_unit := round(v_cost / -v_diff, 2);
      v_dv := -v_cost;
      v_short := v_short + v_cost;
    ELSE
      v_unit := COALESCE(v_line.unit_cost, CASE WHEN v_stock.qty > 0 THEN v_stock.avg_cost ELSE 0 END);
      v_dv := round(v_diff * v_unit, 2);
      v_surplus := v_surplus + v_dv;
    END IF;

    IF v_short >= 1e12 OR v_surplus >= 1e12 OR abs(v_dv) >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    UPDATE public.prod_stock_count_items
    SET system_qty = v_stock.qty,
        diff_qty = v_diff,
        unit_cost = v_unit,
        diff_value = v_dv
    WHERE id = v_line.id AND company_id = v_company_id;
  END LOOP;

  -- Pass 2: surplus lots (takes 'prod_lot_no', always last). The surplus
  -- keys were not consumed in pass 1 (one line per item), so the weighted
  -- quality read here equals the snapshot.
  FOR v_line IN
    SELECT id, item_id, diff_qty, unit_cost
    FROM public.prod_stock_count_items
    WHERE count_id = p_id AND company_id = v_company_id AND diff_qty > 0
    ORDER BY item_id
  LOOP
    SELECT * INTO v_q FROM public.prod_stock_quality_at(v_company_id, v_doc.warehouse_id, v_line.item_id);
    PERFORM public.prod_add_lot(
      v_company_id, v_doc.warehouse_id, v_line.item_id, v_line.diff_qty, v_line.unit_cost,
      v_q.avg_fat, v_q.avg_protein, NULL, 'stock_count', p_id, NULL,
      public.prod_lot_expiry(v_company_id, v_line.item_id, v_doc.doc_date),
      v_doc.doc_date, NULL
    );
  END LOOP;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  UPDATE public.prod_stock_counts
  SET status = 'posted',
      shortage_value = v_short,
      surplus_value = v_surplus,
      posted_at = now(),
      posted_by = auth.uid(),
      posted_by_name = v_user_name,
      updated_at = now()
  WHERE id = p_id AND company_id = v_company_id;

  RETURN jsonb_build_object(
    'id', p_id, 'number', v_doc.number, 'shortage_value', v_short, 'surplus_value', v_surplus
  );
END;
$$;

-- ═══ prod_delete_stock_count_draft (new) ═════════════════════════════════
-- prod_stock. Only a draft (posted -> invalid_input, cancelled ->
-- already_cancelled). Lines go with it (ON DELETE CASCADE). No ledger rows
-- exist for a draft.
CREATE OR REPLACE FUNCTION public.prod_delete_stock_count_draft(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_status text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT status INTO v_status
  FROM public.prod_stock_counts
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  DELETE FROM public.prod_stock_counts
  WHERE id = p_id AND company_id = v_company_id AND status = 'draft';
END;
$$;

-- ═══ prod_create_opening (new) ═══════════════════════════════════════════
-- prod_stock. p_data: { doc_date, warehouse_id, note,
--   items: [{ item_id, qty (> 0), unit_cost (>= 0, required), fat_pct,
--             protein_pct, expiry_date, supplier_id }] }
-- Each line -> one lot (source_doc_type 'opening_balance', received_at =
-- doc_date, expiry = line expiry_date else shelf life). The same item may
-- appear on several lines (several lots). supplier_id: a supplier of the
-- company (inactive allowed), else not_found. Items need not be active.
-- Locks: warehouse FOR SHARE -> 'prod_opening_no' -> 'prod_lot_no' (inflow
-- only, no stock key). Returns { id, number, total }.
CREATE OR REPLACE FUNCTION public.prod_create_opening(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_wh uuid;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_costs numeric[] := '{}';
  v_fats numeric[] := '{}';
  v_pros numeric[] := '{}';
  v_exps date[] := '{}';
  v_sups uuid[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_cost numeric;
  v_fat numeric;
  v_pro numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_lot uuid;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
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
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_note := public.prod_jtext(p_data, 'note', 500);

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);

  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    v_cost := public.prod_jnum(v_line, 'unit_cost', 2);
    v_fat := public.prod_jnum(v_line, 'fat_pct', 3);
    v_pro := public.prod_jnum(v_line, 'protein_pct', 3);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_cost IS NULL OR v_cost < 0
       OR (v_fat IS NOT NULL AND v_fat NOT BETWEEN 0 AND 100)
       OR (v_pro IS NOT NULL AND v_pro NOT BETWEEN 0 AND 100) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_line_total := round(v_qty * v_cost, 2);
    v_total := v_total + v_line_total;
    IF v_line_total >= 1e12 OR v_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_costs := v_costs || v_cost;
    v_fats := array_append(v_fats, v_fat);
    v_pros := array_append(v_pros, v_pro);
    v_exps := array_append(v_exps, public.prod_jdate(v_line, 'expiry_date'));
    v_sups := array_append(v_sups, public.prod_juuid(v_line, 'supplier_id'));
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id IN (SELECT DISTINCT unnest(v_item_ids)))
     <> (SELECT count(DISTINCT x) FROM unnest(v_item_ids) AS t(x)) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF (SELECT count(*) FROM public.prod_suppliers
      WHERE company_id = v_company_id AND id IN (SELECT DISTINCT x FROM unnest(v_sups) AS t(x) WHERE x IS NOT NULL))
     <> (SELECT count(DISTINCT x) FROM unnest(v_sups) AS t(x) WHERE x IS NOT NULL) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_opening_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_openings WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_openings (
    company_id, number, doc_date, warehouse_id, note, total, status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_wh, v_note, v_total, 'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_lot := public.prod_add_lot(
      v_company_id, v_wh, v_item_ids[i], v_qtys[i], v_costs[i],
      v_fats[i], v_pros[i], v_sups[i], 'opening_balance', v_id, NULL,
      COALESCE(v_exps[i], public.prod_lot_expiry(v_company_id, v_item_ids[i], v_doc_date)),
      v_doc_date, NULL
    );
    INSERT INTO public.prod_opening_items (
      company_id, opening_id, item_id, lot_id, sort_order, qty, unit_cost, total,
      fat_pct, protein_pct, expiry_date, supplier_id
    ) VALUES (
      v_company_id, v_id, v_item_ids[i], v_lot, i - 1, v_qtys[i], v_costs[i], round(v_qtys[i] * v_costs[i], 2),
      v_fats[i], v_pros[i], (SELECT expiry_date FROM public.prod_lots WHERE id = v_lot), v_sups[i]
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total);
END;
$$;

-- ═══ prod_create_price_correction (new) ══════════════════════════════════
-- prod_receipts. p_data: { receipt_id, receipt_item_id | item_id, new_price,
--   doc_date, note }. Accounting: see header "Price correction accounting".
-- Lock order: receipt row FOR UPDATE (serialises corrections of the receipt
-- and its cancellation) -> stock key (receipt warehouse, item) ->
-- 'prod_price_correction_no' -> 'prod_lot_no'.
-- Errors: receipt / line not in company -> not_found; receipt cancelled or
-- new_price = effective price -> invalid_input.
-- Returns { id, number, old_price, new_price, debt_delta, stock_qty,
--           consumed_qty, consumed_variance, stock_delta }.
CREATE OR REPLACE FUNCTION public.prod_create_price_correction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_receipt_id uuid;
  v_line_id uuid;
  v_item_id uuid;
  v_new numeric;
  v_old numeric;
  v_note text;
  v_doc_date timestamptz;
  v_r record;
  v_li record;
  v_n integer;
  v_lot record;
  v_new_lot uuid;
  v_delta numeric;
  v_stock_qty numeric := 0;
  v_stock_delta numeric := 0;
  v_consumed numeric;
  v_variance numeric;
  v_lots jsonb := '[]'::jsonb;
  v_id uuid;
  v_number integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_receipts') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_receipt_id := public.prod_juuid(p_data, 'receipt_id');
  v_line_id := public.prod_juuid(p_data, 'receipt_item_id');
  v_item_id := public.prod_juuid(p_data, 'item_id');
  v_new := public.prod_jnum(p_data, 'new_price', 2);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_doc_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());

  IF v_receipt_id IS NULL OR (v_line_id IS NULL AND v_item_id IS NULL)
     OR v_new IS NULL OR v_new < 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, status, warehouse_id, supplier_id INTO v_r
  FROM public.prod_receipts
  WHERE id = v_receipt_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.status <> 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT count(*) INTO v_n
  FROM public.prod_receipt_items ri
  WHERE ri.receipt_id = v_r.id AND ri.company_id = v_company_id
    AND (v_line_id IS NULL OR ri.id = v_line_id)
    AND (v_item_id IS NULL OR ri.item_id = v_item_id);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT ri.id, ri.item_id, ri.qty, ri.price INTO v_li
  FROM public.prod_receipt_items ri
  WHERE ri.receipt_id = v_r.id AND ri.company_id = v_company_id
    AND (v_line_id IS NULL OR ri.id = v_line_id)
    AND (v_item_id IS NULL OR ri.item_id = v_item_id);

  -- Effective price = latest posted correction of the line, else the line.
  v_old := COALESCE((
    SELECT c.new_price FROM public.prod_price_corrections c
    WHERE c.company_id = v_company_id AND c.receipt_item_id = v_li.id AND c.status = 'posted'
    ORDER BY c.number DESC
    LIMIT 1
  ), v_li.price);
  IF v_new = v_old THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_delta := round((v_new - v_old) * v_li.qty, 2);
  IF abs(v_delta) >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_lock_stock(v_company_id, v_r.warehouse_id, ARRAY[v_li.item_id]);

  v_id := gen_random_uuid();

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_price_correction_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_price_corrections WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_price_corrections (
    id, company_id, number, doc_date, receipt_id, receipt_item_id, item_id, warehouse_id, supplier_id,
    qty, old_price, new_price, debt_delta, note, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_r.id, v_li.id, v_li.item_id, v_r.warehouse_id, v_r.supplier_id,
    v_li.qty, v_old, v_new, v_delta, v_note, 'posted', auth.uid(), v_user_name
  );

  -- Revalue every lot of the line still holding stock in the receipt
  -- warehouse (the receipt lot + lots of earlier posted corrections). The
  -- cursor snapshot is taken at loop start: lots created inside are not
  -- revisited.
  FOR v_lot IN
    SELECT x.*
    FROM (
      SELECT l.id, l.lot_no, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id, l.expiry_date,
             l.received_at, l.hold_status, l.hold_reason, l.hold_at, l.hold_by,
             l.opening_qty + COALESCE((
               SELECT sum(m.qty) FROM public.prod_stock_movements m
               WHERE m.lot_id = l.id AND m.company_id = l.company_id
             ), 0) AS remaining
      FROM public.prod_lots l
      WHERE l.company_id = v_company_id
        AND l.warehouse_id = v_r.warehouse_id
        AND l.item_id = v_li.item_id
        AND (
          (l.source_doc_type = 'receipt' AND l.source_doc_id = v_r.id)
          OR (l.source_doc_type = 'price_correction' AND l.source_doc_id IN (
                SELECT c.id FROM public.prod_price_corrections c
                WHERE c.company_id = v_company_id AND c.receipt_item_id = v_li.id
                  AND c.status = 'posted' AND c.id <> v_id))
        )
    ) x
    WHERE x.remaining > 0
    ORDER BY length(x.lot_no), x.lot_no
  LOOP
    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
      fat_pct, protein_pct, lot_id
    ) VALUES (
      v_company_id, v_r.warehouse_id, v_li.item_id, -v_lot.remaining, v_lot.unit_cost, 'price_correction', v_id,
      false, auth.uid(), v_lot.fat_pct, v_lot.protein_pct, v_lot.id
    );

    v_new_lot := public.prod_add_lot(
      v_company_id, v_r.warehouse_id, v_li.item_id, v_lot.remaining, v_new,
      v_lot.fat_pct, v_lot.protein_pct, v_lot.supplier_id, 'price_correction', v_id, v_lot.id,
      v_lot.expiry_date, v_lot.received_at, NULL
    );
    UPDATE public.prod_lots
    SET hold_status = v_lot.hold_status, hold_reason = v_lot.hold_reason,
        hold_at = v_lot.hold_at, hold_by = v_lot.hold_by
    WHERE id = v_new_lot AND company_id = v_company_id;

    v_stock_qty := v_stock_qty + v_lot.remaining;
    v_stock_delta := v_stock_delta + round(v_lot.remaining * v_new, 2) - round(v_lot.remaining * v_lot.unit_cost, 2);
    v_lots := v_lots || jsonb_build_array(jsonb_build_object(
      'old_lot_id', v_lot.id, 'new_lot_id', v_new_lot, 'qty', v_lot.remaining, 'old_unit_cost', v_lot.unit_cost
    ));
  END LOOP;

  v_consumed := GREATEST(v_li.qty - v_stock_qty, 0);
  v_variance := round((v_new - v_old) * v_consumed, 2);

  UPDATE public.prod_price_corrections
  SET stock_qty = v_stock_qty,
      stock_delta = v_stock_delta,
      consumed_qty = v_consumed,
      consumed_variance = v_variance,
      lots = v_lots
  WHERE id = v_id AND company_id = v_company_id;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'old_price', v_old, 'new_price', v_new,
    'debt_delta', v_delta, 'stock_qty', v_stock_qty, 'consumed_qty', v_consumed,
    'consumed_variance', v_variance, 'stock_delta', v_stock_delta
  );
END;
$$;

-- ═══ prod_cancel_receipt_internal (internal, replaced, same signature) ═══
-- Body copied from 20261110000013. ONLY addition: a receipt with a posted
-- price correction -> invalid_input DETAIL 'has_price_correction'.
CREATE OR REPLACE FUNCTION public.prod_cancel_receipt_internal(p_company_id uuid, p_receipt_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_company_id IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT status INTO v_status FROM public.prod_receipts
  WHERE id = p_receipt_id AND company_id = p_company_id FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.prod_price_corrections
    WHERE company_id = p_company_id AND receipt_id = p_receipt_id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'has_price_correction';
  END IF;

  PERFORM public.prod_reverse_document(p_company_id, 'receipt', p_receipt_id);

  UPDATE public.prod_receipts
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_receipt_id AND company_id = p_company_id;
END;
$$;

-- ═══ prod_amend_milk_lab (new) ═══════════════════════════════════════════
-- prod_lab (same as prod_record_milk_lab). Only for an accepted /
-- conditional intake (cancelled -> already_cancelled, else invalid_input)
-- whose receipt lot is untouched: remaining = net_kg (else invalid_input
-- DETAIL 'lot_used'; a legacy intake without a lot is refused the same way)
-- and no posted price correction (DETAIL 'has_price_correction').
-- Steps: intake row FOR UPDATE -> receipt row FOR UPDATE -> stock key ->
-- check -> prod_cancel_receipt_internal (1:1 reversal, receipt cancelled)
-- -> intake reset to 'weighed' -> prod_milk_apply_lab (new lab values, new
-- pricing, new receipt + lot; 'prod_receipt_no' -> 'prod_lot_no') ->
-- lab_amended_at = now(), lab_amend_count + 1. The new decision may be
-- accepted / conditional / rejected (rejected = no stock, no debt).
-- p_lab: same object as prod_record_milk_lab.
-- Returns prod_milk_apply_lab's object + { lab_amend_count, previous_receipt_id }.
CREATE OR REPLACE FUNCTION public.prod_amend_milk_lab(p_intake_id uuid, p_lab jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_in record;
  v_receipt_status text;
  v_lot uuid;
  v_rem numeric;
  v_res jsonb;
  v_count integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_lab') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_intake_id IS NULL OR p_lab IS NULL OR jsonb_typeof(p_lab) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, status, receipt_id, warehouse_id, item_id, net_kg INTO v_in
  FROM public.prod_milk_intakes
  WHERE id = p_intake_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_in.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_in.status NOT IN ('accepted', 'conditional') OR v_in.receipt_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT status INTO v_receipt_status
  FROM public.prod_receipts
  WHERE id = v_in.receipt_id AND company_id = v_company_id
  FOR UPDATE;
  IF v_receipt_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.prod_price_corrections
    WHERE company_id = v_company_id AND receipt_id = v_in.receipt_id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'has_price_correction';
  END IF;

  PERFORM public.prod_lock_stock(v_company_id, v_in.warehouse_id, ARRAY[v_in.item_id]);

  SELECT l.id INTO v_lot
  FROM public.prod_lots l
  WHERE l.company_id = v_company_id AND l.source_doc_type = 'receipt'
    AND l.source_doc_id = v_in.receipt_id AND l.item_id = v_in.item_id;
  IF v_lot IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'lot_used';
  END IF;
  v_rem := public.prod_lot_remaining(v_company_id, v_lot);
  IF v_rem IS DISTINCT FROM v_in.net_kg THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'lot_used';
  END IF;

  PERFORM public.prod_cancel_receipt_internal(v_company_id, v_in.receipt_id);

  -- Back to 'weighed' (receipt_status CHECK: weighed has no receipt).
  UPDATE public.prod_milk_intakes
  SET status = 'weighed',
      receipt_id = NULL,
      pricing_mode = NULL,
      base_price_per_kg = NULL,
      credited_kg = NULL,
      price_per_kg = NULL,
      amount = NULL
  WHERE id = p_intake_id AND company_id = v_company_id;

  v_res := public.prod_milk_apply_lab(v_company_id, p_intake_id, p_lab);

  UPDATE public.prod_milk_intakes
  SET lab_amended_at = now(),
      lab_amend_count = lab_amend_count + 1
  WHERE id = p_intake_id AND company_id = v_company_id
  RETURNING lab_amend_count INTO v_count;

  RETURN v_res || jsonb_build_object('lab_amend_count', v_count, 'previous_receipt_id', v_in.receipt_id);
END;
$$;

-- ═══ prod_create_transfer (replaced, same signature) ═════════════════════
-- Body copied from 20261110000013. Changes:
--   * prod_consume hold mode 'pick': FEFO never takes held / blocked lots,
--     an explicit items[i].lots pick may (quarantine moves).
--   * destination lots copy the source lot's hold_status / reason / at / by.
CREATE OR REPLACE FUNCTION public.prod_create_transfer(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_from_id uuid;
  v_to_id uuid;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_costs numeric[] := '{}';
  v_totals numeric[] := '{}';
  v_picks jsonb[] := '{}';
  v_results jsonb[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_rec record;
  v_res jsonb;
  v_used jsonb;
  v_src record;
  v_new_lot uuid;
  v_line_total numeric;
  v_total numeric := 0;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
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
  v_from_id := public.prod_juuid(p_data, 'from_warehouse_id');
  v_to_id := public.prod_juuid(p_data, 'to_warehouse_id');
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_from_id IS NULL OR v_to_id IS NULL OR v_from_id = v_to_id THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_from_id);
  PERFORM public.prod_require_warehouse(v_company_id, v_to_id);

  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_picks := array_append(v_picks, v_line->'lots');
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  FOR v_rec IN
    SELECT it.item_id, wh.warehouse_id
    FROM unnest(v_item_ids) AS it(item_id)
    CROSS JOIN unnest(ARRAY[v_from_id, v_to_id]) AS wh(warehouse_id)
    ORDER BY it.item_id, wh.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(v_company_id, v_rec.warehouse_id, ARRAY[v_rec.item_id]);
  END LOOP;

  v_id := gen_random_uuid();

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_from_id, v_item_ids[i], v_qtys[i],
                                 'transfer', v_id, v_picks[i], 'pick');
    v_line_total := (v_res->>'cost')::numeric;
    v_results := array_append(v_results, v_res);
    v_totals := v_totals || v_line_total;
    v_costs := v_costs || round(v_line_total / v_qtys[i], 2);
    v_total := v_total + v_line_total;
    IF v_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_transfer_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_transfers WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_transfers (
    id, company_id, number, doc_date, from_warehouse_id, to_warehouse_id, note, total,
    status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_from_id, v_to_id, v_note, v_total,
    'posted', auth.uid(), v_user_name
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_transfer_items (company_id, transfer_id, item_id, qty, unit_cost, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], v_totals[i]);

    FOR v_used IN SELECT * FROM jsonb_array_elements(v_results[i]->'lots')
    LOOP
      SELECT l.id, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id, l.expiry_date, l.received_at,
             l.hold_status, l.hold_reason, l.hold_at, l.hold_by
      INTO v_src
      FROM public.prod_lots l
      WHERE l.id = (v_used->>'lot_id')::uuid AND l.company_id = v_company_id;

      v_new_lot := public.prod_add_lot(
        v_company_id, v_to_id, v_item_ids[i], (v_used->>'qty')::numeric, v_src.unit_cost,
        v_src.fat_pct, v_src.protein_pct, v_src.supplier_id, 'transfer', v_id, v_src.id,
        v_src.expiry_date, v_src.received_at, NULL
      );
      IF v_src.hold_status <> 'free' THEN
        UPDATE public.prod_lots
        SET hold_status = v_src.hold_status, hold_reason = v_src.hold_reason,
            hold_at = v_src.hold_at, hold_by = v_src.hold_by
        WHERE id = v_new_lot AND company_id = v_company_id;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total);
END;
$$;

-- ═══ prod_change_item_unit (replaced, same signature) ════════════════════
-- Body copied from 20261110000013. Additions: new lots inherit the old
-- lot's hold; every recipe rewritten here is snapshotted into
-- prod_recipe_versions (its new version).
CREATE OR REPLACE FUNCTION public.prod_change_item_unit(
  p_item_id uuid, p_new_unit text, p_factor numeric, p_note text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_user_name text;
  v_old_unit text;
  v_conv_id uuid;
  v_wh record;
  v_lot record;
  v_recipe record;
  v_new_qty numeric;
  v_new_cost numeric;
  v_new_lot uuid;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_catalog') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT role, full_name INTO v_role, v_user_name FROM public.users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_item_id IS NULL OR p_new_unit IS NULL
     OR p_new_unit NOT IN ('kg', 'l', 'g', 'pcs', 'm')
     OR p_factor IS NULL OR p_factor <= 0 OR p_factor > 1000000
     OR (p_note IS NOT NULL AND char_length(p_note) > 500) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT unit INTO v_old_unit
  FROM public.prod_items
  WHERE id = p_item_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_old_unit = p_new_unit THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.prod_unit_conversions (company_id, item_id, old_unit, new_unit, factor, note, created_by, created_by_name)
  VALUES (v_company_id, p_item_id, v_old_unit, p_new_unit, p_factor, NULLIF(btrim(p_note), ''), auth.uid(), v_user_name)
  RETURNING id INTO v_conv_id;

  FOR v_wh IN
    SELECT DISTINCT l.warehouse_id
    FROM public.prod_lots l
    WHERE l.company_id = v_company_id AND l.item_id = p_item_id
    ORDER BY l.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(v_company_id, v_wh.warehouse_id, ARRAY[p_item_id]);
  END LOOP;

  FOR v_lot IN
    SELECT x.*
    FROM (
      SELECT l.id, l.warehouse_id, l.lot_no, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id,
             l.expiry_date, l.received_at, l.hold_status, l.hold_reason, l.hold_at, l.hold_by,
             l.opening_qty + COALESCE((
               SELECT sum(m.qty) FROM public.prod_stock_movements m
               WHERE m.lot_id = l.id AND m.company_id = l.company_id
             ), 0) AS remaining
      FROM public.prod_lots l
      WHERE l.company_id = v_company_id AND l.item_id = p_item_id
    ) x
    WHERE x.remaining <> 0
    ORDER BY x.warehouse_id, length(x.lot_no), x.lot_no
  LOOP
    IF v_lot.remaining < 0 THEN
      RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p_item_id::text;
    END IF;

    v_new_qty := round(v_lot.remaining * p_factor, 3);
    IF v_new_qty <= 0 OR v_new_qty >= 1e11 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_new_cost := round(v_lot.unit_cost / p_factor, 2);
    IF v_new_cost >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
      fat_pct, protein_pct, lot_id
    ) VALUES (
      v_company_id, v_lot.warehouse_id, p_item_id, -v_lot.remaining, v_lot.unit_cost, 'conversion', v_conv_id, false, auth.uid(),
      v_lot.fat_pct, v_lot.protein_pct, v_lot.id
    );

    v_new_lot := public.prod_add_lot(
      v_company_id, v_lot.warehouse_id, p_item_id, v_new_qty, v_new_cost,
      v_lot.fat_pct, v_lot.protein_pct, v_lot.supplier_id, 'conversion', v_conv_id, v_lot.id,
      v_lot.expiry_date, v_lot.received_at, NULL
    );
    IF v_lot.hold_status <> 'free' THEN
      UPDATE public.prod_lots
      SET hold_status = v_lot.hold_status, hold_reason = v_lot.hold_reason,
          hold_at = v_lot.hold_at, hold_by = v_lot.hold_by
      WHERE id = v_new_lot AND company_id = v_company_id;
    END IF;
  END LOOP;

  UPDATE public.prod_recipe_lines l
  SET qty = GREATEST(round(l.qty * p_factor, 4), 0.0001)
  WHERE l.company_id = v_company_id AND l.item_id = p_item_id;

  UPDATE public.prod_recipes r
  SET version = r.version + 1, updated_at = now()
  WHERE r.company_id = v_company_id
    AND EXISTS (SELECT 1 FROM public.prod_recipe_lines l WHERE l.recipe_id = r.id AND l.item_id = p_item_id);

  UPDATE public.prod_recipes r
  SET output_qty = GREATEST(round(r.output_qty * p_factor, 4), 0.0001),
      version = r.version + 1, updated_at = now()
  WHERE r.company_id = v_company_id AND r.item_id = p_item_id;

  -- NEW: version history of every rewritten recipe.
  FOR v_recipe IN
    SELECT r.id
    FROM public.prod_recipes r
    WHERE r.company_id = v_company_id
      AND (r.item_id = p_item_id
           OR EXISTS (SELECT 1 FROM public.prod_recipe_lines l
                      WHERE l.recipe_id = r.id AND l.company_id = r.company_id AND l.item_id = p_item_id))
    ORDER BY r.id
  LOOP
    PERFORM public.prod_recipe_snapshot(v_company_id, v_recipe.id);
  END LOOP;

  UPDATE public.prod_items
  SET unit = p_new_unit,
      min_stock = CASE WHEN min_stock IS NULL THEN NULL ELSE round(min_stock * p_factor, 3) END,
      max_stock = CASE WHEN max_stock IS NULL THEN NULL ELSE round(max_stock * p_factor, 3) END,
      updated_at = now()
  WHERE id = p_item_id AND company_id = v_company_id;

  RETURN v_conv_id;
END;
$$;

-- ═══ prod_cancel_document (replaced, same signature) ═════════════════════
-- Body copied from 20261110000013. Additions:
--   * new types: writeoff (prod_stock), stock_count (prod_stock; only a
--     POSTED count, a draft -> invalid_input: delete it instead),
--     opening_balance (prod_stock), price_correction (prod_receipts).
--   * price_correction: receipt row FOR UPDATE BEFORE the correction row
--     (same order as prod_create_price_correction); only the latest posted
--     correction of its line (else invalid_input DETAIL 'not_latest').
--   * receipt: a posted price correction -> invalid_input DETAIL
--     'has_price_correction' (checked after the milk-intake guard).
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
  ELSE
    UPDATE public.prod_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated. Internal ones closed.

REVOKE EXECUTE ON FUNCTION public.prod_cancel_receipt_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.prod_save_item(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_warehouse(uuid, text, text[], boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_recipe(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_set_lot_hold(uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_writeoff(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_stock_count(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_post_stock_count(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_delete_stock_count_draft(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_opening(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_price_correction(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_amend_milk_lab(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_change_item_unit(uuid, text, numeric, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_item(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_warehouse(uuid, text, text[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_recipe(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_set_lot_hold(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_writeoff(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_stock_count(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_post_stock_count(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_delete_stock_count_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_opening(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_price_correction(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_amend_milk_lab(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_change_item_unit(uuid, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on every new table:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_writeoffs', 'prod_writeoff_items', 'prod_stock_counts', 'prod_stock_count_items',
--                     'prod_openings', 'prod_opening_items', 'prod_price_corrections', 'prod_recipe_versions')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_writeoffs', 'prod_writeoff_items', 'prod_stock_counts', 'prod_stock_count_items',
--                      'prod_openings', 'prod_opening_items', 'prod_price_corrections', 'prod_recipe_versions',
--                      'prod_supplier_ageing', 'prod_supplier_balances', 'prod_lot_stock');
-- -- which duplicate indexes were created:
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
--   AND indexname IN ('prod_items_company_name_ci_key', 'prod_items_company_sku_key',
--                     'prod_items_company_barcode_key', 'prod_suppliers_company_name_ci_key');
-- -- ageing balance = balances debt (expect 0 rows):
-- SELECT a.supplier_id FROM public.prod_supplier_ageing a
-- JOIN public.prod_supplier_balances b ON b.supplier_id = a.supplier_id WHERE a.balance <> b.debt;
