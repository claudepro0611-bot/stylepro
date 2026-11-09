-- Branches (filiallar) - PHASE 3 (DB): branch scoping for stock + POS.
--
-- Contents
--   0) catalog_require_admin()        internal: owner/admin gate for the shared catalog
--   1) RLS: branch-scoped reads on product_sizes, transactions,
--      transaction_items, stock_out_entries, shifts, returns, return_items,
--      stock_counts, stock_count_items, stock_transfers,
--      stock_transfer_items (+ post-check)
--   2) shifts: FOR ALL policy (POS writes shifts directly) + immutable
--      company_id / branch_id / cashier_id guard trigger
--   3) pos_catalog(p_branch_id) / pos_lookups(p_branch_id)
--   4) sell_cart: branch, shift and customer validation
--   5) branch checks in every stock write RPC
--   6) catalog mutations owner/admin only ('catalog_forbidden')
--
-- UNCHANGED (company-visible, by design): warehouses, stock_in_entries
-- (supplier balances sum them), supplier_returns / supplier_return_items,
-- products, product_groups, price_lists, price_list_items, promotions,
-- promotion_products and every other catalog table.
--
-- Access model reminder: product_sizes / transactions / transaction_items /
-- stock_out_entries / returns / return_items / stock_counts(+items) /
-- stock_transfers(+items) have NO direct write grant for authenticated
-- (20260715000004, 20260717000001, 20261105000005, 20261106000003). Their
-- writes happen ONLY in the SECURITY DEFINER RPCs below, which bypass RLS -
-- so every write RPC carries an explicit branch check:
--   * reads of an existing row  -> assert_branch_access(row.branch_id)
--   * writes into a new place   -> resolve_branch_id(requested) or
--                                  assert_branch_access(warehouse.branch_id)
--   Error string for all of them: 'branch_forbidden' (raised by the helpers).
--
-- WARNING - DROP POLICY (no data loss): every existing policy on the 11
-- tables in section 1 is dropped and replaced (super-admin policies, if any
-- exist in the live DB, are kept). Dropped policy names are reported with
-- RAISE NOTICE. A post-check aborts the whole file if any remaining policy
-- on those tables is not branch-scoped.
--
-- WARNING - DROP FUNCTION (no data loss): pos_catalog() and pos_lookups()
-- (zero-arg) are dropped and re-created with a trailing
-- p_branch_id uuid DEFAULT NULL, inside this transaction. A call without
-- arguments resolves to the new signature.
--
-- Every other function below is CREATE OR REPLACE with the SAME signature,
-- same permission key, same error strings; only the listed additions.
--
-- Runs as one transaction (BEGIN/COMMIT).

BEGIN;

-- ─── 0) Internal gate: shared-catalog mutations ────────────────────────────
-- Catalog (products, groups, price lists, promotions, variant barcodes) is
-- shared by every branch, so only the all-branch roles may change it
-- (owner decision). Not callable by clients; runs inside SECURITY DEFINER
-- callers (EXECUTE is checked against the definer).

CREATE OR REPLACE FUNCTION public.catalog_require_admin()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
      AND u.company_id IS NOT NULL
      AND u.role IN ('owner', 'admin')
      AND u.status = 'active'
  ) THEN
    RAISE EXCEPTION 'catalog_forbidden';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_require_admin() FROM PUBLIC, anon, authenticated;

-- ─── 1) RLS: drop the company-only policies ────────────────────────────────

DO $drop_policies$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'product_sizes', 'transactions', 'transaction_items', 'stock_out_entries',
        'shifts', 'returns', 'return_items', 'stock_counts', 'stock_count_items',
        'stock_transfers', 'stock_transfer_items'
      ])
  LOOP
    IF coalesce(r.qual, '') || ' ' || coalesce(r.with_check, '') ~* 'is_super_admin' THEN
      RAISE NOTICE 'branch_scope: keeping super-admin policy "%" on public.%', r.policyname, r.tablename;
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
    RAISE NOTICE 'branch_scope: dropped policy "%" on public.%', r.policyname, r.tablename;
  END LOOP;
END
$drop_policies$;

ALTER TABLE public.product_sizes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_out_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.returns              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_counts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_count_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;

-- ─── 1b) Branch-scoped read policies ───────────────────────────────────────
-- SELECT only: these tables have no direct write grant for authenticated
-- (the old FOR ALL policies granted nothing usable on top of SELECT).
-- initPlan-wrapped so get_company_id()/get_branch_ids() run once per query.

CREATE POLICY "Branch isolation (select)" ON public.product_sizes
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation (select)" ON public.transactions
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

-- transaction_items.branch_id is force-derived from its transaction
-- (transaction_items_fill_branch_id), so filtering on it is equivalent to a
-- semi-join on transactions and needs no join.
CREATE POLICY "Branch isolation (select)" ON public.transaction_items
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation (select)" ON public.stock_out_entries
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation (select)" ON public.returns
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

-- return_items has no company_id/branch_id: semi-join on its return. The
-- predicate is spelled out (not just "IN (SELECT id FROM returns)") so it
-- does not depend on nested RLS evaluation.
CREATE POLICY "Branch isolation via return (select)" ON public.return_items
  FOR SELECT TO authenticated
  USING (return_id IN (
    SELECT r.id FROM public.returns r
    WHERE r.company_id = (SELECT public.get_company_id())
      AND r.branch_id = ANY ((SELECT public.get_branch_ids())::uuid[])
  ));

CREATE POLICY "Branch isolation (select)" ON public.stock_counts
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

-- Real FK column is count_id (20261105000005).
CREATE POLICY "Branch isolation via count (select)" ON public.stock_count_items
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND count_id IN (
           SELECT sc.id FROM public.stock_counts sc
           WHERE sc.company_id = (SELECT public.get_company_id())
             AND sc.branch_id = ANY ((SELECT public.get_branch_ids())::uuid[])
         ));

-- A transfer is visible to both the sending and the receiving branch.
CREATE POLICY "Branch isolation (select)" ON public.stock_transfers
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND (from_branch_id = ANY ((SELECT public.get_branch_ids())::uuid[])
              OR to_branch_id = ANY ((SELECT public.get_branch_ids())::uuid[])));

-- Real FK column is transfer_id (20261106000003).
CREATE POLICY "Branch isolation via transfer (select)" ON public.stock_transfer_items
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND transfer_id IN (
           SELECT st.id FROM public.stock_transfers st
           WHERE st.company_id = (SELECT public.get_company_id())
             AND (st.from_branch_id = ANY ((SELECT public.get_branch_ids())::uuid[])
                  OR st.to_branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]))
         ));

-- ─── 2) shifts: direct client writes stay, branch-scoped ───────────────────
-- POS inserts/updates shifts itself (app/(dashboard)/pos/page.tsx), so this
-- table keeps its default grants and a FOR ALL policy. USING and WITH CHECK
-- are both branch-scoped: a scoped user can only see/insert/update/delete
-- shifts of their own branch. On INSERT, shifts_fill_branch_id (BEFORE
-- INSERT) fills branch_id before WITH CHECK is evaluated.

CREATE POLICY "Branch isolation" ON public.shifts
  FOR ALL TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]))
  WITH CHECK (company_id = (SELECT public.get_company_id())
              AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

-- company_id / branch_id / cashier_id are fixed once the shift exists, for
-- every real user session (incl. owner/admin). Service role / cron /
-- migrations (auth.uid() IS NULL) pass. The one legitimate change -
-- cashier_id -> NULL from the users FK (ON DELETE SET NULL) when the
-- cashier's user row is deleted - is allowed: at that point the old
-- cashier's users row is already gone.
CREATE OR REPLACE FUNCTION public.shifts_guard_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF NEW.cashier_id IS DISTINCT FROM OLD.cashier_id THEN
    IF NEW.cashier_id IS NULL
       AND OLD.cashier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = OLD.cashier_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shifts_guard_immutable_columns ON public.shifts;
CREATE TRIGGER shifts_guard_immutable_columns
  BEFORE UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.shifts_guard_immutable_columns();

-- ─── 1c) Post-check: every policy left on these tables is branch-scoped ───

