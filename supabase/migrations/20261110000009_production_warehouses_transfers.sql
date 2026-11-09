-- Production: separate raw / finished warehouses + warehouse transfers.
--
-- Why: a plant keeps raw material ("Xom ashyo ombori") apart from finished
-- goods ("Asosiy ombor"). Until now a production / processing run took its
-- inputs AND put its outputs into ONE warehouse, and there was no transfer
-- document, so stock sitting in a second warehouse could not be used.
-- This file adds:
--   1) prod_productions.output_warehouse_id   - where the output goes
--   2) prod_processings.output_warehouse_id   - where the outputs go
--   3) public.prod_transfers / prod_transfer_items - transfer documents
--   4) prod_stock_movements doc_type 'transfer'
--   5) RLS + grants                           - identical model to file 3
--   6) RPCs: prod_create_production (replaced, same signature),
--            prod_create_processing (replaced, same signature),
--            prod_create_transfer   (new),
--            prod_cancel_document   (replaced, same signature, + 'transfer')
--
-- Retail is untouched. has_permission is unchanged: transfers reuse the
-- existing fail-closed key 'prod_stock'.
--
-- Access model (same as 20261110000003_production_core.sql):
--   * company_id NOT NULL -> companies ON DELETE CASCADE.
--   * RLS on, ONE SELECT policy company-scoped via (SELECT get_company_id()).
--   * REVOKE ALL from authenticated + anon (closes Supabase default-grant
--     leak), GRANT SELECT to authenticated only. Writes ONLY via the
--     SECURITY DEFINER RPCs below.
--
-- Error codes (unchanged contract, productionErrors.*): forbidden,
-- wrong_business_type, not_found, invalid_input, insufficient_stock (item id
-- in DETAIL), already_cancelled.
--
-- ── Lock order (deadlock safety) ──────────────────────────────────────────
-- Stock keys are pg_advisory_xact_lock(hashtextextended(
--   'prod_stock:<company>:<warehouse>:<item>', 0)) (prod_lock_stock).
-- GLOBAL ORDER for every function that takes more than one key:
--   ascending (item_id, warehouse_id).
--   * prod_lock_stock(company, one warehouse, items[]) sorts by item_id; with a
--     single warehouse that IS the global order, so the receipt-free callers
--     (production components, processing source) are already compliant.
--   * prod_cancel_document already iterated ORDER BY item_id, warehouse_id
--     (unchanged) - it now really matters because a production / processing /
--     transfer can touch two warehouses.
--   * prod_create_transfer locks (item, from) and (item, to) for every line,
--     ORDER BY item_id, warehouse_id - same global order.
--   Every set of keys is acquired in one total order, so no cycle (deadlock)
--   is possible between any two of these functions. Inflow-only keys
--   (production output, processing outputs) are still NOT locked, exactly as
--   before (an inflow can only increase stock; receipts never locked either).
--   Document-number locks ('prod_*_no:<company>') are always taken AFTER all
--   stock locks; prod_cancel_document takes the document row FOR UPDATE
--   first, then stock keys, and never a number lock.
--
-- Destructive statement warning: section 4 DROPs and re-ADDs the CHECK
-- constraint prod_stock_movements_doc_type_check (same name, strictly wider
-- allowed set). No data is changed or lost; the re-ADD re-validates existing
-- rows (all already satisfy it) under a short ACCESS EXCLUSIVE lock.
-- Everything else: CREATE TABLE, ADD COLUMN NULL (metadata-only, no default),
-- ADD CONSTRAINT on columns NULL for every existing row, CREATE INDEX,
-- CREATE OR REPLACE FUNCTION.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) prod_productions.output_warehouse_id ──────────────────────────────
-- NULL = same as warehouse_id (rows posted before this migration). New rows
-- always store the resolved value. MATCH SIMPLE composite FK: a non-NULL id
-- can only point at a warehouse of the SAME company.

ALTER TABLE public.prod_productions
  ADD COLUMN output_warehouse_id uuid NULL;

