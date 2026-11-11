-- Production: exact per-lot costing (partiya) - FIFO/FEFO + manual lot pick.
--
-- Why: stock was valued at a running weighted average per (warehouse, item),
-- so "which milk went into this separation, at what price, from which
-- farmer" could not be answered, and the cost of a run was an average, not
-- the real cost of the milk used (3 deliveries at 5 000 / 4 800 / 5 200 were
-- blended). From now on EVERY inflow creates a lot with its own unit_cost,
-- fat / protein, supplier, received_at and expiry, and EVERY outflow consumes
-- concrete lots: automatically (FEFO: expiry_date NULLS LAST, received_at,
-- lot_no) or from lots the user picked. Supplier payments / akt-sverka are
-- NOT touched (they read receipts, not stock).
--
-- This file adds / changes:
--   1) prod_items.shelf_life_days            - default expiry of new lots
--   2) public.prod_lots                      - one row per lot
--   3) prod_stock_movements.lot_id           - FK + CHECK (lot_id IS NOT NULL)
--                                              NOT VALID: every NEW row must
--                                              carry a lot, old rows stay NULL
--   4) backfill                              - one OPENING lot per
--                                              (company, warehouse, item) with
--                                              legacy stock <> 0
--   5) views: prod_lot_stock (new), prod_stock and prod_stock_quality
--      (CREATE OR REPLACE, identical column list / order / types, now
--      aggregates over lots)
--   6) internal helpers (EXECUTE revoked from every client role):
--        prod_lot_remaining, prod_lot_expiry, prod_next_lot_no, prod_add_lot,
--        prod_consume, prod_reverse_document (new);
--        prod_current_stock, prod_stock_quality_at,
--        prod_stock_movements_quality (trigger fn) (replaced, same signatures)
--   7) RPCs replaced (same signatures, same return shapes, extra OPTIONAL
--      input keys only):
--        prod_save_item          + shelf_life_days
--        prod_create_receipt     + items[i].expiry_date
--        prod_milk_apply_lab     (internal; lot with lab fat/protein)
--        prod_cancel_receipt_internal (internal)
--        prod_create_production  + components[i].lots
--        prod_create_processing  + source_lots
--        prod_create_transfer    + items[i].lots
--        prod_create_separation  + milk_lots
--        prod_change_item_unit   (per lot)
--        prod_cancel_document    (latest = 20261110000012)
--      prod_record_milk_lab / prod_cancel_milk_intake / prod_create_milk_intake
--      are NOT replaced: they never touch the ledger themselves, they call
--      prod_milk_apply_lab / prod_cancel_receipt_internal, which are.
--
-- ── Costing rules ──────────────────────────────────────────────────────────
--   * A lot's unit_cost never changes. Every movement of a lot carries the
--     lot's unit_cost, fat_pct and protein_pct (explicitly; the quality
--     trigger keeps them untouched for rows with a lot_id).
--   * remaining(lot) = opening_qty + sum(movements.qty of that lot);
--     value(lot) = round(remaining * unit_cost, 2).
--   * Cost of an outflow = sum over the lots used of round(q * unit_cost, 2)
--     (exact, no averaging). Document line unit_cost columns keep their
--     meaning as "cost per unit" = round(line cost / qty, 2); line totals are
--     the exact lot cost.
--   * Production output unit_cost = round(total / qty, 2) (as before);
--     transfer destination lots copy the SOURCE lot unit_cost / fat / protein
--     / supplier / expiry / received_at (FIFO age kept) with origin_lot_id;
--     unit change: new lot qty = round(rem * factor, 3), unit_cost =
--     round(unit_cost / factor, 2), origin_lot_id = old lot.
--   * Expiry of a new lot: explicit receipt line expiry_date, else
--     business date (Asia/Tashkent, same convention as exchange_rates) of
--     the document + item.shelf_life_days, else NULL.
--
-- ── Cancellation (prod_reverse_document) ───────────────────────────────────
--   Every original movement of the document is mirrored 1:1 (is_reversal =
--   true) into the SAME lot_id with the SAME unit_cost. Reversing an inflow
--   needs that lot's remaining >= qty, else 'insufficient_stock' (the lot
--   was already used downstream / transferred / converted).
--   LEGACY movements (posted before this migration, lot_id NULL) are
--   reversed into the item's OPENING lot of that warehouse (which contains
--   the legacy stock), at the opening lot's unit_cost / fat / protein - so the
--   invariant "movement cost = lot cost" holds; the value difference between
--   the original movement cost and the opening average is absorbed by the
--   opening lot (it was already blended there). If no opening lot exists
--   (legacy stock of that key was exactly 0): a legacy OUTFLOW reversal
--   (stock comes back) creates a fresh lot at the original movement's
--   unit_cost / fat / protein, received_at = original created_at,
--   source_doc_type 'legacy_reversal'; a legacy INFLOW reversal has nothing
--   to take from -> 'insufficient_stock' (the old code refused it too: key
--   stock was 0).
--
-- ── Legacy negative stock ──────────────────────────────────────────────────
--   A key with negative legacy stock still gets an opening lot (negative
--   opening_qty, unit_cost 0) so totals stay equal; the count is RAISE
--   NOTICEd. FEFO never takes from lots with remaining <= 0, so such a lot
--   stays negative until corrected; prod_stock shows the true sum.
--
-- ── Lock order (deadlock safety) ───────────────────────────────────────────
--   Unchanged global order, plus ONE new lock that is always LAST:
--     document row FOR UPDATE (cancel only)
--     -> stock keys 'prod_stock:<company>:<warehouse>:<item>' in ascending
--        (item_id, warehouse_id) order, ALL taken before any consumption
--     -> document-number lock 'prod_*_no:<company>'
--     -> lot-number lock 'prod_lot_no:<company>' (prod_next_lot_no, taken
--        by prod_add_lot / legacy fresh-lot creation).
--   No function takes a stock key, a document-number lock or a row lock
--   after it holds 'prod_lot_no', so no cycle is possible. prod_consume
--   re-takes the key it consumes (re-entrant no-op for a correct caller).
--   Inflows still take no stock lock: they only ever create NEW lots, and
--   every decrement of an existing lot (consumption, inflow reversal, unit
--   change) happens under that lot's (warehouse, item) key.
--   Note: 'prod_lot_no' serialises lot-creating transactions of ONE company
--   until commit (same cost class as the per-doc-type number locks).
--
-- ── Destructive / blocking statements ─────────────────────────────────────
--   NO DROP, no data deleted or rewritten. ALTER TABLE prod_stock_movements
--   ADD COLUMN (NULL, no default: metadata-only, the append-only trigger is
--   not fired) + ADD FOREIGN KEY (validated: every existing row is NULL) +
--   ADD CHECK ... NOT VALID (existing rows not checked) take an ACCESS
--   EXCLUSIVE lock on the ledger until COMMIT: production writes wait for
--   the (short) migration. Any old-definition call queued behind that lock
--   fails on the new CHECK instead of writing a lot-less row.
--   WARNING (behaviour, not data): prod_stock / prod_stock_quality are
--   CREATE OR REPLACEd. Same columns, but rows with qty = 0 are no longer
--   listed (lib/production.ts already filters qty <> 0 / > 0).
--
-- Client deploy: NOT required for safety. All signatures / return shapes
-- are unchanged and every new input key is optional (omitted = FEFO).
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) prod_items.shelf_life_days ────────────────────────────────────────

ALTER TABLE public.prod_items
  ADD COLUMN shelf_life_days integer NULL;

ALTER TABLE public.prod_items
  ADD CONSTRAINT prod_items_shelf_life_check
    CHECK (shelf_life_days IS NULL OR shelf_life_days BETWEEN 1 AND 3650);

-- ─── 2) prod_lots ─────────────────────────────────────────────────────────
-- Access: RLS company-scoped SELECT for authenticated (read by the UI via
-- prod_lot_stock); writes ONLY through the SECURITY DEFINER RPCs below.
-- opening_qty > 0 (or < 0) only for backfill opening lots (CHECK).

