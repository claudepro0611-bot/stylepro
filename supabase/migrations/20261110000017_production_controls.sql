-- Production wave 6: controls & anti-fraud (server-side rules, overrides,
-- audit trail, period lock).
--
-- Why: the plant's documents were validated only for shape. Yield against
-- the recipe, separation loss / fat balance, processing recovery value,
-- conditional milk prices, lab thresholds, back-dated or closed-month
-- documents, self-cancellation, payments above the debt, cash handed to
-- agents, zero-price / supplier-less receipts and expired lots were checked
-- (if at all) only by the screen, so one person could move value out of the
-- books with a well-formed document (audit findings 1-13, 34). Every rule is
-- now enforced in the RPC; an exception needs an owner / admin override that
-- is written to an append-only audit log, and master data changes are logged.
--
-- This file adds / changes:
--   1) prod_control_settings   one row per company (limits below), owner-edited
--   2) prod_audit_log          append-only trail (trigger-guarded)
--   3) prod_period_locks       closed period per company
--   4) prod_audit trigger      on 11 master-data tables (changed columns only)
--   5) lot_pick_deviation      on productions / processings / separations /
--                              transfers / write-offs / sales
--   6) supply_cash_moves       status / cancelled_at / cancelled_by /
--                              cancel_note + supply_cancel_move
--   7) rules in every create / post / cancel RPC (see "Rules")
--
-- Objects:
--   NEW tables:  prod_control_settings, prod_audit_log, prod_period_locks
--   NEW columns: prod_productions / prod_processings / prod_separations /
--                prod_transfers / prod_writeoffs / prod_sales
--                .lot_pick_deviation boolean NOT NULL DEFAULT false;
--                supply_cash_moves.status text NOT NULL DEFAULT 'posted',
--                .cancelled_at, .cancelled_by, .cancel_note
--   REPLACED views (same columns / order / types):
--                supply_agent_balances (posted moves only),
--                prod_cash_movements_v (supply source_status from the move)
--   NEW internal helpers (EXECUTE revoked from every client role):
--                prod_biz_date, prod_ctl_role, prod_ctl_settings,
--                prod_audit_write, prod_ctl_require, prod_assert_date,
--                prod_ctl_cancel, prod_lock_items_share, prod_ctl_ctx,
--                prod_audit_trigger (trigger), prod_audit_log_append_only
--                (trigger), prod_consume 9-arg (+ p_ctl jsonb)
--   NEW policy helper: prod_is_owner_admin() (EXECUTE to authenticated;
--                reveals only the caller's own role)
--   NEW RPCs:    prod_save_control_settings(jsonb), prod_close_period(date),
--                prod_reopen_period(date, text), supply_cancel_move(uuid, text)
--   REPLACED (same signatures and return shapes; new OPTIONAL keys only):
--                prod_consume 7-arg / 8-arg       (latest = 14) -> 9-arg
--                prod_create_receipt              (latest = 13)
--                prod_milk_apply_lab (internal)   (latest = 13)
--                prod_create_milk_intake          (latest = 10)
--                prod_cancel_milk_intake          (latest = 10)
--                prod_amend_milk_lab              (latest = 14)
--                prod_save_supplier               (latest = 14)
--                prod_create_production           (latest = 13)
--                prod_create_processing           (latest = 13)
--                prod_create_separation           (latest = 13)
--                prod_create_transfer             (latest = 14)
--                prod_create_writeoff             (latest = 14)
--                prod_create_opening              (latest = 14)
--                prod_create_price_correction     (latest = 14)
--                prod_create_sale                 (latest = 15)
--                prod_create_sale_return          (latest = 15)
--                prod_cancel_document             (latest = 15)
--                prod_create_customer_payment     (latest = 16)
--                prod_cancel_customer_payment     (latest = 16)
--                prod_create_supplier_payment     (latest = 16)
--                prod_cancel_supplier_payment     (latest = 16)
--                prod_create_cash_order           (latest = 16)
--                prod_create_cash_transfer        (latest = 16)
--                prod_cancel_cash_doc             (latest = 16)
--                supply_add_move                  (latest = 16)
--   RE-CREATED with a defaulted trailing parameter:
--                prod_post_stock_count(p_id uuid)  (latest = 14)
--                -> prod_post_stock_count(p_id uuid, p_ctl jsonb DEFAULT NULL)
--   NOT changed: has_permission (no new key: the control RPCs use the
--     whitelisted shared key 'sozlamalar' + role owner), prod_record_milk_lab
--     (its controls live in prod_milk_apply_lab), prod_save_stock_count,
--     prod_delete_stock_count_draft, prod_change_item_unit.
--
-- ── Override mechanism ────────────────────────────────────────────────────
--   A violated rule raises 'needs_approval' with DETAIL = rule code. It may
--   be bypassed ONLY by an owner / admin who sends override = true and
--   override_note (>= 5 chars, <= 500) in p_data (prod_record_milk_lab /
--   prod_amend_milk_lab: in p_lab; prod_create_milk_intake: top level, also
--   inherited by the inline lab block; prod_post_stock_count: p_ctl).
--   Staff / manager with override -> still 'needs_approval'. Owner / admin
--   with override but no valid note -> invalid_input DETAIL 'override_note'.
--   Every override writes ONE prod_audit_log row per (transaction, entity,
--   rule): action 'override', rule, entity (table), entity_id (document id;
--   generated before the insert), note, new = rule details.
--   NOT overridable: 'period_closed', future_date, 'antibiotic',
--   'supplier_price_change', 'self_cancel'.
--
-- ── Rules (rule codes) ────────────────────────────────────────────────────
--   backdate            date < today - backdate_days_staff (staff / manager)
--                       or - backdate_days_admin (owner / admin). today =
--                       Asia/Tashkent business date. Every create / post RPC.
--   (period_closed)     date <= prod_period_locks.locked_until: create, post
--                       AND cancel of a document dated in the closed period.
--                       Error 'period_closed', DETAIL = lock date.
--   (future_date)       date > today + future_days -> invalid_input DETAIL
--                       'future_date'.
--   production_no_recipe  production without recipe_id.
--   production_yield    with a recipe: a recipe component outside +-tolerance
--                       of line.qty * output_qty / recipe.output_qty (missing
--                       = 0), a component not in the recipe, or output outside
--                       +-tolerance of recipe output scaled by the components.
--   separation_loss     (milk - cream - skim) / milk * 100 >
--                       separation_loss_max_pct (manual quantities included).
--   separation_fat      fat out (cream, skim) > fat in * (1 + tol) or <
--                       fat in * (1 - tol - loss share); fat in uses the
--                       consumed lots' fat (server) when known.
--   processing_recovery recovery_cost < processing_cost * min_recovery_pct,
--                       or an output price 0.
--   conditional_price   conditional price_per_kg_override outside
--                       [base * conditional_price_min_pct / 100, base].
--   supplier_price_change  'forbidden' (not a needs_approval) for a
--                       non-owner/admin setting / changing milk_price_per_kg.
--   lab_same_user       lab_must_differ and the lab user weighed the milk.
--   antibiotic          'forbidden' DETAIL 'antibiotic': accepted + positive.
--   milk_threshold      accepted with acidity > max, fat < min, density < min
--                       or temperature > max (prod_milk_settings).
--   self_cancel         error 'self_cancel': self_cancel_allowed = false and a
--                       non-owner cancels a document they created (stock
--                       count: or posted; milk intake: or did the lab).
--   payment_over_debt   supplier payment > current debt (receipts + price
--                       corrections - payments) unless payment_over_debt_allowed.
--   supply_issue_limit  'issue' by a non owner/admin above
--                       supply_issue_daily_limit per agent per move_date.
--   receipt_zero_price  raw-item receipt line with price 0.
--   receipt_no_supplier receipt with a raw item and no supplier_id.
--   (expiry_in_past)    receipt line expiry_date < doc date -> invalid_input.
--   expired_lot         manual pick of a lot with expiry_date < doc date in
--                       hold modes 'strict' / 'pick' (FEFO skips such lots;
--                       write-off and stock-count shortage ('any') take them).
--   manual_pick         manual lot pick by a role not in manual_lot_pick_roles.
--   lot_pick_deviation  (stored, not a rule) manual plan <> FEFO plan.
--   item rows FOR SHARE in every inflow RPC (finding 13).
--
-- ── Audit log ─────────────────────────────────────────────────────────────
--   Trigger prod_audit (AFTER INSERT / UPDATE / DELETE, row) on prod_items,
--   prod_suppliers, prod_customers, prod_warehouses, prod_recipes,
--   prod_recipe_lines, prod_milk_settings, prod_price_lists,
--   prod_price_list_items, prod_cash_accounts, prod_control_settings: insert
--   (new = row), delete (old = row), update (old / new = changed columns,
--   updated_at ignored, nothing logged when nothing else changed; settings
--   updates logged as action 'settings'). Every cancel writes action
--   'cancel'; prod_close_period / prod_reopen_period write 'period_close' /
--   'period_reopen'. Reads: RLS, owner / admin of the company only.
--
-- ── Lock order (extends 13..16) ───────────────────────────────────────────
--   document row FOR UPDATE (cancel / post) -> period row FOR SHARE
--   (prod_assert_date; created lazily) -> party rows (customer NO KEY
--   UPDATE, supplier: payments now NO KEY UPDATE to serialise the debt check)
--   -> warehouse FOR SHARE -> item rows FOR SHARE (inflows, ascending id) ->
--   stock keys -> document number lock -> account rows -> 'prod_lot_no'.
--   prod_close_period / prod_reopen_period take ONLY the period row FOR
--   UPDATE (waits for in-flight postings). prod_change_item_unit (item FOR
--   UPDATE -> stock keys) is consistent with the item FOR SHARE locks.
--   prod_save_control_settings: settings row FOR UPDATE only.
--
-- ── Destructive / blocking statements ─────────────────────────────────────
--   WARNING: DROP FUNCTION public.prod_post_stock_count(uuid), immediately
--   re-created as prod_post_stock_count(uuid, jsonb DEFAULT NULL) (an
--   overload would make 1-argument calls ambiguous). No data involved;
--   { p_id } calls keep working; EXECUTE re-granted to authenticated.
--   ALTER TABLE ... ADD COLUMN with constant defaults (metadata only) on 6
--   document tables and supply_cash_moves; ADD CONSTRAINT CHECK on
--   supply_cash_moves validates existing rows (all 'posted') under a brief
--   ACCESS EXCLUSIVE lock until COMMIT. No row deleted or rewritten; the only
--   DML is the settings seed INSERT.
--
-- ── Behaviour change for existing clients (read before deploying) ─────────
--   The current client keeps working for in-rule documents, but now gets
--   raw 'needs_approval' (DETAIL rule code) / 'period_closed' / 'self_cancel'
--   / 'forbidden' (DETAIL 'antibiotic' | 'supplier_price_change') errors for
--   the cases above, and has no way to send an override yet. Most visible:
--   production without a recipe, receipts of raw items without a supplier,
--   supplier advances (payment > debt), separations with loss > 2 %, staff
--   documents dated more than 1 day back, admins cancelling their own
--   documents, staff changing a supplier's milk price.
--
-- Client deploy: the migration is SAFE alone (signatures / return shapes
-- unchanged, prod_post_stock_count { p_id } still resolves) but ship the
-- override dialog + error messages + settings / period screens with, or
-- right after, it. Pending client work: "Frontend contract" in the spec.
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) New tables ────────────────────────────────────────────────────────
-- Access model: company_id NOT NULL -> companies ON DELETE CASCADE; RLS on
-- with ONE SELECT policy; REVOKE ALL from authenticated + anon (Supabase
-- default-grant leak), GRANT SELECT to authenticated. Writes ONLY via the
-- SECURITY DEFINER functions / triggers below (RPC-only write access).

-- 1a) Control settings: one row per company (seeded below for every
-- production-enabled company, created lazily by prod_ctl_settings()
-- otherwise). Readable by every member of the company (the UI needs the
-- limits to warn before posting); writable only by the owner through
-- prod_save_control_settings.
CREATE TABLE public.prod_control_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  production_tolerance_pct numeric(6,2) NOT NULL DEFAULT 10,
  separation_loss_max_pct numeric(6,2) NOT NULL DEFAULT 2,
  separation_fat_tolerance_pct numeric(6,2) NOT NULL DEFAULT 5,
  processing_min_recovery_pct numeric(6,2) NOT NULL DEFAULT 50,
  conditional_price_min_pct numeric(6,2) NOT NULL DEFAULT 50,
  backdate_days_staff integer NOT NULL DEFAULT 1,
  backdate_days_admin integer NOT NULL DEFAULT 31,
  future_days integer NOT NULL DEFAULT 1,
  lab_must_differ boolean NOT NULL DEFAULT false,
  self_cancel_allowed boolean NOT NULL DEFAULT false,
  supply_issue_daily_limit numeric(14,2) NULL,
  payment_over_debt_allowed boolean NOT NULL DEFAULT false,
  manual_lot_pick_roles text[] NOT NULL DEFAULT ARRAY['owner', 'admin', 'manager', 'staff']::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_control_settings_pct_check CHECK (
    production_tolerance_pct BETWEEN 0 AND 100
    AND separation_loss_max_pct BETWEEN 0 AND 100
    AND separation_fat_tolerance_pct BETWEEN 0 AND 100
    AND processing_min_recovery_pct BETWEEN 0 AND 100
    AND conditional_price_min_pct BETWEEN 0 AND 100
  ),
  CONSTRAINT prod_control_settings_days_check CHECK (
    backdate_days_staff BETWEEN 0 AND 3650
    AND backdate_days_admin BETWEEN 0 AND 3650
    AND backdate_days_staff <= backdate_days_admin
    AND future_days BETWEEN 0 AND 365
  ),
  CONSTRAINT prod_control_settings_limit_check CHECK (supply_issue_daily_limit IS NULL OR supply_issue_daily_limit > 0),
  CONSTRAINT prod_control_settings_roles_check CHECK (
    manual_lot_pick_roles <@ ARRAY['owner', 'admin', 'manager', 'staff']::text[]
  )
);

COMMENT ON TABLE public.prod_control_settings IS
  'Production anti-fraud limits (one row per company). Read via RLS (company members); write ONLY via '
  'prod_save_control_settings (owner). Every change is in prod_audit_log (action settings).';

-- 1b) Audit log (append-only: trigger refuses UPDATE / DELETE / TRUNCATE
-- for every role except the company ON DELETE CASCADE). No FK on user_id
-- (a deleted staff account must not block / rewrite history).
CREATE TABLE public.prod_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NULL,
  user_name text NULL,
  entity text NOT NULL,
  entity_id uuid NULL,
  action text NOT NULL,
  old jsonb NULL,
  new jsonb NULL,
  rule text NULL,
  note text NULL,
  CONSTRAINT prod_audit_log_action_check CHECK (action IN (
    'insert', 'update', 'delete', 'override', 'cancel', 'period_close', 'period_reopen', 'settings'
  )),
  CONSTRAINT prod_audit_log_entity_check CHECK (length(entity) BETWEEN 1 AND 63),
  CONSTRAINT prod_audit_log_rule_check CHECK (rule IS NULL OR length(rule) <= 50),
  CONSTRAINT prod_audit_log_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT prod_audit_log_override_check CHECK (action <> 'override' OR (rule IS NOT NULL AND note IS NOT NULL))
);

COMMENT ON TABLE public.prod_audit_log IS
  'Append-only production audit trail: master-data changes (old / new = changed columns only), '
  'rule overrides (rule + note), document cancels, period close / reopen, settings. Read via RLS by '
  'owner / admin only; written ONLY by triggers and SECURITY DEFINER RPCs.';

CREATE INDEX prod_audit_log_company_at_idx ON public.prod_audit_log (company_id, at DESC);
CREATE INDEX prod_audit_log_entity_idx ON public.prod_audit_log (entity_id, company_id) WHERE entity_id IS NOT NULL;
CREATE INDEX prod_audit_log_rule_idx ON public.prod_audit_log (company_id, rule) WHERE rule IS NOT NULL;

-- 1c) Period lock: everything dated <= locked_until is closed. NULL = open
-- (a row is created lazily so every posting can take a row lock on it).
CREATE TABLE public.prod_period_locks (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  locked_until date NULL,
  locked_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  locked_at timestamptz NULL
);

COMMENT ON TABLE public.prod_period_locks IS
  'Closed production period per company: no document dated <= locked_until may be posted or cancelled. '
  'Read via RLS (company members); write ONLY via prod_close_period / prod_reopen_period (owner).';

-- Owner / admin of the caller's company (used by the audit-log policy).
-- Reveals only the caller's own role.
CREATE OR REPLACE FUNCTION public.prod_is_owner_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role IN ('owner', 'admin')
  )
$$;

REVOKE EXECUTE ON FUNCTION public.prod_is_owner_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prod_is_owner_admin() TO authenticated;

ALTER TABLE public.prod_control_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Company isolation (select)" ON public.prod_control_settings
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()));
REVOKE ALL ON public.prod_control_settings FROM authenticated, anon;
GRANT SELECT ON public.prod_control_settings TO authenticated;

ALTER TABLE public.prod_period_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Company isolation (select)" ON public.prod_period_locks
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()));
REVOKE ALL ON public.prod_period_locks FROM authenticated, anon;
GRANT SELECT ON public.prod_period_locks TO authenticated;

