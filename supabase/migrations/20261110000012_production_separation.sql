-- Production: Separatsiya — milk separated into cream + skim (obrat).
--
-- Why: cream was being made with "Ishlab chiqarish" (one output), so the skim
-- was lost and the whole milk cost landed on the cream (real case: 1 045 kg
-- milk -> 945 kg "cream", where 945 kg was the skim). Separation is its own
-- document: it computes cream and skim from a fat balance, posts BOTH into
-- stock with their fat %, and splits the milk cost between them.
--
-- Fat balance (all %, s = skim fat, m = milk fat, c = cream fat):
--   net_milk  = milk_qty − loss_qty,  loss_qty = round(milk_qty × loss_pct/100, 3)
--   cream     = round(net_milk × (m − s)/(c − s), 3);  skim = net_milk − cream
-- The client may override the actual cream/skim (separators vary); then
-- loss_qty = milk_qty − cream − skim (must be >= 0).
--
-- Cost allocation of milk_cost = round(milk_qty × avg_cost, 2):
--   skim_price : skim_total = round(skim × skim_price, 2) (<= milk_cost), rest to cream
--   value      : split proportional to cream×cream_ref_price : skim×skim_ref_price
--   fat        : split proportional to cream×cream_fat : skim×skim_fat
-- Unit costs = round(total/qty, 2). Loss has no own value (absorbed).
--
-- Also: doc_type 'separation' in the ledger CHECK, and prod_cancel_document
-- (latest = 20261110000010) learns 'separation' (key prod_production).

BEGIN;

-- ─── 1) ledger doc_type ──────────────────────────────────────────────────
ALTER TABLE public.prod_stock_movements
  DROP CONSTRAINT prod_stock_movements_doc_type_check;
ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_doc_type_check
  CHECK (doc_type IN ('receipt', 'production', 'processing', 'transfer', 'conversion', 'separation'));

-- ─── 2) prod_separations ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prod_separations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  doc_date timestamptz NOT NULL DEFAULT now(),
  warehouse_id uuid NOT NULL,
  output_warehouse_id uuid NOT NULL,
  milk_item_id uuid NOT NULL,
  cream_item_id uuid NOT NULL,
  skim_item_id uuid NOT NULL,
  milk_qty numeric(14,3) NOT NULL CHECK (milk_qty > 0),
  milk_fat numeric(6,3) NOT NULL,
  cream_fat numeric(6,3) NOT NULL,
  skim_fat numeric(6,3) NOT NULL DEFAULT 0.05,
  loss_pct numeric(6,3) NOT NULL DEFAULT 0 CHECK (loss_pct >= 0 AND loss_pct <= 10),
  cream_qty_calc numeric(14,3) NOT NULL CHECK (cream_qty_calc >= 0),
  skim_qty_calc numeric(14,3) NOT NULL CHECK (skim_qty_calc >= 0),
  cream_qty numeric(14,3) NOT NULL CHECK (cream_qty > 0),
  skim_qty numeric(14,3) NOT NULL CHECK (skim_qty > 0),
  loss_qty numeric(14,3) NOT NULL CHECK (loss_qty >= 0),
  allocation_method text NOT NULL DEFAULT 'skim_price' CHECK (allocation_method IN ('skim_price', 'value', 'fat')),
  skim_price numeric(14,2) NULL CHECK (skim_price IS NULL OR skim_price >= 0),
  cream_ref_price numeric(14,2) NULL CHECK (cream_ref_price IS NULL OR cream_ref_price >= 0),
  skim_ref_price numeric(14,2) NULL CHECK (skim_ref_price IS NULL OR skim_ref_price >= 0),
  milk_cost numeric(14,2) NOT NULL CHECK (milk_cost >= 0),
  cream_unit_cost numeric(14,2) NOT NULL CHECK (cream_unit_cost >= 0),
  skim_unit_cost numeric(14,2) NOT NULL CHECK (skim_unit_cost >= 0),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_separations_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_separations_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_separations_wh_fk FOREIGN KEY (warehouse_id, company_id) REFERENCES public.prod_warehouses(id, company_id),
  CONSTRAINT prod_separations_out_wh_fk FOREIGN KEY (output_warehouse_id, company_id) REFERENCES public.prod_warehouses(id, company_id),
  CONSTRAINT prod_separations_milk_fk FOREIGN KEY (milk_item_id, company_id) REFERENCES public.prod_items(id, company_id),
  CONSTRAINT prod_separations_cream_fk FOREIGN KEY (cream_item_id, company_id) REFERENCES public.prod_items(id, company_id),
  CONSTRAINT prod_separations_skim_fk FOREIGN KEY (skim_item_id, company_id) REFERENCES public.prod_items(id, company_id),
  CONSTRAINT prod_separations_items_distinct CHECK (
    milk_item_id <> cream_item_id AND milk_item_id <> skim_item_id AND cream_item_id <> skim_item_id),
  CONSTRAINT prod_separations_fat_order CHECK (skim_fat >= 0 AND skim_fat < milk_fat AND milk_fat < cream_fat AND cream_fat <= 90),
  CONSTRAINT prod_separations_mass CHECK (cream_qty + skim_qty + loss_qty = milk_qty),
  CONSTRAINT prod_separations_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS prod_separations_company_date_idx ON public.prod_separations (company_id, doc_date DESC);

