-- Production company type, file 3 of 5: production tables and views.
--
-- Access model (every table below):
--   * company_id uuid NOT NULL -> companies ON DELETE CASCADE.
--   * RLS enabled; ONE policy: SELECT TO authenticated, company-scoped via
--     (SELECT public.get_company_id()) (initPlan form, see
--     20261108000002_rls_initplan_optimization.sql).
--   * REVOKE ALL from authenticated + anon, then GRANT SELECT to
--     authenticated only. Supabase's default privileges grant
--     INSERT/UPDATE/DELETE/TRUNCATE to anon/authenticated on every new
--     table - that leak is closed explicitly here. anon gets nothing.
--   * ALL writes go through the SECURITY DEFINER RPCs in file 4
--     (20261110000004_production_rpcs.sql) or the service role.
--
-- Cross-company integrity: every parent table has UNIQUE (id, company_id)
-- and every child references it with a COMPOSITE FK (x_id, company_id), so
-- a row can never point at another company's item/warehouse/document even
-- if an RPC had a bug (same pattern as branches in 20261109000001/2).
--
-- Units: 'kg','l','g','pcs','m'. Quantities numeric(14,3), money
-- numeric(14,2), single currency UZS. No lots / expiry / lab tests (MVP).
--
-- Stock is NOT stored as a mutable balance: public.prod_stock_movements is
-- an append-only ledger and public.prod_stock is a view summing it.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) prod_item_groups ──────────────────────────────────────────────────

CREATE TABLE public.prod_item_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_item_groups_company_name_key UNIQUE (company_id, name),
  CONSTRAINT prod_item_groups_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_item_groups_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 100)
);

COMMENT ON TABLE public.prod_item_groups IS
  'Production item groups. Read via RLS (company-scoped SELECT); write ONLY via prod_save_item_group.';

-- ─── 2) prod_items ────────────────────────────────────────────────────────

CREATE TABLE public.prod_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  group_id uuid NULL,
  name text NOT NULL,
  sku text NULL,
  barcode text NULL,
  unit text NOT NULL,
  weight_kg numeric(14,3) NULL,
  item_type text NOT NULL,
  min_stock numeric(14,3) NULL,
  max_stock numeric(14,3) NULL,
  is_active boolean NOT NULL DEFAULT true,
  description text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_items_company_name_key UNIQUE (company_id, name),
  CONSTRAINT prod_items_id_company_key UNIQUE (id, company_id),
  -- MATCH SIMPLE: a NULL group_id skips the check (ungrouped item).
  CONSTRAINT prod_items_group_fk FOREIGN KEY (group_id, company_id)
    REFERENCES public.prod_item_groups (id, company_id),
  CONSTRAINT prod_items_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT prod_items_unit_check CHECK (unit IN ('kg', 'l', 'g', 'pcs', 'm')),
  CONSTRAINT prod_items_item_type_check CHECK (item_type IN ('raw', 'semi', 'finished', 'packaging')),
  CONSTRAINT prod_items_weight_check CHECK (weight_kg IS NULL OR weight_kg >= 0),
  CONSTRAINT prod_items_min_stock_check CHECK (min_stock IS NULL OR min_stock >= 0),
  CONSTRAINT prod_items_max_stock_check CHECK (max_stock IS NULL OR max_stock >= 0),
  CONSTRAINT prod_items_min_max_check CHECK (min_stock IS NULL OR max_stock IS NULL OR max_stock >= min_stock),
  CONSTRAINT prod_items_sku_check CHECK (sku IS NULL OR length(sku) <= 100),
  CONSTRAINT prod_items_barcode_check CHECK (barcode IS NULL OR length(barcode) <= 100),
  CONSTRAINT prod_items_description_check CHECK (description IS NULL OR length(description) <= 500)
);

COMMENT ON TABLE public.prod_items IS
  'Production items (raw, semi, finished, packaging). Read via RLS; write ONLY via prod_save_item.';

CREATE INDEX prod_items_company_group_idx ON public.prod_items (company_id, group_id);

-- ─── 3) prod_warehouses ───────────────────────────────────────────────────
-- Separate from retail public.warehouses on purpose: no branch_id, no
-- (company_id, type) uniqueness, storage_types instead of a single type.

CREATE TABLE public.prod_warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  storage_types text[] NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_warehouses_company_name_key UNIQUE (company_id, name),
  CONSTRAINT prod_warehouses_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_warehouses_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- Non-empty subset of the allowed storage types. NULL elements fail <@.
  CONSTRAINT prod_warehouses_storage_types_check CHECK (
    cardinality(storage_types) > 0
    AND storage_types <@ ARRAY['raw', 'finished', 'production', 'processing', 'return']::text[]
  )
);