ALTER TABLE public.prod_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner/admin read (select)" ON public.prod_audit_log
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()) AND (SELECT public.prod_is_owner_admin()));
REVOKE ALL ON public.prod_audit_log FROM authenticated, anon;
GRANT SELECT ON public.prod_audit_log TO authenticated;

-- Append-only guard (same pattern as prod_cash_movements_append_only).
CREATE OR REPLACE FUNCTION public.prod_audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'prod_audit_log is append-only (% refused)', TG_OP
    USING ERRCODE = '42501';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_audit_log_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prod_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON public.prod_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.prod_audit_log_append_only();

CREATE TRIGGER prod_audit_log_no_truncate
  BEFORE TRUNCATE ON public.prod_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.prod_audit_log_append_only();

-- 1d) Seed settings for every production-enabled company (same predicate as
-- production_enabled() / the 16 cash seed). Others get a row lazily.
INSERT INTO public.prod_control_settings (company_id)
SELECT c.id
FROM public.companies c
WHERE c.business_type = 'production'
   OR EXISTS (
        SELECT 1 FROM public.company_features cf
        WHERE cf.company_id = c.id
          AND cf.feature_key = 'production'
          AND cf.is_active
          AND (cf.expires_at IS NULL OR cf.expires_at > now())
      )
ON CONFLICT (company_id) DO NOTHING;

-- ─── 2) Columns on existing tables ────────────────────────────────────────
-- Constant defaults: metadata-only (no table rewrite).

-- Rule 12: manual lot picks that differ from the FEFO plan.
ALTER TABLE public.prod_productions ADD COLUMN lot_pick_deviation boolean NOT NULL DEFAULT false;
ALTER TABLE public.prod_processings ADD COLUMN lot_pick_deviation boolean NOT NULL DEFAULT false;
ALTER TABLE public.prod_separations ADD COLUMN lot_pick_deviation boolean NOT NULL DEFAULT false;
ALTER TABLE public.prod_transfers ADD COLUMN lot_pick_deviation boolean NOT NULL DEFAULT false;
ALTER TABLE public.prod_writeoffs ADD COLUMN lot_pick_deviation boolean NOT NULL DEFAULT false;
ALTER TABLE public.prod_sales ADD COLUMN lot_pick_deviation boolean NOT NULL DEFAULT false;

-- Rule 9: supply moves can be cancelled (supply_cancel_move).
ALTER TABLE public.supply_cash_moves
  ADD COLUMN status text NOT NULL DEFAULT 'posted',
  ADD COLUMN cancelled_at timestamptz NULL,
  ADD COLUMN cancelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN cancel_note text NULL;

ALTER TABLE public.supply_cash_moves
  ADD CONSTRAINT supply_cash_moves_status_check CHECK (status IN ('posted', 'cancelled')),
  ADD CONSTRAINT supply_cash_moves_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT supply_cash_moves_cancel_note_check CHECK (cancel_note IS NULL OR length(cancel_note) <= 500);

-- ─── 3) Views (same columns / order / types) ─────────────────────────────

-- supply_agent_balances: body of 03, cancelled moves excluded.
CREATE OR REPLACE VIEW public.supply_agent_balances
WITH (security_invoker = true)
AS
SELECT
  a.id AS agent_id,
  a.company_id,
  COALESCE(m.issued, 0) AS issued,
  COALESCE(m.returned, 0) AS returned,
  COALESCE(m.spent, 0) AS spent,
  (COALESCE(m.issued, 0) - COALESCE(m.returned, 0) - COALESCE(m.spent, 0)) AS balance
FROM public.supply_agents a
LEFT JOIN (
  SELECT
    agent_id,
    company_id,
    sum(amount) FILTER (WHERE kind = 'issue') AS issued,
    sum(amount) FILTER (WHERE kind = 'return') AS returned,
    sum(amount) FILTER (WHERE kind = 'expense') AS spent
  FROM public.supply_cash_moves
  WHERE status = 'posted'
  GROUP BY agent_id, company_id
) m ON m.agent_id = a.id AND m.company_id = a.company_id;

COMMENT ON VIEW public.supply_agent_balances IS
  'Per supply agent: issued / returned / spent over POSTED moves (cancelled excluded), balance = cash held.';

-- prod_cash_movements_v: body of 16; ONLY change: source_status of
-- supply_issue / supply_return comes from the move (was the constant 'posted').
CREATE OR REPLACE VIEW public.prod_cash_movements_v
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
    WHEN 'supply_issue' THEN COALESCE(sm.status, 'posted')
    WHEN 'supply_return' THEN COALESCE(sm.status, 'posted')
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
LEFT JOIN public.supply_cash_moves sm
  ON m.source_type IN ('supply_issue', 'supply_return') AND sm.id = m.source_id AND sm.company_id = m.company_id
LEFT JOIN public.prod_cash_accounts pa
  ON pa.company_id = m.company_id
 AND pa.id = CASE WHEN m.account_id = ct.from_account_id THEN ct.to_account_id ELSE ct.from_account_id END
LEFT JOIN public.expense_categories ec
  ON ec.id = m.category_id AND ec.company_id = m.company_id;

COMMENT ON VIEW public.prod_cash_movements_v IS
  'Production cash ledger lines: account, source document number / status (supply moves: their status), '
  'transfer peer, category, running_balance per account (opening_balance + sum ordered by move_date, '
  'created_at, id).';

REVOKE ALL ON public.supply_agent_balances FROM authenticated, anon;
GRANT SELECT ON public.supply_agent_balances TO authenticated;
REVOKE ALL ON public.prod_cash_movements_v FROM authenticated, anon;
GRANT SELECT ON public.prod_cash_movements_v TO authenticated;

-- ─── 4) Internal helpers (EXECUTE revoked from every client role) ─────────
-- SECURITY DEFINER with explicit company ids; reachable only from the RPCs
-- below, which derive the company from get_company_id().

-- Business date (Asia/Tashkent) of a timestamp; NULL -> today.
CREATE OR REPLACE FUNCTION public.prod_biz_date(p_at timestamptz)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT (COALESCE(p_at, now()) AT TIME ZONE 'Asia/Tashkent')::date
$$;

-- Role of the caller (NULL when the caller has no users row).
CREATE OR REPLACE FUNCTION public.prod_ctl_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.role FROM public.users u WHERE u.id = auth.uid()
$$;

-- The company's control settings; the row is created with the defaults on
-- first use (ON CONFLICT: concurrent first use is safe).
CREATE OR REPLACE FUNCTION public.prod_ctl_settings(p_company_id uuid)
RETURNS public.prod_control_settings
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.prod_control_settings%ROWTYPE;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT * INTO v_row FROM public.prod_control_settings WHERE company_id = p_company_id;
  IF NOT FOUND THEN
    INSERT INTO public.prod_control_settings (company_id) VALUES (p_company_id)
    ON CONFLICT (company_id) DO NOTHING;
    SELECT * INTO v_row FROM public.prod_control_settings WHERE company_id = p_company_id;
  END IF;
  RETURN v_row;
END;
$$;

