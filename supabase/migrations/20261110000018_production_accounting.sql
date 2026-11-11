-- Production wave 7: accounting core (purchase VAT, co-products, overhead /
-- full costing, P&L, server-side report aggregation).
--
-- Why: the plant had stock values and cash, but no books on top of them.
-- Purchase VAT was neither recorded nor separated from the stock cost
-- (audit 21), a run with several outputs (cheese + whey, butter + buttermilk)
-- had to put the whole cost on one item (audit 26), overhead (labour,
-- energy, rent ...) never reached a product cost (audit 16), there was no
-- profit and loss statement (audit group 1 / 2), and every report paged
-- raw ledger rows into the browser (performance).
--
-- This file adds / changes:
--   1) prod_company_accounting   one row per company: vat_payer,
--                                base_currency ('UZS'), overhead_method
--   2) purchase VAT              receipt lines vat_rate / vat_amount,
--                                receipts prices_include_vat /
--                                vat_deductible / vat_total, corrections
--                                vat_delta; view prod_vat_summary
--   3) co-products               prod_production_outputs (+ backfill),
--                                prod_recipe_outputs, prod_productions
--                                .allocation_method
--   4) overhead                  prod_cost_pools, prod_overhead_allocations,
--                                views prod_product_costs_month,
--                                prod_cost_pool_suggestions
--   5) P&L                       prod_pnl
--   6) reports                   prod_report_turnover, prod_report_dashboard,
--                                prod_report_sales (+ 2 indexes)
--
-- Objects:
--   NEW tables:  prod_company_accounting, prod_production_outputs,
--                prod_recipe_outputs, prod_cost_pools,
--                prod_overhead_allocations
--   NEW columns: prod_receipts.prices_include_vat boolean NOT NULL DEFAULT
--                false, .vat_deductible boolean NOT NULL DEFAULT false,
--                .vat_total numeric(14,2) NOT NULL DEFAULT 0;
--                prod_receipt_items.vat_rate numeric(5,2) NOT NULL DEFAULT 0,
--                .vat_amount numeric(14,2) NOT NULL DEFAULT 0;
--                prod_price_corrections.vat_delta numeric(14,2) NOT NULL
--                DEFAULT 0; prod_productions.allocation_method text NOT NULL
--                DEFAULT 'mass'
--   NEW views:   prod_vat_summary, prod_product_costs_month,
--                prod_cost_pool_suggestions (security_invoker)
--   NEW internal helpers (EXECUTE revoked from every client role):
--                prod_acct_settings, prod_vat_split, prod_vat_unit_cost,
--                prod_qty_kg, prod_day_start, prod_overhead_guard
--   NEW RPCs:    prod_save_accounting_settings(jsonb),
--                prod_save_recipe_outputs(uuid, jsonb),
--                prod_save_cost_pool(uuid, jsonb), prod_cancel_cost_pool(uuid),
--                prod_allocate_overhead(date, jsonb DEFAULT NULL),
--                prod_pnl(date, date, text DEFAULT 'month'),
--                prod_report_turnover(date, date, uuid DEFAULT NULL, uuid DEFAULT NULL),
--                prod_report_dashboard(date, date, text DEFAULT 'day'),
--                prod_report_sales(date, date, text DEFAULT 'product')
--   REPLACED (same signatures and return shapes; new OPTIONAL keys only):
--                prod_create_receipt              (latest = 17)
--                prod_create_price_correction     (latest = 17)
--                prod_create_production           (latest = 17)
--                prod_audit_trigger (trigger fn)  (latest = 17)
--   NEW triggers: prod_audit (17's audit trigger) on prod_company_accounting,
--                prod_recipe_outputs, prod_cost_pools
--   NOT changed: has_permission (no new key: settings use 'sozlamalar' +
--     role owner; pools / allocation / P&L 'prod_stock' + role owner /
--     admin; recipe by-products 'prod_catalog'; reports their module key),
--     prod_cancel_document (it already reverses every movement of a
--     production, i.e. every output lot), supplier balance / ageing views
--     (they sum receipts.total and corrections.debt_delta, which are now
--     GROSS incl. VAT -> supplier debt stays correct without a change).
--
-- ── VAT (audit 21) ────────────────────────────────────────────────────────
--   Line amounts (prod_vat_split, rate r, qty q, entered price p):
--     r = 0:                 gross = round(q * p, 2), vat = 0 (old formula)
--     prices WITHOUT VAT:    net = round(q * p, 2), vat = round(net * r / 100, 2),
--                            gross = net + vat
--     prices WITH VAT:       gross = round(q * p, 2),
--                            vat = round(gross * r / (100 + r), 2), net = gross - vat
--   prod_receipt_items.price = the entered price, .total = gross (supplier
--   debt), .vat_amount = vat; prod_receipts.total = sum(gross), .vat_total =
--   sum(vat), .vat_deductible = company vat_payer at posting.
--   Lot unit cost (prod_vat_unit_cost): r = 0 -> p; deductible -> unit price
--   WITHOUT VAT (p, or round(p * 100 / (100 + r), 2) when p includes VAT);
--   not deductible -> unit price WITH VAT (p, or round(p * (100 + r) / 100, 2)).
--   Price correction (new_price in the receipt's price basis, line rate):
--     r = 0: unchanged (debt_delta = round((new - old) * qty, 2));
--     r > 0: debt_delta = gross(new) - gross(old), vat_delta = vat(new) - vat(old);
--     revaluation lots / stock_delta / consumed_variance use the lot cost of
--     the price (ex VAT when deductible).
--   prod_vat_summary (per company, business month): output_vat = sales
--   vat_amount - return vat_amount; input_vat = vat_total of deductible
--   receipts + vat_delta of their corrections (correction month); payable =
--   output - input. Posted documents only. Milk-intake receipts carry rate 0.
--
-- ── Co-products (audit 26) ────────────────────────────────────────────────
--   prod_create_production: optional outputs [{item_id, qty,
--   output_warehouse_id?, share_pct?, ref_price?}] (1..20, outputs[0] =
--   main); absent = the old single output. Weights w_i by
--   allocation_method: 'mass' (default) kg-equivalent of qty (kg, g / 1000,
--   pcs / l * weight_kg; missing -> invalid_input 'output_weight'); 'value'
--   ref_price (else item sale_price) * qty (missing -> 'ref_price'); 'fixed'
--   share_pct, sum exactly 100 ('share_pct'). One output: w = 1.
--   cost_i = round(total * w_i / sum w, 2), the LAST output takes the
--   remainder (total - sum of the others), lot unit cost = round(cost_i /
--   qty_i, 2) (as before, the lot value qty * unit_cost may differ from
--   cost_i by the unit-cost rounding). Each output -> own lot + a
--   prod_production_outputs row. Header columns keep the main output
--   (output_item_id / output_qty / unit_cost); total_cost = whole material
--   cost. Yield rule of 17 = main output only. Existing productions are
--   backfilled with one output row (cost = total_cost, share 100).
--   prod_recipe_outputs (by-products of a recipe) are a template for the
--   client only; they are not part of the recipe version snapshot.
--
-- ── Overhead / full costing (audit 16) ────────────────────────────────────
--   prod_cost_pools: monthly amounts by category (labour, energy, gas,
--   water, rent, depreciation, repair, other), optionally tied to the
--   expense category they were taken from (one posted pool per month and
--   expense category). prod_cost_pool_suggestions shows per month and
--   expense category the posted cash orders 'out' + posted supply expenses
--   (the user confirms by saving a pool).
--   prod_allocate_overhead(month): pool total T of the month to the outputs
--   of the month's POSTED productions: per_kg (kg-equivalent; outputs
--   without one are skipped), per_value (material cost), manual (amounts
--   given, sum = T). amount_i = round(T * base_i / sum base, 2), last output
--   takes the remainder. A re-run replaces the month; saving / cancelling a
--   pool clears the month's allocation (re-run needed); cancelling a
--   production leaves its rows but prod_product_costs_month counts posted
--   productions only (re-run to re-spread). Refused for a month touched by
--   the 17 period lock (locked_until >= month start -> 'period_closed').
--   INVENTORY STAYS AT MATERIAL COST: lots and movements are NOT revalued;
--   the allocation feeds prod_product_costs_month (qty, material_cost,
--   overhead, full_cost, material_unit_cost, full_unit_cost) only, and the
--   whole pool is a period expense in prod_pnl.
--
-- ── P&L (prod_pnl) ────────────────────────────────────────────────────────
--   Posted documents only, each on its business date (Asia/Tashkent):
--   revenue           = sum(sales.subtotal) - sum(sale_returns.subtotal)   (ex VAT)
--   cogs              = sum(sales.cost_total)
--                       - sum(sale_returns.cost_total - sale_returns.loss_cost)
--                         (cost of the restocked return lines)
--   gross_profit      = revenue - cogs
--   writeoffs         = sum(writeoffs.total_cost) + sum(stock_counts.shortage_value)
--                       - sum(stock_counts.surplus_value) + sum(sale_returns.loss_cost)
--   production_losses = sum(processings.processing_cost - processings.recovery_cost)
--                       (value lost (or gained, negative) when a source is
--                       processed into outputs at their price)
--   price_variance    = sum(price_corrections.consumed_variance)
--   overhead          = posted cost pools, each spread evenly over the days
--                       of its month (a full month = the pool amount; a
--                       partial range = pro rata by days)
--   other_expenses    = sum(cash_orders.amount, direction 'out')
--                       + sum(supply_cash_moves.amount, kind 'expense')
--                       EXCLUDING the rows whose (business month, expense
--                       category) is used by a posted pool (no double count;
--                       uncategorised rows always count)
--   operating_profit  = gross_profit - writeoffs - production_losses
--                       - price_variance - overhead - other_expenses
--   separation_loss_value (memo, NOT subtracted) = sum(round(milk_cost *
--     loss_qty / milk_qty, 2)) of separations: the separation loss has no
--     own value in the ledger (12: absorbed into the cream / skim cost), so
--     it is already inside cogs / stock; subtracting it would count it twice.
--   Buckets: day / week (ISO, Monday) / month / total; every row has the
--   numbers above, total = sum of the rows (each row rounded to 2) and
--   detail arrays {kind, ref, name, amount} per metric (revenue: sales /
--   returns; cogs: sales / returns_restocked; writeoffs: writeoff (ref =
--   reason) / count_shortage / count_surplus / return_loss;
--   production_losses: processing; price_variance: price_correction;
--   overhead: pool category; other_expenses: cash_order / supply_expense,
--   ref = expense category id, name = its name).
--
-- ── Reports ───────────────────────────────────────────────────────────────
--   prod_report_turnover = aggregateTurnover of lib/production-reports.ts on
--   the server (lot-bearing movements + opening lots by created_at;
--   reversals net in their own direction). prod_report_dashboard: per-day /
--   per-month series (revenue, cogs, margin, milk kg, avg fat, output kg incl.
--   co-products, cash balance), totals + previous-period totals, sales by
--   group, stock by warehouse, outflows by category; each section only for
--   its permission, cogs / margin only for owner / admin. prod_report_sales:
--   by product / customer / group / day / month. All SECURITY DEFINER with
--   explicit company scope (the views they read are filtered by company_id).
--
-- ── Lock order (extends 17) ───────────────────────────────────────────────
--   Receipt / correction / production: unchanged (the accounting settings
--   row is read without a lock; production locks ALL output item rows FOR
--   SHARE where 17 locked the one output item). Pools: pool row FOR UPDATE
--   -> period row FOR SHARE (prod_assert_date) -> advisory
--   'prod_overhead:<company>:<month>'. Allocation: period row FOR SHARE ->
--   the same advisory lock (waits for in-flight pool changes).
--   prod_save_accounting_settings: settings row FOR UPDATE only.
--   prod_save_recipe_outputs: recipe row FOR UPDATE (like prod_save_recipe).
--
-- ── Destructive / blocking statements ─────────────────────────────────────
--   No DROP, no row deleted or rewritten. DML: seed INSERT of
--   prod_company_accounting (production-enabled companies) and backfill
--   INSERT of one prod_production_outputs row per existing production.
--   ALTER TABLE ADD COLUMN with constant defaults (metadata only) on
--   prod_receipts, prod_receipt_items, prod_price_corrections,
--   prod_productions; ADD CONSTRAINT CHECK on prod_receipts /
--   prod_receipt_items / prod_productions validates existing rows (all 0 /
--   default) under a brief ACCESS EXCLUSIVE lock until COMMIT. CREATE INDEX
--   (not CONCURRENTLY, inside the transaction) on prod_stock_movements and
--   prod_lots blocks writes to them while it builds (seconds at the current
--   volume). Runtime: saving / cancelling a pool and re-running an
--   allocation DELETE that month's prod_overhead_allocations rows (derived
--   data, recomputed by prod_allocate_overhead).
--
-- ── Behaviour change for existing clients ─────────────────────────────────
--   None for the current client: it sends no vat_rate (rate 0 = the old
--   amounts and lot costs) and no outputs (single output = the old
--   production). New optional return keys only (receipt: total, vat_total;
--   correction: vat_delta; production: allocation_method, outputs).
--
-- Client deploy: the migration is SAFE alone (no signature / shape change,
-- no new required input). The new features need client work: "Frontend
-- contract" in the spec (VAT fields on receipts, co-product editor,
-- accounting settings, pools / allocation / full-cost screens, P&L, and the
-- server-side report RPCs replacing the client-side paging).
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) New tables ────────────────────────────────────────────────────────
-- Access model (all five): company_id NOT NULL -> companies ON DELETE
-- CASCADE; RLS on with ONE SELECT policy (company members); REVOKE ALL from
-- authenticated + anon right after CREATE (Supabase default-grant leak),
-- GRANT SELECT to authenticated. Writes ONLY via the SECURITY DEFINER RPCs
-- below (RPC-only write access).

-- 1a) Accounting settings: one row per company (seeded below for every
-- production-enabled company, created lazily by prod_acct_settings()
-- otherwise). Owner-edited through prod_save_accounting_settings.
CREATE TABLE public.prod_company_accounting (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  vat_payer boolean NOT NULL DEFAULT false,
  base_currency text NOT NULL DEFAULT 'UZS',
  overhead_method text NOT NULL DEFAULT 'per_kg',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_company_accounting_currency_check CHECK (base_currency = 'UZS'),
  CONSTRAINT prod_company_accounting_overhead_method_check CHECK (overhead_method IN ('per_kg', 'per_value', 'manual'))
);
REVOKE ALL ON public.prod_company_accounting FROM authenticated, anon;

COMMENT ON TABLE public.prod_company_accounting IS
  'Production accounting settings (one row per company): VAT payer, base currency, overhead allocation '
  'method. Read via RLS (company members); write ONLY via prod_save_accounting_settings (owner). Changes '
  'are in prod_audit_log (action settings).';

