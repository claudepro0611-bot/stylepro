-- Production wave 5: cash & bank accounts (kassa / bank / card), cash
-- orders (PKO / RKO), transfers between accounts, and a cash ledger that
-- every money document of the plant posts into.
--
-- Why: payments to suppliers, payments from customers and the cash handed
-- to supply agents were recorded only as documents with a free "method"
-- text. Nothing said WHERE the money is (which till, which bank account),
-- so the plant could not answer "how much cash is in the kassa right now"
-- and could not reconcile the bank statement. Every sum that enters or
-- leaves the plant now lands in a concrete account with a running balance.
--
-- This file adds / changes:
--   1) prod_cash_accounts                  ci-unique name, kind cash / bank /
--                                          card, currency UZS only, opening
--                                          balance, default account per
--                                          payment method (<= 1 per method)
--   2) prod_cash_movements                 append-only cash ledger (trigger,
--                                          same guard as prod_stock_movements)
--   3) prod_cash_orders                    manual kirim / chiqim orders,
--                                          numbered per direction
--   4) prod_cash_transfers                 account -> account
--   5) account_id (nullable) on prod_customer_payments,
--      prod_supplier_payments, supply_cash_moves
--   6) views prod_cash_balances, prod_cash_movements_v
--   7) permission key 'prod_cash'
--   8) seed: two accounts for every production-enabled company that has none
--   9) existing money RPCs post into the ledger (same signatures, new
--      optional key account_id)
--
-- Objects:
--   NEW tables:  prod_cash_accounts, prod_cash_movements, prod_cash_orders,
--                prod_cash_transfers
--   NEW views:   prod_cash_balances, prod_cash_movements_v
--   NEW columns: prod_customer_payments.account_id,
--                prod_supplier_payments.account_id,
--                supply_cash_moves.account_id (all NULL = before this wave)
--   NEW internal helpers (EXECUTE revoked from every client role):
--                prod_cash_balance(company, account),
--                prod_cash_date_ts(date),
--                prod_cash_account_for(company, account, method),
--                prod_cash_post(...12 args),
--                prod_cash_reverse(company, source_type, source_id),
--                prod_cash_movements_append_only() (trigger)
--   NEW RPCs:    prod_save_cash_account, prod_create_cash_order,
--                prod_create_cash_transfer, prod_cancel_cash_doc
--   REPLACED (same signatures, same return shapes):
--                has_permission                (latest = 20261110000015)
--                                              + 'prod_cash'
--                prod_create_customer_payment  (latest = 20261110000015)
--                prod_cancel_customer_payment  (latest = 20261110000015)
--                prod_create_supplier_payment  (latest = 20261110000007)
--                prod_cancel_supplier_payment  (latest = 20261110000007)
--                supply_add_move               (latest = 20261110000004)
--
-- ── Balance model ─────────────────────────────────────────────────────────
--   balance = opening_balance + sum(prod_cash_movements.amount) of the
--   account. amount > 0 = money in, < 0 = money out. The opening balance is
--   a column, NOT a movement (source_type 'opening' is reserved in the
--   CHECK and never written by this file). opening_balance may be changed
--   only while the account has no movement; afterwards a correction is a
--   cash order (invalid_input DETAIL 'account_has_movements').
--   NO account may ever go below 0 (cash, bank and card alike): every
--   outflow - new document OR reversal of an inflow - is checked against
--   the current balance under the account row lock -> 'insufficient_funds'
--   (DETAIL = account id). The guarantee is on the CURRENT balance: a
--   back-dated document may make the chronological running balance of
--   prod_cash_movements_v dip below 0 at an earlier point in time.
--   Every posting (incl. reversals) needs an ACTIVE account (invalid_input
--   DETAIL 'account_inactive'); deactivation needs balance = 0 (invalid_input
--   DETAIL 'account_has_balance') and clears the account's default methods,
--   so an inactive account always holds 0.
--
-- ── Which account ─────────────────────────────────────────────────────────
--   prod_cash_accounts.is_default_for (subset of cash / card / transfer):
--   the account a document uses when the client sends no account_id. At
--   most one ACTIVE account per method per company (partial unique indexes;
--   prod_save_cash_account moves a method from the old default to the new
--   one). No default for the method -> invalid_input DETAIL 'no_account'.
--     customer payment   +amount, default by payment method
--     supplier payment   -amount, default by payment method
--     supply 'issue'     -amount (money handed to the agent), default 'cash'
--     supply 'return'    +amount (agent hands money back),   default 'cash'
--     supply 'expense'   no cash movement (the agent already holds the
--                        money); account_id is refused (invalid_input)
--     cash order in/out  +/-amount, default 'cash'
--     cash transfer      -amount from, +amount to (explicit accounts)
--   An explicit account_id must belong to the company (not_found) and be
--   active. The account kind is NOT matched to the method (the user may
--   book a cash payment into the bank account on purpose).
--
-- ── Dates ─────────────────────────────────────────────────────────────────
--   move_date (timestamptz): cash orders / transfers = doc_date. Date-only
--   documents (payments pay_date, supply move_date) = that date at the
--   current Asia/Tashkent wall-clock time (= now() for today's documents).
--   Reversals keep the move_date of the movement they reverse (a cancelled
--   document nets out on its own date), created_at = cancel time.
--   prod_cash_movements_v.running_balance = opening_balance + window sum
--   ordered by (move_date, created_at, id).
--
-- ── Cancel ────────────────────────────────────────────────────────────────
--   prod_cancel_cash_doc('cash_order' | 'cash_transfer'), cancel of
--   customer / supplier payments: status 'cancelled' + 1:1 reversal of the
--   document's movements (is_reversal = true, accounts in ascending id
--   order). A reversal that would drive an account below 0 ->
--   insufficient_funds, nothing changed. Documents posted BEFORE this
--   wave have no movement: cancelling them only flips the status (as
--   before). supply_cash_moves still have no cancel (unchanged MVP).
--
-- ── History / backfill ────────────────────────────────────────────────────
--   NONE. Payments / supply moves made before this migration keep
--   account_id NULL and have no movement (history is not invented). Each
--   seeded account starts with opening_balance 0; the user sets the real
--   opening balance (the UI must prompt for it).
--   Seed (once, here): every company whose production module is enabled
--   (same predicate as production_enabled(): business_type 'production' OR
--   an active, unexpired company_features 'production' row) and that has no
--   account gets "Asosiy kassa" (cash, default for cash) and "Bank hisob
--   raqami" (bank, default for transfer + card). Firms created / switched
--   on later get NO automatic account (they create their own).
--
-- ── Permissions ───────────────────────────────────────────────────────────
--   'prod_cash': accounts, cash orders, transfers, their cancel (+ owner /
--   admin role, as every cancel). Production key in has_permission:
--   module gate, owners bypass, non-owners fail closed unless granted.
--   Payments keep their own keys (prod_customer_payments / prod_suppliers),
--   supply moves keep prod_supply: posting into an account is part of
--   those documents and does NOT need prod_cash.
--   Reads: RLS company-scoped SELECT on the four tables (like 03..15);
--   prod_cash_movements writes ONLY via the internal helper, all other
--   writes ONLY via the RPCs.
--
-- ── Lock order (extends the global order of 13..15) ───────────────────────
--   party / document rows (customer KEY SHARE, supplier SHARE, payment /
--   order / transfer FOR UPDATE) and the supply agent advisory lock ->
--   document number lock -> ACCOUNT rows (ascending id when two).
--   Account row lock: outflow FOR NO KEY UPDATE (serialises the balance
--   check of one account), inflow FOR KEY SHARE (never blocks an outflow,
--   an inflow can only raise the balance), prod_save_cash_account
--   'prod_cash_account_save:<co>' -> row FOR UPDATE (waits for every
--   posting, so deactivation / opening edits see a settled balance).
--   Nothing waits for a number lock while holding an account lock.
--
-- ── Destructive / blocking statements ─────────────────────────────────────
--   No DROP, no data-loss ALTER, no existing row rewritten.
--   ALTER TABLE ... ADD COLUMN account_id uuid NULL (metadata only) and ADD
--   CONSTRAINT (FK / CHECK) on prod_customer_payments,
--   prod_supplier_payments, supply_cash_moves: the constraints validate
--   existing rows (all account_id NULL, trivially valid) under a brief
--   SHARE ROW EXCLUSIVE / ACCESS EXCLUSIVE lock on those three tables until
--   COMMIT (payments / supply moves wait for the migration).
--   Everything else: CREATE TABLE / VIEW / INDEX / TRIGGER, CREATE OR
--   REPLACE FUNCTION, INSERT of the seed accounts.
--
-- ── Behaviour change for existing clients (read before deploying) ─────────
--   After this migration a supplier payment or a supply 'issue' is REFUSED
--   with 'insufficient_funds' when the default account does not hold the
--   amount; seeded accounts start at 0. Until the owner enters the opening
--   balances (or a cash 'in' order), the CURRENT client cannot post
--   supplier payments / agent issues and shows the raw code. Customer
--   payments (inflows) and agent returns keep working unchanged.
--
-- Client deploy: the migration is SAFE alone (signatures and return shapes
-- unchanged, old clients never send account_id) but see the behaviour
-- change above: ship the opening-balance UI + the 'insufficient_funds' /
-- 'no_account' messages together with, or right after, the migration.
-- Pending client work: see "Frontend contract" in the spec.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) New tables ────────────────────────────────────────────────────────
-- Access model for ALL of them (same as 03..15): company_id NOT NULL ->
-- companies ON DELETE CASCADE; RLS on with ONE company-scoped SELECT policy;
-- REVOKE ALL from authenticated + anon (default-grant leak), GRANT SELECT to
-- authenticated. Writes ONLY via the SECURITY DEFINER functions below.

