-- Production: Sut qabuli (raw milk intake).
--
-- Why: a dairy plant receives raw milk truck by truck: WEIGHING (gross /
-- tare -> net kg, litres = net / density) -> LAB (fat, protein, SNF,
-- density, acidity, temperature, antibiotic) -> DECISION (accepted /
-- conditional / rejected). Accepted milk goes into stock and the supplier is
-- owed money, usually by "credited (zachet) mass" = net * fat / base_fat.
-- The FAT % of the milk must follow the stock (separation, the next module,
-- needs the average fat of the milk in a warehouse).
--
-- This file adds:
--   1) public.prod_milk_settings            - per-company intake settings
--   2) prod_suppliers.milk_price_per_kg     - per-supplier base milk price
--   3) prod_stock_movements.fat_pct /
--      protein_pct + BEFORE INSERT trigger  - quality follows the stock
--      public.prod_stock_quality (view)     - avg fat / protein per stock key
--   4) public.prod_milk_intakes             - the intake documents
--   5) RLS + grants                         - identical model to file 3
--   6) has_permission                       - new fail-closed keys
--                                             'prod_milk', 'prod_lab'
--   7) RPCs: prod_save_milk_settings (new), prod_create_milk_intake (new),
--            prod_record_milk_lab (new), prod_cancel_milk_intake (new),
--            prod_save_supplier   (replaced, same signature, + milk price),
--            prod_cancel_document (replaced, same signature, + guard)
--
-- Retail is untouched: no retail table or function is changed. has_permission
-- only gains two prod_* keys, which retail firms without the production
-- module still get false for. Every existing production RPC keeps its exact
-- behaviour; the only visible differences are
--   * prod_save_supplier accepts an OPTIONAL milk_price_per_kg (an absent key
--     leaves the stored value unchanged, so old clients cannot wipe it);
--   * prod_cancel_document('receipt', id) refuses ('invalid_input') a receipt
--     that was posted by a NOT-cancelled milk intake: such a receipt must be
--     cancelled through prod_cancel_milk_intake, otherwise the intake would
--     still say "accepted" while its stock and debt are gone. Receipts not
--     linked to an intake (every receipt that exists today) are unaffected.
--
-- Access model (same as 20261110000003_production_core.sql):
--   * company_id NOT NULL -> companies ON DELETE CASCADE.
--   * RLS on, ONE SELECT policy company-scoped via (SELECT get_company_id()).
--   * REVOKE ALL from authenticated + anon (closes Supabase default-grant
--     leak), GRANT SELECT to authenticated only. Writes ONLY via the
--     SECURITY DEFINER RPCs below (RPC-only write access, RLS-only read).
--
-- Error codes (unchanged contract, productionErrors.*): forbidden,
-- wrong_business_type, not_found, invalid_input, insufficient_stock (item id
-- in DETAIL), already_cancelled.
--
-- ── Quality trigger (prod_stock_movements_quality) per existing writer ─────
-- Rule order (first match wins):
--   R0 fat_pct or protein_pct given explicitly  -> kept as given.
--   R1 is_reversal                              -> copy fat/protein from the
--      original (non-reversal) row of the same doc_type/doc_id/warehouse/item.
--   R2 qty < 0                                  -> current weighted average of
--      that (company, warehouse, item): sum(qty*fat)/sum(qty) over rows with a
--      non-NULL value (fat and protein independently); NULL if none.
--   R3 qty > 0 AND doc_type = 'transfer'        -> copy from the matching
--      negative (source) row of the same transfer + item; if that row is not
--      inserted yet, compute R2 on the transfer's from_warehouse_id instead.
--   R4 otherwise                                -> NULL (left as is).
-- Writers (none of them sets fat_pct / protein_pct, so R0 never hits them):
--   * prod_create_receipt: +qty rows -> R4, NULL (a free receipt carries no
--     lab data). Milk intake receipts set fat/protein explicitly -> R0.
--   * prod_create_production: components -qty -> R2 (fat leaves the source
--     pool at its average, so the pool's average is unchanged - exactly like
--     average cost); output +qty -> R4, NULL. The output item is never a
--     component, so its row never interacts with the component rows.
--   * prod_create_processing: source -qty -> R2; outputs +qty -> R4 (the
--     separation module will write explicit values -> R0).
--   * prod_create_transfer: inserts (from, -qty), (to, +qty) per item in ONE
--     multi-row VALUES. PostgreSQL does not promise the per-row processing
--     order, so R3 does not depend on it: if the -qty row is visible it is
--     copied exactly; otherwise the +qty row computes R2 on the source
--     warehouse, which is the very value the -qty row will get (from <> to is
--     a CHECK, so the +qty row cannot change the source pool, and the source
--     key is locked by the transfer). Both orders give the same result.
--   * prod_cancel_document / prod_cancel_receipt_internal: INSERT ... SELECT
--     of mirror rows with is_reversal = true -> R1. Every document has at
--     most one original row per (doc_type, doc_id, warehouse, item) (receipt
--     lines / components / outputs / transfer lines are distinct per item,
--     output <> components, source <> outputs, from <> to), so the copy is
--     unambiguous; ORDER BY created_at, id LIMIT 1 keeps it deterministic
--     anyway. R1 is checked BEFORE R2 so a receipt reversal (-qty) removes
--     the milk at ITS OWN fat, not at the pool average - an exact undo.
-- Concurrency: R2 runs inside writers that already hold the stock advisory
-- lock of that key (production components, processing source, transfer
-- from/to, cancel locks every key of the document), and the trigger's
-- queries take a fresh snapshot (VOLATILE plpgsql, READ COMMITTED), the same
-- guarantee prod_current_stock relies on for average cost.
-- Safety: the derived average is only stored when the tracked quantity is
-- > 0 and the result lies in [0, 100]; otherwise NULL. It can therefore never
-- raise (no division by zero, no numeric(6,3) overflow) and can never break
-- an existing writer. CHECK constraints keep explicit values in [0, 100].
-- Known limitation (documented, by spec): untracked inflows of the SAME item
-- (a plain prod_create_receipt of the milk item, fat NULL) are not part of
-- the tracked pool, but outflows are charged against it; the average then
-- becomes approximate (or NULL once the tracked pool is exhausted). Receive
-- raw milk only through Sut qabuli to keep it exact.
--
-- ── Pricing (prod_record_milk_lab, decision 'accepted') ────────────────────
--   base         = supplier.milk_price_per_kg ?? settings.default_price_per_kg
--   credited_kg  = flat:        net_kg
--                  fat:         round(net_kg * fat / base_fat, 3)
--                  fat_protein: round(net_kg * (fat/base_fat + protein/base_protein) / 2, 3)
--   amount       = round(credited_kg * base, 2)       (credited_kg as stored)
--   price_per_kg = round(amount / net_kg, 2)          (per PHYSICAL kg)
-- 'conditional': credited_kg = net_kg, price_per_kg = override,
--                amount = round(net_kg * override, 2).
-- 'rejected':    no stock, no receipt, amount = 0, credited/price NULL.
-- The posted receipt has ONE line (item, qty = net_kg, price = price_per_kg)
-- and line total = receipt total = amount, so the supplier debt in
-- prod_supplier_balances equals the intake amount exactly (the line total
-- may differ from round(qty * price, 2) by < net_kg * 0.005 because
-- price_per_kg is rounded; stock is valued at price_per_kg).
--
-- ── Lock order (deadlock safety) ───────────────────────────────────────────
--   prod_create_milk_intake: supplier row FOR SHARE -> 'prod_milk_intake_no'
--     -> (lab) 'prod_receipt_no'.
--   prod_record_milk_lab:    intake row FOR UPDATE -> supplier row FOR SHARE
--     -> 'prod_receipt_no'.
--   prod_cancel_milk_intake: intake row FOR UPDATE -> receipt row FOR UPDATE
--     -> stock keys in global (item_id, warehouse_id) order.
--   prod_cancel_document:    receipt row FOR UPDATE -> (reads intake, no
--     lock) -> stock keys (unchanged order).
--   prod_create_receipt:     supplier FOR SHARE -> 'prod_receipt_no' (unchanged).
--   No function takes 'prod_receipt_no' before 'prod_milk_intake_no', none
--   takes an intake row after a receipt row, and inflows take no stock lock
--   (same as receipts). No cycle is possible.
--
-- Destructive statements: NONE. Only CREATE TABLE / VIEW / INDEX, ADD COLUMN
-- NULL without default (metadata-only, the append-only trigger is not hit
-- because no row is updated), ADD CONSTRAINT CHECK on columns that are NULL
-- for every existing row, CREATE TRIGGER, CREATE OR REPLACE FUNCTION.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) prod_milk_settings ────────────────────────────────────────────────
-- One row per company (company_id is the PK). Missing row = column defaults
-- (the RPCs fall back to the same literal defaults). milk_item_id /
-- default_warehouse_id: MATCH SIMPLE composite FKs, NULL = not configured.