ALTER TABLE public.prod_separations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Company isolation (select)" ON public.prod_separations;
CREATE POLICY "Company isolation (select)" ON public.prod_separations
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()));
REVOKE ALL ON public.prod_separations FROM authenticated, anon;
GRANT SELECT ON public.prod_separations TO authenticated;

-- ─── 3) prod_create_separation ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prod_create_separation(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_wh uuid;
  v_out_wh uuid;
  v_milk uuid;
  v_cream uuid;
  v_skim uuid;
  v_milk_qty numeric;
  v_milk_fat numeric;
  v_cream_fat numeric;
  v_skim_fat numeric;
  v_loss_pct numeric;
  v_loss numeric;
  v_net numeric;
  v_cream_calc numeric;
  v_skim_calc numeric;
  v_cream_qty numeric;
  v_skim_qty numeric;
  v_method text;
  v_skim_price numeric;
  v_cream_ref numeric;
  v_skim_ref numeric;
  v_stock record;
  v_quality record;
  v_milk_cost numeric;
  v_cream_total numeric;
  v_skim_total numeric;
  v_w_cream numeric;
  v_w_skim numeric;
  v_cream_cost numeric;
  v_skim_cost numeric;
  v_note text;
  v_date timestamptz;
  v_number integer;
  v_id uuid;
  v_ok boolean;
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

  -- ids / numbers (same tolerant parsing helpers as the other RPCs)
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_out_wh := COALESCE(public.prod_juuid(p_data, 'output_warehouse_id'), v_wh);
  v_milk := public.prod_juuid(p_data, 'milk_item_id');
  v_cream := public.prod_juuid(p_data, 'cream_item_id');
  v_skim := public.prod_juuid(p_data, 'skim_item_id');
  v_milk_qty := public.prod_jnum(p_data, 'milk_qty', 3);
  v_milk_fat := public.prod_jnum(p_data, 'milk_fat', 3);
  v_cream_fat := public.prod_jnum(p_data, 'cream_fat', 3);
  v_skim_fat := COALESCE(public.prod_jnum(p_data, 'skim_fat', 3), 0.05);
  v_loss_pct := COALESCE(public.prod_jnum(p_data, 'loss_pct', 3), 0);
  v_method := COALESCE(NULLIF(public.prod_jtext(p_data, 'allocation_method', 20), ''), 'skim_price');
  v_skim_price := public.prod_jnum(p_data, 'skim_price', 2);
  v_cream_ref := public.prod_jnum(p_data, 'cream_ref_price', 2);
  v_skim_ref := public.prod_jnum(p_data, 'skim_ref_price', 2);
  v_note := NULLIF(btrim(COALESCE(public.prod_jtext(p_data, 'note', 500), '')), '');
  v_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());

  IF v_milk IS NULL OR v_cream IS NULL OR v_skim IS NULL
     OR v_milk = v_cream OR v_milk = v_skim OR v_cream = v_skim
     OR v_milk_qty IS NULL OR v_milk_qty <= 0
     OR v_cream_fat IS NULL OR v_loss_pct < 0 OR v_loss_pct > 10
     OR v_method NOT IN ('skim_price', 'value', 'fat')
     OR (v_note IS NOT NULL AND char_length(v_note) > 500) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);
  PERFORM public.prod_require_warehouse(v_company_id, v_out_wh);

  -- milk may be inactive (existing stock still usable, like production
  -- components); cream/skim outputs must be active.
  IF NOT EXISTS (SELECT 1 FROM public.prod_items WHERE id = v_milk AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT bool_and(is_active) INTO v_ok FROM public.prod_items
  WHERE company_id = v_company_id AND id IN (v_cream, v_skim);
  IF (SELECT count(*) FROM public.prod_items WHERE company_id = v_company_id AND id IN (v_cream, v_skim)) <> 2 THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Stock lock (global order item_id, warehouse_id; one inflow-free key).
  PERFORM public.prod_lock_stock(v_company_id, v_wh, ARRAY[v_milk]);
  SELECT * INTO v_stock FROM public.prod_current_stock(v_company_id, v_wh, v_milk);
  IF v_stock.qty < v_milk_qty THEN
    RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_milk::text;
  END IF;

  IF v_milk_fat IS NULL THEN
    SELECT * INTO v_quality FROM public.prod_stock_quality_at(v_company_id, v_wh, v_milk);
    v_milk_fat := v_quality.avg_fat;
  END IF;
  IF v_milk_fat IS NULL OR NOT (v_skim_fat >= 0 AND v_skim_fat < v_milk_fat AND v_milk_fat < v_cream_fat AND v_cream_fat <= 90) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_milk_fat := round(v_milk_fat, 3);

  -- Fat balance
  v_loss := round(v_milk_qty * v_loss_pct / 100, 3);
  v_net := v_milk_qty - v_loss;
  v_cream_calc := round(v_net * (v_milk_fat - v_skim_fat) / (v_cream_fat - v_skim_fat), 3);
  v_skim_calc := v_net - v_cream_calc;

  v_cream_qty := COALESCE(public.prod_jnum(p_data, 'cream_qty', 3), v_cream_calc);
  v_skim_qty := COALESCE(public.prod_jnum(p_data, 'skim_qty', 3), v_skim_calc);
  IF v_cream_qty <= 0 OR v_skim_qty <= 0 OR v_cream_qty + v_skim_qty > v_milk_qty THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_loss := v_milk_qty - v_cream_qty - v_skim_qty;

  -- Cost allocation
  v_milk_cost := round(v_milk_qty * v_stock.avg_cost, 2);
  IF v_method = 'skim_price' THEN
    IF v_skim_price IS NULL OR v_skim_price < 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_skim_total := round(v_skim_qty * v_skim_price, 2);
    IF v_skim_total > v_milk_cost THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_cream_total := v_milk_cost - v_skim_total;
  ELSE
    IF v_method = 'value' THEN
      IF v_cream_ref IS NULL OR v_skim_ref IS NULL OR v_cream_ref <= 0 OR v_skim_ref <= 0 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      v_w_cream := v_cream_qty * v_cream_ref;
      v_w_skim := v_skim_qty * v_skim_ref;
    ELSE
      v_w_cream := v_cream_qty * v_cream_fat;
      v_w_skim := v_skim_qty * v_skim_fat;
    END IF;
    IF v_w_cream + v_w_skim <= 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_cream_total := round(v_milk_cost * v_w_cream / (v_w_cream + v_w_skim), 2);
    v_skim_total := v_milk_cost - v_cream_total;
  END IF;
  v_cream_cost := round(v_cream_total / v_cream_qty, 2);
  v_skim_cost := round(v_skim_total / v_skim_qty, 2);

  -- Number (after the stock lock, like the other documents)
  PERFORM pg_advisory_xact_lock(hashtextextended('prod_separation_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_separations WHERE company_id = v_company_id;
  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_separations (
    company_id, number, doc_date, warehouse_id, output_warehouse_id, milk_item_id, cream_item_id, skim_item_id,
    milk_qty, milk_fat, cream_fat, skim_fat, loss_pct, cream_qty_calc, skim_qty_calc, cream_qty, skim_qty, loss_qty,
    allocation_method, skim_price, cream_ref_price, skim_ref_price, milk_cost, cream_unit_cost, skim_unit_cost,
    note, status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_date, v_wh, v_out_wh, v_milk, v_cream, v_skim,
    v_milk_qty, v_milk_fat, v_cream_fat, v_skim_fat, v_loss_pct, v_cream_calc, v_skim_calc, v_cream_qty, v_skim_qty, v_loss,
    v_method,
    CASE WHEN v_method = 'skim_price' THEN v_skim_price END,
    CASE WHEN v_method = 'value' THEN v_cream_ref END,
    CASE WHEN v_method = 'value' THEN v_skim_ref END,
    v_milk_cost, v_cream_cost, v_skim_cost,
    v_note, 'posted', auth.uid(), v_user_name
  ) RETURNING id INTO v_id;

  -- Ledger: milk out (fat via the quality trigger = pool average), outputs in
  -- with their own fat.
  INSERT INTO public.prod_stock_movements (company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by)
  VALUES (v_company_id, v_wh, v_milk, -v_milk_qty, v_stock.avg_cost, 'separation', v_id, false, auth.uid());
  INSERT INTO public.prod_stock_movements (company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by, fat_pct)
  VALUES (v_company_id, v_out_wh, v_cream, v_cream_qty, v_cream_cost, 'separation', v_id, false, auth.uid(), v_cream_fat);
  INSERT INTO public.prod_stock_movements (company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by, fat_pct)
  VALUES (v_company_id, v_out_wh, v_skim, v_skim_qty, v_skim_cost, 'separation', v_id, false, auth.uid(), v_skim_fat);

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'cream_qty', v_cream_qty, 'skim_qty', v_skim_qty, 'loss_qty', v_loss,
    'cream_unit_cost', v_cream_cost, 'skim_unit_cost', v_skim_cost
  );
END;
$$;

-- ─── 4) prod_cancel_document: + 'separation' ─────────────────────────────
-- Copied from 20261110000010; only the separation branches are new.
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
    WHEN 'separation' THEN 'prod_production'
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

  -- milk-intake receipts are cancelled only through their intake.
  IF p_doc_type = 'receipt' AND EXISTS (
    SELECT 1 FROM public.prod_milk_intakes
    WHERE company_id = v_company_id AND receipt_id = p_id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Lock every touched (warehouse, item) key in the global
  -- (item_id, warehouse_id) order (see 20261110000009 header).
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
  ELSIF p_doc_type = 'separation' THEN
    UPDATE public.prod_separations
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSE
    UPDATE public.prod_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_create_separation(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prod_create_separation(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;

COMMIT;