CREATE TABLE public.prod_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  lot_no text NOT NULL,
  received_at timestamptz NOT NULL,
  opening_qty numeric(14,3) NOT NULL DEFAULT 0,
  unit_cost numeric(14,2) NOT NULL,
  fat_pct numeric(6,3) NULL,
  protein_pct numeric(6,3) NULL,
  supplier_id uuid NULL,
  source_doc_type text NULL,
  source_doc_id uuid NULL,
  origin_lot_id uuid NULL,
  expiry_date date NULL,
  is_opening boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_lots_company_lot_no_key UNIQUE (company_id, lot_no),
  CONSTRAINT prod_lots_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_lots_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_lots_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_lots_supplier_fk FOREIGN KEY (supplier_id, company_id)
    REFERENCES public.prod_suppliers (id, company_id),
  CONSTRAINT prod_lots_origin_fk FOREIGN KEY (origin_lot_id, company_id)
    REFERENCES public.prod_lots (id, company_id),
  CONSTRAINT prod_lots_lot_no_check CHECK (lot_no ~ '^P-[0-9]{6,15}$'),
  CONSTRAINT prod_lots_unit_cost_check CHECK (unit_cost >= 0),
  CONSTRAINT prod_lots_fat_check CHECK (fat_pct IS NULL OR fat_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_lots_protein_check CHECK (protein_pct IS NULL OR protein_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_lots_opening_check CHECK (is_opening OR opening_qty = 0),
  CONSTRAINT prod_lots_origin_check CHECK (origin_lot_id IS NULL OR origin_lot_id <> id),
  CONSTRAINT prod_lots_source_doc_type_check CHECK (
    source_doc_type IS NULL OR source_doc_type IN (
      'opening', 'receipt', 'production', 'processing', 'transfer', 'conversion',
      'separation', 'legacy_reversal'
    )
  )
);

COMMENT ON TABLE public.prod_lots IS
  'Production stock lots (partiya). remaining = opening_qty + sum(prod_stock_movements.qty '
  'WHERE lot_id = id). Read via RLS (company-scoped SELECT) / prod_lot_stock; write ONLY via '
  'production RPCs.';

CREATE INDEX prod_lots_stock_idx ON public.prod_lots (company_id, warehouse_id, item_id);
CREATE INDEX prod_lots_source_doc_idx ON public.prod_lots (source_doc_id) WHERE source_doc_id IS NOT NULL;
CREATE INDEX prod_lots_origin_idx ON public.prod_lots (origin_lot_id, company_id) WHERE origin_lot_id IS NOT NULL;
CREATE INDEX prod_lots_supplier_idx ON public.prod_lots (supplier_id, company_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX prod_lots_item_idx ON public.prod_lots (item_id, company_id);
-- prod_next_lot_no: top lot number per company = longest, then greatest.
CREATE INDEX prod_lots_lot_no_order_idx ON public.prod_lots (company_id, length(lot_no) DESC, lot_no DESC);
-- At most one opening lot per stock key (target of legacy reversals).
CREATE UNIQUE INDEX prod_lots_opening_key ON public.prod_lots (company_id, warehouse_id, item_id) WHERE is_opening;

ALTER TABLE public.prod_lots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Company isolation (select)" ON public.prod_lots
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()));
-- Close the Supabase default-grant leak, then read-only for authenticated.
REVOKE ALL ON public.prod_lots FROM authenticated, anon;
GRANT SELECT ON public.prod_lots TO authenticated;

-- ─── 3) prod_stock_movements.lot_id ───────────────────────────────────────
-- MATCH SIMPLE composite FK (NULL skips, legacy rows). NOT VALID CHECK:
-- existing rows are not checked, every new INSERT is.

ALTER TABLE public.prod_stock_movements
  ADD COLUMN lot_id uuid NULL;

ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_lot_fk FOREIGN KEY (lot_id, company_id)
    REFERENCES public.prod_lots (id, company_id);

ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_lot_required CHECK (lot_id IS NOT NULL) NOT VALID;

CREATE INDEX prod_stock_movements_lot_idx
  ON public.prod_stock_movements (lot_id, company_id) INCLUDE (qty)
  WHERE lot_id IS NOT NULL;

-- ─── 4) Backfill: one opening lot per legacy stock key ────────────────────
-- Computed inline from the ledger with the OLD formulas (prod_stock /
-- prod_stock_quality of 03 / 10), BEFORE the views are replaced. The ledger
-- is ACCESS EXCLUSIVE locked by step 3, so it cannot change underneath.
-- unit_cost = round(value / qty, 2) (0 when qty <= 0); lot numbers
-- P-000001.. per company in (warehouse name, item name) order.

INSERT INTO public.prod_lots (
  company_id, warehouse_id, item_id, lot_no, received_at, opening_qty, unit_cost,
  fat_pct, protein_pct, source_doc_type, is_opening
)
SELECT
  s.company_id, s.warehouse_id, s.item_id,
  'P-' || lpad((row_number() OVER (PARTITION BY s.company_id ORDER BY w.name, i.name, s.warehouse_id, s.item_id))::text, 6, '0'),
  now(),
  s.qty,
  CASE WHEN s.qty > 0 THEN round(s.value / s.qty, 2) ELSE 0 END,
  CASE WHEN s.fat_qty > 0 THEN
    CASE WHEN round(s.fat_sum / s.fat_qty, 3) BETWEEN 0 AND 100 THEN round(s.fat_sum / s.fat_qty, 3) END
  END,
  CASE WHEN s.pro_qty > 0 THEN
    CASE WHEN round(s.pro_sum / s.pro_qty, 3) BETWEEN 0 AND 100 THEN round(s.pro_sum / s.pro_qty, 3) END
  END,
  'opening',
  true
FROM (
  SELECT
    m.company_id, m.warehouse_id, m.item_id,
    sum(m.qty) AS qty,
    sum(m.qty * m.unit_cost) AS value,
    sum(m.qty) FILTER (WHERE m.fat_pct IS NOT NULL) AS fat_qty,
    sum(m.qty * m.fat_pct) AS fat_sum,
    sum(m.qty) FILTER (WHERE m.protein_pct IS NOT NULL) AS pro_qty,
    sum(m.qty * m.protein_pct) AS pro_sum
  FROM public.prod_stock_movements m
  GROUP BY m.company_id, m.warehouse_id, m.item_id
  HAVING sum(m.qty) <> 0
) s
JOIN public.prod_warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
JOIN public.prod_items i ON i.id = s.item_id AND i.company_id = s.company_id;

DO $$
DECLARE
  v_lots integer;
  v_neg integer;
  v_bad integer;
  v_old_value numeric;
  v_new_value numeric;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE opening_qty < 0)
  INTO v_lots, v_neg
  FROM public.prod_lots WHERE is_opening;

  -- Assert: per key, sum of lot remaining = legacy qty (both directions).
  SELECT count(*) INTO v_bad
  FROM (
    SELECT m.company_id, m.warehouse_id, m.item_id, sum(m.qty) AS qty
    FROM public.prod_stock_movements m
    GROUP BY m.company_id, m.warehouse_id, m.item_id
  ) legacy
  FULL JOIN (
    SELECT l.company_id, l.warehouse_id, l.item_id, sum(l.opening_qty) AS qty
    FROM public.prod_lots l
    GROUP BY l.company_id, l.warehouse_id, l.item_id
  ) lots
    ON lots.company_id = legacy.company_id
   AND lots.warehouse_id = legacy.warehouse_id
   AND lots.item_id = legacy.item_id
  WHERE COALESCE(legacy.qty, 0) <> COALESCE(lots.qty, 0);

  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'prod_lots backfill mismatch on % stock keys', v_bad;
  END IF;

  SELECT COALESCE(sum(round(x.value, 2)), 0) INTO v_old_value
  FROM (
    SELECT sum(m.qty * m.unit_cost) AS value
    FROM public.prod_stock_movements m
    GROUP BY m.company_id, m.warehouse_id, m.item_id
  ) x;
  SELECT COALESCE(sum(round(l.opening_qty * l.unit_cost, 2)), 0) INTO v_new_value
  FROM public.prod_lots l WHERE l.is_opening;

  RAISE NOTICE 'prod_lots backfill: % opening lots (% with negative qty), value legacy % -> lots % (diff %, unit_cost rounding)',
    v_lots, v_neg, v_old_value, v_new_value, v_new_value - v_old_value;