ALTER TABLE public.prod_productions
  ADD CONSTRAINT prod_productions_output_warehouse_fk FOREIGN KEY (output_warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id);

-- ─── 2) prod_processings.output_warehouse_id ──────────────────────────────

ALTER TABLE public.prod_processings
  ADD COLUMN output_warehouse_id uuid NULL;

ALTER TABLE public.prod_processings
  ADD CONSTRAINT prod_processings_output_warehouse_fk FOREIGN KEY (output_warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id);

-- ─── 3) Transfers (ko'chirish) ────────────────────────────────────────────
-- number: per-company sequence (max + 1 under an advisory lock in the RPC).
-- total = sum(item.total) = value moved, at the source average cost.

CREATE TABLE public.prod_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  from_warehouse_id uuid NOT NULL,
  to_warehouse_id uuid NOT NULL,
  note text NULL,
  total numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_transfers_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_transfers_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_transfers_from_warehouse_fk FOREIGN KEY (from_warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_transfers_to_warehouse_fk FOREIGN KEY (to_warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_transfers_warehouses_check CHECK (from_warehouse_id <> to_warehouse_id),
  CONSTRAINT prod_transfers_number_check CHECK (number > 0),
  CONSTRAINT prod_transfers_total_check CHECK (total >= 0),
  CONSTRAINT prod_transfers_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_transfers_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_transfers_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_transfers IS
  'Production warehouse transfers (ko''chirish). Read via RLS (company-scoped SELECT); '
  'write ONLY via prod_create_transfer / prod_cancel_document.';

CREATE INDEX prod_transfers_company_date_idx ON public.prod_transfers (company_id, doc_date DESC);
CREATE INDEX prod_transfers_from_warehouse_idx ON public.prod_transfers (from_warehouse_id, company_id);
CREATE INDEX prod_transfers_to_warehouse_idx ON public.prod_transfers (to_warehouse_id, company_id);

CREATE TABLE public.prod_transfer_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,3) NOT NULL,
  unit_cost numeric(14,2) NOT NULL,
  total numeric(14,2) NOT NULL,
  CONSTRAINT prod_transfer_items_transfer_fk FOREIGN KEY (transfer_id, company_id)
    REFERENCES public.prod_transfers (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_transfer_items_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_transfer_items_transfer_item_key UNIQUE (transfer_id, item_id),
  CONSTRAINT prod_transfer_items_qty_check CHECK (qty > 0),
  CONSTRAINT prod_transfer_items_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT prod_transfer_items_total_check CHECK (total >= 0)
);

COMMENT ON TABLE public.prod_transfer_items IS
  'Lines of a production warehouse transfer (qty at the source average cost). '
  'Read via RLS; write ONLY via prod_create_transfer.';

-- UNIQUE (transfer_id, item_id) serves transfer_id lookups, but the
-- composite FK is (transfer_id, company_id): index it for the cascade.
CREATE INDEX prod_transfer_items_transfer_idx ON public.prod_transfer_items (transfer_id, company_id);
CREATE INDEX prod_transfer_items_item_idx ON public.prod_transfer_items (item_id, company_id);

-- ─── 4) Ledger doc_type: allow 'transfer' ─────────────────────────────────
-- WARNING: DROP CONSTRAINT (see header). Same name, wider set, no data change.

ALTER TABLE public.prod_stock_movements
  DROP CONSTRAINT prod_stock_movements_doc_type_check;

ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_doc_type_check
    CHECK (doc_type IN ('receipt', 'production', 'processing', 'transfer'));

-- ─── 5) RLS, policies, grants ─────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prod_transfers', 'prod_transfer_items']
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

-- ─── 6) RPCs ──────────────────────────────────────────────────────────────

