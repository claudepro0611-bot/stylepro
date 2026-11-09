-- Production suppliers (yetkazib beruvchilar) for the production module.
--
-- Why: raw-material (milk) receipts so far carried only a free-text
-- supplier_name, so the plant could not answer "who delivered what, how much
-- did we pay, how much do we still owe". This file adds:
--   1) public.prod_suppliers            - supplier directory (per company)
--   2) prod_receipts.supplier_id        - optional link, composite FK
--   3) backfill                         - suppliers from existing supplier_name
--   4) public.prod_supplier_payments    - payments to suppliers (cancellable)
--   5) public.prod_supplier_balances    - purchased / paid / debt view
--   6) RLS + grants                     - identical model to file 3
--   7) has_permission                   - new fail-closed key 'prod_suppliers'
--   8) RPCs                             - prod_save_supplier,
--                                         prod_create_supplier_payment,
--                                         prod_cancel_supplier_payment,
--                                         prod_create_receipt (replaced)
--
-- Deliberately separate from the retail public.suppliers module
-- (20261106000004_suppliers.sql): no retail table or function is touched,
-- retail behaviour is unchanged (has_permission only gains one prod_* key,
-- which retail firms without the production module still get false for).
--
-- Access model (same as 20261110000003_production_core.sql):
--   * company_id NOT NULL -> companies ON DELETE CASCADE.
--   * RLS on, ONE SELECT policy company-scoped via (SELECT get_company_id()).
--   * REVOKE ALL from authenticated + anon (closes Supabase default-grant
--     leak), GRANT SELECT to authenticated only. Writes ONLY via the
--     SECURITY DEFINER RPCs below.
--
-- Error codes (unchanged contract, productionErrors.*): forbidden,
-- wrong_business_type, not_found, invalid_input, duplicate_name,
-- already_cancelled.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) prod_suppliers ────────────────────────────────────────────────────
-- name max 200 = prod_receipts.supplier_name max, so (a) every legacy
-- supplier_name can be backfilled and (b) the snapshot copied into a receipt
-- always satisfies prod_receipts_supplier_check.

CREATE TABLE public.prod_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NULL,
  address text NULL,
  note text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_suppliers_company_name_key UNIQUE (company_id, name),
  CONSTRAINT prod_suppliers_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_suppliers_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT prod_suppliers_phone_check CHECK (phone IS NULL OR length(phone) <= 30),
  CONSTRAINT prod_suppliers_address_check CHECK (address IS NULL OR length(address) <= 300),
  CONSTRAINT prod_suppliers_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_suppliers IS
  'Production (raw-material) suppliers. Read via RLS (company-scoped SELECT); '
  'write ONLY via prod_save_supplier. Separate from retail public.suppliers.';

-- ─── 2) prod_receipts.supplier_id ─────────────────────────────────────────
-- Nullable: supplier stays optional on a receipt. MATCH SIMPLE composite FK:
-- a NULL supplier_id skips the check; a non-NULL one can only point at a
-- supplier of the SAME company. supplier_name is kept as the legacy /
-- display snapshot (name at posting time).
-- Non-destructive: ADD COLUMN NULL without default is metadata-only.

ALTER TABLE public.prod_receipts
  ADD COLUMN supplier_id uuid NULL;

ALTER TABLE public.prod_receipts
  ADD CONSTRAINT prod_receipts_supplier_fk FOREIGN KEY (supplier_id, company_id)
    REFERENCES public.prod_suppliers (id, company_id);

-- Supplier detail page (Kirimlar tab) + balances view + FK support.
CREATE INDEX prod_receipts_supplier_idx
  ON public.prod_receipts (supplier_id, company_id)
  WHERE supplier_id IS NOT NULL;

-- ─── 3) Backfill ──────────────────────────────────────────────────────────
-- One supplier per DISTINCT (company, btrim(supplier_name)), non-empty,
-- from ALL receipts (posted and cancelled - both are history). Matching is
-- exact after trimming (case-sensitive, like the UNIQUE key): 'Ali' and
-- 'ali' become two suppliers; users can merge by hand later.
-- supplier_name itself is NOT rewritten.

INSERT INTO public.prod_suppliers (company_id, name)
SELECT DISTINCT r.company_id, btrim(r.supplier_name)
FROM public.prod_receipts r
WHERE NULLIF(btrim(r.supplier_name), '') IS NOT NULL
ON CONFLICT (company_id, name) DO NOTHING;

