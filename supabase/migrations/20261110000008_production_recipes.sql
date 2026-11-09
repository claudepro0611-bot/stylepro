-- Production recipes (retseptura) for the production module.
--
-- Why: a plant makes ~100 products, each with its own recipe. The owner wants
-- to pick a product, see its recipe (ingredient norms per batch), type the
-- real amounts and later compare norm vs. fact and input vs. output. So:
--   1) public.prod_recipes                    - one ACTIVE recipe per output item
--   2) public.prod_recipe_lines               - ingredient lines per batch
--   3) prod_productions.recipe_id/_version    - which recipe (and which
--                                               revision) a run was based on
--   4) prod_production_components.planned_qty - the recipe norm for that run
--   5) RLS + grants                           - identical model to file 3
--   6) RPCs                                   - prod_save_recipe (new),
--                                               prod_create_production (replaced,
--                                               same signature)
--
-- Retail is untouched: no retail table or function is changed, no new
-- permission key (recipes reuse 'prod_catalog', recipe use in a production
-- run reuses 'prod_production').
--
-- Units: every quantity stays in the item's BASE unit ('kg','l','g','pcs','m').
-- kg/g and l/ml conversion is a UI-only entry helper. Recipe quantities and
-- planned quantities are numeric(14,4) because spices per batch in kg need
-- 4 decimals (e.g. 0.0035 kg = 3.5 g). The ledger and actual component
-- quantities stay numeric(14,3) (unchanged).
--
-- Versioning: a recipe row is edited in place; every successful save of an
-- existing recipe replaces ALL its lines and bumps version by 1. Old line
-- sets are NOT archived. History of what was planned for a given run lives on
-- the run itself (prod_productions.recipe_version + per-component
-- planned_qty), which is all the reports need.
--
-- Access model (same as 20261110000003_production_core.sql):
--   * company_id NOT NULL -> companies ON DELETE CASCADE.
--   * RLS on, ONE SELECT policy company-scoped via (SELECT get_company_id()).
--   * REVOKE ALL from authenticated + anon (closes Supabase default-grant
--     leak), GRANT SELECT to authenticated only. Writes ONLY via the
--     SECURITY DEFINER RPCs below.
--
-- Error codes (unchanged contract, productionErrors.*): forbidden,
-- wrong_business_type, not_found, invalid_input, insufficient_stock.
-- A second active recipe for the same item is 'invalid_input' (NOT
-- 'duplicate_name'): the frontend deactivates/edits the old one first.
--
-- Non-destructive: only CREATE TABLE, ADD COLUMN NULL (metadata-only, no
-- default), ADD CONSTRAINT on columns that are NULL for every existing row,
-- CREATE INDEX and CREATE OR REPLACE FUNCTION. No DROP, no data rewrite.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) prod_recipes ──────────────────────────────────────────────────────
-- item_id = the OUTPUT item (finished | semi; enforced in prod_save_recipe,
-- a CHECK cannot look at prod_items). output_qty = batch size in the output
-- item's base unit. UNIQUE (id, company_id) is the target of the composite
-- FKs from recipe lines and productions.

CREATE TABLE public.prod_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  output_qty numeric(14,4) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  note text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_recipes_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_recipes_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_recipes_output_qty_check CHECK (output_qty > 0),
  CONSTRAINT prod_recipes_version_check CHECK (version >= 1),
  CONSTRAINT prod_recipes_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_recipes IS
  'Production recipes (retseptura): batch output_qty of item_id. At most one '
  'active recipe per (company, item). Read via RLS; write ONLY via prod_save_recipe.';

-- One active recipe per output item. Also the race guard: two concurrent
-- "create active recipe for item X" calls both pass the RPC pre-check, the
-- second INSERT hits this index (unique_violation -> 'invalid_input').
CREATE UNIQUE INDEX prod_recipes_company_item_active_key
  ON public.prod_recipes (company_id, item_id)
  WHERE is_active;

-- Composite-FK support + "all recipes (incl. inactive) of item X".
CREATE INDEX prod_recipes_item_idx ON public.prod_recipes (item_id, company_id);

-- ─── 2) prod_recipe_lines ─────────────────────────────────────────────────
-- qty = component amount per ONE batch (recipe.output_qty), component base
-- unit. Lines die with their recipe (ON DELETE CASCADE); there is no delete
-- RPC, so in practice only prod_save_recipe's line replacement and the
-- company cascade remove rows. item FK has no cascade: an item referenced by
-- a recipe cannot be hard-deleted (there is no item delete RPC either).

CREATE TABLE public.prod_recipe_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  recipe_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,4) NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  note text NULL,
  CONSTRAINT prod_recipe_lines_recipe_fk FOREIGN KEY (recipe_id, company_id)
    REFERENCES public.prod_recipes (id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_recipe_lines_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_recipe_lines_recipe_item_key UNIQUE (recipe_id, item_id),
  CONSTRAINT prod_recipe_lines_qty_check CHECK (qty > 0),
  CONSTRAINT prod_recipe_lines_sort_order_check CHECK (sort_order >= 0),
  CONSTRAINT prod_recipe_lines_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_recipe_lines IS
  'Ingredient lines of a production recipe (qty per batch, base unit). '
  'Read via RLS; write ONLY via prod_save_recipe (full replace).';

-- The UNIQUE (recipe_id, item_id) index already serves recipe_id lookups,
-- but the composite FK is (recipe_id, company_id): index it for the cascade.
CREATE INDEX prod_recipe_lines_recipe_idx ON public.prod_recipe_lines (recipe_id, company_id);
CREATE INDEX prod_recipe_lines_item_idx ON public.prod_recipe_lines (item_id, company_id);

-- ─── 3) prod_productions: recipe link ─────────────────────────────────────
-- Nullable (runs without a recipe stay valid; every existing row gets NULL).
-- MATCH SIMPLE composite FK: NULL recipe_id skips the check, a non-NULL one
-- can only point at a recipe of the SAME company. recipe_version is a
-- snapshot of prod_recipes.version at posting time (the recipe may be edited
-- later). Both-or-neither CHECK: existing rows (both NULL) satisfy it.