-- ═══ Production (prod_production) — replaced, same signature ═════════════
-- Body copied from 20261110000008_production_recipes.sql (recipe_id /
-- planned_qty kept); every validation, lock, numbering and costing step is
-- unchanged. Addition only:
--   * optional p_data.output_warehouse_id (default = warehouse_id): must be
--     an ACTIVE warehouse of the company, else 'invalid_input'. Components
--     are still issued from warehouse_id; the output movement goes into
--     output_warehouse_id, which is stored on the document.
--   Locks: components in warehouse_id only (single warehouse, item order =
--   global (item_id, warehouse_id) order). The output is an inflow and is
--   not locked (unchanged).
-- p_data: { doc_date, warehouse_id, output_warehouse_id, output_item_id,
--           output_qty, note, recipe_id,
--           components: [{ item_id, qty, planned_qty }] }
-- Returns { id, number, total_cost, unit_cost }.
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
  v_warehouse_id uuid;
  v_output_warehouse_id uuid;
  v_output_item_id uuid;
  v_output_qty numeric;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_costs numeric[] := '{}';
  v_planned numeric[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_planned_qty numeric;
  v_stock record;
  v_total_cost numeric := 0;
  v_unit_cost numeric;
  v_out_type text;
  v_out_active boolean;
  v_recipe_id uuid;
  v_recipe_item_id uuid;
  v_recipe_version integer;
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
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_output_warehouse_id := public.prod_juuid(p_data, 'output_warehouse_id');
  v_output_item_id := public.prod_juuid(p_data, 'output_item_id');
  v_output_qty := public.prod_jnum(p_data, 'output_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_recipe_id := public.prod_juuid(p_data, 'recipe_id');

  IF v_output_item_id IS NULL OR v_output_qty IS NULL OR v_output_qty <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);

  -- NEW: output warehouse (default = source). Company-scoped; another
  -- company's / inactive / missing warehouse -> 'invalid_input'.
  v_output_warehouse_id := COALESCE(v_output_warehouse_id, v_warehouse_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.prod_warehouses
    WHERE id = v_output_warehouse_id AND company_id = v_company_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT item_type, is_active INTO v_out_type, v_out_active
  FROM public.prod_items
  WHERE id = v_output_item_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_out_active OR v_out_type NOT IN ('finished', 'semi') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Recipe link. Company-scoped lookup; a recipe of another company or
  -- of another item is indistinguishable from a missing one (invalid_input).
  IF v_recipe_id IS NOT NULL THEN
    SELECT item_id, version INTO v_recipe_item_id, v_recipe_version
    FROM public.prod_recipes
    WHERE id = v_recipe_id AND company_id = v_company_id
    FOR SHARE;
    IF NOT FOUND OR v_recipe_item_id <> v_output_item_id THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;

  -- Nested IF: SQL does not guarantee OR short-circuit, and
  -- jsonb_array_length raises on a non-array.
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
    -- Optional norm, NULL when missing.
    v_planned_qty := public.prod_jnum(v_line, 'planned_qty', 4);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_item_id = v_output_item_id
       OR v_item_id = ANY (v_item_ids)
       OR (v_planned_qty IS NOT NULL AND v_planned_qty < 0) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    -- array_append, not ||: a NULL planned_qty must append a NULL element
    -- so the arrays stay index-aligned.
    v_planned := array_append(v_planned, v_planned_qty);
  END LOOP;

  -- Components may be inactive items (stock already on hand can still be
  -- consumed), but must belong to the company.
  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Stock locks (sorted; source warehouse only), then read stock under the lock.
  PERFORM public.prod_lock_stock(v_company_id, v_warehouse_id, v_item_ids);

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    SELECT * INTO v_stock
    FROM public.prod_current_stock(v_company_id, v_warehouse_id, v_item_ids[i]);
    IF v_stock.qty < v_qtys[i] THEN
      RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_item_ids[i]::text;
    END IF;
    v_costs := v_costs || v_stock.avg_cost;
    v_total_cost := v_total_cost + round(v_qtys[i] * v_stock.avg_cost, 2);
  END LOOP;

  IF v_total_cost >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_unit_cost := round(v_total_cost / v_output_qty, 2);
  IF v_unit_cost >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_production_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_productions WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_productions (
    company_id, number, doc_date, warehouse_id, output_warehouse_id, output_item_id, output_qty,
    total_cost, unit_cost, note, status, created_by, created_by_name,
    recipe_id, recipe_version
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_warehouse_id, v_output_item_id, v_output_qty,
    v_total_cost, v_unit_cost, v_note, 'posted', auth.uid(), v_user_name,
    v_recipe_id, v_recipe_version
  )
  RETURNING id INTO v_id;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_production_components (
      company_id, production_id, item_id, qty, unit_cost, total, planned_qty
    ) VALUES (
      v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i],
      round(v_qtys[i] * v_costs[i], 2), v_planned[i]
    );

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
    ) VALUES (
      v_company_id, v_warehouse_id, v_item_ids[i], -v_qtys[i], v_costs[i], 'production', v_id, false, auth.uid()
    );
  END LOOP;

  -- NEW: output goes into the output warehouse.
  INSERT INTO public.prod_stock_movements (
    company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
  ) VALUES (
    v_company_id, v_output_warehouse_id, v_output_item_id, v_output_qty, v_unit_cost, 'production', v_id, false, auth.uid()
  );

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'total_cost', v_total_cost, 'unit_cost', v_unit_cost
  );