END;
$$;

-- ─── 5) Views ─────────────────────────────────────────────────────────────
-- security_invoker = true everywhere: the caller's RLS on prod_lots,
-- prod_stock_movements, prod_warehouses, prod_items, prod_suppliers applies.
-- LEFT JOINs on unique keys so the planner removes the name joins when
-- prod_stock / prod_stock_quality do not need them.

CREATE VIEW public.prod_lot_stock
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
  round((l.opening_qty + COALESCE(m.qty, 0)) * l.unit_cost, 2) AS value
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
  'round(remaining_qty * unit_cost, 2), plus warehouse / item / supplier names.';

-- Same columns / order / types as 20261110000003 (qty, value, avg_cost are
-- plain numeric there too). Only lots with remaining <> 0 contribute.
CREATE OR REPLACE VIEW public.prod_stock
WITH (security_invoker = true)
AS
SELECT
  ls.company_id,
  ls.warehouse_id,
  ls.item_id,
  sum(ls.remaining_qty) AS qty,
  sum(ls.value) AS value,
  CASE
    WHEN sum(ls.remaining_qty) > 0 THEN round(sum(ls.value) / sum(ls.remaining_qty), 2)
    ELSE 0::numeric
  END AS avg_cost
FROM public.prod_lot_stock ls
WHERE ls.remaining_qty <> 0
GROUP BY ls.company_id, ls.warehouse_id, ls.item_id;

COMMENT ON VIEW public.prod_stock IS
  'Current production stock per (company, warehouse, item) = sum over its lots '
  '(prod_lot_stock, remaining <> 0). value = sum of lot values, avg_cost = value / qty '
  '(0 when qty <= 0).';

-- Same columns / order / types as 20261110000010; weights = lot remaining.
CREATE OR REPLACE VIEW public.prod_stock_quality
WITH (security_invoker = true)
AS
SELECT
  s.company_id,
  s.warehouse_id,
  s.item_id,
  s.qty,
  CASE WHEN s.fat_qty > 0 THEN
    CASE WHEN round(s.fat_sum / s.fat_qty, 3) BETWEEN 0 AND 100
         THEN round(s.fat_sum / s.fat_qty, 3) END
  END AS avg_fat,
  CASE WHEN s.pro_qty > 0 THEN
    CASE WHEN round(s.pro_sum / s.pro_qty, 3) BETWEEN 0 AND 100
         THEN round(s.pro_sum / s.pro_qty, 3) END
  END AS avg_protein
FROM (
  SELECT
    ls.company_id,
    ls.warehouse_id,
    ls.item_id,
    sum(ls.remaining_qty) AS qty,
    sum(ls.remaining_qty) FILTER (WHERE ls.fat_pct IS NOT NULL) AS fat_qty,
    sum(ls.remaining_qty * ls.fat_pct) AS fat_sum,
    sum(ls.remaining_qty) FILTER (WHERE ls.protein_pct IS NOT NULL) AS pro_qty,
    sum(ls.remaining_qty * ls.protein_pct) AS pro_sum
  FROM public.prod_lot_stock ls
  WHERE ls.remaining_qty <> 0
  GROUP BY ls.company_id, ls.warehouse_id, ls.item_id
) s;

COMMENT ON VIEW public.prod_stock_quality IS
  'Per (company, warehouse, item): qty = sum of lot remaining, avg_fat / avg_protein = '
  'remaining-weighted over lots with a non-NULL value (NULL when none, when that '
  'tracked qty <= 0 or when the result is outside 0..100).';

REVOKE ALL ON public.prod_lot_stock FROM authenticated, anon;
GRANT SELECT ON public.prod_lot_stock TO authenticated;
REVOKE ALL ON public.prod_stock FROM authenticated, anon;
GRANT SELECT ON public.prod_stock TO authenticated;
REVOKE ALL ON public.prod_stock_quality FROM authenticated, anon;
GRANT SELECT ON public.prod_stock_quality TO authenticated;

-- ─── 6) Internal helpers ──────────────────────────────────────────────────
-- Take explicit company ids; reachable only from the SECURITY DEFINER RPCs
-- (EXECUTE revoked from PUBLIC / anon / authenticated below). VOLATILE: they
-- must read with a snapshot taken after the caller's stock lock.

-- Remaining qty of one lot of the company (NULL if no such lot).
CREATE OR REPLACE FUNCTION public.prod_lot_remaining(p_company_id uuid, p_lot_id uuid)
RETURNS numeric
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.opening_qty + COALESCE((
    SELECT sum(m.qty) FROM public.prod_stock_movements m
    WHERE m.lot_id = l.id AND m.company_id = l.company_id
  ), 0)
  FROM public.prod_lots l
  WHERE l.id = p_lot_id AND l.company_id = p_company_id
$$;

-- Default expiry: business date (Asia/Tashkent) of p_at + shelf_life_days.
CREATE OR REPLACE FUNCTION public.prod_lot_expiry(p_company_id uuid, p_item_id uuid, p_at timestamptz)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN i.shelf_life_days IS NOT NULL AND p_at IS NOT NULL
              THEN (p_at AT TIME ZONE 'Asia/Tashkent')::date + i.shelf_life_days END
  FROM public.prod_items i
  WHERE i.id = p_item_id AND i.company_id = p_company_id
$$;

-- Next lot number 'P-000001' for the company. Takes the per-company lot
-- number lock (ALWAYS the last lock of a transaction, see header) and reads
-- max under it; own earlier inserts in this transaction are visible.
CREATE OR REPLACE FUNCTION public.prod_next_lot_no(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_top text;
  v_n bigint;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('prod_lot_no:' || p_company_id::text, 0));
  SELECT l.lot_no INTO v_top
  FROM public.prod_lots l
  WHERE l.company_id = p_company_id
  ORDER BY length(l.lot_no) DESC, l.lot_no DESC
  LIMIT 1;
  v_n := COALESCE(substr(v_top, 3)::bigint, 0) + 1;
  RETURN 'P-' || CASE WHEN v_n < 1000000 THEN lpad(v_n::text, 6, '0') ELSE v_n::text END;
END;
$$;