-- 1b) Outputs of a production run (main output + co-/by-products). One row
-- per output; the main output (sort_order 0) is also kept in
-- prod_productions.output_item_id / output_qty / unit_cost (backward
-- compatibility). Backfilled below for every existing production.
CREATE TABLE public.prod_production_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  production_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  item_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL,
  share_pct numeric(9,6) NOT NULL,
  ref_price numeric(14,2) NULL,
  cost numeric(14,2) NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  lot_id uuid NULL,
  CONSTRAINT prod_production_outputs_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_production_outputs_production_item_key UNIQUE (production_id, item_id),
  CONSTRAINT prod_production_outputs_production_fk FOREIGN KEY (production_id, company_id)
    REFERENCES public.prod_productions (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_production_outputs_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_production_outputs_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_production_outputs_lot_fk FOREIGN KEY (lot_id, company_id)
    REFERENCES public.prod_lots (id, company_id),
  CONSTRAINT prod_production_outputs_sort_check CHECK (sort_order >= 0),
  CONSTRAINT prod_production_outputs_qty_check CHECK (qty > 0),
  CONSTRAINT prod_production_outputs_share_check CHECK (share_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_production_outputs_ref_price_check CHECK (ref_price IS NULL OR ref_price >= 0),
  CONSTRAINT prod_production_outputs_cost_check CHECK (cost >= 0 AND unit_cost >= 0)
);
REVOKE ALL ON public.prod_production_outputs FROM authenticated, anon;

COMMENT ON TABLE public.prod_production_outputs IS
  'Outputs of a production run (main + co-products): qty, allocated material cost, unit (lot) cost, lot. '
  'Read via RLS; written ONLY by prod_create_production.';

CREATE INDEX prod_production_outputs_production_idx ON public.prod_production_outputs (production_id, company_id);
CREATE INDEX prod_production_outputs_item_idx ON public.prod_production_outputs (item_id, company_id);

-- 1c) By-products listed on a recipe (optional; the production yield rule
-- of 20261110000017 checks the MAIN output only).
CREATE TABLE public.prod_recipe_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty_per_batch numeric(14,4) NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT prod_recipe_outputs_recipe_item_key UNIQUE (recipe_id, item_id),
  CONSTRAINT prod_recipe_outputs_recipe_fk FOREIGN KEY (recipe_id, company_id)
    REFERENCES public.prod_recipes (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_recipe_outputs_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_recipe_outputs_qty_check CHECK (qty_per_batch > 0),
  CONSTRAINT prod_recipe_outputs_sort_check CHECK (sort_order >= 0)
);
REVOKE ALL ON public.prod_recipe_outputs FROM authenticated, anon;

COMMENT ON TABLE public.prod_recipe_outputs IS
  'By-products of a recipe (per recipe batch = prod_recipes.output_qty of the main item). Read via RLS; '
  'write ONLY via prod_save_recipe_outputs.';

CREATE INDEX prod_recipe_outputs_recipe_idx ON public.prod_recipe_outputs (recipe_id, company_id);
CREATE INDEX prod_recipe_outputs_item_idx ON public.prod_recipe_outputs (item_id, company_id);

-- 1d) Monthly overhead cost pools (period = first day of the month).
-- expense_category_id: the cash / supply expense category the pool was
-- taken from; cash orders 'out' and supply expenses of that category in
-- that month are then NOT counted again as other expenses in prod_pnl.
CREATE TABLE public.prod_cost_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period date NOT NULL,
  category text NOT NULL,
  amount numeric(14,2) NOT NULL,
  expense_category_id uuid NULL REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_cost_pools_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_cost_pools_period_check CHECK (extract(day FROM period) = 1),
  CONSTRAINT prod_cost_pools_category_check CHECK (category IN (
    'labour', 'energy', 'gas', 'water', 'rent', 'depreciation', 'repair', 'other'
  )),
  CONSTRAINT prod_cost_pools_amount_check CHECK (amount > 0),
  CONSTRAINT prod_cost_pools_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT prod_cost_pools_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_cost_pools_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
REVOKE ALL ON public.prod_cost_pools FROM authenticated, anon;

COMMENT ON TABLE public.prod_cost_pools IS
  'Monthly overhead pools (labour, energy, ...). Period expense in prod_pnl; allocated to the month''s '
  'production outputs by prod_allocate_overhead (report only, lots stay at material cost). Read via RLS; '
  'write ONLY via prod_save_cost_pool / prod_cancel_cost_pool (owner / admin).';

CREATE INDEX prod_cost_pools_company_period_idx ON public.prod_cost_pools (company_id, period);
-- One posted pool per (month, expense category): the category is excluded
-- from other expenses exactly once.
CREATE UNIQUE INDEX prod_cost_pools_category_key
  ON public.prod_cost_pools (company_id, period, expense_category_id)
  WHERE status = 'posted' AND expense_category_id IS NOT NULL;

-- 1e) Overhead allocation of one month (replaced as a whole by every run
-- of prod_allocate_overhead; cleared when a pool of the month changes).
CREATE TABLE public.prod_overhead_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period date NOT NULL,
  production_id uuid NOT NULL,
  output_id uuid NOT NULL,
  item_id uuid NOT NULL,
  method text NOT NULL,
  base numeric(20,4) NOT NULL,
  amount numeric(14,2) NOT NULL,
  pool_total numeric(14,2) NOT NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_overhead_allocations_output_key UNIQUE (output_id),
  CONSTRAINT prod_overhead_allocations_production_fk FOREIGN KEY (production_id, company_id)
    REFERENCES public.prod_productions (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_overhead_allocations_output_fk FOREIGN KEY (output_id, company_id)
    REFERENCES public.prod_production_outputs (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_overhead_allocations_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_overhead_allocations_period_check CHECK (extract(day FROM period) = 1),
  CONSTRAINT prod_overhead_allocations_method_check CHECK (method IN ('per_kg', 'per_value', 'manual')),
  CONSTRAINT prod_overhead_allocations_amount_check CHECK (amount >= 0 AND base >= 0 AND pool_total >= 0)
);
REVOKE ALL ON public.prod_overhead_allocations FROM authenticated, anon;

COMMENT ON TABLE public.prod_overhead_allocations IS
  'Overhead of a month allocated to its posted production outputs (per_kg / per_value / manual). Feeds '
  'prod_product_costs_month only; lots and movements are NOT revalued. Read via RLS; written ONLY by '
  'prod_allocate_overhead (and cleared by the pool RPCs).';

CREATE INDEX prod_overhead_allocations_company_period_idx ON public.prod_overhead_allocations (company_id, period);
CREATE INDEX prod_overhead_allocations_production_idx ON public.prod_overhead_allocations (production_id, company_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'prod_company_accounting', 'prod_production_outputs', 'prod_recipe_outputs',
    'prod_cost_pools', 'prod_overhead_allocations'
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

-- 1f) Seeds / backfill (the only DML of this migration; inserts only).
-- Accounting settings for every production-enabled company (same predicate
-- as production_enabled() / the 16 cash and 17 control seeds).
INSERT INTO public.prod_company_accounting (company_id)
SELECT c.id
FROM public.companies c
WHERE c.business_type = 'production'
   OR EXISTS (
        SELECT 1 FROM public.company_features cf
        WHERE cf.company_id = c.id
          AND cf.feature_key = 'production'
          AND cf.is_active
          AND (cf.expires_at IS NULL OR cf.expires_at > now())
      )
ON CONFLICT (company_id) DO NOTHING;

-- One output row per existing production (its single output; lot = the
-- production's inflow lot of the output item, NULL before the lots wave).
INSERT INTO public.prod_production_outputs (
  company_id, production_id, sort_order, item_id, warehouse_id, qty, share_pct, ref_price, cost, unit_cost, lot_id
)
SELECT
  p.company_id, p.id, 0, p.output_item_id, COALESCE(p.output_warehouse_id, p.warehouse_id), p.output_qty,
  100, NULL, p.total_cost, p.unit_cost,
  (SELECT l.id FROM public.prod_lots l
   WHERE l.company_id = p.company_id AND l.source_doc_type = 'production' AND l.source_doc_id = p.id
     AND l.item_id = p.output_item_id
   ORDER BY l.created_at, l.id
   LIMIT 1)
FROM public.prod_productions p;

-- 1g) Master-data audit trail (trigger of 20261110000017), created after
-- the seed so the seed rows are not logged.
CREATE TRIGGER prod_audit AFTER INSERT OR UPDATE OR DELETE ON public.prod_company_accounting
  FOR EACH ROW EXECUTE FUNCTION public.prod_audit_trigger();
CREATE TRIGGER prod_audit AFTER INSERT OR UPDATE OR DELETE ON public.prod_recipe_outputs
  FOR EACH ROW EXECUTE FUNCTION public.prod_audit_trigger();
CREATE TRIGGER prod_audit AFTER INSERT OR UPDATE OR DELETE ON public.prod_cost_pools
  FOR EACH ROW EXECUTE FUNCTION public.prod_audit_trigger();

-- ─── 2) Columns on existing tables ────────────────────────────────────────
-- Constant defaults (metadata only); the CHECKs validate existing rows
-- (all 0 / false) under a brief ACCESS EXCLUSIVE lock until COMMIT.
ALTER TABLE public.prod_receipts
  ADD COLUMN prices_include_vat boolean NOT NULL DEFAULT false,
  ADD COLUMN vat_deductible boolean NOT NULL DEFAULT false,
  ADD COLUMN vat_total numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.prod_receipts
  ADD CONSTRAINT prod_receipts_vat_total_check CHECK (vat_total >= 0 AND vat_total <= total);

ALTER TABLE public.prod_receipt_items
  ADD COLUMN vat_rate numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN vat_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.prod_receipt_items
  ADD CONSTRAINT prod_receipt_items_vat_check CHECK (vat_rate BETWEEN 0 AND 100 AND vat_amount >= 0 AND vat_amount <= total);

ALTER TABLE public.prod_price_corrections
  ADD COLUMN vat_delta numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE public.prod_productions
  ADD COLUMN allocation_method text NOT NULL DEFAULT 'mass';
ALTER TABLE public.prod_productions
  ADD CONSTRAINT prod_productions_allocation_method_check CHECK (allocation_method IN ('mass', 'value', 'fixed'));

-- ─── 3) Indexes for the server-side reports ───────────────────────────────
-- Plain CREATE INDEX (inside the transaction): blocks writes to the table
-- while it builds (seconds at the current volume).
CREATE INDEX prod_stock_movements_company_created_idx
  ON public.prod_stock_movements (company_id, created_at);
CREATE INDEX prod_lots_opening_created_idx
  ON public.prod_lots (company_id, created_at) WHERE is_opening;
-- (sales, returns, cash orders, supply moves, milk intakes, productions,
-- write-offs, counts, corrections, processings, separations already have a
-- (company_id, date) index.)

-- ─── 4) Internal helpers (EXECUTE revoked from every client role) ─────────

-- The company's accounting settings; row created with the defaults on first
-- use (ON CONFLICT: concurrent first use is safe).
CREATE OR REPLACE FUNCTION public.prod_acct_settings(p_company_id uuid)
RETURNS public.prod_company_accounting
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.prod_company_accounting%ROWTYPE;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT * INTO v_row FROM public.prod_company_accounting WHERE company_id = p_company_id;
  IF NOT FOUND THEN
    INSERT INTO public.prod_company_accounting (company_id) VALUES (p_company_id)
    ON CONFLICT (company_id) DO NOTHING;
    SELECT * INTO v_row FROM public.prod_company_accounting WHERE company_id = p_company_id;
  END IF;
  RETURN v_row;
END;
$$;