END;
$$;

-- ═══ Processing (prod_processing) — replaced, same signature ═════════════
-- Body copied from 20261110000004_production_rpcs.sql; every validation,
-- lock, numbering and costing step is unchanged. Addition only:
--   * optional p_data.output_warehouse_id (default = warehouse_id): must be
--     an ACTIVE warehouse of the company, else 'invalid_input'. The source is
--     issued from warehouse_id; every output movement goes into
--     output_warehouse_id, which is stored on the document.
--   Locks: source key in warehouse_id only (unchanged); outputs are inflows.
-- p_data: { doc_date, warehouse_id, output_warehouse_id, source_item_id,
--           source_qty, note, outputs: [{ item_id, qty, price }] }
-- Returns { id, number, processing_cost, recovery_cost, profit }.
CREATE OR REPLACE FUNCTION public.prod_create_processing(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_warehouse_id uuid;
  v_output_warehouse_id uuid;
  v_source_item_id uuid;
  v_source_qty numeric;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_prices numeric[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_price numeric;
  v_line_total numeric;
  v_stock record;
  v_processing_cost numeric;
  v_recovery numeric := 0;
  v_profit numeric;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_processing') THEN
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
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_output_warehouse_id := public.prod_juuid(p_data, 'output_warehouse_id');
  v_source_item_id := public.prod_juuid(p_data, 'source_item_id');
  v_source_qty := public.prod_jnum(p_data, 'source_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_source_item_id IS NULL OR v_source_qty IS NULL OR v_source_qty <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);

  -- NEW: output warehouse (default = source). Company-scoped; another
  -- company's / inactive / missing warehouse -> 'invalid_input'.
  v_output_warehouse_id := COALESCE(v_output_warehouse_id, v_warehouse_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.prod_warehouses
    WHERE id = v_output_warehouse_id AND company_id = v_company_id AND is_active
  ) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.prod_items
                 WHERE id = v_source_item_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Nested IF: SQL does not guarantee OR short-circuit, and
  -- jsonb_array_length raises on a non-array.
  IF jsonb_typeof(p_data->'outputs') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'outputs') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'outputs')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    v_price := public.prod_jnum(v_line, 'price', 2);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_price IS NULL OR v_price < 0
       OR v_item_id = v_source_item_id
       OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_line_total := round(v_qty * v_price, 2);
    v_recovery := v_recovery + v_line_total;
    IF v_line_total >= 1e12 OR v_recovery >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_prices := v_prices || v_price;
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.prod_items
             WHERE company_id = v_company_id AND id = ANY (v_item_ids) AND NOT is_active) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Only the source is an outflow: lock it, then read stock under the lock.
  PERFORM public.prod_lock_stock(v_company_id, v_warehouse_id, ARRAY[v_source_item_id]);

  SELECT * INTO v_stock
  FROM public.prod_current_stock(v_company_id, v_warehouse_id, v_source_item_id);
  IF v_stock.qty < v_source_qty THEN
    RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_source_item_id::text;
  END IF;

  v_processing_cost := round(v_source_qty * v_stock.avg_cost, 2);
  IF v_processing_cost >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_profit := v_recovery - v_processing_cost;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_processing_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_processings WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_processings (
    company_id, number, doc_date, warehouse_id, output_warehouse_id, source_item_id, source_qty,
    source_unit_cost, processing_cost, recovery_cost, profit, note, status,
    created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_warehouse_id, v_source_item_id, v_source_qty,
    v_stock.avg_cost, v_processing_cost, v_recovery, v_profit, v_note, 'posted',
    auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  INSERT INTO public.prod_stock_movements (
    company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
  ) VALUES (
    v_company_id, v_warehouse_id, v_source_item_id, -v_source_qty, v_stock.avg_cost, 'processing', v_id, false, auth.uid()
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_processing_outputs (company_id, processing_id, item_id, qty, price, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_prices[i], round(v_qtys[i] * v_prices[i], 2));

    -- NEW: outputs go into the output warehouse.
    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
    ) VALUES (
      v_company_id, v_output_warehouse_id, v_item_ids[i], v_qtys[i], v_prices[i], 'processing', v_id, false, auth.uid()
    );
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number,
    'processing_cost', v_processing_cost, 'recovery_cost', v_recovery, 'profit', v_profit
  );
