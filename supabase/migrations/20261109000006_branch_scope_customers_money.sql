-- Branches (filiallar) - PHASE 4 (DB): branch scoping for customers and
-- money ledgers (nasiya, loyalty, expenses, requests / murojat).
--
-- Contents
--   1) RLS: branch-scoped reads on customers, nasiya_transactions,
--      loyalty_transactions, expenses, requests; murojat_messages via
--      semi-join on requests (+ post-check)
--   2) create_customer(..., p_branch_id) / create_expense(..., p_branch_id)
--   3) branch checks: set_customer_vip, set_customer_price_list,
--      delete_expense, update_request, send_murojat_reply,
--      get_murojat_messages
--   4) branch checks: give_nasiya, repay_nasiya, get_customer_nasiya_balance,
--      earn_loyalty, redeem_loyalty, use_cashback,
--      get_customer_loyalty_balance
--   5) move_customer_branch(p_customer_id, p_branch_id)
--   6) branch_fill_from_parent: customer parent read FOR SHARE (makes
--      move_customer_branch race-free for the telegram webhook insert)
--
-- UNCHANGED (company-wide, by design): expense_categories, loyalty_config,
-- purchases (legacy).
--
-- Customers model: one person = one customer row (company-wide). There is
-- NO unique constraint on customers.phone in any migration; none is added
-- here. A customer belongs to exactly one branch and is MOVED between
-- branches with move_customer_branch (all of their nasiya / loyalty /
-- request rows move with them, so balances stay whole). Past sales
-- (transactions) stay in the branch where the sale happened.
--
-- Telegram webhook (app/api/telegram/webhook/route.ts, service role)
-- inserts public.requests with customer_id and no branch_id:
-- requests_fill_branch_id ('customer', 'customer_id', 'if_null') gives the
-- request the customer's branch. murojat_messages has no branch_id; it
-- follows its request through the RLS semi-join below.
--
-- WARNING - DROP POLICY (no data loss): every existing policy on the 6
-- tables in section 1 is dropped and replaced (super-admin policies, if
-- any exist in the live DB, are kept). A post-check aborts the file if any
-- remaining policy there is not branch-scoped.
--
-- WARNING - DROP FUNCTION (no data loss): create_customer(text, text, text,
-- text, text) and create_expense(jsonb) are dropped and re-created with a
-- trailing p_branch_id uuid DEFAULT NULL, inside this transaction.
-- Existing named-arg calls resolve to the new signatures unchanged.
--
-- Every other function is CREATE OR REPLACE with the SAME signature, same
-- permission key and same error strings; only the listed additions.
--
-- Runs as one transaction (BEGIN/COMMIT).

BEGIN;

-- ─── 1) RLS ────────────────────────────────────────────────────────────────

DO $drop_policies$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'customers', 'nasiya_transactions', 'loyalty_transactions',
        'expenses', 'requests', 'murojat_messages'
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

ALTER TABLE public.customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nasiya_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.murojat_messages     ENABLE ROW LEVEL SECURITY;

-- SELECT only: INSERT/UPDATE/DELETE are revoked from authenticated on all
-- six tables (20260723000006, 20260723000007, 20260723000009,
-- 20260806000002); writes go through the RPCs below or the service role.

CREATE POLICY "Branch isolation (select)" ON public.customers
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation (select)" ON public.nasiya_transactions
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation (select)" ON public.loyalty_transactions
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation (select)" ON public.expenses
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation (select)" ON public.requests
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND branch_id = ANY ((SELECT public.get_branch_ids())::uuid[]));

CREATE POLICY "Branch isolation via request (select)" ON public.murojat_messages
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id())
         AND request_id IN (
           SELECT r.id FROM public.requests r
           WHERE r.company_id = (SELECT public.get_company_id())
             AND r.branch_id = ANY ((SELECT public.get_branch_ids())::uuid[])
         ));

DO $post_check$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'customers', 'nasiya_transactions', 'loyalty_transactions',
        'expenses', 'requests', 'murojat_messages'
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

-- ─── 6) branch_fill_from_parent: lock the customer parent ─────────────────
-- Body from 20261109000002, unchanged except the 'customer' lookup is
-- FOR SHARE. Why: move_customer_branch locks the customer FOR UPDATE and
-- re-points the customer's ledger rows. A concurrent insert that derived
-- the branch from an unlocked read could land in the OLD branch after the
-- move (FK checks only take KEY SHARE, which does not conflict with a
-- non-key UPDATE). FOR SHARE waits for the move and then reads the new
-- branch. Only nasiya_transactions, loyalty_transactions and requests use
-- the 'customer' kind, and only when branch_id was not supplied (the RPCs
-- below always supply it; the telegram webhook does not).