-- VAT split of one purchase line (see header "VAT"):
--   rate 0:            gross = round(qty * price, 2), vat 0, net = gross
--   prices exclusive:  net = round(qty * price, 2), vat = round(net * rate / 100, 2), gross = net + vat
--   prices inclusive:  gross = round(qty * price, 2), vat = round(gross * rate / (100 + rate), 2), net = gross - vat
CREATE OR REPLACE FUNCTION public.prod_vat_split(
  p_qty numeric, p_price numeric, p_rate numeric, p_incl boolean,
  OUT net numeric, OUT vat numeric, OUT gross numeric
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(p_rate, 0) = 0 THEN
    gross := round(p_qty * p_price, 2);
    vat := 0;
    net := gross;
  ELSIF NOT COALESCE(p_incl, false) THEN
    net := round(p_qty * p_price, 2);
    vat := round(net * p_rate / 100, 2);
    gross := net + vat;
  ELSE
    gross := round(p_qty * p_price, 2);
    vat := round(gross * p_rate / (100 + p_rate), 2);
    net := gross - vat;
  END IF;
END;
$$;

-- Unit (lot) cost of a purchase price: VAT is recoverable (deductible) ->
-- price WITHOUT VAT, else price WITH VAT. Rate 0 -> the price unchanged.
CREATE OR REPLACE FUNCTION public.prod_vat_unit_cost(p_price numeric, p_rate numeric, p_incl boolean, p_deductible boolean)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN COALESCE(p_rate, 0) = 0 THEN p_price
    WHEN p_incl AND p_deductible THEN round(p_price * 100 / (100 + p_rate), 2)
    WHEN p_incl THEN p_price
    WHEN p_deductible THEN p_price
    ELSE round(p_price * (100 + p_rate) / 100, 2)
  END
$$;

-- kg-equivalent of a quantity (same rule as toKg in lib/production-reports.ts):
-- kg -> qty, g -> qty / 1000, pcs / l with weight_kg > 0 -> qty * weight_kg,
-- else NULL.
CREATE OR REPLACE FUNCTION public.prod_qty_kg(p_qty numeric, p_unit text, p_weight_kg numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_unit = 'kg' THEN p_qty
    WHEN p_unit = 'g' THEN p_qty / 1000
    WHEN p_unit IN ('pcs', 'l') AND p_weight_kg > 0 THEN p_qty * p_weight_kg
    ELSE NULL
  END
$$;

-- Start of a Tashkent business day as timestamptz.
CREATE OR REPLACE FUNCTION public.prod_day_start(p_day date)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (p_day::timestamp AT TIME ZONE 'Asia/Tashkent')
$$;

REVOKE EXECUTE ON FUNCTION public.prod_acct_settings(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_vat_split(numeric, numeric, numeric, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_vat_unit_cost(numeric, numeric, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_qty_kg(numeric, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_day_start(date) FROM PUBLIC, anon, authenticated;

-- prod_audit_trigger (replaced, same signature): body of 20261110000017;
-- the only change: updates of prod_company_accounting are logged with
-- action 'settings' like prod_control_settings.
CREATE OR REPLACE FUNCTION public.prod_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_o jsonb;
  v_n jsonb;
  v_row jsonb;
  v_company uuid;
  v_action text;
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_company := (v_old->>'company_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = v_company) THEN
      RETURN NULL;
    END IF;
    v_o := v_old;
    v_n := NULL;
    v_row := v_old;
  ELSIF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_company := (v_new->>'company_id')::uuid;
    v_o := NULL;
    v_n := v_new;
    v_row := v_new;
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_company := (v_new->>'company_id')::uuid;
    v_o := '{}'::jsonb;
    v_n := '{}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(v_new)
    LOOP
      CONTINUE WHEN k = 'updated_at';
      IF (v_old->k) IS DISTINCT FROM (v_new->k) THEN
        v_o := v_o || jsonb_build_object(k, v_old->k);
        v_n := v_n || jsonb_build_object(k, v_new->k);
      END IF;
    END LOOP;
    IF v_n = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    v_row := v_new;
  END IF;

  v_action := CASE
    WHEN TG_TABLE_NAME IN ('prod_control_settings', 'prod_company_accounting') AND TG_OP = 'UPDATE' THEN 'settings'
    ELSE lower(TG_OP)
  END;

  PERFORM public.prod_audit_write(
    v_company, TG_TABLE_NAME,
    CASE WHEN v_row ? 'id' THEN (v_row->>'id')::uuid ELSE (v_row->>'company_id')::uuid END,
    v_action, v_o, v_n, NULL, NULL
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_audit_trigger() FROM PUBLIC, anon, authenticated;

-- ─── 5) Views (security_invoker: the caller's RLS on the base tables) ────

-- VAT per company and business month (Asia/Tashkent). Posted documents only.
--   output_vat = sales vat_amount - sale return vat_amount
--   input_vat  = receipts vat_total (vat_deductible receipts only)
--                + price corrections vat_delta (of vat_deductible receipts,
--                  in the correction's month)
--   payable    = output_vat - input_vat (negative = refundable)
CREATE VIEW public.prod_vat_summary
WITH (security_invoker = true)
AS
WITH s AS (
  SELECT company_id, date_trunc('month', doc_date AT TIME ZONE 'Asia/Tashkent')::date AS month, sum(vat_amount) AS v
  FROM public.prod_sales WHERE status = 'posted'
  GROUP BY 1, 2
),
r AS (
  SELECT company_id, date_trunc('month', doc_date AT TIME ZONE 'Asia/Tashkent')::date AS month, sum(vat_amount) AS v
  FROM public.prod_sale_returns WHERE status = 'posted'
  GROUP BY 1, 2
),
i AS (
  SELECT company_id, date_trunc('month', doc_date AT TIME ZONE 'Asia/Tashkent')::date AS month, sum(vat_total) AS v
  FROM public.prod_receipts WHERE status = 'posted' AND vat_deductible
  GROUP BY 1, 2
),
c AS (
  SELECT pc.company_id, date_trunc('month', pc.doc_date AT TIME ZONE 'Asia/Tashkent')::date AS month, sum(pc.vat_delta) AS v
  FROM public.prod_price_corrections pc
  JOIN public.prod_receipts rc ON rc.id = pc.receipt_id AND rc.company_id = pc.company_id
  WHERE pc.status = 'posted' AND rc.vat_deductible
  GROUP BY 1, 2
),
k AS (
  SELECT company_id, month FROM s UNION SELECT company_id, month FROM r
  UNION SELECT company_id, month FROM i UNION SELECT company_id, month FROM c
)
SELECT
  k.company_id,
  k.month,
  COALESCE(s.v, 0)::numeric(14,2) AS sales_vat,
  COALESCE(r.v, 0)::numeric(14,2) AS returns_vat,
  (COALESCE(s.v, 0) - COALESCE(r.v, 0))::numeric(14,2) AS output_vat,
  COALESCE(i.v, 0)::numeric(14,2) AS receipts_vat,
  COALESCE(c.v, 0)::numeric(14,2) AS corrections_vat,
  (COALESCE(i.v, 0) + COALESCE(c.v, 0))::numeric(14,2) AS input_vat,
  (COALESCE(s.v, 0) - COALESCE(r.v, 0) - COALESCE(i.v, 0) - COALESCE(c.v, 0))::numeric(14,2) AS payable
FROM k
LEFT JOIN s ON s.company_id = k.company_id AND s.month = k.month
LEFT JOIN r ON r.company_id = k.company_id AND r.month = k.month
LEFT JOIN i ON i.company_id = k.company_id AND i.month = k.month
LEFT JOIN c ON c.company_id = k.company_id AND c.month = k.month;

COMMENT ON VIEW public.prod_vat_summary IS
  'VAT per business month: output (sales - returns), input (deductible receipts + their price corrections), '
  'payable = output - input. Posted documents only.';

-- Full cost per (month, output item): material cost of the posted
-- production outputs of the month + allocated overhead.
CREATE VIEW public.prod_product_costs_month
WITH (security_invoker = true)
AS
WITH o AS (
  SELECT o.id, o.company_id, o.item_id, o.qty, o.cost,
         date_trunc('month', p.doc_date AT TIME ZONE 'Asia/Tashkent')::date AS month
  FROM public.prod_production_outputs o
  JOIN public.prod_productions p ON p.id = o.production_id AND p.company_id = o.company_id
  WHERE p.status = 'posted'
),
a AS (
  SELECT output_id, company_id, sum(amount) AS amount
  FROM public.prod_overhead_allocations
  GROUP BY output_id, company_id
),
g AS (
  SELECT o.company_id, o.month, o.item_id,
         sum(o.qty) AS qty, sum(o.cost) AS material_cost, COALESCE(sum(a.amount), 0) AS overhead
  FROM o
  LEFT JOIN a ON a.output_id = o.id AND a.company_id = o.company_id
  GROUP BY o.company_id, o.month, o.item_id
)
SELECT
  g.company_id,
  g.month,
  g.item_id,
  i.name AS item_name,
  i.unit AS item_unit,
  g.qty::numeric(14,3) AS qty,
  g.material_cost::numeric(14,2) AS material_cost,
  g.overhead::numeric(14,2) AS overhead,
  (g.material_cost + g.overhead)::numeric(14,2) AS full_cost,
  CASE WHEN g.qty > 0 THEN round(g.material_cost / g.qty, 2) END AS material_unit_cost,
  CASE WHEN g.qty > 0 THEN round((g.material_cost + g.overhead) / g.qty, 2) END AS full_unit_cost
FROM g
LEFT JOIN public.prod_items i ON i.id = g.item_id AND i.company_id = g.company_id;

COMMENT ON VIEW public.prod_product_costs_month IS
  'Per business month and produced item: qty, material cost (lots), allocated overhead, full cost and unit '
  'costs. Posted productions only; overhead from the month''s latest prod_allocate_overhead run.';

-- Suggested pool amounts: per business month and expense category, the
-- posted cash orders ''out'' + posted supply expenses. pooled = a posted
-- pool of that month already uses the category.
CREATE VIEW public.prod_cost_pool_suggestions
WITH (security_invoker = true)
AS
WITH src AS (
  SELECT co.company_id, date_trunc('month', co.doc_date AT TIME ZONE 'Asia/Tashkent')::date AS period,
         co.category_id, co.amount AS cash_amount, 0::numeric AS supply_amount
  FROM public.prod_cash_orders co
  WHERE co.direction = 'out' AND co.status = 'posted'
  UNION ALL
  SELECT sm.company_id, date_trunc('month', sm.move_date)::date, sm.expense_category_id, 0::numeric, sm.amount
  FROM public.supply_cash_moves sm
  WHERE sm.kind = 'expense' AND sm.status = 'posted'
),
g AS (
  SELECT company_id, period, category_id,
         sum(cash_amount) AS cash_amount, sum(supply_amount) AS supply_amount, count(*) AS doc_count
  FROM src
  GROUP BY company_id, period, category_id
)
SELECT
  g.company_id,
  g.period,
  g.category_id AS expense_category_id,
  ec.name AS category_name,
  g.cash_amount::numeric(14,2) AS cash_amount,
  g.supply_amount::numeric(14,2) AS supply_amount,
  (g.cash_amount + g.supply_amount)::numeric(14,2) AS amount,
  g.doc_count,
  EXISTS (
    SELECT 1 FROM public.prod_cost_pools cp
    WHERE cp.company_id = g.company_id AND cp.period = g.period AND cp.status = 'posted'
      AND cp.expense_category_id = g.category_id
  ) AS pooled
FROM g
LEFT JOIN public.expense_categories ec ON ec.id = g.category_id AND ec.company_id = g.company_id;

COMMENT ON VIEW public.prod_cost_pool_suggestions IS
  'Suggested overhead pool amounts per business month and expense category (posted cash orders out + '
  'posted supply expenses). pooled = already used by a posted pool of the month. The user confirms by '
  'saving a pool (prod_save_cost_pool).';

REVOKE ALL ON public.prod_vat_summary FROM authenticated, anon;
GRANT SELECT ON public.prod_vat_summary TO authenticated;
REVOKE ALL ON public.prod_product_costs_month FROM authenticated, anon;
GRANT SELECT ON public.prod_product_costs_month TO authenticated;
REVOKE ALL ON public.prod_cost_pool_suggestions FROM authenticated, anon;
GRANT SELECT ON public.prod_cost_pool_suggestions TO authenticated;

-- ─── 6) Replaced RPCs (bodies copied from 20261110000017) ───────────────

-- ═══ prod_create_receipt (replaced, same signature) ══════════════════════
-- Body copied from 20261110000017 (latest definition). Additions (VAT):
--   * header prices_include_vat (default false) and vat_rate (default 0,
--     the default of the lines); line vat_rate 0..100 (else invalid_input
--     DETAIL 'vat_rate').
--   * line amounts = prod_vat_split: line total (= supplier debt) is the
--     GROSS amount incl. VAT, vat_amount the VAT; receipt total = sum of
--     gross, vat_total = sum of VAT. Rate 0 -> exactly the old formula.
--   * vat_deductible = prod_company_accounting.vat_payer at posting (stored
--     on the receipt: later price corrections keep the treatment).
--   * lot unit cost = prod_vat_unit_cost(price, rate, incl, deductible):
--     VAT payer -> price WITHOUT VAT, else price WITH VAT (rate 0: price).
--   Locks unchanged (the settings row is read without a lock).
-- p_data: + prices_include_vat, vat_rate, items[].vat_rate.
-- Returns { id, number } + total, vat_total (new optional keys).
CREATE OR REPLACE FUNCTION public.prod_create_receipt(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_biz date;
  v_warehouse_id uuid;
  v_supplier_id uuid;
  v_supplier_active boolean;
  v_supplier_db_name text;
  v_supplier text;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_prices numeric[] := '{}';
  v_expiries date[] := '{}';
  v_rates numeric[] := '{}';
  v_vats numeric[] := '{}';
  v_grosses numeric[] := '{}';
  v_rate numeric;
  v_hdr_rate numeric;
  v_incl boolean;
  v_deductible boolean;
  v_split record;
  v_vat_total numeric := 0;
  v_item_id uuid;
  v_qty numeric;
  v_price numeric;
  v_expiry date;
  v_line_total numeric;
  v_total numeric := 0;
  v_has_raw boolean;
  v_zero_raw uuid[];
  v_id uuid;
  v_number integer;
  i integer;
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

  v_doc_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());
  v_biz := public.prod_biz_date(v_doc_date);
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_supplier_id := public.prod_juuid(p_data, 'supplier_id');
  v_supplier := public.prod_jtext(p_data, 'supplier_name', 200);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_id := gen_random_uuid();
  v_incl := COALESCE(public.prod_jbool(p_data, 'prices_include_vat'), false);
  v_hdr_rate := COALESCE(public.prod_jnum(p_data, 'vat_rate', 2), 0);
  IF v_hdr_rate NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'vat_rate';
  END IF;
  v_deductible := (public.prod_acct_settings(v_company_id)).vat_payer;

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);

  IF v_supplier_id IS NOT NULL THEN
    SELECT s.is_active, s.name INTO v_supplier_active, v_supplier_db_name
    FROM public.prod_suppliers s
    WHERE s.id = v_supplier_id AND s.company_id = v_company_id
    FOR SHARE;
    IF NOT FOUND OR NOT v_supplier_active THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_supplier := v_supplier_db_name;
  END IF;

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
    v_price := public.prod_jnum(v_line, 'price', 2);
    v_expiry := public.prod_jdate(v_line, 'expiry_date');
    v_rate := COALESCE(public.prod_jnum(v_line, 'vat_rate', 2), v_hdr_rate);
    IF v_rate NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'vat_rate';
    END IF;
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_price IS NULL OR v_price < 0
       OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF v_expiry IS NOT NULL AND v_expiry < v_biz THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'expiry_in_past';
    END IF;
    v_split := public.prod_vat_split(v_qty, v_price, v_rate, v_incl);
    v_line_total := v_split.gross;
    v_total := v_total + v_line_total;
    v_vat_total := v_vat_total + v_split.vat;
    IF v_line_total >= 1e12 OR v_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_prices := v_prices || v_price;
    -- array_append keeps a NULL element (index alignment).
    v_expiries := array_append(v_expiries, v_expiry);
    v_rates := v_rates || v_rate;
    v_vats := v_vats || v_split.vat;
    v_grosses := v_grosses || v_split.gross;
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.prod_items
             WHERE company_id = v_company_id AND id = ANY (v_item_ids) AND NOT is_active) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_receipts', v_id);

  -- Rule 10 (raw items only).
  SELECT bool_or(it.item_type = 'raw'),
         array_agg(it.id ORDER BY it.id) FILTER (
           WHERE it.item_type = 'raw'
             AND EXISTS (SELECT 1 FROM unnest(v_item_ids, v_prices) AS l(item_id, price)
                         WHERE l.item_id = it.id AND l.price = 0))
  INTO v_has_raw, v_zero_raw
  FROM public.prod_items it
  WHERE it.company_id = v_company_id AND it.id = ANY (v_item_ids);
  IF v_zero_raw IS NOT NULL THEN
    PERFORM public.prod_ctl_require(v_company_id, 'receipt_zero_price', p_data, 'prod_receipts', v_id,
      jsonb_build_object('item_ids', to_jsonb(v_zero_raw)));
  END IF;
  IF COALESCE(v_has_raw, false) AND v_supplier_id IS NULL THEN
    PERFORM public.prod_ctl_require(v_company_id, 'receipt_no_supplier', p_data, 'prod_receipts', v_id,
      jsonb_build_object('supplier_name', v_supplier, 'total', v_total));
  END IF;

  PERFORM public.prod_lock_items_share(v_company_id, v_item_ids);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_receipt_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_receipts WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_receipts (
    id, company_id, number, doc_date, warehouse_id, supplier_id, supplier_name, note, total,
    status, created_by, created_by_name, prices_include_vat, vat_deductible, vat_total
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_supplier_id, v_supplier, v_note, v_total,
    'posted', auth.uid(), v_user_name, v_incl, v_deductible, v_vat_total
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_receipt_items (company_id, receipt_id, item_id, qty, price, total, vat_rate, vat_amount)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_prices[i], v_grosses[i], v_rates[i], v_vats[i]);

    PERFORM public.prod_add_lot(
      v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i],
      public.prod_vat_unit_cost(v_prices[i], v_rates[i], v_incl, v_deductible),
      NULL, NULL, v_supplier_id, 'receipt', v_id, NULL,
      COALESCE(v_expiries[i], public.prod_lot_expiry(v_company_id, v_item_ids[i], v_doc_date)),
      v_doc_date, NULL
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total, 'vat_total', v_vat_total);
END;
$$;


-- ═══ prod_create_price_correction (replaced, same signature) ═════════════
-- Body copied from 20261110000017 (latest definition). Additions (VAT):
--   new_price is in the receipt's price basis (prices_include_vat) and the
--   line's vat_rate applies. Rate 0: unchanged formulas. Rate > 0:
--     debt_delta = gross(new) - gross(old), vat_delta = vat(new) - vat(old)
--     (prod_vat_split of the line qty; stored in prod_price_corrections);
--     revaluation lots get prod_vat_unit_cost(new_price, ...) (ex VAT for
--     a deductible receipt); stock_delta uses that cost;
--     consumed_variance = round((cost(new) - cost(old)) * consumed_qty, 2).
-- Returns the old object + vat_delta (new optional key).
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
  v_rate numeric;
  v_s_new record;
  v_s_old record;
  v_vat_delta numeric := 0;
  v_new_cost numeric;
  v_old_cost numeric;
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
  v_id := gen_random_uuid();

  IF v_receipt_id IS NULL OR (v_line_id IS NULL AND v_item_id IS NULL)
     OR v_new IS NULL OR v_new < 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, status, warehouse_id, supplier_id, prices_include_vat, vat_deductible INTO v_r
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
  SELECT ri.id, ri.item_id, ri.qty, ri.price, ri.vat_rate INTO v_li
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

  v_rate := COALESCE(v_li.vat_rate, 0);
  IF v_rate = 0 THEN
    v_delta := round((v_new - v_old) * v_li.qty, 2);
  ELSE
    v_s_new := public.prod_vat_split(v_li.qty, v_new, v_rate, v_r.prices_include_vat);
    v_s_old := public.prod_vat_split(v_li.qty, v_old, v_rate, v_r.prices_include_vat);
    v_delta := v_s_new.gross - v_s_old.gross;
    v_vat_delta := v_s_new.vat - v_s_old.vat;
  END IF;
  v_new_cost := public.prod_vat_unit_cost(v_new, v_rate, v_r.prices_include_vat, v_r.vat_deductible);
  v_old_cost := public.prod_vat_unit_cost(v_old, v_rate, v_r.prices_include_vat, v_r.vat_deductible);
  IF abs(v_delta) >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_doc_date), 'create',
                                  p_data, 'prod_price_corrections', v_id);

  PERFORM public.prod_lock_items_share(v_company_id, ARRAY[v_li.item_id]);
  PERFORM public.prod_lock_stock(v_company_id, v_r.warehouse_id, ARRAY[v_li.item_id]);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_price_correction_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_price_corrections WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_price_corrections (
    id, company_id, number, doc_date, receipt_id, receipt_item_id, item_id, warehouse_id, supplier_id,
    qty, old_price, new_price, debt_delta, note, status, created_by, created_by_name, vat_delta
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_r.id, v_li.id, v_li.item_id, v_r.warehouse_id, v_r.supplier_id,
    v_li.qty, v_old, v_new, v_delta, v_note, 'posted', auth.uid(), v_user_name, v_vat_delta
  );

  -- Revalue every lot of the line still holding stock in the receipt
  -- warehouse (the receipt lot + lots of earlier posted corrections).
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
      v_company_id, v_r.warehouse_id, v_li.item_id, v_lot.remaining, v_new_cost,
      v_lot.fat_pct, v_lot.protein_pct, v_lot.supplier_id, 'price_correction', v_id, v_lot.id,
      v_lot.expiry_date, v_lot.received_at, NULL
    );
    UPDATE public.prod_lots
    SET hold_status = v_lot.hold_status, hold_reason = v_lot.hold_reason,
        hold_at = v_lot.hold_at, hold_by = v_lot.hold_by
    WHERE id = v_new_lot AND company_id = v_company_id;

    v_stock_qty := v_stock_qty + v_lot.remaining;
    v_stock_delta := v_stock_delta + round(v_lot.remaining * v_new_cost, 2) - round(v_lot.remaining * v_lot.unit_cost, 2);
    v_lots := v_lots || jsonb_build_array(jsonb_build_object(
      'old_lot_id', v_lot.id, 'new_lot_id', v_new_lot, 'qty', v_lot.remaining, 'old_unit_cost', v_lot.unit_cost
    ));
  END LOOP;

  v_consumed := GREATEST(v_li.qty - v_stock_qty, 0);
  v_variance := round((v_new_cost - v_old_cost) * v_consumed, 2);

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
    'consumed_variance', v_variance, 'stock_delta', v_stock_delta, 'vat_delta', v_vat_delta
  );
END;
$$;

-- ═══ prod_create_production (replaced, same signature) ═══════════════════
-- Body copied from 20261110000017 (latest definition). Additions
-- (co-products, see header "Co-products"):
--   * optional outputs: [{ item_id, qty, output_warehouse_id?, share_pct?,
--     ref_price? }] (1..20). Absent -> the old single output (output_item_id
--     / output_qty). Present -> the full list, outputs[0] = main output; a
--     header output_item_id / output_qty, when also sent, must equal
--     outputs[0] (else invalid_input DETAIL 'outputs').
--   * allocation_method 'mass' (default) | 'value' | 'fixed' (invalid ->
--     invalid_input DETAIL 'allocation_method'); see header for weights.
--   * every output item: active, finished / semi, distinct, not a
--     component; every output warehouse active.
--   * material cost split: cost_i = round(total * w_i / sum(w), 2) for all
--     but the last output, last = total - sum(others); unit cost (lot cost)
--     = round(cost_i / qty_i, 2). Each output -> its own lot + a
--     prod_production_outputs row (also for a single output).
--   * prod_productions.output_item_id / output_qty / unit_cost = the main
--     output; total_cost = the whole material cost; allocation_method.
--   * yield rule (17) on the MAIN output only; all output item rows FOR SHARE.
-- Cancel (prod_cancel_document, unchanged) reverses every movement of the
-- document, i.e. all output lots.
-- Returns { id, number, total_cost, unit_cost } + allocation_method,
--   outputs: [{ item_id, qty, cost, unit_cost, share_pct, lot_id }] (new
--   optional keys).
CREATE OR REPLACE FUNCTION public.prod_create_production(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_biz date;
  v_warehouse_id uuid;
  v_output_warehouse_id uuid;
  v_output_item_id uuid;
  v_output_qty numeric;
  v_hdr_item uuid;
  v_hdr_qty numeric;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_costs numeric[] := '{}';
  v_totals numeric[] := '{}';
  v_planned numeric[] := '{}';
  v_picks jsonb[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_planned_qty numeric;
  v_res jsonb;
  v_line_cost numeric;
  v_total_cost numeric := 0;
  v_unit_cost numeric;
  v_out_type text;
  v_out_active boolean;
  v_out_unit text;
  v_out_weight numeric;
  v_out_sale numeric;
  v_recipe_id uuid;
  v_recipe_item_id uuid;
  v_recipe_version integer;
  v_recipe_out numeric;
  v_set public.prod_control_settings%ROWTYPE;
  v_tol numeric;
  v_rl record;
  v_actual numeric;
  v_plan numeric;
  v_dev numeric;
  v_max_dev numeric := 0;
  v_in_sum numeric := 0;
  v_rl_sum numeric := 0;
  v_expected numeric;
  v_bad boolean := false;
  v_extra uuid[];
  v_ctl jsonb;
  v_deviation boolean := false;
  v_method text;
  v_o_items uuid[] := '{}';
  v_o_qtys numeric[] := '{}';
  v_o_whs uuid[] := '{}';
  v_o_shares numeric[] := '{}';
  v_o_refs numeric[] := '{}';
  v_o_w numeric[] := '{}';
  v_o_cost numeric[] := '{}';
  v_o_unit numeric[] := '{}';
  v_o_lot uuid;
  v_o_wh uuid;
  v_share numeric;
  v_ref numeric;
  v_w numeric;
  v_w_sum numeric := 0;
  v_alloc numeric := 0;
  v_n integer;
  v_outputs jsonb := '[]'::jsonb;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_production') THEN
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
  v_biz := public.prod_biz_date(v_doc_date);
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_output_warehouse_id := public.prod_juuid(p_data, 'output_warehouse_id');
  v_hdr_item := public.prod_juuid(p_data, 'output_item_id');
  v_hdr_qty := public.prod_jnum(p_data, 'output_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_recipe_id := public.prod_juuid(p_data, 'recipe_id');
  v_method := COALESCE(public.prod_jtext(p_data, 'allocation_method', 20), 'mass');
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_productions');

  IF v_method NOT IN ('mass', 'value', 'fixed') THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocation_method';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);
  v_output_warehouse_id := COALESCE(v_output_warehouse_id, v_warehouse_id);

  -- Output list (main first).
  IF p_data->'outputs' IS NULL OR jsonb_typeof(p_data->'outputs') = 'null' THEN
    IF v_hdr_item IS NULL OR v_hdr_qty IS NULL OR v_hdr_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_o_items := ARRAY[v_hdr_item];
    v_o_qtys := ARRAY[v_hdr_qty];
    v_o_whs := ARRAY[v_output_warehouse_id];
    v_o_shares := ARRAY[NULL::numeric];
    v_o_refs := ARRAY[NULL::numeric];
  ELSE
    IF jsonb_typeof(p_data->'outputs') <> 'array'
       OR jsonb_array_length(p_data->'outputs') NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'outputs')
    LOOP
      IF jsonb_typeof(v_line) <> 'object' THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
      END IF;
      v_item_id := public.prod_juuid(v_line, 'item_id');
      v_qty := public.prod_jnum(v_line, 'qty', 3);
      v_o_wh := COALESCE(public.prod_juuid(v_line, 'output_warehouse_id'), v_output_warehouse_id);
      v_share := public.prod_jnum(v_line, 'share_pct', 4);
      v_ref := public.prod_jnum(v_line, 'ref_price', 2);
      IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_item_id = ANY (v_o_items)
         OR (v_share IS NOT NULL AND v_share NOT BETWEEN 0 AND 100)
         OR (v_ref IS NOT NULL AND v_ref < 0) THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
      END IF;
      v_o_items := v_o_items || v_item_id;
      v_o_qtys := v_o_qtys || v_qty;
      v_o_whs := v_o_whs || v_o_wh;
      v_o_shares := array_append(v_o_shares, v_share);
      v_o_refs := array_append(v_o_refs, v_ref);
    END LOOP;
    IF (v_hdr_item IS NOT NULL AND v_hdr_item <> v_o_items[1])
       OR (v_hdr_qty IS NOT NULL AND v_hdr_qty <> v_o_qtys[1]) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
    END IF;
  END IF;
  v_n := cardinality(v_o_items);
  v_output_item_id := v_o_items[1];
  v_output_qty := v_o_qtys[1];

  -- Output items / warehouses + allocation weights.
  FOR i IN 1 .. v_n
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.prod_warehouses
      WHERE id = v_o_whs[i] AND company_id = v_company_id AND is_active
    ) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    SELECT item_type, is_active, unit, weight_kg, sale_price
    INTO v_out_type, v_out_active, v_out_unit, v_out_weight, v_out_sale
    FROM public.prod_items
    WHERE id = v_o_items[i] AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_out_active OR v_out_type NOT IN ('finished', 'semi') THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF v_n = 1 THEN
      v_w := 1;
    ELSIF v_method = 'mass' THEN
      v_w := public.prod_qty_kg(v_o_qtys[i], v_out_unit, v_out_weight);
      IF v_w IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'output_weight';
      END IF;
    ELSIF v_method = 'value' THEN
      v_ref := COALESCE(v_o_refs[i], v_out_sale);
      IF v_ref IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'ref_price';
      END IF;
      v_o_refs[i] := v_ref;
      v_w := v_ref * v_o_qtys[i];
    ELSE
      IF v_o_shares[i] IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'share_pct';
      END IF;
      v_w := v_o_shares[i];
    END IF;
    v_o_w := v_o_w || v_w;
    v_w_sum := v_w_sum + v_w;
  END LOOP;
  IF v_n > 1 THEN
    IF v_method = 'fixed' AND v_w_sum <> 100 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'share_pct';
    END IF;
    IF v_w_sum <= 0 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = CASE v_method WHEN 'mass' THEN 'output_weight'
        WHEN 'value' THEN 'ref_price' ELSE 'share_pct' END;
    END IF;
  END IF;

  IF v_recipe_id IS NOT NULL THEN
    SELECT item_id, version, output_qty INTO v_recipe_item_id, v_recipe_version, v_recipe_out
    FROM public.prod_recipes
    WHERE id = v_recipe_id AND company_id = v_company_id
    FOR SHARE;
    IF NOT FOUND OR v_recipe_item_id <> v_output_item_id THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;

  IF jsonb_typeof(p_data->'components') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'components') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'components')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    v_planned_qty := public.prod_jnum(v_line, 'planned_qty', 4);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_item_id = ANY (v_o_items)
       OR v_item_id = ANY (v_item_ids)
       OR (v_planned_qty IS NOT NULL AND v_planned_qty < 0) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_planned := array_append(v_planned, v_planned_qty);
    v_picks := array_append(v_picks, v_line->'lots');
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_productions', v_id);

  -- Rule 1 (17): yield against the recipe, MAIN output only.
  IF v_recipe_id IS NULL THEN
    PERFORM public.prod_ctl_require(v_company_id, 'production_no_recipe', p_data, 'prod_productions', v_id,
      jsonb_build_object('output_item_id', v_output_item_id, 'output_qty', v_output_qty));
  ELSE
    v_set := public.prod_ctl_settings(v_company_id);
    v_tol := v_set.production_tolerance_pct / 100;
    FOR v_rl IN
      SELECT l.item_id, l.qty
      FROM public.prod_recipe_lines l
      WHERE l.recipe_id = v_recipe_id AND l.company_id = v_company_id
    LOOP
      v_plan := v_rl.qty * v_output_qty / v_recipe_out;
      v_actual := COALESCE((SELECT q FROM unnest(v_item_ids, v_qtys) AS c(id, q) WHERE c.id = v_rl.item_id), 0);
      v_in_sum := v_in_sum + v_actual;
      v_rl_sum := v_rl_sum + v_rl.qty;
      IF v_plan > 0 THEN
        v_dev := abs(v_actual - v_plan) / v_plan;
        v_max_dev := GREATEST(v_max_dev, v_dev);
        IF v_dev > v_tol THEN
          v_bad := true;
        END IF;
      END IF;
      FOR i IN 1 .. cardinality(v_item_ids)
      LOOP
        IF v_item_ids[i] = v_rl.item_id THEN
          v_planned[i] := round(v_plan, 4);
        END IF;
      END LOOP;
    END LOOP;

    SELECT array_agg(c.id) INTO v_extra
    FROM unnest(v_item_ids) AS c(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.prod_recipe_lines l
                      WHERE l.recipe_id = v_recipe_id AND l.company_id = v_company_id AND l.item_id = c.id);
    IF v_extra IS NOT NULL THEN
      v_bad := true;
    END IF;

    IF v_rl_sum > 0 THEN
      v_expected := v_recipe_out * v_in_sum / v_rl_sum;
      IF v_expected <= 0 OR abs(v_output_qty - v_expected) / v_expected > v_tol THEN
        v_bad := true;
      END IF;
    END IF;

    IF v_bad THEN
      PERFORM public.prod_ctl_require(v_company_id, 'production_yield', p_data, 'prod_productions', v_id,
        jsonb_build_object('recipe_id', v_recipe_id, 'output_qty', v_output_qty,
                           'expected_output', round(v_expected, 3), 'max_component_dev_pct', round(v_max_dev * 100, 2),
                           'extra_components', to_jsonb(v_extra), 'tolerance_pct', v_set.production_tolerance_pct));
    END IF;
  END IF;

  PERFORM public.prod_lock_items_share(v_company_id, v_o_items);

  -- Stock locks (sorted; source warehouse only), then consume under them.
  PERFORM public.prod_lock_stock(v_company_id, v_warehouse_id, v_item_ids);

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i],
                                 'production', v_id, v_picks[i], 'strict', v_ctl);
    v_line_cost := (v_res->>'cost')::numeric;
    v_totals := v_totals || v_line_cost;
    v_costs := v_costs || round(v_line_cost / v_qtys[i], 2);
    v_total_cost := v_total_cost + v_line_cost;
    v_deviation := v_deviation OR COALESCE((v_res->>'deviation')::boolean, false);
  END LOOP;

  IF v_total_cost >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Cost split (last output takes the rounding remainder).
  FOR i IN 1 .. v_n
  LOOP
    IF i < v_n THEN
      v_line_cost := round(v_total_cost * v_o_w[i] / v_w_sum, 2);
      v_alloc := v_alloc + v_line_cost;
    ELSE
      v_line_cost := v_total_cost - v_alloc;
    END IF;
    IF v_line_cost < 0 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocation';
    END IF;
    v_o_cost := v_o_cost || v_line_cost;
    v_unit_cost := round(v_line_cost / v_o_qtys[i], 2);
    IF v_unit_cost >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_o_unit := v_o_unit || v_unit_cost;
  END LOOP;
  v_unit_cost := v_o_unit[1];

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_production_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_productions WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_productions (
    id, company_id, number, doc_date, warehouse_id, output_warehouse_id, output_item_id, output_qty,
    total_cost, unit_cost, note, status, created_by, created_by_name,
    recipe_id, recipe_version, lot_pick_deviation, allocation_method
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_o_whs[1], v_output_item_id, v_output_qty,
    v_total_cost, v_unit_cost, v_note, 'posted', auth.uid(), v_user_name,
    v_recipe_id, v_recipe_version, v_deviation, v_method
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_production_components (
      company_id, production_id, item_id, qty, unit_cost, total, planned_qty
    ) VALUES (
      v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], v_totals[i], v_planned[i]
    );
  END LOOP;

  FOR i IN 1 .. v_n
  LOOP
    v_o_lot := public.prod_add_lot(
      v_company_id, v_o_whs[i], v_o_items[i], v_o_qtys[i], v_o_unit[i],
      NULL, NULL, NULL, 'production', v_id, NULL,
      public.prod_lot_expiry(v_company_id, v_o_items[i], v_doc_date),
      v_doc_date, NULL
    );
    v_share := CASE WHEN v_n = 1 THEN 100 ELSE round(v_o_w[i] * 100 / v_w_sum, 6) END;
    INSERT INTO public.prod_production_outputs (
      company_id, production_id, sort_order, item_id, warehouse_id, qty, share_pct, ref_price,
      cost, unit_cost, lot_id
    ) VALUES (
      v_company_id, v_id, i - 1, v_o_items[i], v_o_whs[i], v_o_qtys[i], v_share, v_o_refs[i],
      v_o_cost[i], v_o_unit[i], v_o_lot
    );
    v_outputs := v_outputs || jsonb_build_array(jsonb_build_object(
      'item_id', v_o_items[i], 'qty', v_o_qtys[i], 'cost', v_o_cost[i], 'unit_cost', v_o_unit[i],
      'share_pct', v_share, 'lot_id', v_o_lot
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'total_cost', v_total_cost, 'unit_cost', v_unit_cost,
    'allocation_method', v_method, 'outputs', v_outputs
  );
END;
$$;

-- ─── 7) New RPCs ──────────────────────────────────────────────────────────