CREATE TABLE public.prod_milk_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  milk_item_id uuid NULL,
  default_warehouse_id uuid NULL,
  base_fat numeric(5,2) NOT NULL DEFAULT 3.4,
  base_protein numeric(5,2) NOT NULL DEFAULT 3.0,
  pricing_mode text NOT NULL DEFAULT 'fat',
  default_price_per_kg numeric(14,2) NOT NULL DEFAULT 0,
  default_density numeric(6,4) NOT NULL DEFAULT 1.030,
  min_fat numeric(5,2) NOT NULL DEFAULT 2.8,
  min_density numeric(6,4) NOT NULL DEFAULT 1.027,
  max_acidity numeric(5,1) NOT NULL DEFAULT 19,
  max_temperature numeric(5,1) NOT NULL DEFAULT 10,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_milk_settings_item_fk FOREIGN KEY (milk_item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_milk_settings_warehouse_fk FOREIGN KEY (default_warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_milk_settings_pricing_mode_check CHECK (pricing_mode IN ('flat', 'fat', 'fat_protein')),
  CONSTRAINT prod_milk_settings_base_fat_check CHECK (base_fat > 0 AND base_fat <= 100),
  CONSTRAINT prod_milk_settings_base_protein_check CHECK (base_protein > 0 AND base_protein <= 100),
  CONSTRAINT prod_milk_settings_price_check CHECK (default_price_per_kg >= 0),
  CONSTRAINT prod_milk_settings_density_check CHECK (default_density BETWEEN 0.5 AND 2),
  CONSTRAINT prod_milk_settings_min_fat_check CHECK (min_fat BETWEEN 0 AND 100),
  CONSTRAINT prod_milk_settings_min_density_check CHECK (min_density BETWEEN 0.5 AND 2),
  CONSTRAINT prod_milk_settings_max_acidity_check CHECK (max_acidity BETWEEN 0 AND 999.9),
  CONSTRAINT prod_milk_settings_max_temperature_check CHECK (max_temperature BETWEEN -100 AND 100)
);

COMMENT ON TABLE public.prod_milk_settings IS
  'Raw milk intake settings (one row per company). Read via RLS (company-scoped SELECT); '
  'write ONLY via prod_save_milk_settings.';

-- ─── 2) prod_suppliers.milk_price_per_kg ──────────────────────────────────
-- Per-supplier base price per credited kg; NULL = settings default.