COMMENT ON TABLE public.prod_warehouses IS
  'Production warehouses. Read via RLS; write ONLY via prod_save_warehouse '
  '(two are seeded by handle_new_company for production firms).';

-- ─── 4) prod_stock_movements (append-only ledger) ─────────────────────────
-- qty > 0 = inflow, qty < 0 = outflow. Outflows are written at the item's
-- average cost at the moment of issue, so sum(qty * unit_cost) stays the
-- remaining stock value. A cancelled document is never edited: its
-- movements are mirrored with is_reversal = true (same unit_cost).
--
-- created_by deliberately has NO FK to auth.users: an "ON DELETE SET NULL"
-- FK would be an UPDATE on this table and the append-only trigger would
-- then block deleting a staff account forever. doc_id is polymorphic
-- (receipt / production / processing id), hence no FK either.

CREATE TABLE public.prod_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  doc_type text NOT NULL,
  doc_id uuid NOT NULL,
  is_reversal boolean NOT NULL DEFAULT false,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_stock_movements_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_stock_movements_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_stock_movements_qty_check CHECK (qty <> 0),
  CONSTRAINT prod_stock_movements_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT prod_stock_movements_doc_type_check CHECK (doc_type IN ('receipt', 'production', 'processing'))
);

COMMENT ON TABLE public.prod_stock_movements IS
  'Append-only production stock ledger. UPDATE/DELETE/TRUNCATE are refused by '
  'trigger for every role (only the company ON DELETE CASCADE may remove rows). '
  'Written ONLY by production RPCs.';

CREATE INDEX prod_stock_movements_stock_idx
  ON public.prod_stock_movements (company_id, warehouse_id, item_id);
CREATE INDEX prod_stock_movements_doc_idx
  ON public.prod_stock_movements (doc_type, doc_id);
-- Composite-FK support for item-side lookups (e.g. "where is item X").
CREATE INDEX prod_stock_movements_item_idx
  ON public.prod_stock_movements (item_id, company_id);

-- Append-only guard. Fires for every role, including SECURITY DEFINER
-- functions and the service role. Single exception: rows of a company that
-- no longer exists, i.e. the ON DELETE CASCADE from public.companies when
-- super-admin deletes a firm (the cascade runs after the parent row is
-- deleted, so it is no longer visible here). Without this exception,
-- deleteCompany would fail for every production firm.
CREATE OR REPLACE FUNCTION public.prod_stock_movements_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Nested IF (not AND): OLD must not be touched for the statement-level
  -- TRUNCATE trigger.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'prod_stock_movements is append-only (% refused)', TG_OP
    USING ERRCODE = '42501';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_stock_movements_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prod_stock_movements_no_update_delete
  BEFORE UPDATE OR DELETE ON public.prod_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.prod_stock_movements_append_only();

CREATE TRIGGER prod_stock_movements_no_truncate
  BEFORE TRUNCATE ON public.prod_stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION public.prod_stock_movements_append_only();

-- ─── 5) prod_stock view ───────────────────────────────────────────────────
-- security_invoker = true: the caller's RLS on prod_stock_movements applies
-- (company-scoped), the view never widens access.
-- Zero-balance groups are kept (qty = 0); the UI filters them.

CREATE VIEW public.prod_stock
WITH (security_invoker = true)
AS
SELECT
  m.company_id,
  m.warehouse_id,
  m.item_id,
  sum(m.qty) AS qty,
  round(sum(m.qty * m.unit_cost), 2) AS value,
  CASE
    WHEN sum(m.qty) > 0 THEN round(sum(m.qty * m.unit_cost) / sum(m.qty), 2)
    ELSE 0::numeric
  END AS avg_cost
FROM public.prod_stock_movements m
GROUP BY m.company_id, m.warehouse_id, m.item_id;

COMMENT ON VIEW public.prod_stock IS
  'Current production stock per (company, warehouse, item) = sum of the ledger. '
  'avg_cost = value / qty (0 when qty <= 0).';

-- ─── 6) Documents: receipts (xom ashyo kirimi) ────────────────────────────
-- number: per-company sequence (max + 1 under an advisory lock in the RPC),
-- uniqueness enforced here.
-- status / cancelled_at consistency enforced by CHECK.

