-- ═══════════════════════════════════════════════════════════════════════
-- Loyalty (ball) points + nasiya (customer credit/IOU) data model for the
-- VIP customer card. Follows the exact hardening precedent set by
-- products/product_sizes/promotions/promotion_products: every new table
-- gets its default authenticated INSERT/UPDATE/DELETE grants revoked
-- immediately, all real writes go through SECURITY DEFINER RPCs pinned to
-- `SET search_path = public, pg_temp`, gated by has_permission() against
-- the whitelisted key set, guarded against a NULL company_id, and scoped
-- by company_id on every read/write.
--
-- Naming correction applied per explicit instruction: the originating task
-- brief referred to a `has_permission('settings')` key. There is no
-- 'settings' key in either lib/permissions.ts's PERMISSION_KEYS or the SQL
-- whitelist below (20260716000001) — the existing key for the Settings
-- page is 'sozlamalar' (Uzbek for "settings"). `upsert_loyalty_config`
-- below uses has_permission('sozlamalar'), NOT a new redundant 'settings'
-- key. 'nasiya' genuinely does not exist yet and is added to the whitelist
-- in this migration (section 0 below) before any RPC that checks it.
--
-- Does NOT touch sell_cart, any POS/frontend code, or campaigns/coupons.
-- earn_loyalty/redeem_loyalty are additive RPCs meant for a FUTURE
-- sell_cart integration (not wired in by this migration) — same pattern
-- as get_best_promotion_discount in 20260723000004, which was also added
-- ahead of its own sell_cart wiring in a later migration.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 0) Permission whitelist: add 'nasiya'
-- ─────────────────────────────────────────────────────────────────────────
-- Reproduced verbatim from 20260716000001_search_path_and_permission_whitelist.sql
-- — only 'nasiya' appended to v_valid_keys. Logic (fail-closed on unknown
-- keys, owner bypass, default-true-for-absent-whitelisted-key) is
-- unchanged. Must run before give_nasiya/repay_nasiya below, which check
-- has_permission('nasiya') and would otherwise fail closed forever since
-- 'nasiya' wasn't previously whitelisted.
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
  v_valid_keys text[] := ARRAY[
    'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
    'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
    'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya'
  ];
BEGIN
  IF NOT (p_key = ANY(v_valid_keys)) THEN
    RETURN false;
  END IF;

  SELECT role, permissions INTO v_role, v_permissions
  FROM public.users
  WHERE id = auth.uid();

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  IF v_permissions IS NULL OR NOT (v_permissions ? p_key) THEN
    RETURN true;
  END IF;

  RETURN COALESCE((v_permissions->>p_key)::boolean, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) customers.vip_since + updated set_customer_vip
-- ─────────────────────────────────────────────────────────────────────────
-- Nullable date: "when the customer first became VIP", not "last time the
-- discount % was edited". NULL means never-VIP or VIP status was removed.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS vip_since date;

-- Same signature, same has_permission('marketing') gate, same validation
-- and NULL-company guard as the version in 20260723000004 (verified read
-- in full before this edit) — the only change is vip_since maintenance.
--
-- Transition logic, computed in a single UPDATE ... SET so the "old"
-- customers.vip_discount_percent/vip_since values referenced on the RHS
-- are the pre-update row (Postgres evaluates an UPDATE's SET target list
-- against the row as it was before this statement, all in one atomic
-- statement — no separate SELECT-then-UPDATE, no race window):
--   - old NULL/0  -> new > 0   : becoming VIP now, vip_since = current_date
--   - old > 0     -> new > 0   : already VIP, just adjusting %, vip_since
--                                 unchanged
--   - new NULL/0                : VIP status removed, vip_since = NULL
--                                 (regardless of prior state)
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

-- ─────────────────────────────────────────────────────────────────────────
-- 2) loyalty_config — one row per company, company-wide ball settings
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.loyalty_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('percent', 'fixed')),
  ball_rate numeric(10,4) NOT NULL,
  redeem_rate numeric(10,4) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.loyalty_config.ball_rate IS
  'Dual meaning depending on mode — read carefully: '
  'mode=percent -> percentage of purchase amount earned as balls (e.g. 2 = 2% of the sale becomes balls). '
  'mode=fixed   -> so''m amount per 1 earned ball (e.g. 100000 = every 100,000 so''m spent earns 1 ball). '
  'Never confuse the two: a fixed-mode value is a so''m denominator, a percent-mode value is a percentage.';

COMMENT ON COLUMN public.loyalty_config.redeem_rate IS
  'so''m value of 1 ball when redeeming (e.g. 100 = 1 ball is worth 100 so''m off a purchase). '
  'Independent of mode/ball_rate — this only governs redemption value, not earning.';

CREATE TRIGGER loyalty_config_set_updated_at
  BEFORE UPDATE ON public.loyalty_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.loyalty_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation" ON public.loyalty_config
  FOR ALL
  USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

-- Close the Supabase default-grant leak immediately, same as every other
-- hardened table — SELECT stays open (RLS-scoped), all writes go through
-- upsert_loyalty_config below.
REVOKE INSERT, UPDATE, DELETE ON public.loyalty_config FROM authenticated;

