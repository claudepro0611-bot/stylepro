-- Production: change an item's unit of measure SAFELY (e.g. Sut l -> kg).
--
-- Why: prod_save_item refuses a unit change once an item has stock movements,
-- because relabelling would silently corrupt stock (1 000 l would become
-- "1 000 kg" while it is really ~1 030 kg). The owner needs to switch units,
-- so this adds an explicit conversion with a factor:
--   * every warehouse with stock gets a 'conversion' document:
--       -qty (old unit, at current avg cost)  and  +qty*factor (new unit),
--     total value preserved (new unit_cost = value / new qty), fat/protein
--     carried over; the old-unit quantities net to zero, so the ledger sum is
--     correct in the new unit from here on;
--   * recipes are rescaled (component line qty * factor; output_qty * factor
--     where the item is the recipe output), each touched recipe gets version+1;
--   * the change is logged in prod_unit_conversions (old/new unit, factor).
-- Past documents keep their stored numbers (they were entered in the old unit);
-- the log tells when the unit changed.
--
-- Only owner/admin with prod_catalog. Negative stock blocks the conversion.

BEGIN;

-- ─── 1) ledger: allow doc_type 'conversion' ──────────────────────────────
ALTER TABLE public.prod_stock_movements
  DROP CONSTRAINT prod_stock_movements_doc_type_check;
ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_doc_type_check
  CHECK (doc_type IN ('receipt', 'production', 'processing', 'transfer', 'conversion'));

-- ─── 2) conversion log ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prod_unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  old_unit text NOT NULL,
  new_unit text NOT NULL,
  factor numeric(14,6) NOT NULL CHECK (factor > 0),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 500),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_unit_conversions_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items(id, company_id) ON DELETE CASCADE,
  CONSTRAINT prod_unit_conversions_units_differ CHECK (old_unit <> new_unit)
);
CREATE INDEX IF NOT EXISTS prod_unit_conversions_item_idx ON public.prod_unit_conversions (item_id, created_at DESC);

ALTER TABLE public.prod_unit_conversions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Company isolation (select)" ON public.prod_unit_conversions;
CREATE POLICY "Company isolation (select)" ON public.prod_unit_conversions
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()));
REVOKE ALL ON public.prod_unit_conversions FROM authenticated, anon;
GRANT SELECT ON public.prod_unit_conversions TO authenticated;

-- ─── 3) RPC ──────────────────────────────────────────────────────────────
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
  v_qty numeric;
  v_cost numeric;
  v_value numeric;
  v_new_qty numeric;
  v_new_cost numeric;
  v_fat numeric;
  v_pro numeric;
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

  -- Lock the item row: serialises concurrent unit changes / item saves.
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

  -- Stock locks in the global order (item_id, warehouse_id): one item, so
  -- ascending warehouse id.
  FOR v_wh IN
    SELECT DISTINCT m.warehouse_id
    FROM public.prod_stock_movements m
    WHERE m.company_id = v_company_id AND m.item_id = p_item_id
    ORDER BY m.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(v_company_id, v_wh.warehouse_id, ARRAY[p_item_id]);
  END LOOP;

  FOR v_wh IN
    SELECT DISTINCT m.warehouse_id
    FROM public.prod_stock_movements m
    WHERE m.company_id = v_company_id AND m.item_id = p_item_id
    ORDER BY m.warehouse_id
  LOOP
    SELECT s.qty, s.avg_cost INTO v_qty, v_cost
    FROM public.prod_current_stock(v_company_id, v_wh.warehouse_id, p_item_id) s;

    IF v_qty < 0 THEN
      RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p_item_id::text;
    END IF;
    CONTINUE WHEN v_qty = 0;

    SELECT q.avg_fat, q.avg_protein INTO v_fat, v_pro
    FROM public.prod_stock_quality_at(v_company_id, v_wh.warehouse_id, p_item_id) q;

    v_value := round(v_qty * v_cost, 2);
    v_new_qty := round(v_qty * p_factor, 3);
    IF v_new_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_new_cost := round(v_value / v_new_qty, 2);

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by, fat_pct, protein_pct
    ) VALUES
      (v_company_id, v_wh.warehouse_id, p_item_id, -v_qty, v_cost, 'conversion', v_conv_id, false, auth.uid(), v_fat, v_pro);
    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by, fat_pct, protein_pct
    ) VALUES
      (v_company_id, v_wh.warehouse_id, p_item_id, v_new_qty, v_new_cost, 'conversion', v_conv_id, false, auth.uid(), v_fat, v_pro);
  END LOOP;

  -- Rescale recipes: as a component, and as the recipe output.
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

  -- Finally relabel the item (min/max stock rescaled too).
  UPDATE public.prod_items
  SET unit = p_new_unit,
      min_stock = CASE WHEN min_stock IS NULL THEN NULL ELSE round(min_stock * p_factor, 3) END,
      max_stock = CASE WHEN max_stock IS NULL THEN NULL ELSE round(max_stock * p_factor, 3) END,
      updated_at = now()
  WHERE id = p_item_id AND company_id = v_company_id;

  RETURN v_conv_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_change_item_unit(uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prod_change_item_unit(uuid, text, numeric, text) TO authenticated;

COMMIT;