-- ═══ prod_save_accounting_settings (new) ═════════════════════════════════
-- Owner only (has_permission('sozlamalar') + role owner, like
-- prod_save_control_settings). p_data: any subset of { vat_payer boolean,
-- overhead_method 'per_kg' | 'per_value' | 'manual', base_currency 'UZS' };
-- absent key = unchanged; unknown key / bad value -> invalid_input DETAIL
-- key. Row FOR UPDATE (created when missing); logged by the prod_audit
-- trigger (action 'settings'). vat_payer applies to receipts posted AFTER
-- the change (each receipt stores vat_deductible). Returns the row.
CREATE OR REPLACE FUNCTION public.prod_save_accounting_settings(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_cur public.prod_company_accounting%ROWTYPE;
  v_key text;
  v_vat boolean;
  v_method text;
  v_cur_code text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('sozlamalar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF public.prod_ctl_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_acct_settings(v_company_id);
  SELECT * INTO v_cur FROM public.prod_company_accounting WHERE company_id = v_company_id FOR UPDATE;
  v_vat := v_cur.vat_payer;
  v_method := v_cur.overhead_method;
  v_cur_code := v_cur.base_currency;

  FOR v_key IN SELECT jsonb_object_keys(p_data)
  LOOP
    IF v_key = 'vat_payer' THEN
      v_vat := public.prod_jbool(p_data, v_key);
      IF v_vat IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
    ELSIF v_key = 'overhead_method' THEN
      v_method := public.prod_jtext(p_data, v_key, 20);
      IF v_method IS NULL OR v_method NOT IN ('per_kg', 'per_value', 'manual') THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
    ELSIF v_key = 'base_currency' THEN
      v_cur_code := public.prod_jtext(p_data, v_key, 3);
      IF v_cur_code IS DISTINCT FROM 'UZS' THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
    END IF;
  END LOOP;

  UPDATE public.prod_company_accounting
  SET vat_payer = v_vat, overhead_method = v_method, base_currency = v_cur_code,
      updated_at = now(), updated_by = auth.uid()
  WHERE company_id = v_company_id
  RETURNING * INTO v_cur;

  RETURN to_jsonb(v_cur);
END;
$$;

-- ═══ prod_save_recipe_outputs (new) ══════════════════════════════════════
-- has_permission('prod_catalog') (same key as prod_save_recipe). Replaces
-- the by-product list of a recipe: p_outputs [{ item_id, qty_per_batch }]
-- (0..20; [] clears). Items: of the company, active, finished / semi,
-- distinct, not the recipe's main item, not a recipe component (else
-- invalid_input). Recipe row FOR UPDATE (serialises with prod_save_recipe).
-- Not part of the recipe version snapshot (prod_recipe_versions). Logged by
-- the prod_audit trigger. Returns { recipe_id, outputs: n }.
CREATE OR REPLACE FUNCTION public.prod_save_recipe_outputs(p_recipe_id uuid, p_outputs jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_main uuid;
  v_line jsonb;
  v_item uuid;
  v_qty numeric;
  v_items uuid[] := '{}';
  v_qtys numeric[] := '{}';
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
  IF p_recipe_id IS NULL OR p_outputs IS NULL OR jsonb_typeof(p_outputs) <> 'array'
     OR jsonb_array_length(p_outputs) > 20 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT item_id INTO v_main FROM public.prod_recipes
  WHERE id = p_recipe_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_outputs)
  LOOP
    v_item := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty_per_batch', 4);
    IF v_item IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_item = v_main OR v_item = ANY (v_items) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_items := v_items || v_item;
    v_qtys := v_qtys || v_qty;
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_items)) <> cardinality(v_items) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.prod_items
             WHERE company_id = v_company_id AND id = ANY (v_items)
               AND (NOT is_active OR item_type NOT IN ('finished', 'semi')))
     OR EXISTS (SELECT 1 FROM public.prod_recipe_lines
                WHERE company_id = v_company_id AND recipe_id = p_recipe_id AND item_id = ANY (v_items)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  DELETE FROM public.prod_recipe_outputs
  WHERE recipe_id = p_recipe_id AND company_id = v_company_id
    AND NOT (item_id = ANY (v_items));
  FOR i IN 1 .. cardinality(v_items)
  LOOP
    INSERT INTO public.prod_recipe_outputs (company_id, recipe_id, item_id, qty_per_batch, sort_order)
    VALUES (v_company_id, p_recipe_id, v_items[i], v_qtys[i], i - 1)
    ON CONFLICT (recipe_id, item_id) DO UPDATE
      SET qty_per_batch = EXCLUDED.qty_per_batch, sort_order = EXCLUDED.sort_order;
  END LOOP;

  RETURN jsonb_build_object('recipe_id', p_recipe_id, 'outputs', cardinality(v_items));
END;
$$;

-- Common guard of the overhead RPCs (pool save / cancel, allocation):
-- the month must be open (prod_period_locks.locked_until < month start ->
-- else 'period_closed', DETAIL lock date), not in the future (invalid_input
-- DETAIL 'future_date'), and the 17 date window applies to
-- LEAST(month end, today) ('backdate' rule, override via p_ctl). Then the
-- month advisory lock 'prod_overhead:<company>:<month>' (serialises pool
-- changes with allocation runs).
CREATE OR REPLACE FUNCTION public.prod_overhead_guard(
  p_company_id uuid, p_period date, p_ctl jsonb, p_entity text, p_entity_id uuid, p_cancel boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today date := public.prod_biz_date(now());
BEGIN
  IF p_company_id IS NULL OR p_period IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  PERFORM public.prod_assert_date(p_company_id, p_period, 'cancel');
  IF NOT p_cancel THEN
    IF p_period > v_today THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'future_date';
    END IF;
    PERFORM public.prod_assert_date(p_company_id,
      LEAST((p_period + interval '1 month' - interval '1 day')::date, v_today),
      'create', p_ctl, p_entity, p_entity_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'prod_overhead:' || p_company_id::text || ':' || p_period::text, 0));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_overhead_guard(uuid, date, jsonb, text, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ═══ prod_save_cost_pool (new) ═══════════════════════════════════════════
-- Owner / admin + has_permission('prod_stock'). p_id NULL = create, else
-- update of a posted pool (period immutable: a different period ->
-- invalid_input DETAIL 'period'; cancelled -> invalid_input).
-- p_data: { period (YYYY-MM-DD, any day of the month; required on create),
--   category (labour | energy | gas | water | rent | depreciation | repair |
--   other), amount (> 0), expense_category_id?, note?, override,
--   override_note }.
-- Guard: prod_overhead_guard (open month, not future, backdate rule).
-- expense_category_id: an expense category of the company (else
-- not_found); one posted pool per (month, category) -> 'duplicate' DETAIL
-- 'expense_category_id'. Clears the month's overhead allocation (re-run
-- prod_allocate_overhead). Logged by the prod_audit trigger.
-- Returns { id, period, amount, allocation_cleared }.
CREATE OR REPLACE FUNCTION public.prod_save_cost_pool(p_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_period date;
  v_date date;
  v_category text;
  v_amount numeric;
  v_ec uuid;
  v_note text;
  v_old record;
  v_id uuid;
  v_cleared boolean;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_role := public.prod_ctl_role();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_date := public.prod_jdate(p_data, 'period');
  v_category := public.prod_jtext(p_data, 'category', 20);
  v_amount := public.prod_jnum(p_data, 'amount', 2);
  v_ec := public.prod_juuid(p_data, 'expense_category_id');
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_category IS NULL OR v_category NOT IN ('labour', 'energy', 'gas', 'water', 'rent', 'depreciation', 'repair', 'other') THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'category';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'amount';
  END IF;

  IF p_id IS NULL THEN
    IF v_date IS NULL THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'period';
    END IF;
    v_period := date_trunc('month', v_date)::date;
    v_id := gen_random_uuid();
  ELSE
    SELECT id, period, status INTO v_old FROM public.prod_cost_pools
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF v_old.status <> 'posted' THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_period := v_old.period;
    IF v_date IS NOT NULL AND date_trunc('month', v_date)::date <> v_period THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'period';
    END IF;
    v_id := p_id;
  END IF;

  IF v_ec IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expense_categories WHERE id = v_ec AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM public.prod_overhead_guard(v_company_id, v_period, p_data, 'prod_cost_pools', v_id, false);

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_cost_pools (
        id, company_id, period, category, amount, expense_category_id, note, status, created_by, created_by_name
      ) VALUES (
        v_id, v_company_id, v_period, v_category, v_amount, v_ec, v_note, 'posted', auth.uid(),
        (SELECT full_name FROM public.users WHERE id = auth.uid())
      );
    ELSE
      UPDATE public.prod_cost_pools
      SET category = v_category, amount = v_amount, expense_category_id = v_ec, note = v_note, updated_at = now()
      WHERE id = v_id AND company_id = v_company_id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate' USING DETAIL = 'expense_category_id';
  END;

  DELETE FROM public.prod_overhead_allocations WHERE company_id = v_company_id AND period = v_period;
  v_cleared := FOUND;

  RETURN jsonb_build_object('id', v_id, 'period', v_period, 'amount', v_amount, 'allocation_cleared', v_cleared);
END;
$$;

-- ═══ prod_cancel_cost_pool (new) ═════════════════════════════════════════
-- Owner / admin + has_permission('prod_stock'). Row FOR UPDATE; not_found /
-- already_cancelled; prod_ctl_cancel (17: period lock on the month start
-- -> 'period_closed', self-cancel -> 'self_cancel', audit 'cancel'); month
-- advisory lock; status cancelled; clears the month's allocation.
-- Returns { id, period, allocation_cleared }.
CREATE OR REPLACE FUNCTION public.prod_cancel_cost_pool(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_row record;
  v_cleared boolean;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_role := public.prod_ctl_role();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, period, status, created_by INTO v_row FROM public.prod_cost_pools
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_row.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  PERFORM public.prod_ctl_cancel(v_company_id, 'prod_cost_pools', p_id, v_row.period,
                                 ARRAY[v_row.created_by], 'cost_pool');
  PERFORM public.prod_overhead_guard(v_company_id, v_row.period, NULL, 'prod_cost_pools', p_id, true);

  UPDATE public.prod_cost_pools
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), updated_at = now()
  WHERE id = p_id AND company_id = v_company_id;

  DELETE FROM public.prod_overhead_allocations WHERE company_id = v_company_id AND period = v_row.period;
  v_cleared := FOUND;

  RETURN jsonb_build_object('id', p_id, 'period', v_row.period, 'allocation_cleared', v_cleared);
END;
$$;

-- ═══ prod_allocate_overhead (new) ════════════════════════════════════════
-- Owner / admin + has_permission('prod_stock'). Allocates the month's
-- posted pool total T to the outputs (prod_production_outputs) of the
-- month's POSTED productions (business date in the month):
--   per_kg     base = kg-equivalent of the output qty (prod_qty_kg; an
--              output without one gets base 0 and is reported in
--              'skipped')
--   per_value  base = the output's material cost
--   manual     p_ctl.allocations [{ output_id, amount }] (outputs of the
--              month, amounts >= 0, sum = T exactly, else invalid_input
--              DETAIL 'allocations' / 'output_id' / 'allocations_sum')
--   amount_i = round(T * base_i / sum(base), 2) in (doc_date, number,
--   sort_order) order, the last output takes the rounding remainder.
-- method = p_ctl.method or prod_company_accounting.overhead_method.
-- Re-running REPLACES the month's allocation. T = 0 -> allocation cleared.
-- T > 0 and sum(base) = 0 -> invalid_input DETAIL 'no_base'.
-- Guard: prod_overhead_guard (month not closed by the 17 period lock ->
-- 'period_closed'; future month; backdate rule with p_ctl.override).
-- Does NOT revalue lots / movements (report only). Audit row ('insert',
-- entity prod_overhead_allocations) with the run summary.
-- Returns { period, method, pool_total, allocated, rows, skipped }.
CREATE OR REPLACE FUNCTION public.prod_allocate_overhead(p_month date, p_ctl jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_period date;
  v_end_ts timestamptz;
  v_method text;
  v_total numeric;
  v_base_sum numeric := 0;
  v_rows integer := 0;
  v_n integer;
  v_skipped integer := 0;
  v_alloc numeric := 0;
  v_amount numeric;
  v_rec record;
  v_line jsonb;
  v_oid uuid;
  v_amt numeric;
  v_man_ids uuid[] := '{}';
  v_man_amts numeric[] := '{}';
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_role := public.prod_ctl_role();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_month IS NULL OR NOT isfinite(p_month) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_ctl IS NOT NULL AND jsonb_typeof(p_ctl) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_period := date_trunc('month', p_month)::date;
  v_end_ts := public.prod_day_start((v_period + interval '1 month')::date);
  v_method := COALESCE(CASE WHEN p_ctl IS NOT NULL THEN public.prod_jtext(p_ctl, 'method', 20) END,
                       (public.prod_acct_settings(v_company_id)).overhead_method);
  IF v_method NOT IN ('per_kg', 'per_value', 'manual') THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'method';
  END IF;

  PERFORM public.prod_overhead_guard(v_company_id, v_period, p_ctl, 'prod_overhead_allocations', NULL, false);

  SELECT COALESCE(sum(amount), 0) INTO v_total
  FROM public.prod_cost_pools
  WHERE company_id = v_company_id AND period = v_period AND status = 'posted';

  DELETE FROM public.prod_overhead_allocations WHERE company_id = v_company_id AND period = v_period;

  IF v_method = 'manual' THEN
    IF p_ctl IS NULL OR jsonb_typeof(p_ctl->'allocations') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_ctl->'allocations') > 5000 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocations';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_ctl->'allocations')
    LOOP
      v_oid := public.prod_juuid(v_line, 'output_id');
      v_amt := public.prod_jnum(v_line, 'amount', 2);
      IF v_oid IS NULL OR v_amt IS NULL OR v_amt < 0 OR v_oid = ANY (v_man_ids) THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocations';
      END IF;
      v_man_ids := v_man_ids || v_oid;
      v_man_amts := v_man_amts || v_amt;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM unnest(v_man_ids) AS x(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.prod_production_outputs o
        JOIN public.prod_productions p ON p.id = o.production_id AND p.company_id = o.company_id
        WHERE o.id = x.id AND o.company_id = v_company_id AND p.status = 'posted'
          AND p.doc_date >= public.prod_day_start(v_period) AND p.doc_date < v_end_ts)
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'output_id';
    END IF;
    IF (SELECT COALESCE(sum(a), 0) FROM unnest(v_man_amts) AS t(a)) <> v_total THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocations_sum';
    END IF;
  END IF;

  IF v_total > 0 THEN
    -- Base per output of the month.
    SELECT COALESCE(sum(b.base), 0), count(*) FILTER (WHERE b.base > 0), count(*) FILTER (WHERE b.base <= 0)
    INTO v_base_sum, v_n, v_skipped
    FROM (
      SELECT COALESCE(CASE v_method
               WHEN 'per_kg' THEN public.prod_qty_kg(o.qty, i.unit, i.weight_kg)
               WHEN 'per_value' THEN o.cost
               ELSE (SELECT m.a FROM unnest(v_man_ids, v_man_amts) AS m(id, a) WHERE m.id = o.id)
             END, 0) AS base
      FROM public.prod_production_outputs o
      JOIN public.prod_productions p ON p.id = o.production_id AND p.company_id = o.company_id
      JOIN public.prod_items i ON i.id = o.item_id AND i.company_id = o.company_id
      WHERE o.company_id = v_company_id AND p.status = 'posted'
        AND p.doc_date >= public.prod_day_start(v_period) AND p.doc_date < v_end_ts
    ) b;
    IF v_base_sum <= 0 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'no_base';
    END IF;

    FOR v_rec IN
      SELECT o.id AS output_id, o.production_id, o.item_id,
             COALESCE(CASE v_method
               WHEN 'per_kg' THEN public.prod_qty_kg(o.qty, i.unit, i.weight_kg)
               WHEN 'per_value' THEN o.cost
               ELSE (SELECT m.a FROM unnest(v_man_ids, v_man_amts) AS m(id, a) WHERE m.id = o.id)
             END, 0) AS base
      FROM public.prod_production_outputs o
      JOIN public.prod_productions p ON p.id = o.production_id AND p.company_id = o.company_id
      JOIN public.prod_items i ON i.id = o.item_id AND i.company_id = o.company_id
      WHERE o.company_id = v_company_id AND p.status = 'posted'
        AND p.doc_date >= public.prod_day_start(v_period) AND p.doc_date < v_end_ts
      ORDER BY p.doc_date, p.number, o.sort_order, o.id
    LOOP
      CONTINUE WHEN v_rec.base <= 0;
      v_rows := v_rows + 1;
      IF v_method = 'manual' THEN
        v_amount := v_rec.base;
      ELSIF v_rows < v_n THEN
        v_amount := round(v_total * v_rec.base / v_base_sum, 2);
      ELSE
        v_amount := v_total - v_alloc;
      END IF;
      IF v_amount < 0 THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocation';
      END IF;
      v_alloc := v_alloc + v_amount;
      INSERT INTO public.prod_overhead_allocations (
        company_id, period, production_id, output_id, item_id, method, base, amount, pool_total, created_by
      ) VALUES (
        v_company_id, v_period, v_rec.production_id, v_rec.output_id, v_rec.item_id, v_method,
        round(v_rec.base, 4), v_amount, v_total, auth.uid()
      );
    END LOOP;
  END IF;

  PERFORM public.prod_audit_write(v_company_id, 'prod_overhead_allocations', NULL, 'insert', NULL,
    jsonb_build_object('period', v_period, 'method', v_method, 'pool_total', v_total,
                       'allocated', v_alloc, 'rows', v_rows, 'skipped', v_skipped), NULL, NULL);

  RETURN jsonb_build_object('period', v_period, 'method', v_method, 'pool_total', v_total,
                            'allocated', v_alloc, 'rows', v_rows, 'skipped', v_skipped);
END;
$$;

-- ═══ prod_pnl (new) ══════════════════════════════════════════════════════
-- Owner / admin + has_permission('prod_stock'). Profit and loss of the
-- business days [p_from, p_to] (Asia/Tashkent), grouped by p_group 'day' |
-- 'week' | 'month' (default) | 'total'. Formulas: header "P&L". Posted
-- documents only, each on its own business date. p_to >= p_from, range <=
-- 3660 days ('day': <= 731) else invalid_input.
-- Returns { from, to, group, currency, vat_payer,
--   rows: [{ period, from, to, revenue, cogs, gross_profit, writeoffs,
--            production_losses, price_variance, overhead, other_expenses,
--            operating_profit, separation_loss_value }],
--   total: { same numbers, detail: { revenue[], cogs[], writeoffs[],
--            production_losses[], price_variance[], overhead[],
--            other_expenses[] } } }   (detail rows: { kind, ref, name, amount })
CREATE OR REPLACE FUNCTION public.prod_pnl(p_from date, p_to date, p_group text DEFAULT 'month')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_group text := COALESCE(p_group, 'month');
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v_vat boolean;
  v_result jsonb;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_role := public.prod_ctl_role();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to < p_from
     OR v_group NOT IN ('day', 'week', 'month', 'total')
     OR p_to - p_from > 3660 OR (v_group = 'day' AND p_to - p_from > 731) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_from_ts := public.prod_day_start(p_from);
  v_to_ts := public.prod_day_start(p_to + 1);
  SELECT vat_payer INTO v_vat FROM public.prod_company_accounting WHERE company_id = v_company_id;

  WITH days AS (
    SELECT d::date AS d,
           CASE v_group
             WHEN 'day' THEN d::date
             WHEN 'week' THEN date_trunc('week', d)::date
             WHEN 'month' THEN date_trunc('month', d)::date
             ELSE p_from
           END AS b
    FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') AS g(d)
  ),
  buckets AS (
    SELECT b, min(d) AS bfrom, max(d) AS bto FROM days GROUP BY b
  ),
  pooled AS (
    SELECT DISTINCT cp.period, cp.expense_category_id
    FROM public.prod_cost_pools cp
    WHERE cp.company_id = v_company_id AND cp.status = 'posted' AND cp.expense_category_id IS NOT NULL
  ),
  ev AS (
    -- revenue / cogs (sales)
    SELECT (s.doc_date AT TIME ZONE 'Asia/Tashkent')::date AS d, 'revenue'::text AS metric, 'sales'::text AS kind,
           NULL::text AS ref, s.subtotal AS amount
    FROM public.prod_sales s
    WHERE s.company_id = v_company_id AND s.status = 'posted' AND s.doc_date >= v_from_ts AND s.doc_date < v_to_ts
    UNION ALL
    SELECT (s.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'cogs', 'sales', NULL, s.cost_total
    FROM public.prod_sales s
    WHERE s.company_id = v_company_id AND s.status = 'posted' AND s.doc_date >= v_from_ts AND s.doc_date < v_to_ts
    -- returns
    UNION ALL
    SELECT (r.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'revenue', 'returns', NULL, -r.subtotal
    FROM public.prod_sale_returns r
    WHERE r.company_id = v_company_id AND r.status = 'posted' AND r.doc_date >= v_from_ts AND r.doc_date < v_to_ts
    UNION ALL
    SELECT (r.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'cogs', 'returns_restocked', NULL, -(r.cost_total - r.loss_cost)
    FROM public.prod_sale_returns r
    WHERE r.company_id = v_company_id AND r.status = 'posted' AND r.doc_date >= v_from_ts AND r.doc_date < v_to_ts
    UNION ALL
    SELECT (r.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'writeoffs', 'return_loss', NULL, r.loss_cost
    FROM public.prod_sale_returns r
    WHERE r.company_id = v_company_id AND r.status = 'posted' AND r.loss_cost <> 0
      AND r.doc_date >= v_from_ts AND r.doc_date < v_to_ts
    -- write-offs (by reason)
    UNION ALL
    SELECT (w.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'writeoffs', 'writeoff', w.reason, w.total_cost
    FROM public.prod_writeoffs w
    WHERE w.company_id = v_company_id AND w.status = 'posted' AND w.doc_date >= v_from_ts AND w.doc_date < v_to_ts
    -- stock counts
    UNION ALL
    SELECT (c.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'writeoffs', 'count_shortage', NULL, c.shortage_value
    FROM public.prod_stock_counts c
    WHERE c.company_id = v_company_id AND c.status = 'posted' AND c.shortage_value <> 0
      AND c.doc_date >= v_from_ts AND c.doc_date < v_to_ts
    UNION ALL
    SELECT (c.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'writeoffs', 'count_surplus', NULL, -c.surplus_value
    FROM public.prod_stock_counts c
    WHERE c.company_id = v_company_id AND c.status = 'posted' AND c.surplus_value <> 0
      AND c.doc_date >= v_from_ts AND c.doc_date < v_to_ts
    -- processing result (source cost - recovery value)
    UNION ALL
    SELECT (p.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'production_losses', 'processing', NULL,
           p.processing_cost - p.recovery_cost
    FROM public.prod_processings p
    WHERE p.company_id = v_company_id AND p.status = 'posted' AND p.doc_date >= v_from_ts AND p.doc_date < v_to_ts
    -- separation loss (memo: absorbed into the cream / skim cost)
    UNION ALL
    SELECT (sp.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'memo_separation', 'separation', NULL,
           round(sp.milk_cost * sp.loss_qty / sp.milk_qty, 2)
    FROM public.prod_separations sp
    WHERE sp.company_id = v_company_id AND sp.status = 'posted' AND sp.loss_qty > 0
      AND sp.doc_date >= v_from_ts AND sp.doc_date < v_to_ts
    -- price variance of consumed stock
    UNION ALL
    SELECT (pc.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'price_variance', 'price_correction', NULL, pc.consumed_variance
    FROM public.prod_price_corrections pc
    WHERE pc.company_id = v_company_id AND pc.status = 'posted' AND pc.consumed_variance <> 0
      AND pc.doc_date >= v_from_ts AND pc.doc_date < v_to_ts
    -- overhead pools, spread evenly over the days of their month
    UNION ALL
    SELECT dy.d, 'overhead', cp.category, NULL,
           cp.amount / extract(day FROM (cp.period + interval '1 month' - interval '1 day'))
    FROM public.prod_cost_pools cp
    JOIN days dy ON date_trunc('month', dy.d)::date = cp.period
    WHERE cp.company_id = v_company_id AND cp.status = 'posted'
    -- other expenses: cash orders out + supply expenses, minus pooled categories
    UNION ALL
    SELECT (co.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'other_expenses', 'cash_order', co.category_id::text, co.amount
    FROM public.prod_cash_orders co
    WHERE co.company_id = v_company_id AND co.direction = 'out' AND co.status = 'posted'
      AND co.doc_date >= v_from_ts AND co.doc_date < v_to_ts
      AND NOT EXISTS (SELECT 1 FROM pooled pl
                      WHERE pl.expense_category_id = co.category_id
                        AND pl.period = date_trunc('month', co.doc_date AT TIME ZONE 'Asia/Tashkent')::date)
    UNION ALL
    SELECT sm.move_date, 'other_expenses', 'supply_expense', sm.expense_category_id::text, sm.amount
    FROM public.supply_cash_moves sm
    WHERE sm.company_id = v_company_id AND sm.kind = 'expense' AND sm.status = 'posted'
      AND sm.move_date BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM pooled pl
                      WHERE pl.expense_category_id = sm.expense_category_id
                        AND pl.period = date_trunc('month', sm.move_date)::date)
  ),
  evb AS (
    SELECT dy.b, ev.metric, ev.kind, ev.ref, ev.amount
    FROM ev JOIN days dy ON dy.d = ev.d
  ),
  agg AS (
    SELECT bk.b, bk.bfrom, bk.bto,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'revenue'), 0), 2) AS revenue,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'cogs'), 0), 2) AS cogs,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'writeoffs'), 0), 2) AS writeoffs,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'production_losses'), 0), 2) AS production_losses,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'price_variance'), 0), 2) AS price_variance,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'overhead'), 0), 2) AS overhead,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'other_expenses'), 0), 2) AS other_expenses,
      round(COALESCE(sum(e.amount) FILTER (WHERE e.metric = 'memo_separation'), 0), 2) AS separation_loss_value
    FROM buckets bk
    LEFT JOIN evb e ON e.b = bk.b
    GROUP BY bk.b, bk.bfrom, bk.bto
  ),
  tot AS (
    SELECT
      COALESCE(sum(revenue), 0) AS revenue, COALESCE(sum(cogs), 0) AS cogs,
      COALESCE(sum(writeoffs), 0) AS writeoffs, COALESCE(sum(production_losses), 0) AS production_losses,
      COALESCE(sum(price_variance), 0) AS price_variance, COALESCE(sum(overhead), 0) AS overhead,
      COALESCE(sum(other_expenses), 0) AS other_expenses, COALESCE(sum(separation_loss_value), 0) AS separation_loss_value
    FROM agg
  ),
  det AS (
    SELECT e.metric, e.kind, e.ref,
           CASE
             WHEN e.metric = 'other_expenses' AND e.ref IS NOT NULL THEN
               (SELECT ec.name FROM public.expense_categories ec
                WHERE ec.id = e.ref::uuid AND ec.company_id = v_company_id)
           END AS name,
           round(sum(e.amount), 2) AS amount
    FROM evb e
    WHERE e.metric <> 'memo_separation'
    GROUP BY e.metric, e.kind, e.ref
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'group', v_group, 'currency', 'UZS', 'vat_payer', COALESCE(v_vat, false),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'period', a.b, 'from', a.bfrom, 'to', a.bto,
        'revenue', a.revenue, 'cogs', a.cogs, 'gross_profit', a.revenue - a.cogs,
        'writeoffs', a.writeoffs, 'production_losses', a.production_losses,
        'price_variance', a.price_variance, 'overhead', a.overhead, 'other_expenses', a.other_expenses,
        'operating_profit', a.revenue - a.cogs - a.writeoffs - a.production_losses - a.price_variance
                            - a.overhead - a.other_expenses,
        'separation_loss_value', a.separation_loss_value
      ) ORDER BY a.b)
      FROM agg a), '[]'::jsonb),
    'total', (
      SELECT jsonb_build_object(
        'revenue', t.revenue, 'cogs', t.cogs, 'gross_profit', t.revenue - t.cogs,
        'writeoffs', t.writeoffs, 'production_losses', t.production_losses,
        'price_variance', t.price_variance, 'overhead', t.overhead, 'other_expenses', t.other_expenses,
        'operating_profit', t.revenue - t.cogs - t.writeoffs - t.production_losses - t.price_variance
                            - t.overhead - t.other_expenses,
        'separation_loss_value', t.separation_loss_value,
        'detail', (
          SELECT jsonb_object_agg(m.metric, COALESCE((
            SELECT jsonb_agg(jsonb_build_object('kind', d2.kind, 'ref', d2.ref, 'name', d2.name, 'amount', d2.amount)
                             ORDER BY d2.kind, d2.ref NULLS FIRST)
            FROM det d2 WHERE d2.metric = m.metric), '[]'::jsonb))
          FROM unnest(ARRAY['revenue', 'cogs', 'writeoffs', 'production_losses', 'price_variance',
                            'overhead', 'other_expenses']) AS m(metric)
        )
      )
      FROM tot t)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ═══ prod_report_turnover (new) ══════════════════════════════════════════