CREATE TABLE public.prod_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NOT NULL,
  supplier_name text NULL,
  note text NULL,
  total numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_receipts_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_receipts_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_receipts_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_receipts_number_check CHECK (number > 0),
  CONSTRAINT prod_receipts_total_check CHECK (total >= 0),
  CONSTRAINT prod_receipts_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_receipts_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_receipts_supplier_check CHECK (supplier_name IS NULL OR length(supplier_name) <= 200),
  CONSTRAINT prod_receipts_note_check CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX prod_receipts_company_date_idx ON public.prod_receipts (company_id, doc_date DESC);

CREATE TABLE public.prod_receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL,
  price numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  CONSTRAINT prod_receipt_items_receipt_fk FOREIGN KEY (receipt_id, company_id)
    REFERENCES public.prod_receipts (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_receipt_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_receipt_items_qty_check CHECK (qty > 0),
  CONSTRAINT prod_receipt_items_price_check CHECK (price >= 0),
  CONSTRAINT prod_receipt_items_total_check CHECK (total >= 0)
);

CREATE INDEX prod_receipt_items_receipt_idx ON public.prod_receipt_items (receipt_id, company_id);
CREATE INDEX prod_receipt_items_item_idx ON public.prod_receipt_items (item_id, company_id);

-- ─── 7) Documents: productions (ishlab chiqarish) ─────────────────────────

CREATE TABLE public.prod_productions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NOT NULL,
  output_item_id uuid NOT NULL,
  output_qty numeric(14,3) NOT NULL,
  total_cost numeric(14,2) NOT NULL DEFAULT 0,
  unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_productions_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_productions_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_productions_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_productions_output_item_fk FOREIGN KEY (output_item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_productions_number_check CHECK (number > 0),
  CONSTRAINT prod_productions_output_qty_check CHECK (output_qty > 0),
  CONSTRAINT prod_productions_total_cost_check CHECK (total_cost >= 0),
  CONSTRAINT prod_productions_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT prod_productions_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_productions_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_productions_note_check CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX prod_productions_company_date_idx ON public.prod_productions (company_id, doc_date DESC);
CREATE INDEX prod_productions_output_item_idx ON public.prod_productions (output_item_id, company_id);

CREATE TABLE public.prod_production_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  production_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  CONSTRAINT prod_production_components_production_fk FOREIGN KEY (production_id, company_id)
    REFERENCES public.prod_productions (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_production_components_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_production_components_qty_check CHECK (qty > 0),
  CONSTRAINT prod_production_components_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT prod_production_components_total_check CHECK (total >= 0)
);

CREATE INDEX prod_production_components_production_idx
  ON public.prod_production_components (production_id, company_id);
CREATE INDEX prod_production_components_item_idx
  ON public.prod_production_components (item_id, company_id);

-- ─── 8) Documents: processings (qayta ishlash) ────────────────────────────
-- profit = recovery_cost - processing_cost, may be negative (loss).

CREATE TABLE public.prod_processings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NOT NULL,
  source_item_id uuid NOT NULL,
  source_qty numeric(14,3) NOT NULL,
  source_unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  processing_cost numeric(14,2) NOT NULL DEFAULT 0,
  recovery_cost numeric(14,2) NOT NULL DEFAULT 0,
  profit numeric(14,2) NOT NULL DEFAULT 0,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_processings_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_processings_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_processings_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_processings_source_item_fk FOREIGN KEY (source_item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_processings_number_check CHECK (number > 0),
  CONSTRAINT prod_processings_source_qty_check CHECK (source_qty > 0),
  CONSTRAINT prod_processings_source_unit_cost_check CHECK (source_unit_cost >= 0),
  CONSTRAINT prod_processings_processing_cost_check CHECK (processing_cost >= 0),
  CONSTRAINT prod_processings_recovery_cost_check CHECK (recovery_cost >= 0),
  CONSTRAINT prod_processings_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_processings_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_processings_note_check CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX prod_processings_company_date_idx ON public.prod_processings (company_id, doc_date DESC);
CREATE INDEX prod_processings_source_item_idx ON public.prod_processings (source_item_id, company_id);

CREATE TABLE public.prod_processing_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  processing_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL,
  price numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  CONSTRAINT prod_processing_outputs_processing_fk FOREIGN KEY (processing_id, company_id)
    REFERENCES public.prod_processings (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_processing_outputs_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_processing_outputs_qty_check CHECK (qty > 0),
  CONSTRAINT prod_processing_outputs_price_check CHECK (price >= 0),
  CONSTRAINT prod_processing_outputs_total_check CHECK (total >= 0)
);

CREATE INDEX prod_processing_outputs_processing_idx
  ON public.prod_processing_outputs (processing_id, company_id);
CREATE INDEX prod_processing_outputs_item_idx
  ON public.prod_processing_outputs (item_id, company_id);

-- ─── 9) Supply agents (ta'minot) and their cash ───────────────────────────

CREATE TABLE public.supply_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NULL,
  telegram_id text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_agents_company_name_key UNIQUE (company_id, name),
  CONSTRAINT supply_agents_id_company_key UNIQUE (id, company_id),
  CONSTRAINT supply_agents_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT supply_agents_phone_check CHECK (phone IS NULL OR length(phone) <= 30),
  CONSTRAINT supply_agents_telegram_check CHECK (telegram_id IS NULL OR length(telegram_id) <= 64)
);