-- Insert one lot and its inflow movement (qty > 0, lot cost / fat / protein).
-- p_lot_no NULL -> prod_next_lot_no (takes the lot number lock).
CREATE OR REPLACE FUNCTION public.prod_add_lot(
  p_company_id uuid, p_warehouse_id uuid, p_item_id uuid, p_qty numeric, p_unit_cost numeric,
  p_fat_pct numeric, p_protein_pct numeric, p_supplier_id uuid, p_doc_type text, p_doc_id uuid,
  p_origin_lot_id uuid, p_expiry_date date, p_received_at timestamptz, p_lot_no text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_warehouse_id IS NULL OR p_item_id IS NULL
     OR p_doc_type IS NULL OR p_doc_id IS NULL
     OR p_qty IS NULL OR p_qty <= 0
     OR p_unit_cost IS NULL OR p_unit_cost < 0 OR p_unit_cost >= 1e12
     OR (p_fat_pct IS NOT NULL AND p_fat_pct NOT BETWEEN 0 AND 100)
     OR (p_protein_pct IS NOT NULL AND p_protein_pct NOT BETWEEN 0 AND 100) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.prod_lots (
    company_id, warehouse_id, item_id, lot_no, received_at, opening_qty, unit_cost,
    fat_pct, protein_pct, supplier_id, source_doc_type, source_doc_id, origin_lot_id,
    expiry_date, is_opening
  ) VALUES (
    p_company_id, p_warehouse_id, p_item_id,
    COALESCE(p_lot_no, public.prod_next_lot_no(p_company_id)),
    COALESCE(p_received_at, now()), 0, round(p_unit_cost, 2),
    p_fat_pct, p_protein_pct, p_supplier_id, p_doc_type, p_doc_id, p_origin_lot_id,
    p_expiry_date, false
  )
  RETURNING id INTO v_id;

  INSERT INTO public.prod_stock_movements (
    company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
    fat_pct, protein_pct, lot_id
  ) VALUES (
    p_company_id, p_warehouse_id, p_item_id, p_qty, round(p_unit_cost, 2), p_doc_type, p_doc_id, false, auth.uid(),
    p_fat_pct, p_protein_pct, v_id
  );

  RETURN v_id;
END;
$$;

-- Consume p_qty of (company, warehouse, item) from lots and write ONE
-- outflow movement per lot used (qty < 0, the lot's cost / fat / protein).
-- PRECONDITION: the caller holds the stock lock of (warehouse, item)
-- (re-taken here: re-entrant no-op).
-- p_picks NULL / JSON null / [] -> FEFO over lots with remaining > 0:
--   expiry_date NULLS LAST, received_at, lot_no.
-- p_picks [{lot_id, qty}] (1..500) -> each lot of (company, warehouse, item)
--   (else invalid_input), qty > 0 with 3 decimals, no duplicate lot
--   (invalid_input), qty <= remaining (insufficient_stock), sum = p_qty
--   (invalid_input).
-- Not enough stock -> insufficient_stock, DETAIL = item id.
-- Returns {qty, cost, fat_pct, protein_pct, lots:[{lot_id, lot_no, qty, unit_cost}]}
--   cost = sum(round(q * unit_cost, 2)); fat / protein = qty-weighted over
--   the used lots with a non-NULL value (round 3), NULL if none.
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
DECLARE
  v_picks jsonb := p_picks;
  v_pick jsonb;
  v_lot_id uuid;
  v_q numeric;
  v_rem numeric;
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
     OR p_qty IS NULL OR p_qty <= 0 THEN
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
    -- FEFO plan.
    v_left := p_qty;
    FOR v_rec IN
      SELECT x.id, x.remaining
      FROM (
        SELECT l.id, l.expiry_date, l.received_at, l.lot_no,
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
      ORDER BY x.expiry_date NULLS LAST, x.received_at, length(x.lot_no), x.lot_no
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
      IF NOT EXISTS (
        SELECT 1 FROM public.prod_lots l
        WHERE l.id = v_lot_id AND l.company_id = p_company_id
          AND l.warehouse_id = p_warehouse_id AND l.item_id = p_item_id
      ) THEN
        RAISE EXCEPTION 'invalid_input';
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

-- Reverse every original movement of one document (see header,
-- "Cancellation"). PRECONDITION: caller locked the document row FOR UPDATE
-- and checked status / permission / role. Locks: stock keys in global
-- (item_id, warehouse_id) order, then (legacy fresh lots only) lot number.
CREATE OR REPLACE FUNCTION public.prod_reverse_document(p_company_id uuid, p_doc_type text, p_doc_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec record;
  v_lot record;
  v_rem numeric;
  v_new_lot uuid;
BEGIN
  IF p_company_id IS NULL OR p_doc_type IS NULL OR p_doc_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_rec IN
    SELECT DISTINCT m.warehouse_id, m.item_id
    FROM public.prod_stock_movements m
    WHERE m.company_id = p_company_id AND m.doc_type = p_doc_type
      AND m.doc_id = p_doc_id AND NOT m.is_reversal
    ORDER BY m.item_id, m.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(p_company_id, v_rec.warehouse_id, ARRAY[v_rec.item_id]);
  END LOOP;

  -- Check: every lot that loses qty must still hold it.
  FOR v_rec IN
    SELECT t.target_lot, t.item_id, -sum(t.qty) AS delta
    FROM (
      SELECT m.item_id, m.qty,
             COALESCE(m.lot_id, (
               SELECT o.id FROM public.prod_lots o
               WHERE o.company_id = m.company_id AND o.warehouse_id = m.warehouse_id
                 AND o.item_id = m.item_id AND o.is_opening
             )) AS target_lot
      FROM public.prod_stock_movements m
      WHERE m.company_id = p_company_id AND m.doc_type = p_doc_type
        AND m.doc_id = p_doc_id AND NOT m.is_reversal
    ) t
    GROUP BY t.target_lot, t.item_id
  LOOP
    IF v_rec.delta < 0 THEN
      IF v_rec.target_lot IS NULL THEN
        RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_rec.item_id::text;
      END IF;
      v_rem := public.prod_lot_remaining(p_company_id, v_rec.target_lot);
      IF v_rem + v_rec.delta < 0 THEN
        RAISE EXCEPTION 'insufficient_stock' USING DETAIL = v_rec.item_id::text;
      END IF;
    END IF;
  END LOOP;

  -- Mirror rows. Snapshot of the originals is taken at loop start, so the
  -- reversal rows inserted inside the loop are never revisited.
  FOR v_rec IN
    SELECT m.*,
           (SELECT o.id FROM public.prod_lots o
            WHERE o.company_id = m.company_id AND o.warehouse_id = m.warehouse_id
              AND o.item_id = m.item_id AND o.is_opening) AS opening_lot
    FROM public.prod_stock_movements m
    WHERE m.company_id = p_company_id AND m.doc_type = p_doc_type
      AND m.doc_id = p_doc_id AND NOT m.is_reversal
    ORDER BY m.item_id, m.warehouse_id, m.created_at, m.id
  LOOP
    IF v_rec.lot_id IS NOT NULL THEN
      INSERT INTO public.prod_stock_movements (
        company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
        fat_pct, protein_pct, lot_id
      ) VALUES (
        p_company_id, v_rec.warehouse_id, v_rec.item_id, -v_rec.qty, v_rec.unit_cost, p_doc_type, p_doc_id, true, auth.uid(),
        v_rec.fat_pct, v_rec.protein_pct, v_rec.lot_id
      );
    ELSIF v_rec.opening_lot IS NOT NULL THEN
      -- Legacy row -> the key's opening lot, at the opening lot's values.
      SELECT l.unit_cost, l.fat_pct, l.protein_pct INTO v_lot
      FROM public.prod_lots l WHERE l.id = v_rec.opening_lot AND l.company_id = p_company_id;
      INSERT INTO public.prod_stock_movements (
        company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
        fat_pct, protein_pct, lot_id
      ) VALUES (
        p_company_id, v_rec.warehouse_id, v_rec.item_id, -v_rec.qty, v_lot.unit_cost, p_doc_type, p_doc_id, true, auth.uid(),
        v_lot.fat_pct, v_lot.protein_pct, v_rec.opening_lot
      );
    ELSE
      -- Legacy outflow reversal without an opening lot (the check above
      -- guarantees -qty > 0 here): fresh lot at the original movement cost.
      INSERT INTO public.prod_lots (
        company_id, warehouse_id, item_id, lot_no, received_at, opening_qty, unit_cost,
        fat_pct, protein_pct, supplier_id, source_doc_type, source_doc_id, origin_lot_id,
        expiry_date, is_opening
      ) VALUES (
        p_company_id, v_rec.warehouse_id, v_rec.item_id, public.prod_next_lot_no(p_company_id),
        v_rec.created_at, 0, v_rec.unit_cost,
        v_rec.fat_pct, v_rec.protein_pct, NULL, 'legacy_reversal', p_doc_id, NULL,
        NULL, false
      )
      RETURNING id INTO v_new_lot;
      INSERT INTO public.prod_stock_movements (
        company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
        fat_pct, protein_pct, lot_id
      ) VALUES (
        p_company_id, v_rec.warehouse_id, v_rec.item_id, -v_rec.qty, v_rec.unit_cost, p_doc_type, p_doc_id, true, auth.uid(),
        v_rec.fat_pct, v_rec.protein_pct, v_new_lot
      );
    END IF;
  END LOOP;
END;
$$;

-- prod_current_stock (replaced, same signature): qty / avg_cost of a key
-- from its lots, same formulas as the prod_stock view.
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
  SELECT COALESCE(sum(x.rem), 0), COALESCE(sum(round(x.rem * x.unit_cost, 2)), 0)
  INTO qty, v_value
  FROM (
    SELECT l.unit_cost,
           l.opening_qty + COALESCE((
             SELECT sum(m.qty) FROM public.prod_stock_movements m
             WHERE m.lot_id = l.id AND m.company_id = l.company_id
           ), 0) AS rem
    FROM public.prod_lots l
    WHERE l.company_id = p_company_id
      AND l.warehouse_id = p_warehouse_id
      AND l.item_id = p_item_id
  ) x;

  avg_cost := CASE WHEN qty > 0 THEN round(v_value / qty, 2) ELSE 0 END;
END;
$$;

-- prod_stock_quality_at (replaced, same signature): remaining-weighted over
-- the key's lots, same formula as the prod_stock_quality view.
CREATE OR REPLACE FUNCTION public.prod_stock_quality_at(
  p_company_id uuid, p_warehouse_id uuid, p_item_id uuid,
  OUT avg_fat numeric, OUT avg_protein numeric
)
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fat_qty numeric;
  v_fat_sum numeric;
  v_pro_qty numeric;
  v_pro_sum numeric;
  v_avg numeric;
BEGIN
  SELECT sum(x.rem) FILTER (WHERE x.fat_pct IS NOT NULL),
         sum(x.rem * x.fat_pct),
         sum(x.rem) FILTER (WHERE x.protein_pct IS NOT NULL),
         sum(x.rem * x.protein_pct)
  INTO v_fat_qty, v_fat_sum, v_pro_qty, v_pro_sum
  FROM (
    SELECT l.fat_pct, l.protein_pct,
           l.opening_qty + COALESCE((
             SELECT sum(m.qty) FROM public.prod_stock_movements m
             WHERE m.lot_id = l.id AND m.company_id = l.company_id
           ), 0) AS rem
    FROM public.prod_lots l
    WHERE l.company_id = p_company_id
      AND l.warehouse_id = p_warehouse_id
      AND l.item_id = p_item_id
  ) x
  WHERE x.rem <> 0;

  avg_fat := NULL;
  avg_protein := NULL;

  IF v_fat_qty > 0 THEN
    v_avg := round(v_fat_sum / v_fat_qty, 3);
    IF v_avg BETWEEN 0 AND 100 THEN
      avg_fat := v_avg;
    END IF;
  END IF;

  IF v_pro_qty > 0 THEN
    v_avg := round(v_pro_sum / v_pro_qty, 3);
    IF v_avg BETWEEN 0 AND 100 THEN
      avg_protein := v_avg;
    END IF;
  END IF;
END;
$$;

-- Quality trigger (replaced, same name): NEW rule RL first - a row with a
-- lot_id carries the lot's fat / protein explicitly (possibly NULL) and is
-- kept exactly as given. R0..R4 of 20261110000010 follow unchanged for any
-- lot-less writer (none remain; the NOT VALID CHECK rejects such rows).
CREATE OR REPLACE FUNCTION public.prod_stock_movements_quality()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_q record;
  v_from uuid;
BEGIN
  -- RL: lot rows are explicit (the lot is the source of truth).
  IF NEW.lot_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- R0: explicit values are kept.
  IF NEW.fat_pct IS NOT NULL OR NEW.protein_pct IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- R1: reversal mirrors the original row of the same document key.
  IF NEW.is_reversal THEN
    SELECT m.fat_pct, m.protein_pct
    INTO NEW.fat_pct, NEW.protein_pct
    FROM public.prod_stock_movements m
    WHERE m.company_id = NEW.company_id
      AND m.doc_type = NEW.doc_type
      AND m.doc_id = NEW.doc_id
      AND m.warehouse_id = NEW.warehouse_id
      AND m.item_id = NEW.item_id
      AND NOT m.is_reversal
    ORDER BY m.created_at, m.id
    LIMIT 1;
    RETURN NEW;
  END IF;

  -- R2: outflow at the current weighted average of the key.
  IF NEW.qty < 0 THEN
    SELECT * INTO v_q
    FROM public.prod_stock_quality_at(NEW.company_id, NEW.warehouse_id, NEW.item_id);
    NEW.fat_pct := v_q.avg_fat;
    NEW.protein_pct := v_q.avg_protein;
    RETURN NEW;
  END IF;

  -- R3: transfer inflow follows its source row.
  IF NEW.doc_type = 'transfer' THEN
    SELECT m.fat_pct AS avg_fat, m.protein_pct AS avg_protein
    INTO v_q
    FROM public.prod_stock_movements m
    WHERE m.company_id = NEW.company_id
      AND m.doc_type = 'transfer'
      AND m.doc_id = NEW.doc_id
      AND m.item_id = NEW.item_id
      AND m.qty < 0
      AND NOT m.is_reversal
    ORDER BY m.created_at, m.id
    LIMIT 1;
    IF FOUND THEN
      NEW.fat_pct := v_q.avg_fat;
      NEW.protein_pct := v_q.avg_protein;
      RETURN NEW;
    END IF;

    SELECT t.from_warehouse_id INTO v_from
    FROM public.prod_transfers t
    WHERE t.id = NEW.doc_id AND t.company_id = NEW.company_id;
    IF v_from IS NOT NULL AND v_from <> NEW.warehouse_id THEN
      SELECT * INTO v_q
      FROM public.prod_stock_quality_at(NEW.company_id, v_from, NEW.item_id);
      NEW.fat_pct := v_q.avg_fat;
      NEW.protein_pct := v_q.avg_protein;
    END IF;
    RETURN NEW;
  END IF;

  -- R4: other inflows carry no quality data.
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_lot_remaining(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_lot_expiry(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_next_lot_no(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_add_lot(uuid, uuid, uuid, numeric, numeric, numeric, numeric, uuid, text, uuid, uuid, date, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_consume(uuid, uuid, uuid, numeric, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_reverse_document(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_current_stock(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_stock_quality_at(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_stock_movements_quality() FROM PUBLIC, anon, authenticated;

-- ─── 7) RPCs ──────────────────────────────────────────────────────────────

-- ═══ prod_save_item (replaced, same signature) ═══════════════════════════
-- Body copied from 20261110000004. Additions:
--   * optional shelf_life_days: integer 1..3650. Key ABSENT -> unchanged on
--     update / NULL on create; present + null -> cleared.
--   * the unit-change guard also looks at lots (an opening lot always has
--     legacy movements, so this is belt and braces).
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
  v_has_shelf boolean;
  v_shelf numeric;
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

  IF v_name IS NULL
     OR v_unit IS NULL OR v_unit NOT IN ('kg', 'l', 'g', 'pcs', 'm')
     OR v_type IS NULL OR v_type NOT IN ('raw', 'semi', 'finished', 'packaging')
     OR (v_weight IS NOT NULL AND v_weight < 0)
     OR (v_min IS NOT NULL AND v_min < 0)
     OR (v_max IS NOT NULL AND v_max < 0)
     OR (v_min IS NOT NULL AND v_max IS NOT NULL AND v_max < v_min)
     OR (v_shelf IS NOT NULL AND (v_shelf <> trunc(v_shelf) OR v_shelf NOT BETWEEN 1 AND 3650)) THEN
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
        min_stock, max_stock, is_active, description, shelf_life_days
      ) VALUES (
        v_company_id, v_group_id, v_name, v_sku, v_barcode, v_unit, v_weight, v_type,
        v_min, v_max, COALESCE(v_active, true), v_description, v_shelf::integer
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

-- ═══ prod_create_receipt (replaced, same signature) ══════════════════════
-- Body copied from 20261110000007. Changes:
--   * optional line key expiry_date ('YYYY-MM-DD'); else doc business date
--     + item.shelf_life_days; else NULL.
--   * each line -> one lot (prod_add_lot): unit_cost = price, supplier =
--     receipt supplier_id, received_at = doc_date, no fat / protein.
--   Locks: 'prod_receipt_no' -> 'prod_lot_no' (inflow only, no stock lock).
-- p_data: { doc_date, warehouse_id, supplier_id, supplier_name, note,
--           items: [{ item_id, qty, price, expiry_date }] }
-- Returns { id, number }.
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
  v_item_id uuid;
  v_qty numeric;
  v_price numeric;
  v_expiry date;
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
  v_supplier_id := public.prod_juuid(p_data, 'supplier_id');
  v_supplier := public.prod_jtext(p_data, 'supplier_name', 200);
  v_note := public.prod_jtext(p_data, 'note', 500);

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
    -- array_append keeps a NULL element (index alignment).
    v_expiries := array_append(v_expiries, v_expiry);
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id = ANY (v_item_ids)) <> cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.prod_items
             WHERE company_id = v_company_id AND id = ANY (v_item_ids) AND NOT is_active) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_receipt_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_receipts WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_receipts (
    company_id, number, doc_date, warehouse_id, supplier_id, supplier_name, note, total,
    status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_warehouse_id, v_supplier_id, v_supplier, v_note, v_total,
    'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_receipt_items (company_id, receipt_id, item_id, qty, price, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_prices[i], round(v_qtys[i] * v_prices[i], 2));

    PERFORM public.prod_add_lot(
      v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i], v_prices[i],
      NULL, NULL, v_supplier_id, 'receipt', v_id, NULL,
      COALESCE(v_expiries[i], public.prod_lot_expiry(v_company_id, v_item_ids[i], v_doc_date)),
      v_doc_date, NULL
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_milk_apply_lab (internal, replaced, same signature) ════════════
-- Body copied from 20261110000010. ONLY change: the ledger row is now a lot
-- (prod_add_lot) with the lab fat / protein, supplier = intake supplier,
-- received_at = intake_date, expiry from the milk item's shelf life.
-- Locks: unchanged + 'prod_lot_no' last.
CREATE OR REPLACE FUNCTION public.prod_milk_apply_lab(p_company_id uuid, p_intake_id uuid, p_lab jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_in record;
  v_fat numeric;
  v_protein numeric;
  v_snf numeric;
  v_density numeric;
  v_acidity numeric;
  v_temperature numeric;
  v_antibiotic text;
  v_decision text;
  v_override numeric;
  v_decision_note text;
  v_volume numeric;
  v_mode text;
  v_base_fat numeric;
  v_base_protein numeric;
  v_default_price numeric;
  v_sup_active boolean;
  v_sup_name text;
  v_sup_price numeric;
  v_item_active boolean;
  v_pricing_mode text := NULL;
  v_base_price numeric := NULL;
  v_credited numeric := NULL;
  v_price numeric := NULL;
  v_amount numeric := 0;
  v_receipt_id uuid := NULL;
  v_receipt_no integer;
  v_user_name text;
BEGIN
  IF p_company_id IS NULL OR p_intake_id IS NULL
     OR p_lab IS NULL OR jsonb_typeof(p_lab) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_in
  FROM public.prod_milk_intakes
  WHERE id = p_intake_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_in.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_in.status <> 'weighed' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_fat := public.prod_jnum(p_lab, 'fat_pct', 3);
  v_protein := public.prod_jnum(p_lab, 'protein_pct', 3);
  v_snf := public.prod_jnum(p_lab, 'snf_pct', 3);
  v_density := public.prod_jnum(p_lab, 'density', 4);
  v_acidity := public.prod_jnum(p_lab, 'acidity', 1);
  v_temperature := public.prod_jnum(p_lab, 'temperature', 1);
  v_antibiotic := public.prod_jtext(p_lab, 'antibiotic', 20);
  v_decision := public.prod_jtext(p_lab, 'decision', 20);
  v_override := public.prod_jnum(p_lab, 'price_per_kg_override', 2);
  v_decision_note := public.prod_jtext(p_lab, 'decision_note', 500);

  IF (v_fat IS NOT NULL AND v_fat NOT BETWEEN 0 AND 100)
     OR (v_protein IS NOT NULL AND v_protein NOT BETWEEN 0 AND 100)
     OR (v_snf IS NOT NULL AND v_snf NOT BETWEEN 0 AND 100)
     OR (v_density IS NOT NULL AND v_density NOT BETWEEN 0.5 AND 2)
     OR (v_acidity IS NOT NULL AND v_acidity NOT BETWEEN 0 AND 999.9)
     OR (v_temperature IS NOT NULL AND v_temperature NOT BETWEEN -100 AND 100)
     OR (v_antibiotic IS NOT NULL AND v_antibiotic NOT IN ('negative', 'positive', 'not_tested'))
     OR v_decision IS NULL OR v_decision NOT IN ('accepted', 'conditional', 'rejected') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_density := COALESCE(v_density, v_in.density);
  v_volume := CASE WHEN v_density IS NOT NULL THEN round(v_in.net_kg / v_density, 3) ELSE v_in.volume_l END;

  IF v_decision IN ('accepted', 'conditional') THEN
    SELECT s.is_active, s.name, s.milk_price_per_kg
    INTO v_sup_active, v_sup_name, v_sup_price
    FROM public.prod_suppliers s
    WHERE s.id = v_in.supplier_id AND s.company_id = p_company_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_sup_active THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    PERFORM public.prod_require_warehouse(p_company_id, v_in.warehouse_id);

    SELECT is_active INTO v_item_active
    FROM public.prod_items
    WHERE id = v_in.item_id AND company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_item_active THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    IF v_decision = 'accepted' THEN
      SELECT pricing_mode, base_fat, base_protein, default_price_per_kg
      INTO v_mode, v_base_fat, v_base_protein, v_default_price
      FROM public.prod_milk_settings
      WHERE company_id = p_company_id;
      IF NOT FOUND THEN
        v_mode := 'fat';
        v_base_fat := 3.4;
        v_base_protein := 3.0;
        v_default_price := 0;
      END IF;

      v_pricing_mode := v_mode;
      v_base_price := COALESCE(v_sup_price, v_default_price);

      IF v_mode = 'flat' THEN
        v_credited := v_in.net_kg;
      ELSIF v_mode = 'fat' THEN
        IF v_fat IS NULL THEN
          RAISE EXCEPTION 'invalid_input';
        END IF;
        v_credited := round(v_in.net_kg * v_fat / v_base_fat, 3);
      ELSE
        IF v_fat IS NULL OR v_protein IS NULL THEN
          RAISE EXCEPTION 'invalid_input';
        END IF;
        v_credited := round(v_in.net_kg * ((v_fat / v_base_fat) + (v_protein / v_base_protein)) / 2, 3);
      END IF;

      IF v_credited >= 1e11 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      v_amount := round(v_credited * v_base_price, 2);
      IF v_amount >= 1e12 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      v_price := round(v_amount / v_in.net_kg, 2);
      IF v_price >= 1e12 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
    ELSE
      IF v_override IS NULL OR v_override < 0 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      v_credited := v_in.net_kg;
      v_price := v_override;
      v_amount := round(v_in.net_kg * v_override, 2);
      IF v_amount >= 1e12 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('prod_receipt_no:' || p_company_id::text, 0));
    SELECT COALESCE(max(number), 0) + 1 INTO v_receipt_no
    FROM public.prod_receipts WHERE company_id = p_company_id;

    SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

    INSERT INTO public.prod_receipts (
      company_id, number, doc_date, warehouse_id, supplier_id, supplier_name, note, total,
      status, created_by, created_by_name
    ) VALUES (
      p_company_id, v_receipt_no, v_in.intake_date, v_in.warehouse_id, v_in.supplier_id, v_sup_name,
      'Sut qabuli #' || v_in.number::text, v_amount,
      'posted', auth.uid(), v_user_name
    )
    RETURNING id INTO v_receipt_id;

    INSERT INTO public.prod_receipt_items (company_id, receipt_id, item_id, qty, price, total)
    VALUES (p_company_id, v_receipt_id, v_in.item_id, v_in.net_kg, v_price, v_amount);

    -- NEW: one lot with the lab quality and the supplier.
    PERFORM public.prod_add_lot(
      p_company_id, v_in.warehouse_id, v_in.item_id, v_in.net_kg, v_price,
      v_fat, v_protein, v_in.supplier_id, 'receipt', v_receipt_id, NULL,
      public.prod_lot_expiry(p_company_id, v_in.item_id, v_in.intake_date),
      v_in.intake_date, NULL
    );
  ELSE
    SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();
  END IF;

  UPDATE public.prod_milk_intakes
  SET fat_pct = v_fat,
      protein_pct = v_protein,
      snf_pct = v_snf,
      density = v_density,
      volume_l = v_volume,
      acidity = v_acidity,
      temperature = v_temperature,
      antibiotic = v_antibiotic,
      status = v_decision,
      pricing_mode = v_pricing_mode,
      base_price_per_kg = v_base_price,
      credited_kg = v_credited,
      price_per_kg = v_price,
      amount = v_amount,
      receipt_id = v_receipt_id,
      decision_note = v_decision_note,
      lab_by = auth.uid(),
      lab_by_name = v_user_name,
      lab_at = now()
  WHERE id = p_intake_id AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'status', v_decision,
    'credited_kg', v_credited,
    'price_per_kg', v_price,
    'amount', v_amount,
    'receipt_id', v_receipt_id
  );
END;
$$;

-- ═══ prod_cancel_receipt_internal (internal, replaced, same signature) ═══
-- receipt row FOR UPDATE -> prod_reverse_document (stock keys in global
-- order, per-lot check, 1:1 mirror) -> mark cancelled.
-- Permission / role checks are the CALLER's job (prod_cancel_milk_intake).
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

  PERFORM public.prod_reverse_document(p_company_id, 'receipt', p_receipt_id);

  UPDATE public.prod_receipts
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_receipt_id AND company_id = p_company_id;
END;
$$;

-- ═══ prod_create_production (replaced, same signature) ═══════════════════
-- Body copied from 20261110000009. Changes:
--   * components[i].lots optional [{lot_id, qty}] -> prod_consume (else FEFO).
--   * component unit_cost = round(line cost / qty, 2), total = exact lot cost;
--     total_cost = sum of line totals; output unit_cost = round(total / qty, 2).
--   * output = one lot in output_warehouse_id, expiry = doc business date +
--     output item shelf life, received_at = doc_date.
--   * the document id is generated first so the consumption rows can be
--     written before the header (doc_id has no FK).
--   Locks: components (source warehouse, item order) -> 'prod_production_no'
--   -> 'prod_lot_no'.
-- p_data: { doc_date, warehouse_id, output_warehouse_id, output_item_id,
--           output_qty, note, recipe_id,
--           components: [{ item_id, qty, planned_qty, lots }] }
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

  IF v_recipe_id IS NOT NULL THEN
    SELECT item_id, version INTO v_recipe_item_id, v_recipe_version
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
       OR v_item_id = v_output_item_id
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

  -- Stock locks (sorted; source warehouse only), then consume under them.
  PERFORM public.prod_lock_stock(v_company_id, v_warehouse_id, v_item_ids);

  v_id := gen_random_uuid();

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i],
                                 'production', v_id, v_picks[i]);
    v_line_cost := (v_res->>'cost')::numeric;
    v_totals := v_totals || v_line_cost;
    v_costs := v_costs || round(v_line_cost / v_qtys[i], 2);
    v_total_cost := v_total_cost + v_line_cost;
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
    id, company_id, number, doc_date, warehouse_id, output_warehouse_id, output_item_id, output_qty,
    total_cost, unit_cost, note, status, created_by, created_by_name,
    recipe_id, recipe_version
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_warehouse_id, v_output_item_id, v_output_qty,
    v_total_cost, v_unit_cost, v_note, 'posted', auth.uid(), v_user_name,
    v_recipe_id, v_recipe_version
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_production_components (
      company_id, production_id, item_id, qty, unit_cost, total, planned_qty
    ) VALUES (
      v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], v_totals[i], v_planned[i]
    );
  END LOOP;

  PERFORM public.prod_add_lot(
    v_company_id, v_output_warehouse_id, v_output_item_id, v_output_qty, v_unit_cost,
    NULL, NULL, NULL, 'production', v_id, NULL,
    public.prod_lot_expiry(v_company_id, v_output_item_id, v_doc_date),
    v_doc_date, NULL
  );

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'total_cost', v_total_cost, 'unit_cost', v_unit_cost
  );
END;
$$;

-- ═══ prod_create_processing (replaced, same signature) ═══════════════════
-- Body copied from 20261110000009. Changes:
--   * optional source_lots [{lot_id, qty}] -> prod_consume (else FEFO).
--   * processing_cost = exact lot cost, source_unit_cost = round(cost/qty, 2).
--   * every output = one lot (unit_cost = valuation price, expiry from
--     shelf life, received_at = doc_date) in output_warehouse_id.
--   Locks: source key -> 'prod_processing_no' -> 'prod_lot_no'.
-- p_data: { doc_date, warehouse_id, output_warehouse_id, source_item_id,
--           source_qty, source_lots, note, outputs: [{ item_id, qty, price }] }
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
  v_res jsonb;
  v_source_unit_cost numeric;
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

  PERFORM public.prod_lock_stock(v_company_id, v_warehouse_id, ARRAY[v_source_item_id]);

  v_id := gen_random_uuid();
  v_res := public.prod_consume(v_company_id, v_warehouse_id, v_source_item_id, v_source_qty,
                               'processing', v_id, p_data->'source_lots');
  v_processing_cost := (v_res->>'cost')::numeric;
  v_source_unit_cost := round(v_processing_cost / v_source_qty, 2);
  v_profit := v_recovery - v_processing_cost;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_processing_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_processings WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_processings (
    id, company_id, number, doc_date, warehouse_id, output_warehouse_id, source_item_id, source_qty,
    source_unit_cost, processing_cost, recovery_cost, profit, note, status,
    created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_warehouse_id, v_source_item_id, v_source_qty,
    v_source_unit_cost, v_processing_cost, v_recovery, v_profit, v_note, 'posted',
    auth.uid(), v_user_name
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_processing_outputs (company_id, processing_id, item_id, qty, price, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_prices[i], round(v_qtys[i] * v_prices[i], 2));

    PERFORM public.prod_add_lot(
      v_company_id, v_output_warehouse_id, v_item_ids[i], v_qtys[i], v_prices[i],
      NULL, NULL, NULL, 'processing', v_id, NULL,
      public.prod_lot_expiry(v_company_id, v_item_ids[i], v_doc_date),
      v_doc_date, NULL
    );
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number,
    'processing_cost', v_processing_cost, 'recovery_cost', v_recovery, 'profit', v_profit
  );
END;
$$;

-- ═══ prod_create_transfer (replaced, same signature) ═════════════════════
-- Body copied from 20261110000009. Changes:
--   * items[i].lots optional [{lot_id, qty}] -> prod_consume at the source
--     (else FEFO).
--   * for EACH consumed source lot a destination lot with the SAME
--     unit_cost, fat, protein, supplier, expiry, received_at (FIFO age kept),
--     origin_lot_id = source lot. Value moves exactly.
--   * line unit_cost = round(line cost / qty, 2), line total = exact cost,
--     document total = sum of line totals.
--   Locks: (item, from) and (item, to) for every line in global
--   (item_id, warehouse_id) order -> 'prod_transfer_no' -> 'prod_lot_no'.
-- p_data: { doc_date, from_warehouse_id, to_warehouse_id, note,
--           items: [{ item_id, qty, lots }] }
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
  v_totals numeric[] := '{}';
  v_picks jsonb[] := '{}';
  v_results jsonb[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_rec record;
  v_res jsonb;
  v_used jsonb;
  v_src record;
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
                                 'transfer', v_id, v_picks[i]);
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
      SELECT l.id, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id, l.expiry_date, l.received_at
      INTO v_src
      FROM public.prod_lots l
      WHERE l.id = (v_used->>'lot_id')::uuid AND l.company_id = v_company_id;

      PERFORM public.prod_add_lot(
        v_company_id, v_to_id, v_item_ids[i], (v_used->>'qty')::numeric, v_src.unit_cost,
        v_src.fat_pct, v_src.protein_pct, v_src.supplier_id, 'transfer', v_id, v_src.id,
        v_src.expiry_date, v_src.received_at, NULL
      );
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total);
END;
$$;

-- ═══ prod_create_separation (replaced, same signature) ═══════════════════
-- Body copied from 20261110000012. Changes:
--   * optional milk_lots [{lot_id, qty}] -> prod_consume (else FEFO).
--   * milk_cost = exact cost of the consumed lots.
--   * milk_fat: explicit p_data.milk_fat wins (today's behaviour); else the
--     consumed lots' qty-weighted fat (was: pool average).
--   * cream / skim = one lot each (fat = cream_fat / skim_fat, expiry from
--     shelf life, received_at = doc_date).
--   * the milk is consumed (validation: insufficient_stock / pick errors)
--     before the fat / allocation checks, which raise invalid_input as
--     before; any error rolls the whole call back.
--   Locks: milk key -> 'prod_separation_no' -> 'prod_lot_no'.
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
  v_res jsonb;
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

  -- Stock lock, then consume the milk lots (FEFO or picked).
  PERFORM public.prod_lock_stock(v_company_id, v_wh, ARRAY[v_milk]);
  v_id := gen_random_uuid();
  v_res := public.prod_consume(v_company_id, v_wh, v_milk, v_milk_qty, 'separation', v_id, p_data->'milk_lots');

  IF v_milk_fat IS NULL THEN
    v_milk_fat := (v_res->>'fat_pct')::numeric;
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

  -- Cost allocation of the exact milk lot cost
  v_milk_cost := (v_res->>'cost')::numeric;
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

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_separation_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_separations WHERE company_id = v_company_id;
  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_separations (
    id, company_id, number, doc_date, warehouse_id, output_warehouse_id, milk_item_id, cream_item_id, skim_item_id,
    milk_qty, milk_fat, cream_fat, skim_fat, loss_pct, cream_qty_calc, skim_qty_calc, cream_qty, skim_qty, loss_qty,
    allocation_method, skim_price, cream_ref_price, skim_ref_price, milk_cost, cream_unit_cost, skim_unit_cost,
    note, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_date, v_wh, v_out_wh, v_milk, v_cream, v_skim,
    v_milk_qty, v_milk_fat, v_cream_fat, v_skim_fat, v_loss_pct, v_cream_calc, v_skim_calc, v_cream_qty, v_skim_qty, v_loss,
    v_method,
    CASE WHEN v_method = 'skim_price' THEN v_skim_price END,
    CASE WHEN v_method = 'value' THEN v_cream_ref END,
    CASE WHEN v_method = 'value' THEN v_skim_ref END,
    v_milk_cost, v_cream_cost, v_skim_cost,
    v_note, 'posted', auth.uid(), v_user_name
  );

  PERFORM public.prod_add_lot(
    v_company_id, v_out_wh, v_cream, v_cream_qty, v_cream_cost,
    v_cream_fat, NULL, NULL, 'separation', v_id, NULL,
    public.prod_lot_expiry(v_company_id, v_cream, v_date), v_date, NULL
  );
  PERFORM public.prod_add_lot(
    v_company_id, v_out_wh, v_skim, v_skim_qty, v_skim_cost,
    v_skim_fat, NULL, NULL, 'separation', v_id, NULL,
    public.prod_lot_expiry(v_company_id, v_skim, v_date), v_date, NULL
  );

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'cream_qty', v_cream_qty, 'skim_qty', v_skim_qty, 'loss_qty', v_loss,
    'cream_unit_cost', v_cream_cost, 'skim_unit_cost', v_skim_cost
  );
END;
$$;

-- ═══ prod_change_item_unit (replaced, same signature) ════════════════════
-- Body copied from 20261110000011. Ledger part now per lot: for every lot of
-- the item with remaining <> 0 (any warehouse): outflow of the remaining
-- from the old lot + a NEW lot qty = round(rem * factor, 3), unit_cost =
-- round(unit_cost / factor, 2), same fat / protein / supplier / expiry /
-- received_at, origin_lot_id = old lot. A lot with negative remaining
-- blocks the conversion (insufficient_stock), as negative stock did before.
--   Locks: item row FOR UPDATE -> stock keys (one item, ascending
--   warehouse id = global order) -> 'prod_lot_no'.
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
  v_new_qty numeric;
  v_new_cost numeric;
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

  -- Stock locks: every warehouse holding a lot of the item, ascending id.
  FOR v_wh IN
    SELECT DISTINCT l.warehouse_id
    FROM public.prod_lots l
    WHERE l.company_id = v_company_id AND l.item_id = p_item_id
    ORDER BY l.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(v_company_id, v_wh.warehouse_id, ARRAY[p_item_id]);
  END LOOP;

  -- Cursor snapshot taken at loop start: the new lots are not revisited.
  FOR v_lot IN
    SELECT x.*
    FROM (
      SELECT l.id, l.warehouse_id, l.lot_no, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id,
             l.expiry_date, l.received_at,
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

    PERFORM public.prod_add_lot(
      v_company_id, v_lot.warehouse_id, p_item_id, v_new_qty, v_new_cost,
      v_lot.fat_pct, v_lot.protein_pct, v_lot.supplier_id, 'conversion', v_conv_id, v_lot.id,
      v_lot.expiry_date, v_lot.received_at, NULL
    );
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
-- Body copied from 20261110000012 (latest). Permission / role / row lock /
-- already_cancelled / milk-intake guard unchanged; the lock + check + mirror
-- part is now prod_reverse_document (same stock-key order, per-LOT check).
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

  IF p_doc_type = 'receipt' AND EXISTS (
    SELECT 1 FROM public.prod_milk_intakes
    WHERE company_id = v_company_id AND receipt_id = p_id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'invalid_input';
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
  ELSE
    UPDATE public.prod_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated. Internal ones (milk lab,
-- receipt cancel) stay closed to every client role.

REVOKE EXECUTE ON FUNCTION public.prod_milk_apply_lab(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_receipt_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.prod_save_item(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_production(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_processing(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_separation(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_change_item_unit(uuid, text, numeric, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_item(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_production(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_processing(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_separation(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_change_item_unit(uuid, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy, only authenticated/SELECT grants:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.oid = 'public.prod_lots'::regclass GROUP BY 1, 2;
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_lots', 'prod_lot_stock', 'prod_stock', 'prod_stock_quality');
-- -- helpers not executable by clients (expect all false):
-- SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE')
-- FROM pg_proc p WHERE p.proname IN ('prod_lot_remaining', 'prod_lot_expiry', 'prod_next_lot_no',
--   'prod_add_lot', 'prod_consume', 'prod_reverse_document');
-- -- every lot ledger row carries its lot's cost / fat / protein (expect 0):
-- SELECT count(*) FROM public.prod_stock_movements m JOIN public.prod_lots l ON l.id = m.lot_id
-- WHERE m.unit_cost <> l.unit_cost OR m.fat_pct IS DISTINCT FROM l.fat_pct
--    OR m.protein_pct IS DISTINCT FROM l.protein_pct;
-- -- totals: sum of lots = prod_stock (expect 0 rows):
-- SELECT s.* FROM public.prod_stock s
-- WHERE s.qty <> (SELECT sum(remaining_qty) FROM public.prod_lot_stock ls
--                 WHERE ls.warehouse_id = s.warehouse_id AND ls.item_id = s.item_id);