-- 1) Accounts. Never deleted (no delete RPC), only deactivated.
CREATE TABLE public.prod_cash_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  currency text NOT NULL DEFAULT 'UZS',
  bank_name text NULL,
  account_no text NULL,
  mfo text NULL,
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  opening_date date NULL,
  is_default_for text[] NULL,
  is_active boolean NOT NULL DEFAULT true,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_cash_accounts_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_cash_accounts_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT prod_cash_accounts_kind_check CHECK (kind IN ('cash', 'bank', 'card')),
  CONSTRAINT prod_cash_accounts_currency_check CHECK (currency = 'UZS'),
  CONSTRAINT prod_cash_accounts_opening_check CHECK (opening_balance >= 0),
  CONSTRAINT prod_cash_accounts_default_for_check CHECK (
    is_default_for IS NULL
    OR (cardinality(is_default_for) BETWEEN 1 AND 3
        AND is_default_for <@ ARRAY['cash', 'card', 'transfer']::text[])
  ),
  CONSTRAINT prod_cash_accounts_default_active_check CHECK (is_active OR is_default_for IS NULL),
  CONSTRAINT prod_cash_accounts_bank_name_check CHECK (bank_name IS NULL OR length(bank_name) <= 200),
  CONSTRAINT prod_cash_accounts_account_no_check CHECK (account_no IS NULL OR length(account_no) <= 40),
  CONSTRAINT prod_cash_accounts_mfo_check CHECK (mfo IS NULL OR length(mfo) <= 20),
  CONSTRAINT prod_cash_accounts_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_cash_accounts IS
  'Production cash / bank / card accounts (UZS). balance = opening_balance + sum(prod_cash_movements). '
  'is_default_for = payment methods this account is the default for (<= 1 account per method). '
  'Read via RLS; write ONLY via prod_save_cash_account.';

CREATE UNIQUE INDEX prod_cash_accounts_company_name_ci_key
  ON public.prod_cash_accounts (company_id, lower(btrim(name)));
CREATE UNIQUE INDEX prod_cash_accounts_default_cash_key
  ON public.prod_cash_accounts (company_id) WHERE 'cash' = ANY (is_default_for);
CREATE UNIQUE INDEX prod_cash_accounts_default_card_key
  ON public.prod_cash_accounts (company_id) WHERE 'card' = ANY (is_default_for);
CREATE UNIQUE INDEX prod_cash_accounts_default_transfer_key
  ON public.prod_cash_accounts (company_id) WHERE 'transfer' = ANY (is_default_for);

-- 2) Cash ledger (append-only, like prod_stock_movements).
-- source_id is polymorphic (payment / supply move / order / transfer id),
-- hence no FK. created_by and category_id deliberately have NO FK: an
-- "ON DELETE SET NULL" FK would be an UPDATE on this table and the
-- append-only trigger would then block deleting a staff account / an
-- expense category forever (category_id is copied from the cash order,
-- whose own FK is ON DELETE SET NULL; the view shows NULL for a deleted
-- category). Company match of category_id is enforced in the RPC.
CREATE TABLE public.prod_cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  move_date timestamptz NOT NULL,
  amount numeric(14,2) NOT NULL,
  source_type text NOT NULL,
  source_id uuid NULL,
  counterparty_type text NULL,
  counterparty_id uuid NULL,
  counterparty_name text NULL,
  category_id uuid NULL,
  note text NULL,
  is_reversal boolean NOT NULL DEFAULT false,
  created_by uuid NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_cash_movements_account_fk FOREIGN KEY (account_id, company_id)
    REFERENCES public.prod_cash_accounts (id, company_id),
  CONSTRAINT prod_cash_movements_amount_check CHECK (amount <> 0),
  CONSTRAINT prod_cash_movements_source_type_check CHECK (source_type IN (
    'customer_payment', 'supplier_payment', 'supply_issue', 'supply_return',
    'cash_order', 'cash_transfer', 'opening'
  )),
  CONSTRAINT prod_cash_movements_source_id_check CHECK (source_type = 'opening' OR source_id IS NOT NULL),
  CONSTRAINT prod_cash_movements_counterparty_type_check CHECK (
    counterparty_type IS NULL OR counterparty_type IN ('customer', 'supplier', 'agent')
  ),
  CONSTRAINT prod_cash_movements_counterparty_name_check CHECK (counterparty_name IS NULL OR length(counterparty_name) <= 200),
  CONSTRAINT prod_cash_movements_note_check CHECK (note IS NULL OR length(note) <= 500)
);