-- ─── upsert_loyalty_config ──────────────────────────────────────────────
-- Single-row-per-company config write. has_permission('sozlamalar') — see
-- naming correction note at the top of this file; this is the Settings
-- module's permission key, not a new 'settings' key.
CREATE OR REPLACE FUNCTION public.upsert_loyalty_config(
  p_mode text,
  p_ball_rate numeric,
  p_redeem_rate numeric,
  p_is_active boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT public.has_permission('sozlamalar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_mode IS NULL OR p_mode NOT IN ('percent', 'fixed') THEN
    RAISE EXCEPTION 'Invalid mode: %', p_mode;
  END IF;

  IF p_ball_rate IS NULL OR p_ball_rate <= 0 THEN
    RAISE EXCEPTION 'ball_rate must be a positive number';
  END IF;

  IF p_redeem_rate IS NULL OR p_redeem_rate <= 0 THEN
    RAISE EXCEPTION 'redeem_rate must be a positive number';
  END IF;

  INSERT INTO public.loyalty_config (company_id, mode, ball_rate, redeem_rate, is_active)
  VALUES (v_company_id, p_mode, p_ball_rate, p_redeem_rate, COALESCE(p_is_active, true))
  ON CONFLICT (company_id) DO UPDATE
    SET mode = excluded.mode,
        ball_rate = excluded.ball_rate,
        redeem_rate = excluded.redeem_rate,
        is_active = excluded.is_active;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_loyalty_config(text, numeric, numeric, boolean) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) loyalty_transactions — ledger, one row per earn/redeem event
-- ─────────────────────────────────────────────────────────────────────────
-- amount is always positive (CHECK amount > 0); direction comes from
-- `type`, never a stored sign. Balance = SUM(earn) - SUM(redeem), computed
-- explicitly in get_customer_loyalty_balance below — avoids any "was this
-- supposed to be negative" ambiguity.
CREATE TABLE public.loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  -- Nullable: a redeem could in principle stand alone (e.g. a manual
  -- goodwill redemption not tied to any specific sale), and earn_loyalty's
  -- own future sell_cart caller can still always pass the sale's
  -- transaction_id when it exists. Kept nullable for schema flexibility
  -- either way rather than forcing every row to carry one.
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('earn', 'redeem')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX loyalty_transactions_company_id_idx ON public.loyalty_transactions(company_id);
CREATE INDEX loyalty_transactions_customer_id_idx ON public.loyalty_transactions(company_id, customer_id);
CREATE INDEX loyalty_transactions_transaction_id_idx ON public.loyalty_transactions(transaction_id) WHERE transaction_id IS NOT NULL;

ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation" ON public.loyalty_transactions
  FOR ALL
  USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

REVOKE INSERT, UPDATE, DELETE ON public.loyalty_transactions FROM authenticated;

-- ─── earn_loyalty ───────────────────────────────────────────────────────
-- Meant to be called from a FUTURE sell_cart integration (not done here —
-- sell_cart is not touched by this migration). has_permission('pos'),
-- matching the intended caller. Graceful no-op (RETURN, not RAISE) when
-- loyalty is unconfigured/inactive for this company, so a future
-- integration never blocks a sale from completing just because loyalty
-- isn't set up — the exception path is reserved for genuine input/tenant
-- errors (bad customer_id, bad transaction_id), not "feature not enabled".
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

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  IF p_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions
    WHERE id = p_transaction_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid transaction_id for this company';
  END IF;

  -- Nothing to earn on a zero/negative/NULL purchase amount — graceful
  -- no-op, same reasoning as the missing-config case below.
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

  -- Never insert a zero (or negative, defensively) amount row — the
  -- amount > 0 CHECK constraint would reject it anyway, but skipping here
  -- avoids relying on the constraint to enforce an expected business rule.
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.loyalty_transactions (company_id, customer_id, transaction_id, type, amount)
  VALUES (v_company_id, p_customer_id, p_transaction_id, 'earn', v_amount);
END;
$$;

GRANT EXECUTE ON FUNCTION public.earn_loyalty(uuid, uuid, numeric) TO authenticated;

-- ─── redeem_loyalty ─────────────────────────────────────────────────────
-- Returns the so'm value redeemed so a future POS caller knows how much to
-- subtract from the sale total. Balance is a SUM() over the ledger, not a
-- single row that a SELECT ... FOR UPDATE could lock directly — an
-- advisory transaction lock keyed on (customer_id, 'loyalty') serializes
-- concurrent redeem_loyalty calls for the same customer so two concurrent
-- redemptions can never both pass the balance check and jointly overdraw
-- it (the "no read-then-write without locking" rule, applied via advisory
-- lock since there is no natural balance row to SELECT ... FOR UPDATE).
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

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  IF p_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions
    WHERE id = p_transaction_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid transaction_id for this company';
  END IF;

  IF p_balls IS NULL OR p_balls <= 0 THEN
    RAISE EXCEPTION 'p_balls must be a positive number';
  END IF;

  -- Serialize concurrent redeems for this customer for the rest of this
  -- transaction. Namespaced with classid 1 (loyalty) so it never collides
  -- with the nasiya advisory lock below (classid 2), even for the same
  -- customer_id.
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

  INSERT INTO public.loyalty_transactions (company_id, customer_id, transaction_id, type, amount)
  VALUES (v_company_id, p_customer_id, p_transaction_id, 'redeem', p_balls);

  RETURN round(p_balls * v_redeem_rate, 2);
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_loyalty(uuid, uuid, numeric) TO authenticated;

-- ─── get_customer_loyalty_balance ───────────────────────────────────────
-- Read-only lookup, same treatment as get_best_promotion_discount
-- (20260723000004): no has_permission() gate, since this is a pure,
-- company-scoped read with no side effects and no money/stock mutation of
-- its own — the RPCs that actually move balls (earn_loyalty/
-- redeem_loyalty) are already gated on 'pos'. Still validates
-- p_customer_id belongs to the caller's own company before returning
-- anything, same as every other company-scoped lookup in this schema.
CREATE OR REPLACE FUNCTION public.get_customer_loyalty_balance(p_customer_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
  v_balance numeric;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN type = 'earn' THEN amount WHEN type = 'redeem' THEN -amount END), 0)
  INTO v_balance
  FROM public.loyalty_transactions
  WHERE customer_id = p_customer_id AND company_id = v_company_id;

  RETURN v_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_loyalty_balance(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) nasiya_transactions — customer credit/debt ledger