-- has_permission('prod_stock'). Same semantics as aggregateTurnover in
-- lib/production-reports.ts: events = lot-bearing movements (lot_id NOT
-- NULL) + opening lots (is_opening, opening_qty <> 0) as an inflow at the
-- lot's created_at, all by created_at; opening = events before p_from
-- (p_from NULL: no opening), period = [p_from, p_to] (Tashkent days, by
-- created_at); in = qty > 0 (a reversal: qty < 0, i.e. a cancelled inflow
-- lowers in), out = the rest (a cancelled outflow lowers out); closing =
-- opening + in - out. value = sum(qty * unit_cost). p_warehouse / p_group
-- (item group) filter; unknown -> not_found. Rows per (warehouse, item),
-- untouched rows omitted.
-- Returns { from, to, warehouse_id, group_id, rows: [{ warehouse_id,
--   warehouse_name, item_id, item_name, item_unit, opening_qty,
--   opening_value, in_qty, in_value, out_qty, out_value, closing_qty,
--   closing_value, closing_fat, by_doc_type: { <doc_type>: { in_qty,
--   in_value, out_qty, out_value } } }], totals: { opening_value, in_value,
--   out_value, closing_value } }
CREATE OR REPLACE FUNCTION public.prod_report_turnover(
  p_from date, p_to date, p_warehouse uuid DEFAULT NULL, p_group uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v_result jsonb;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_to IS NULL OR NOT isfinite(p_to) OR (p_from IS NOT NULL AND (NOT isfinite(p_from) OR p_from > p_to)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_warehouse IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.prod_warehouses WHERE id = p_warehouse AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_group IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.prod_item_groups WHERE id = p_group AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_from_ts := CASE WHEN p_from IS NOT NULL THEN public.prod_day_start(p_from) END;
  v_to_ts := public.prod_day_start(p_to + 1);

  WITH ev AS (
    SELECT m.warehouse_id, m.item_id, m.qty, m.qty * m.unit_cost AS value, m.doc_type, m.is_reversal,
           m.created_at AS ts, m.fat_pct
    FROM public.prod_stock_movements m
    WHERE m.company_id = v_company_id AND m.lot_id IS NOT NULL AND m.created_at < v_to_ts
      AND (p_warehouse IS NULL OR m.warehouse_id = p_warehouse)
      AND (p_group IS NULL OR EXISTS (SELECT 1 FROM public.prod_items i
                                      WHERE i.id = m.item_id AND i.company_id = v_company_id AND i.group_id = p_group))
    UNION ALL
    SELECT l.warehouse_id, l.item_id, l.opening_qty, l.opening_qty * l.unit_cost, 'opening', false,
           l.created_at, l.fat_pct
    FROM public.prod_lots l
    WHERE l.company_id = v_company_id AND l.is_opening AND l.opening_qty <> 0 AND l.created_at < v_to_ts
      AND (p_warehouse IS NULL OR l.warehouse_id = p_warehouse)
      AND (p_group IS NULL OR EXISTS (SELECT 1 FROM public.prod_items i
                                      WHERE i.id = l.item_id AND i.company_id = v_company_id AND i.group_id = p_group))
  ),
  cl AS (
    SELECT ev.*,
           (v_from_ts IS NOT NULL AND ev.ts < v_from_ts) AS is_open,
           CASE WHEN ev.is_reversal THEN ev.qty < 0 ELSE ev.qty > 0 END AS is_in
    FROM ev
  ),
  k AS (
    SELECT warehouse_id, item_id,
      COALESCE(sum(qty) FILTER (WHERE is_open), 0) AS o_q,
      COALESCE(sum(value) FILTER (WHERE is_open), 0) AS o_v,
      COALESCE(sum(qty) FILTER (WHERE NOT is_open AND is_in), 0) AS i_q,
      COALESCE(sum(value) FILTER (WHERE NOT is_open AND is_in), 0) AS i_v,
      COALESCE(-sum(qty) FILTER (WHERE NOT is_open AND NOT is_in), 0) AS x_q,
      COALESCE(-sum(value) FILTER (WHERE NOT is_open AND NOT is_in), 0) AS x_v,
      sum(qty) AS c_q, sum(value) AS c_v,
      sum(qty) FILTER (WHERE fat_pct IS NOT NULL) AS f_q,
      sum(qty * fat_pct) FILTER (WHERE fat_pct IS NOT NULL) AS f_s
    FROM cl
    GROUP BY warehouse_id, item_id
  ),
  dt AS (
    SELECT warehouse_id, item_id, jsonb_object_agg(doc_type, jsonb_build_object(
             'in_qty', round(iq, 3), 'in_value', round(iv, 2), 'out_qty', round(xq, 3), 'out_value', round(xv, 2))) AS j
    FROM (
      SELECT warehouse_id, item_id, doc_type,
             COALESCE(sum(qty) FILTER (WHERE is_in), 0) AS iq, COALESCE(sum(value) FILTER (WHERE is_in), 0) AS iv,
             COALESCE(-sum(qty) FILTER (WHERE NOT is_in), 0) AS xq, COALESCE(-sum(value) FILTER (WHERE NOT is_in), 0) AS xv
      FROM cl WHERE NOT is_open
      GROUP BY warehouse_id, item_id, doc_type
    ) z
    GROUP BY warehouse_id, item_id
  ),
  r AS (
    SELECT k.*, dt.j, w.name AS wname, i.name AS iname, i.unit AS iunit
    FROM k
    LEFT JOIN dt ON dt.warehouse_id = k.warehouse_id AND dt.item_id = k.item_id
    LEFT JOIN public.prod_warehouses w ON w.id = k.warehouse_id AND w.company_id = v_company_id
    LEFT JOIN public.prod_items i ON i.id = k.item_id AND i.company_id = v_company_id
    WHERE abs(k.o_q) > 0.0005 OR abs(k.i_q) > 0.0005 OR abs(k.x_q) > 0.0005 OR abs(k.c_q) > 0.0005
       OR abs(k.o_v) > 0.005 OR abs(k.i_v) > 0.005 OR abs(k.x_v) > 0.005 OR abs(k.c_v) > 0.005
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'warehouse_id', p_warehouse, 'group_id', p_group,
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'warehouse_id', r.warehouse_id, 'warehouse_name', r.wname,
        'item_id', r.item_id, 'item_name', r.iname, 'item_unit', r.iunit,
        'opening_qty', round(r.o_q, 3), 'opening_value', round(r.o_v, 2),
        'in_qty', round(r.i_q, 3), 'in_value', round(r.i_v, 2),
        'out_qty', round(r.x_q, 3), 'out_value', round(r.x_v, 2),
        'closing_qty', round(r.c_q, 3), 'closing_value', round(r.c_v, 2),
        'closing_fat', CASE WHEN abs(COALESCE(r.f_q, 0)) > 0.0005 THEN round(r.f_s / r.f_q, 3) END,
        'by_doc_type', COALESCE(r.j, '{}'::jsonb)
      ) ORDER BY r.iname, r.item_id, r.wname, r.warehouse_id) FROM r), '[]'::jsonb),
    'totals', (SELECT jsonb_build_object(
        'opening_value', round(COALESCE(sum(r.o_v), 0), 2), 'in_value', round(COALESCE(sum(r.i_v), 0), 2),
        'out_value', round(COALESCE(sum(r.x_v), 0), 2), 'closing_value', round(COALESCE(sum(r.c_v), 0), 2)) FROM r)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ═══ prod_report_dashboard (new) ═════════════════════════════════════════
