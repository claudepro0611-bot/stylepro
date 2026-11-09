-- Production company type, file 4 of 5: write RPCs for the production module.
--
-- Every public RPC here:
--   * SECURITY DEFINER, SET search_path = public, pg_temp.
--   * First statement: PERFORM public.assert_business_type('production')
--     (-> 'wrong_business_type'), then has_permission(<prod key>)
--     (-> 'forbidden'). has_permission learns the prod_* keys in file 5;
--     until then it returns false for them (unknown key, fail closed).
--   * company = public.get_company_id(); NULL -> 'forbidden'.
--   * Every referenced id (warehouse, item, group, agent, expense category,
--     document) is checked to belong to that company; the composite FKs of
--     file 3 back this up at the constraint level.
--   * Money/stock values are derived server-side: costs come from the
--     ledger (average cost), totals are recomputed. The only client-supplied
--     money is what the user legitimately enters: receipt purchase price,
--     processing output valuation price, supply cash amount.
--   * EXECUTE: REVOKE from PUBLIC/anon, GRANT to authenticated.
--
-- Error contract: RAISE EXCEPTION '<code>' with the code as the message,
-- the frontend maps it (productionErrors.*):
--   forbidden, wrong_business_type, not_found, insufficient_stock,
--   invalid_input, duplicate_name, already_cancelled, negative_balance.
-- insufficient_stock carries the item id in DETAIL.
--
-- Concurrency: any statement sequence that checks stock and then writes an
-- outflow first takes pg_advisory_xact_lock on
-- hashtextextended('prod_stock:<company>:<warehouse>:<item>', 0), acquired
-- in ascending item-id order (prod_lock_stock) so two documents touching
-- the same items can never deadlock. Each later statement in the function
-- takes a fresh READ COMMITTED snapshot, so it sees everything the previous
-- lock holder committed. Supply cash moves lock per agent.
-- Document numbers: max(number)+1 under a per-company, per-doc-type
-- advisory lock (same pattern as create_stock_transfer), always taken
-- AFTER the stock locks.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ═══ Internal helpers (NOT callable by clients) ══════════════════════════
-- These run inside the SECURITY DEFINER RPCs below (as the function owner).
-- They are deliberately SECURITY INVOKER with EXECUTE revoked from every
-- client role: they take explicit company ids and must never be reachable
-- through PostgREST.

-- Parse a jsonb field as a finite numeric, rounded to p_scale decimals and
-- bounded to the numeric(14, p_scale) column range. NULL/'' -> NULL.
-- Rejects NaN / Infinity / non-numeric text with 'invalid_input' (a bare
-- ::numeric cast would accept 'NaN', and NaN > 0 is true in Postgres).
CREATE OR REPLACE FUNCTION public.prod_jnum(p_obj jsonb, p_key text, p_scale integer)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_txt text;
  v_num numeric;
BEGIN
  IF p_obj IS NULL OR jsonb_typeof(p_obj) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_obj->p_key IS NULL OR jsonb_typeof(p_obj->p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_obj->p_key) NOT IN ('number', 'string') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_txt := btrim(p_obj->>p_key);
  IF v_txt = '' THEN
    RETURN NULL;
  END IF;
  IF v_txt !~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]{1,3})?$' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_num := round(v_txt::numeric, p_scale);
  IF abs(v_num) >= power(10::numeric, 14 - p_scale) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  RETURN v_num;
END;
$$;