DO $post_check$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'product_sizes', 'transactions', 'transaction_items', 'stock_out_entries',
        'shifts', 'returns', 'return_items', 'stock_counts', 'stock_count_items',
        'stock_transfers', 'stock_transfer_items'
      ])
  LOOP
    IF coalesce(r.qual, '') || ' ' || coalesce(r.with_check, '') ~* 'is_super_admin' THEN
      CONTINUE;
    END IF;
    IF r.qual IS NOT NULL AND r.qual !~* 'get_branch_ids' THEN
      RAISE EXCEPTION 'branch_scope post-check: policy "%" on public.% is not branch-scoped (USING %)',
        r.policyname, r.tablename, r.qual;
    END IF;
    IF r.with_check IS NOT NULL AND r.with_check !~* 'get_branch_ids' THEN
      RAISE EXCEPTION 'branch_scope post-check: policy "%" on public.% is not branch-scoped (WITH CHECK %)',
        r.policyname, r.tablename, r.with_check;
    END IF;
  END LOOP;
END
$post_check$;

-- ─── 3) pos_catalog / pos_lookups with a branch ────────────────────────────
-- SECURITY INVOKER kept (justification): the RLS above already restricts a
-- scoped user to their own branch, so an invoker function can never return
-- more than the caller's direct selects; the explicit branch_id = v_branch
-- filter then narrows owner/admin (who can read every branch) to the branch
-- the POS is working in. v_branch comes from resolve_branch_id (SECURITY
-- DEFINER helper): scoped user -> own branch (another one ->
-- 'branch_forbidden'); owner/admin -> requested ACTIVE branch, NULL -> own
-- active branch -> company default. A caller without a company gets empty
-- arrays (same as before, when RLS matched no rows).
-- Same JSON shape and keys as 20261108000004.

DROP FUNCTION IF EXISTS public.pos_catalog();

CREATE FUNCTION public.pos_catalog(p_branch_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch uuid;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object('products', '[]'::jsonb, 'sizes', '[]'::jsonb);
  END IF;

  v_branch := public.resolve_branch_id(p_branch_id);

  RETURN jsonb_build_object(
    -- Products are company-wide (shared catalog): all active ones.
    'products', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',        p.id,
               'name',      p.name,
               'sku',       p.sku,
               'category',  p.category,
               'price',     p.price,
               'status',    p.status,
               'image_url', p.image_url
             )), '[]'::jsonb)
      FROM public.products p
      WHERE p.company_id = v_company_id
        AND p.status = 'active'
    ),
    -- Every variant row of the branch, including stock = 0.
    'sizes', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',                        ps.id,
               'product_id',                ps.product_id,
               'size',                      ps.size,
               'color',                     ps.color,
               'stock',                     ps.stock,
               'purchase_price',            ps.purchase_price,
               'selling_price',             ps.selling_price,
               'sku',                       ps.sku,
               'companion_product_size_id', ps.companion_product_size_id
             )), '[]'::jsonb)
      FROM public.product_sizes ps
      WHERE ps.company_id = v_company_id
        AND ps.branch_id = v_branch
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pos_catalog(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_catalog(uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.pos_lookups();

CREATE FUNCTION public.pos_lookups(p_branch_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch uuid;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object('customers', '[]'::jsonb,
                              'price_lists', '[]'::jsonb,
                              'price_list_items', '[]'::jsonb);
  END IF;

  v_branch := public.resolve_branch_id(p_branch_id);

  RETURN jsonb_build_object(
    'customers', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',            c.id,
               'full_name',     c.full_name,
               'phone',         c.phone,
               'price_list_id', c.price_list_id
             )), '[]'::jsonb)
      FROM public.customers c
      WHERE c.company_id = v_company_id
        AND c.branch_id = v_branch
    ),
    -- Price lists are company-wide (unchanged).
    'price_lists', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',             pl.id,
               'name',           pl.name,
               'base',           pl.base,
               'adjust_percent', pl.adjust_percent,
               'rounding',       pl.rounding,
               'is_active',      pl.is_active
             )), '[]'::jsonb)
      FROM public.price_lists pl
      WHERE pl.company_id = v_company_id
    ),
    'price_list_items', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'price_list_id',   pli.price_list_id,
               'product_size_id', pli.product_size_id,
               'price',           pli.price
             )), '[]'::jsonb)
      FROM public.price_list_items pli
      WHERE pli.company_id = v_company_id
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pos_lookups(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_lookups(uuid) TO authenticated;

-- ─── 4) sell_cart ──────────────────────────────────────────────────────────
-- Body from 20261108000001 (gifts, manual discount, price lists, promos,
-- VIP, loyalty unchanged). Added:
--   * v_branch_id := resolve_branch_id(p_payment->>'branch_id')
--   * p_payment->>'shift_id' (if given) must be an ACTIVE shift of the
--     caller (cashier_id = auth.uid()), same company, same branch
--     -> else 'invalid_shift'. Locked FOR SHARE so the shift cannot be
--     closed while this sale is being recorded. (SECURITY FIX: it was
--     trusted blindly.)
--   * customer (if given) must be in v_branch_id -> else
--     'customer_wrong_branch'. Locked FOR NO KEY UPDATE (the customer row
--     is updated later in this transaction by the purchase-stats trigger
--     anyway; also serializes with move_customer_branch).
--   * every locked product_sizes row must be in v_branch_id -> else
--     'wrong_branch'.
--   * transactions and stock_out_entries get branch_id = v_branch_id
--     explicitly (transaction_items is force-derived from the transaction).