ALTER TABLE public.prod_suppliers
  ADD COLUMN milk_price_per_kg numeric(14,2) NULL;

ALTER TABLE public.prod_suppliers
  ADD CONSTRAINT prod_suppliers_milk_price_check
    CHECK (milk_price_per_kg IS NULL OR milk_price_per_kg >= 0);

-- ─── 3) Ledger quality columns + trigger + view ───────────────────────────

ALTER TABLE public.prod_stock_movements
  ADD COLUMN fat_pct numeric(6,3) NULL;

ALTER TABLE public.prod_stock_movements
  ADD COLUMN protein_pct numeric(6,3) NULL;

ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_fat_check
    CHECK (fat_pct IS NULL OR fat_pct BETWEEN 0 AND 100);

ALTER TABLE public.prod_stock_movements
  ADD CONSTRAINT prod_stock_movements_protein_check
    CHECK (protein_pct IS NULL OR protein_pct BETWEEN 0 AND 100);

-- Internal: weighted average fat / protein of one stock key, computed with
-- the SAME formula as the prod_stock_quality view (tracked qty > 0, result
-- rounded to 3 decimals, kept only within [0, 100], else NULL).
-- VOLATILE: must see rows inserted earlier in the same transaction/statement.
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
  SELECT sum(m.qty) FILTER (WHERE m.fat_pct IS NOT NULL),
         sum(m.qty * m.fat_pct),
         sum(m.qty) FILTER (WHERE m.protein_pct IS NOT NULL),
         sum(m.qty * m.protein_pct)
  INTO v_fat_qty, v_fat_sum, v_pro_qty, v_pro_sum
  FROM public.prod_stock_movements m
  WHERE m.company_id = p_company_id
    AND m.warehouse_id = p_warehouse_id
    AND m.item_id = p_item_id;

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

REVOKE EXECUTE ON FUNCTION public.prod_stock_quality_at(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Trigger function: rules R0..R4, see header. SECURITY INVOKER (like
-- prod_stock_movements_append_only): every writer is a SECURITY DEFINER RPC
-- running as the table owner, or the service role. All lookups are scoped
-- by NEW.company_id. Never raises.
CREATE OR REPLACE FUNCTION public.prod_stock_movements_quality()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_q record;
  v_from uuid;
BEGIN
  -- R0: explicit values are kept (milk intake receipts, future separation).
  IF NEW.fat_pct IS NOT NULL OR NEW.protein_pct IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- R1: reversal mirrors the original row of the same document key.
  -- No original found -> SELECT INTO sets NULLs.
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

  -- R3: transfer inflow follows its source row (order-independent).
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

REVOKE EXECUTE ON FUNCTION public.prod_stock_movements_quality() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prod_stock_movements_quality
  BEFORE INSERT ON public.prod_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.prod_stock_movements_quality();

-- prod_stock_quality: same grouping as prod_stock; avg_* use exactly the
-- formula of prod_stock_quality_at (nested CASE: no division unless the
-- tracked qty is > 0). security_invoker: caller's RLS applies.
CREATE VIEW public.prod_stock_quality
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
    m.company_id,
    m.warehouse_id,
    m.item_id,
    sum(m.qty) AS qty,
    sum(m.qty) FILTER (WHERE m.fat_pct IS NOT NULL) AS fat_qty,
    sum(m.qty * m.fat_pct) AS fat_sum,
    sum(m.qty) FILTER (WHERE m.protein_pct IS NOT NULL) AS pro_qty,
    sum(m.qty * m.protein_pct) AS pro_sum
  FROM public.prod_stock_movements m
  GROUP BY m.company_id, m.warehouse_id, m.item_id
) s;

COMMENT ON VIEW public.prod_stock_quality IS
  'Per (company, warehouse, item): qty = sum of the ledger, avg_fat / avg_protein = '
  'sum(qty*value)/sum(qty) over movements with a non-NULL value (NULL when none, '
  'when that tracked qty <= 0 or when the result is outside 0..100).';

-- ─── 4) prod_milk_intakes ─────────────────────────────────────────────────
-- Lifecycle: weighed -> accepted | conditional | rejected (lab decision,
-- once) ; any of them -> cancelled. accepted / conditional always have the
-- posted receipt (receipt_id); after cancel the receipt link is kept (the
-- receipt is then cancelled too).