COMMENT ON TABLE public.supply_agents IS
  'Supply agents (ta''minotchilar) holding company cash. Read via RLS; write ONLY via supply_save_agent.';

-- expense_category_id: plain FK (expense_categories has no (id, company_id)
-- unique key and this migration does not alter a retail table); the
-- company match is enforced in supply_add_move. ON DELETE SET NULL because
-- expense_categories are directly deletable by company users (its RLS is
-- FOR ALL) and a deleted category must not block that delete.
CREATE TABLE public.supply_cash_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  kind text NOT NULL,
  amount numeric(14,2) NOT NULL,
  purpose text NULL,
  expense_category_id uuid NULL REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  move_date date NOT NULL DEFAULT current_date,
  note text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supply_cash_moves_agent_fk FOREIGN KEY (agent_id, company_id)
    REFERENCES public.supply_agents (id, company_id),
  CONSTRAINT supply_cash_moves_kind_check CHECK (kind IN ('issue', 'return', 'expense')),
  CONSTRAINT supply_cash_moves_amount_check CHECK (amount > 0),
  CONSTRAINT supply_cash_moves_category_kind_check CHECK (kind = 'expense' OR expense_category_id IS NULL),
  CONSTRAINT supply_cash_moves_purpose_check CHECK (purpose IS NULL OR length(purpose) <= 200),
  CONSTRAINT supply_cash_moves_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.supply_cash_moves IS
  'Cash given to (issue), returned by (return) or spent by (expense) a supply agent. '
  'Read via RLS; write ONLY via supply_add_move.';

CREATE INDEX supply_cash_moves_agent_idx ON public.supply_cash_moves (agent_id, company_id);
CREATE INDEX supply_cash_moves_company_date_idx ON public.supply_cash_moves (company_id, move_date DESC);
CREATE INDEX supply_cash_moves_category_idx
  ON public.supply_cash_moves (expense_category_id) WHERE expense_category_id IS NOT NULL;

-- Every agent appears (zeros when it has no moves).
CREATE VIEW public.supply_agent_balances
WITH (security_invoker = true)
AS
SELECT
  a.id AS agent_id,
  a.company_id,
  COALESCE(m.issued, 0) AS issued,
  COALESCE(m.returned, 0) AS returned,
  COALESCE(m.spent, 0) AS spent,
  (COALESCE(m.issued, 0) - COALESCE(m.returned, 0) - COALESCE(m.spent, 0)) AS balance
FROM public.supply_agents a
LEFT JOIN (
  SELECT
    agent_id,
    company_id,
    sum(amount) FILTER (WHERE kind = 'issue') AS issued,
    sum(amount) FILTER (WHERE kind = 'return') AS returned,
    sum(amount) FILTER (WHERE kind = 'expense') AS spent
  FROM public.supply_cash_moves
  GROUP BY agent_id, company_id
) m ON m.agent_id = a.id AND m.company_id = a.company_id;

COMMENT ON VIEW public.supply_agent_balances IS
  'Per-agent cash balance: issued - returned - spent.';

-- ─── 10) RLS, policies, grants ────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'prod_item_groups', 'prod_items', 'prod_warehouses', 'prod_stock_movements',
    'prod_receipts', 'prod_receipt_items',
    'prod_productions', 'prod_production_components',
    'prod_processings', 'prod_processing_outputs',
    'supply_agents', 'supply_cash_moves'
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
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END;
$$;

REVOKE ALL ON public.prod_stock FROM authenticated, anon;
GRANT SELECT ON public.prod_stock TO authenticated;
REVOKE ALL ON public.supply_agent_balances FROM authenticated, anon;
GRANT SELECT ON public.supply_agent_balances TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- every new table has RLS on and exactly one SELECT policy:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND (c.relname LIKE 'prod\_%' OR c.relname LIKE 'supply\_%') AND c.relkind = 'r'
-- GROUP BY 1, 2;
-- -- authenticated/anon may only SELECT (expect only authenticated/SELECT rows):
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND (table_name LIKE 'prod\_%' OR table_name LIKE 'supply\_%');