CREATE OR REPLACE FUNCTION public.sell_cart(
  p_items jsonb,
  p_customer_id uuid,
  p_payment jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_shift_id uuid;
  v_customer_branch uuid;
  v_transaction_id uuid;
  v_total_amount numeric := 0;      -- paid total BEFORE manual discount
  v_final_total numeric := 0;       -- charged total AFTER manual discount
  v_gift_amount numeric := 0;
  v_vip_discount_percent numeric := 0;
  v_manual_discount numeric := 0;
  v_item jsonb;
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_idx integer := 0;
  v_absorb_idx integer := NULL;
  v_absorb_qty integer := NULL;
  v_absorb_price numeric := NULL;
  v_others_total numeric := 0;
  v_product_size_id uuid;
  v_quantity integer;
  v_is_gift boolean;
  v_promo_discount numeric;
  v_effective_discount numeric;
  v_list_price numeric;
  v_unit_price numeric;
  v_final_price numeric;
  v_line_total numeric;
  v_row RECORD;
  v_role text;
  v_max_gift_percent numeric;
  v_gift_staff_allowed boolean;
  v_price_list_id uuid;
  v_pl_price numeric;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;

  v_manual_discount := COALESCE(NULLIF(p_payment->>'manual_discount', '')::numeric, 0);
  IF v_manual_discount < 0 OR v_manual_discount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'invalid_discount';
  END IF;
  v_manual_discount := round(v_manual_discount, 2);

  -- Branch of this sale ('branch_forbidden' if not allowed / inactive).
  v_branch_id := public.resolve_branch_id(NULLIF(p_payment->>'branch_id', '')::uuid);

  v_shift_id := NULLIF(p_payment->>'shift_id', '')::uuid;
  IF v_shift_id IS NOT NULL THEN
    PERFORM 1
    FROM public.shifts s
    WHERE s.id = v_shift_id
      AND s.company_id = v_company_id
      AND s.branch_id = v_branch_id
      AND s.status = 'active'
      AND s.cashier_id = auth.uid()
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_shift';
    END IF;
  END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT COALESCE(vip_discount_percent, 0), price_list_id, branch_id
      INTO v_vip_discount_percent, v_price_list_id, v_customer_branch
    FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid customer_id for this company';
    END IF;

    IF v_customer_branch IS DISTINCT FROM v_branch_id THEN
      RAISE EXCEPTION 'customer_wrong_branch';
    END IF;
  END IF;

  -- ── Pass 1: lock, validate and price every line (no writes) ──────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_size_id := NULLIF(v_item->>'product_size_id', '')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_is_gift := COALESCE((v_item->>'is_gift')::boolean, false);

    IF v_product_size_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid cart line: %', v_item;
    END IF;

    SELECT
      ps.id, ps.product_id, ps.size, ps.color, ps.selling_price,
      ps.purchase_price, ps.branch_id, p.price AS product_price, p.category,
      p.name AS product_name
    INTO v_row
    FROM public.product_sizes ps
    JOIN public.products p ON p.id = ps.product_id AND p.company_id = v_company_id
    WHERE ps.id = v_product_size_id AND ps.company_id = v_company_id
    FOR UPDATE OF ps;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid product_size_id % for this company', v_product_size_id;
    END IF;

    IF v_row.branch_id IS DISTINCT FROM v_branch_id THEN
      RAISE EXCEPTION 'wrong_branch';
    END IF;

    v_list_price := CASE WHEN v_row.selling_price > 0 THEN v_row.selling_price ELSE v_row.product_price END;

    -- Customer's price list (e.g. wholesale) replaces the retail price and
    -- is final: promotions / VIP discounts do not stack on top of it.
    v_pl_price := NULL;
    IF v_price_list_id IS NOT NULL THEN
      v_pl_price := public.price_list_price(v_price_list_id, v_product_size_id);
      IF v_pl_price IS NOT NULL THEN
        v_list_price := v_pl_price;
      END IF;
    END IF;

    IF v_is_gift THEN
      v_effective_discount := 100;
      v_unit_price := 0;
      v_gift_amount := v_gift_amount + v_list_price * v_quantity;
    ELSIF v_pl_price IS NOT NULL THEN
      v_effective_discount := 0;
      v_unit_price := round(v_list_price, 2);
    ELSE
      v_promo_discount := public.get_best_promotion_discount(v_product_size_id, current_date);
      v_effective_discount := GREATEST(v_promo_discount, v_vip_discount_percent, 0);
      v_unit_price := round(v_list_price * (1 - v_effective_discount / 100), 2);
    END IF;

    v_total_amount := v_total_amount + v_unit_price * v_quantity;

    -- Absorbing line for the discount rounding remainder: the non-gift,
    -- non-zero-priced line with the smallest quantity (ties -> later line).
    IF NOT v_is_gift AND v_unit_price > 0
       AND (v_absorb_qty IS NULL OR v_quantity <= v_absorb_qty) THEN
      v_absorb_idx := v_idx;
      v_absorb_qty := v_quantity;
    END IF;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_size_id', v_product_size_id,
      'product_id', v_row.product_id,
      'product_name', v_row.product_name,
      'category', v_row.category,
      'size', v_row.size,
      'color', v_row.color,
      'purchase_price', COALESCE(v_row.purchase_price, 0),
      'quantity', v_quantity,
      'is_gift', v_is_gift,
      'list_price', v_list_price,
      'effective_discount', v_effective_discount,
      'unit_price', v_unit_price
    ));
    v_idx := v_idx + 1;
  END LOOP;

  -- Gift rules: who may give, and how much relative to the paid total.
  -- Deliberately measured against the PRE-discount paid total.
  IF v_gift_amount > 0 THEN
    SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
    SELECT max_gift_percent, gift_staff_allowed
      INTO v_max_gift_percent, v_gift_staff_allowed
    FROM public.companies WHERE id = v_company_id;

    IF v_role IS NULL OR (v_role = 'staff' AND NOT COALESCE(v_gift_staff_allowed, false)) THEN
      RAISE EXCEPTION 'gift_forbidden';
    END IF;

    IF v_total_amount <= 0 THEN
      RAISE EXCEPTION 'gift_requires_paid_item';
    END IF;

    IF v_gift_amount > round(v_total_amount * COALESCE(v_max_gift_percent, 0) / 100, 2) THEN
      RAISE EXCEPTION 'gift_limit_exceeded: max % %%', COALESCE(v_max_gift_percent, 0);
    END IF;
  END IF;

  -- Manual discount: no role limit, only "not more than the paid total".
  IF v_manual_discount > v_total_amount THEN
    RAISE EXCEPTION 'discount_exceeds_total';
  END IF;

  -- Discounted price for the absorbing line = whatever remains of the
  -- target total after every other line has been scaled + rounded.
  IF v_manual_discount > 0 THEN
    v_idx := 0;
    FOR v_line IN SELECT value FROM jsonb_array_elements(v_lines)
    LOOP
      IF NOT (v_line->>'is_gift')::boolean AND v_idx IS DISTINCT FROM v_absorb_idx THEN
        v_others_total := v_others_total
          + round((v_line->>'unit_price')::numeric * (v_total_amount - v_manual_discount) / v_total_amount, 2)
            * (v_line->>'quantity')::integer;
      END IF;
      v_idx := v_idx + 1;
    END LOOP;

    v_line := v_lines->v_absorb_idx;
    v_absorb_price := GREATEST(0, LEAST(
      (v_line->>'unit_price')::numeric,
      round(((v_total_amount - v_manual_discount) - v_others_total) / v_absorb_qty, 2)
    ));
  END IF;

  -- ── Pass 2: write ─────────────────────────────────────────────────────
  INSERT INTO public.transactions (
    company_id, branch_id, customer_id, customer_name, total_amount, date,
    payment_method, status, shift_id, cashier_id, cashier_name
  ) VALUES (
    v_company_id,
    v_branch_id,
    p_customer_id,
    p_payment->>'customer_name',
    0,
    COALESCE((p_payment->>'date')::date, current_date),
    p_payment->>'payment_method',
    'completed',
    v_shift_id,
    NULLIF(p_payment->>'cashier_id', '')::uuid,
    p_payment->>'cashier_name'
  )
  RETURNING id INTO v_transaction_id;

  v_idx := 0;
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_lines)
  LOOP
    v_product_size_id := (v_line->>'product_size_id')::uuid;
    v_quantity := (v_line->>'quantity')::integer;
    v_is_gift := (v_line->>'is_gift')::boolean;
    v_unit_price := (v_line->>'unit_price')::numeric;

    IF v_is_gift THEN
      v_final_price := 0;
    ELSIF v_manual_discount = 0 THEN
      v_final_price := v_unit_price;
    ELSIF v_idx = v_absorb_idx THEN
      v_final_price := v_absorb_price;
    ELSE
      v_final_price := round(v_unit_price * (v_total_amount - v_manual_discount) / v_total_amount, 2);
    END IF;

    v_line_total := v_final_price * v_quantity;
    v_final_total := v_final_total + v_line_total;

    INSERT INTO public.transaction_items (
      company_id, transaction_id, product_id, product_name, quantity, price,
      purchase_price, product_size_id, discount_percent, list_price, is_gift
    ) VALUES (
      v_company_id, v_transaction_id,
      (v_line->>'product_id')::uuid,
      v_line->>'product_name',
      v_quantity,
      v_final_price,
      (v_line->>'purchase_price')::numeric,
      v_product_size_id,
      (v_line->>'effective_discount')::numeric,
      (v_line->>'list_price')::numeric,
      v_is_gift
    );

    INSERT INTO public.stock_out_entries (
      company_id, branch_id, product_id, product_name, category, size, color,
      quantity, sell_price, total_amount, product_size_id,
      customer_id, customer_name, payment_method, date, note, entry_type
    ) VALUES (
      v_company_id,
      v_branch_id,
      (v_line->>'product_id')::uuid,
      v_line->>'product_name',
      v_line->>'category',
      v_line->>'size',
      v_line->>'color',
      v_quantity,
      v_final_price,
      v_line_total,
      v_product_size_id,
      p_customer_id,
      p_payment->>'customer_name',
      p_payment->>'payment_method',
      COALESCE((p_payment->>'date')::date, current_date),
      CASE WHEN v_is_gift THEN 'Sovg''a' ELSE '' END,
      'sale'
    );

    UPDATE public.product_sizes
    SET stock = stock - v_quantity, updated_at = now()
    WHERE id = v_product_size_id
      AND company_id = v_company_id
      AND stock >= v_quantity;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient stock for product_size %', v_product_size_id
        USING ERRCODE = 'P0001';
    END IF;

    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.transactions
  SET total_amount = v_final_total,
      gift_amount = v_gift_amount,
      manual_discount = v_total_amount - v_final_total
  WHERE id = v_transaction_id AND company_id = v_company_id;

  IF p_customer_id IS NOT NULL THEN
    PERFORM public.earn_loyalty(p_customer_id, v_transaction_id, v_final_total);
  END IF;

  RETURN v_transaction_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) TO authenticated;