UPDATE public.prod_receipts r
SET supplier_id = s.id
FROM public.prod_suppliers s
WHERE r.supplier_id IS NULL
  AND s.company_id = r.company_id
  AND s.name = btrim(r.supplier_name);

-- ─── 4) prod_supplier_payments ────────────────────────────────────────────
-- number: per-company sequence (max + 1 under an advisory lock in the RPC).
-- A payment is never edited or deleted; it can only be cancelled
-- (status / cancelled_at consistency enforced by CHECK, like documents).

CREATE TABLE public.prod_supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  supplier_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  method text NOT NULL DEFAULT 'cash',
  pay_date date NOT NULL DEFAULT current_date,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_supplier_payments_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_supplier_payments_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_supplier_payments_supplier_fk FOREIGN KEY (supplier_id, company_id)
    REFERENCES public.prod_suppliers (id, company_id),
  CONSTRAINT prod_supplier_payments_number_check CHECK (number > 0),
  CONSTRAINT prod_supplier_payments_amount_check CHECK (amount > 0),
  CONSTRAINT prod_supplier_payments_method_check CHECK (method IN ('cash', 'card', 'transfer')),
  CONSTRAINT prod_supplier_payments_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_supplier_payments_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT prod_supplier_payments_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_supplier_payments IS
  'Payments to production suppliers. Read via RLS; write ONLY via '
  'prod_create_supplier_payment / prod_cancel_supplier_payment.';

CREATE INDEX prod_supplier_payments_supplier_idx
  ON public.prod_supplier_payments (supplier_id, company_id);
CREATE INDEX prod_supplier_payments_company_date_idx
  ON public.prod_supplier_payments (company_id, pay_date DESC);

-- ─── 5) prod_supplier_balances view ───────────────────────────────────────
-- security_invoker = true: caller's RLS on the three base tables applies, the
-- view never widens access. Every supplier appears (zeros when inactive in
-- business terms). Pre-aggregated subqueries avoid receipt x payment
-- fan-out. debt < 0 = advance (overpayment is allowed).
-- last_receipt_at = max(doc_date) of posted receipts (timestamptz);
-- last_payment_at = max(pay_date) of posted payments (date).

CREATE VIEW public.prod_supplier_balances
WITH (security_invoker = true)
AS
SELECT
  s.id AS supplier_id,
  s.company_id,
  COALESCE(r.purchased, 0)::numeric(14,2) AS purchased,
  COALESCE(p.paid, 0)::numeric(14,2) AS paid,
  (COALESCE(r.purchased, 0) - COALESCE(p.paid, 0))::numeric(14,2) AS debt,
  r.last_receipt_at,
  p.last_payment_at
FROM public.prod_suppliers s
LEFT JOIN (
  SELECT supplier_id, company_id,
         sum(total) AS purchased,
         max(doc_date) AS last_receipt_at
  FROM public.prod_receipts
  WHERE status = 'posted' AND supplier_id IS NOT NULL
  GROUP BY supplier_id, company_id
) r ON r.supplier_id = s.id AND r.company_id = s.company_id
LEFT JOIN (
  SELECT supplier_id, company_id,
         sum(amount) AS paid,
         max(pay_date) AS last_payment_at
  FROM public.prod_supplier_payments
  WHERE status = 'posted'
  GROUP BY supplier_id, company_id
) p ON p.supplier_id = s.id AND p.company_id = s.company_id;

COMMENT ON VIEW public.prod_supplier_balances IS
  'Per production supplier: purchased (posted receipts), paid (posted payments), '
  'debt = purchased - paid (negative = advance).';

-- ─── 6) RLS, policies, grants ─────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prod_suppliers', 'prod_supplier_payments']
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

REVOKE ALL ON public.prod_supplier_balances FROM authenticated, anon;
GRANT SELECT ON public.prod_supplier_balances TO authenticated;

-- ─── 7) has_permission ────────────────────────────────────────────────────
-- Copied verbatim from 20261110000006. ONLY change: 'prod_suppliers' added
-- to v_prod_keys (-> production-module gate + fail-closed for non-owners)
-- and to v_valid_keys (whitelist).
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
    'prod_receipts', 'prod_stock', 'prod_supply', 'prod_suppliers'
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
    'prod_receipts', 'prod_stock', 'prod_supply', 'prod_suppliers'
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