CREATE TABLE public.prod_milk_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  intake_date timestamptz NOT NULL DEFAULT now(),
  supplier_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  item_id uuid NOT NULL,
  vehicle_no text NULL,
  driver text NULL,
  gross_kg numeric(14,3) NOT NULL,
  tare_kg numeric(14,3) NOT NULL DEFAULT 0,
  net_kg numeric(14,3) NOT NULL,
  density numeric(6,4) NULL,
  volume_l numeric(14,3) NULL,
  fat_pct numeric(6,3) NULL,
  protein_pct numeric(6,3) NULL,
  snf_pct numeric(6,3) NULL,
  acidity numeric(5,1) NULL,
  temperature numeric(5,1) NULL,
  antibiotic text NULL,
  status text NOT NULL DEFAULT 'weighed',
  pricing_mode text NULL,
  base_price_per_kg numeric(14,2) NULL,
  credited_kg numeric(14,3) NULL,
  price_per_kg numeric(14,2) NULL,
  amount numeric(14,2) NULL,
  receipt_id uuid NULL,
  decision_note text NULL,
  note text NULL,
  lab_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  lab_by_name text NULL,
  lab_at timestamptz NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_milk_intakes_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_milk_intakes_id_company_key UNIQUE (id, company_id),
  -- One intake per receipt (NULLs do not collide).
  CONSTRAINT prod_milk_intakes_receipt_key UNIQUE (receipt_id),
  CONSTRAINT prod_milk_intakes_supplier_fk FOREIGN KEY (supplier_id, company_id)
    REFERENCES public.prod_suppliers (id, company_id),
  CONSTRAINT prod_milk_intakes_warehouse_fk FOREIGN KEY (warehouse_id, company_id)
    REFERENCES public.prod_warehouses (id, company_id),
  CONSTRAINT prod_milk_intakes_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_milk_intakes_receipt_fk FOREIGN KEY (receipt_id, company_id)
    REFERENCES public.prod_receipts (id, company_id),
  CONSTRAINT prod_milk_intakes_number_check CHECK (number > 0),
  CONSTRAINT prod_milk_intakes_gross_check CHECK (gross_kg >= 0),
  CONSTRAINT prod_milk_intakes_tare_check CHECK (tare_kg >= 0),
  CONSTRAINT prod_milk_intakes_net_check CHECK (net_kg > 0 AND net_kg = gross_kg - tare_kg),
  CONSTRAINT prod_milk_intakes_density_check CHECK (density IS NULL OR density BETWEEN 0.5 AND 2),
  CONSTRAINT prod_milk_intakes_volume_check CHECK (volume_l IS NULL OR volume_l > 0),
  CONSTRAINT prod_milk_intakes_fat_check CHECK (fat_pct IS NULL OR fat_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_milk_intakes_protein_check CHECK (protein_pct IS NULL OR protein_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_milk_intakes_snf_check CHECK (snf_pct IS NULL OR snf_pct BETWEEN 0 AND 100),
  CONSTRAINT prod_milk_intakes_acidity_check CHECK (acidity IS NULL OR acidity BETWEEN 0 AND 999.9),
  CONSTRAINT prod_milk_intakes_temperature_check CHECK (temperature IS NULL OR temperature BETWEEN -100 AND 100),
  CONSTRAINT prod_milk_intakes_antibiotic_check CHECK (
    antibiotic IS NULL OR antibiotic IN ('negative', 'positive', 'not_tested')
  ),
  CONSTRAINT prod_milk_intakes_status_check CHECK (
    status IN ('weighed', 'accepted', 'conditional', 'rejected', 'cancelled')
  ),
  CONSTRAINT prod_milk_intakes_pricing_mode_check CHECK (
    pricing_mode IS NULL OR pricing_mode IN ('flat', 'fat', 'fat_protein')
  ),
  CONSTRAINT prod_milk_intakes_money_check CHECK (
    (base_price_per_kg IS NULL OR base_price_per_kg >= 0)
    AND (credited_kg IS NULL OR credited_kg >= 0)
    AND (price_per_kg IS NULL OR price_per_kg >= 0)
    AND (amount IS NULL OR amount >= 0)
  ),
  CONSTRAINT prod_milk_intakes_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  -- accepted / conditional are always backed by a receipt; weighed /
  -- rejected never are.
  CONSTRAINT prod_milk_intakes_receipt_status_check CHECK (
    (status IN ('accepted', 'conditional') AND receipt_id IS NOT NULL)
    OR (status IN ('weighed', 'rejected') AND receipt_id IS NULL)
    OR status = 'cancelled'
  ),
  CONSTRAINT prod_milk_intakes_lab_check CHECK (
    status NOT IN ('accepted', 'conditional', 'rejected') OR lab_at IS NOT NULL
  ),
  CONSTRAINT prod_milk_intakes_vehicle_check CHECK (vehicle_no IS NULL OR length(vehicle_no) <= 30),
  CONSTRAINT prod_milk_intakes_driver_check CHECK (driver IS NULL OR length(driver) <= 100),
  CONSTRAINT prod_milk_intakes_decision_note_check CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  CONSTRAINT prod_milk_intakes_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_milk_intakes IS
  'Raw milk intake documents (weighing + lab + decision). Read via RLS (company-scoped SELECT); '
  'write ONLY via prod_create_milk_intake / prod_record_milk_lab / prod_cancel_milk_intake.';

CREATE INDEX prod_milk_intakes_company_date_idx ON public.prod_milk_intakes (company_id, intake_date DESC);
CREATE INDEX prod_milk_intakes_supplier_idx ON public.prod_milk_intakes (supplier_id, company_id);
CREATE INDEX prod_milk_intakes_warehouse_idx ON public.prod_milk_intakes (warehouse_id, company_id);
CREATE INDEX prod_milk_intakes_item_idx ON public.prod_milk_intakes (item_id, company_id);

-- ─── 5) RLS, policies, grants ─────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prod_milk_settings', 'prod_milk_intakes']
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

REVOKE ALL ON public.prod_stock_quality FROM authenticated, anon;
GRANT SELECT ON public.prod_stock_quality TO authenticated;

-- ─── 6) has_permission ────────────────────────────────────────────────────
-- Copied verbatim from 20261110000007. ONLY change: 'prod_milk' and
-- 'prod_lab' added to v_prod_keys (-> production-module gate + fail-closed
-- for non-owners) and to v_valid_keys (whitelist).
CREATE OR REPLACE FUNCTION public.has_permission(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_role text;
  v_permissions jsonb;
  v_business_type text;
  v_prod_keys text[] := ARRAY[
    'prod_catalog', 'prod_production', 'prod_processing',
    'prod_receipts', 'prod_stock', 'prod_supply', 'prod_suppliers',
    'prod_milk', 'prod_lab'
  ];
  v_shared_keys text[] := ARRAY[
    'dashboard', 'xarajatlar', 'hr', 'jamoa', 'sozlamalar'
  ];
  v_valid_keys text[] := ARRAY[
    'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
    'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
    'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
    'reports_moliya', 'reports_foyda', 'reports_sotuvlar', 'reports_mijozlar',
    'reports_yetkazuvchilar', 'reports_kirim', 'reports_spisaniya',
    'reports_xarajatlar', 'reports_inventar',
    'peremeshenie', 'reports_peremeshenie',
    'yetkazuvchilar',
    'prod_catalog', 'prod_production', 'prod_processing',
    'prod_receipts', 'prod_stock', 'prod_supply', 'prod_suppliers',
    'prod_milk', 'prod_lab'
  ];
BEGIN
  IF NOT (p_key = ANY(v_valid_keys)) THEN
    RETURN false;
  END IF;

  SELECT u.role, u.permissions, c.business_type
  INTO v_role, v_permissions, v_business_type
  FROM public.users u
  LEFT JOIN public.companies c ON c.id = u.company_id
  WHERE u.id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Business-type / module gate (before the owner shortcut).
  IF COALESCE(v_business_type, 'retail') = 'production' THEN
    IF NOT (p_key = ANY(v_prod_keys || v_shared_keys)) THEN
      RETURN false;
    END IF;
  ELSE
    IF p_key = ANY(v_prod_keys) AND NOT public.production_enabled() THEN
      RETURN false;
    END IF;
  END IF;

  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  -- prod_* keys: fail closed when not explicitly granted.
  IF p_key = ANY(v_prod_keys) THEN
    IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
      RETURN false;
    END IF;
    RETURN COALESCE((v_permissions->>p_key)::boolean, false);
  END IF;

  -- Retail / shared keys: legacy semantics (missing key = allowed).
  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;

-- ─── 7) Internal helpers (NOT callable by clients) ────────────────────────
-- SECURITY INVOKER with EXECUTE revoked from every client role (same rule
-- as file 4's helpers): they take explicit company ids and run only inside
-- the SECURITY DEFINER RPCs below, after those checked business type,
-- permission and company.

-- Lab step + decision for one intake. PRECONDITION: the caller holds the
-- intake row lock (FOR UPDATE) or inserted the row in this transaction, and
-- has checked has_permission('prod_lab'). Re-checks status = 'weighed'.
-- p_lab: { fat_pct, protein_pct, snf_pct, density, acidity, temperature,
--          antibiotic, decision, price_per_kg_override, decision_note }
-- Returns { status, credited_kg, price_per_kg, amount, receipt_id }.
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

  -- Range checks (the columns are narrower than numeric(14,x)).
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

  -- Lab density replaces the weighing (default) density; litres follow.
  v_density := COALESCE(v_density, v_in.density);
  v_volume := CASE WHEN v_density IS NOT NULL THEN round(v_in.net_kg / v_density, 3) ELSE v_in.volume_l END;

  IF v_decision IN ('accepted', 'conditional') THEN
    -- Posting rules = prod_create_receipt: active supplier (FOR SHARE),
    -- active warehouse, active item.
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
      -- Settings, falling back to the prod_milk_settings column defaults.
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
      -- A tiny net with a large amount could overflow numeric(14,2).
      IF v_price >= 1e12 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
    ELSE
      -- conditional: custom price per physical kg, required.
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

    -- Receipt: same numbering, header, line and ledger movement as
    -- prod_create_receipt (inflow only -> no stock lock; number lock only).
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

    -- Explicit fat/protein -> trigger rule R0 keeps them.
    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
      fat_pct, protein_pct
    ) VALUES (
      p_company_id, v_in.warehouse_id, v_in.item_id, v_in.net_kg, v_price, 'receipt', v_receipt_id, false, auth.uid(),
      v_fat, v_protein
    );
  ELSE
    -- rejected: nothing posted, nothing owed.
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

