-- ═══════════════════════════════════════════════════════════════════════
-- Stock counts ("Inventarizatsiya"): per-warehouse physical stock count.
--
-- Flow: create_stock_count (draft) -> set/increment_stock_count_item while
-- counting -> complete_stock_count (applies counted quantities to
-- product_sizes.stock atomically) OR cancel_stock_count. Drafts and
-- cancelled counts may be deleted; completed counts are permanent history.
--
-- Access model (same as exchange_rates / loyalty_config / warehouses):
--   - RLS enabled; SELECT only, scoped by company_id = get_company_id().
--   - ALL default Supabase grants revoked from authenticated (incl. TRUNCATE,
--     which bypasses RLS) and anon; authenticated gets SELECT back only.
--   - Every write goes through the SECURITY DEFINER RPCs below, pinned to
--     `SET search_path = public, pg_temp`, gated by has_permission('inventory')
--     (present in the whitelist, latest definition 20260723000007), with a
--     NULL company_id guard and company_id scoping on every statement.
--   - Every client-supplied id (warehouse_id, count_id, product_size_id) is
--     re-validated against the caller's company inside the RPC.
--
-- product_sizes.stock is only modified by complete_stock_count, under
-- row locks taken in deterministic (id) order. CHECK (stock >= 0) on
-- product_sizes is untouched; counted_qty >= 0 guarantees it holds.
--
-- Additive only: no DROP, no ALTER of existing objects, no data changes.
-- No existing client code references these objects, so applying this
-- migration before the frontend ships is safe.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 0) set_updated_at() — create only if the live DB doesn't have it yet
--    (same pattern as 20261105000003_exchange_rates.sql).
-- ─────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_updated_at' AND p.pronargs = 0
  ) THEN
    CREATE FUNCTION public.set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
    AS $fn$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $fn$;
  END IF;
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) stock_counts (header)
-- ─────────────────────────────────────────────────────────────────────────
-- warehouse_id ON DELETE CASCADE: delete_warehouse() already refuses while
-- any product_sizes row references the warehouse, so by the time a
-- warehouse can be deleted every stock_count_items row of its counts is
-- already gone (product_size_id cascades). Cascading the now-empty headers
-- avoids a raw FK error from delete_warehouse().
CREATE TABLE public.stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'completed', 'cancelled')),
  note text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz NULL,
  zero_uncounted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_counts_company_number_key UNIQUE (company_id, number)
);

COMMENT ON TABLE public.stock_counts IS
  'Per-warehouse stock count (inventarizatsiya). Read via RLS (company-scoped '
  'SELECT); write ONLY via create/complete/cancel/delete_stock_count RPCs.';
COMMENT ON COLUMN public.stock_counts.number IS
  'Sequential per company (1,2,3...), assigned server-side under an advisory lock.';
COMMENT ON COLUMN public.stock_counts.zero_uncounted IS
  'Mode chosen at completion: true = variants of the warehouse that were not '
  'counted were set to stock 0.';

-- At most one open (draft) count per warehouse.
CREATE UNIQUE INDEX stock_counts_one_draft_per_warehouse_idx
  ON public.stock_counts (warehouse_id)
  WHERE status = 'draft';

-- List page: WHERE company_id = ? ORDER BY created_at DESC
CREATE INDEX stock_counts_company_created_idx
  ON public.stock_counts (company_id, created_at DESC);

CREATE TRIGGER stock_counts_set_updated_at
  BEFORE UPDATE ON public.stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 2) stock_count_items (lines)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.stock_count_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  count_id uuid NOT NULL REFERENCES public.stock_counts(id) ON DELETE CASCADE,
  product_size_id uuid NOT NULL REFERENCES public.product_sizes(id) ON DELETE CASCADE,
  counted_qty integer NOT NULL CHECK (counted_qty >= 0),
  expected_qty integer NULL,
  purchase_price numeric NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_count_items_count_product_size_key
    UNIQUE (count_id, product_size_id)
);

COMMENT ON TABLE public.stock_count_items IS
  'Counted quantity per variant within a stock count. Write ONLY via '
  'set_stock_count_item / increment_stock_count_item / complete_stock_count.';
COMMENT ON COLUMN public.stock_count_items.expected_qty IS
  'Snapshot of product_sizes.stock at completion time; NULL while draft.';
COMMENT ON COLUMN public.stock_count_items.purchase_price IS
  'Snapshot of product_sizes.purchase_price at completion time; NULL while draft.';

CREATE INDEX stock_count_items_count_id_idx
  ON public.stock_count_items (count_id);

-- Supports the ON DELETE CASCADE from product_sizes without a seq scan.
CREATE INDEX stock_count_items_product_size_id_idx
  ON public.stock_count_items (product_size_id);