-- ─── 5a) stock_in ──────────────────────────────────────────────────────────
-- Body from 20261106000004 (supplier link). Added:
--   * the warehouse is read with its branch (FOR KEY SHARE: a concurrent
--     update_warehouse move waits for us, or we see its result) and
--     assert_branch_access(warehouse.branch_id) -> 'branch_forbidden'.
--     Staff keep kirim rights in their own branch, incl. creating new
--     per-warehouse variant rows (NOT catalog-gated).
--   * product_id must belong to the caller's company -> 'Invalid product'
--     (previously unchecked; an FK alone does not check company_id).
--   * the "one price per variant" sync to sibling rows is limited to the
--     SAME branch: a kirim in branch A no longer rewrites branch B's
--     purchase/selling price. The sibling-barcode lookup stays
--     company-wide (a barcode identifies a variant across all warehouses,
--     product_sizes_barcode_variant_check).
--   * stock_in_entries.branch_id = warehouse branch, explicitly.

CREATE OR REPLACE FUNCTION public.stock_in(p_entries jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_entry jsonb;
  v_quantity integer;
  v_purchase_price numeric;
  v_selling_price numeric;
  v_color text;
  v_product_id uuid;
  v_warehouse_id uuid;
  v_warehouse_branch uuid;
  v_product_size_id uuid;
  v_current_barcode text;
  v_sibling_barcode text;
  v_generated_barcode text;
  v_supplier_id uuid;
  v_supplier_name text;
BEGIN
  IF NOT public.has_permission('kirim') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_entries IS NULL OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'No entries to record';
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    v_quantity := (v_entry->>'quantity')::integer;
    v_purchase_price := COALESCE((v_entry->>'purchase_price')::numeric, 0);
    v_selling_price := COALESCE((v_entry->>'selling_price')::numeric, 0);
    v_color := COALESCE(v_entry->>'color', '');
    v_product_id := (v_entry->>'product_id')::uuid;
    v_warehouse_id := NULLIF(v_entry->>'warehouse_id', '')::uuid;
    v_supplier_id := NULLIF(v_entry->>'supplier_id', '')::uuid;
    v_supplier_name := v_entry->>'supplier';

    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-in quantity: %', v_entry;
    END IF;

    v_warehouse_branch := NULL;
    IF v_warehouse_id IS NOT NULL THEN
      SELECT w.branch_id INTO v_warehouse_branch
      FROM public.warehouses w
      WHERE w.id = v_warehouse_id AND w.company_id = v_company_id
      FOR KEY SHARE;
    END IF;
    IF v_warehouse_branch IS NULL THEN
      RAISE EXCEPTION 'Invalid warehouse';
    END IF;

    PERFORM public.assert_branch_access(v_warehouse_branch);

    IF v_product_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.products WHERE id = v_product_id AND company_id = v_company_id
    ) THEN
      RAISE EXCEPTION 'Invalid product';
    END IF;

    IF v_supplier_id IS NOT NULL THEN
      SELECT name INTO v_supplier_name
      FROM public.suppliers WHERE id = v_supplier_id AND company_id = v_company_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid supplier';
      END IF;
    END IF;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, color, stock, warehouse_id,
      purchase_price, selling_price, updated_at
    ) VALUES (
      v_company_id, v_product_id, v_entry->>'size', v_color, v_quantity, v_warehouse_id,
      v_purchase_price, v_selling_price, now()
    )
    ON CONFLICT (company_id, product_id, size, color, warehouse_id) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          purchase_price = excluded.purchase_price,
          selling_price = excluded.selling_price,
          updated_at = now()
    RETURNING id, barcode INTO v_product_size_id, v_current_barcode;

    -- One price per variant across the warehouses OF THIS BRANCH.
    UPDATE public.product_sizes
    SET purchase_price = v_purchase_price, selling_price = v_selling_price, updated_at = now()
    WHERE company_id = v_company_id AND product_id = v_product_id
      AND size = v_entry->>'size' AND color = v_color AND id <> v_product_size_id
      AND branch_id = v_warehouse_branch;

    IF v_current_barcode IS NULL OR v_current_barcode = '' THEN
      SELECT barcode INTO v_sibling_barcode
      FROM public.product_sizes
      WHERE company_id = v_company_id AND product_id = v_product_id
        AND size = v_entry->>'size' AND color = v_color AND id <> v_product_size_id
        AND barcode IS NOT NULL AND barcode <> ''
      LIMIT 1;

      v_generated_barcode := COALESCE(
        v_sibling_barcode,
        lpad(extract(epoch FROM now())::bigint::text, 13, '0') || lpad(v_product_size_id::text, 4, '0')
      );
      UPDATE public.product_sizes
      SET barcode = v_generated_barcode
      WHERE id = v_product_size_id AND (barcode IS NULL OR barcode = '');
    END IF;

    INSERT INTO public.stock_in_entries (
      company_id, branch_id, product_id, product_name, category, size, color,
      quantity, unit_price, purchase_price, selling_price, total_amount,
      supplier, supplier_id, date, note, product_size_id
    ) VALUES (
      v_company_id,
      v_warehouse_branch,
      v_product_id,
      v_entry->>'product_name',
      v_entry->>'category',
      v_entry->>'size',
      v_color,
      v_quantity,
      v_purchase_price,
      v_purchase_price,
      v_selling_price,
      v_purchase_price * v_quantity,
      v_supplier_name,
      v_supplier_id,
      COALESCE((v_entry->>'date')::date, current_date),
      v_entry->>'note',
      v_product_size_id
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stock_in(jsonb) TO authenticated;

-- ─── 5b) stock_out (chiqim 'manual', brak 'brak', 'sale') ──────────────────
-- Body from 20260719000002. Added: the product_sizes row is locked and
-- read with its branch; assert_branch_access(row.branch_id). A row that is
-- not found keeps the old behaviour (the stock UPDATE below raises
-- 'Insufficient stock for product_size %').

CREATE OR REPLACE FUNCTION public.stock_out(
  p_entries jsonb,
  p_entry_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_entry jsonb;
  v_product_size_id uuid;
  v_quantity integer;
  v_sell_price numeric;
  v_color text;
  v_size_branch uuid;
BEGIN
  IF p_entry_type NOT IN ('sale', 'brak', 'manual') THEN
    RAISE EXCEPTION 'Invalid entry_type: %', p_entry_type;
  END IF;

  IF p_entry_type = 'manual' AND NOT public.has_permission('chiqim') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_entry_type = 'brak' AND NOT public.has_permission('brak') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_entry_type = 'sale' AND NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_entries IS NULL OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'No entries to record';
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    v_product_size_id := NULLIF(v_entry->>'product_size_id', '')::uuid;
    v_quantity := (v_entry->>'quantity')::integer;
    v_sell_price := COALESCE((v_entry->>'sell_price')::numeric, 0);

    IF v_product_size_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid stock-out entry: %', v_entry;
    END IF;

    v_color := NULL;
    v_size_branch := NULL;
    SELECT color, branch_id INTO v_color, v_size_branch
    FROM public.product_sizes
    WHERE id = v_product_size_id AND company_id = v_company_id
    FOR UPDATE;

    IF FOUND THEN
      PERFORM public.assert_branch_access(v_size_branch);
    END IF;

    INSERT INTO public.stock_out_entries (
      company_id, product_id, product_name, category, size, color,
      quantity, sell_price, total_amount, customer_id, customer_name,
      payment_method, date, note, entry_type, product_size_id
    ) VALUES (
      v_company_id,
      NULLIF(v_entry->>'product_id', '')::uuid,
      v_entry->>'product_name',
      v_entry->>'category',
      v_entry->>'size',
      COALESCE(v_color, ''),
      v_quantity,
      v_sell_price,
      v_sell_price * v_quantity,
      NULLIF(v_entry->>'customer_id', '')::uuid,
      v_entry->>'customer_name',
      v_entry->>'payment_method',
      COALESCE((v_entry->>'date')::date, current_date),
      v_entry->>'note',
      p_entry_type,
      v_product_size_id
    );

    UPDATE public.product_sizes
    SET stock = stock - v_quantity, updated_at = now()
    WHERE id = v_product_size_id
      AND company_id = v_company_id
      AND stock >= v_quantity;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient stock for product_size %', v_product_size_id
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stock_out(jsonb, text) TO authenticated;

-- ─── 5c) delete_stock_in_entry / delete_stock_out_entry ───────────────────
-- Bodies from 20260716000001. Added: the entry is locked and read with its
-- branch; assert_branch_access(entry.branch_id). delete_stock_in_entry keeps
-- its silent no-op for an unknown id.