CREATE OR REPLACE FUNCTION public.branch_fill_from_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text := TG_ARGV[0];
  v_force boolean := COALESCE(TG_ARGV[2], 'if_null') = 'force';
  v_parent_id uuid;
  v_branch uuid;
BEGIN
  IF NEW.branch_id IS NOT NULL AND NOT v_force THEN
    RETURN NEW;
  END IF;

  IF v_kind <> 'context' THEN
    v_parent_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[1], '')::uuid;

    IF v_parent_id IS NOT NULL THEN
      CASE v_kind
        WHEN 'warehouse' THEN
          SELECT w.branch_id INTO v_branch
          FROM public.warehouses w
          WHERE w.id = v_parent_id AND w.company_id = NEW.company_id;
        WHEN 'product_size' THEN
          SELECT ps.branch_id INTO v_branch
          FROM public.product_sizes ps
          WHERE ps.id = v_parent_id AND ps.company_id = NEW.company_id;
        WHEN 'transaction' THEN
          SELECT t.branch_id INTO v_branch
          FROM public.transactions t
          WHERE t.id = v_parent_id AND t.company_id = NEW.company_id;
        WHEN 'customer' THEN
          SELECT c.branch_id INTO v_branch
          FROM public.customers c
          WHERE c.id = v_parent_id AND c.company_id = NEW.company_id
          FOR SHARE;
        ELSE
          RAISE EXCEPTION 'branch_fill_from_parent: unknown parent kind %', v_kind;
      END CASE;
    END IF;
  END IF;

  IF v_branch IS NULL THEN
    IF NEW.branch_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_branch := public.branch_default_for_write(NEW.company_id);
  END IF;

  NEW.branch_id := v_branch;
  RETURN NEW;
END;
$$;

-- ─── 2a) create_customer + p_branch_id ─────────────────────────────────────
-- Body from 20260723000006. Added: branch = resolve_branch_id(p_branch_id)
-- (scoped user -> own branch, another -> 'branch_forbidden'; owner/admin ->
-- requested active branch, NULL -> own active branch -> default), passed
-- explicitly on insert.

DROP FUNCTION IF EXISTS public.create_customer(text, text, text, text, text);