COMMENT ON TABLE public.prod_cash_movements IS
  'Append-only production cash ledger (amount > 0 in, < 0 out). UPDATE/DELETE/TRUNCATE are refused by '
  'trigger for every role (only the company ON DELETE CASCADE may remove rows). A cancelled document is '
  'mirrored with is_reversal = true. Written ONLY by prod_cash_post (inside the production RPCs).';

CREATE INDEX prod_cash_movements_account_idx
  ON public.prod_cash_movements (account_id, company_id, move_date, created_at, id);
CREATE INDEX prod_cash_movements_source_idx
  ON public.prod_cash_movements (source_type, source_id);
CREATE INDEX prod_cash_movements_company_date_idx
  ON public.prod_cash_movements (company_id, move_date DESC);

-- Append-only guard: copy of prod_stock_movements_append_only (03), same
-- single exception for the company ON DELETE CASCADE.
CREATE OR REPLACE FUNCTION public.prod_cash_movements_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Nested IF (not AND): OLD must not be touched for the statement-level
  -- TRUNCATE trigger.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'prod_cash_movements is append-only (% refused)', TG_OP
    USING ERRCODE = '42501';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_cash_movements_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prod_cash_movements_no_update_delete
  BEFORE UPDATE OR DELETE ON public.prod_cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.prod_cash_movements_append_only();

CREATE TRIGGER prod_cash_movements_no_truncate
  BEFORE TRUNCATE ON public.prod_cash_movements
  FOR EACH STATEMENT EXECUTE FUNCTION public.prod_cash_movements_append_only();

-- 3) Cash orders (PKO = 'in', RKO = 'out'). Numbered per direction.
-- category_id: plain FK ON DELETE SET NULL (same reasoning as
-- supply_cash_moves.expense_category_id in 03); company match in the RPC.
CREATE TABLE public.prod_cash_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  direction text NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  account_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  category_id uuid NULL REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  counterparty_name text NULL,
  purpose text NULL,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_cash_orders_company_direction_number_key UNIQUE (company_id, direction, number),
  CONSTRAINT prod_cash_orders_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_cash_orders_account_fk FOREIGN KEY (account_id, company_id)
    REFERENCES public.prod_cash_accounts (id, company_id),
  CONSTRAINT prod_cash_orders_number_check CHECK (number > 0),
  CONSTRAINT prod_cash_orders_direction_check CHECK (direction IN ('in', 'out')),
  CONSTRAINT prod_cash_orders_amount_check CHECK (amount > 0),
  CONSTRAINT prod_cash_orders_category_direction_check CHECK (direction = 'out' OR category_id IS NULL),
  CONSTRAINT prod_cash_orders_counterparty_check CHECK (counterparty_name IS NULL OR length(counterparty_name) <= 200),
  CONSTRAINT prod_cash_orders_purpose_check CHECK (purpose IS NULL OR length(purpose) <= 200),
  CONSTRAINT prod_cash_orders_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT prod_cash_orders_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_cash_orders_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

COMMENT ON TABLE public.prod_cash_orders IS
  'Manual cash orders: direction in (kirim / PKO) or out (chiqim / RKO), numbered per direction. '
  'Read via RLS; write ONLY via prod_create_cash_order / prod_cancel_cash_doc.';

CREATE INDEX prod_cash_orders_account_idx ON public.prod_cash_orders (account_id, company_id);
CREATE INDEX prod_cash_orders_company_date_idx ON public.prod_cash_orders (company_id, doc_date DESC);
CREATE INDEX prod_cash_orders_category_idx
  ON public.prod_cash_orders (category_id) WHERE category_id IS NOT NULL;

-- 4) Transfers between two accounts of the company.
CREATE TABLE public.prod_cash_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  number integer NOT NULL,
  doc_date timestamptz NOT NULL DEFAULT now(),
  from_account_id uuid NOT NULL,
  to_account_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  note text NULL,
  status text NOT NULL DEFAULT 'posted',
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_name text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_cash_transfers_company_number_key UNIQUE (company_id, number),
  CONSTRAINT prod_cash_transfers_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_cash_transfers_from_fk FOREIGN KEY (from_account_id, company_id)
    REFERENCES public.prod_cash_accounts (id, company_id),
  CONSTRAINT prod_cash_transfers_to_fk FOREIGN KEY (to_account_id, company_id)
    REFERENCES public.prod_cash_accounts (id, company_id),
  CONSTRAINT prod_cash_transfers_accounts_check CHECK (from_account_id <> to_account_id),
  CONSTRAINT prod_cash_transfers_number_check CHECK (number > 0),
  CONSTRAINT prod_cash_transfers_amount_check CHECK (amount > 0),
  CONSTRAINT prod_cash_transfers_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT prod_cash_transfers_status_check CHECK (status IN ('posted', 'cancelled')),
  CONSTRAINT prod_cash_transfers_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

COMMENT ON TABLE public.prod_cash_transfers IS
  'Transfers between two production cash accounts (two movements). Read via RLS; write ONLY via '
  'prod_create_cash_transfer / prod_cancel_cash_doc.';

CREATE INDEX prod_cash_transfers_from_idx ON public.prod_cash_transfers (from_account_id, company_id);
CREATE INDEX prod_cash_transfers_to_idx ON public.prod_cash_transfers (to_account_id, company_id);
CREATE INDEX prod_cash_transfers_company_date_idx ON public.prod_cash_transfers (company_id, doc_date DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'prod_cash_accounts', 'prod_cash_movements', 'prod_cash_orders', 'prod_cash_transfers'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "Company isolation (select)" ON public.%I '
      'FOR SELECT TO authenticated '
      'USING (company_id = (SELECT public.get_company_id()))',
      t
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated, anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END;
$$;

-- ─── 2) account_id on the existing money documents ────────────────────────
-- Nullable (NULL = posted before this wave, no movement). MATCH SIMPLE
-- composite FK: a non-NULL value can only point at an account of the SAME
-- company. See header "Destructive / blocking statements".

ALTER TABLE public.prod_customer_payments ADD COLUMN account_id uuid NULL;
ALTER TABLE public.prod_customer_payments
  ADD CONSTRAINT prod_customer_payments_account_fk FOREIGN KEY (account_id, company_id)
    REFERENCES public.prod_cash_accounts (id, company_id);
CREATE INDEX prod_customer_payments_account_idx
  ON public.prod_customer_payments (account_id, company_id) WHERE account_id IS NOT NULL;