-- Parse a jsonb field as a uuid (canonical 8-4-4-4-12 hex). NULL/'' -> NULL.
CREATE OR REPLACE FUNCTION public.prod_juuid(p_obj jsonb, p_key text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_txt text;
BEGIN
  IF p_obj IS NULL OR jsonb_typeof(p_obj) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_obj->p_key IS NULL OR jsonb_typeof(p_obj->p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_obj->p_key) <> 'string' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_txt := btrim(p_obj->>p_key);
  IF v_txt = '' THEN
    RETURN NULL;
  END IF;
  IF v_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  RETURN v_txt::uuid;
END;
$$;

-- Parse a jsonb field as trimmed text; ''/NULL -> NULL; longer than
-- p_max_len -> 'invalid_input'.
CREATE OR REPLACE FUNCTION public.prod_jtext(p_obj jsonb, p_key text, p_max_len integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_txt text;
BEGIN
  IF p_obj IS NULL OR jsonb_typeof(p_obj) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_obj->p_key IS NULL OR jsonb_typeof(p_obj->p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_obj->p_key) NOT IN ('string', 'number') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_txt := NULLIF(btrim(p_obj->>p_key), '');
  IF v_txt IS NOT NULL AND length(v_txt) > p_max_len THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  RETURN v_txt;
END;
$$;

-- Parse a jsonb field as boolean (true/false or 'true'/'false'). NULL -> NULL.
CREATE OR REPLACE FUNCTION public.prod_jbool(p_obj jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_obj IS NULL OR jsonb_typeof(p_obj) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_obj->p_key IS NULL OR jsonb_typeof(p_obj->p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF lower(btrim(p_obj->>p_key)) = 'true' THEN
    RETURN true;
  ELSIF lower(btrim(p_obj->>p_key)) = 'false' THEN
    RETURN false;
  END IF;
  RAISE EXCEPTION 'invalid_input';
END;
$$;

-- Parse a jsonb field as a finite timestamptz. NULL/'' -> NULL.
-- STABLE (not IMMUTABLE): timestamptz input depends on the TimeZone setting.
CREATE OR REPLACE FUNCTION public.prod_jts(p_obj jsonb, p_key text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_txt text;
  v_ts timestamptz;
BEGIN
  v_txt := public.prod_jtext(p_obj, p_key, 64);
  IF v_txt IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_ts := v_txt::timestamptz;
  EXCEPTION
    WHEN invalid_datetime_format OR datetime_field_overflow
      OR invalid_text_representation OR invalid_parameter_value THEN
      RAISE EXCEPTION 'invalid_input';
  END;
  IF NOT isfinite(v_ts) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  RETURN v_ts;
END;
$$;

-- Parse a jsonb field as a finite date ('YYYY-MM-DD'). NULL/'' -> NULL.
CREATE OR REPLACE FUNCTION public.prod_jdate(p_obj jsonb, p_key text)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_txt text;
  v_date date;
BEGIN
  v_txt := public.prod_jtext(p_obj, p_key, 32);
  IF v_txt IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_txt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  BEGIN
    v_date := v_txt::date;
  EXCEPTION
    WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid_input';
  END;
  RETURN v_date;
END;
$$;

-- Lock (company, warehouse, item) stock keys in ascending item-id order.
-- Transaction-scoped: released at COMMIT/ROLLBACK.
CREATE OR REPLACE FUNCTION public.prod_lock_stock(p_company_id uuid, p_warehouse_id uuid, p_item_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item uuid;
BEGIN
  FOR v_item IN
    SELECT DISTINCT x FROM unnest(p_item_ids) AS t(x) WHERE x IS NOT NULL ORDER BY x
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'prod_stock:' || p_company_id::text || ':' || p_warehouse_id::text || ':' || v_item::text, 0
    ));
  END LOOP;
END;
$$;

-- Current stock of one (company, warehouse, item): qty and average cost,
-- computed exactly like the prod_stock view. Callers must hold the
-- prod_lock_stock lock for the key when they act on the result.
-- VOLATILE on purpose: the read must use a snapshot taken after the lock.
CREATE OR REPLACE FUNCTION public.prod_current_stock(
  p_company_id uuid, p_warehouse_id uuid, p_item_id uuid,
  OUT qty numeric, OUT avg_cost numeric
)
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_value numeric;
BEGIN
  SELECT COALESCE(sum(m.qty), 0), COALESCE(sum(m.qty * m.unit_cost), 0)
  INTO qty, v_value
  FROM public.prod_stock_movements m
  WHERE m.company_id = p_company_id
    AND m.warehouse_id = p_warehouse_id
    AND m.item_id = p_item_id;

  avg_cost := CASE WHEN qty > 0 THEN round(v_value / qty, 2) ELSE 0 END;
END;
$$;

-- Active warehouse of the company, or raise.
CREATE OR REPLACE FUNCTION public.prod_require_warehouse(p_company_id uuid, p_warehouse_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
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
  WHERE id = p_warehouse_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_jnum(jsonb, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_juuid(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_jtext(jsonb, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_jbool(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_jts(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_jdate(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_lock_stock(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_current_stock(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_require_warehouse(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ═══ Catalog (prod_catalog) ══════════════════════════════════════════════

-- p_id NULL -> create, else update the company's group (not_found if not).
-- p_is_active NULL -> true on create, unchanged on update.
CREATE OR REPLACE FUNCTION public.prod_save_item_group(p_id uuid, p_name text, p_is_active boolean)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_name text;
  v_id uuid;
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

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_item_groups (company_id, name, is_active)
      VALUES (v_company_id, v_name, COALESCE(p_is_active, true))
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_item_groups
      SET name = v_name,
          is_active = COALESCE(p_is_active, is_active)
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'not_found';
      END IF;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate_name';
  END;

  RETURN v_id;
END;
$$;

-- p_data: { name, group_id, sku, barcode, unit, weight_kg, item_type,
--           min_stock, max_stock, is_active, description }
-- Full replace on update (every field is taken from p_data; a missing
-- optional field becomes NULL, missing is_active -> true on create /
-- unchanged on update). unit cannot change once the item has ledger
-- movements (quantities already posted are in the old unit).
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

  IF v_name IS NULL
     OR v_unit IS NULL OR v_unit NOT IN ('kg', 'l', 'g', 'pcs', 'm')
     OR v_type IS NULL OR v_type NOT IN ('raw', 'semi', 'finished', 'packaging')
     OR (v_weight IS NOT NULL AND v_weight < 0)
     OR (v_min IS NOT NULL AND v_min < 0)
     OR (v_max IS NOT NULL AND v_max < 0)
     OR (v_min IS NOT NULL AND v_max IS NOT NULL AND v_max < v_min) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.prod_item_groups WHERE id = v_group_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_items (
        company_id, group_id, name, sku, barcode, unit, weight_kg, item_type,
        min_stock, max_stock, is_active, description
      ) VALUES (
        v_company_id, v_group_id, v_name, v_sku, v_barcode, v_unit, v_weight, v_type,
        v_min, v_max, COALESCE(v_active, true), v_description
      )
      RETURNING id INTO v_id;
    ELSE
      SELECT unit INTO v_old_unit
      FROM public.prod_items
      WHERE id = p_id AND company_id = v_company_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'not_found';
      END IF;

      IF v_old_unit <> v_unit AND EXISTS (
        SELECT 1 FROM public.prod_stock_movements
        WHERE company_id = v_company_id AND item_id = p_id
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
          updated_at = now()
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

-- p_storage_types: non-empty subset of raw|finished|production|processing|return
-- (deduplicated and sorted before storing).
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
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'not_found';
      END IF;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate_name';
  END;

  RETURN v_id;
END;
$$;

-- ═══ Raw receipt (prod_receipts) ═════════════════════════════════════════
-- p_data: { doc_date, warehouse_id, supplier_name, note,
--           items: [{ item_id, qty, price }] }
-- Each line: +qty at price. Items must be active items of the company,
-- no duplicate item in one receipt. Returns { id, number }.
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
  v_warehouse_id uuid;
  v_supplier text;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_prices numeric[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_price numeric;
  v_line_total numeric;
  v_total numeric := 0;
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
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_supplier := public.prod_jtext(p_data, 'supplier_name', 200);
  v_note := public.prod_jtext(p_data, 'note', 500);

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);

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
    v_price := public.prod_jnum(v_line, 'price', 2);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_price IS NULL OR v_price < 0
       OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_line_total := round(v_qty * v_price, 2);
    v_total := v_total + v_line_total;
    IF v_line_total >= 1e12 OR v_total >= 1e12 THEN
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

  -- Inflow only: no stock check, so no stock lock. Number lock only.
  PERFORM pg_advisory_xact_lock(hashtextextended('prod_receipt_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_receipts WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_receipts (
    company_id, number, doc_date, warehouse_id, supplier_name, note, total,
    status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_warehouse_id, v_supplier, v_note, v_total,
    'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_receipt_items (company_id, receipt_id, item_id, qty, price, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_prices[i], round(v_qtys[i] * v_prices[i], 2));

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
    ) VALUES (
      v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i], v_prices[i], 'receipt', v_id, false, auth.uid()
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ Production (prod_production) ════════════════════════════════════════
-- p_data: { doc_date, warehouse_id, output_item_id, output_qty, note,
--           components: [{ item_id, qty }] }
-- Components are issued from p_data.warehouse_id at their current average
-- cost (-qty); the output (+output_qty) is received into the same
-- warehouse at unit_cost = round(total_cost / output_qty, 2).
-- Output must be an active 'finished' or 'semi' item and not a component;
-- no duplicate components. Returns { id, number, total_cost, unit_cost }.
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
  v_output_item_id uuid;
  v_output_qty numeric;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_costs numeric[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_stock record;
  v_total_cost numeric := 0;
  v_unit_cost numeric;
  v_out_type text;
  v_out_active boolean;
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
  v_output_item_id := public.prod_juuid(p_data, 'output_item_id');
  v_output_qty := public.prod_jnum(p_data, 'output_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_output_item_id IS NULL OR v_output_qty IS NULL OR v_output_qty <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);

  SELECT item_type, is_active INTO v_out_type, v_out_active
  FROM public.prod_items
  WHERE id = v_output_item_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_out_active OR v_out_type NOT IN ('finished', 'semi') THEN
    RAISE EXCEPTION 'invalid_input';
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
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_item_id = v_output_item_id
       OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
  END LOOP;

  -- Components may be inactive items (stock already on hand can still be
  -- consumed), but must belong to the company.
  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Stock locks (sorted), then read stock under the lock.
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
    company_id, number, doc_date, warehouse_id, output_item_id, output_qty,
    total_cost, unit_cost, note, status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_item_id, v_output_qty,
    v_total_cost, v_unit_cost, v_note, 'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_production_components (company_id, production_id, item_id, qty, unit_cost, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], round(v_qtys[i] * v_costs[i], 2));

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
    ) VALUES (
      v_company_id, v_warehouse_id, v_item_ids[i], -v_qtys[i], v_costs[i], 'production', v_id, false, auth.uid()
    );
  END LOOP;

  INSERT INTO public.prod_stock_movements (
    company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
  ) VALUES (
    v_company_id, v_warehouse_id, v_output_item_id, v_output_qty, v_unit_cost, 'production', v_id, false, auth.uid()
  );

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'total_cost', v_total_cost, 'unit_cost', v_unit_cost
  );
END;
$$;

-- ═══ Processing (prod_processing) ════════════════════════════════════════
-- p_data: { doc_date, warehouse_id, source_item_id, source_qty, note,
--           outputs: [{ item_id, qty, price }] }
-- Source issued at its average cost (processing_cost = round(qty * avg, 2));
-- each output received at its price; recovery_cost = sum of output totals;
-- profit = recovery_cost - processing_cost.
-- At least one output; outputs must be active company items, distinct,
-- and not the source item.
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
  v_source_item_id := public.prod_juuid(p_data, 'source_item_id');
  v_source_qty := public.prod_jnum(p_data, 'source_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_source_item_id IS NULL OR v_source_qty IS NULL OR v_source_qty <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);

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
    company_id, number, doc_date, warehouse_id, source_item_id, source_qty,
    source_unit_cost, processing_cost, recovery_cost, profit, note, status,
    created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_warehouse_id, v_source_item_id, v_source_qty,
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

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
    ) VALUES (
      v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i], v_prices[i], 'processing', v_id, false, auth.uid()
    );
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number,
    'processing_cost', v_processing_cost, 'recovery_cost', v_recovery, 'profit', v_profit
  );
END;
$$;

-- ═══ Cancel a posted document ════════════════════════════════════════════
-- p_doc_type: 'receipt' (key prod_receipts) | 'production' (prod_production)
--             | 'processing' (prod_processing).
-- Additionally owner/admin only. The document row is locked FOR UPDATE
-- (a concurrent second cancel waits, then gets 'already_cancelled').
-- Every original movement of the document is mirrored with
-- qty = -qty, same unit_cost, is_reversal = true. If any item's stock
-- would go negative (e.g. received milk already consumed by a production)
-- the whole cancel is refused with 'insufficient_stock'.
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
  ELSE
    SELECT status INTO v_status FROM public.prod_processings
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  END IF;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  -- Lock every touched (warehouse, item) key in ascending item-id order
  -- (all movements of one document share its warehouse, so this is the
  -- same order prod_lock_stock uses).
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
  ELSE
    UPDATE public.prod_processings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ═══ Supply agents (prod_supply) ═════════════════════════════════════════

-- p_id NULL -> create, else update. p_is_active NULL -> true on create,
-- unchanged on update.
CREATE OR REPLACE FUNCTION public.supply_save_agent(
  p_id uuid, p_name text, p_phone text, p_telegram_id text, p_is_active boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_name text;
  v_phone text;
  v_telegram text;
  v_id uuid;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_supply') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := NULLIF(btrim(p_name), '');
  v_phone := NULLIF(btrim(p_phone), '');
  v_telegram := NULLIF(btrim(p_telegram_id), '');
  IF v_name IS NULL OR length(v_name) > 100
     OR (v_phone IS NOT NULL AND length(v_phone) > 30)
     OR (v_telegram IS NOT NULL AND length(v_telegram) > 64) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.supply_agents (company_id, name, phone, telegram_id, is_active)
      VALUES (v_company_id, v_name, v_phone, v_telegram, COALESCE(p_is_active, true))
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.supply_agents
      SET name = v_name,
          phone = v_phone,
          telegram_id = v_telegram,
          is_active = COALESCE(p_is_active, is_active)
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        RAISE EXCEPTION 'not_found';
      END IF;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate_name';
  END;

  RETURN v_id;
END;
$$;

-- p_data: { agent_id, kind ('issue'|'return'|'expense'), amount, purpose,
--           expense_category_id (expense only), move_date (YYYY-MM-DD), note }
-- 'issue' requires an active agent. 'return'/'expense' may not drive the
-- agent's balance below 0 ('negative_balance'); checked under a per-agent
-- advisory lock. Moves are immutable (no edit/delete RPC in the MVP).
CREATE OR REPLACE FUNCTION public.supply_add_move(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_agent_id uuid;
  v_kind text;
  v_amount numeric;
  v_purpose text;
  v_category_id uuid;
  v_move_date date;
  v_note text;
  v_agent_active boolean;
  v_balance numeric;
  v_id uuid;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_supply') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_agent_id := public.prod_juuid(p_data, 'agent_id');
  v_kind := public.prod_jtext(p_data, 'kind', 20);
  v_amount := public.prod_jnum(p_data, 'amount', 2);
  v_purpose := public.prod_jtext(p_data, 'purpose', 200);
  v_category_id := public.prod_juuid(p_data, 'expense_category_id');
  v_move_date := COALESCE(public.prod_jdate(p_data, 'move_date'), current_date);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_agent_id IS NULL
     OR v_kind IS NULL OR v_kind NOT IN ('issue', 'return', 'expense')
     OR v_amount IS NULL OR v_amount <= 0
     OR (v_category_id IS NOT NULL AND v_kind <> 'expense') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT is_active INTO v_agent_active
  FROM public.supply_agents
  WHERE id = v_agent_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_kind = 'issue' AND NOT v_agent_active THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expense_categories WHERE id = v_category_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'supply_agent:' || v_company_id::text || ':' || v_agent_id::text, 0
  ));

  IF v_kind IN ('return', 'expense') THEN
    SELECT COALESCE(sum(CASE WHEN kind = 'issue' THEN amount ELSE -amount END), 0)
    INTO v_balance
    FROM public.supply_cash_moves
    WHERE company_id = v_company_id AND agent_id = v_agent_id;
    IF v_balance - v_amount < 0 THEN
      RAISE EXCEPTION 'negative_balance';
    END IF;
  END IF;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.supply_cash_moves (
    company_id, agent_id, kind, amount, purpose, expense_category_id,
    move_date, note, created_by, created_by_name
  ) VALUES (
    v_company_id, v_agent_id, v_kind, v_amount, v_purpose, v_category_id,
    v_move_date, v_note, auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.prod_save_item_group(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_item(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_warehouse(uuid, text, text[], boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_production(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_processing(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.supply_save_agent(uuid, text, text, text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.supply_add_move(jsonb) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_item_group(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_item(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_warehouse(uuid, text, text[], boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_production(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_processing(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supply_save_agent(uuid, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supply_add_move(jsonb) TO authenticated;

COMMIT;