-- Append one audit row (caller = auth.uid(), name from users).
CREATE OR REPLACE FUNCTION public.prod_audit_write(
  p_company_id uuid, p_entity text, p_entity_id uuid, p_action text,
  p_old jsonb, p_new jsonb, p_rule text, p_note text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.prod_audit_log (company_id, user_id, user_name, entity, entity_id, action, old, new, rule, note)
  VALUES (
    p_company_id, auth.uid(), (SELECT u.full_name FROM public.users u WHERE u.id = auth.uid()),
    p_entity, p_entity_id, p_action, p_old, p_new, p_rule, left(p_note, 500)
  );
END;
$$;

-- A violated rule: only an owner / admin passing p_ctl.override = true and
-- p_ctl.override_note (>= 5 chars) may continue; the override is logged
-- (once per transaction, entity and rule). Everyone else ->
-- 'needs_approval' DETAIL = rule code. Owner / admin with override but a
-- missing / short note -> invalid_input DETAIL 'override_note'.
CREATE OR REPLACE FUNCTION public.prod_ctl_require(
  p_company_id uuid, p_rule text, p_ctl jsonb, p_entity text, p_entity_id uuid, p_info jsonb
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_override boolean := false;
  v_note text;
  v_role text;
BEGIN
  IF p_ctl IS NOT NULL AND jsonb_typeof(p_ctl) = 'object' THEN
    v_override := COALESCE(public.prod_jbool(p_ctl, 'override'), false);
  END IF;
  v_role := public.prod_ctl_role();
  IF NOT v_override OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'needs_approval' USING DETAIL = p_rule;
  END IF;
  v_note := public.prod_jtext(p_ctl, 'override_note', 500);
  IF v_note IS NULL OR char_length(v_note) < 5 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'override_note';
  END IF;
  -- now() is the transaction start: one row per (transaction, entity, rule).
  IF NOT EXISTS (
    SELECT 1 FROM public.prod_audit_log
    WHERE company_id = p_company_id AND action = 'override' AND rule = p_rule
      AND entity = COALESCE(p_entity, 'unknown') AND entity_id IS NOT DISTINCT FROM p_entity_id
      AND at = now() AND user_id IS NOT DISTINCT FROM auth.uid()
  ) THEN
    PERFORM public.prod_audit_write(p_company_id, COALESCE(p_entity, 'unknown'), p_entity_id, 'override',
                                    NULL, p_info, p_rule, v_note);
  END IF;
END;
$$;

-- Date guard of every create / post / cancel (rule 5).
--   p_kind 'create': date <= locked_until -> 'period_closed' (DETAIL the
--     lock date, never overridable); date > today + future_days ->
--     invalid_input DETAIL 'future_date'; date < today - backdate days
--     (staff / manager: backdate_days_staff, owner / admin:
--     backdate_days_admin) -> rule 'backdate' (prod_ctl_require).
--   p_kind 'cancel': only the period lock (the document's own date).
-- Takes the period row FOR SHARE (created lazily), so a concurrent
-- prod_close_period (FOR UPDATE) waits for in-flight postings and later
-- postings see the new lock date.
CREATE OR REPLACE FUNCTION public.prod_assert_date(
  p_company_id uuid, p_date date, p_kind text,
  p_ctl jsonb DEFAULT NULL, p_entity text DEFAULT NULL, p_entity_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_locked date;
  v_set public.prod_control_settings%ROWTYPE;
  v_today date;
  v_role text;
  v_days integer;
BEGIN
  IF p_company_id IS NULL OR p_date IS NULL OR p_kind IS NULL OR p_kind NOT IN ('create', 'cancel') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT locked_until INTO v_locked
  FROM public.prod_period_locks WHERE company_id = p_company_id
  FOR SHARE;
  IF NOT FOUND THEN
    INSERT INTO public.prod_period_locks (company_id) VALUES (p_company_id)
    ON CONFLICT (company_id) DO NOTHING;
    SELECT locked_until INTO v_locked
    FROM public.prod_period_locks WHERE company_id = p_company_id
    FOR SHARE;
  END IF;
  IF v_locked IS NOT NULL AND p_date <= v_locked THEN
    RAISE EXCEPTION 'period_closed' USING DETAIL = v_locked::text;
  END IF;

  IF p_kind = 'cancel' THEN
    RETURN;
  END IF;

  v_set := public.prod_ctl_settings(p_company_id);
  v_today := public.prod_biz_date(now());
  IF p_date > v_today + v_set.future_days THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'future_date';
  END IF;
  v_role := public.prod_ctl_role();
  v_days := CASE WHEN v_role IN ('owner', 'admin') THEN v_set.backdate_days_admin ELSE v_set.backdate_days_staff END;
  IF p_date < v_today - v_days THEN
    PERFORM public.prod_ctl_require(p_company_id, 'backdate', p_ctl, p_entity, p_entity_id,
      jsonb_build_object('date', p_date, 'today', v_today, 'allowed_days', v_days));
  END IF;
END;
$$;

-- Common guard of every cancel (rules 5, 6, 7): period lock on the
-- document date, self-cancel, audit row (action 'cancel').
-- p_creators: users who created / posted the document (NULLs ignored).
-- self_cancel_allowed = false: a non-owner who is one of p_creators ->
-- 'self_cancel' (not overridable: an owner must cancel it).
CREATE OR REPLACE FUNCTION public.prod_ctl_cancel(
  p_company_id uuid, p_entity text, p_id uuid, p_date date, p_creators uuid[], p_doc_type text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set public.prod_control_settings%ROWTYPE;
BEGIN
  PERFORM public.prod_assert_date(p_company_id, p_date, 'cancel');
  v_set := public.prod_ctl_settings(p_company_id);
  IF NOT v_set.self_cancel_allowed
     AND COALESCE(public.prod_ctl_role(), '') <> 'owner'
     AND auth.uid() IS NOT NULL
     AND auth.uid() = ANY (p_creators) THEN
    RAISE EXCEPTION 'self_cancel';
  END IF;
  PERFORM public.prod_audit_write(p_company_id, p_entity, p_id, 'cancel', NULL,
    jsonb_build_object('doc_type', p_doc_type, 'doc_date', p_date), NULL, NULL);
END;
$$;

-- Rule 13: inflow RPCs take the item rows FOR SHARE (ascending id) before
-- any stock key / number lock, so prod_change_item_unit (item FOR UPDATE ->
-- stock keys) can never interleave with a new lot of the old unit.
CREATE OR REPLACE FUNCTION public.prod_lock_items_share(p_company_id uuid, p_item_ids uuid[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1
  FROM public.prod_items i
  WHERE i.company_id = p_company_id
    AND i.id IN (SELECT DISTINCT x FROM unnest(p_item_ids) AS t(x) WHERE x IS NOT NULL)
  ORDER BY i.id
  FOR SHARE;
END;
$$;

-- Control context passed to prod_consume: override fields of the request,
-- the document's business date and the audited entity (table name).
CREATE OR REPLACE FUNCTION public.prod_ctl_ctx(p_data jsonb, p_biz_date date, p_entity text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'override', CASE WHEN p_data IS NOT NULL AND jsonb_typeof(p_data) = 'object' THEN p_data->'override' END,
    'override_note', CASE WHEN p_data IS NOT NULL AND jsonb_typeof(p_data) = 'object' THEN p_data->'override_note' END,
    'biz_date', p_biz_date,
    'entity', p_entity
  )
$$;

REVOKE EXECUTE ON FUNCTION public.prod_biz_date(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_ctl_role() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_ctl_settings(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_audit_write(uuid, text, uuid, text, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_ctl_require(uuid, text, jsonb, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_assert_date(uuid, date, text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_ctl_cancel(uuid, text, uuid, date, uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_lock_items_share(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_ctl_ctx(jsonb, date, text) FROM PUBLIC, anon, authenticated;

-- ─── 5) Master-data audit trigger (rule 7) ────────────────────────────────
-- AFTER INSERT / UPDATE / DELETE, row level. INSERT: new = full row;
-- DELETE: old = full row; UPDATE: old / new = ONLY the changed columns
-- (updated_at ignored; no row when nothing else changed). entity_id = the
-- row's id (prod_milk_settings / prod_control_settings: company_id).
-- prod_control_settings updates are logged with action 'settings'.
-- Rows removed by the company ON DELETE CASCADE are not logged (the
-- company and its log are gone).
CREATE OR REPLACE FUNCTION public.prod_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_o jsonb;
  v_n jsonb;
  v_row jsonb;
  v_company uuid;
  v_action text;
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_company := (v_old->>'company_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = v_company) THEN
      RETURN NULL;
    END IF;
    v_o := v_old;
    v_n := NULL;
    v_row := v_old;
  ELSIF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_company := (v_new->>'company_id')::uuid;
    v_o := NULL;
    v_n := v_new;
    v_row := v_new;
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_company := (v_new->>'company_id')::uuid;
    v_o := '{}'::jsonb;
    v_n := '{}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(v_new)
    LOOP
      CONTINUE WHEN k = 'updated_at';
      IF (v_old->k) IS DISTINCT FROM (v_new->k) THEN
        v_o := v_o || jsonb_build_object(k, v_old->k);
        v_n := v_n || jsonb_build_object(k, v_new->k);
      END IF;
    END LOOP;
    IF v_n = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    v_row := v_new;
  END IF;

  v_action := CASE
    WHEN TG_TABLE_NAME = 'prod_control_settings' AND TG_OP = 'UPDATE' THEN 'settings'
    ELSE lower(TG_OP)
  END;

  PERFORM public.prod_audit_write(
    v_company, TG_TABLE_NAME,
    CASE WHEN v_row ? 'id' THEN (v_row->>'id')::uuid ELSE (v_row->>'company_id')::uuid END,
    v_action, v_o, v_n, NULL, NULL
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_audit_trigger() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'prod_items', 'prod_suppliers', 'prod_customers', 'prod_warehouses', 'prod_recipes',
    'prod_recipe_lines', 'prod_milk_settings', 'prod_price_lists', 'prod_price_list_items',
    'prod_cash_accounts', 'prod_control_settings'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER prod_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.prod_audit_trigger()',
      t
    );
  END LOOP;
END;
$$;

-- ─── 6) prod_consume with a control context (rules 11, 12) ───────────────
-- NEW 9-arg overload. Body = the 8-arg one of 20261110000014 plus:
--   p_ctl (prod_ctl_ctx): { override, override_note, biz_date, entity }.
--   NULL -> biz_date = today (Tashkent), no override, entity 'unknown'.
--   * Expired lots (expiry_date < biz_date) are skipped by the automatic
--     FEFO plan in hold modes 'strict' and 'pick'; 'any' (write-off,
--     stock-count shortage) still takes them (spoiled stock is written off
--     exactly there). Not enough unexpired stock -> insufficient_stock
--     (DETAIL item id, unchanged contract).
--   * A manual pick of an expired lot (modes 'strict' / 'pick') -> rule
--     'expired_lot' (owner / admin override, logged).
--   * Manual picks by a role not in settings.manual_lot_pick_roles -> rule
--     'manual_pick'.
--   * deviation: a manual plan that differs from the FEFO plan the server
--     would have used (other lots or other quantities, or FEFO impossible).
-- Returns the 8-arg object + { deviation boolean }.
CREATE OR REPLACE FUNCTION public.prod_consume(
  p_company_id uuid, p_warehouse_id uuid, p_item_id uuid, p_qty numeric,
  p_doc_type text, p_doc_id uuid, p_picks jsonb, p_hold_mode text, p_ctl jsonb
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
  v_hold text;
  v_expiry date;
  v_rec record;
  v_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_fefo_ids uuid[] := '{}';
  v_fefo_qtys numeric[] := '{}';
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
  v_biz date;
  v_entity text;
  v_skip_expired boolean;
  v_set public.prod_control_settings%ROWTYPE;
  v_role text;
  v_deviation boolean := false;
  i integer;
BEGIN
  IF p_company_id IS NULL OR p_warehouse_id IS NULL OR p_item_id IS NULL
     OR p_doc_type IS NULL OR p_doc_id IS NULL
     OR p_qty IS NULL OR p_qty <= 0
     OR p_hold_mode IS NULL OR p_hold_mode NOT IN ('strict', 'pick', 'any') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_ctl IS NOT NULL AND jsonb_typeof(p_ctl) = 'object' THEN
    v_biz := public.prod_jdate(p_ctl, 'biz_date');
    v_entity := public.prod_jtext(p_ctl, 'entity', 63);
  END IF;
  v_biz := COALESCE(v_biz, public.prod_biz_date(now()));
  v_entity := COALESCE(v_entity, 'unknown');
  v_skip_expired := p_hold_mode <> 'any';

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

  -- FEFO plan (always computed: it is the plan for an automatic call and
  -- the reference for a manual one). 'any': free lots first, then held /
  -- blocked ones. Expired lots skipped unless 'any'.
  v_left := p_qty;
  FOR v_rec IN
    SELECT x.id, x.remaining
    FROM (
      SELECT l.id, l.expiry_date, l.received_at, l.lot_no, l.hold_status,
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
      AND (p_hold_mode = 'any' OR x.hold_status = 'free')
      AND (NOT v_skip_expired OR x.expiry_date IS NULL OR x.expiry_date >= v_biz)
    ORDER BY (x.hold_status <> 'free'), x.expiry_date NULLS LAST, x.received_at, length(x.lot_no), x.lot_no
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, v_rec.remaining);
    v_fefo_ids := v_fefo_ids || v_rec.id;
    v_fefo_qtys := v_fefo_qtys || v_take;
    v_left := v_left - v_take;
  END LOOP;

  IF v_picks IS NULL THEN
    IF v_left > 0 THEN
      RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p_item_id::text;
    END IF;
    v_ids := v_fefo_ids;
    v_qtys := v_fefo_qtys;
  ELSE
    -- Manual plan.
    v_set := public.prod_ctl_settings(p_company_id);
    v_role := public.prod_ctl_role();
    IF v_role IS NULL OR NOT (v_role = ANY (v_set.manual_lot_pick_roles)) THEN
      PERFORM public.prod_ctl_require(p_company_id, 'manual_pick', p_ctl, v_entity, p_doc_id,
        jsonb_build_object('item_id', p_item_id, 'role', v_role));
    END IF;

    FOR v_pick IN SELECT * FROM jsonb_array_elements(v_picks)
    LOOP
      v_lot_id := public.prod_juuid(v_pick, 'lot_id');
      v_q := public.prod_jnum(v_pick, 'qty', 3);
      IF v_lot_id IS NULL OR v_q IS NULL OR v_q <= 0 OR v_lot_id = ANY (v_ids) THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      SELECT l.hold_status, l.expiry_date INTO v_hold, v_expiry
      FROM public.prod_lots l
      WHERE l.id = v_lot_id AND l.company_id = p_company_id
        AND l.warehouse_id = p_warehouse_id AND l.item_id = p_item_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
      IF p_hold_mode = 'strict' AND v_hold <> 'free' THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'lot_on_hold';
      END IF;
      v_rem := public.prod_lot_remaining(p_company_id, v_lot_id);
      IF v_q > v_rem THEN
        RAISE EXCEPTION 'insufficient_stock' USING DETAIL = p_item_id::text;
      END IF;
      IF v_skip_expired AND v_expiry IS NOT NULL AND v_expiry < v_biz THEN
        PERFORM public.prod_ctl_require(p_company_id, 'expired_lot', p_ctl, v_entity, p_doc_id,
          jsonb_build_object('item_id', p_item_id, 'lot_id', v_lot_id, 'expiry_date', v_expiry, 'qty', v_q));
      END IF;
      v_ids := v_ids || v_lot_id;
      v_qtys := v_qtys || v_q;
      v_sum := v_sum + v_q;
    END LOOP;
    IF v_sum <> p_qty THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    -- Deviation from FEFO: compared as sets of (lot, qty).
    v_deviation := v_left > 0 OR EXISTS (
      (SELECT a.id, a.q FROM unnest(v_ids, v_qtys) AS a(id, q)
       EXCEPT
       SELECT b.id, b.q FROM unnest(v_fefo_ids, v_fefo_qtys) AS b(id, q))
      UNION ALL
      (SELECT b.id, b.q FROM unnest(v_fefo_ids, v_fefo_qtys) AS b(id, q)
       EXCEPT
       SELECT a.id, a.q FROM unnest(v_ids, v_qtys) AS a(id, q))
    );
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
    'lots', v_lots,
    'deviation', v_deviation
  );
END;
$$;

-- 8-arg (replaced, same signature): = 9-arg without a control context.
CREATE OR REPLACE FUNCTION public.prod_consume(
  p_company_id uuid, p_warehouse_id uuid, p_item_id uuid, p_qty numeric,
  p_doc_type text, p_doc_id uuid, p_picks jsonb, p_hold_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.prod_consume(p_company_id, p_warehouse_id, p_item_id, p_qty,
                             p_doc_type, p_doc_id, p_picks, p_hold_mode, NULL::jsonb);
END;
$$;

-- 7-arg (replaced, same signature): = hold mode 'strict', no context.
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
BEGIN
  RETURN public.prod_consume(p_company_id, p_warehouse_id, p_item_id, p_qty,
                             p_doc_type, p_doc_id, p_picks, 'strict'::text, NULL::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_consume(uuid, uuid, uuid, numeric, text, uuid, jsonb, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_consume(uuid, uuid, uuid, numeric, text, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prod_consume(uuid, uuid, uuid, numeric, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ─── 7) RPCs (replaced: bodies copied from the latest definition) ────────

-- ═══ prod_create_receipt (replaced, same signature) ══════════════════════
-- Body copied from 20261110000013 (latest definition). Additions:
--   * id generated first (audit entity id); prod_assert_date on the doc
--     business date (period_closed / future_date / backdate).
--   * line expiry_date < doc business date -> invalid_input DETAIL
--     'expiry_in_past' (rule 11).
--   * rule 10: a raw-item line with price 0 -> 'receipt_zero_price'; a
--     receipt with a raw item and no supplier_id -> 'receipt_no_supplier'
--     (owner / admin override with override + override_note).
--   * rule 13: item rows FOR SHARE before the number lock.
--   Locks: supplier SHARE -> period row SHARE -> items SHARE ->
--   'prod_receipt_no' -> 'prod_lot_no'.
-- p_data: { doc_date, warehouse_id, supplier_id, supplier_name, note,
--           override, override_note,
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
  v_biz date;
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
  v_has_raw boolean;
  v_zero_raw uuid[];
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
  v_biz := public.prod_biz_date(v_doc_date);
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_supplier_id := public.prod_juuid(p_data, 'supplier_id');
  v_supplier := public.prod_jtext(p_data, 'supplier_name', 200);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_id := gen_random_uuid();

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
    IF v_expiry IS NOT NULL AND v_expiry < v_biz THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'expiry_in_past';
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

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_receipts', v_id);

  -- Rule 10 (raw items only).
  SELECT bool_or(it.item_type = 'raw'),
         array_agg(it.id ORDER BY it.id) FILTER (
           WHERE it.item_type = 'raw'
             AND EXISTS (SELECT 1 FROM unnest(v_item_ids, v_prices) AS l(item_id, price)
                         WHERE l.item_id = it.id AND l.price = 0))
  INTO v_has_raw, v_zero_raw
  FROM public.prod_items it
  WHERE it.company_id = v_company_id AND it.id = ANY (v_item_ids);
  IF v_zero_raw IS NOT NULL THEN
    PERFORM public.prod_ctl_require(v_company_id, 'receipt_zero_price', p_data, 'prod_receipts', v_id,
      jsonb_build_object('item_ids', to_jsonb(v_zero_raw)));
  END IF;
  IF COALESCE(v_has_raw, false) AND v_supplier_id IS NULL THEN
    PERFORM public.prod_ctl_require(v_company_id, 'receipt_no_supplier', p_data, 'prod_receipts', v_id,
      jsonb_build_object('supplier_name', v_supplier, 'total', v_total));
  END IF;

  PERFORM public.prod_lock_items_share(v_company_id, v_item_ids);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_receipt_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_receipts WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_receipts (
    id, company_id, number, doc_date, warehouse_id, supplier_id, supplier_name, note, total,
    status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_supplier_id, v_supplier, v_note, v_total,
    'posted', auth.uid(), v_user_name
  );

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
-- Body copied from 20261110000013 (latest definition). Now SECURITY
-- DEFINER (EXECUTE stays revoked from clients). Additions (rules 4, 5, 6,
-- 34; override fields are read from p_lab):
--   * prod_assert_date on the intake business date ('create').
--   * 'lab_same_user': settings.lab_must_differ and the caller weighed the
--     milk (intake created_by) -> rule (any decision).
--   * 'antibiotic': decision 'accepted' with antibiotic 'positive' ->
--     'forbidden' DETAIL 'antibiotic' (NEVER overridable; 'conditional' /
--     'rejected' allowed).
--   * 'milk_threshold': decision 'accepted' with acidity > max_acidity,
--     fat < min_fat, density < min_density or temperature > max_temperature
--     (prod_milk_settings, defaults 19 / 2.8 / 1.027 / 10) -> rule.
--   * 'conditional_price': conditional price_per_kg_override outside
--     [base * conditional_price_min_pct / 100, base], base = supplier
--     milk_price_per_kg else settings default_price_per_kg -> rule.
--   * rule 13: the milk item row FOR SHARE before the receipt number lock.
CREATE OR REPLACE FUNCTION public.prod_milk_apply_lab(p_company_id uuid, p_intake_id uuid, p_lab jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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
  v_min_fat numeric;
  v_min_density numeric;
  v_max_acidity numeric;
  v_max_temp numeric;
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
  v_set public.prod_control_settings%ROWTYPE;
  v_cond_base numeric;
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

  -- Controls (before any write).
  PERFORM public.prod_assert_date(p_company_id, public.prod_biz_date(v_in.intake_date), 'create',
                                  p_lab, 'prod_milk_intakes', p_intake_id);

  v_set := public.prod_ctl_settings(p_company_id);
  IF v_set.lab_must_differ AND v_in.created_by IS NOT NULL AND v_in.created_by = auth.uid() THEN
    PERFORM public.prod_ctl_require(p_company_id, 'lab_same_user', p_lab, 'prod_milk_intakes', p_intake_id,
      jsonb_build_object('weighed_by', v_in.created_by, 'decision', v_decision));
  END IF;

  IF v_decision = 'accepted' AND v_antibiotic = 'positive' THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'antibiotic';
  END IF;

  SELECT pricing_mode, base_fat, base_protein, default_price_per_kg,
         min_fat, min_density, max_acidity, max_temperature
  INTO v_mode, v_base_fat, v_base_protein, v_default_price,
       v_min_fat, v_min_density, v_max_acidity, v_max_temp
  FROM public.prod_milk_settings
  WHERE company_id = p_company_id;
  IF NOT FOUND THEN
    v_mode := 'fat';
    v_base_fat := 3.4;
    v_base_protein := 3.0;
    v_default_price := 0;
    v_min_fat := 2.8;
    v_min_density := 1.027;
    v_max_acidity := 19;
    v_max_temp := 10;
  END IF;

  IF v_decision = 'accepted' AND (
       (v_acidity IS NOT NULL AND v_acidity > v_max_acidity)
    OR (v_fat IS NOT NULL AND v_fat < v_min_fat)
    OR (v_density IS NOT NULL AND v_density < v_min_density)
    OR (v_temperature IS NOT NULL AND v_temperature > v_max_temp)
  ) THEN
    PERFORM public.prod_ctl_require(p_company_id, 'milk_threshold', p_lab, 'prod_milk_intakes', p_intake_id,
      jsonb_build_object('fat_pct', v_fat, 'density', v_density, 'acidity', v_acidity, 'temperature', v_temperature,
                         'min_fat', v_min_fat, 'min_density', v_min_density, 'max_acidity', v_max_acidity,
                         'max_temperature', v_max_temp));
  END IF;

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
      v_cond_base := COALESCE(v_sup_price, v_default_price, 0);
      IF v_override > v_cond_base OR v_override < round(v_cond_base * v_set.conditional_price_min_pct / 100, 2) THEN
        PERFORM public.prod_ctl_require(p_company_id, 'conditional_price', p_lab, 'prod_milk_intakes', p_intake_id,
          jsonb_build_object('price_per_kg', v_override, 'base_price', v_cond_base,
                             'min_pct', v_set.conditional_price_min_pct));
      END IF;
      v_credited := v_in.net_kg;
      v_price := v_override;
      v_amount := round(v_in.net_kg * v_override, 2);
      IF v_amount >= 1e12 THEN
        RAISE EXCEPTION 'invalid_input';
      END IF;
    END IF;

    PERFORM public.prod_lock_items_share(p_company_id, ARRAY[v_in.item_id]);

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

REVOKE EXECUTE ON FUNCTION public.prod_milk_apply_lab(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ═══ prod_create_milk_intake (replaced, same signature) ══════════════════
-- Body copied from 20261110000010 (latest definition). Additions: id
-- generated first; prod_assert_date on the intake business date (override
-- fields at the top level of p_data); the inline lab block inherits the
-- top-level override / override_note when it has none of its own.
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
    IF NOT (v_lab ? 'override') AND p_data ? 'override' THEN
      v_lab := v_lab || jsonb_build_object('override', p_data->'override', 'override_note', p_data->'override_note');
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
  v_id := gen_random_uuid();

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

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_intake_date), 'create',
                                  p_data, 'prod_milk_intakes', v_id);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_milk_intake_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_milk_intakes WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_milk_intakes (
    id, company_id, number, intake_date, supplier_id, warehouse_id, item_id,
    vehicle_no, driver, gross_kg, tare_kg, net_kg, density, volume_l,
    status, note, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_intake_date, v_supplier_id, v_warehouse_id, v_item_id,
    v_vehicle, v_driver, v_gross, v_tare, v_net, v_density, v_volume,
    'weighed', v_note, auth.uid(), v_user_name
  );

  IF v_lab IS NOT NULL THEN
    -- Row inserted by this transaction: invisible to others, no lock needed.
    PERFORM public.prod_milk_apply_lab(v_company_id, v_id, v_lab);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_cancel_milk_intake (replaced, same signature) ══════════════════
-- Body copied from 20261110000010 (latest definition). Addition after the
-- row lock: prod_ctl_cancel (period lock on the intake date, self-cancel
-- for the weigher / lab user, audit row 'cancel').
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
  v_date timestamptz;
  v_created_by uuid;
  v_lab_by uuid;
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

  SELECT status, receipt_id, intake_date, created_by, lab_by
  INTO v_status, v_receipt_id, v_date, v_created_by, v_lab_by
  FROM public.prod_milk_intakes
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  PERFORM public.prod_ctl_cancel(v_company_id, 'prod_milk_intakes', p_id, public.prod_biz_date(v_date),
                                 ARRAY[v_created_by, v_lab_by], 'milk_intake');

  IF v_status IN ('accepted', 'conditional') THEN
    PERFORM public.prod_cancel_receipt_internal(v_company_id, v_receipt_id);
  END IF;

  UPDATE public.prod_milk_intakes
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_amend_milk_lab (replaced, same signature) ══════════════════════
-- Body copied from 20261110000014 (latest definition). Addition: the old
-- receipt is cancelled inside -> period lock on the intake date
-- (prod_assert_date 'cancel') before anything changes; the new decision
-- goes through every lab control of prod_milk_apply_lab (override fields
-- in p_lab). No self-cancel rule (an amend is a correction by the lab).
CREATE OR REPLACE FUNCTION public.prod_amend_milk_lab(p_intake_id uuid, p_lab jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_in record;
  v_receipt_status text;
  v_lot uuid;
  v_rem numeric;
  v_res jsonb;
  v_count integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_lab') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_intake_id IS NULL OR p_lab IS NULL OR jsonb_typeof(p_lab) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, status, receipt_id, warehouse_id, item_id, net_kg, intake_date INTO v_in
  FROM public.prod_milk_intakes
  WHERE id = p_intake_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_in.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_in.status NOT IN ('accepted', 'conditional') OR v_in.receipt_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_in.intake_date), 'cancel');

  SELECT status INTO v_receipt_status
  FROM public.prod_receipts
  WHERE id = v_in.receipt_id AND company_id = v_company_id
  FOR UPDATE;
  IF v_receipt_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.prod_price_corrections
    WHERE company_id = v_company_id AND receipt_id = v_in.receipt_id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'has_price_correction';
  END IF;

  PERFORM public.prod_lock_stock(v_company_id, v_in.warehouse_id, ARRAY[v_in.item_id]);

  SELECT l.id INTO v_lot
  FROM public.prod_lots l
  WHERE l.company_id = v_company_id AND l.source_doc_type = 'receipt'
    AND l.source_doc_id = v_in.receipt_id AND l.item_id = v_in.item_id;
  IF v_lot IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'lot_used';
  END IF;
  v_rem := public.prod_lot_remaining(v_company_id, v_lot);
  IF v_rem IS DISTINCT FROM v_in.net_kg THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'lot_used';
  END IF;

  PERFORM public.prod_cancel_receipt_internal(v_company_id, v_in.receipt_id);

  -- Back to 'weighed' (receipt_status CHECK: weighed has no receipt).
  UPDATE public.prod_milk_intakes
  SET status = 'weighed',
      receipt_id = NULL,
      pricing_mode = NULL,
      base_price_per_kg = NULL,
      credited_kg = NULL,
      price_per_kg = NULL,
      amount = NULL
  WHERE id = p_intake_id AND company_id = v_company_id;

  v_res := public.prod_milk_apply_lab(v_company_id, p_intake_id, p_lab);

  UPDATE public.prod_milk_intakes
  SET lab_amended_at = now(),
      lab_amend_count = lab_amend_count + 1
  WHERE id = p_intake_id AND company_id = v_company_id
  RETURNING lab_amend_count INTO v_count;

  RETURN v_res || jsonb_build_object('lab_amend_count', v_count, 'previous_receipt_id', v_in.receipt_id);
END;
$$;

-- ═══ prod_save_supplier (replaced, same signature) ═══════════════════════
-- Body copied from 20261110000014 (latest definition). Addition (rule 4,
-- 'supplier_price_change'): setting milk_price_per_kg on create (non-NULL)
-- or changing it on update is allowed for owner / admin only; anyone else
-- -> 'forbidden' DETAIL 'supplier_price_change' (NOT overridable). Every
-- change is logged by the prod_audit trigger (old / new value, who, when).
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
  v_old_name text;
  v_old_price numeric;
  v_phone text;
  v_address text;
  v_note text;
  v_active boolean;
  v_has_milk_price boolean;
  v_milk_price numeric;
  v_has_terms boolean;
  v_terms numeric;
  v_role text;
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
  v_has_terms := p_data ? 'payment_terms_days';
  v_terms := public.prod_jnum(p_data, 'payment_terms_days', 3);
  v_role := public.prod_ctl_role();

  IF v_name IS NULL OR (v_milk_price IS NOT NULL AND v_milk_price < 0)
     OR (v_terms IS NOT NULL AND (v_terms <> trunc(v_terms) OR v_terms NOT BETWEEN 0 AND 365)) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_supplier_save:' || v_company_id::text, 0));

  IF p_id IS NOT NULL THEN
    SELECT name, milk_price_per_kg INTO v_old_name, v_old_price
    FROM public.prod_suppliers
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  IF COALESCE(v_role, '') NOT IN ('owner', 'admin') AND (
       (p_id IS NULL AND v_milk_price IS NOT NULL)
    OR (p_id IS NOT NULL AND v_has_milk_price AND v_milk_price IS DISTINCT FROM v_old_price)
  ) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'supplier_price_change';
  END IF;

  IF (p_id IS NULL OR lower(btrim(v_old_name)) <> lower(v_name)) AND EXISTS (
    SELECT 1 FROM public.prod_suppliers
    WHERE company_id = v_company_id AND lower(btrim(name)) = lower(v_name)
      AND (p_id IS NULL OR id <> p_id)
  ) THEN
    RAISE EXCEPTION 'duplicate' USING DETAIL = 'name';
  END IF;

  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.prod_suppliers (company_id, name, phone, address, note, is_active, milk_price_per_kg,
                                         payment_terms_days)
      VALUES (v_company_id, v_name, v_phone, v_address, v_note, COALESCE(v_active, true), v_milk_price,
              v_terms::integer)
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.prod_suppliers
      SET name = v_name,
          phone = v_phone,
          address = v_address,
          note = v_note,
          is_active = COALESCE(v_active, is_active),
          milk_price_per_kg = CASE WHEN v_has_milk_price THEN v_milk_price ELSE milk_price_per_kg END,
          payment_terms_days = CASE WHEN v_has_terms THEN v_terms::integer ELSE payment_terms_days END,
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

-- ═══ prod_create_production (replaced, same signature) ═══════════════════
-- Body copied from 20261110000013 (latest definition). Additions:
--   * prod_assert_date on the doc business date.
--   * rule 1: without recipe_id -> 'production_no_recipe'. With a recipe:
--     scale = output_qty / recipe.output_qty; for every recipe line
--     planned = line.qty * scale and |qty - planned| / planned must be <=
--     production_tolerance_pct (a missing recipe component counts as
--     qty 0; a component that is not in the recipe is a violation too),
--     and the output must be within the same tolerance of
--     recipe.output_qty * (sum of recipe-component qty / sum of recipe
--     line qty) -> else 'production_yield'.
--     planned_qty of a recipe component is now the SERVER value
--     (round(line.qty * scale, 4)); the client value is kept only for runs
--     without a recipe / components outside the recipe.
--   * lots: prod_consume 9-arg (expired lots skipped, manual pick rules);
--     lot_pick_deviation stored.
--   * rule 13: output item row FOR SHARE before the stock keys.
-- p_data: + override, override_note. Return shape unchanged.
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
  v_biz date;
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
  v_recipe_out numeric;
  v_set public.prod_control_settings%ROWTYPE;
  v_tol numeric;
  v_rl record;
  v_actual numeric;
  v_plan numeric;
  v_dev numeric;
  v_max_dev numeric := 0;
  v_in_sum numeric := 0;
  v_rl_sum numeric := 0;
  v_expected numeric;
  v_bad boolean := false;
  v_extra uuid[];
  v_ctl jsonb;
  v_deviation boolean := false;
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
  v_biz := public.prod_biz_date(v_doc_date);
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_output_warehouse_id := public.prod_juuid(p_data, 'output_warehouse_id');
  v_output_item_id := public.prod_juuid(p_data, 'output_item_id');
  v_output_qty := public.prod_jnum(p_data, 'output_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_recipe_id := public.prod_juuid(p_data, 'recipe_id');
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_productions');

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
    SELECT item_id, version, output_qty INTO v_recipe_item_id, v_recipe_version, v_recipe_out
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

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_productions', v_id);

  -- Rule 1: yield against the recipe.
  IF v_recipe_id IS NULL THEN
    PERFORM public.prod_ctl_require(v_company_id, 'production_no_recipe', p_data, 'prod_productions', v_id,
      jsonb_build_object('output_item_id', v_output_item_id, 'output_qty', v_output_qty));
  ELSE
    v_set := public.prod_ctl_settings(v_company_id);
    v_tol := v_set.production_tolerance_pct / 100;
    FOR v_rl IN
      SELECT l.item_id, l.qty
      FROM public.prod_recipe_lines l
      WHERE l.recipe_id = v_recipe_id AND l.company_id = v_company_id
    LOOP
      v_plan := v_rl.qty * v_output_qty / v_recipe_out;
      v_actual := COALESCE((SELECT q FROM unnest(v_item_ids, v_qtys) AS c(id, q) WHERE c.id = v_rl.item_id), 0);
      v_in_sum := v_in_sum + v_actual;
      v_rl_sum := v_rl_sum + v_rl.qty;
      IF v_plan > 0 THEN
        v_dev := abs(v_actual - v_plan) / v_plan;
        v_max_dev := GREATEST(v_max_dev, v_dev);
        IF v_dev > v_tol THEN
          v_bad := true;
        END IF;
      END IF;
      FOR i IN 1 .. cardinality(v_item_ids)
      LOOP
        IF v_item_ids[i] = v_rl.item_id THEN
          v_planned[i] := round(v_plan, 4);
        END IF;
      END LOOP;
    END LOOP;

    SELECT array_agg(c.id) INTO v_extra
    FROM unnest(v_item_ids) AS c(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.prod_recipe_lines l
                      WHERE l.recipe_id = v_recipe_id AND l.company_id = v_company_id AND l.item_id = c.id);
    IF v_extra IS NOT NULL THEN
      v_bad := true;
    END IF;

    IF v_rl_sum > 0 THEN
      v_expected := v_recipe_out * v_in_sum / v_rl_sum;
      IF v_expected <= 0 OR abs(v_output_qty - v_expected) / v_expected > v_tol THEN
        v_bad := true;
      END IF;
    END IF;

    IF v_bad THEN
      PERFORM public.prod_ctl_require(v_company_id, 'production_yield', p_data, 'prod_productions', v_id,
        jsonb_build_object('recipe_id', v_recipe_id, 'output_qty', v_output_qty,
                           'expected_output', round(v_expected, 3), 'max_component_dev_pct', round(v_max_dev * 100, 2),
                           'extra_components', to_jsonb(v_extra), 'tolerance_pct', v_set.production_tolerance_pct));
    END IF;
  END IF;

  PERFORM public.prod_lock_items_share(v_company_id, ARRAY[v_output_item_id]);

  -- Stock locks (sorted; source warehouse only), then consume under them.
  PERFORM public.prod_lock_stock(v_company_id, v_warehouse_id, v_item_ids);

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_warehouse_id, v_item_ids[i], v_qtys[i],
                                 'production', v_id, v_picks[i], 'strict', v_ctl);
    v_line_cost := (v_res->>'cost')::numeric;
    v_totals := v_totals || v_line_cost;
    v_costs := v_costs || round(v_line_cost / v_qtys[i], 2);
    v_total_cost := v_total_cost + v_line_cost;
    v_deviation := v_deviation OR COALESCE((v_res->>'deviation')::boolean, false);
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
    recipe_id, recipe_version, lot_pick_deviation
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_warehouse_id, v_output_item_id, v_output_qty,
    v_total_cost, v_unit_cost, v_note, 'posted', auth.uid(), v_user_name,
    v_recipe_id, v_recipe_version, v_deviation
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
-- Body copied from 20261110000013 (latest definition). Additions:
--   * prod_assert_date; rule 3 'processing_recovery': recovery_cost <
--     processing_cost * processing_min_recovery_pct / 100, or any output
--     price 0 -> rule (checked after the exact lot cost is known).
--   * prod_consume 9-arg, lot_pick_deviation; output items FOR SHARE.
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
  v_biz date;
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
  v_set public.prod_control_settings%ROWTYPE;
  v_ctl jsonb;
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
  v_biz := public.prod_biz_date(v_doc_date);
  v_warehouse_id := public.prod_juuid(p_data, 'warehouse_id');
  v_output_warehouse_id := public.prod_juuid(p_data, 'output_warehouse_id');
  v_source_item_id := public.prod_juuid(p_data, 'source_item_id');
  v_source_qty := public.prod_jnum(p_data, 'source_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_processings');

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

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_processings', v_id);

  PERFORM public.prod_lock_items_share(v_company_id, v_item_ids);

  PERFORM public.prod_lock_stock(v_company_id, v_warehouse_id, ARRAY[v_source_item_id]);

  v_res := public.prod_consume(v_company_id, v_warehouse_id, v_source_item_id, v_source_qty,
                               'processing', v_id, p_data->'source_lots', 'strict', v_ctl);
  v_processing_cost := (v_res->>'cost')::numeric;
  v_source_unit_cost := round(v_processing_cost / v_source_qty, 2);
  v_profit := v_recovery - v_processing_cost;

  -- Rule 3: recovery value.
  v_set := public.prod_ctl_settings(v_company_id);
  IF 0 = ANY (v_prices)
     OR v_recovery < round(v_processing_cost * v_set.processing_min_recovery_pct / 100, 2) THEN
    PERFORM public.prod_ctl_require(v_company_id, 'processing_recovery', p_data, 'prod_processings', v_id,
      jsonb_build_object('processing_cost', v_processing_cost, 'recovery_cost', v_recovery,
                         'min_recovery_pct', v_set.processing_min_recovery_pct,
                         'zero_price', 0 = ANY (v_prices)));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_processing_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_processings WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_processings (
    id, company_id, number, doc_date, warehouse_id, output_warehouse_id, source_item_id, source_qty,
    source_unit_cost, processing_cost, recovery_cost, profit, note, status,
    created_by, created_by_name, lot_pick_deviation
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_output_warehouse_id, v_source_item_id, v_source_qty,
    v_source_unit_cost, v_processing_cost, v_recovery, v_profit, v_note, 'posted',
    auth.uid(), v_user_name, COALESCE((v_res->>'deviation')::boolean, false)
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

-- ═══ prod_create_separation (replaced, same signature) ═══════════════════
-- Body copied from 20261110000013 (latest definition). Additions (rule 2),
-- checked after the quantities are final (manual cream_qty / skim_qty
-- included):
--   * 'separation_loss': loss_qty / milk_qty * 100 > separation_loss_max_pct.
--   * 'separation_fat': fat in = milk_qty * F / 100, F = fat of the consumed
--     lots (server value) when known, else milk_fat; fat out = cream_qty *
--     cream_fat / 100 + skim_qty * skim_fat / 100; out > in * (1 + tol) or
--     out < in * (1 - tol - loss_qty / milk_qty) -> rule
--     (tol = separation_fat_tolerance_pct / 100).
--   * prod_assert_date; prod_consume 9-arg; lot_pick_deviation; cream /
--     skim item rows FOR SHARE before the milk stock key.
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
  v_biz date;
  v_number integer;
  v_id uuid;
  v_ok boolean;
  v_set public.prod_control_settings%ROWTYPE;
  v_actual_loss_pct numeric;
  v_check_fat numeric;
  v_fat_in numeric;
  v_fat_out numeric;
  v_ctl jsonb;
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
  v_biz := public.prod_biz_date(v_date);
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_separations');

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

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_separations', v_id);

  PERFORM public.prod_lock_items_share(v_company_id, ARRAY[v_cream, v_skim]);

  -- Stock lock, then consume the milk lots (FEFO or picked).
  PERFORM public.prod_lock_stock(v_company_id, v_wh, ARRAY[v_milk]);
  v_res := public.prod_consume(v_company_id, v_wh, v_milk, v_milk_qty, 'separation', v_id,
                               p_data->'milk_lots', 'strict', v_ctl);

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

  -- Rule 2: loss and fat balance on the FINAL quantities.
  v_set := public.prod_ctl_settings(v_company_id);
  v_actual_loss_pct := round(v_loss / v_milk_qty * 100, 3);
  IF v_actual_loss_pct > v_set.separation_loss_max_pct THEN
    PERFORM public.prod_ctl_require(v_company_id, 'separation_loss', p_data, 'prod_separations', v_id,
      jsonb_build_object('loss_qty', v_loss, 'loss_pct', v_actual_loss_pct,
                         'max_pct', v_set.separation_loss_max_pct));
  END IF;
  v_check_fat := COALESCE((v_res->>'fat_pct')::numeric, v_milk_fat);
  v_fat_in := v_milk_qty * v_check_fat / 100;
  v_fat_out := v_cream_qty * v_cream_fat / 100 + v_skim_qty * v_skim_fat / 100;
  IF v_fat_out > v_fat_in * (1 + v_set.separation_fat_tolerance_pct / 100)
     OR v_fat_out < v_fat_in * (1 - v_set.separation_fat_tolerance_pct / 100 - v_loss / v_milk_qty) THEN
    PERFORM public.prod_ctl_require(v_company_id, 'separation_fat', p_data, 'prod_separations', v_id,
      jsonb_build_object('fat_in_kg', round(v_fat_in, 3), 'fat_out_kg', round(v_fat_out, 3),
                         'milk_fat', v_check_fat, 'tolerance_pct', v_set.separation_fat_tolerance_pct));
  END IF;

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
    note, status, created_by, created_by_name, lot_pick_deviation
  ) VALUES (
    v_id, v_company_id, v_number, v_date, v_wh, v_out_wh, v_milk, v_cream, v_skim,
    v_milk_qty, v_milk_fat, v_cream_fat, v_skim_fat, v_loss_pct, v_cream_calc, v_skim_calc, v_cream_qty, v_skim_qty, v_loss,
    v_method,
    CASE WHEN v_method = 'skim_price' THEN v_skim_price END,
    CASE WHEN v_method = 'value' THEN v_cream_ref END,
    CASE WHEN v_method = 'value' THEN v_skim_ref END,
    v_milk_cost, v_cream_cost, v_skim_cost,
    v_note, 'posted', auth.uid(), v_user_name, COALESCE((v_res->>'deviation')::boolean, false)
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

-- ═══ prod_create_transfer (replaced, same signature) ═════════════════════
-- Body copied from 20261110000014 (latest definition). Additions:
-- prod_assert_date; item rows FOR SHARE (destination lots are inflows)
-- before the stock keys; prod_consume 9-arg ('pick' mode: expired lots are
-- skipped by FEFO, a manual pick of one needs approval);
-- lot_pick_deviation.
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
  v_biz date;
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
  v_new_lot uuid;
  v_line_total numeric;
  v_total numeric := 0;
  v_ctl jsonb;
  v_deviation boolean := false;
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
  v_biz := public.prod_biz_date(v_doc_date);
  v_from_id := public.prod_juuid(p_data, 'from_warehouse_id');
  v_to_id := public.prod_juuid(p_data, 'to_warehouse_id');
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_transfers');

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

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_transfers', v_id);

  PERFORM public.prod_lock_items_share(v_company_id, v_item_ids);

  FOR v_rec IN
    SELECT it.item_id, wh.warehouse_id
    FROM unnest(v_item_ids) AS it(item_id)
    CROSS JOIN unnest(ARRAY[v_from_id, v_to_id]) AS wh(warehouse_id)
    ORDER BY it.item_id, wh.warehouse_id
  LOOP
    PERFORM public.prod_lock_stock(v_company_id, v_rec.warehouse_id, ARRAY[v_rec.item_id]);
  END LOOP;

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_from_id, v_item_ids[i], v_qtys[i],
                                 'transfer', v_id, v_picks[i], 'pick', v_ctl);
    v_line_total := (v_res->>'cost')::numeric;
    v_results := array_append(v_results, v_res);
    v_totals := v_totals || v_line_total;
    v_costs := v_costs || round(v_line_total / v_qtys[i], 2);
    v_total := v_total + v_line_total;
    v_deviation := v_deviation OR COALESCE((v_res->>'deviation')::boolean, false);
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
    status, created_by, created_by_name, lot_pick_deviation
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_from_id, v_to_id, v_note, v_total,
    'posted', auth.uid(), v_user_name, v_deviation
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_transfer_items (company_id, transfer_id, item_id, qty, unit_cost, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], v_totals[i]);

    FOR v_used IN SELECT * FROM jsonb_array_elements(v_results[i]->'lots')
    LOOP
      SELECT l.id, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id, l.expiry_date, l.received_at,
             l.hold_status, l.hold_reason, l.hold_at, l.hold_by
      INTO v_src
      FROM public.prod_lots l
      WHERE l.id = (v_used->>'lot_id')::uuid AND l.company_id = v_company_id;

      v_new_lot := public.prod_add_lot(
        v_company_id, v_to_id, v_item_ids[i], (v_used->>'qty')::numeric, v_src.unit_cost,
        v_src.fat_pct, v_src.protein_pct, v_src.supplier_id, 'transfer', v_id, v_src.id,
        v_src.expiry_date, v_src.received_at, NULL
      );
      IF v_src.hold_status <> 'free' THEN
        UPDATE public.prod_lots
        SET hold_status = v_src.hold_status, hold_reason = v_src.hold_reason,
            hold_at = v_src.hold_at, hold_by = v_src.hold_by
        WHERE id = v_new_lot AND company_id = v_company_id;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total);
END;
$$;

-- ═══ prod_create_writeoff (replaced, same signature) ═════════════════════
-- Body copied from 20261110000014 (latest definition). Additions:
-- prod_assert_date; prod_consume 9-arg in hold mode 'any' (expired lots
-- ARE taken here - this is where spoiled stock leaves; manual-pick role
-- rule applies); lot_pick_deviation.
CREATE OR REPLACE FUNCTION public.prod_create_writeoff(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_biz date;
  v_wh uuid;
  v_reason text;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_picks jsonb[] := '{}';
  v_costs numeric[] := '{}';
  v_totals numeric[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_res jsonb;
  v_line_cost numeric;
  v_total numeric := 0;
  v_ctl jsonb;
  v_deviation boolean := false;
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
  v_biz := public.prod_biz_date(v_doc_date);
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_reason := public.prod_jtext(p_data, 'reason', 20);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_writeoffs');

  IF v_reason IS NULL OR v_reason NOT IN ('spoiled', 'expired', 'damaged', 'lab_reject', 'sample', 'other') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);

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

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_writeoffs', v_id);

  PERFORM public.prod_lock_stock(v_company_id, v_wh, v_item_ids);

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_wh, v_item_ids[i], v_qtys[i],
                                 'writeoff', v_id, v_picks[i], 'any', v_ctl);
    v_line_cost := (v_res->>'cost')::numeric;
    v_totals := v_totals || v_line_cost;
    v_costs := v_costs || round(v_line_cost / v_qtys[i], 2);
    v_total := v_total + v_line_cost;
    v_deviation := v_deviation OR COALESCE((v_res->>'deviation')::boolean, false);
    IF v_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_writeoff_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_writeoffs WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_writeoffs (
    id, company_id, number, doc_date, warehouse_id, reason, note, total_cost,
    status, created_by, created_by_name, lot_pick_deviation
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_wh, v_reason, v_note, v_total,
    'posted', auth.uid(), v_user_name, v_deviation
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_writeoff_items (company_id, writeoff_id, item_id, qty, unit_cost, total)
    VALUES (v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], v_totals[i]);
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total_cost', v_total);
END;
$$;

-- ═══ prod_post_stock_count (replaced: + defaulted trailing p_ctl) ════════
-- WARNING: DROP FUNCTION prod_post_stock_count(uuid) + CREATE with a new
-- trailing parameter p_ctl jsonb DEFAULT NULL ({ override, override_note }).
-- An overload next to the old one would make 1-argument calls ambiguous.
-- No data is touched; PostgREST calls { p_id } keep working (the default
-- fills p_ctl). Body copied from 20261110000014 (latest definition).
-- Additions: prod_assert_date on the count business date ('create',
-- override from p_ctl); item rows FOR SHARE (surplus lots are inflows)
-- before the stock keys; shortages via prod_consume 9-arg, hold mode
-- 'any' (expired lots are taken: a count is physical reality).
DROP FUNCTION public.prod_post_stock_count(uuid);

CREATE FUNCTION public.prod_post_stock_count(p_id uuid, p_ctl jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc record;
  v_item_ids uuid[];
  v_line record;
  v_stock record;
  v_q record;
  v_diff numeric;
  v_res jsonb;
  v_cost numeric;
  v_unit numeric;
  v_dv numeric;
  v_short numeric := 0;
  v_surplus numeric := 0;
  v_biz date;
  v_ctl jsonb;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_stock') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_id IS NULL OR (p_ctl IS NOT NULL AND jsonb_typeof(p_ctl) NOT IN ('object', 'null')) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, number, status, warehouse_id, doc_date INTO v_doc
  FROM public.prod_stock_counts
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_doc.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF v_doc.status <> 'draft' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_biz := public.prod_biz_date(v_doc.doc_date);
  v_ctl := public.prod_ctl_ctx(p_ctl, v_biz, 'prod_stock_counts');
  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', v_ctl, 'prod_stock_counts', p_id);

  PERFORM public.prod_require_warehouse(v_company_id, v_doc.warehouse_id);

  SELECT array_agg(item_id ORDER BY item_id) INTO v_item_ids
  FROM public.prod_stock_count_items
  WHERE count_id = p_id AND company_id = v_company_id;
  IF v_item_ids IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_lock_items_share(v_company_id, v_item_ids);
  PERFORM public.prod_lock_stock(v_company_id, v_doc.warehouse_id, v_item_ids);

  -- Pass 1: snapshot every line, post shortages.
  FOR v_line IN
    SELECT id, item_id, counted_qty, unit_cost
    FROM public.prod_stock_count_items
    WHERE count_id = p_id AND company_id = v_company_id
    ORDER BY item_id
  LOOP
    SELECT * INTO v_stock FROM public.prod_current_stock(v_company_id, v_doc.warehouse_id, v_line.item_id);
    v_diff := v_line.counted_qty - v_stock.qty;

    IF v_diff < 0 THEN
      v_res := public.prod_consume(v_company_id, v_doc.warehouse_id, v_line.item_id, -v_diff,
                                   'stock_count', p_id, NULL, 'any', v_ctl);
      v_cost := (v_res->>'cost')::numeric;
      v_unit := round(v_cost / -v_diff, 2);
      v_dv := -v_cost;
      v_short := v_short + v_cost;
    ELSE
      v_unit := COALESCE(v_line.unit_cost, CASE WHEN v_stock.qty > 0 THEN v_stock.avg_cost ELSE 0 END);
      v_dv := round(v_diff * v_unit, 2);
      v_surplus := v_surplus + v_dv;
    END IF;

    IF v_short >= 1e12 OR v_surplus >= 1e12 OR abs(v_dv) >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    UPDATE public.prod_stock_count_items
    SET system_qty = v_stock.qty,
        diff_qty = v_diff,
        unit_cost = v_unit,
        diff_value = v_dv
    WHERE id = v_line.id AND company_id = v_company_id;
  END LOOP;

  -- Pass 2: surplus lots (takes 'prod_lot_no', always last).
  FOR v_line IN
    SELECT id, item_id, diff_qty, unit_cost
    FROM public.prod_stock_count_items
    WHERE count_id = p_id AND company_id = v_company_id AND diff_qty > 0
    ORDER BY item_id
  LOOP
    SELECT * INTO v_q FROM public.prod_stock_quality_at(v_company_id, v_doc.warehouse_id, v_line.item_id);
    PERFORM public.prod_add_lot(
      v_company_id, v_doc.warehouse_id, v_line.item_id, v_line.diff_qty, v_line.unit_cost,
      v_q.avg_fat, v_q.avg_protein, NULL, 'stock_count', p_id, NULL,
      public.prod_lot_expiry(v_company_id, v_line.item_id, v_doc.doc_date),
      v_doc.doc_date, NULL
    );
  END LOOP;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  UPDATE public.prod_stock_counts
  SET status = 'posted',
      shortage_value = v_short,
      surplus_value = v_surplus,
      posted_at = now(),
      posted_by = auth.uid(),
      posted_by_name = v_user_name,
      updated_at = now()
  WHERE id = p_id AND company_id = v_company_id;

  RETURN jsonb_build_object(
    'id', p_id, 'number', v_doc.number, 'shortage_value', v_short, 'surplus_value', v_surplus
  );
END;
$$;

-- ═══ prod_create_opening (replaced, same signature) ══════════════════════
-- Body copied from 20261110000014 (latest definition). Additions: id
-- generated first; prod_assert_date; item rows FOR SHARE before the number
-- lock.
CREATE OR REPLACE FUNCTION public.prod_create_opening(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_wh uuid;
  v_note text;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_costs numeric[] := '{}';
  v_fats numeric[] := '{}';
  v_pros numeric[] := '{}';
  v_exps date[] := '{}';
  v_sups uuid[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_cost numeric;
  v_fat numeric;
  v_pro numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_lot uuid;
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
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_id := gen_random_uuid();

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);

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
    v_cost := public.prod_jnum(v_line, 'unit_cost', 2);
    v_fat := public.prod_jnum(v_line, 'fat_pct', 3);
    v_pro := public.prod_jnum(v_line, 'protein_pct', 3);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR v_cost IS NULL OR v_cost < 0
       OR (v_fat IS NOT NULL AND v_fat NOT BETWEEN 0 AND 100)
       OR (v_pro IS NOT NULL AND v_pro NOT BETWEEN 0 AND 100) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_line_total := round(v_qty * v_cost, 2);
    v_total := v_total + v_line_total;
    IF v_line_total >= 1e12 OR v_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_costs := v_costs || v_cost;
    v_fats := array_append(v_fats, v_fat);
    v_pros := array_append(v_pros, v_pro);
    v_exps := array_append(v_exps, public.prod_jdate(v_line, 'expiry_date'));
    v_sups := array_append(v_sups, public.prod_juuid(v_line, 'supplier_id'));
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id IN (SELECT DISTINCT unnest(v_item_ids)))
     <> (SELECT count(DISTINCT x) FROM unnest(v_item_ids) AS t(x)) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF (SELECT count(*) FROM public.prod_suppliers
      WHERE company_id = v_company_id AND id IN (SELECT DISTINCT x FROM unnest(v_sups) AS t(x) WHERE x IS NOT NULL))
     <> (SELECT count(DISTINCT x) FROM unnest(v_sups) AS t(x) WHERE x IS NOT NULL) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_doc_date), 'create',
                                  p_data, 'prod_openings', v_id);

  PERFORM public.prod_lock_items_share(v_company_id, v_item_ids);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_opening_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_openings WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_openings (
    id, company_id, number, doc_date, warehouse_id, note, total, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_wh, v_note, v_total, 'posted', auth.uid(), v_user_name
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_lot := public.prod_add_lot(
      v_company_id, v_wh, v_item_ids[i], v_qtys[i], v_costs[i],
      v_fats[i], v_pros[i], v_sups[i], 'opening_balance', v_id, NULL,
      COALESCE(v_exps[i], public.prod_lot_expiry(v_company_id, v_item_ids[i], v_doc_date)),
      v_doc_date, NULL
    );
    INSERT INTO public.prod_opening_items (
      company_id, opening_id, item_id, lot_id, sort_order, qty, unit_cost, total,
      fat_pct, protein_pct, expiry_date, supplier_id
    ) VALUES (
      v_company_id, v_id, v_item_ids[i], v_lot, i - 1, v_qtys[i], v_costs[i], round(v_qtys[i] * v_costs[i], 2),
      v_fats[i], v_pros[i], (SELECT expiry_date FROM public.prod_lots WHERE id = v_lot), v_sups[i]
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'number', v_number, 'total', v_total);
END;
$$;

-- ═══ prod_create_price_correction (replaced, same signature) ═════════════
-- Body copied from 20261110000014 (latest definition). Additions: id
-- generated first; prod_assert_date on the correction business date; the
-- line item row FOR SHARE (revaluation lots are inflows) between the
-- receipt row lock and the stock key.
CREATE OR REPLACE FUNCTION public.prod_create_price_correction(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_receipt_id uuid;
  v_line_id uuid;
  v_item_id uuid;
  v_new numeric;
  v_old numeric;
  v_note text;
  v_doc_date timestamptz;
  v_r record;
  v_li record;
  v_n integer;
  v_lot record;
  v_new_lot uuid;
  v_delta numeric;
  v_stock_qty numeric := 0;
  v_stock_delta numeric := 0;
  v_consumed numeric;
  v_variance numeric;
  v_lots jsonb := '[]'::jsonb;
  v_id uuid;
  v_number integer;
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

  v_receipt_id := public.prod_juuid(p_data, 'receipt_id');
  v_line_id := public.prod_juuid(p_data, 'receipt_item_id');
  v_item_id := public.prod_juuid(p_data, 'item_id');
  v_new := public.prod_jnum(p_data, 'new_price', 2);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_doc_date := COALESCE(public.prod_jts(p_data, 'doc_date'), now());
  v_id := gen_random_uuid();

  IF v_receipt_id IS NULL OR (v_line_id IS NULL AND v_item_id IS NULL)
     OR v_new IS NULL OR v_new < 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, status, warehouse_id, supplier_id INTO v_r
  FROM public.prod_receipts
  WHERE id = v_receipt_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_r.status <> 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT count(*) INTO v_n
  FROM public.prod_receipt_items ri
  WHERE ri.receipt_id = v_r.id AND ri.company_id = v_company_id
    AND (v_line_id IS NULL OR ri.id = v_line_id)
    AND (v_item_id IS NULL OR ri.item_id = v_item_id);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT ri.id, ri.item_id, ri.qty, ri.price INTO v_li
  FROM public.prod_receipt_items ri
  WHERE ri.receipt_id = v_r.id AND ri.company_id = v_company_id
    AND (v_line_id IS NULL OR ri.id = v_line_id)
    AND (v_item_id IS NULL OR ri.item_id = v_item_id);

  -- Effective price = latest posted correction of the line, else the line.
  v_old := COALESCE((
    SELECT c.new_price FROM public.prod_price_corrections c
    WHERE c.company_id = v_company_id AND c.receipt_item_id = v_li.id AND c.status = 'posted'
    ORDER BY c.number DESC
    LIMIT 1
  ), v_li.price);
  IF v_new = v_old THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_delta := round((v_new - v_old) * v_li.qty, 2);
  IF abs(v_delta) >= 1e12 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_doc_date), 'create',
                                  p_data, 'prod_price_corrections', v_id);

  PERFORM public.prod_lock_items_share(v_company_id, ARRAY[v_li.item_id]);
  PERFORM public.prod_lock_stock(v_company_id, v_r.warehouse_id, ARRAY[v_li.item_id]);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_price_correction_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_price_corrections WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_price_corrections (
    id, company_id, number, doc_date, receipt_id, receipt_item_id, item_id, warehouse_id, supplier_id,
    qty, old_price, new_price, debt_delta, note, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_r.id, v_li.id, v_li.item_id, v_r.warehouse_id, v_r.supplier_id,
    v_li.qty, v_old, v_new, v_delta, v_note, 'posted', auth.uid(), v_user_name
  );

  -- Revalue every lot of the line still holding stock in the receipt
  -- warehouse (the receipt lot + lots of earlier posted corrections).
  FOR v_lot IN
    SELECT x.*
    FROM (
      SELECT l.id, l.lot_no, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id, l.expiry_date,
             l.received_at, l.hold_status, l.hold_reason, l.hold_at, l.hold_by,
             l.opening_qty + COALESCE((
               SELECT sum(m.qty) FROM public.prod_stock_movements m
               WHERE m.lot_id = l.id AND m.company_id = l.company_id
             ), 0) AS remaining
      FROM public.prod_lots l
      WHERE l.company_id = v_company_id
        AND l.warehouse_id = v_r.warehouse_id
        AND l.item_id = v_li.item_id
        AND (
          (l.source_doc_type = 'receipt' AND l.source_doc_id = v_r.id)
          OR (l.source_doc_type = 'price_correction' AND l.source_doc_id IN (
                SELECT c.id FROM public.prod_price_corrections c
                WHERE c.company_id = v_company_id AND c.receipt_item_id = v_li.id
                  AND c.status = 'posted' AND c.id <> v_id))
        )
    ) x
    WHERE x.remaining > 0
    ORDER BY length(x.lot_no), x.lot_no
  LOOP
    INSERT INTO public.prod_stock_movements (
      company_id, warehouse_id, item_id, qty, unit_cost, doc_type, doc_id, is_reversal, created_by,
      fat_pct, protein_pct, lot_id
    ) VALUES (
      v_company_id, v_r.warehouse_id, v_li.item_id, -v_lot.remaining, v_lot.unit_cost, 'price_correction', v_id,
      false, auth.uid(), v_lot.fat_pct, v_lot.protein_pct, v_lot.id
    );

    v_new_lot := public.prod_add_lot(
      v_company_id, v_r.warehouse_id, v_li.item_id, v_lot.remaining, v_new,
      v_lot.fat_pct, v_lot.protein_pct, v_lot.supplier_id, 'price_correction', v_id, v_lot.id,
      v_lot.expiry_date, v_lot.received_at, NULL
    );
    UPDATE public.prod_lots
    SET hold_status = v_lot.hold_status, hold_reason = v_lot.hold_reason,
        hold_at = v_lot.hold_at, hold_by = v_lot.hold_by
    WHERE id = v_new_lot AND company_id = v_company_id;

    v_stock_qty := v_stock_qty + v_lot.remaining;
    v_stock_delta := v_stock_delta + round(v_lot.remaining * v_new, 2) - round(v_lot.remaining * v_lot.unit_cost, 2);
    v_lots := v_lots || jsonb_build_array(jsonb_build_object(
      'old_lot_id', v_lot.id, 'new_lot_id', v_new_lot, 'qty', v_lot.remaining, 'old_unit_cost', v_lot.unit_cost
    ));
  END LOOP;

  v_consumed := GREATEST(v_li.qty - v_stock_qty, 0);
  v_variance := round((v_new - v_old) * v_consumed, 2);

  UPDATE public.prod_price_corrections
  SET stock_qty = v_stock_qty,
      stock_delta = v_stock_delta,
      consumed_qty = v_consumed,
      consumed_variance = v_variance,
      lots = v_lots
  WHERE id = v_id AND company_id = v_company_id;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'old_price', v_old, 'new_price', v_new,
    'debt_delta', v_delta, 'stock_qty', v_stock_qty, 'consumed_qty', v_consumed,
    'consumed_variance', v_variance, 'stock_delta', v_stock_delta
  );
END;
$$;

-- ═══ prod_create_sale (replaced, same signature) ═════════════════════════
-- Body copied from 20261110000015 (latest definition). Additions: id
-- generated first; prod_assert_date; prod_consume 9-arg ('strict': expired
-- lots skipped by FEFO, manual pick of one -> 'expired_lot', manual-pick
-- role rule); lot_pick_deviation stored. Return shape unchanged.
CREATE OR REPLACE FUNCTION public.prod_create_sale(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_biz date;
  v_customer_id uuid;
  v_cust record;
  v_wh uuid;
  v_sale_list uuid;
  v_cust_list uuid;
  v_def_list uuid;
  v_list_active boolean;
  v_vat_rate numeric;
  v_vehicle text;
  v_driver text;
  v_note text;
  v_enforce boolean;
  v_line jsonb;
  v_item_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_prices numeric[] := '{}';
  v_discs numeric[] := '{}';
  v_sources text[] := '{}';
  v_amounts numeric[] := '{}';
  v_vats numeric[] := '{}';
  v_picks jsonb[] := '{}';
  v_costs numeric[] := '{}';
  v_lots jsonb[] := '{}';
  v_item_id uuid;
  v_qty numeric;
  v_price numeric;
  v_disc numeric;
  v_source text;
  v_amount numeric;
  v_vat numeric;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_total numeric;
  v_cost_total numeric := 0;
  v_res jsonb;
  v_balance numeric;
  v_warning jsonb;
  v_due date;
  v_ctl jsonb;
  v_deviation boolean := false;
  v_id uuid;
  v_number integer;
  i integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
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
  v_biz := public.prod_biz_date(v_doc_date);
  v_customer_id := public.prod_juuid(p_data, 'customer_id');
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_sale_list := public.prod_juuid(p_data, 'price_list_id');
  v_vat_rate := COALESCE(public.prod_jnum(p_data, 'vat_rate', 2), 0);
  v_vehicle := public.prod_jtext(p_data, 'vehicle_no', 30);
  v_driver := public.prod_jtext(p_data, 'driver', 100);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_enforce := COALESCE(public.prod_jbool(p_data, 'enforce_credit_limit'), false);
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_sales');

  IF v_customer_id IS NULL OR v_wh IS NULL OR v_vat_rate NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_sales', v_id);

  -- Customer row lock first (see header "Credit limit" / lock order).
  SELECT c.name, c.is_active, c.price_list_id, c.credit_limit, c.payment_terms_days INTO v_cust
  FROM public.prod_customers c
  WHERE c.id = v_customer_id AND c.company_id = v_company_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT v_cust.is_active THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_wh);

  -- Price lists of the resolution chain (inactive lists are skipped).
  IF v_sale_list IS NOT NULL THEN
    SELECT is_active INTO v_list_active
    FROM public.prod_price_lists WHERE id = v_sale_list AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_list_active THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END IF;
  SELECT id INTO v_cust_list
  FROM public.prod_price_lists
  WHERE id = v_cust.price_list_id AND company_id = v_company_id AND is_active;
  SELECT id INTO v_def_list
  FROM public.prod_price_lists
  WHERE company_id = v_company_id AND is_default AND is_active;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_item_id := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    v_price := public.prod_jnum(v_line, 'price', 2);
    v_disc := COALESCE(public.prod_jnum(v_line, 'discount_pct', 2), 0);
    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0
       OR (v_price IS NOT NULL AND v_price < 0)
       OR v_disc NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_prices := array_append(v_prices, v_price);
    v_discs := v_discs || v_disc;
    v_picks := array_append(v_picks, v_line->'lots');
  END LOOP;

  IF (SELECT count(*) FROM public.prod_items
      WHERE company_id = v_company_id AND id IN (SELECT DISTINCT unnest(v_item_ids)))
     <> (SELECT count(DISTINCT x) FROM unnest(v_item_ids) AS t(x)) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Prices + amounts (server-side; see 15 header "Pricing").
  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_price := v_prices[i];
    v_source := 'manual';
    IF v_price IS NULL AND v_sale_list IS NOT NULL THEN
      SELECT price INTO v_price FROM public.prod_price_list_items
      WHERE price_list_id = v_sale_list AND company_id = v_company_id AND item_id = v_item_ids[i];
      v_source := 'sale_list';
    END IF;
    IF v_price IS NULL AND v_cust_list IS NOT NULL THEN
      SELECT price INTO v_price FROM public.prod_price_list_items
      WHERE price_list_id = v_cust_list AND company_id = v_company_id AND item_id = v_item_ids[i];
      v_source := 'customer_list';
    END IF;
    IF v_price IS NULL AND v_def_list IS NOT NULL THEN
      SELECT price INTO v_price FROM public.prod_price_list_items
      WHERE price_list_id = v_def_list AND company_id = v_company_id AND item_id = v_item_ids[i];
      v_source := 'default_list';
    END IF;
    IF v_price IS NULL THEN
      SELECT sale_price INTO v_price FROM public.prod_items
      WHERE id = v_item_ids[i] AND company_id = v_company_id;
      v_source := 'item';
    END IF;
    IF v_price IS NULL THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'no_price';
    END IF;

    v_amount := round(v_qtys[i] * v_price * (1 - v_discs[i] / 100), 2);
    v_vat := round(v_amount * v_vat_rate / 100, 2);
    v_subtotal := v_subtotal + v_amount;
    v_vat_total := v_vat_total + v_vat;
    IF v_amount + v_vat >= 1e12 OR v_subtotal + v_vat_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_prices[i] := v_price;
    v_sources := v_sources || v_source;
    v_amounts := v_amounts || v_amount;
    v_vats := v_vats || v_vat;
  END LOOP;
  v_total := v_subtotal + v_vat_total;

  -- Credit limit (under the customer row lock).
  v_balance := public.prod_customer_balance(v_company_id, v_customer_id);
  IF v_cust.credit_limit IS NOT NULL AND v_balance + v_total > v_cust.credit_limit THEN
    IF v_enforce THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'credit_limit';
    END IF;
    v_warning := jsonb_build_object('limit', v_cust.credit_limit, 'balance_before', v_balance,
                                    'balance_after', v_balance + v_total);
  END IF;

  IF v_cust.payment_terms_days IS NOT NULL THEN
    v_due := (v_doc_date AT TIME ZONE 'Asia/Tashkent')::date + v_cust.payment_terms_days;
  END IF;

  -- Stock: all keys first (one warehouse, ascending item id), then consume.
  PERFORM public.prod_lock_stock(v_company_id, v_wh, v_item_ids);

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    v_res := public.prod_consume(v_company_id, v_wh, v_item_ids[i], v_qtys[i],
                                 'sale', v_id, v_picks[i], 'strict', v_ctl);
    v_costs := v_costs || (v_res->>'cost')::numeric;
    v_lots := array_append(v_lots, v_res->'lots');
    v_cost_total := v_cost_total + (v_res->>'cost')::numeric;
    v_deviation := v_deviation OR COALESCE((v_res->>'deviation')::boolean, false);
    IF v_cost_total >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_sale_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_sales WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_sales (
    id, company_id, number, doc_date, customer_id, customer_name, warehouse_id, price_list_id,
    due_date, vat_rate, subtotal, vat_amount, total, cost_total, margin,
    vehicle_no, driver, note, status, created_by, created_by_name, lot_pick_deviation
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_customer_id, v_cust.name, v_wh,
    COALESCE(v_sale_list, v_cust_list, v_def_list),
    v_due, v_vat_rate, v_subtotal, v_vat_total, v_total, v_cost_total, v_subtotal - v_cost_total,
    v_vehicle, v_driver, v_note, 'posted', auth.uid(), v_user_name, v_deviation
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_sale_items (
      company_id, sale_id, sort_order, item_id, unit, qty, price, discount_pct, price_source,
      amount, vat_amount, total, cost, unit_cost, lots
    ) VALUES (
      v_company_id, v_id, i - 1, v_item_ids[i],
      (SELECT it.unit FROM public.prod_items it WHERE it.id = v_item_ids[i] AND it.company_id = v_company_id),
      v_qtys[i], v_prices[i], v_discs[i], v_sources[i],
      v_amounts[i], v_vats[i], v_amounts[i] + v_vats[i], v_costs[i], round(v_costs[i] / v_qtys[i], 2),
      COALESCE(v_lots[i], '[]'::jsonb)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number,
    'subtotal', v_subtotal, 'vat_amount', v_vat_total, 'total', v_total,
    'cost_total', v_cost_total, 'margin', v_subtotal - v_cost_total,
    'due_date', v_due,
    'credit_warning', v_warning
  );
END;
$$;

-- ═══ prod_create_sale_return (replaced, same signature) ══════════════════
-- Body copied from 20261110000015 (latest definition). Additions: id
-- generated first; prod_assert_date on the return business date; the item
-- rows of restocked lines FOR SHARE before the number lock (rule 13).
CREATE OR REPLACE FUNCTION public.prod_create_sale_return(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_user_name text;
  v_doc_date timestamptz;
  v_sale_id uuid;
  v_sale record;
  v_wh uuid;
  v_reason text;
  v_note text;
  v_line jsonb;
  v_si_ids uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_restocks boolean[] := '{}';
  v_any_restock boolean := false;
  v_si_id uuid;
  v_qty numeric;
  v_restock boolean;
  v_si record;
  v_done record;
  v_avail numeric;
  v_amount numeric;
  v_vat numeric;
  v_lot_ids uuid[];
  v_lot_av numeric[];
  v_lot_cost numeric[];
  v_take numeric[];
  v_sum_av numeric;
  v_left numeric;
  v_add numeric;
  v_pass integer;
  v_e record;
  v_line_cost numeric;
  v_line_lots jsonb;
  v_items_out jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_cost_total numeric := 0;
  v_loss numeric := 0;
  v_src record;
  v_new_lot uuid;
  v_out jsonb;
  v_lots_out jsonb;
  v_restock_items uuid[] := '{}';
  v_id uuid;
  v_number integer;
  i integer;
  k integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
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
  v_sale_id := public.prod_juuid(p_data, 'sale_id');
  v_wh := public.prod_juuid(p_data, 'warehouse_id');
  v_reason := public.prod_jtext(p_data, 'reason', 200);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_id := gen_random_uuid();

  IF v_sale_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_typeof(p_data->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_data->'items') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'items')
  LOOP
    v_si_id := public.prod_juuid(v_line, 'sale_item_id');
    v_qty := public.prod_jnum(v_line, 'qty', 3);
    v_restock := COALESCE(public.prod_jbool(v_line, 'restock'), true);
    IF v_si_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_si_id = ANY (v_si_ids) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_si_ids := v_si_ids || v_si_id;
    v_qtys := v_qtys || v_qty;
    v_restocks := v_restocks || v_restock;
    v_any_restock := v_any_restock OR v_restock;
  END LOOP;

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_doc_date), 'create',
                                  p_data, 'prod_sale_returns', v_id);

  -- Sale row lock: serialises returns of this sale and its cancellation.
  SELECT s.id, s.status, s.customer_id, s.warehouse_id, s.vat_rate INTO v_sale
  FROM public.prod_sales s
  WHERE s.id = v_sale_id AND s.company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_sale.status <> 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  v_wh := COALESCE(v_wh, v_sale.warehouse_id);
  IF v_any_restock THEN
    PERFORM public.prod_require_warehouse(v_company_id, v_wh);
  ELSIF NOT EXISTS (SELECT 1 FROM public.prod_warehouses WHERE id = v_wh AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF (SELECT count(*) FROM public.prod_sale_items
      WHERE company_id = v_company_id AND sale_id = v_sale_id AND id = ANY (v_si_ids)) <> cardinality(v_si_ids) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Plan every line (amounts, lot split) before writing anything.
  FOR i IN 1 .. cardinality(v_si_ids)
  LOOP
    SELECT si.id, si.item_id, si.unit, si.qty, si.price, si.discount_pct, si.amount, si.vat_amount, si.lots,
           it.unit AS cur_unit
    INTO v_si
    FROM public.prod_sale_items si
    JOIN public.prod_items it ON it.id = si.item_id AND it.company_id = si.company_id
    WHERE si.id = v_si_ids[i] AND si.company_id = v_company_id;

    SELECT COALESCE(sum(ri.qty), 0) AS qty, COALESCE(sum(ri.amount), 0) AS amount,
           COALESCE(sum(ri.vat_amount), 0) AS vat
    INTO v_done
    FROM public.prod_sale_return_items ri
    JOIN public.prod_sale_returns r ON r.id = ri.return_id AND r.company_id = ri.company_id
    WHERE ri.company_id = v_company_id AND ri.sale_item_id = v_si.id AND r.status = 'posted';

    v_avail := v_si.qty - v_done.qty;
    IF v_qtys[i] > v_avail THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
    END IF;

    IF v_restocks[i] AND v_si.cur_unit <> v_si.unit THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'unit_changed';
    END IF;
    IF v_restocks[i] THEN
      v_restock_items := v_restock_items || v_si.item_id;
    END IF;

    -- Credit (capped by the uncredited rest; exact rest on completion).
    IF v_qtys[i] = v_avail THEN
      v_amount := v_si.amount - v_done.amount;
      v_vat := v_si.vat_amount - v_done.vat;
    ELSE
      v_amount := LEAST(round(v_qtys[i] * v_si.price * (1 - v_si.discount_pct / 100), 2), v_si.amount - v_done.amount);
      v_vat := LEAST(round(v_amount * v_sale.vat_rate / 100, 2), v_si.vat_amount - v_done.vat);
    END IF;
    v_amount := GREATEST(v_amount, 0);
    v_vat := GREATEST(v_vat, 0);

    -- Lot split: avail per original lot of this line.
    v_lot_ids := '{}';
    v_lot_av := '{}';
    v_lot_cost := '{}';
    v_sum_av := 0;
    FOR v_e IN
      SELECT (e.value->>'lot_id')::uuid AS lot_id,
             sum((e.value->>'qty')::numeric) AS qty,
             max((e.value->>'unit_cost')::numeric) AS unit_cost,
             min(e.ord) AS ord
      FROM jsonb_array_elements(v_si.lots) WITH ORDINALITY AS e(value, ord)
      GROUP BY 1
      ORDER BY min(e.ord)
    LOOP
      v_avail := v_e.qty - COALESCE((
        SELECT sum((x.value->>'qty')::numeric)
        FROM public.prod_sale_return_items ri
        JOIN public.prod_sale_returns r ON r.id = ri.return_id AND r.company_id = ri.company_id
        CROSS JOIN LATERAL jsonb_array_elements(ri.lots) AS x(value)
        WHERE ri.company_id = v_company_id AND ri.sale_item_id = v_si.id AND r.status = 'posted'
          AND (x.value->>'origin_lot_id')::uuid = v_e.lot_id
      ), 0);
      IF v_avail > 0 THEN
        v_lot_ids := v_lot_ids || v_e.lot_id;
        v_lot_av := v_lot_av || v_avail;
        v_lot_cost := v_lot_cost || v_e.unit_cost;
        v_sum_av := v_sum_av + v_avail;
      END IF;
    END LOOP;
    IF v_sum_av < v_qtys[i] THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
    END IF;

    v_take := '{}';
    v_left := v_qtys[i];
    FOR k IN 1 .. cardinality(v_lot_ids)
    LOOP
      v_take := v_take || trunc(v_qtys[i] * v_lot_av[k] / v_sum_av, 3);
      v_left := v_left - v_take[k];
    END LOOP;
    -- remainder (< 0.001 per lot): 0.001 at a time, lots in order, round robin
    v_pass := 0;
    WHILE v_left > 0 LOOP
      v_pass := v_pass + 1;
      IF v_pass > 1000 THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
      END IF;
      FOR k IN 1 .. cardinality(v_lot_ids)
      LOOP
        EXIT WHEN v_left <= 0;
        v_add := LEAST(v_left, 0.001, v_lot_av[k] - v_take[k]);
        v_take[k] := v_take[k] + v_add;
        v_left := v_left - v_add;
      END LOOP;
    END LOOP;
    IF v_left <> 0 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'over_return';
    END IF;

    v_line_cost := 0;
    v_line_lots := '[]'::jsonb;
    FOR k IN 1 .. cardinality(v_lot_ids)
    LOOP
      CONTINUE WHEN v_take[k] <= 0;
      v_line_cost := v_line_cost + round(v_take[k] * v_lot_cost[k], 2);
      v_line_lots := v_line_lots || jsonb_build_array(jsonb_build_object(
        'origin_lot_id', v_lot_ids[k], 'qty', v_take[k], 'unit_cost', v_lot_cost[k]
      ));
    END LOOP;

    v_subtotal := v_subtotal + v_amount;
    v_vat_total := v_vat_total + v_vat;
    v_cost_total := v_cost_total + v_line_cost;
    IF NOT v_restocks[i] THEN
      v_loss := v_loss + v_line_cost;
    END IF;

    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_si.id, 'item_id', v_si.item_id, 'qty', v_qtys[i], 'restock', v_restocks[i],
      'price', v_si.price, 'discount_pct', v_si.discount_pct,
      'amount', v_amount, 'vat_amount', v_vat, 'cost', v_line_cost, 'lots', v_line_lots
    ));
  END LOOP;

  PERFORM public.prod_lock_items_share(v_company_id, v_restock_items);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_sale_return_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_sale_returns WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_sale_returns (
    id, company_id, number, doc_date, sale_id, customer_id, warehouse_id, reason, note,
    subtotal, vat_amount, total, cost_total, loss_cost, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_sale_id, v_sale.customer_id, v_wh, v_reason, v_note,
    v_subtotal, v_vat_total, v_subtotal + v_vat_total, v_cost_total, v_loss, 'posted', auth.uid(), v_user_name
  );

  -- Lines + restock lots ('prod_lot_no' is the last lock).
  i := 0;
  FOR v_out IN SELECT * FROM jsonb_array_elements(v_items_out)
  LOOP
    v_lots_out := '[]'::jsonb;
    FOR v_e IN SELECT * FROM jsonb_array_elements(v_out->'lots') AS x(value)
    LOOP
      v_new_lot := NULL;
      IF (v_out->>'restock')::boolean THEN
        SELECT l.id, l.unit_cost, l.fat_pct, l.protein_pct, l.supplier_id, l.expiry_date, l.received_at
        INTO v_src
        FROM public.prod_lots l
        WHERE l.id = (v_e.value->>'origin_lot_id')::uuid AND l.company_id = v_company_id;
        v_new_lot := public.prod_add_lot(
          v_company_id, v_wh, (v_out->>'item_id')::uuid, (v_e.value->>'qty')::numeric, v_src.unit_cost,
          v_src.fat_pct, v_src.protein_pct, v_src.supplier_id, 'sale_return', v_id, v_src.id,
          v_src.expiry_date, v_src.received_at, NULL
        );
      END IF;
      v_lots_out := v_lots_out || jsonb_build_array(v_e.value || jsonb_build_object('lot_id', v_new_lot));
    END LOOP;

    INSERT INTO public.prod_sale_return_items (
      company_id, return_id, sale_item_id, item_id, sort_order, qty, restock, price, discount_pct,
      amount, vat_amount, total, cost, lots
    ) VALUES (
      v_company_id, v_id, (v_out->>'sale_item_id')::uuid, (v_out->>'item_id')::uuid, i,
      (v_out->>'qty')::numeric, (v_out->>'restock')::boolean, (v_out->>'price')::numeric,
      (v_out->>'discount_pct')::numeric, (v_out->>'amount')::numeric, (v_out->>'vat_amount')::numeric,
      (v_out->>'amount')::numeric + (v_out->>'vat_amount')::numeric, (v_out->>'cost')::numeric, v_lots_out
    );
    i := i + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number,
    'subtotal', v_subtotal, 'vat_amount', v_vat_total, 'total', v_subtotal + v_vat_total,
    'cost_total', v_cost_total, 'loss_cost', v_loss
  );
END;
$$;

-- ═══ prod_create_customer_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000016 (latest definition). Additions: id
-- generated first; prod_assert_date on pay_date.
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
  v_id := gen_random_uuid();

  IF v_customer_id IS NULL
     OR v_amount IS NULL OR v_amount <= 0
     OR v_method NOT IN ('cash', 'card', 'transfer') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, v_pay_date, 'create', p_data, 'prod_customer_payments', v_id);

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
    id, company_id, number, customer_id, amount, method, pay_date, note,
    status, created_by, created_by_name, account_id
  ) VALUES (
    v_id, v_company_id, v_number, v_customer_id, v_amount, v_method, v_pay_date, v_note,
    'posted', auth.uid(), v_user_name, v_account_id
  );

  PERFORM public.prod_cash_post(
    v_company_id, v_account_id, v_amount, public.prod_cash_date_ts(v_pay_date),
    'customer_payment', v_id, 'customer', v_customer_id, v_customer_name, NULL, v_note, false
  );

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_cancel_customer_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000016 (latest definition). Addition after the
-- row lock: prod_ctl_cancel (period lock on pay_date, self-cancel, audit).
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
  v_date date;
  v_created_by uuid;
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

  SELECT status, pay_date, created_by INTO v_status, v_date, v_created_by
  FROM public.prod_customer_payments
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  PERFORM public.prod_ctl_cancel(v_company_id, 'prod_customer_payments', p_id, v_date,
                                 ARRAY[v_created_by], 'customer_payment');

  PERFORM public.prod_cash_reverse(v_company_id, 'customer_payment', p_id);

  UPDATE public.prod_customer_payments
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_create_supplier_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000016 (latest definition). Additions: id
-- generated first; prod_assert_date on pay_date; rule 8
-- 'payment_over_debt': amount > current debt (prod_supplier_balances.debt,
-- posted receipts + posted price corrections - posted payments; <= 0 debt
-- = nothing owed) needs approval unless settings.payment_over_debt_allowed.
-- The supplier row is now taken FOR NO KEY UPDATE (was FOR SHARE) so two
-- payments of one supplier serialise their debt check (receipts, FOR
-- SHARE, wait for it; they only raise the debt). Akt-sverka is unchanged.
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
  v_debt numeric;
  v_set public.prod_control_settings%ROWTYPE;
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
  v_id := gen_random_uuid();

  IF v_supplier_id IS NULL
     OR v_amount IS NULL OR v_amount <= 0
     OR v_method NOT IN ('cash', 'card', 'transfer') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, v_pay_date, 'create', p_data, 'prod_supplier_payments', v_id);

  SELECT name INTO v_supplier_name FROM public.prod_suppliers
  WHERE id = v_supplier_id AND company_id = v_company_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  v_set := public.prod_ctl_settings(v_company_id);
  IF NOT v_set.payment_over_debt_allowed THEN
    SELECT b.debt INTO v_debt
    FROM public.prod_supplier_balances b
    WHERE b.supplier_id = v_supplier_id AND b.company_id = v_company_id;
    IF v_amount > GREATEST(COALESCE(v_debt, 0), 0) THEN
      PERFORM public.prod_ctl_require(v_company_id, 'payment_over_debt', p_data, 'prod_supplier_payments', v_id,
        jsonb_build_object('supplier_id', v_supplier_id, 'amount', v_amount, 'debt', COALESCE(v_debt, 0)));
    END IF;
  END IF;

  v_account_id := public.prod_cash_account_for(v_company_id, v_account_id, v_method);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_supplier_payment_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_supplier_payments WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_supplier_payments (
    id, company_id, number, supplier_id, amount, method, pay_date, note,
    status, created_by, created_by_name, account_id
  ) VALUES (
    v_id, v_company_id, v_number, v_supplier_id, v_amount, v_method, v_pay_date, v_note,
    'posted', auth.uid(), v_user_name, v_account_id
  );

  PERFORM public.prod_cash_post(
    v_company_id, v_account_id, -v_amount, public.prod_cash_date_ts(v_pay_date),
    'supplier_payment', v_id, 'supplier', v_supplier_id, v_supplier_name, NULL, v_note, false
  );

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_cancel_supplier_payment (replaced, same signature) ═════════════
-- Body copied from 20261110000016 (latest definition). Addition after the
-- row lock: prod_ctl_cancel (period lock on pay_date, self-cancel, audit).
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
  v_date date;
  v_created_by uuid;
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

  SELECT status, pay_date, created_by INTO v_status, v_date, v_created_by
  FROM public.prod_supplier_payments
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  PERFORM public.prod_ctl_cancel(v_company_id, 'prod_supplier_payments', p_id, v_date,
                                 ARRAY[v_created_by], 'supplier_payment');

  PERFORM public.prod_cash_reverse(v_company_id, 'supplier_payment', p_id);

  UPDATE public.prod_supplier_payments
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_create_cash_order (replaced, same signature) ═══════════════════
-- Body copied from 20261110000016 (latest definition). Additions: id
-- generated first; prod_assert_date on the doc business date.
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
  v_id := gen_random_uuid();

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

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_doc_date), 'create',
                                  p_data, 'prod_cash_orders', v_id);

  v_account_id := public.prod_cash_account_for(v_company_id, v_account_id, 'cash');

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'prod_cash_order_no:' || v_company_id::text || ':' || v_direction, 0
  ));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_cash_orders WHERE company_id = v_company_id AND direction = v_direction;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_cash_orders (
    id, company_id, number, direction, doc_date, account_id, amount, category_id,
    counterparty_name, purpose, note, status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_direction, v_doc_date, v_account_id, v_amount, v_category_id,
    v_counterparty, v_purpose, v_note, 'posted', auth.uid(), v_user_name
  );

  PERFORM public.prod_cash_post(
    v_company_id, v_account_id,
    CASE WHEN v_direction = 'in' THEN v_amount ELSE -v_amount END,
    v_doc_date, 'cash_order', v_id, NULL, NULL, v_counterparty, v_category_id,
    COALESCE(v_purpose, v_note), false
  );

  RETURN jsonb_build_object('id', v_id, 'number', v_number);
END;
$$;

-- ═══ prod_create_cash_transfer (replaced, same signature) ════════════════
-- Body copied from 20261110000016 (latest definition). Additions: id
-- generated first; prod_assert_date on the doc business date.
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
  v_id := gen_random_uuid();

  IF v_from IS NULL OR v_to IS NULL OR v_from = v_to
     OR v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_cash_account_for(v_company_id, v_from, NULL);
  PERFORM public.prod_cash_account_for(v_company_id, v_to, NULL);

  PERFORM public.prod_assert_date(v_company_id, public.prod_biz_date(v_doc_date), 'create',
                                  p_data, 'prod_cash_transfers', v_id);

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_cash_transfer_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_cash_transfers WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_cash_transfers (
    id, company_id, number, doc_date, from_account_id, to_account_id, amount, note,
    status, created_by, created_by_name
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_from, v_to, v_amount, v_note,
    'posted', auth.uid(), v_user_name
  );

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

-- ═══ prod_cancel_cash_doc (replaced, same signature) ═════════════════════
-- Body copied from 20261110000016 (latest definition). Addition after the
-- row lock: prod_ctl_cancel (period lock on doc_date, self-cancel, audit).
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
  v_date timestamptz;
  v_created_by uuid;
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
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by
    FROM public.prod_cash_orders
    WHERE id = p_id AND company_id = v_company_id
    FOR UPDATE;
  ELSE
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by
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

  PERFORM public.prod_ctl_cancel(v_company_id,
    CASE WHEN p_type = 'cash_order' THEN 'prod_cash_orders' ELSE 'prod_cash_transfers' END,
    p_id, public.prod_biz_date(v_date), ARRAY[v_created_by], p_type);

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

-- ═══ supply_add_move (replaced, same signature) ══════════════════════════
-- Body copied from 20261110000016 (latest definition). Additions: id
-- generated first; prod_assert_date on move_date; agent balance counts
-- POSTED moves only (cancelled excluded); rule 9 'supply_issue_limit': an
-- 'issue' by a non owner / admin that takes the agent's posted issues of
-- that move_date above settings.supply_issue_daily_limit (NULL = no limit)
-- needs approval (checked under the per-agent lock).
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
  v_set public.prod_control_settings%ROWTYPE;
  v_day_total numeric;
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
  v_id := gen_random_uuid();

  IF v_agent_id IS NULL
     OR v_kind IS NULL OR v_kind NOT IN ('issue', 'return', 'expense')
     OR v_amount IS NULL OR v_amount <= 0
     OR (v_category_id IS NOT NULL AND v_kind <> 'expense')
     OR (v_account_id IS NOT NULL AND v_kind = 'expense') THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_assert_date(v_company_id, v_move_date, 'create', p_data, 'supply_cash_moves', v_id);

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
    WHERE company_id = v_company_id AND agent_id = v_agent_id AND status = 'posted';
    IF v_balance - v_amount < 0 THEN
      RAISE EXCEPTION 'negative_balance';
    END IF;
  END IF;

  IF v_kind = 'issue' AND COALESCE(public.prod_ctl_role(), '') NOT IN ('owner', 'admin') THEN
    v_set := public.prod_ctl_settings(v_company_id);
    IF v_set.supply_issue_daily_limit IS NOT NULL THEN
      SELECT COALESCE(sum(amount), 0) INTO v_day_total
      FROM public.supply_cash_moves
      WHERE company_id = v_company_id AND agent_id = v_agent_id AND kind = 'issue'
        AND status = 'posted' AND move_date = v_move_date;
      IF v_day_total + v_amount > v_set.supply_issue_daily_limit THEN
        PERFORM public.prod_ctl_require(v_company_id, 'supply_issue_limit', p_data, 'supply_cash_moves', v_id,
          jsonb_build_object('agent_id', v_agent_id, 'move_date', v_move_date, 'day_total', v_day_total,
                             'amount', v_amount, 'limit', v_set.supply_issue_daily_limit));
      END IF;
    END IF;
  END IF;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.supply_cash_moves (
    id, company_id, agent_id, kind, amount, purpose, expense_category_id,
    move_date, note, created_by, created_by_name, account_id
  ) VALUES (
    v_id, v_company_id, v_agent_id, v_kind, v_amount, v_purpose, v_category_id,
    v_move_date, v_note, auth.uid(), v_user_name, v_account_id
  );

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

-- ═══ supply_cancel_move (new) ════════════════════════════════════════════
-- prod_supply AND owner / admin role. Row FOR UPDATE (a second cancel
-- waits, then 'already_cancelled') -> prod_ctl_cancel (period lock on
-- move_date, self-cancel, audit) -> per-agent advisory lock (same as
-- supply_add_move) -> cancelling an 'issue' must not leave the agent below
-- 0 ('negative_balance') -> 1:1 reversal of the move's cash movement
-- (issue: money back into the account; return: out of it, so
-- insufficient_funds is possible; expense: none) -> status 'cancelled'.
-- p_note optional (<= 500), stored as cancel_note.
CREATE OR REPLACE FUNCTION public.supply_cancel_move(p_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_role text;
  v_mv record;
  v_note text;
  v_balance numeric;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_supply') THEN
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

  v_note := NULLIF(btrim(p_note), '');
  IF p_id IS NULL OR (v_note IS NOT NULL AND char_length(v_note) > 500) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT id, agent_id, kind, amount, move_date, status, created_by INTO v_mv
  FROM public.supply_cash_moves
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_mv.status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;

  PERFORM public.prod_ctl_cancel(v_company_id, 'supply_cash_moves', p_id, v_mv.move_date,
                                 ARRAY[v_mv.created_by], 'supply_' || v_mv.kind);

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'supply_agent:' || v_company_id::text || ':' || v_mv.agent_id::text, 0
  ));

  IF v_mv.kind = 'issue' THEN
    SELECT COALESCE(sum(CASE WHEN kind = 'issue' THEN amount ELSE -amount END), 0)
    INTO v_balance
    FROM public.supply_cash_moves
    WHERE company_id = v_company_id AND agent_id = v_mv.agent_id AND status = 'posted';
    IF v_balance - v_mv.amount < 0 THEN
      RAISE EXCEPTION 'negative_balance';
    END IF;
    PERFORM public.prod_cash_reverse(v_company_id, 'supply_issue', p_id);
  ELSIF v_mv.kind = 'return' THEN
    PERFORM public.prod_cash_reverse(v_company_id, 'supply_return', p_id);
  END IF;

  UPDATE public.supply_cash_moves
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_note = v_note
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ═══ prod_cancel_document (replaced, same signature) ═════════════════════
-- Body copied from 20261110000015 (latest definition). Addition: every
-- branch also reads the document date and creator under the row lock, then
-- prod_ctl_cancel (period lock on the document business date ->
-- 'period_closed'; self-cancel -> 'self_cancel' for the creator, for a
-- stock count also the user who posted it; audit row 'cancel') runs before
-- the type-specific guards and the reversal.
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
  v_receipt_id uuid;
  v_corr_line uuid;
  v_corr_number integer;
  v_sale_id uuid;
  v_date timestamptz;
  v_created_by uuid;
  v_posted_by uuid;
  v_entity text;
BEGIN
  PERFORM public.assert_business_type('production');

  v_key := CASE p_doc_type
    WHEN 'receipt' THEN 'prod_receipts'
    WHEN 'production' THEN 'prod_production'
    WHEN 'processing' THEN 'prod_processing'
    WHEN 'transfer' THEN 'prod_stock'
    WHEN 'separation' THEN 'prod_production'
    WHEN 'writeoff' THEN 'prod_stock'
    WHEN 'stock_count' THEN 'prod_stock'
    WHEN 'opening_balance' THEN 'prod_stock'
    WHEN 'price_correction' THEN 'prod_receipts'
    WHEN 'sale' THEN 'prod_sales'
    WHEN 'sale_return' THEN 'prod_sales'
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
    v_entity := 'prod_receipts';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_receipts
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'production' THEN
    v_entity := 'prod_productions';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_productions
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'processing' THEN
    v_entity := 'prod_processings';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_processings
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'separation' THEN
    v_entity := 'prod_separations';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_separations
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'writeoff' THEN
    v_entity := 'prod_writeoffs';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_writeoffs
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'stock_count' THEN
    v_entity := 'prod_stock_counts';
    SELECT status, doc_date, created_by, posted_by INTO v_status, v_date, v_created_by, v_posted_by
    FROM public.prod_stock_counts
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'opening_balance' THEN
    v_entity := 'prod_openings';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_openings
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'price_correction' THEN
    v_entity := 'prod_price_corrections';
    -- receipt_id is immutable: read it unlocked, lock the receipt, then the
    -- correction.
    SELECT receipt_id INTO v_receipt_id FROM public.prod_price_corrections
    WHERE id = p_id AND company_id = v_company_id;
    IF v_receipt_id IS NOT NULL THEN
      PERFORM 1 FROM public.prod_receipts
      WHERE id = v_receipt_id AND company_id = v_company_id FOR UPDATE;
    END IF;
    SELECT status, receipt_item_id, number, doc_date, created_by
    INTO v_status, v_corr_line, v_corr_number, v_date, v_created_by
    FROM public.prod_price_corrections
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'sale' THEN
    v_entity := 'prod_sales';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_sales
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSIF p_doc_type = 'sale_return' THEN
    v_entity := 'prod_sale_returns';
    -- sale_id is immutable: read it unlocked, lock the sale, then the return.
    SELECT sale_id INTO v_sale_id FROM public.prod_sale_returns
    WHERE id = p_id AND company_id = v_company_id;
    IF v_sale_id IS NOT NULL THEN
      PERFORM 1 FROM public.prod_sales
      WHERE id = v_sale_id AND company_id = v_company_id FOR UPDATE;
    END IF;
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_sale_returns
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  ELSE
    v_entity := 'prod_transfers';
    SELECT status, doc_date, created_by INTO v_status, v_date, v_created_by FROM public.prod_transfers
    WHERE id = p_id AND company_id = v_company_id FOR UPDATE;
  END IF;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'already_cancelled';
  END IF;
  IF p_doc_type = 'stock_count' AND v_status <> 'posted' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_ctl_cancel(v_company_id, v_entity, p_id, public.prod_biz_date(v_date),
                                 ARRAY[v_created_by, v_posted_by], p_doc_type);

  IF p_doc_type = 'receipt' AND EXISTS (
    SELECT 1 FROM public.prod_milk_intakes
    WHERE company_id = v_company_id AND receipt_id = p_id AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  IF p_doc_type = 'receipt' AND EXISTS (
    SELECT 1 FROM public.prod_price_corrections
    WHERE company_id = v_company_id AND receipt_id = p_id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'has_price_correction';
  END IF;

  IF p_doc_type = 'price_correction' THEN
    IF EXISTS (
      SELECT 1 FROM public.prod_price_corrections c
      WHERE c.company_id = v_company_id AND c.receipt_item_id = v_corr_line
        AND c.status = 'posted' AND c.number > v_corr_number
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'not_latest';
    END IF;
  END IF;

  IF p_doc_type = 'sale' THEN
    IF EXISTS (
      SELECT 1 FROM public.prod_sale_returns
      WHERE company_id = v_company_id AND sale_id = p_id AND status = 'posted'
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'has_returns';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.prod_sale_items si
      JOIN public.prod_items it ON it.id = si.item_id AND it.company_id = si.company_id
      WHERE si.company_id = v_company_id AND si.sale_id = p_id AND it.unit <> si.unit
    ) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'unit_changed';
    END IF;
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
  ELSIF p_doc_type = 'writeoff' THEN
    UPDATE public.prod_writeoffs
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'stock_count' THEN
    UPDATE public.prod_stock_counts
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), updated_at = now()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'opening_balance' THEN
    UPDATE public.prod_openings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'price_correction' THEN
    UPDATE public.prod_price_corrections
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'sale' THEN
    UPDATE public.prod_sales
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSIF p_doc_type = 'sale_return' THEN
    UPDATE public.prod_sale_returns
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  ELSE
    UPDATE public.prod_transfers
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    WHERE id = p_id AND company_id = v_company_id;
  END IF;
END;
$$;

-- ─── 8) New control RPCs (owner only) ─────────────────────────────────────
-- Permission: has_permission('sozlamalar') (whitelisted shared key, also
-- valid for production firms; owners bypass) AND role 'owner'.

-- ═══ prod_save_control_settings (new) ════════════════════════════════════
-- p_data: any subset of the prod_control_settings columns (absent key =
-- unchanged; supply_issue_daily_limit null = no limit; other keys must not
-- be null). Ranges: *_pct 0..100, backdate_days_* 0..3650 (staff <= admin),
-- future_days 0..365, supply_issue_daily_limit > 0, manual_lot_pick_roles
-- array subset of owner / admin / manager / staff. Unknown keys ->
-- invalid_input. Row created when missing; logged by the prod_audit
-- trigger (action 'settings'). Returns the settings row as jsonb.
CREATE OR REPLACE FUNCTION public.prod_save_control_settings(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_cur public.prod_control_settings%ROWTYPE;
  v_key text;
  v_num numeric;
  v_bool boolean;
  v_roles text[];
  v_el jsonb;
  v_prod_tol numeric;
  v_sep_loss numeric;
  v_sep_fat numeric;
  v_proc_min numeric;
  v_cond_min numeric;
  v_bd_staff integer;
  v_bd_admin integer;
  v_future integer;
  v_lab_differ boolean;
  v_self_cancel boolean;
  v_limit numeric;
  v_over_debt boolean;
  v_pick_roles text[];
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('sozlamalar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF public.prod_ctl_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM public.prod_ctl_settings(v_company_id);
  SELECT * INTO v_cur FROM public.prod_control_settings WHERE company_id = v_company_id FOR UPDATE;

  v_prod_tol := v_cur.production_tolerance_pct;
  v_sep_loss := v_cur.separation_loss_max_pct;
  v_sep_fat := v_cur.separation_fat_tolerance_pct;
  v_proc_min := v_cur.processing_min_recovery_pct;
  v_cond_min := v_cur.conditional_price_min_pct;
  v_bd_staff := v_cur.backdate_days_staff;
  v_bd_admin := v_cur.backdate_days_admin;
  v_future := v_cur.future_days;
  v_lab_differ := v_cur.lab_must_differ;
  v_self_cancel := v_cur.self_cancel_allowed;
  v_limit := v_cur.supply_issue_daily_limit;
  v_over_debt := v_cur.payment_over_debt_allowed;
  v_pick_roles := v_cur.manual_lot_pick_roles;

  FOR v_key IN SELECT jsonb_object_keys(p_data)
  LOOP
    IF v_key IN ('production_tolerance_pct', 'separation_loss_max_pct', 'separation_fat_tolerance_pct',
                 'processing_min_recovery_pct', 'conditional_price_min_pct') THEN
      v_num := public.prod_jnum(p_data, v_key, 2);
      IF v_num IS NULL OR v_num NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
      IF v_key = 'production_tolerance_pct' THEN
        v_prod_tol := v_num;
      ELSIF v_key = 'separation_loss_max_pct' THEN
        v_sep_loss := v_num;
      ELSIF v_key = 'separation_fat_tolerance_pct' THEN
        v_sep_fat := v_num;
      ELSIF v_key = 'processing_min_recovery_pct' THEN
        v_proc_min := v_num;
      ELSE
        v_cond_min := v_num;
      END IF;
    ELSIF v_key IN ('backdate_days_staff', 'backdate_days_admin', 'future_days') THEN
      v_num := public.prod_jnum(p_data, v_key, 3);
      IF v_num IS NULL OR v_num <> trunc(v_num) OR v_num < 0
         OR v_num > (CASE WHEN v_key = 'future_days' THEN 365 ELSE 3650 END) THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
      IF v_key = 'backdate_days_staff' THEN
        v_bd_staff := v_num::integer;
      ELSIF v_key = 'backdate_days_admin' THEN
        v_bd_admin := v_num::integer;
      ELSE
        v_future := v_num::integer;
      END IF;
    ELSIF v_key IN ('lab_must_differ', 'self_cancel_allowed', 'payment_over_debt_allowed') THEN
      v_bool := public.prod_jbool(p_data, v_key);
      IF v_bool IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
      IF v_key = 'lab_must_differ' THEN
        v_lab_differ := v_bool;
      ELSIF v_key = 'self_cancel_allowed' THEN
        v_self_cancel := v_bool;
      ELSE
        v_over_debt := v_bool;
      END IF;
    ELSIF v_key = 'supply_issue_daily_limit' THEN
      v_num := public.prod_jnum(p_data, v_key, 2);
      IF v_num IS NOT NULL AND v_num <= 0 THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
      v_limit := v_num;
    ELSIF v_key = 'manual_lot_pick_roles' THEN
      IF jsonb_typeof(p_data->v_key) <> 'array' OR jsonb_array_length(p_data->v_key) > 4 THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
      END IF;
      v_roles := '{}';
      FOR v_el IN SELECT * FROM jsonb_array_elements(p_data->v_key)
      LOOP
        IF jsonb_typeof(v_el) <> 'string' OR (v_el #>> '{}') NOT IN ('owner', 'admin', 'manager', 'staff') THEN
          RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
        END IF;
        IF NOT ((v_el #>> '{}') = ANY (v_roles)) THEN
          v_roles := v_roles || (v_el #>> '{}');
        END IF;
      END LOOP;
      v_pick_roles := v_roles;
    ELSE
      RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
    END IF;
  END LOOP;

  IF v_bd_staff > v_bd_admin THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'backdate_days_staff';
  END IF;

  UPDATE public.prod_control_settings
  SET production_tolerance_pct = v_prod_tol,
      separation_loss_max_pct = v_sep_loss,
      separation_fat_tolerance_pct = v_sep_fat,
      processing_min_recovery_pct = v_proc_min,
      conditional_price_min_pct = v_cond_min,
      backdate_days_staff = v_bd_staff,
      backdate_days_admin = v_bd_admin,
      future_days = v_future,
      lab_must_differ = v_lab_differ,
      self_cancel_allowed = v_self_cancel,
      supply_issue_daily_limit = v_limit,
      payment_over_debt_allowed = v_over_debt,
      manual_lot_pick_roles = v_pick_roles,
      updated_at = now(),
      updated_by = auth.uid()
  WHERE company_id = v_company_id
  RETURNING * INTO v_cur;

  RETURN to_jsonb(v_cur);
END;
$$;

-- ═══ prod_close_period (new) ═════════════════════════════════════════════
-- Owner. Closes everything dated <= p_until. p_until must be < today
-- (Tashkent) -> else invalid_input DETAIL 'future_date', and later than the
-- current lock -> else invalid_input DETAIL 'already_closed' (moving the
-- lock back is prod_reopen_period). Period row FOR UPDATE: waits for every
-- in-flight posting (they hold it FOR SHARE). Audit 'period_close'.
-- Returns { locked_until }.
CREATE OR REPLACE FUNCTION public.prod_close_period(p_until date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_old date;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('sozlamalar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF public.prod_ctl_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_until IS NULL OR NOT isfinite(p_until) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_until >= public.prod_biz_date(now()) THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'future_date';
  END IF;

  INSERT INTO public.prod_period_locks (company_id) VALUES (v_company_id)
  ON CONFLICT (company_id) DO NOTHING;
  SELECT locked_until INTO v_old
  FROM public.prod_period_locks WHERE company_id = v_company_id
  FOR UPDATE;
  IF v_old IS NOT NULL AND p_until <= v_old THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'already_closed';
  END IF;

  UPDATE public.prod_period_locks
  SET locked_until = p_until, locked_by = auth.uid(), locked_at = now()
  WHERE company_id = v_company_id;

  PERFORM public.prod_audit_write(v_company_id, 'prod_period_locks', v_company_id, 'period_close',
    jsonb_build_object('locked_until', v_old), jsonb_build_object('locked_until', p_until), NULL, NULL);

  RETURN jsonb_build_object('locked_until', p_until);
END;
$$;

-- ═══ prod_reopen_period (new) ════════════════════════════════════════════
-- Owner. Moves the lock BACK to p_until (NULL = fully open). Requires a
-- current lock and p_until < it (else invalid_input DETAIL 'not_closed'),
-- p_note >= 5 chars (else invalid_input DETAIL 'note'). Audit
-- 'period_reopen' with the note. Returns { locked_until }.
CREATE OR REPLACE FUNCTION public.prod_reopen_period(p_until date, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_old date;
  v_note text;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('sozlamalar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF public.prod_ctl_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_note := NULLIF(btrim(p_note), '');
  IF v_note IS NULL OR char_length(v_note) < 5 OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'note';
  END IF;
  IF p_until IS NOT NULL AND NOT isfinite(p_until) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  INSERT INTO public.prod_period_locks (company_id) VALUES (v_company_id)
  ON CONFLICT (company_id) DO NOTHING;
  SELECT locked_until INTO v_old
  FROM public.prod_period_locks WHERE company_id = v_company_id
  FOR UPDATE;
  IF v_old IS NULL OR (p_until IS NOT NULL AND p_until >= v_old) THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'not_closed';
  END IF;

  UPDATE public.prod_period_locks
  SET locked_until = p_until, locked_by = auth.uid(), locked_at = now()
  WHERE company_id = v_company_id;

  PERFORM public.prod_audit_write(v_company_id, 'prod_period_locks', v_company_id, 'period_reopen',
    jsonb_build_object('locked_until', v_old), jsonb_build_object('locked_until', p_until), NULL, v_note);

  RETURN jsonb_build_object('locked_until', p_until);
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated for every client RPC
-- touched here. prod_post_stock_count was re-created (new ACL).

REVOKE EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_milk_intake(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_milk_intake(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_amend_milk_lab(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_production(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_processing(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_separation(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_writeoff(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_post_stock_count(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_opening(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_price_correction(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_sale(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_sale_return(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_customer_payment(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_customer_payment(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_supplier_payment(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_supplier_payment(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_cash_order(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_create_cash_transfer(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_cash_doc(text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.supply_add_move(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.supply_cancel_move(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_control_settings(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_close_period(date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_reopen_period(date, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_create_receipt(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_milk_intake(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_milk_intake(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_amend_milk_lab(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_supplier(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_production(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_processing(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_separation(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_transfer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_writeoff(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_post_stock_count(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_opening(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_price_correction(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_sale(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_sale_return(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_customer_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_customer_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_supplier_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_supplier_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_cash_order(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_create_cash_transfer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_cash_doc(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supply_add_move(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supply_cancel_move(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_cancel_document(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_control_settings(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_close_period(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_reopen_period(date, text) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on every new table:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_control_settings', 'prod_audit_log', 'prod_period_locks')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_control_settings', 'prod_audit_log', 'prod_period_locks');
-- -- audit trigger on 11 tables:
-- SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
-- WHERE t.tgname = 'prod_audit' AND NOT t.tgisinternal ORDER BY 1;
-- -- one settings row per production-enabled company:
-- SELECT count(*) FROM public.prod_control_settings;