ALTER TABLE public.prod_supplier_payments ADD COLUMN account_id uuid NULL;
ALTER TABLE public.prod_supplier_payments
  ADD CONSTRAINT prod_supplier_payments_account_fk FOREIGN KEY (account_id, company_id)
    REFERENCES public.prod_cash_accounts (id, company_id);
CREATE INDEX prod_supplier_payments_account_idx
  ON public.prod_supplier_payments (account_id, company_id) WHERE account_id IS NOT NULL;

ALTER TABLE public.supply_cash_moves ADD COLUMN account_id uuid NULL;
ALTER TABLE public.supply_cash_moves
  ADD CONSTRAINT supply_cash_moves_account_fk FOREIGN KEY (account_id, company_id)
    REFERENCES public.prod_cash_accounts (id, company_id);
ALTER TABLE public.supply_cash_moves
  ADD CONSTRAINT supply_cash_moves_account_kind_check CHECK (kind <> 'expense' OR account_id IS NULL);
CREATE INDEX supply_cash_moves_account_idx
  ON public.supply_cash_moves (account_id, company_id) WHERE account_id IS NOT NULL;

-- ─── 3) Seed accounts (see header "History / backfill") ───────────────────
-- One statement: NOT EXISTS is evaluated on the pre-insert snapshot, so a
-- company gets both rows or none.
INSERT INTO public.prod_cash_accounts (company_id, name, kind, is_default_for)
SELECT c.id, v.name, v.kind, v.defaults
FROM public.companies c
CROSS JOIN (VALUES
  ('Asosiy kassa', 'cash', ARRAY['cash']::text[]),
  ('Bank hisob raqami', 'bank', ARRAY['card', 'transfer']::text[])
) AS v(name, kind, defaults)
WHERE (c.business_type = 'production'
       OR EXISTS (
            SELECT 1 FROM public.company_features cf
            WHERE cf.company_id = c.id
              AND cf.feature_key = 'production'
              AND cf.is_active
              AND (cf.expires_at IS NULL OR cf.expires_at > now())
          ))
  AND NOT EXISTS (SELECT 1 FROM public.prod_cash_accounts a WHERE a.company_id = c.id);

-- ─── 4) Views (security_invoker: the caller's RLS on the base tables) ────

-- Per account. total_in / total_out are by ORIGINAL direction, net of
-- reversals (a cancelled document disappears from both), so
-- balance = opening_balance + total_in - total_out = opening + sum(amount).
CREATE VIEW public.prod_cash_balances
WITH (security_invoker = true)
AS
SELECT
  a.id AS account_id,
  a.company_id,
  a.name,
  a.kind,
  a.currency,
  a.bank_name,
  a.account_no,
  a.mfo,
  a.is_default_for,
  a.is_active,
  a.note,
  a.opening_balance,
  a.opening_date,
  COALESCE(m.total_in, 0)::numeric(14,2) AS total_in,
  COALESCE(m.total_out, 0)::numeric(14,2) AS total_out,
  (a.opening_balance + COALESCE(m.total, 0))::numeric(14,2) AS balance,
  m.last_move_at,
  COALESCE(m.move_count, 0) AS move_count
FROM public.prod_cash_accounts a
LEFT JOIN (
  SELECT
    account_id,
    company_id,
    sum(amount) FILTER (WHERE (amount > 0) <> is_reversal) AS total_in,
    -sum(amount) FILTER (WHERE (amount < 0) <> is_reversal) AS total_out,
    sum(amount) AS total,
    max(move_date) AS last_move_at,
    count(*) AS move_count
  FROM public.prod_cash_movements
  GROUP BY account_id, company_id
) m ON m.account_id = a.id AND m.company_id = a.company_id;

COMMENT ON VIEW public.prod_cash_balances IS
  'Per production cash account: opening_balance, total_in / total_out (net of reversals), '
  'balance = opening_balance + sum(movements), last_move_at, move_count (0 = opening still editable).';

-- Ledger lines with document numbers / status, category, transfer peer and
-- the running balance per account.
CREATE VIEW public.prod_cash_movements_v
WITH (security_invoker = true)
AS
SELECT
  m.id,
  m.company_id,
  m.account_id,
  a.name AS account_name,
  a.kind AS account_kind,
  m.move_date,
  m.amount,
  GREATEST(m.amount, 0)::numeric(14,2) AS amount_in,
  GREATEST(-m.amount, 0)::numeric(14,2) AS amount_out,
  m.source_type,
  m.source_id,
  CASE m.source_type
    WHEN 'customer_payment' THEN cp.number
    WHEN 'supplier_payment' THEN sp.number
    WHEN 'cash_order' THEN co.number
    WHEN 'cash_transfer' THEN ct.number
  END AS source_number,
  CASE m.source_type
    WHEN 'customer_payment' THEN cp.status
    WHEN 'supplier_payment' THEN sp.status
    WHEN 'cash_order' THEN co.status
    WHEN 'cash_transfer' THEN ct.status
    WHEN 'supply_issue' THEN 'posted'
    WHEN 'supply_return' THEN 'posted'
  END AS source_status,
  co.direction AS order_direction,
  CASE WHEN m.source_type = 'cash_transfer' THEN
    CASE WHEN m.account_id = ct.from_account_id THEN ct.to_account_id ELSE ct.from_account_id END
  END AS peer_account_id,
  pa.name AS peer_account_name,
  m.counterparty_type,
  m.counterparty_id,
  m.counterparty_name,
  m.category_id,
  ec.name AS category_name,
  m.note,
  m.is_reversal,
  m.created_by,
  m.created_by_name,
  m.created_at,
  (a.opening_balance + sum(m.amount) OVER (
    PARTITION BY m.account_id
    ORDER BY m.move_date, m.created_at, m.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ))::numeric(14,2) AS running_balance
FROM public.prod_cash_movements m
JOIN public.prod_cash_accounts a ON a.id = m.account_id AND a.company_id = m.company_id
LEFT JOIN public.prod_customer_payments cp
  ON m.source_type = 'customer_payment' AND cp.id = m.source_id AND cp.company_id = m.company_id
LEFT JOIN public.prod_supplier_payments sp
  ON m.source_type = 'supplier_payment' AND sp.id = m.source_id AND sp.company_id = m.company_id
LEFT JOIN public.prod_cash_orders co
  ON m.source_type = 'cash_order' AND co.id = m.source_id AND co.company_id = m.company_id
LEFT JOIN public.prod_cash_transfers ct
  ON m.source_type = 'cash_transfer' AND ct.id = m.source_id AND ct.company_id = m.company_id
LEFT JOIN public.prod_cash_accounts pa
  ON pa.company_id = m.company_id
 AND pa.id = CASE WHEN m.account_id = ct.from_account_id THEN ct.to_account_id ELSE ct.from_account_id END
LEFT JOIN public.expense_categories ec
  ON ec.id = m.category_id AND ec.company_id = m.company_id;

COMMENT ON VIEW public.prod_cash_movements_v IS
  'Production cash ledger lines: account, source document number / status, transfer peer, category, '
  'running_balance per account (opening_balance + sum ordered by move_date, created_at, id).';

REVOKE ALL ON public.prod_cash_balances FROM authenticated, anon;
GRANT SELECT ON public.prod_cash_balances TO authenticated;
REVOKE ALL ON public.prod_cash_movements_v FROM authenticated, anon;
GRANT SELECT ON public.prod_cash_movements_v TO authenticated;

-- ─── 5) Internal helpers (EXECUTE revoked from every client role) ─────────
-- SECURITY DEFINER with explicit company ids; reachable only from the RPCs
-- below, which derive the company from get_company_id().