END;
$$;

-- ═══ Transfer (prod_stock) — new ═════════════════════════════════════════
-- p_data: { doc_date, from_warehouse_id, to_warehouse_id, note,
--           items: [{ item_id, qty }] }
-- Rules:
--   * both warehouses: of the company (else 'not_found') and active (else
--     'invalid_input'), from <> to ('invalid_input').
--   * 1..500 lines, qty > 0 (3 decimals), no duplicate item, items of the
--     company (else 'not_found'). Inactive items are allowed: stock already
--     on hand may still be moved (same rule as production components).
--   * Cost is server-derived: unit_cost = current average cost of the item
--     in the SOURCE warehouse (read under the lock); line total =
--     round(qty * unit_cost, 2); document total = sum of line totals.
--     No client-supplied money.
--   * Ledger: -qty at unit_cost in from, +qty at the same unit_cost in to.
--   * Locks: (item, from) AND (item, to) for every line, in global
--     (item_id, warehouse_id) order (see header), then the number lock.
--     The 'to' keys are not needed for correctness of this function (inflow)
--     but make transfer posting mutually exclusive with a concurrent cancel /
--     issue of the same item in the destination; they cost nothing in
--     deadlock terms because the order is global.
-- Returns { id, number, total }.
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
  v_item_id uuid;
  v_qty numeric;
  v_rec record;
  v_stock record;
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

  -- Nested IF: SQL does not guarantee OR short-circuit, and
  -- jsonb_array_length raises on a non-array.
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
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Stock locks: every (item, warehouse) key of both warehouses in the
  -- global (item_id, warehouse_id) order. One key per prod_lock_stock call
  -- so the ORDER BY here fully determines acquisition order.
  FOR v_rec IN
    SELECT it.item_id, wh.warehouse_id
    FROM unnest(v_item_ids) AS it(item_id)
    CROSS JOIN unnest(ARRAY[v_from_id, v_to_id]) AS wh(warehouse_id)
    ORDER BY it.item_id, wh.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(v_company_id, v_rec.warehouse_id, ARRAY[v_rec.item_id]);
  END LOOP;

  -- Read source stock under the locks; cost = source average cost.
  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    SELECT * INTO v_stock
    FROM public.prod_current_stock(v_company_id, v_from_id, v_item_ids[i]);
    IF v_stock.qty < v_qtys[i] THEN
      RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_item_ids[i]::text;
    END IF;
    v_costs := v_costs || v_stock.avg_cost;
    v_line_total := round(v_qtys[i] * v_stock.avg_cost, 2);
    v_total := v_total + v_line_total;
    IF v_line_total >= 1e12 OR v_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_transfer_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_transfers WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_transfers (
    company_id, number, doc_date, from_warehouse_id, to_warehouse_id, note, total,
    status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_from_id, v_to_id, v_note, v_total,
    'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_transfer_items (company_id, transfer_id, item_id, qty, unit_cost, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], round(v_qtys[i] * v_costs[i], 2));

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
    ) VALUES
      (v_company_id, v_from_id, v_item_ids[i], -v_qtys[i], v_costs[i], 'transfer', v_id, false, auth.uid()),
      (v_company_id, v_to_id, v_item_ids[i], v_qtys[i], v_costs[i], 'transfer', v_id, false, auth.uid());
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total);
END;
$$;