CREATE OR REPLACE FUNCTION public.delete_stock_in_entry(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('kirim') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.stock_in_entries
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  DELETE FROM public.stock_in_entries
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_stock_in_entry(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_stock_out_entry(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_entry_type text;
  v_branch_id uuid;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT entry_type, branch_id INTO v_entry_type, v_branch_id
  FROM public.stock_out_entries
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found';
  END IF;

  IF v_entry_type = 'brak' AND NOT public.has_permission('brak') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_entry_type IN ('manual', 'sale') AND NOT public.has_permission('chiqim') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  DELETE FROM public.stock_out_entries
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_stock_out_entry(uuid) TO authenticated;

-- ─── 5d) delete_warehouse ──────────────────────────────────────────────────
-- Body from 20260721000001. Added: the warehouse row is locked and read
-- with its branch; assert_branch_access(warehouse.branch_id) - a manager of
-- branch A can no longer delete an (empty) warehouse of branch B. Same
-- error strings; 'Warehouse not found' is now raised before the
-- product_sizes count for an unknown id (it used to come after it, with
-- the same result: count 0 -> not found).

CREATE OR REPLACE FUNCTION public.delete_warehouse(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_ref_count integer;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.warehouses
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  SELECT count(*) INTO v_ref_count
  FROM public.product_sizes
  WHERE warehouse_id = p_id AND company_id = v_company_id;

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION 'Warehouse has % linked product size row(s)', v_ref_count
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.warehouses WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_warehouse(uuid) TO authenticated;

-- ─── 5e) Stock counts ──────────────────────────────────────────────────────
-- Bodies from 20261105000005. Added: create -> warehouse's branch;
-- set/increment/complete/cancel/delete -> count's branch
-- (stock_counts.branch_id is force-derived from the warehouse). The check
-- runs right after the "not found" check, before any status message.

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
  v_warehouse_branch uuid;
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

  IF p_warehouse_id IS NOT NULL THEN
    SELECT w.branch_id INTO v_warehouse_branch
    FROM public.warehouses w
    WHERE w.id = p_warehouse_id AND w.company_id = v_company_id
    FOR KEY SHARE;
  END IF;
  IF v_warehouse_branch IS NULL THEN
    RAISE EXCEPTION 'Warehouse not found';
  END IF;

  PERFORM public.assert_branch_access(v_warehouse_branch);

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

  SELECT id, warehouse_id, status, branch_id INTO v_count
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;

  PERFORM public.assert_branch_access(v_count.branch_id);

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

  SELECT id, warehouse_id, status, branch_id INTO v_count
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;

  PERFORM public.assert_branch_access(v_count.branch_id);

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
  SELECT id, warehouse_id, status, branch_id INTO v_count
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;

  PERFORM public.assert_branch_access(v_count.branch_id);

  IF v_count.status <> 'draft' THEN
    RAISE EXCEPTION 'Count is not open';
  END IF;

  -- b)
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

  -- e)
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

CREATE OR REPLACE FUNCTION public.cancel_stock_count(p_count_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_status text;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT status, branch_id INTO v_status, v_branch_id
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

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

CREATE OR REPLACE FUNCTION public.delete_stock_count(p_count_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_status text;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('inventory') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT status, branch_id INTO v_status, v_branch_id
  FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  IF v_status = 'completed' THEN
    RAISE EXCEPTION 'Completed count cannot be deleted';
  END IF;

  DELETE FROM public.stock_counts
  WHERE id = p_count_id AND company_id = v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_stock_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_stock_count(uuid) TO authenticated;

-- ─── 5f) create_stock_transfer ─────────────────────────────────────────────
-- Body from 20261106000003. Added: the SOURCE warehouse must be in a branch
-- the caller can access (assert_branch_access) -> 'branch_forbidden'. The
-- destination may be any warehouse of the company, including another
-- branch (that is how stock moves between branches); the destination row's
-- branch_id is force-derived from its warehouse by product_sizes_fill_branch_id.
-- Both warehouse rows are locked FOR KEY SHARE (a concurrent
-- update_warehouse move/delete waits for us).

CREATE OR REPLACE FUNCTION public.create_stock_transfer(
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_items jsonb,
  p_note text DEFAULT NULL,
  p_date date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_from_branch uuid;
  v_transfer_id uuid;
  v_number integer;
  v_item jsonb;
  v_quantity integer;
  v_src public.product_sizes%ROWTYPE;
  v_dest_id uuid;
  v_product_name text;
  v_category text;
  v_user_name text;
BEGIN
  IF NOT public.has_permission('peremeshenie') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_from_warehouse_id IS NULL OR p_to_warehouse_id IS NULL OR p_from_warehouse_id = p_to_warehouse_id THEN
    RAISE EXCEPTION 'Invalid warehouses';
  END IF;

  PERFORM 1 FROM public.warehouses
  WHERE company_id = v_company_id AND id IN (p_from_warehouse_id, p_to_warehouse_id)
  ORDER BY id
  FOR KEY SHARE;

  IF (SELECT count(*) FROM public.warehouses
      WHERE company_id = v_company_id AND id IN (p_from_warehouse_id, p_to_warehouse_id)) <> 2 THEN
    RAISE EXCEPTION 'Invalid warehouses';
  END IF;

  SELECT branch_id INTO v_from_branch
  FROM public.warehouses
  WHERE id = p_from_warehouse_id AND company_id = v_company_id;

  PERFORM public.assert_branch_access(v_from_branch);

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items to transfer';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('stock_transfer:' || v_company_id::text));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.stock_transfers WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.stock_transfers (
    company_id, number, from_warehouse_id, to_warehouse_id, date, note, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, p_from_warehouse_id, p_to_warehouse_id,
    COALESCE(p_date, current_date), NULLIF(trim(p_note), ''), auth.uid(), v_user_name
  )
  RETURNING id INTO v_transfer_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity: %', v_item;
    END IF;

    SELECT * INTO v_src
    FROM public.product_sizes
    WHERE id = (v_item->>'product_size_id')::uuid
      AND company_id = v_company_id
      AND warehouse_id = p_from_warehouse_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid product_size_id: %', v_item->>'product_size_id';
    END IF;
    IF v_src.stock < v_quantity THEN
      RAISE EXCEPTION 'Insufficient stock for product_size %', v_src.id;
    END IF;

    UPDATE public.product_sizes
    SET stock = stock - v_quantity, updated_at = now()
    WHERE id = v_src.id;

    INSERT INTO public.product_sizes (
      company_id, product_id, size, color, stock, warehouse_id,
      purchase_price, selling_price, sku, barcode, updated_at
    ) VALUES (
      v_company_id, v_src.product_id, v_src.size, v_src.color, v_quantity, p_to_warehouse_id,
      v_src.purchase_price, v_src.selling_price, v_src.sku, NULLIF(v_src.barcode, ''), now()
    )
    ON CONFLICT (company_id, product_id, size, color, warehouse_id) DO UPDATE
      SET stock = public.product_sizes.stock + excluded.stock,
          updated_at = now()
    RETURNING id INTO v_dest_id;

    -- Price-list prices follow the variant into the new warehouse row.
    INSERT INTO public.price_list_items (price_list_id, product_size_id, company_id, price)
    SELECT price_list_id, v_dest_id, company_id, price
    FROM public.price_list_items
    WHERE product_size_id = v_src.id
    ON CONFLICT (price_list_id, product_size_id) DO NOTHING;

    SELECT name, category INTO v_product_name, v_category
    FROM public.products WHERE id = v_src.product_id;

    INSERT INTO public.stock_transfer_items (
      company_id, transfer_id, product_id, product_name, category, size, color,
      quantity, purchase_price, from_product_size_id, to_product_size_id
    ) VALUES (
      v_company_id, v_transfer_id, v_src.product_id, COALESCE(v_product_name, '—'), v_category,
      v_src.size, v_src.color, v_quantity, COALESCE(v_src.purchase_price, 0), v_src.id, v_dest_id
    );
  END LOOP;

  RETURN v_transfer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_stock_transfer(uuid, uuid, jsonb, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_stock_transfer(uuid, uuid, jsonb, text, date) TO authenticated;

-- ─── 5g) Supplier returns ──────────────────────────────────────────────────
-- Bodies from 20261106000005. Added: create -> warehouse's branch;
-- delete -> the return's branch (supplier_returns.branch_id, force-derived
-- from the warehouse). delete_supplier_return now locks the return row
-- FOR UPDATE before giving stock back: two concurrent deletes of the same
-- return used to be able to BOTH add the stock back (pre-existing race);
-- the second one now gets 'Return not found'.