-- Cancel one posted receipt: the 'receipt' branch of prod_cancel_document
-- (20261110000009), step for step: receipt row FOR UPDATE, stock keys in
-- global (item_id, warehouse_id) order, refuse with insufficient_stock if a
-- key would go negative, mirror every original movement with
-- is_reversal = true (trigger R1 copies fat/protein), mark cancelled.
-- Permission / role checks are the CALLER's job.
CREATE OR REPLACE FUNCTION public.prod_cancel_receipt_internal(p_company_id uuid, p_receipt_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_rec record;
  v_stock record;
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

  FOR v_rec IN
    SELECT DISTINCT m.warehouse_id, m.item_id
    FROM public.prod_stock_movements m
    WHERE m.company_id = p_company_id AND m.doc_type = 'receipt'
      AND m.doc_id = p_receipt_id AND NOT m.is_reversal
    ORDER BY m.item_id, m.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(p_company_id, v_rec.warehouse_id, ARRAY[v_rec.item_id]);
  END LOOP;

  FOR v_rec IN
    SELECT m.warehouse_id, m.item_id, -sum(m.qty) AS delta
    FROM public.prod_stock_movements m
    WHERE m.company_id = p_company_id AND m.doc_type = 'receipt'
      AND m.doc_id = p_receipt_id AND NOT m.is_reversal
    GROUP BY m.warehouse_id, m.item_id
  LOOP
    IF v_rec.delta < 0 THEN
      SELECT * INTO v_stock
      FROM public.prod_current_stock(p_company_id, v_rec.warehouse_id, v_rec.item_id);
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
  WHERE m.company_id = p_company_id AND m.doc_type = 'receipt'
    AND m.doc_id = p_receipt_id AND NOT m.is_reversal;

  UPDATE public.prod_receipts
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_receipt_id AND company_id = p_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_milk_apply_lab(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_receipt_internal(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ─── 8) RPCs ──────────────────────────────────────────────────────────────

-- prod_milk permission AND owner/admin role.
-- p_data: { milk_item_id, default_warehouse_id, base_fat, base_protein,
--           pricing_mode, default_price_per_kg, default_density, min_fat,
--           min_density, max_acidity, max_temperature }
-- Partial update: an ABSENT key leaves the stored value (or the column
-- default on first save) unchanged. milk_item_id / default_warehouse_id:
-- present + null clears; other keys: null = unchanged (they are NOT NULL).
-- milk_item_id: company item (not_found), active, item_type 'raw' and
-- unit 'kg' (else invalid_input). Warehouse: company (not_found), active
-- (invalid_input).
CREATE OR REPLACE FUNCTION public.prod_save_milk_settings(p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_has_item boolean;
  v_has_wh boolean;
  v_item_id uuid;
  v_wh_id uuid;
  v_base_fat numeric;
  v_base_protein numeric;
  v_mode text;
  v_price numeric;
  v_density numeric;
  v_min_fat numeric;
  v_min_density numeric;
  v_max_acidity numeric;
  v_max_temp numeric;
  v_item record;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_milk') THEN
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

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_has_item := p_data ? 'milk_item_id';
  v_has_wh := p_data ? 'default_warehouse_id';
  v_item_id := public.prod_juuid(p_data, 'milk_item_id');
  v_wh_id := public.prod_juuid(p_data, 'default_warehouse_id');
  v_base_fat := public.prod_jnum(p_data, 'base_fat', 2);
  v_base_protein := public.prod_jnum(p_data, 'base_protein', 2);
  v_mode := public.prod_jtext(p_data, 'pricing_mode', 20);
  v_price := public.prod_jnum(p_data, 'default_price_per_kg', 2);
  v_density := public.prod_jnum(p_data, 'default_density', 4);
  v_min_fat := public.prod_jnum(p_data, 'min_fat', 2);
  v_min_density := public.prod_jnum(p_data, 'min_density', 4);
  v_max_acidity := public.prod_jnum(p_data, 'max_acidity', 1);
  v_max_temp := public.prod_jnum(p_data, 'max_temperature', 1);

  IF (v_base_fat IS NOT NULL AND NOT (v_base_fat > 0 AND v_base_fat <= 100))
     OR (v_base_protein IS NOT NULL AND NOT (v_base_protein > 0 AND v_base_protein <= 100))
     OR (v_mode IS NOT NULL AND v_mode NOT IN ('flat', 'fat', 'fat_protein'))
     OR (v_price IS NOT NULL AND v_price < 0)
     OR (v_density IS NOT NULL AND v_density NOT BETWEEN 0.5 AND 2)
     OR (v_min_fat IS NOT NULL AND v_min_fat NOT BETWEEN 0 AND 100)
     OR (v_min_density IS NOT NULL AND v_min_density NOT BETWEEN 0.5 AND 2)
     OR (v_max_acidity IS NOT NULL AND v_max_acidity NOT BETWEEN 0 AND 999.9)
     OR (v_max_temp IS NOT NULL AND v_max_temp NOT BETWEEN -100 AND 100) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_item_id IS NOT NULL THEN
    SELECT is_active, item_type, unit INTO v_item
    FROM public.prod_items
    WHERE id = v_item_id AND company_id = v_company_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_item.is_active OR v_item.item_type <> 'raw' OR v_item.unit <> 'kg' THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;

  IF v_wh_id IS NOT NULL THEN
    PERFORM public.prod_require_warehouse(v_company_id, v_wh_id);
  END IF;

  -- Create-if-missing with column defaults, then one row-locking UPDATE.
  INSERT INTO public.prod_milk_settings (company_id)
  VALUES (v_company_id)
  ON CONFLICT (company_id) DO NOTHING;

  UPDATE public.prod_milk_settings
  SET milk_item_id = CASE WHEN v_has_item THEN v_item_id ELSE milk_item_id END,
      default_warehouse_id = CASE WHEN v_has_wh THEN v_wh_id ELSE default_warehouse_id END,
      base_fat = COALESCE(v_base_fat, base_fat),
      base_protein = COALESCE(v_base_protein, base_protein),
      pricing_mode = COALESCE(v_mode, pricing_mode),
      default_price_per_kg = COALESCE(v_price, default_price_per_kg),
      default_density = COALESCE(v_density, default_density),
      min_fat = COALESCE(v_min_fat, min_fat),
      min_density = COALESCE(v_min_density, min_density),
      max_acidity = COALESCE(v_max_acidity, max_acidity),
      max_temperature = COALESCE(v_max_temp, max_temperature),
      updated_at = now(),
      updated_by = auth.uid()
  WHERE company_id = v_company_id;
END;
$$;

-- prod_milk permission (+ prod_lab when a "lab" object is given).
-- p_data: { intake_date, supplier_id, warehouse_id, item_id, vehicle_no,
--           driver, gross_kg, tare_kg, net_kg, density, note, lab }
--   * supplier_id required: company supplier (not_found), active
--     (invalid_input); locked FOR SHARE.
--   * warehouse_id default settings.default_warehouse_id; company
--     (not_found), active (invalid_input).
--   * item_id default settings.milk_item_id; company item (not_found),
--     active, item_type 'raw', unit 'kg' (invalid_input).
--   * weights: gross_kg given -> tare_kg default 0, net = gross - tare
--     (a net_kg that disagrees -> invalid_input); gross_kg absent -> net_kg
--     required, gross = net, tare = 0 (a non-zero tare -> invalid_input).
--     net > 0.
--   * density default settings.default_density (1.030 without settings);
--     volume_l = round(net / density, 3).
--   * lab: optional object, same fields as prod_record_milk_lab, applied in
--     the same transaction.
-- Returns { id, number }.
CREATE OR REPLACE FUNCTION public.prod_create_milk_intake(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_settings record;
  v_has_settings boolean;
  v_intake_date timestamptz;
  v_supplier_id uuid;
  v_sup_active boolean;
  v_warehouse_id uuid;
  v_item_id uuid;
  v_item record;
  v_vehicle text;
  v_driver text;
  v_gross numeric;
  v_tare numeric;
  v_net_in numeric;
  v_net numeric;
  v_density numeric;
  v_volume numeric;
  v_note text;
  v_lab jsonb;
  v_id uuid;
  v_number integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_milk') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Optional lab block: validated / permission-checked up front.
  v_lab := p_data->'lab';
  IF v_lab IS NOT NULL AND jsonb_typeof(v_lab) = 'null' THEN
    v_lab := NULL;
  END IF;
  IF v_lab IS NOT NULL THEN
    IF jsonb_typeof(v_lab) <> 'object' THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF NOT public.has_permission('prod_lab') THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  END IF;

  SELECT milk_item_id, default_warehouse_id, default_density INTO v_settings
  FROM public.prod_milk_settings
  WHERE company_id = v_company_id;
  v_has_settings := FOUND;

  v_intake_date := COALESCE(public.prod_jts(p_data, 'intake_date'), now());
  v_supplier_id := public.prod_juuid(p_data, 'supplier_id');
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_item_id := public.prod_juuid(p_data, 'item_id');
  v_vehicle := public.prod_jtext(p_data, 'vehicle_no', 30);
  v_driver := public.prod_jtext(p_data, 'driver', 100);
  v_gross := public.prod_jnum(p_data, 'gross_kg', 3);
  v_tare := public.prod_jnum(p_data, 'tare_kg', 3);
  v_net_in := public.prod_jnum(p_data, 'net_kg', 3);
  v_density := public.prod_jnum(p_data, 'density', 4);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_has_settings THEN
    v_warehouse_id := COALESCE(v_warehouse_id, v_settings.default_warehouse_id);
    v_item_id := COALESCE(v_item_id, v_settings.milk_item_id);
    v_density := COALESCE(v_density, v_settings.default_density);
  END IF;
  v_density := COALESCE(v_density, 1.030);

  IF v_supplier_id IS NULL OR v_warehouse_id IS NULL OR v_item_id IS NULL
     OR v_density NOT BETWEEN 0.5 AND 2 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Weights.
  IF v_gross IS NOT NULL THEN
    v_tare := COALESCE(v_tare, 0);
    IF v_gross < 0 OR v_tare < 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_net := v_gross - v_tare;
    IF v_net_in IS NOT NULL AND v_net_in <> v_net THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  ELSE
    IF v_net_in IS NULL OR (v_tare IS NOT NULL AND v_tare <> 0) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_net := v_net_in;
    v_gross := v_net_in;
    v_tare := 0;
  END IF;
  IF v_net <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  v_volume := round(v_net / v_density, 3);

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);

  SELECT is_active, item_type, unit INTO v_item
  FROM public.prod_items
  WHERE id = v_item_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_item.is_active OR v_item.item_type <> 'raw' OR v_item.unit <> 'kg' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT s.is_active INTO v_sup_active
  FROM public.prod_suppliers s
  WHERE s.id = v_supplier_id AND s.company_id = v_company_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_sup_active THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_milk_intake_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_milk_intakes WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_milk_intakes (
    company_id, number, intake_date, supplier_id, warehouse_id, item_id,
    vehicle_no, driver, gross_kg, tare_kg, net_kg, density, volume_l,
    status, note, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_intake_date, v_supplier_id, v_warehouse_id, v_item_id,
    v_vehicle, v_driver, v_gross, v_tare, v_net, v_density, v_volume,
    'weighed', v_note, auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  IF v_lab IS NOT NULL THEN
    -- Row inserted by this transaction: invisible to others, no lock needed.
    PERFORM public.prod_milk_apply_lab(v_company_id, v_id, v_lab);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- prod_lab permission. Only when status = 'weighed' (cancelled ->
-- already_cancelled, already decided -> invalid_input). Intake row locked
-- FOR UPDATE: a concurrent second decision waits, then gets invalid_input.
-- p_data: see prod_milk_apply_lab. Thresholds are NOT enforced here (the
-- lab decides); the values are stored.
-- Returns { status, credited_kg, price_per_kg, amount, receipt_id }.
CREATE OR REPLACE FUNCTION public.prod_record_milk_lab(p_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_status text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_lab') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_id IS NULL OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT status INTO v_status
  FROM public.prod_milk_intakes
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Status re-checked inside (weighed only).
  RETURN public.prod_milk_apply_lab(v_company_id, p_id, p_data);
END;
$$;

-- prod_milk permission AND owner/admin role. Intake row FOR UPDATE.
--   weighed / rejected       -> cancelled.
--   accepted / conditional   -> linked receipt cancelled exactly like
--                               prod_cancel_document('receipt', ...)
--                               (insufficient_stock if the milk was already
--                               consumed / moved), then cancelled.
--   cancelled                -> already_cancelled.
CREATE OR REPLACE FUNCTION public.prod_cancel_milk_intake(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_status text;
  v_receipt_id uuid;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_milk') THEN
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

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT status, receipt_id INTO v_status, v_receipt_id
  FROM public.prod_milk_intakes
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  IF v_status IN ('accepted', 'conditional') THEN
    PERFORM public.prod_cancel_receipt_internal(v_company_id, v_receipt_id);
  END IF;

  UPDATE public.prod_milk_intakes
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_save_supplier (replaced, same signature) ═══════════════════════
-- Body copied from 20261110000007. ONLY addition: optional
-- p_data.milk_price_per_kg (>= 0, 2 decimals). Key ABSENT -> unchanged on
-- update / NULL on create (old clients never wipe it); present + null ->
-- cleared (falls back to the settings default price).
-- p_data: { name, phone, address, note, is_active, milk_price_per_kg }
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
  v_phone text;
  v_address text;
  v_note text;
  v_active boolean;
  v_has_milk_price boolean;
  v_milk_price numeric;
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

  IF v_name IS NULL OR (v_milk_price IS NOT NULL AND v_milk_price < 0) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_suppliers (company_id, name, phone, address, note, is_active, milk_price_per_kg)
      VALUES (v_company_id, v_name, v_phone, v_address, v_note, COALESCE(v_active, true), v_milk_price)
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_suppliers
      SET name = v_name,
          phone = v_phone,
          address = v_address,
          note = v_note,
          is_active = COALESCE(v_active, is_active),
          milk_price_per_kg = CASE WHEN v_has_milk_price THEN v_milk_price ELSE milk_price_per_kg END,
          updated_at = now()
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

-- ═══ prod_cancel_document (replaced, same signature) ═════════════════════
-- Body copied from 20261110000009. ONLY addition (after the
-- already_cancelled check): a receipt posted by a milk intake that is not
-- cancelled -> 'invalid_input' (cancel it via prod_cancel_milk_intake).
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

  -- NEW: milk-intake receipts are cancelled only through their intake.
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
  ELSE
    UPDATE public.prod_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated for the replaced ones and
-- the default PUBLIC EXECUTE closed on the new ones.

REVOKE EXECUTE ON FUNCTION public.prod_save_milk_settings(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_milk_intake(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_record_milk_lab(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_milk_intake(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_milk_settings(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_milk_intake(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_record_milk_lab(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_milk_intake(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on both new tables:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_milk_settings', 'prod_milk_intakes')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_milk_settings', 'prod_milk_intakes', 'prod_stock_quality');
-- -- internal helpers not executable by clients (expect all false):
-- SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE')
-- FROM pg_proc p WHERE p.proname IN ('prod_stock_quality_at', 'prod_stock_movements_quality',
--   'prod_milk_apply_lab', 'prod_cancel_receipt_internal');
-- -- transfer quality follows the source (expect 0 rows):
-- SELECT o.doc_id FROM public.prod_stock_movements o
-- JOIN public.prod_stock_movements i ON i.doc_id = o.doc_id AND i.item_id = o.item_id
--   AND i.doc_type = 'transfer' AND i.qty > 0 AND NOT i.is_reversal
-- WHERE o.doc_type = 'transfer' AND o.qty < 0 AND NOT o.is_reversal
--   AND o.fat_pct IS DISTINCT FROM i.fat_pct;