CREATE FUNCTION public.create_customer(
  p_full_name text,
  p_phone text,
  p_email text,
  p_address text,
  p_status text DEFAULT 'New',
  p_branch_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_status text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('customers') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'full_name is required';
  END IF;

  IF p_phone IS NULL OR trim(p_phone) = '' THEN
    RAISE EXCEPTION 'phone is required';
  END IF;

  v_status := NULLIF(trim(coalesce(p_status, '')), '');
  IF v_status IS NULL THEN
    v_status := 'New';
  END IF;
  IF v_status NOT IN ('VIP', 'Regular', 'New') THEN
    RAISE EXCEPTION 'Invalid status: %', v_status;
  END IF;

  v_branch_id := public.resolve_branch_id(p_branch_id);

  INSERT INTO public.customers (
    company_id, branch_id, full_name, phone, email, address, status
  ) VALUES (
    v_company_id,
    v_branch_id,
    trim(p_full_name),
    trim(p_phone),
    NULLIF(trim(coalesce(p_email, '')), ''),
    NULLIF(trim(coalesce(p_address, '')), ''),
    v_status
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer(text, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_customer(text, text, text, text, text, uuid) TO authenticated;

-- ─── 2b) create_expense + p_branch_id ──────────────────────────────────────
-- Body from 20260723000009. Added: branch = resolve_branch_id(p_branch_id).

DROP FUNCTION IF EXISTS public.create_expense(jsonb);

CREATE FUNCTION public.create_expense(p_data jsonb, p_branch_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_category_id uuid;
  v_amount numeric;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('xarajatlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  v_amount := NULLIF(p_data->>'amount', '')::numeric;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  v_category_id := NULLIF(p_data->>'category_id', '')::uuid;
  IF v_category_id IS NOT NULL THEN
    PERFORM 1 FROM public.expense_categories
    WHERE id = v_category_id AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expense category not found';
    END IF;
  END IF;

  v_branch_id := public.resolve_branch_id(p_branch_id);

  INSERT INTO public.expenses (
    company_id, branch_id, category_id, amount, payment_method, date, note, created_by
  ) VALUES (
    v_company_id,
    v_branch_id,
    v_category_id,
    v_amount,
    COALESCE(NULLIF(p_data->>'payment_method', ''), 'cash'),
    COALESCE(NULLIF(p_data->>'date', '')::date, CURRENT_DATE),
    NULLIF(trim(p_data->>'note'), ''),
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_expense(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_expense(jsonb, uuid) TO authenticated;

-- ─── 3a) delete_expense ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_expense(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('xarajatlar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.expenses
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  DELETE FROM public.expenses WHERE id = p_id AND company_id = v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_expense(uuid) TO authenticated;

-- ─── 3b) set_customer_vip (20260723000007) ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_customer_vip(
  p_customer_id uuid,
  p_vip_discount_percent numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('marketing') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_vip_discount_percent IS NOT NULL
     AND (p_vip_discount_percent < 0 OR p_vip_discount_percent > 100) THEN
    RAISE EXCEPTION 'vip_discount_percent must be NULL or between 0 and 100';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  UPDATE public.customers
  SET
    vip_discount_percent = p_vip_discount_percent,
    vip_since = CASE
      WHEN p_vip_discount_percent IS NOT NULL AND p_vip_discount_percent > 0 THEN
        CASE
          WHEN customers.vip_discount_percent IS NULL OR customers.vip_discount_percent = 0
            THEN current_date
          ELSE customers.vip_since
        END
      ELSE NULL
    END
  WHERE id = p_customer_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_customer_vip(uuid, numeric) TO authenticated;

-- ─── 3c) set_customer_price_list (20261106000001) ──────────────────────────
-- Assigning a customer to a (company-wide) price list is a customer edit,
-- not a catalog edit: same permission as before, plus the customer's branch.

CREATE OR REPLACE FUNCTION public.set_customer_price_list(p_customer_id uuid, p_price_list_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid := public.get_company_id();
  v_branch_id uuid;
BEGIN
  IF NOT (public.has_permission('mahsulotlar') OR public.has_permission('customers')) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;
  IF p_price_list_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.price_lists WHERE id = p_price_list_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Price list not found';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  UPDATE public.customers SET price_list_id = p_price_list_id
  WHERE id = p_customer_id AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_customer_price_list(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_customer_price_list(uuid, uuid) TO authenticated;

-- ─── 3d) Requests / murojat (20260723000009, 20260806000002) ──────────────

CREATE OR REPLACE FUNCTION public.update_request(p_id uuid, p_data jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('requests') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.requests
  WHERE id = p_id AND company_id = v_company_id
  FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  UPDATE public.requests SET
    notes = CASE WHEN p_data ? 'notes' THEN p_data->>'notes' ELSE notes END,
    status = CASE WHEN p_data ? 'status' THEN p_data->>'status' ELSE status END
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_request(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.send_murojat_reply(p_request_id uuid, p_message text)
RETURNS public.murojat_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_customer_id uuid;
  v_branch_id uuid;
  v_row public.murojat_messages;
BEGIN
  IF NOT public.has_permission('requests') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_message IS NULL OR trim(p_message) = '' THEN
    RAISE EXCEPTION 'Message cannot be empty';
  END IF;

  SELECT customer_id, branch_id INTO v_customer_id, v_branch_id
  FROM public.requests
  WHERE id = p_request_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  INSERT INTO public.murojat_messages (
    company_id, request_id, customer_id, sender, message
  ) VALUES (
    v_company_id, p_request_id, v_customer_id, 'store', trim(p_message)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_murojat_reply(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_murojat_messages(p_request_id uuid)
RETURNS SETOF public.murojat_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.requests
  WHERE id = p_request_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid request_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  RETURN QUERY
  SELECT *
  FROM public.murojat_messages
  WHERE request_id = p_request_id AND company_id = v_company_id
  ORDER BY sent_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_murojat_messages(uuid) TO authenticated;

-- ─── 4) Nasiya + loyalty (20260723000007, 20260723000008) ─────────────────
-- Every write RPC reads the customer FOR SHARE (serializes with
-- move_customer_branch, which takes FOR UPDATE), checks
-- assert_branch_access(customer.branch_id) -> 'branch_forbidden', and
-- inserts the ledger row with branch_id = the customer's branch. Read-only
-- balance functions check the branch without locking.

CREATE OR REPLACE FUNCTION public.get_customer_nasiya_balance(p_customer_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_balance numeric;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  SELECT COALESCE(SUM(CASE WHEN type = 'given' THEN amount WHEN type = 'repaid' THEN -amount END), 0)
  INTO v_balance
  FROM public.nasiya_transactions
  WHERE customer_id = p_customer_id AND company_id = v_company_id;

  RETURN v_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_nasiya_balance(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.give_nasiya(
  p_customer_id uuid,
  p_amount numeric,
  p_related_transaction_id uuid,
  p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
BEGIN
  IF NOT public.has_permission('nasiya') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id is required';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  IF p_related_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions
    WHERE id = p_related_transaction_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid related_transaction_id for this company';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be a positive number';
  END IF;

  INSERT INTO public.nasiya_transactions (
    company_id, branch_id, customer_id, type, amount, note, related_transaction_id
  ) VALUES (
    v_company_id, v_branch_id, p_customer_id, 'given', p_amount, p_note, p_related_transaction_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.give_nasiya(uuid, numeric, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.repay_nasiya(
  p_customer_id uuid,
  p_amount numeric,
  p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_balance numeric;
BEGIN
  IF NOT public.has_permission('nasiya') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id is required';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be a positive number';
  END IF;

  PERFORM pg_advisory_xact_lock(2, hashtext(p_customer_id::text));

  v_balance := public.get_customer_nasiya_balance(p_customer_id);

  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'Repayment amount % exceeds outstanding nasiya balance %', p_amount, v_balance;
  END IF;

  INSERT INTO public.nasiya_transactions (company_id, branch_id, customer_id, type, amount, note)
  VALUES (v_company_id, v_branch_id, p_customer_id, 'repaid', p_amount, p_note);
END;
$$;

GRANT EXECUTE ON FUNCTION public.repay_nasiya(uuid, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_customer_loyalty_balance(p_customer_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_balance numeric;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  SELECT COALESCE(SUM(CASE WHEN type = 'earn' THEN amount WHEN type = 'redeem' THEN -amount END), 0)
  INTO v_balance
  FROM public.loyalty_transactions
  WHERE customer_id = p_customer_id AND company_id = v_company_id;

  RETURN v_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_loyalty_balance(uuid) TO authenticated;

-- Called by sell_cart after the sale (which already holds FOR NO KEY UPDATE
-- on the customer; FOR SHARE in the same transaction is compatible).
CREATE OR REPLACE FUNCTION public.earn_loyalty(
  p_customer_id uuid,
  p_transaction_id uuid,
  p_purchase_amount numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_mode text;
  v_ball_rate numeric;
  v_is_active boolean;
  v_amount numeric;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id is required';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  IF p_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions
    WHERE id = p_transaction_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid transaction_id for this company';
  END IF;

  IF p_purchase_amount IS NULL OR p_purchase_amount <= 0 THEN
    RETURN;
  END IF;

  SELECT mode, ball_rate, is_active INTO v_mode, v_ball_rate, v_is_active
  FROM public.loyalty_config
  WHERE company_id = v_company_id;

  IF NOT FOUND OR NOT v_is_active THEN
    RETURN;
  END IF;

  IF v_mode = 'percent' THEN
    v_amount := round(p_purchase_amount * v_ball_rate / 100, 2);
  ELSE
    v_amount := floor(p_purchase_amount / v_ball_rate);
  END IF;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.loyalty_transactions (company_id, branch_id, customer_id, transaction_id, type, amount)
  VALUES (v_company_id, v_branch_id, p_customer_id, p_transaction_id, 'earn', v_amount);
END;
$$;

GRANT EXECUTE ON FUNCTION public.earn_loyalty(uuid, uuid, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.redeem_loyalty(
  p_customer_id uuid,
  p_transaction_id uuid,
  p_balls numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_redeem_rate numeric;
  v_balance numeric;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id is required';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  IF p_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions
    WHERE id = p_transaction_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid transaction_id for this company';
  END IF;

  IF p_balls IS NULL OR p_balls <= 0 THEN
    RAISE EXCEPTION 'p_balls must be a positive number';
  END IF;

  PERFORM pg_advisory_xact_lock(1, hashtext(p_customer_id::text));

  SELECT redeem_rate INTO v_redeem_rate
  FROM public.loyalty_config
  WHERE company_id = v_company_id AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loyalty is not configured or is inactive for this company';
  END IF;

  v_balance := public.get_customer_loyalty_balance(p_customer_id);

  IF v_balance < p_balls THEN
    RAISE EXCEPTION 'Insufficient loyalty balance: has %, requested %', v_balance, p_balls;
  END IF;

  INSERT INTO public.loyalty_transactions (company_id, branch_id, customer_id, transaction_id, type, amount)
  VALUES (v_company_id, v_branch_id, p_customer_id, p_transaction_id, 'redeem', p_balls);

  RETURN round(p_balls * v_redeem_rate, 2);
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_loyalty(uuid, uuid, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.use_cashback(
  p_customer_id uuid,
  p_balls numeric,
  p_transaction_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_branch_id uuid;
  v_balance numeric;
  v_result numeric;
BEGIN
  IF NOT public.has_permission('pos') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id is required';
  END IF;

  SELECT branch_id INTO v_branch_id
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  PERFORM public.assert_branch_access(v_branch_id);

  v_balance := public.get_customer_loyalty_balance(p_customer_id);

  IF p_balls > v_balance THEN
    RAISE EXCEPTION 'Insufficient loyalty balance';
  END IF;

  v_result := public.redeem_loyalty(p_customer_id, p_transaction_id, p_balls);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.use_cashback(uuid, numeric, uuid) TO authenticated;

-- ─── 5) move_customer_branch ───────────────────────────────────────────────
-- owner/admin only (branch_require_admin -> 'forbidden'). Target must be an
-- ACTIVE branch of the caller's company -> else 'branch_forbidden'.
-- Moves the customer AND all of its nasiya_transactions,
-- loyalty_transactions and requests (murojat_messages follow their request)
-- atomically, so both balances stay whole in the new branch. transactions
-- (past sales) are NOT moved.
-- Locking: target branch FOR KEY SHARE (blocks a concurrent
-- set_branch_active(false)/delete_branch, which take FOR UPDATE); customer
-- FOR UPDATE (blocks every nasiya/loyalty RPC above, which take FOR SHARE,
-- and the fill trigger's FOR SHARE for direct inserts, until we commit).
-- Same branch -> no-op. Note: the updated_at triggers on customers and
-- requests bump updated_at of the moved rows.

CREATE OR REPLACE FUNCTION public.move_customer_branch(p_customer_id uuid, p_branch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_current_branch uuid;
BEGIN
  v_company_id := public.branch_require_admin();

  PERFORM 1 FROM public.branches b
  WHERE b.id = p_branch_id
    AND b.company_id = v_company_id
    AND b.is_active
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch_forbidden';
  END IF;

  SELECT c.branch_id INTO v_current_branch
  FROM public.customers c
  WHERE c.id = p_customer_id AND c.company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  IF v_current_branch = p_branch_id THEN
    RETURN;
  END IF;

  UPDATE public.customers
  SET branch_id = p_branch_id
  WHERE id = p_customer_id AND company_id = v_company_id;

  UPDATE public.nasiya_transactions
  SET branch_id = p_branch_id
  WHERE customer_id = p_customer_id AND company_id = v_company_id
    AND branch_id IS DISTINCT FROM p_branch_id;

  UPDATE public.loyalty_transactions
  SET branch_id = p_branch_id
  WHERE customer_id = p_customer_id AND company_id = v_company_id
    AND branch_id IS DISTINCT FROM p_branch_id;

  UPDATE public.requests
  SET branch_id = p_branch_id
  WHERE customer_id = p_customer_id AND company_id = v_company_id
    AND branch_id IS DISTINCT FROM p_branch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.move_customer_branch(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_customer_branch(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- 1) policies (expect only "Branch isolation..." + any super-admin)
-- SELECT tablename, policyname, cmd, roles, qual FROM pg_policies
-- WHERE schemaname = 'public' AND tablename IN
--   ('customers','nasiya_transactions','loyalty_transactions','expenses','requests','murojat_messages')
-- ORDER BY 1, 2;
--
-- -- 2) one overload each (expect create_customer(...,uuid), create_expense(jsonb,uuid))
-- SELECT oid::regprocedure FROM pg_proc
-- WHERE pronamespace = 'public'::regnamespace
--   AND proname IN ('create_customer', 'create_expense', 'move_customer_branch');
--
-- -- 3) ledgers agree with their customer's branch (expect 0, 0, 0)
-- SELECT count(*) FROM public.nasiya_transactions n JOIN public.customers c ON c.id = n.customer_id WHERE n.branch_id <> c.branch_id;
-- SELECT count(*) FROM public.loyalty_transactions l JOIN public.customers c ON c.id = l.customer_id WHERE l.branch_id <> c.branch_id;
-- SELECT count(*) FROM public.requests r JOIN public.customers c ON c.id = r.customer_id WHERE r.branch_id <> c.branch_id;