-- ─── 8) RPCs ──────────────────────────────────────────────────────────────

-- p_id NULL -> create, else update the company's supplier (not_found if not).
-- p_data: { name, phone, address, note, is_active }
-- Full replace on update: every field is taken from p_data (a missing
-- optional field becomes NULL); missing is_active -> true on create /
-- unchanged on update (same rule as prod_save_item).
-- Renaming does NOT rewrite prod_receipts.supplier_name (it is a snapshot).
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

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_suppliers (company_id, name, phone, address, note, is_active)
      VALUES (v_company_id, v_name, v_phone, v_address, v_note, COALESCE(v_active, true))
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_suppliers
      SET name = v_name,
          phone = v_phone,
          address = v_address,
          note = v_note,
          is_active = COALESCE(v_active, is_active),
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

-- p_data: { supplier_id, amount, method ('cash'|'card'|'transfer', default
--           'cash'), pay_date (YYYY-MM-DD, default today), note }
-- amount > 0, money entered by the user (what was actually paid).
-- Overpayment IS allowed (debt goes negative = advance), so no balance
-- check and no balance lock. Inactive suppliers CAN be paid (settling the
-- debt of a supplier we no longer buy from). Returns { id, number }.
CREATE OR REPLACE FUNCTION public.prod_create_supplier_payment(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_supplier_id uuid;
  v_amount numeric;
  v_method text;
  v_pay_date date;
  v_note text;
  v_id uuid;
  v_number integer;
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

  v_supplier_id := public.prod_juuid(p_data, 'supplier_id');
  v_amount := public.prod_jnum(p_data, 'amount', 2);
  v_method := COALESCE(public.prod_jtext(p_data, 'method', 20), 'cash');
  v_pay_date := COALESCE(public.prod_jdate(p_data, 'pay_date'), current_date);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_supplier_id IS NULL
     OR v_amount IS NULL OR v_amount <= 0
     OR v_method NOT IN ('cash', 'card', 'transfer') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- FOR SHARE: the supplier row cannot change underneath (consistent with
  -- the FK check that follows on INSERT).
  PERFORM 1 FROM public.prod_suppliers
  WHERE id = v_supplier_id AND company_id = v_company_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_supplier_payment_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_supplier_payments WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_supplier_payments (
    company_id, number, supplier_id, amount, method, pay_date, note,
    status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_supplier_id, v_amount, v_method, v_pay_date, v_note,
    'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- prod_suppliers permission AND owner/admin role (same rule as
-- prod_cancel_document). Row locked FOR UPDATE: a concurrent second cancel
-- waits, then gets 'already_cancelled'.
CREATE OR REPLACE FUNCTION public.prod_cancel_supplier_payment(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_status text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_suppliers') THEN
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

  SELECT status INTO v_status
  FROM public.prod_supplier_payments
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  UPDATE public.prod_supplier_payments
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_create_receipt (replaced, same signature) ═══════════════════════
-- Body copied from 20261110000004. ONLY additions:
--   * optional p_data.supplier_id: must be a supplier of the company
--     (else invalid_input, per spec - NOT not_found) and active (else
--     invalid_input). Locked FOR SHARE so it cannot be deactivated /
--     renamed between the check and the insert.
--   * when supplier_id is given: supplier_id stored, supplier_name := the
--     supplier's current name (snapshot; client supplier_name ignored).
--     Otherwise old behaviour (free-text supplier_name, supplier_id NULL).
-- p_data: { doc_date, warehouse_id, supplier_id, supplier_name, note,
--           items: [{ item_id, qty, price }] }
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

    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by
    ) VALUES (
      v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i], v_prices[i], 'receipt', v_id, false, auth.uid()
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps prod_create_receipt's existing ACL; re-stated
-- for clarity / idempotence.

REVOKE EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_supplier_payment(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_supplier_payment(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_supplier_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_supplier_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on the two new tables:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_suppliers', 'prod_supplier_payments')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_suppliers', 'prod_supplier_payments', 'prod_supplier_balances');
-- -- backfill: legacy receipts with a name but no link (expect 0):
-- SELECT count(*) FROM public.prod_receipts
-- WHERE NULLIF(btrim(supplier_name), '') IS NOT NULL AND supplier_id IS NULL;