-- Sections are filled only for the caller's permissions (others null):
--   sales   prod_sales   revenue = net sales amount (ex VAT, returns
--                        negative, prod_sales_lines_v); cogs / margin only
--                        for owner / admin (null otherwise)
--   milk    prod_milk    milk_kg = net_kg of accepted + conditional
--                        intakes, avg_fat kg-weighted over those with fat
--   output  prod_production  output_kg = kg-equivalent of every output
--                        (main + co-products) of posted productions
--   cash    prod_cash    end-of-bucket balance of all accounts (opening
--                        balances + movements before the bucket end)
--   stock   prod_stock   current qty / value per warehouse (prod_stock)
--   outflows prod_cash / prod_supply  cash orders out + supply expenses of
--                        the period by expense category
-- Buckets: p_group 'day' (default) | 'month' (key = first day). Previous
-- period = the same number of days right before p_from. Range <= 3660 days
-- ('day': <= 400). Business dates (Asia/Tashkent).
-- Returns { from, to, group, prev_from, prev_to, series: [{ period,
--   revenue, cogs, margin, milk_kg, avg_fat, output_kg, cash_balance }],
--   totals: {...}, prev_totals: {...}, sales_by_group: [{ group_id,
--   group_name, revenue, cogs, margin }], stock_by_warehouse: [{
--   warehouse_id, warehouse_name, qty, value }], outflows: [{ source,
--   category_id, category_name, amount }] }
CREATE OR REPLACE FUNCTION public.prod_report_dashboard(p_from date, p_to date, p_group text DEFAULT 'day')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_group text := COALESCE(p_group, 'day');
  v_n integer;
  v_pfrom date;
  v_pto date;
  v_sales boolean;
  v_cost boolean;
  v_milk boolean;
  v_out boolean;
  v_cash boolean;
  v_stock boolean;
  v_supply boolean;
  v_result jsonb;