-- Current balance of one account. VOLATILE: read after the caller's
-- account row lock (fresh snapshot per statement).
CREATE OR REPLACE FUNCTION public.prod_cash_balance(p_company_id uuid, p_account_id uuid)
RETURNS numeric
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE((SELECT a.opening_balance FROM public.prod_cash_accounts a
              WHERE a.id = p_account_id AND a.company_id = p_company_id), 0)
  + COALESCE((SELECT sum(m.amount) FROM public.prod_cash_movements m
              WHERE m.company_id = p_company_id AND m.account_id = p_account_id), 0)
$$;

-- A business date at the current Asia/Tashkent wall-clock time
-- (= now() for today). Used as move_date of date-only documents.
CREATE OR REPLACE FUNCTION public.prod_cash_date_ts(p_date date)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ((p_date + (now() AT TIME ZONE 'Asia/Tashkent')::time) AT TIME ZONE 'Asia/Tashkent')
$$;

-- Resolve the account of a document: explicit p_account_id (must be of the
-- company -> not_found, active -> invalid_input 'account_inactive') or the
-- active default for p_method (none -> invalid_input 'no_account').
-- No lock here: prod_cash_post re-checks under the row lock.
CREATE OR REPLACE FUNCTION public.prod_cash_account_for(p_company_id uuid, p_account_id uuid, p_method text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active boolean;
  v_id uuid;
BEGIN
  IF p_account_id IS NOT NULL THEN
    SELECT is_active INTO v_active
    FROM public.prod_cash_accounts
    WHERE id = p_account_id AND company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_active THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'account_inactive';
    END IF;
    RETURN p_account_id;
  END IF;

  IF p_method IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT id INTO v_id
  FROM public.prod_cash_accounts
  WHERE company_id = p_company_id AND is_active AND p_method = ANY (is_default_for);
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'no_account';
  END IF;
  RETURN v_id;
END;
$$;

-- Post one movement. Locks the account row (outflow FOR NO KEY UPDATE,
-- inflow FOR KEY SHARE), requires an active account of the company, and
-- refuses an outflow that would leave the balance below 0
-- ('insufficient_funds', DETAIL = account id).
CREATE OR REPLACE FUNCTION public.prod_cash_post(
  p_company_id uuid, p_account_id uuid, p_amount numeric, p_move_date timestamptz,
  p_source_type text, p_source_id uuid,
  p_counterparty_type text, p_counterparty_id uuid, p_counterparty_name text,
  p_category_id uuid, p_note text, p_is_reversal boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active boolean;
  v_user_name text;
BEGIN
  IF p_company_id IS NULL OR p_account_id IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_amount < 0 THEN
    SELECT is_active INTO v_active
    FROM public.prod_cash_accounts
    WHERE id = p_account_id AND company_id = p_company_id
    FOR NO KEY UPDATE;
  ELSE
    SELECT is_active INTO v_active
    FROM public.prod_cash_accounts
    WHERE id = p_account_id AND company_id = p_company_id
    FOR KEY SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'account_inactive';
  END IF;

  IF p_amount < 0 AND public.prod_cash_balance(p_company_id, p_account_id) + p_amount < 0 THEN
    RAISE EXCEPTION 'insufficient_funds' USING DETAIL = p_account_id::text;
  END IF;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_cash_movements (
    company_id, account_id, move_date, amount, source_type, source_id,
    counterparty_type, counterparty_id, counterparty_name, category_id, note,
    is_reversal, created_by, created_by_name
  ) VALUES (
    p_company_id, p_account_id, COALESCE(p_move_date, now()), p_amount, p_source_type, p_source_id,
    p_counterparty_type, p_counterparty_id, left(p_counterparty_name, 200), p_category_id, left(p_note, 500),
    COALESCE(p_is_reversal, false), auth.uid(), v_user_name
  );
END;
$$;

-- 1:1 reversal of a document's movements (accounts in ascending id order,
-- same move_date). No movement (document older than this wave) -> no-op.
CREATE OR REPLACE FUNCTION public.prod_cash_reverse(p_company_id uuid, p_source_type text, p_source_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT *
    FROM public.prod_cash_movements
    WHERE company_id = p_company_id AND source_type = p_source_type AND source_id = p_source_id
      AND NOT is_reversal
    ORDER BY account_id, id
  LOOP
    PERFORM public.prod_cash_post(
      p_company_id, r.account_id, -r.amount, r.move_date, r.source_type, r.source_id,
      r.counterparty_type, r.counterparty_id, r.counterparty_name, r.category_id, r.note, true
    );
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_cash_balance(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_cash_date_ts(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_cash_account_for(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_cash_post(uuid, uuid, numeric, timestamptz, text, uuid, text, uuid, text, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_cash_reverse(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- ─── 6) has_permission ────────────────────────────────────────────────────
-- Copied verbatim from 20261110000015 (latest definition). ONLY change:
-- 'prod_cash' added to v_prod_keys (production-module gate + fail-closed for
-- non-owners) and v_valid_keys.
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
    'prod_milk', 'prod_lab',
    'prod_sales', 'prod_customer_payments',
    'prod_cash'
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
    'prod_milk', 'prod_lab',
    'prod_sales', 'prod_customer_payments',
    'prod_cash'
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

-- ─── 7) RPCs ──────────────────────────────────────────────────────────────

-- ═══ prod_save_cash_account (new) ════════════════════════════════════════
-- prod_cash. p_id NULL -> create, else update the company's account
-- (not_found). p_data: { name, kind ('cash'|'bank'|'card'), currency
-- ('UZS' only), bank_name, account_no, mfo, opening_balance (>= 0),
-- opening_date (YYYY-MM-DD), is_default_for (array subset of 'cash' /
-- 'card' / 'transfer', [] or null = none), is_active, note }.
-- Create: name + kind required. Update: an ABSENT key keeps the stored
-- value; null clears an optional text / date / is_default_for; name / kind
-- present-but-null -> invalid_input; null opening_balance / currency /
-- is_active = unchanged.
-- Rules: name ci-unique per company ('duplicate' DETAIL 'name');
-- opening_balance change with movements -> invalid_input DETAIL
-- 'account_has_movements'; is_active false with balance <> 0 ->
-- invalid_input DETAIL 'account_has_balance'; deactivation clears
-- is_default_for (sending a non-empty is_default_for together with
-- is_active false -> invalid_input); a method in is_default_for is removed
-- from every other account of the company first.
-- Lock: 'prod_cash_account_save:<co>' -> account row FOR UPDATE.
-- Returns the id.
CREATE OR REPLACE FUNCTION public.prod_save_cash_account(p_id uuid, p_data jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_old public.prod_cash_accounts%ROWTYPE;
  v_id uuid;
  v_name text;
  v_kind text;
  v_currency text;
  v_bank_name text;
  v_account_no text;
  v_mfo text;
  v_opening numeric;
  v_opening_date date;
  v_active boolean;
  v_note text;
  v_has_defaults boolean;
  v_defaults text[];
  v_raw text[] := '{}';
  v_el jsonb;
  v_has_moves boolean := false;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_cash') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_name := public.prod_jtext(p_data, 'name', 100);
  v_kind := public.prod_jtext(p_data, 'kind', 20);
  v_currency := public.prod_jtext(p_data, 'currency', 10);
  v_bank_name := public.prod_jtext(p_data, 'bank_name', 200);
  v_account_no := public.prod_jtext(p_data, 'account_no', 40);
  v_mfo := public.prod_jtext(p_data, 'mfo', 20);
  v_opening := public.prod_jnum(p_data, 'opening_balance', 2);
  v_opening_date := public.prod_jdate(p_data, 'opening_date');
  v_active := public.prod_jbool(p_data, 'is_active');
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_has_defaults := p_data ? 'is_default_for';

  IF v_has_defaults AND jsonb_typeof(p_data->'is_default_for') <> 'null' THEN
    IF jsonb_typeof(p_data->'is_default_for') <> 'array' THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF jsonb_array_length(p_data->'is_default_for') > 10 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    FOR v_el IN SELECT * FROM jsonb_array_elements(p_data->'is_default_for')
    LOOP
      IF jsonb_typeof(v_el) <> 'string' OR (v_el #>> '{}') NOT IN ('cash', 'card', 'transfer') THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      v_raw := v_raw || (v_el #>> '{}');
    END LOOP;
    SELECT array_agg(DISTINCT x ORDER BY x) INTO v_defaults FROM unnest(v_raw) AS t(x);
  END IF;

  IF p_id IS NULL AND (v_name IS NULL OR v_kind IS NULL) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF (p_data ? 'name' AND v_name IS NULL) OR (p_data ? 'kind' AND v_kind IS NULL) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF (v_kind IS NOT NULL AND v_kind NOT IN ('cash', 'bank', 'card'))
     OR (v_currency IS NOT NULL AND v_currency <> 'UZS')
     OR (v_opening IS NOT NULL AND v_opening < 0) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_cash_account_save:' || v_company_id::text, 0));

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_old
    FROM public.prod_cash_accounts
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    v_has_moves := EXISTS (
      SELECT 1 FROM public.prod_cash_movements
      WHERE company_id = v_company_id AND account_id = p_id
    );
  END IF;

  -- Effective values (v_old fields are NULL on create).
  v_name := COALESCE(v_name, v_old.name);
  v_kind := COALESCE(v_kind, v_old.kind);
  v_currency := COALESCE(v_currency, v_old.currency, 'UZS');
  v_bank_name := CASE WHEN p_data ? 'bank_name' THEN v_bank_name ELSE v_old.bank_name END;
  v_account_no := CASE WHEN p_data ? 'account_no' THEN v_account_no ELSE v_old.account_no END;
  v_mfo := CASE WHEN p_data ? 'mfo' THEN v_mfo ELSE v_old.mfo END;
  v_opening := COALESCE(v_opening, v_old.opening_balance, 0);
  v_opening_date := CASE WHEN p_data ? 'opening_date' THEN v_opening_date ELSE v_old.opening_date END;
  v_active := COALESCE(v_active, v_old.is_active, true);
  v_note := CASE WHEN p_data ? 'note' THEN v_note ELSE v_old.note END;
  v_defaults := CASE WHEN v_has_defaults THEN v_defaults ELSE v_old.is_default_for END;

  IF NOT v_active THEN
    IF v_has_defaults AND v_defaults IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_defaults := NULL;
  END IF;

  IF p_id IS NOT NULL AND v_has_moves AND v_opening <> v_old.opening_balance THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'account_has_movements';
  END IF;

  -- Under the FOR UPDATE row lock no posting is in flight on this account.
  IF NOT v_active AND v_opening
       + COALESCE((SELECT sum(amount) FROM public.prod_cash_movements
                   WHERE company_id = v_company_id AND account_id = p_id), 0) <> 0 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'account_has_balance';
  END IF;

  IF (p_id IS NULL OR lower(btrim(v_old.name)) <> lower(v_name)) AND EXISTS (
    SELECT 1 FROM public.prod_cash_accounts
    WHERE company_id = v_company_id AND lower(btrim(name)) = lower(v_name)
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END IF;

  IF v_defaults IS NOT NULL THEN
    UPDATE public.prod_cash_accounts a
    SET is_default_for = (SELECT array_agg(x ORDER BY x) FROM unnest(a.is_default_for) AS t(x)
                          WHERE x <> ALL (v_defaults)),
        updated_at = now()
    WHERE a.company_id = v_company_id
      AND a.is_default_for && v_defaults
      AND (p_id IS NULL OR a.id <> p_id);
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_cash_accounts (
        company_id, name, kind, currency, bank_name, account_no, mfo,
        opening_balance, opening_date, is_default_for, is_active, note
      ) VALUES (
        v_company_id, v_name, v_kind, v_currency, v_bank_name, v_account_no, v_mfo,
        v_opening, v_opening_date, v_defaults, v_active, v_note
      )
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_cash_accounts
      SET name = v_name,
          kind = v_kind,
          currency = v_currency,
          bank_name = v_bank_name,
          account_no = v_account_no,
          mfo = v_mfo,
          opening_balance = v_opening,
          opening_date = v_opening_date,
          is_default_for = v_defaults,
          is_active = v_active,
          note = v_note,
          updated_at = now()
      WHERE id = p_id AND company_id = v_company_id
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END;

  RETURN v_id;
END;
$$;

-- ═══ prod_create_cash_order (new) ════════════════════════════════════════
-- prod_cash. p_data: { direction ('in'|'out'), account_id (default = the
-- 'cash' default account), amount > 0, doc_date (timestamptz, default
-- now()), category_id (expense_categories of the company, 'out' only),
-- counterparty_name, purpose, note }. 'out' -> insufficient_funds when the
-- account does not hold the amount. Lock: 'prod_cash_order_no:<co>:<dir>'
-- -> account row. Returns { id, number } (number per direction).
CREATE OR REPLACE FUNCTION public.prod_create_cash_order(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_direction text;
  v_account_id uuid;
  v_amount numeric;
  v_doc_date timestamptz;
  v_category_id uuid;
  v_counterparty text;
  v_purpose text;
  v_note text;
  v_id uuid;
  v_number integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_cash') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_direction := public.prod_jtext(p_data, 'direction', 10);
  v_account_id := public.prod_juuid(p_data, 'account_id');
  v_amount := public.prod_jnum(p_data, 'amount', 2);
  v_doc_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());
  v_category_id := public.prod_juuid(p_data, 'category_id');
  v_counterparty := public.prod_jtext(p_data, 'counterparty_name', 200);
  v_purpose := public.prod_jtext(p_data, 'purpose', 200);
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_direction IS NULL OR v_direction NOT IN ('in', 'out')
     OR v_amount IS NULL OR v_amount <= 0
     OR (v_category_id IS NOT NULL AND v_direction <> 'out') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF v_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.expense_categories WHERE id = v_category_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_account_id := public.prod_cash_account_for(v_company_id, v_account_id, 'cash');

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'prod_cash_order_no:' || v_company_id::text || ':' || v_direction, 0
  ));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_cash_orders WHERE company_id = v_company_id AND direction = v_direction;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_cash_orders (
    company_id, number, direction, doc_date, account_id, amount, category_id,
    counterparty_name, purpose, note, status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_direction, v_doc_date, v_account_id, v_amount, v_category_id,
    v_counterparty, v_purpose, v_note, 'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  PERFORM public.prod_cash_post(
    v_company_id, v_account_id,
    CASE WHEN v_direction = 'in' THEN v_amount ELSE -v_amount END,
    v_doc_date, 'cash_order', v_id, NULL, NULL, v_counterparty, v_category_id,
    COALESCE(v_purpose, v_note), false
  );

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_create_cash_transfer (new) ═════════════════════════════════════
-- prod_cash. p_data: { from_account_id, to_account_id (different, both
-- active accounts of the company), amount > 0, doc_date (default now()),
-- note }. Two movements (-from, +to), accounts locked in ascending id order.
-- insufficient_funds when 'from' does not hold the amount.
-- Lock: 'prod_cash_transfer_no:<co>' -> account rows. Returns { id, number }.
CREATE OR REPLACE FUNCTION public.prod_create_cash_transfer(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_from uuid;
  v_to uuid;
  v_amount numeric;
  v_doc_date timestamptz;
  v_note text;
  v_id uuid;
  v_number integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_cash') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_from := public.prod_juuid(p_data, 'from_account_id');
  v_to := public.prod_juuid(p_data, 'to_account_id');
  v_amount := public.prod_jnum(p_data, 'amount', 2);
  v_doc_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());
  v_note := public.prod_jtext(p_data, 'note', 500);

  IF v_from IS NULL OR v_to IS NULL OR v_from = v_to
     OR v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_cash_account_for(v_company_id, v_from, NULL);
  PERFORM public.prod_cash_account_for(v_company_id, v_to, NULL);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_cash_transfer_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_cash_transfers WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_cash_transfers (
    company_id, number, doc_date, from_account_id, to_account_id, amount, note,
    status, created_by, created_by_name
  ) VALUES (
    v_company_id, v_number, v_doc_date, v_from, v_to, v_amount, v_note,
    'posted', auth.uid(), v_user_name
  )
  RETURNING id INTO v_id;

  IF v_from < v_to THEN
    PERFORM public.prod_cash_post(v_company_id, v_from, -v_amount, v_doc_date, 'cash_transfer', v_id,
                                  NULL, NULL, NULL, NULL, v_note, false);
    PERFORM public.prod_cash_post(v_company_id, v_to, v_amount, v_doc_date, 'cash_transfer', v_id,
                                  NULL, NULL, NULL, NULL, v_note, false);
  ELSE
    PERFORM public.prod_cash_post(v_company_id, v_to, v_amount, v_doc_date, 'cash_transfer', v_id,
                                  NULL, NULL, NULL, NULL, v_note, false);
    PERFORM public.prod_cash_post(v_company_id, v_from, -v_amount, v_doc_date, 'cash_transfer', v_id,
                                  NULL, NULL, NULL, NULL, v_note, false);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_cancel_cash_doc (new) ══════════════════════════════════════════
-- prod_cash AND owner / admin role. p_type 'cash_order' | 'cash_transfer'.
-- Row FOR UPDATE (a concurrent second cancel waits, then gets
-- 'already_cancelled'), 1:1 reversal (insufficient_funds when an account
-- would go below 0 - nothing changed), status 'cancelled'.
CREATE OR REPLACE FUNCTION public.prod_cancel_cash_doc(p_type text, p_id uuid)
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
  IF NOT public.has_permission('prod_cash') THEN
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

  IF p_id IS NULL OR p_type IS NULL OR p_type NOT IN ('cash_order', 'cash_transfer') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_type = 'cash_order' THEN
    SELECT status INTO v_status
    FROM public.prod_cash_orders
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
  ELSE
    SELECT status INTO v_status
    FROM public.prod_cash_transfers
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
  END IF;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  PERFORM public.prod_cash_reverse(v_company_id, p_type, p_id);

  IF p_type = 'cash_order' THEN
    UPDATE public.prod_cash_orders
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSE
    UPDATE public.prod_cash_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ═══ prod_create_customer_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000015 (latest definition). Additions:
--   * optional p_data.account_id; absent -> the active default account of
--     the payment method (none -> invalid_input DETAIL 'no_account');
--     explicit -> not_found / invalid_input DETAIL 'account_inactive'.
--   * stores account_id, posts +amount (source 'customer_payment',
--     counterparty the customer, move_date = pay_date at current Tashkent
--     time). Lock: customer KEY SHARE -> number lock -> account KEY SHARE.
-- Return shape unchanged: { id, number }.
CREATE OR REPLACE FUNCTION public.prod_create_customer_payment(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_customer_id uuid;
  v_customer_name text;
  v_amount numeric;
  v_method text;
  v_pay_date date;
  v_note text;
  v_account_id uuid;
  v_id uuid;
  v_number integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_customer_payments') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_customer_id := public.prod_juuid(p_data, 'customer_id');
  v_amount := public.prod_jnum(p_data, 'amount', 2);
  v_method := COALESCE(public.prod_jtext(p_data, 'method', 20), 'cash');
  v_pay_date := COALESCE(public.prod_jdate(p_data, 'pay_date'), (now() AT TIME ZONE 'Asia/Tashkent')::date);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_account_id := public.prod_juuid(p_data, 'account_id');

  IF v_customer_id IS NULL
     OR v_amount IS NULL OR v_amount <= 0
     OR v_method NOT IN ('cash', 'card', 'transfer') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT name INTO v_customer_name FROM public.prod_customers
  WHERE id = v_customer_id AND company_id = v_company_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_account_id := public.prod_cash_account_for(v_company_id, v_account_id, v_method);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_customer_payment_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_customer_payments WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_customer_payments (
    company_id, number, customer_id, amount, method, pay_date, note,
    status, created_by, created_by_name, account_id
  ) VALUES (
    v_company_id, v_number, v_customer_id, v_amount, v_method, v_pay_date, v_note,
    'posted', auth.uid(), v_user_name, v_account_id
  )
  RETURNING id INTO v_id;

  PERFORM public.prod_cash_post(
    v_company_id, v_account_id, v_amount, public.prod_cash_date_ts(v_pay_date),
    'customer_payment', v_id, 'customer', v_customer_id, v_customer_name, NULL, v_note, false
  );

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_cancel_customer_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000015 (latest definition). Addition: 1:1
-- reversal of the payment's movement (insufficient_funds when the account
-- no longer holds the amount; nothing changed). Payments from before this
-- wave have no movement: status flip only, as before.
CREATE OR REPLACE FUNCTION public.prod_cancel_customer_payment(p_id uuid)
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
  IF NOT public.has_permission('prod_customer_payments') THEN
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
  FROM public.prod_customer_payments
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  PERFORM public.prod_cash_reverse(v_company_id, 'customer_payment', p_id);

  UPDATE public.prod_customer_payments
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_create_supplier_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000007 (latest definition). Additions:
--   * optional p_data.account_id (default by payment method, as for
--     customer payments; 'no_account' / 'account_inactive' / not_found).
--   * stores account_id, posts -amount (counterparty the supplier):
--     insufficient_funds (DETAIL account id) when the account does not hold
--     the amount. Lock: supplier FOR SHARE -> number lock -> account
--     FOR NO KEY UPDATE.
-- Supplier overpayment (advance) is still allowed. Return shape unchanged.
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
  v_supplier_name text;
  v_amount numeric;
  v_method text;
  v_pay_date date;
  v_note text;
  v_account_id uuid;
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
  v_account_id := public.prod_juuid(p_data, 'account_id');

  IF v_supplier_id IS NULL
     OR v_amount IS NULL OR v_amount <= 0
     OR v_method NOT IN ('cash', 'card', 'transfer') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- FOR SHARE: the supplier row cannot change underneath (consistent with
  -- the FK check that follows on INSERT).
  SELECT name INTO v_supplier_name FROM public.prod_suppliers
  WHERE id = v_supplier_id AND company_id = v_company_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_account_id := public.prod_cash_account_for(v_company_id, v_account_id, v_method);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_supplier_payment_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_supplier_payments WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_supplier_payments (
    company_id, number, supplier_id, amount, method, pay_date, note,
    status, created_by, created_by_name, account_id
  ) VALUES (
    v_company_id, v_number, v_supplier_id, v_amount, v_method, v_pay_date, v_note,
    'posted', auth.uid(), v_user_name, v_account_id
  )
  RETURNING id INTO v_id;

  PERFORM public.prod_cash_post(
    v_company_id, v_account_id, -v_amount, public.prod_cash_date_ts(v_pay_date),
    'supplier_payment', v_id, 'supplier', v_supplier_id, v_supplier_name, NULL, v_note, false
  );

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_cancel_supplier_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000007 (latest definition). Addition: 1:1
-- reversal of the payment's movement (money back into the account).
-- Pre-wave payments: status flip only.
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

  PERFORM public.prod_cash_reverse(v_company_id, 'supplier_payment', p_id);

  UPDATE public.prod_supplier_payments
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ supply_add_move (replaced, same signature) ══════════════════════════
-- Body copied from 20261110000004 (latest definition). Additions:
--   * optional p_data.account_id: 'issue' / 'return' only (with 'expense'
--     -> invalid_input); absent -> the active default 'cash' account.
--   * 'issue' posts -amount (supply_issue; insufficient_funds when the
--     account does not hold it), 'return' posts +amount (supply_return);
--     counterparty = the agent; move_date = move_date at current Tashkent
--     time. 'expense' posts nothing. account_id stored on the move.
-- Lock: per-agent advisory lock -> account row. Return shape unchanged.
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
  v_agent_name text;
  v_kind text;
  v_amount numeric;
  v_purpose text;
  v_category_id uuid;
  v_move_date date;
  v_note text;
  v_account_id uuid;
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
  v_account_id := public.prod_juuid(p_data, 'account_id');

  IF v_agent_id IS NULL
     OR v_kind IS NULL OR v_kind NOT IN ('issue', 'return', 'expense')
     OR v_amount IS NULL OR v_amount <= 0
     OR (v_category_id IS NOT NULL AND v_kind <> 'expense')
     OR (v_account_id IS NOT NULL AND v_kind = 'expense') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT is_active, name INTO v_agent_active, v_agent_name
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

  IF v_kind IN ('issue', 'return') THEN
    v_account_id := public.prod_cash_account_for(v_company_id, v_account_id, 'cash');
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
    move_date, note, created_by, created_by_name, account_id
  ) VALUES (
    v_company_id, v_agent_id, v_kind, v_amount, v_purpose, v_category_id,
    v_move_date, v_note, auth.uid(), v_user_name, v_account_id
  )
  RETURNING id INTO v_id;

  IF v_kind IN ('issue', 'return') THEN
    PERFORM public.prod_cash_post(
      v_company_id, v_account_id,
      CASE WHEN v_kind = 'issue' THEN -v_amount ELSE v_amount END,
      public.prod_cash_date_ts(v_move_date),
      CASE WHEN v_kind = 'issue' THEN 'supply_issue' ELSE 'supply_return' END,
      v_id, 'agent', v_agent_id, v_agent_name, NULL, COALESCE(v_purpose, v_note), false
    );
  END IF;

  RETURN v_id;
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated.

REVOKE EXECUTE ON FUNCTION public.prod_save_cash_account(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_cash_order(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_cash_transfer(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_cash_doc(text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_customer_payment(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_customer_payment(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_supplier_payment(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_supplier_payment(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.supply_add_move(jsonb) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_save_cash_account(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_cash_order(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_cash_transfer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_cash_doc(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_customer_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_customer_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_supplier_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_supplier_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supply_add_move(jsonb) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on every new table:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_cash_accounts', 'prod_cash_movements', 'prod_cash_orders', 'prod_cash_transfers')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_cash_accounts', 'prod_cash_movements', 'prod_cash_orders', 'prod_cash_transfers',
--                      'prod_cash_balances', 'prod_cash_movements_v');
-- -- seeded accounts (2 per production-enabled company):
-- SELECT company_id, count(*) FROM public.prod_cash_accounts GROUP BY 1;
-- -- balances = opening + ledger (expect 0 rows):
-- SELECT b.account_id FROM public.prod_cash_balances b
-- WHERE b.balance <> b.opening_balance + COALESCE((SELECT sum(amount) FROM public.prod_cash_movements m
--                                                  WHERE m.account_id = b.account_id), 0);