CREATE TRIGGER stock_count_items_set_updated_at
  BEFORE UPDATE ON public.stock_count_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 3) RLS + grants (access model: RLS for reads, RPC-only for writes)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_count_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation (select)" ON public.stock_counts
  FOR SELECT
  TO authenticated
  USING (company_id = public.get_company_id());

CREATE POLICY "Company isolation (select)" ON public.stock_count_items
  FOR SELECT
  TO authenticated
  USING (company_id = public.get_company_id());

-- Close the Supabase default-grant leak immediately. REVOKE ALL (not just
-- INSERT/UPDATE/DELETE) also removes TRUNCATE, which is not subject to RLS.
REVOKE ALL ON public.stock_counts FROM authenticated, anon;
REVOKE ALL ON public.stock_count_items FROM authenticated, anon;
GRANT SELECT ON public.stock_counts TO authenticated;
GRANT SELECT ON public.stock_count_items TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) create_stock_count
-- ─────────────────────────────────────────────────────────────────────────
-- The per-company advisory lock serializes number assignment (max+1) and
-- the "open count exists" check, so both are race-free. The partial unique
-- index remains the hard guarantee; its violation is mapped to the same
-- error message.
CREATE OR REPLACE FUNCTION public.create_stock_count(
  p_warehouse_id uuid,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_number integer;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_warehouse_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.warehouses
    WHERE id = p_warehouse_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_company_id::text));

  IF EXISTS (
    SELECT 1 FROM public.stock_counts
    WHERE company_id = v_company_id
      AND warehouse_id = p_warehouse_id
      AND status = 'draft'
  ) THEN
    RAISE EXCEPTION 'Open count exists';
  END IF;

  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.stock_counts
  WHERE company_id = v_company_id;

  BEGIN
    INSERT INTO public.stock_counts (company_id, number, warehouse_id, note, created_by)
    VALUES (v_company_id, v_number, p_warehouse_id, NULLIF(trim(p_note), ''), auth.uid())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Open count exists';
  END;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_stock_count(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_stock_count(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5) set_stock_count_item — set absolute counted quantity (NULL = uncount)
-- ─────────────────────────────────────────────────────────────────────────
-- The count row is locked FOR SHARE: concurrent item edits (several
-- scanners) don't block each other, but they do conflict with the
-- FOR UPDATE taken by complete/cancel/delete, so no item can be written
-- into a count that is being completed.
CREATE OR REPLACE FUNCTION public.set_stock_count_item(
  p_count_id uuid,
  p_product_size_id uuid,
  p_counted_qty integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_count record;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT id, warehouse_id, status INTO v_count
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;
  IF v_count.status <> 'draft' THEN
    RAISE EXCEPTION 'Count is not open';
  END IF;

  -- NULL = return the variant to "not counted". Only company ownership is
  -- checked here (not the warehouse), so a line whose variant was moved to
  -- another warehouse after being counted can still be removed.
  IF p_counted_qty IS NULL THEN
    DELETE FROM public.stock_count_items
    WHERE count_id = v_count.id
      AND product_size_id = p_product_size_id
      AND company_id = v_company_id;
    RETURN;
  END IF;

  IF p_counted_qty < 0 THEN
    RAISE EXCEPTION 'Invalid quantity';
  END IF;

  IF p_product_size_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.product_sizes
    WHERE id = p_product_size_id
      AND company_id = v_company_id
      AND warehouse_id = v_count.warehouse_id
  ) THEN
    RAISE EXCEPTION 'Item not in this warehouse';
  END IF;

  INSERT INTO public.stock_count_items (company_id, count_id, product_size_id, counted_qty)
  VALUES (v_company_id, v_count.id, p_product_size_id, p_counted_qty)
  ON CONFLICT (count_id, product_size_id) DO UPDATE
    SET counted_qty = EXCLUDED.counted_qty;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_stock_count_item(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_stock_count_item(uuid, uuid, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 6) increment_stock_count_item — scanner: atomic +delta, floor at 0
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_stock_count_item(
  p_count_id uuid,
  p_product_size_id uuid,
  p_delta integer DEFAULT 1
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_count record;
  v_qty integer;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT id, warehouse_id, status INTO v_count
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;
  IF v_count.status <> 'draft' THEN
    RAISE EXCEPTION 'Count is not open';
  END IF;

  IF p_delta IS NULL THEN
    RAISE EXCEPTION 'Invalid quantity';
  END IF;

  IF p_product_size_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.product_sizes
    WHERE id = p_product_size_id
      AND company_id = v_company_id
      AND warehouse_id = v_count.warehouse_id
  ) THEN
    RAISE EXCEPTION 'Item not in this warehouse';
  END IF;

  -- Single statement: concurrent scans of the same variant serialize on the
  -- item row via ON CONFLICT, no lost updates.
  INSERT INTO public.stock_count_items (company_id, count_id, product_size_id, counted_qty)
  VALUES (v_company_id, v_count.id, p_product_size_id, GREATEST(0, p_delta))
  ON CONFLICT (count_id, product_size_id) DO UPDATE
    SET counted_qty = GREATEST(0, public.stock_count_items.counted_qty + p_delta)
  RETURNING counted_qty INTO v_qty;

  RETURN v_qty;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_stock_count_item(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_stock_count_item(uuid, uuid, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 7) complete_stock_count — apply counted quantities to stock
-- ─────────────────────────────────────────────────────────────────────────
-- Order of operations (all in the caller's single transaction):
--   a) lock the count row FOR UPDATE (blocks concurrent item edits,
--      cancel, delete, and a second complete);
--   b) lock every affected product_sizes row FOR UPDATE ORDER BY id
--      (deterministic order => no lock-order deadlock between two
--      completes; sell_cart/stock_out wait on these rows until commit);
--   c) refuse if any counted variant no longer belongs to this warehouse;
--   d) zero_uncounted: add counted_qty=0 lines for the warehouse's
--      uncounted variants with stock <> 0;
--   e) snapshot expected_qty / purchase_price from the locked rows;
--   f) stock := counted_qty;
--   g) mark completed.
CREATE OR REPLACE FUNCTION public.complete_stock_count(
  p_count_id uuid,
  p_zero_uncounted boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_count record;
  v_zero boolean := COALESCE(p_zero_uncounted, false);
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  -- a)
  SELECT id, warehouse_id, status INTO v_count
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;
  IF v_count.status <> 'draft' THEN
    RAISE EXCEPTION 'Count is not open';
  END IF;

  -- b) counted variants (even if moved, so c) sees a stable value) plus,
  --    in zero_uncounted mode, every variant of the warehouse.
  PERFORM 1
  FROM public.product_sizes ps
  WHERE ps.company_id = v_company_id
    AND (
      ps.id IN (
        SELECT i.product_size_id FROM public.stock_count_items i
        WHERE i.count_id = v_count.id AND i.company_id = v_company_id
      )
      OR (v_zero AND ps.warehouse_id = v_count.warehouse_id)
    )
  ORDER BY ps.id
  FOR UPDATE;

  -- c)
  IF EXISTS (
    SELECT 1
    FROM public.stock_count_items i
    JOIN public.product_sizes ps ON ps.id = i.product_size_id
    WHERE i.count_id = v_count.id
      AND i.company_id = v_company_id
      AND (ps.company_id <> v_company_id OR ps.warehouse_id <> v_count.warehouse_id)
  ) THEN
    RAISE EXCEPTION 'Item not in this warehouse';
  END IF;

  -- d)
  IF v_zero THEN
    INSERT INTO public.stock_count_items (company_id, count_id, product_size_id, counted_qty)
    SELECT v_company_id, v_count.id, ps.id, 0
    FROM public.product_sizes ps
    WHERE ps.company_id = v_company_id
      AND ps.warehouse_id = v_count.warehouse_id
      AND ps.stock <> 0
      AND NOT EXISTS (
        SELECT 1 FROM public.stock_count_items i
        WHERE i.count_id = v_count.id AND i.product_size_id = ps.id
      );
  END IF;

  -- e) snapshot BEFORE stock is overwritten
  UPDATE public.stock_count_items i
  SET expected_qty = ps.stock,
      purchase_price = ps.purchase_price
  FROM public.product_sizes ps
  WHERE i.count_id = v_count.id
    AND i.company_id = v_company_id
    AND ps.id = i.product_size_id
    AND ps.company_id = v_company_id;

  -- f)
  UPDATE public.product_sizes ps
  SET stock = i.counted_qty,
      updated_at = now()
  FROM public.stock_count_items i
  WHERE i.count_id = v_count.id
    AND i.company_id = v_company_id
    AND ps.id = i.product_size_id
    AND ps.company_id = v_company_id
    AND ps.warehouse_id = v_count.warehouse_id
    AND ps.stock <> i.counted_qty;

  -- g)
  UPDATE public.stock_counts
  SET status = 'completed',
      completed_by = auth.uid(),
      completed_at = now(),
      zero_uncounted = v_zero
  WHERE id = v_count.id AND company_id = v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_stock_count(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_stock_count(uuid, boolean) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 8) cancel_stock_count — draft -> cancelled, stock untouched
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_stock_count(p_count_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_status text;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT status INTO v_status
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Count is not open';
  END IF;

  UPDATE public.stock_counts
  SET status = 'cancelled'
  WHERE id = p_count_id AND company_id = v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cancel_stock_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_stock_count(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 9) delete_stock_count — only draft / cancelled (items cascade)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_stock_count(p_count_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_status text;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT status INTO v_status
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;
  IF v_status = 'completed' THEN
    RAISE EXCEPTION 'Completed count cannot be deleted';
  END IF;

  DELETE FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_stock_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_stock_count(uuid) TO authenticated;