BEGIN
  PERFORM public.assert_business_type('production');
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to < p_from
     OR v_group NOT IN ('day', 'month')
     OR p_to - p_from > 3660 OR (v_group = 'day' AND p_to - p_from > 400) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_sales := public.has_permission('prod_sales');
  v_cost := v_sales AND COALESCE(public.prod_ctl_role(), '') IN ('owner', 'admin');
  v_milk := public.has_permission('prod_milk');
  v_out := public.has_permission('prod_production');
  v_cash := public.has_permission('prod_cash');
  v_stock := public.has_permission('prod_stock');
  v_supply := public.has_permission('prod_supply');
  IF NOT (v_sales OR v_milk OR v_out OR v_cash OR v_stock OR v_supply) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_n := p_to - p_from + 1;
  v_pfrom := p_from - v_n;
  v_pto := p_from - 1;

  WITH days AS (
    SELECT d::date AS d, CASE WHEN v_group = 'month' THEN date_trunc('month', d)::date ELSE d::date END AS b,
           (d::date >= p_from) AS cur
    FROM generate_series(v_pfrom::timestamp, p_to::timestamp, interval '1 day') AS g(d)
  ),
  sl AS (
    SELECT (v.doc_date AT TIME ZONE 'Asia/Tashkent')::date AS d, v.group_id, v.group_name, v.amount, v.cost
    FROM public.prod_sales_lines_v v
    WHERE v_sales AND v.company_id = v_company_id
      AND v.doc_date >= public.prod_day_start(v_pfrom) AND v.doc_date < public.prod_day_start(p_to + 1)
  ),
  mk AS (
    SELECT (mi.intake_date AT TIME ZONE 'Asia/Tashkent')::date AS d, mi.net_kg, mi.fat_pct
    FROM public.prod_milk_intakes mi
    WHERE v_milk AND mi.company_id = v_company_id AND mi.status IN ('accepted', 'conditional')
      AND mi.intake_date >= public.prod_day_start(v_pfrom) AND mi.intake_date < public.prod_day_start(p_to + 1)
  ),
  op AS (
    SELECT (p.doc_date AT TIME ZONE 'Asia/Tashkent')::date AS d, public.prod_qty_kg(o.qty, i.unit, i.weight_kg) AS kg
    FROM public.prod_production_outputs o
    JOIN public.prod_productions p ON p.id = o.production_id AND p.company_id = o.company_id
    JOIN public.prod_items i ON i.id = o.item_id AND i.company_id = o.company_id
    WHERE v_out AND o.company_id = v_company_id AND p.status = 'posted'
      AND p.doc_date >= public.prod_day_start(v_pfrom) AND p.doc_date < public.prod_day_start(p_to + 1)
  ),
  cash_base AS (
    SELECT COALESCE((SELECT sum(a.opening_balance) FROM public.prod_cash_accounts a WHERE a.company_id = v_company_id), 0)
         + COALESCE((SELECT sum(m.amount) FROM public.prod_cash_movements m
                     WHERE m.company_id = v_company_id AND m.move_date < public.prod_day_start(v_pfrom)), 0) AS base
  ),
  cm AS (
    SELECT (m.move_date AT TIME ZONE 'Asia/Tashkent')::date AS d, sum(m.amount) AS amount
    FROM public.prod_cash_movements m
    WHERE v_cash AND m.company_id = v_company_id
      AND m.move_date >= public.prod_day_start(v_pfrom) AND m.move_date < public.prod_day_start(p_to + 1)
    GROUP BY 1
  ),
  daily AS (
    SELECT dy.d, dy.b, dy.cur,
      (SELECT COALESCE(sum(amount), 0) FROM sl WHERE sl.d = dy.d) AS revenue,
      (SELECT COALESCE(sum(cost), 0) FROM sl WHERE sl.d = dy.d) AS cogs,
      (SELECT COALESCE(sum(net_kg), 0) FROM mk WHERE mk.d = dy.d) AS milk_kg,
      (SELECT COALESCE(sum(net_kg), 0) FROM mk WHERE mk.d = dy.d AND mk.fat_pct IS NOT NULL) AS fat_w,
      (SELECT COALESCE(sum(net_kg * fat_pct), 0) FROM mk WHERE mk.d = dy.d AND mk.fat_pct IS NOT NULL) AS fat_s,
      (SELECT COALESCE(sum(kg), 0) FROM op WHERE op.d = dy.d) AS output_kg,
      (SELECT base FROM cash_base) + sum(COALESCE(cm.amount, 0)) OVER (ORDER BY dy.d) AS cash_end
    FROM days dy
    LEFT JOIN cm ON cm.d = dy.d
  ),
  ser AS (
    SELECT b, sum(revenue) AS revenue, sum(cogs) AS cogs, sum(milk_kg) AS milk_kg, sum(fat_w) AS fat_w,
           sum(fat_s) AS fat_s, sum(output_kg) AS output_kg,
           (array_agg(cash_end ORDER BY d DESC))[1] AS cash_balance
    FROM daily WHERE cur GROUP BY b
  ),
  tt AS (
    SELECT cur, sum(revenue) AS revenue, sum(cogs) AS cogs, sum(milk_kg) AS milk_kg, sum(fat_w) AS fat_w,
           sum(fat_s) AS fat_s, sum(output_kg) AS output_kg,
           (array_agg(cash_end ORDER BY d DESC))[1] AS cash_balance
    FROM daily GROUP BY cur
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'group', v_group, 'prev_from', v_pfrom, 'prev_to', v_pto,
    'series', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'period', s.b,
        'revenue', CASE WHEN v_sales THEN round(s.revenue, 2) END,
        'cogs', CASE WHEN v_cost THEN round(s.cogs, 2) END,
        'margin', CASE WHEN v_cost THEN round(s.revenue - s.cogs, 2) END,
        'milk_kg', CASE WHEN v_milk THEN round(s.milk_kg, 3) END,
        'avg_fat', CASE WHEN v_milk AND s.fat_w > 0 THEN round(s.fat_s / s.fat_w, 3) END,
        'output_kg', CASE WHEN v_out THEN round(s.output_kg, 3) END,
        'cash_balance', CASE WHEN v_cash THEN round(s.cash_balance, 2) END
      ) ORDER BY s.b) FROM ser s), '[]'::jsonb),
    'totals', (SELECT jsonb_build_object(
        'revenue', CASE WHEN v_sales THEN round(t.revenue, 2) END,
        'cogs', CASE WHEN v_cost THEN round(t.cogs, 2) END,
        'margin', CASE WHEN v_cost THEN round(t.revenue - t.cogs, 2) END,
        'milk_kg', CASE WHEN v_milk THEN round(t.milk_kg, 3) END,
        'avg_fat', CASE WHEN v_milk AND t.fat_w > 0 THEN round(t.fat_s / t.fat_w, 3) END,
        'output_kg', CASE WHEN v_out THEN round(t.output_kg, 3) END,
        'cash_balance', CASE WHEN v_cash THEN round(t.cash_balance, 2) END)
      FROM tt t WHERE t.cur),
    'prev_totals', (SELECT jsonb_build_object(
        'revenue', CASE WHEN v_sales THEN round(t.revenue, 2) END,
        'cogs', CASE WHEN v_cost THEN round(t.cogs, 2) END,
        'margin', CASE WHEN v_cost THEN round(t.revenue - t.cogs, 2) END,
        'milk_kg', CASE WHEN v_milk THEN round(t.milk_kg, 3) END,
        'avg_fat', CASE WHEN v_milk AND t.fat_w > 0 THEN round(t.fat_s / t.fat_w, 3) END,
        'output_kg', CASE WHEN v_out THEN round(t.output_kg, 3) END,
        'cash_balance', CASE WHEN v_cash THEN round(t.cash_balance, 2) END)
      FROM tt t WHERE NOT t.cur),
    'sales_by_group', CASE WHEN v_sales THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'group_id', g.group_id, 'group_name', g.group_name, 'revenue', round(g.revenue, 2),
        'cogs', CASE WHEN v_cost THEN round(g.cogs, 2) END,
        'margin', CASE WHEN v_cost THEN round(g.revenue - g.cogs, 2) END) ORDER BY g.revenue DESC, g.group_name)
      FROM (SELECT group_id, max(group_name) AS group_name, sum(amount) AS revenue, sum(cost) AS cogs
            FROM sl WHERE sl.d >= p_from GROUP BY group_id) g), '[]'::jsonb) END,
    'stock_by_warehouse', CASE WHEN v_stock THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'warehouse_id', x.warehouse_id, 'warehouse_name', x.name, 'qty', round(x.qty, 3), 'value', round(x.value, 2))
        ORDER BY x.name)
      FROM (SELECT st.warehouse_id, w.name, sum(st.qty) AS qty, sum(st.value) AS value
            FROM public.prod_stock st
            JOIN public.prod_warehouses w ON w.id = st.warehouse_id AND w.company_id = st.company_id
            WHERE st.company_id = v_company_id AND st.qty <> 0
            GROUP BY st.warehouse_id, w.name) x), '[]'::jsonb) END,
    'outflows', CASE WHEN v_cash OR v_supply THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'source', o.source, 'category_id', o.category_id, 'category_name', ec.name, 'amount', round(o.amount, 2))
        ORDER BY o.amount DESC)
      FROM (
        SELECT 'cash_order'::text AS source, co.category_id, sum(co.amount) AS amount
        FROM public.prod_cash_orders co
        WHERE v_cash AND co.company_id = v_company_id AND co.direction = 'out' AND co.status = 'posted'
          AND co.doc_date >= public.prod_day_start(p_from) AND co.doc_date < public.prod_day_start(p_to + 1)
        GROUP BY co.category_id
        UNION ALL
        SELECT 'supply_expense', sm.expense_category_id, sum(sm.amount)
        FROM public.supply_cash_moves sm
        WHERE v_supply AND sm.company_id = v_company_id AND sm.kind = 'expense' AND sm.status = 'posted'
          AND sm.move_date BETWEEN p_from AND p_to
        GROUP BY sm.expense_category_id
      ) o
      LEFT JOIN public.expense_categories ec ON ec.id = o.category_id AND ec.company_id = v_company_id), '[]'::jsonb) END
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ═══ prod_report_sales (new) ═════════════════════════════════════════════
-- has_permission('prod_sales'). Sales report of the business days
-- [p_from, p_to] from prod_sales_lines_v (posted sales + posted returns as
-- negative rows), grouped by p_by 'product' (default) | 'customer' |
-- 'group' | 'day' | 'month'. revenue = net amount ex VAT (sales - returns),
-- vat, total; cost / margin only for owner / admin (null otherwise); qty
-- only by product (units differ otherwise). Range <= 3660 days.
-- Returns { from, to, by, rows: [{ key, name, unit, qty, sales_amount,
--   returns_amount, revenue, vat, total, cost, margin, sales_count }],
--   totals: { sales_amount, returns_amount, revenue, vat, total, cost,
--   margin, sales_count } }
CREATE OR REPLACE FUNCTION public.prod_report_sales(p_from date, p_to date, p_by text DEFAULT 'product')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_by text := COALESCE(p_by, 'product');
  v_cost boolean;
  v_result jsonb;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to < p_from
     OR p_to - p_from > 3660 OR v_by NOT IN ('product', 'customer', 'group', 'day', 'month') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_cost := COALESCE(public.prod_ctl_role(), '') IN ('owner', 'admin');

  WITH l AS (
    SELECT v.*,
      CASE v_by
        WHEN 'product' THEN v.item_id::text
        WHEN 'customer' THEN v.customer_id::text
        WHEN 'group' THEN v.group_id::text
        WHEN 'day' THEN to_char((v.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', v.doc_date AT TIME ZONE 'Asia/Tashkent')::date, 'YYYY-MM-DD')
      END AS k,
      CASE v_by
        WHEN 'product' THEN v.item_name
        WHEN 'customer' THEN v.customer_name
        WHEN 'group' THEN v.group_name
      END AS nm
    FROM public.prod_sales_lines_v v
    WHERE v.company_id = v_company_id
      AND v.doc_date >= public.prod_day_start(p_from) AND v.doc_date < public.prod_day_start(p_to + 1)
  ),
  g AS (
    SELECT k, max(nm) AS nm, max(item_unit) AS unit, sum(qty) AS qty,
           COALESCE(sum(amount) FILTER (WHERE row_kind = 'sale'), 0) AS s_amt,
           COALESCE(-sum(amount) FILTER (WHERE row_kind = 'return'), 0) AS r_amt,
           sum(amount) AS revenue, sum(vat_amount) AS vat, sum(total) AS total, sum(cost) AS cost,
           count(DISTINCT sale_id) FILTER (WHERE row_kind = 'sale') AS n
    FROM l GROUP BY k
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'by', v_by,
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', g.k, 'name', g.nm,
        'unit', CASE WHEN v_by = 'product' THEN g.unit END,
        'qty', CASE WHEN v_by = 'product' THEN round(g.qty, 3) END,
        'sales_amount', round(g.s_amt, 2), 'returns_amount', round(g.r_amt, 2),
        'revenue', round(g.revenue, 2), 'vat', round(g.vat, 2), 'total', round(g.total, 2),
        'cost', CASE WHEN v_cost THEN round(g.cost, 2) END,
        'margin', CASE WHEN v_cost THEN round(g.revenue - g.cost, 2) END,
        'sales_count', g.n
      ) ORDER BY CASE WHEN v_by IN ('day', 'month') THEN g.k END, g.revenue DESC, g.nm, g.k) FROM g), '[]'::jsonb),
    'totals', (SELECT jsonb_build_object(
        'sales_amount', round(COALESCE(sum(l.amount) FILTER (WHERE l.row_kind = 'sale'), 0), 2),
        'returns_amount', round(COALESCE(-sum(l.amount) FILTER (WHERE l.row_kind = 'return'), 0), 2),
        'revenue', round(COALESCE(sum(l.amount), 0), 2), 'vat', round(COALESCE(sum(l.vat_amount), 0), 2),
        'total', round(COALESCE(sum(l.total), 0), 2),
        'cost', CASE WHEN v_cost THEN round(COALESCE(sum(l.cost), 0), 2) END,
        'margin', CASE WHEN v_cost THEN round(COALESCE(sum(l.amount) - sum(l.cost), 0), 2) END,
        'sales_count', count(DISTINCT l.sale_id) FILTER (WHERE l.row_kind = 'sale')) FROM l)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated for the replaced RPCs.
REVOKE EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_price_correction(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_production(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_accounting_settings(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_recipe_outputs(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_cost_pool(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_cost_pool(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_allocate_overhead(date, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_pnl(date, date, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_report_turnover(date, date, uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_report_dashboard(date, date, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_report_sales(date, date, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_price_correction(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_production(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_accounting_settings(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_recipe_outputs(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_cost_pool(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_cost_pool(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_allocate_overhead(date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_pnl(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_report_turnover(date, date, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_report_dashboard(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_report_sales(date, date, text) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on every new table:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_company_accounting', 'prod_production_outputs', 'prod_recipe_outputs',
--                     'prod_cost_pools', 'prod_overhead_allocations')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_company_accounting', 'prod_production_outputs', 'prod_recipe_outputs',
--                      'prod_cost_pools', 'prod_overhead_allocations', 'prod_vat_summary',
--                      'prod_product_costs_month', 'prod_cost_pool_suggestions');
-- -- every production has exactly one main output row:
-- SELECT count(*) FROM public.prod_productions p
-- WHERE NOT EXISTS (SELECT 1 FROM public.prod_production_outputs o WHERE o.production_id = p.id AND o.sort_order = 0);