CREATE OR REPLACE FUNCTION public.create_supplier_return(
  p_supplier_id uuid,
  p_warehouse_id uuid,
  p_items jsonb,
  p_note text DEFAULT NULL,
  p_date date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_warehouse_branch uuid;
  v_return_id uuid;
  v_number integer;
  v_item jsonb;
  v_quantity integer;
  v_price numeric;
  v_src public.product_sizes%ROWTYPE;
  v_product_name text;
  v_category text;
BEGIN
  IF NOT public.has_permission('yetkazuvchilar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = p_supplier_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;

  SELECT w.branch_id INTO v_warehouse_branch
  FROM public.warehouses w
  WHERE w.id = p_warehouse_id AND w.company_id = v_company_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid warehouse';
  END IF;

  PERFORM public.assert_branch_access(v_warehouse_branch);

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items to return';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('supplier_return:' || v_company_id::text));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.supplier_returns WHERE company_id = v_company_id;

  INSERT INTO public.supplier_returns (
    company_id, number, supplier_id, warehouse_id, date, note, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, p_supplier_id, p_warehouse_id, COALESCE(p_date, current_date),
    NULLIF(trim(p_note), ''), auth.uid(), (SELECT full_name FROM public.users WHERE id = auth.uid())
  )
  RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_quantity := (v_item->>'quantity')::integer;
    v_price := COALESCE((v_item->>'price')::numeric, 0);
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity: %', v_item;
    END IF;
    IF v_price < 0 THEN
      RAISE EXCEPTION 'Invalid price: %', v_item;
    END IF;

    SELECT * INTO v_src
    FROM public.product_sizes
    WHERE id = (v_item->>'product_size_id')::uuid
      AND company_id = v_company_id
      AND warehouse_id = p_warehouse_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid product_size_id: %', v_item->>'product_size_id';
    END IF;
    IF v_src.stock < v_quantity THEN
      RAISE EXCEPTION 'Insufficient stock for product_size %', v_src.id;
    END IF;

    UPDATE public.product_sizes SET stock = stock - v_quantity, updated_at = now() WHERE id = v_src.id;

    SELECT name, category INTO v_product_name, v_category FROM public.products WHERE id = v_src.product_id;

    INSERT INTO public.supplier_return_items (
      company_id, return_id, product_size_id, product_id, product_name, category, size, color, quantity, price
    ) VALUES (
      v_company_id, v_return_id, v_src.id, v_src.product_id, COALESCE(v_product_name, '—'), v_category,
      v_src.size, v_src.color, v_quantity, v_price
    );
  END LOOP;

  RETURN v_return_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_supplier_return(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('yetkazuvchilar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.supplier_returns
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  UPDATE public.product_sizes ps
  SET stock = ps.stock + i.qty, updated_at = now()
  FROM (
    SELECT product_size_id, sum(quantity) AS qty
    FROM public.supplier_return_items
    WHERE return_id = p_id AND product_size_id IS NOT NULL
    GROUP BY product_size_id
  ) i
  WHERE ps.id = i.product_size_id AND ps.company_id = v_company_id;

  DELETE FROM public.supplier_returns WHERE id = p_id AND company_id = v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_supplier_return(uuid, uuid, jsonb, text, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.delete_supplier_return(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_supplier_return(uuid, uuid, jsonb, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_supplier_return(uuid) TO authenticated;

-- ─── 5h) return_items (customer return of a sale) ──────────────────────────
-- Body from 20260717000001. Added:
--   * the transaction is read with its branch and locked FOR UPDATE;
--     assert_branch_access(transaction.branch_id) -> 'branch_forbidden'.
--     The lock also serializes concurrent returns of the same sale, so two
--     returns can no longer both pass the "returned + requested <= sold"
--     check (pre-existing read-then-write race).
--   * returns.branch_id = the transaction's branch, explicitly.

CREATE OR REPLACE FUNCTION public.return_items(
  p_transaction_id uuid,
  p_items jsonb,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_txn_status text;
  v_txn_branch uuid;
  v_return_id uuid;
  v_item jsonb;
  v_transaction_item_id uuid;
  v_quantity integer;
  v_ti RECORD;
  v_size text;
  v_category text;
  v_refund_amount numeric;
  v_fully_returned boolean;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items to return';
  END IF;

  SELECT status, branch_id INTO v_txn_status, v_txn_branch
  FROM public.transactions
  WHERE id = p_transaction_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;

  PERFORM public.assert_branch_access(v_txn_branch);

  IF v_txn_status != 'completed' THEN
    RAISE EXCEPTION 'Only a completed transaction can be returned';
  END IF;

  INSERT INTO public.returns (company_id, branch_id, transaction_id, created_by, reason)
  VALUES (v_company_id, v_txn_branch, p_transaction_id, auth.uid(), trim(p_reason))
  RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_transaction_item_id := NULLIF(v_item->>'transaction_item_id', '')::uuid;
    v_quantity := (v_item->>'quantity')::integer;

    IF v_transaction_item_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid return line: %', v_item;
    END IF;

    SELECT id, product_id, product_name, quantity AS sold_quantity,
           returned_quantity, price, product_size_id
    INTO v_ti
    FROM public.transaction_items
    WHERE id = v_transaction_item_id
      AND transaction_id = p_transaction_id
      AND company_id = v_company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction item not found: %', v_transaction_item_id;
    END IF;

    IF v_ti.product_size_id IS NULL THEN
      RAISE EXCEPTION 'Item % has no recorded variant and cannot be returned', v_ti.product_name;
    END IF;

    IF (v_ti.returned_quantity + v_quantity) > v_ti.sold_quantity THEN
      RAISE EXCEPTION 'Return quantity for % exceeds sold quantity (sold %, already returned %, requested %)',
        v_ti.product_name, v_ti.sold_quantity, v_ti.returned_quantity, v_quantity
        USING ERRCODE = 'P0001';
    END IF;

    v_refund_amount := v_ti.price * v_quantity;

    SELECT ps.size, p.category INTO v_size, v_category
    FROM public.product_sizes ps
    JOIN public.products p ON p.id = ps.product_id
    WHERE ps.id = v_ti.product_size_id;

    INSERT INTO public.return_items (
      return_id, transaction_item_id, product_size_id, quantity, refund_amount
    ) VALUES (
      v_return_id, v_transaction_item_id, v_ti.product_size_id, v_quantity, v_refund_amount
    );

    INSERT INTO public.stock_in_entries (
      company_id, product_id, product_name, category, size,
      quantity, unit_price, purchase_price, total_amount, date, note,
      entry_type, product_size_id
    ) VALUES (
      v_company_id, v_ti.product_id, v_ti.product_name, v_category, v_size,
      v_quantity, v_ti.price, v_ti.price, v_ti.price * v_quantity, current_date,
      trim(p_reason), 'return', v_ti.product_size_id
    );

    UPDATE public.product_sizes
    SET stock = stock + v_quantity, updated_at = now()
    WHERE id = v_ti.product_size_id AND company_id = v_company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'product_sizes row not found for %', v_ti.product_size_id;
    END IF;

    UPDATE public.transaction_items
    SET returned_quantity = returned_quantity + v_quantity
    WHERE id = v_transaction_item_id;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.transaction_items
    WHERE transaction_id = p_transaction_id AND returned_quantity < quantity
  ) INTO v_fully_returned;

  IF v_fully_returned THEN
    UPDATE public.transactions SET status = 'cancelled' WHERE id = p_transaction_id;
  END IF;

  RETURN v_return_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.return_items(uuid, jsonb, text) TO authenticated;

-- ─── 5i) set_product_size_companion (per-row variant link) ────────────────
-- Body from 20261104000001. Added: the row must be in an accessible branch
-- ('branch_forbidden'), and the companion (bottle) must be in the SAME
-- branch as the row ('wrong_branch') - otherwise POS would add a cart line
-- from another branch and sell_cart would reject the sale. Per-row link,
-- not shared catalog -> not catalog-gated.

CREATE OR REPLACE FUNCTION public.set_product_size_companion(p_id uuid, p_companion_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_row_branch uuid;
  v_companion_branch uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Product size is required';
  END IF;

  SELECT branch_id INTO v_row_branch
  FROM public.product_sizes
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product size not found';
  END IF;

  PERFORM public.assert_branch_access(v_row_branch);

  IF p_companion_id IS NOT NULL THEN
    IF p_companion_id = p_id THEN
      RAISE EXCEPTION 'A product size cannot be its own companion';
    END IF;
    SELECT branch_id INTO v_companion_branch
    FROM public.product_sizes
    WHERE id = p_companion_id AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Companion product size not found';
    END IF;
    IF v_companion_branch IS DISTINCT FROM v_row_branch THEN
      RAISE EXCEPTION 'wrong_branch';
    END IF;
  END IF;

  UPDATE public.product_sizes
  SET companion_product_size_id = p_companion_id, updated_at = now()
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product size not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_product_size_companion(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_size_companion(uuid, uuid) TO authenticated;

-- ─── 6) Shared catalog: owner/admin only ('catalog_forbidden') ────────────
-- Each body is the latest definition, unchanged except for
-- PERFORM public.catalog_require_admin() right after the existing
-- has_permission() check (so a caller without the permission still gets
-- 'forbidden'; with the permission but not owner/admin -> 'catalog_forbidden').
-- create_product / update_product keep accepting ANY company warehouse for
-- products.warehouse_id ("home warehouse"), no branch restriction.

-- 6a) create_product (20261105000001)
CREATE OR REPLACE FUNCTION public.create_product(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_warehouse_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Product name is required';
  END IF;

  v_warehouse_id := NULLIF(p_data->>'warehouse_id', '')::uuid;
  IF v_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouses WHERE id = v_warehouse_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid warehouse';
  END IF;

  INSERT INTO public.products (
    company_id, name, sku, category, price, min_stock, colors, description, status, warehouse_id,
    barcode, image_url
  ) VALUES (
    v_company_id,
    trim(p_data->>'name'),
    NULLIF(p_data->>'sku', ''),
    p_data->>'category',
    COALESCE((p_data->>'price')::numeric, 0),
    COALESCE((p_data->>'min_stock')::integer, 5),
    CASE WHEN p_data ? 'colors'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'colors'))
      ELSE '{}'::text[]
    END,
    p_data->>'description',
    COALESCE(p_data->>'status', 'active'),
    v_warehouse_id,
    NULLIF(p_data->>'barcode', ''),
    NULLIF(p_data->>'image_url', '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product(jsonb) TO authenticated;

-- 6b) update_product (20261105000001)
CREATE OR REPLACE FUNCTION public.update_product(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_warehouse_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data ? 'warehouse_id' THEN
    v_warehouse_id := NULLIF(p_data->>'warehouse_id', '')::uuid;
    IF v_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'Warehouse is required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.warehouses WHERE id = v_warehouse_id AND company_id = v_company_id
    ) THEN
      RAISE EXCEPTION 'Invalid warehouse';
    END IF;
  END IF;

  UPDATE public.products SET
    name = CASE WHEN p_data ? 'name' THEN trim(p_data->>'name') ELSE name END,
    sku = CASE WHEN p_data ? 'sku' THEN NULLIF(p_data->>'sku', '') ELSE sku END,
    category = CASE WHEN p_data ? 'category' THEN p_data->>'category' ELSE category END,
    price = CASE WHEN p_data ? 'price' THEN COALESCE((p_data->>'price')::numeric, price) ELSE price END,
    min_stock = CASE WHEN p_data ? 'min_stock' THEN COALESCE((p_data->>'min_stock')::integer, min_stock) ELSE min_stock END,
    colors = CASE WHEN p_data ? 'colors'
      THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'colors'))
      ELSE colors
    END,
    description = CASE WHEN p_data ? 'description' THEN p_data->>'description' ELSE description END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END,
    warehouse_id = CASE WHEN p_data ? 'warehouse_id' THEN v_warehouse_id ELSE warehouse_id END,
    barcode = CASE WHEN p_data ? 'barcode' THEN NULLIF(p_data->>'barcode', '') ELSE barcode END,
    image_url = CASE WHEN p_data ? 'image_url' THEN NULLIF(p_data->>'image_url', '') ELSE image_url END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_product(uuid, jsonb) TO authenticated;

-- 6c) delete_product (20260718000001)
CREATE OR REPLACE FUNCTION public.delete_product(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.products WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_product(uuid) TO authenticated;

-- 6d) create_product_group (20260718000001)
CREATE OR REPLACE FUNCTION public.create_product_group(p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulot_guruhi') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_data IS NULL OR NULLIF(trim(p_data->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'Group name is required';
  END IF;

  INSERT INTO public.product_groups (company_id, name, description, status, size_type)
  VALUES (
    v_company_id,
    trim(p_data->>'name'),
    p_data->>'description',
    COALESCE(p_data->>'status', 'active'),
    COALESCE(p_data->>'size_type', 'clothing')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_product_group(jsonb) TO authenticated;

-- 6e) update_product_group (20260718000001)
CREATE OR REPLACE FUNCTION public.update_product_group(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulot_guruhi') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  UPDATE public.product_groups SET
    name = CASE WHEN p_data ? 'name' THEN trim(p_data->>'name') ELSE name END,
    description = CASE WHEN p_data ? 'description' THEN p_data->>'description' ELSE description END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END,
    size_type = CASE WHEN p_data ? 'size_type' THEN p_data->>'size_type' ELSE size_type END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product group not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_product_group(uuid, jsonb) TO authenticated;

-- 6f) delete_product_group (20260718000001)
CREATE OR REPLACE FUNCTION public.delete_product_group(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulot_guruhi') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.product_groups WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product group not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_product_group(uuid) TO authenticated;

-- 6g) set_product_size_barcode (20261106000003): writes the barcode of
-- EVERY warehouse row of the variant, across all branches -> shared catalog.
CREATE OR REPLACE FUNCTION public.set_product_size_barcode(p_id uuid, p_barcode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_row public.product_sizes%ROWTYPE;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_barcode IS NULL OR trim(p_barcode) = '' THEN
    RAISE EXCEPTION 'Barcode is required';
  END IF;

  SELECT * INTO v_row FROM public.product_sizes WHERE id = p_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product size not found';
  END IF;

  UPDATE public.product_sizes
  SET barcode = p_barcode, updated_at = now()
  WHERE company_id = v_company_id AND product_id = v_row.product_id
    AND size = v_row.size AND color = v_row.color;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_product_size_barcode(uuid, text) TO authenticated;

-- 6h) save_price_list (20261106000001)
CREATE OR REPLACE FUNCTION public.save_price_list(
  p_id uuid, p_name text, p_base text, p_adjust_percent numeric, p_rounding integer, p_is_active boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
  v_id uuid;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.price_lists (company_id, name, base, adjust_percent, rounding, is_active)
    VALUES (v_company_id, trim(p_name), p_base, COALESCE(p_adjust_percent, 0), COALESCE(p_rounding, 0), COALESCE(p_is_active, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.price_lists
    SET name = trim(p_name), base = p_base, adjust_percent = COALESCE(p_adjust_percent, 0),
        rounding = COALESCE(p_rounding, 0), is_active = COALESCE(p_is_active, true)
    WHERE id = p_id AND company_id = v_company_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Price list not found';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.save_price_list(uuid, text, text, numeric, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_price_list(uuid, text, text, numeric, integer, boolean) TO authenticated;

-- 6i) delete_price_list (20261106000001) + NULL company guard
CREATE OR REPLACE FUNCTION public.delete_price_list(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;
  DELETE FROM public.price_lists WHERE id = p_id AND company_id = v_company_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.delete_price_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_price_list(uuid) TO authenticated;

-- 6j) set_price_list_item (20261106000003, variant-wide) + NULL company guard
CREATE OR REPLACE FUNCTION public.set_price_list_item(p_price_list_id uuid, p_product_size_id uuid, p_price numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
  v_row public.product_sizes%ROWTYPE;
BEGIN
  IF NOT public.has_permission('mahsulotlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.price_lists WHERE id = p_price_list_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'Price list not found';
  END IF;
  SELECT * INTO v_row FROM public.product_sizes WHERE id = p_product_size_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid product_size_id';
  END IF;
  IF p_price IS NOT NULL AND p_price < 0 THEN
    RAISE EXCEPTION 'Invalid price';
  END IF;

  IF p_price IS NULL THEN
    DELETE FROM public.price_list_items pli
    USING public.product_sizes ps
    WHERE pli.price_list_id = p_price_list_id
      AND pli.product_size_id = ps.id
      AND ps.company_id = v_company_id AND ps.product_id = v_row.product_id
      AND ps.size = v_row.size AND ps.color = v_row.color;
  ELSE
    INSERT INTO public.price_list_items (price_list_id, product_size_id, company_id, price)
    SELECT p_price_list_id, ps.id, v_company_id, p_price
    FROM public.product_sizes ps
    WHERE ps.company_id = v_company_id AND ps.product_id = v_row.product_id
      AND ps.size = v_row.size AND ps.color = v_row.color
    ON CONFLICT (price_list_id, product_size_id) DO UPDATE SET price = EXCLUDED.price;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_price_list_item(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_price_list_item(uuid, uuid, numeric) TO authenticated;

-- 6k) create_promotion (20260723000004)
CREATE OR REPLACE FUNCTION public.create_promotion(
  p_name text,
  p_discount_percent numeric,
  p_scope_type text,
  p_category text,
  p_starts_on date,
  p_ends_on date,
  p_product_size_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_category text;
  v_id uuid;
  v_input_count integer;
  v_valid_count integer;
BEGIN
  IF NOT public.has_permission('marketing') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Promotion name is required';
  END IF;

  IF p_discount_percent IS NULL OR p_discount_percent < 0 OR p_discount_percent > 100 THEN
    RAISE EXCEPTION 'discount_percent must be between 0 and 100';
  END IF;

  IF p_scope_type IS NULL OR p_scope_type NOT IN ('product', 'category', 'store') THEN
    RAISE EXCEPTION 'Invalid scope_type: %', p_scope_type;
  END IF;

  v_category := NULLIF(trim(coalesce(p_category, '')), '');

  IF p_scope_type = 'category' THEN
    IF v_category IS NULL THEN
      RAISE EXCEPTION 'category is required when scope_type = ''category''';
    END IF;
  ELSE
    IF v_category IS NOT NULL THEN
      RAISE EXCEPTION 'category must be empty unless scope_type = ''category''';
    END IF;
  END IF;

  IF p_scope_type = 'product' THEN
    IF p_product_size_ids IS NULL OR cardinality(p_product_size_ids) = 0 THEN
      RAISE EXCEPTION 'p_product_size_ids is required when scope_type = ''product''';
    END IF;
  ELSE
    IF p_product_size_ids IS NOT NULL AND cardinality(p_product_size_ids) > 0 THEN
      RAISE EXCEPTION 'p_product_size_ids must be empty unless scope_type = ''product''';
    END IF;
  END IF;

  IF p_scope_type = 'product' THEN
    SELECT count(DISTINCT x) INTO v_input_count FROM unnest(p_product_size_ids) x;
    SELECT count(DISTINCT ps.id) INTO v_valid_count
      FROM public.product_sizes ps
      WHERE ps.id = ANY(p_product_size_ids) AND ps.company_id = v_company_id;

    IF v_valid_count IS DISTINCT FROM v_input_count THEN
      RAISE EXCEPTION 'One or more product sizes do not belong to this company';
    END IF;
  END IF;

  INSERT INTO public.promotions (
    company_id, name, discount_percent, scope_type, category, starts_on, ends_on
  ) VALUES (
    v_company_id, trim(p_name), p_discount_percent, p_scope_type, v_category, p_starts_on, p_ends_on
  )
  RETURNING id INTO v_id;

  IF p_scope_type = 'product' THEN
    INSERT INTO public.promotion_products (company_id, promotion_id, product_size_id)
    SELECT v_company_id, v_id, x FROM (SELECT DISTINCT unnest(p_product_size_ids) AS x) u;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_promotion(text, numeric, text, text, date, date, uuid[]) TO authenticated;

-- 6l) update_promotion (20260723000004)
CREATE OR REPLACE FUNCTION public.update_promotion(
  p_id uuid,
  p_name text,
  p_discount_percent numeric,
  p_scope_type text,
  p_category text,
  p_starts_on date,
  p_ends_on date,
  p_is_active boolean,
  p_product_size_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_category text;
  v_input_count integer;
  v_valid_count integer;
BEGIN
  IF NOT public.has_permission('marketing') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Promotion name is required';
  END IF;

  IF p_discount_percent IS NULL OR p_discount_percent < 0 OR p_discount_percent > 100 THEN
    RAISE EXCEPTION 'discount_percent must be between 0 and 100';
  END IF;

  IF p_scope_type IS NULL OR p_scope_type NOT IN ('product', 'category', 'store') THEN
    RAISE EXCEPTION 'Invalid scope_type: %', p_scope_type;
  END IF;

  v_category := NULLIF(trim(coalesce(p_category, '')), '');

  IF p_scope_type = 'category' THEN
    IF v_category IS NULL THEN
      RAISE EXCEPTION 'category is required when scope_type = ''category''';
    END IF;
  ELSE
    IF v_category IS NOT NULL THEN
      RAISE EXCEPTION 'category must be empty unless scope_type = ''category''';
    END IF;
  END IF;

  IF p_scope_type = 'product' THEN
    IF p_product_size_ids IS NULL OR cardinality(p_product_size_ids) = 0 THEN
      RAISE EXCEPTION 'p_product_size_ids is required when scope_type = ''product''';
    END IF;
  ELSE
    IF p_product_size_ids IS NOT NULL AND cardinality(p_product_size_ids) > 0 THEN
      RAISE EXCEPTION 'p_product_size_ids must be empty unless scope_type = ''product''';
    END IF;
  END IF;

  IF p_scope_type = 'product' THEN
    SELECT count(DISTINCT x) INTO v_input_count FROM unnest(p_product_size_ids) x;
    SELECT count(DISTINCT ps.id) INTO v_valid_count
      FROM public.product_sizes ps
      WHERE ps.id = ANY(p_product_size_ids) AND ps.company_id = v_company_id;

    IF v_valid_count IS DISTINCT FROM v_input_count THEN
      RAISE EXCEPTION 'One or more product sizes do not belong to this company';
    END IF;
  END IF;

  UPDATE public.promotions SET
    name = trim(p_name),
    discount_percent = p_discount_percent,
    scope_type = p_scope_type,
    category = v_category,
    starts_on = p_starts_on,
    ends_on = p_ends_on,
    is_active = COALESCE(p_is_active, is_active)
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Promotion not found';
  END IF;

  DELETE FROM public.promotion_products
  WHERE promotion_id = p_id AND company_id = v_company_id;

  IF p_scope_type = 'product' THEN
    INSERT INTO public.promotion_products (company_id, promotion_id, product_size_id)
    SELECT v_company_id, p_id, x FROM (SELECT DISTINCT unnest(p_product_size_ids) AS x) u;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_promotion(uuid, text, numeric, text, text, date, date, boolean, uuid[]) TO authenticated;

-- 6m) delete_promotion (20260723000004)
CREATE OR REPLACE FUNCTION public.delete_promotion(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('marketing') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM public.catalog_require_admin();

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  DELETE FROM public.promotions WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Promotion not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_promotion(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- 1) policies on the scoped tables (expect only "Branch isolation..." + any super-admin)
-- SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies
-- WHERE schemaname = 'public' AND tablename IN
--   ('product_sizes','transactions','transaction_items','stock_out_entries','shifts',
--    'returns','return_items','stock_counts','stock_count_items','stock_transfers','stock_transfer_items')
-- ORDER BY 1, 2;
--
-- -- 2) exactly one pos_catalog / pos_lookups overload, taking uuid (expect 2 rows)
-- SELECT oid::regprocedure FROM pg_proc
-- WHERE pronamespace = 'public'::regnamespace AND proname IN ('pos_catalog', 'pos_lookups');
--
-- -- 3) transactions_net still works under the new RLS (security_invoker):
-- --    as a user, view rows == base-table rows, and every row is in an allowed branch.
-- --    (run with SET LOCAL ROLE authenticated + request.jwt.claims of a staff user)
-- SELECT (SELECT count(*) FROM public.transactions_net) = (SELECT count(*) FROM public.transactions) AS same_count,
--        bool_and(branch_id = ANY (public.get_branch_ids())) AS all_in_scope
-- FROM public.transactions_net;
--
-- -- 4) helper not callable by clients (expect false, false)
-- SELECT has_function_privilege('authenticated', 'public.catalog_require_admin()', 'EXECUTE'),
--        has_function_privilege('anon', 'public.catalog_require_admin()', 'EXECUTE');
--
-- -- 5) shift guard attached
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.shifts'::regclass AND NOT tgisinternal;