-- ═══ Cancel a posted document — replaced, same signature ═════════════════
-- Body copied from 20261110000004_production_rpcs.sql; unchanged except:
--   * p_doc_type 'transfer' -> key 'prod_stock', table prod_transfers.
-- p_doc_type: 'receipt' (key prod_receipts) | 'production' (prod_production)
--             | 'processing' (prod_processing) | 'transfer' (prod_stock).
-- Additionally owner/admin only. The document row is locked FOR UPDATE
-- (a concurrent second cancel waits, then gets 'already_cancelled').
-- Every original movement of the document is mirrored with
-- qty = -qty, same unit_cost, is_reversal = true. If any (warehouse, item)
-- stock would go negative (e.g. received milk already consumed, transferred
-- goods already used in the destination) the whole cancel is refused with
-- 'insufficient_stock'. The reversal works per movement warehouse, so
-- two-warehouse documents (production / processing with an output
-- warehouse, transfers) are reversed correctly.
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
  v_rec record;
  v_stock record;
BEGIN
  PERFORM public.assert_business_type('production');

  v_key := CASE p_doc_type
    WHEN 'receipt' THEN 'prod_receipts'
    WHEN 'production' THEN 'prod_production'
    WHEN 'processing' THEN 'prod_processing'
    WHEN 'transfer' THEN 'prod_stock'
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

  -- Lock every touched (warehouse, item) key in the global
  -- (item_id, warehouse_id) order (see header). A document may now span two
  -- warehouses; this order is the same one prod_create_transfer uses, and
  -- for a single warehouse it equals prod_lock_stock's item order.
  FOR v_rec IN
    SELECT DISTINCT m.warehouse_id, m.item_id
    FROM public.prod_stock_movements m
    WHERE m.company_id = v_company_id AND m.doc_type = p_doc_type
      AND m.doc_id = p_id AND NOT m.is_reversal
    ORDER BY m.item_id, m.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(v_company_id, v_rec.warehouse_id, ARRAY[v_rec.item_id]);
  END LOOP;

  -- Refuse if the reversal would drive any item negative.
  FOR v_rec IN
    SELECT m.warehouse_id, m.item_id, -sum(m.qty) AS delta
    FROM public.prod_stock_movements m
    WHERE m.company_id = v_company_id AND m.doc_type = p_doc_type
      AND m.doc_id = p_id AND NOT m.is_reversal
    GROUP BY m.warehouse_id, m.item_id
  LOOP
    IF v_rec.delta < 0 THEN
      SELECT * INTO v_stock
      FROM public.prod_current_stock(v_company_id, v_rec.warehouse_id, v_rec.item_id);
      IF v_stock.qty + v_rec.delta < 0 THEN
        RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_rec.item_id::text;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.prod_stock_movements (
    company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
  )
  SELECT m.company_id, m.warehouse_id, m.item_id, -m.qty, m.unit_cost, m.doc_type, m.doc_id, true, auth.uid()
  FROM public.prod_stock_movements m
  WHERE m.company_id = v_company_id AND m.doc_type = p_doc_type
    AND m.doc_id = p_id AND NOT m.is_reversal;

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
  ELSE
    UPDATE public.prod_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs, but restate them (and close the
-- default PUBLIC EXECUTE on the new function).

REVOKE EXECUTE ON FUNCTION public.prod_create_production(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_processing(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_create_production(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_processing(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on both new tables:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_transfers', 'prod_transfer_items')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_transfers', 'prod_transfer_items');
-- -- doc_type constraint now allows 'transfer':
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conname = 'prod_stock_movements_doc_type_check';