-- ─────────────────────────────────────────────────────────────────────────
-- Same always-positive-amount convention as loyalty_transactions: direction
-- comes from `type`, never a stored sign.
CREATE TABLE public.nasiya_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('given', 'repaid')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  note text,
  -- Nullable: a 'given' entry may originate from a sale the customer
  -- didn't pay in full for; a 'repaid' entry is typically a standalone
  -- payment with no associated sale. Both directions are legitimately
  -- nullable here.
  related_transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nasiya_transactions_company_id_idx ON public.nasiya_transactions(company_id);
CREATE INDEX nasiya_transactions_customer_id_idx ON public.nasiya_transactions(company_id, customer_id);
CREATE INDEX nasiya_transactions_related_transaction_id_idx ON public.nasiya_transactions(related_transaction_id) WHERE related_transaction_id IS NOT NULL;

ALTER TABLE public.nasiya_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation" ON public.nasiya_transactions
  FOR ALL
  USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

REVOKE INSERT, UPDATE, DELETE ON public.nasiya_transactions FROM authenticated;

-- ─── give_nasiya ────────────────────────────────────────────────────────
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

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

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
    company_id, customer_id, type, amount, note, related_transaction_id
  ) VALUES (
    v_company_id, p_customer_id, 'given', p_amount, p_note, p_related_transaction_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.give_nasiya(uuid, numeric, uuid, text) TO authenticated;

-- ─── repay_nasiya ───────────────────────────────────────────────────────
-- Judgment call, stated explicitly: an over-repayment (p_amount exceeding
-- the customer's current outstanding debt) is hard-rejected via
-- RAISE EXCEPTION, consistent with this schema's established
-- "hard reject over silent clamping" philosophy (sell_cart's discount
-- validation, redeem_loyalty's balance check above) — a customer cannot
-- "repay" more than they owe; that scenario almost always means the
-- amount or customer was picked wrong at the register, and should be
-- caught immediately rather than silently clamped or allowed to go
-- negative/represent a store credit (nasiya is credit *extended by the
-- shop*, not the other way around — a negative balance would be a
-- different, unmodeled concept).
--
-- Advisory lock keyed on (customer_id, 'nasiya') — classid 2, distinct
-- from redeem_loyalty's classid 1 — serializes concurrent repayments for
-- the same customer so two concurrent repay_nasiya calls can never both
-- pass the balance check and jointly over-repay.
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

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'p_amount must be a positive number';
  END IF;

  PERFORM pg_advisory_xact_lock(2, hashtext(p_customer_id::text));

  v_balance := public.get_customer_nasiya_balance(p_customer_id);

  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'Repayment amount % exceeds outstanding nasiya balance %', p_amount, v_balance;
  END IF;

  INSERT INTO public.nasiya_transactions (company_id, customer_id, type, amount, note)
  VALUES (v_company_id, p_customer_id, 'repaid', p_amount, p_note);
END;
$$;

GRANT EXECUTE ON FUNCTION public.repay_nasiya(uuid, numeric, text) TO authenticated;

-- ─── get_customer_nasiya_balance ────────────────────────────────────────
-- Same "read-only, no has_permission() gate" reasoning as
-- get_customer_loyalty_balance above.
CREATE OR REPLACE FUNCTION public.get_customer_nasiya_balance(p_customer_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
  v_balance numeric;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.customers
    WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid customer_id for this company';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN type = 'given' THEN amount WHEN type = 'repaid' THEN -amount END), 0)
  INTO v_balance
  FROM public.nasiya_transactions
  WHERE customer_id = p_customer_id AND company_id = v_company_id;

  RETURN v_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_customer_nasiya_balance(uuid) TO authenticated;
-- ═══════════════════════════════════════════════════════════════════════