ALTER TABLE public.prod_productions
  ADD COLUMN recipe_id uuid NULL,
  ADD COLUMN recipe_version integer NULL;

ALTER TABLE public.prod_productions
  ADD CONSTRAINT prod_productions_recipe_fk FOREIGN KEY (recipe_id, company_id)
    REFERENCES public.prod_recipes (id, company_id),
  ADD CONSTRAINT prod_productions_recipe_version_check CHECK (
    (recipe_id IS NULL AND recipe_version IS NULL)
    OR (recipe_id IS NOT NULL AND recipe_version IS NOT NULL AND recipe_version >= 1)
  );

CREATE INDEX prod_productions_recipe_idx
  ON public.prod_productions (recipe_id, company_id)
  WHERE recipe_id IS NOT NULL;

-- ─── 4) prod_production_components: planned (norm) quantity ───────────────
-- The recipe norm for this run in the component's base unit (UI computes it
-- as line.qty * output_qty / recipe.output_qty). NULL = extra component not
-- in the recipe, or a run without a recipe. 0 is allowed (norm rounded to 0
-- or explicitly "not planned"). It is informational only: qty (fact) still
-- drives consumption and cost.

ALTER TABLE public.prod_production_components
  ADD COLUMN planned_qty numeric(14,4) NULL;

ALTER TABLE public.prod_production_components
  ADD CONSTRAINT prod_production_components_planned_qty_check
    CHECK (planned_qty IS NULL OR planned_qty >= 0);

-- ─── 5) RLS, policies, grants ─────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prod_recipes', 'prod_recipe_lines']
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

-- p_id NULL -> create, else update the company's recipe (not_found if not).
-- p_data: { item_id, output_qty, note, is_active,
--           lines: [{ item_id, qty, note }] }   (array order = sort_order)
-- Rules:
--   * output item: in company, item_type finished | semi (inactive allowed,
--     so the recipe of a paused product can still be maintained).
--   * 1..200 lines, qty > 0 (4 decimals), no duplicate component, component
--     <> output item, components in company (inactive allowed, same as
--     production components).
--   * is_active missing/NULL -> true on create, unchanged on update.
--   * Activating (create active, or update to active) while ANOTHER active
--     recipe exists for the item -> 'invalid_input'.
--   * Update: item_id is immutable (a different item -> 'invalid_input';
--     use create, i.e. "nusxa olish", for another item). All lines replaced,
--     version = version + 1, updated_at = now().
-- Concurrency: update locks the recipe row FOR UPDATE (two editors serialize,
-- each bumps the version once). The partial unique index is the final guard
-- against two concurrent activations.
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

  -- Nested IF: SQL does not guarantee OR short-circuit, and
  -- jsonb_array_length raises on a non-array.
  IF jsonb_typeof(p_data->'lines') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'lines') NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- jsonb_array_elements preserves array order; the loop index becomes
  -- sort_order (0-based) below.
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
    -- array_append, not ||: a NULL text note must append a NULL element.
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

  -- Friendly pre-check (the partial unique index enforces it under races).
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
    -- Only prod_recipes_company_item_active_key can realistically fire here
    -- (duplicate lines were rejected above): concurrent activation.
    WHEN unique_violation THEN
      RAISE EXCEPTION 'invalid_input';
  END;

  RETURN v_id;
END;
$$;

-- ═══ Production (prod_production) — replaced, same signature ═════════════
-- Body copied from 20261110000004_production_rpcs.sql; every validation,
-- lock, numbering and costing step is unchanged. Additions only:
--   * optional p_data.recipe_id: must be a recipe of the company whose
--     item_id = output_item_id (active or not: a run may follow an older,
--     since-deactivated recipe), else 'invalid_input'. Stored with the
--     recipe's current version (row taken FOR SHARE so a concurrent
--     prod_save_recipe cannot bump the version between read and insert).
--   * optional components[].planned_qty (>= 0, 4 decimals): stored as-is.
--     Purely informational; qty (fact) decides consumption and cost.
--     Components may include items not in the recipe, and recipe lines may
--     be omitted.
-- p_data: { doc_date, warehouse_id, output_item_id, output_qty, note,
--           recipe_id, components: [{ item_id, qty, planned_qty }] }
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
  v_output_item_id := public.prod_juuid(p_data, 'output_item_id');
  v_output_qty := public.prod_jnum(p_data, 'output_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_recipe_id := public.prod_juuid(p_data, 'recipe_id');

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

  -- NEW: recipe link. Company-scoped lookup; a recipe of another company or
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
    -- NEW: optional norm, NULL when missing.
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
    total_cost, unit_cost, note, status, created_by, created_by_name,
    recipe_id, recipe_version
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_item_id, v_output_qty,
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

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs, but restate them (and close the
-- default PUBLIC EXECUTE on the new function).

REVOKE EXECUTE ON FUNCTION public.prod_save_recipe(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_production(jsonb) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_recipe(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_production(jsonb) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on both new tables:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_recipes', 'prod_recipe_lines')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_recipes', 'prod_recipe_lines');
