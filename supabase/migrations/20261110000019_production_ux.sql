-- Production wave 8: usability (approval queue, notifications, user
-- preferences, onboarding status, repeat last sale, daily production plan).
--
-- Why: 17 made every exception an owner / admin override, but a staff
-- member who hits a rule had no way to hand the document to the owner
-- (they had to re-type it on the owner's screen). Daily work (lab queue,
-- expiring lots, low stock, overdue debts, open stock counts) had to be
-- found page by page; a new customer had no checklist; every user saw the
-- full menu; the dispatcher re-typed the same order every day; production
-- had no plan to work against.
--
-- This file adds / changes:
--   1) approval requests   prod_approval_requests + request / decide /
--                          withdraw RPCs (approve = run the stored RPC as
--                          the approver with override)
--   2) notifications       prod_notifications() (computed, no table)
--   3) user preferences    prod_user_prefs + get / save RPCs
--   4) onboarding          prod_onboarding_status()
--   5) repeat last sale    prod_last_sale_lines(uuid)
--   6) daily plan          prod_production_plans, prod_save_plan,
--                          prod_plan_requirements, prod_create_production
--                          + optional plan_id, cancel trigger
--
-- Objects:
--   NEW tables:  prod_approval_requests, prod_user_prefs, prod_production_plans
--   NEW indexes (partial, for the notifications / last sale):
--                prod_milk_intakes_weighed_idx, prod_lots_expiry_idx,
--                prod_items_min_stock_idx, prod_stock_counts_draft_idx,
--                prod_sales_customer_posted_idx
--   NEW internal helpers (EXECUTE revoked from every client role):
--                prod_approval_rpc_perm, prod_notif_entry, prod_prefs_hrefs,
--                prod_plan_on_production_cancel (trigger fn)
--   NEW RPCs:    prod_request_approval(text, jsonb, text, text) -> uuid,
--                prod_decide_approval(uuid, boolean, text) -> jsonb,
--                prod_withdraw_approval(uuid),
--                prod_notifications() -> jsonb,
--                prod_get_user_prefs() -> jsonb, prod_save_user_prefs(jsonb) -> jsonb,
--                prod_onboarding_status() -> jsonb,
--                prod_last_sale_lines(uuid) -> jsonb,
--                prod_save_plan(date, jsonb) -> jsonb,
--                prod_plan_requirements(date, uuid DEFAULT NULL) -> jsonb
--   REPLACED (same signature; new OPTIONAL input plan_id, new return key plan_id):
--                prod_create_production           (latest = 18)
--   NEW trigger: prod_plan_on_production_cancel (AFTER UPDATE OF status on
--                prod_productions, posted -> cancelled)
--   NOT changed: has_permission (no new key), every 17 / 18 rule, the
--     target RPCs of the approval whitelist, prod_cancel_document.
--
-- ── Approval (how an approved request runs) ───────────────────────────────
--   Whitelist (prod_approval_rpc_perm, RPC -> permission the requester AND
--   the approver must hold): prod_create_receipt / _price_correction
--   (prod_receipts), prod_create_milk_intake (prod_milk; + prod_lab for a
--   lab block, requester), prod_record_milk_lab / prod_amend_milk_lab
--   (prod_lab), prod_create_production / _separation (prod_production),
--   prod_create_processing (prod_processing), prod_create_transfer /
--   _writeoff / _opening, prod_post_stock_count (prod_stock),
--   prod_create_sale / _sale_return (prod_sales),
--   prod_create_customer_payment (prod_customer_payments),
--   prod_create_supplier_payment (prod_suppliers), prod_create_cash_order /
--   _cash_transfer (prod_cash), supply_add_move (prod_supply). Unknown name
--   -> invalid_input DETAIL 'rpc'. (prod_save_supplier is not listed: its
--   rule is 'forbidden', not 'needs_approval'; cancels have no overridable
--   rule.)
--   prod_decide_approval calls the stored RPC from inside its own body, in
--   the approver's session. SECURITY DEFINER switches current_user only;
--   auth.uid() reads the request JWT claims, so inside the target RPC
--   auth.uid(), prod_ctl_role() (users.role of auth.uid()) and
--   has_permission() are the APPROVER's: the 17 override is accepted for an
--   owner / admin, the 'override' audit row (user_id, note = decision note)
--   and the document's created_by are the approver; the requester stays on
--   the request row (requested_by). Non-jsonb signatures by explicit CASE
--   branches: milk lab (uuid, lab || override) and stock count (uuid, p_ctl
--   = override). The call runs in a plpgsql sub-transaction (BEGIN ...
--   EXCEPTION): an error rolls back only the document and the request is
--   stored as 'failed' (error = SQLERRM, error_detail = DETAIL); the
--   decision itself commits. An admin may not decide their own request;
--   the owner may.
--
-- ── Lock order (extends 17 / 18) ──────────────────────────────────────────
--   prod_request_approval: advisory 'prod_approval_req:<user>' only.
--   prod_decide_approval: request row FOR UPDATE -> the target RPC's order.
--   prod_withdraw_approval: request row FOR UPDATE.
--   prod_create_production with plan_id: plan row FOR UPDATE -> period row
--   (17) -> ... unchanged. prod_save_plan: advisory 'prod_plan:<co>:<date>'
--   -> that date's plan rows FOR UPDATE (never followed by document locks).
--   Cancel trigger: production row (held by prod_cancel_document) -> plan
--   row. prod_save_user_prefs: one upsert (ON CONFLICT). Reads (notifications,
--   onboarding, last sale, plan requirements) take no locks.
--
-- ── Access model ──────────────────────────────────────────────────────────
--   All three tables: RLS on, ONE SELECT policy, REVOKE ALL from
--   authenticated + anon right after CREATE, GRANT SELECT to authenticated,
--   writes RPC-only. prod_approval_requests: company AND (requester OR
--   owner / admin); prod_user_prefs: own row (user_id = auth.uid());
--   prod_production_plans: company members.
--   Permission checks: request (target key), decide (role owner / admin +
--   target key), withdraw (requester only, deliberately no key),
--   notifications (per kind), prefs (none: caller's own UI state, company
--   required), onboarding (role owner / admin + 'sozlamalar'), last sale
--   ('prod_sales'), plan ('prod_production').
--
-- ── Destructive / blocking statements ─────────────────────────────────────
--   No DROP, no ALTER of existing columns / constraints, no DML on existing
--   rows. CREATE INDEX (not CONCURRENTLY, inside the transaction) on
--   prod_milk_intakes, prod_lots, prod_items, prod_stock_counts, prod_sales
--   blocks writes to those tables while each partial index builds
--   (milliseconds at the current volume). CREATE TRIGGER on
--   prod_productions takes a brief SHARE ROW EXCLUSIVE lock. Runtime:
--   prod_save_plan DELETEs the date's planned / skipped plan lines that the
--   client left out (user-owned planning data, never done lines).
--
-- ── Behaviour change for existing clients ─────────────────────────────────
--   None: no signature / shape change (prod_create_production only gains an
--   optional input and an extra return key); every rule of 17 / 18 is
--   unchanged.
--
-- Client deploy: the migration is SAFE alone. The new features need client
-- work: "Frontend contract" in the spec (approval queue + "Tasdiqlashga
-- yuborish", notification bell, prefs / favourites / tablet mode,
-- onboarding checklist, repeat last sale, daily plan page).
--
-- Runs as one transaction (BEGIN/COMMIT) so a failure leaves nothing applied.

BEGIN;

-- ─── 1) New tables ────────────────────────────────────────────────────────
-- Access model (all three): company_id NOT NULL -> companies ON DELETE
-- CASCADE; RLS on with ONE SELECT policy; REVOKE ALL from authenticated +
-- anon right after CREATE (Supabase default-grant leak), GRANT SELECT to
-- authenticated. Writes ONLY via the SECURITY DEFINER RPCs / trigger below
-- (RPC-only write access, also for the per-user preferences: one write path
-- with validation instead of INSERT / UPDATE policies).

-- 1a) Approval requests: a document that hit a 17 'needs_approval' rule,
-- parked for an owner / admin. payload = the RPC input WITHOUT override
-- keys. Lifecycle: pending -> approved | failed (decide, approve) |
-- rejected (decide, reject) | withdrawn (requester). Terminal states are
-- never changed again. No FK on the user columns (a deleted account must
-- not block / rewrite history; names are snapshotted).
CREATE TABLE public.prod_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid NOT NULL,
  requested_by_name text NULL,
  rpc_name text NOT NULL,
  payload jsonb NOT NULL,
  rule text NULL,
  rule_detail jsonb NULL,
  doc_label text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid NULL,
  decided_by_name text NULL,
  decided_at timestamptz NULL,
  decision_note text NULL,
  result jsonb NULL,
  error text NULL,
  error_detail text NULL,
  CONSTRAINT prod_approval_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'failed', 'withdrawn')),
  CONSTRAINT prod_approval_requests_rpc_check CHECK (length(rpc_name) BETWEEN 1 AND 63),
  CONSTRAINT prod_approval_requests_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT prod_approval_requests_rule_check CHECK (rule IS NULL OR length(rule) <= 50),
  CONSTRAINT prod_approval_requests_label_check CHECK (length(btrim(doc_label)) BETWEEN 1 AND 200),
  CONSTRAINT prod_approval_requests_note_check CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  CONSTRAINT prod_approval_requests_error_check CHECK (
    (error IS NULL OR length(error) <= 1000) AND (error_detail IS NULL OR length(error_detail) <= 1000)
  ),
  CONSTRAINT prod_approval_requests_decided_check CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT prod_approval_requests_decider_check CHECK (
    (status IN ('approved', 'rejected', 'failed')) = (decided_by IS NOT NULL)
  ),
  CONSTRAINT prod_approval_requests_approved_check CHECK (
    status <> 'approved' OR (decision_note IS NOT NULL AND error IS NULL)
  ),
  CONSTRAINT prod_approval_requests_failed_check CHECK (
    status <> 'failed' OR (decision_note IS NOT NULL AND error IS NOT NULL AND result IS NULL)
  )
);
REVOKE ALL ON public.prod_approval_requests FROM authenticated, anon;

COMMENT ON TABLE public.prod_approval_requests IS
  'Production approval queue: documents that need an owner / admin override (17 rules). Read via RLS '
  '(owner / admin: the company; others: their own requests); write ONLY via prod_request_approval / '
  'prod_decide_approval / prod_withdraw_approval. Approve runs the stored RPC as the approver.';

CREATE INDEX prod_approval_requests_company_created_idx
  ON public.prod_approval_requests (company_id, created_at DESC);
CREATE INDEX prod_approval_requests_pending_idx
  ON public.prod_approval_requests (company_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX prod_approval_requests_requester_idx
  ON public.prod_approval_requests (requested_by, company_id, decided_at DESC);

ALTER TABLE public.prod_approval_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner/admin or requester (select)" ON public.prod_approval_requests
  FOR SELECT TO authenticated
  USING (
    company_id = (SELECT public.get_company_id())
    AND (requested_by = (SELECT auth.uid()) OR (SELECT public.prod_is_owner_admin()))
  );
GRANT SELECT ON public.prod_approval_requests TO authenticated;

-- 1b) Per-user UI preferences (start page, favourites, hidden menu items,
-- tablet mode). One row per user, created by the first save. Readable only
-- by its user; written only via prod_save_user_prefs.
CREATE TABLE public.prod_user_prefs (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  home text NULL,
  favorites text[] NOT NULL DEFAULT '{}'::text[],
  hidden_menu text[] NOT NULL DEFAULT '{}'::text[],
  tablet_mode boolean NOT NULL DEFAULT false,
  requests_seen_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prod_user_prefs_home_check CHECK (
    home IS NULL OR home IN ('auto', 'dashboard', 'milk', 'lab', 'stock', 'sales', 'cash')
  ),
  CONSTRAINT prod_user_prefs_favorites_check CHECK (cardinality(favorites) <= 12),
  CONSTRAINT prod_user_prefs_hidden_check CHECK (cardinality(hidden_menu) <= 100)
);
REVOKE ALL ON public.prod_user_prefs FROM authenticated, anon;

COMMENT ON TABLE public.prod_user_prefs IS
  'Per-user production UI preferences. Read via RLS (own row only); write ONLY via prod_save_user_prefs.';

CREATE INDEX prod_user_prefs_company_idx ON public.prod_user_prefs (company_id);

ALTER TABLE public.prod_user_prefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own row (select)" ON public.prod_user_prefs
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON public.prod_user_prefs TO authenticated;

-- 1c) Daily production plan lines. done <=> production_id set (by
-- prod_create_production with plan_id; a cancelled production puts the line
-- back to planned, trigger prod_plan_on_production_cancel).
CREATE TABLE public.prod_production_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  plan_date date NOT NULL,
  item_id uuid NOT NULL,
  planned_qty numeric(14,3) NOT NULL,
  recipe_id uuid NULL,
  status text NOT NULL DEFAULT 'planned',
  production_id uuid NULL,
  note text NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT prod_production_plans_id_company_key UNIQUE (id, company_id),
  CONSTRAINT prod_production_plans_item_fk FOREIGN KEY (item_id, company_id)
    REFERENCES public.prod_items (id, company_id),
  CONSTRAINT prod_production_plans_recipe_fk FOREIGN KEY (recipe_id, company_id)
    REFERENCES public.prod_recipes (id, company_id),
  CONSTRAINT prod_production_plans_production_fk FOREIGN KEY (production_id, company_id)
    REFERENCES public.prod_productions (id, company_id),
  CONSTRAINT prod_production_plans_qty_check CHECK (planned_qty > 0),
  CONSTRAINT prod_production_plans_status_check CHECK (status IN ('planned', 'done', 'skipped')),
  CONSTRAINT prod_production_plans_done_check CHECK ((status = 'done') = (production_id IS NOT NULL)),
  CONSTRAINT prod_production_plans_note_check CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT prod_production_plans_sort_check CHECK (sort_order BETWEEN 0 AND 1000)
);
REVOKE ALL ON public.prod_production_plans FROM authenticated, anon;

COMMENT ON TABLE public.prod_production_plans IS
  'Daily production plan lines (item, planned qty, recipe). Read via RLS (company members); write ONLY via '
  'prod_save_plan / prod_create_production (plan_id) / the production-cancel trigger.';

CREATE INDEX prod_production_plans_company_date_idx ON public.prod_production_plans (company_id, plan_date, sort_order);
CREATE UNIQUE INDEX prod_production_plans_production_key ON public.prod_production_plans (production_id)
  WHERE production_id IS NOT NULL;
CREATE INDEX prod_production_plans_item_idx ON public.prod_production_plans (item_id, company_id);
CREATE INDEX prod_production_plans_recipe_idx ON public.prod_production_plans (recipe_id, company_id)
  WHERE recipe_id IS NOT NULL;

ALTER TABLE public.prod_production_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Company isolation (select)" ON public.prod_production_plans
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_company_id()));
GRANT SELECT ON public.prod_production_plans TO authenticated;

-- ─── 2) Indexes for prod_notifications (polled every 60 s) ────────────────
-- Partial, small; built inside the transaction (blocks writes to the table
-- for the build time, milliseconds at the current volume).
CREATE INDEX prod_milk_intakes_weighed_idx ON public.prod_milk_intakes (company_id, intake_date)
  WHERE status = 'weighed';
CREATE INDEX prod_lots_expiry_idx ON public.prod_lots (company_id, expiry_date)
  WHERE expiry_date IS NOT NULL;
CREATE INDEX prod_items_min_stock_idx ON public.prod_items (company_id)
  WHERE min_stock IS NOT NULL AND is_active;
CREATE INDEX prod_stock_counts_draft_idx ON public.prod_stock_counts (company_id, doc_date)
  WHERE status = 'draft';
-- prod_last_sale_lines: newest posted sale of a customer.
CREATE INDEX prod_sales_customer_posted_idx ON public.prod_sales (company_id, customer_id, doc_date DESC, number DESC)
  WHERE status = 'posted';

-- ─── 3) Approval requests ─────────────────────────────────────────────────

-- Whitelist: RPC that can raise 'needs_approval' (17) -> the permission key
-- its caller needs. NULL = not approvable (callers fail closed).
CREATE OR REPLACE FUNCTION public.prod_approval_rpc_perm(p_rpc text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_rpc
    WHEN 'prod_create_receipt' THEN 'prod_receipts'
    WHEN 'prod_create_price_correction' THEN 'prod_receipts'
    WHEN 'prod_create_milk_intake' THEN 'prod_milk'
    WHEN 'prod_record_milk_lab' THEN 'prod_lab'
    WHEN 'prod_amend_milk_lab' THEN 'prod_lab'
    WHEN 'prod_create_production' THEN 'prod_production'
    WHEN 'prod_create_separation' THEN 'prod_production'
    WHEN 'prod_create_processing' THEN 'prod_processing'
    WHEN 'prod_create_transfer' THEN 'prod_stock'
    WHEN 'prod_create_writeoff' THEN 'prod_stock'
    WHEN 'prod_create_opening' THEN 'prod_stock'
    WHEN 'prod_post_stock_count' THEN 'prod_stock'
    WHEN 'prod_create_sale' THEN 'prod_sales'
    WHEN 'prod_create_sale_return' THEN 'prod_sales'
    WHEN 'prod_create_customer_payment' THEN 'prod_customer_payments'
    WHEN 'prod_create_supplier_payment' THEN 'prod_suppliers'
    WHEN 'prod_create_cash_order' THEN 'prod_cash'
    WHEN 'prod_create_cash_transfer' THEN 'prod_cash'
    WHEN 'supply_add_move' THEN 'prod_supply'
  END
$$;

REVOKE EXECUTE ON FUNCTION public.prod_approval_rpc_perm(text) FROM PUBLIC, anon, authenticated;

-- ═══ prod_request_approval (new) ═════════════════════════════════════════
-- Any user holding the target RPC's permission (prod_create_milk_intake
-- with a lab block: + prod_lab). p_payload = the RPC's p_data; for the
-- non-jsonb RPCs { intake_id, lab } (prod_record_milk_lab,
-- prod_amend_milk_lab) / { id } (prod_post_stock_count). override /
-- override_note are stripped (top level and in lab). p_rule <= 50 chars,
-- p_label 1..200. An identical pending request of the same requester is
-- returned instead of a duplicate; max 50 pending per requester.
-- Lock: advisory 'prod_approval_req:<user>' (dedupe + cap), nothing else.
CREATE OR REPLACE FUNCTION public.prod_request_approval(p_rpc text, p_payload jsonb, p_rule text, p_label text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_uid uuid := auth.uid();
  v_perm text;
  v_payload jsonb;
  v_rule text;
  v_label text;
  v_ref uuid;
  v_id uuid;
BEGIN
  PERFORM public.assert_business_type('production');
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_perm := public.prod_approval_rpc_perm(p_rpc);
  IF v_perm IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'rpc';
  END IF;
  IF NOT public.has_permission(v_perm) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR pg_column_size(p_payload) > 262144 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'payload';
  END IF;
  v_payload := p_payload - 'override' - 'override_note';

  IF p_rpc IN ('prod_record_milk_lab', 'prod_amend_milk_lab') THEN
    IF jsonb_typeof(v_payload->'lab') IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_payload->'intake_id') IS DISTINCT FROM 'string'
       OR (v_payload->>'intake_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'payload';
    END IF;
    v_ref := (v_payload->>'intake_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.prod_milk_intakes WHERE id = v_ref AND company_id = v_company_id) THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    v_payload := jsonb_build_object('intake_id', v_ref, 'lab', (v_payload->'lab') - 'override' - 'override_note');
  ELSIF p_rpc = 'prod_post_stock_count' THEN
    IF jsonb_typeof(v_payload->'id') IS DISTINCT FROM 'string'
       OR (v_payload->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'payload';
    END IF;
    v_ref := (v_payload->>'id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.prod_stock_counts WHERE id = v_ref AND company_id = v_company_id) THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    v_payload := jsonb_build_object('id', v_ref);
  ELSIF jsonb_typeof(v_payload->'lab') = 'object' THEN
    IF p_rpc = 'prod_create_milk_intake' AND NOT public.has_permission('prod_lab') THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
    v_payload := jsonb_set(v_payload, '{lab}', (v_payload->'lab') - 'override' - 'override_note');
  END IF;

  v_rule := NULLIF(btrim(p_rule), '');
  IF v_rule IS NOT NULL AND length(v_rule) > 50 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'rule';
  END IF;
  v_label := btrim(p_label);
  IF v_label IS NULL OR length(v_label) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'label';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_approval_req:' || v_uid::text, 0));

  SELECT id INTO v_id
  FROM public.prod_approval_requests
  WHERE company_id = v_company_id AND requested_by = v_uid AND status = 'pending'
    AND rpc_name = p_rpc AND payload = v_payload
  LIMIT 1;
  IF FOUND THEN
    RETURN v_id;
  END IF;

  IF (SELECT count(*) FROM public.prod_approval_requests
      WHERE company_id = v_company_id AND requested_by = v_uid AND status = 'pending') >= 50 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'too_many_pending';
  END IF;

  INSERT INTO public.prod_approval_requests (
    company_id, requested_by, requested_by_name, rpc_name, payload, rule, doc_label
  ) VALUES (
    v_company_id, v_uid, (SELECT u.full_name FROM public.users u WHERE u.id = v_uid),
    p_rpc, v_payload, v_rule, v_label
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ═══ prod_decide_approval (new) ══════════════════════════════════════════
-- Owner / admin of the request's company who also holds the target RPC's
-- permission. An admin may not decide their own request (the owner may).
-- Approve (note 5..500): the stored RPC is called from here, in the SAME
-- session, so auth.uid() / prod_ctl_role() / has_permission() inside it are
-- the APPROVER's (SECURITY DEFINER changes current_user, not the JWT
-- claims): created_by of the document and the 17 'override' audit row are
-- the approver, override_note = the decision note. The call runs in a
-- sub-transaction: an error rolls back only the document, the request
-- becomes 'failed' with error = SQLERRM, error_detail = DETAIL, and this
-- function returns normally. Reject: status only (note optional).
-- Lock: request row FOR UPDATE -> the target RPC's own lock order.
CREATE OR REPLACE FUNCTION public.prod_decide_approval(p_id uuid, p_approve boolean, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_uid uuid := auth.uid();
  v_role text;
  v_req public.prod_approval_requests%ROWTYPE;
  v_perm text;
  v_note text;
  v_ctl jsonb;
  v_res jsonb;
  v_uuid uuid;
  v_err text;
  v_det text;
  v_status text;
  v_name text;
BEGIN
  PERFORM public.assert_business_type('production');
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_role := public.prod_ctl_role();
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_id IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT * INTO v_req
  FROM public.prod_approval_requests
  WHERE id = p_id AND company_id = v_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'not_pending';
  END IF;
  IF v_req.requested_by = v_uid AND v_role <> 'owner' THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'self_approve';
  END IF;
  v_perm := public.prod_approval_rpc_perm(v_req.rpc_name);
  IF v_perm IS NULL OR NOT public.has_permission(v_perm) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_note := NULLIF(btrim(p_note), '');
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'decision_note';
  END IF;
  SELECT u.full_name INTO v_name FROM public.users u WHERE u.id = v_uid;

  IF NOT p_approve THEN
    UPDATE public.prod_approval_requests
    SET status = 'rejected', decided_by = v_uid, decided_by_name = v_name, decided_at = now(),
        decision_note = v_note
    WHERE id = p_id AND company_id = v_company_id;
    RETURN jsonb_build_object('id', p_id, 'status', 'rejected', 'result', NULL, 'error', NULL, 'error_detail', NULL);
  END IF;

  IF v_note IS NULL OR char_length(v_note) < 5 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'decision_note';
  END IF;
  v_ctl := jsonb_build_object('override', true, 'override_note', v_note);

  BEGIN
    CASE v_req.rpc_name
      WHEN 'prod_record_milk_lab', 'prod_amend_milk_lab' THEN
        EXECUTE format('SELECT to_jsonb(public.%I($1, $2))', v_req.rpc_name)
          INTO v_res
          USING (v_req.payload->>'intake_id')::uuid, (v_req.payload->'lab') || v_ctl;
      WHEN 'prod_post_stock_count' THEN
        EXECUTE 'SELECT to_jsonb(public.prod_post_stock_count($1, $2))'
          INTO v_res
          USING (v_req.payload->>'id')::uuid, v_ctl;
      WHEN 'supply_add_move' THEN
        EXECUTE 'SELECT public.supply_add_move($1)'
          INTO v_uuid
          USING v_req.payload || v_ctl;
        v_res := jsonb_build_object('id', v_uuid);
      ELSE
        EXECUTE format('SELECT to_jsonb(public.%I($1))', v_req.rpc_name)
          INTO v_res
          USING v_req.payload || v_ctl;
    END CASE;
    v_status := 'approved';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL;
      v_status := 'failed';
      v_res := NULL;
      v_err := left(COALESCE(NULLIF(v_err, ''), 'error'), 1000);
      v_det := left(NULLIF(v_det, ''), 1000);
  END;

  UPDATE public.prod_approval_requests
  SET status = v_status, decided_by = v_uid, decided_by_name = v_name, decided_at = now(),
      decision_note = v_note, result = v_res,
      error = CASE WHEN v_status = 'failed' THEN v_err END,
      error_detail = CASE WHEN v_status = 'failed' THEN v_det END
  WHERE id = p_id AND company_id = v_company_id;

  RETURN jsonb_build_object(
    'id', p_id, 'status', v_status, 'result', v_res,
    'error', CASE WHEN v_status = 'failed' THEN v_err END,
    'error_detail', CASE WHEN v_status = 'failed' THEN v_det END
  );
END;
$$;

-- ═══ prod_withdraw_approval (new) ════════════════════════════════════════
-- The requester only (another user's / company's request -> 'not_found'),
-- while pending. No module permission: withdrawing only ends the caller's
-- own request (works even after the permission was taken away).
CREATE OR REPLACE FUNCTION public.prod_withdraw_approval(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_uid uuid := auth.uid();
  v_status text;
BEGIN
  PERFORM public.assert_business_type('production');
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  SELECT status INTO v_status
  FROM public.prod_approval_requests
  WHERE id = p_id AND company_id = v_company_id AND requested_by = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'not_pending';
  END IF;

  UPDATE public.prod_approval_requests
  SET status = 'withdrawn', decided_at = now()
  WHERE id = p_id AND company_id = v_company_id;
END;
$$;

-- ─── 4) Notifications (computed, no table) ────────────────────────────────

-- One notification entry (internal).
CREATE OR REPLACE FUNCTION public.prod_notif_entry(
  p_kind text, p_severity text, p_count bigint, p_href text, p_sample jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'kind', p_kind, 'severity', p_severity, 'count', p_count,
    'title_key', 'prodUx.notif.' || p_kind, 'href', p_href,
    'sample', COALESCE(p_sample, '[]'::jsonb)
  )
$$;

REVOKE EXECUTE ON FUNCTION public.prod_notif_entry(text, text, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ═══ prod_notifications (new) ════════════════════════════════════════════
-- For the CALLER: jsonb array of { kind, severity, count, title_key, href,
-- sample (<= 3 labels) }, only kinds with count > 0 and only those the
-- caller may see (per-kind has_permission; approvals: role). Not a
-- production-enabled company -> []. Read-only, no locks. Each kind is one
-- indexed query on the caller's company:
--   pending_lab        prod_lab        milk intakes status 'weighed'
--   expired_lots       prod_stock      lots remaining > 0, expiry < today
--   expiring_lots      prod_stock      today <= expiry <= today +
--                                      COALESCE(item.expiry_warn_days, 3)
--   low_stock          prod_stock      active items with min_stock, stock
--                                      (all warehouses) < min_stock
--   stock_count_drafts prod_stock      stock counts status 'draft'
--   overdue_customers  prod_sales      overdue open amount > 0 (= the
--                                      prod_customer_ageing overdue buckets:
--                                      sum(posted sales due < today) -
--                                      posted payments - posted returns)
--   overdue_suppliers  prod_suppliers  same with receipts (+ corrections)
--                                      and supplier payments
--   pending_approvals  owner / admin   pending requests the caller can
--                                      decide (target permission; an admin
--                                      never decides their own)
--   my_requests        any             own requests decided in the last 7
--                                      days and after prefs.requests_seen_at
-- today = Asia/Tashkent business date.
CREATE OR REPLACE FUNCTION public.prod_notifications()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_uid uuid := auth.uid();
  v_role text;
  v_today date;
  v_out jsonb := '[]'::jsonb;
  v_n bigint;
  v_bad bigint;
  v_sample jsonb;
  v_perms text[];
  v_seen timestamptz;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL OR v_uid IS NULL OR NOT public.production_enabled() THEN
    RETURN '[]'::jsonb;
  END IF;
  v_role := public.prod_ctl_role();
  v_today := public.prod_biz_date(now());

  IF public.has_permission('prod_lab') THEN
    SELECT count(*) INTO v_n FROM public.prod_milk_intakes
    WHERE company_id = v_company_id AND status = 'weighed';
    IF v_n > 0 THEN
      SELECT jsonb_agg(x.lbl ORDER BY x.intake_date, x.number) INTO v_sample
      FROM (
        SELECT '#' || mi.number || ' ' || COALESCE(s.name, '') || ' ' || trim_scale(mi.net_kg)::text || ' kg' AS lbl,
               mi.intake_date, mi.number
        FROM public.prod_milk_intakes mi
        LEFT JOIN public.prod_suppliers s ON s.id = mi.supplier_id AND s.company_id = mi.company_id
        WHERE mi.company_id = v_company_id AND mi.status = 'weighed'
        ORDER BY mi.intake_date, mi.number
        LIMIT 3
      ) x;
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('pending_lab', 'warn', v_n, '/sut-qabuli?status=weighed', v_sample));
    END IF;
  END IF;

  IF public.has_permission('prod_stock') THEN
    -- Lots with an expiry date up to a year ahead; remaining via the
    -- (lot_id, company_id) INCLUDE (qty) index.
    WITH c AS (
      SELECT l.id, l.lot_no, l.expiry_date, i.name AS item_name,
             l.expiry_date < v_today AS expired,
             l.expiry_date <= v_today + COALESCE(i.expiry_warn_days, 3) AS soon
      FROM public.prod_lots l
      JOIN public.prod_items i ON i.id = l.item_id AND i.company_id = l.company_id
      WHERE l.company_id = v_company_id AND l.expiry_date IS NOT NULL AND l.expiry_date <= v_today + 365
    ), r AS (
      SELECT c.*
      FROM c
      WHERE c.soon
        AND (SELECT l2.opening_qty FROM public.prod_lots l2 WHERE l2.id = c.id)
            + COALESCE((SELECT sum(m.qty) FROM public.prod_stock_movements m
                        WHERE m.lot_id = c.id AND m.company_id = v_company_id), 0) > 0
    )
    SELECT jsonb_build_object(
      'expired_n', count(*) FILTER (WHERE r.expired),
      'soon_n', count(*) FILTER (WHERE NOT r.expired),
      'expired_s', (SELECT jsonb_agg(z.lbl) FROM (
          SELECT r2.lot_no || ' ' || r2.item_name || ' (' || r2.expiry_date || ')' AS lbl FROM r r2
          WHERE r2.expired ORDER BY r2.expiry_date, r2.lot_no LIMIT 3) z),
      'soon_s', (SELECT jsonb_agg(z.lbl) FROM (
          SELECT r2.lot_no || ' ' || r2.item_name || ' (' || r2.expiry_date || ')' AS lbl FROM r r2
          WHERE NOT r2.expired ORDER BY r2.expiry_date, r2.lot_no LIMIT 3) z))
    INTO v_sample
    FROM r;
    IF (v_sample->>'expired_n')::bigint > 0 THEN
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('expired_lots', 'danger',
        (v_sample->>'expired_n')::bigint, '/zavod-qoldiq?expiry=expired', v_sample->'expired_s'));
    END IF;
    IF (v_sample->>'soon_n')::bigint > 0 THEN
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('expiring_lots', 'warn',
        (v_sample->>'soon_n')::bigint, '/zavod-qoldiq?expiry=soon', v_sample->'soon_s'));
    END IF;

    WITH s AS (
      SELECT i.id, i.name, i.unit, i.min_stock,
             COALESCE((SELECT sum(l.opening_qty) FROM public.prod_lots l
                       WHERE l.item_id = i.id AND l.company_id = v_company_id), 0)
             + COALESCE((SELECT sum(m.qty) FROM public.prod_stock_movements m
                         WHERE m.item_id = i.id AND m.company_id = v_company_id AND m.lot_id IS NOT NULL), 0) AS qty
      FROM public.prod_items i
      WHERE i.company_id = v_company_id AND i.min_stock IS NOT NULL AND i.is_active
    ), low AS (
      SELECT * FROM s WHERE s.qty < s.min_stock
    )
    SELECT count(*),
           (SELECT jsonb_agg(z.lbl) FROM (
              SELECT l2.name || ' ' || trim_scale(round(l2.qty, 3))::text || ' / ' || trim_scale(l2.min_stock)::text
                     || ' ' || l2.unit AS lbl
              FROM low l2 ORDER BY (l2.qty / NULLIF(l2.min_stock, 0)) NULLS FIRST, l2.name LIMIT 3) z)
    INTO v_n, v_sample
    FROM low;
    IF v_n > 0 THEN
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('low_stock', 'warn', v_n, '/zavod-qoldiq?low=1', v_sample));
    END IF;

    SELECT count(*) INTO v_n FROM public.prod_stock_counts
    WHERE company_id = v_company_id AND status = 'draft';
    IF v_n > 0 THEN
      SELECT jsonb_agg(z.lbl) INTO v_sample FROM (
        SELECT '#' || sc.number || ' ' || public.prod_biz_date(sc.doc_date)::text AS lbl
        FROM public.prod_stock_counts sc
        WHERE sc.company_id = v_company_id AND sc.status = 'draft'
        ORDER BY sc.doc_date, sc.number LIMIT 3) z;
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('stock_count_drafts', 'info', v_n,
        '/zavod-inventarizatsiya?status=draft', v_sample));
    END IF;
  END IF;

  IF public.has_permission('prod_sales') THEN
    WITH ch AS (
      SELECT s.customer_id, sum(s.total) AS overdue_charged
      FROM public.prod_sales s
      WHERE s.company_id = v_company_id AND s.status = 'posted'
        AND COALESCE(s.due_date, public.prod_biz_date(s.doc_date)) < v_today
      GROUP BY s.customer_id
    ), cr AS (
      SELECT x.customer_id, sum(x.amount) AS credited
      FROM (
        SELECT p.customer_id, p.amount FROM public.prod_customer_payments p
        WHERE p.company_id = v_company_id AND p.status = 'posted'
        UNION ALL
        SELECT r.customer_id, r.total FROM public.prod_sale_returns r
        WHERE r.company_id = v_company_id AND r.status = 'posted'
      ) x
      GROUP BY x.customer_id
    ), od AS (
      SELECT ch.customer_id, c.name, ch.overdue_charged - COALESCE(cr.credited, 0) AS amount
      FROM ch
      JOIN public.prod_customers c ON c.id = ch.customer_id AND c.company_id = v_company_id
      LEFT JOIN cr ON cr.customer_id = ch.customer_id
      WHERE ch.overdue_charged - COALESCE(cr.credited, 0) > 0
    )
    SELECT count(*),
           (SELECT jsonb_agg(z.lbl) FROM (
              SELECT o2.name || ' ' || round(o2.amount)::text AS lbl FROM od o2
              ORDER BY o2.amount DESC, o2.name LIMIT 3) z)
    INTO v_n, v_sample
    FROM od;
    IF v_n > 0 THEN
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('overdue_customers', 'warn', v_n,
        '/zavod-mijozlar?overdue=1', v_sample));
    END IF;
  END IF;

  IF public.has_permission('prod_suppliers') THEN
    WITH corr AS (
      SELECT pc.receipt_id, sum(pc.debt_delta) AS delta
      FROM public.prod_price_corrections pc
      WHERE pc.company_id = v_company_id AND pc.status = 'posted'
      GROUP BY pc.receipt_id
    ), ch AS (
      SELECT r.supplier_id, sum(r.total + COALESCE(corr.delta, 0)) AS overdue_charged
      FROM public.prod_receipts r
      LEFT JOIN corr ON corr.receipt_id = r.id
      WHERE r.company_id = v_company_id AND r.status = 'posted' AND r.supplier_id IS NOT NULL
        AND COALESCE(r.due_date, public.prod_biz_date(r.doc_date)) < v_today
      GROUP BY r.supplier_id
    ), pay AS (
      SELECT sp.supplier_id, sum(sp.amount) AS paid
      FROM public.prod_supplier_payments sp
      WHERE sp.company_id = v_company_id AND sp.status = 'posted'
      GROUP BY sp.supplier_id
    ), od AS (
      SELECT ch.supplier_id, s.name, ch.overdue_charged - COALESCE(pay.paid, 0) AS amount
      FROM ch
      JOIN public.prod_suppliers s ON s.id = ch.supplier_id AND s.company_id = v_company_id
      LEFT JOIN pay ON pay.supplier_id = ch.supplier_id
      WHERE ch.overdue_charged - COALESCE(pay.paid, 0) > 0
    )
    SELECT count(*),
           (SELECT jsonb_agg(z.lbl) FROM (
              SELECT o2.name || ' ' || round(o2.amount)::text AS lbl FROM od o2
              ORDER BY o2.amount DESC, o2.name LIMIT 3) z)
    INTO v_n, v_sample
    FROM od;
    IF v_n > 0 THEN
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('overdue_suppliers', 'warn', v_n,
        '/zavod-yetkazuvchilar?overdue=1', v_sample));
    END IF;
  END IF;

  IF v_role IN ('owner', 'admin') THEN
    SELECT COALESCE(array_agg(k), '{}') INTO v_perms
    FROM unnest(ARRAY['prod_receipts', 'prod_milk', 'prod_lab', 'prod_production', 'prod_processing',
                      'prod_stock', 'prod_sales', 'prod_customer_payments', 'prod_suppliers', 'prod_cash',
                      'prod_supply']) AS t(k)
    WHERE public.has_permission(k);
    WITH p AS (
      SELECT ar.doc_label, ar.created_at
      FROM public.prod_approval_requests ar
      WHERE ar.company_id = v_company_id AND ar.status = 'pending'
        AND (v_role = 'owner' OR ar.requested_by <> v_uid)
        AND public.prod_approval_rpc_perm(ar.rpc_name) = ANY (v_perms)
    )
    SELECT count(*),
           (SELECT jsonb_agg(z.doc_label) FROM (SELECT p2.doc_label FROM p p2 ORDER BY p2.created_at LIMIT 3) z)
    INTO v_n, v_sample
    FROM p;
    IF v_n > 0 THEN
      v_out := v_out || jsonb_build_array(public.prod_notif_entry('pending_approvals', 'warn', v_n,
        '/zavod-tasdiqlar', v_sample));
    END IF;
  END IF;

  SELECT up.requests_seen_at INTO v_seen FROM public.prod_user_prefs up WHERE up.user_id = v_uid;
  WITH m AS (
    SELECT ar.doc_label, ar.status, ar.decided_at
    FROM public.prod_approval_requests ar
    WHERE ar.requested_by = v_uid AND ar.company_id = v_company_id
      AND ar.status IN ('approved', 'rejected', 'failed')
      AND ar.decided_at > GREATEST(now() - interval '7 days', COALESCE(v_seen, '-infinity'::timestamptz))
  )
  SELECT count(*), count(*) FILTER (WHERE m.status <> 'approved'),
         (SELECT jsonb_agg(z.lbl) FROM (
            SELECT m2.doc_label || ': ' || m2.status AS lbl FROM m m2 ORDER BY m2.decided_at DESC LIMIT 3) z)
  INTO v_n, v_bad, v_sample
  FROM m;
  IF v_n > 0 THEN
    v_out := v_out || jsonb_build_array(public.prod_notif_entry('my_requests',
      CASE WHEN v_bad > 0 THEN 'danger' ELSE 'info' END, v_n, '/zavod-tasdiqlar?tab=mine', v_sample));
  END IF;

  RETURN v_out;
END;
$$;

-- ─── 5) User preferences ──────────────────────────────────────────────────
-- No module permission (deliberate): the data is the caller's own UI state
-- keyed by auth.uid(); the company comes from get_company_id() (NULL ->
-- 'forbidden'). Works for retail users too.

-- Validated href list (internal): array of strings starting with '/',
-- each <= 200 chars, at most p_max, duplicates removed (first kept).
CREATE OR REPLACE FUNCTION public.prod_prefs_hrefs(p_val jsonb, p_max integer, p_key text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_out text[] := '{}';
  v_el jsonb;
  v_txt text;
BEGIN
  IF p_val IS NULL OR jsonb_typeof(p_val) = 'null' THEN
    RETURN '{}'::text[];
  END IF;
  IF jsonb_typeof(p_val) <> 'array' THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = p_key;
  END IF;
  FOR v_el IN SELECT * FROM jsonb_array_elements(p_val)
  LOOP
    IF jsonb_typeof(v_el) <> 'string' THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = p_key;
    END IF;
    v_txt := btrim(v_el #>> '{}');
    IF v_txt = '' OR left(v_txt, 1) <> '/' OR length(v_txt) > 200 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = p_key;
    END IF;
    IF NOT (v_txt = ANY (v_out)) THEN
      v_out := v_out || v_txt;
    END IF;
  END LOOP;
  IF cardinality(v_out) > p_max THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = p_key;
  END IF;
  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_prefs_hrefs(jsonb, integer, text) FROM PUBLIC, anon, authenticated;

-- ═══ prod_get_user_prefs (new) ═══════════════════════════════════════════
-- { home, favorites, hidden_menu, tablet_mode, requests_seen_at, updated_at };
-- defaults when the caller has no row yet.
CREATE OR REPLACE FUNCTION public.prod_get_user_prefs()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_uid uuid := auth.uid();
  v_row public.prod_user_prefs%ROWTYPE;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT * INTO v_row FROM public.prod_user_prefs WHERE user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('home', NULL, 'favorites', '[]'::jsonb, 'hidden_menu', '[]'::jsonb,
                              'tablet_mode', false, 'requests_seen_at', NULL, 'updated_at', NULL);
  END IF;
  RETURN jsonb_build_object('home', v_row.home, 'favorites', to_jsonb(v_row.favorites),
                            'hidden_menu', to_jsonb(v_row.hidden_menu), 'tablet_mode', v_row.tablet_mode,
                            'requests_seen_at', v_row.requests_seen_at, 'updated_at', v_row.updated_at);
END;
$$;

-- ═══ prod_save_user_prefs (new) ══════════════════════════════════════════
-- p_data: any subset of { home, favorites, hidden_menu, tablet_mode,
-- requests_seen (true -> requests_seen_at = now()) }; absent key =
-- unchanged, null = default; unknown key -> invalid_input DETAIL key.
-- Single-statement upsert (ON CONFLICT (user_id)). Returns
-- prod_get_user_prefs().
CREATE OR REPLACE FUNCTION public.prod_save_user_prefs(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_uid uuid := auth.uid();
  v_key text;
  v_home text;
  v_fav text[];
  v_hidden text[];
  v_tablet boolean;
  v_seen boolean;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_data)
  LOOP
    IF v_key NOT IN ('home', 'favorites', 'hidden_menu', 'tablet_mode', 'requests_seen') THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = v_key;
    END IF;
  END LOOP;

  IF p_data ? 'home' THEN
    IF jsonb_typeof(p_data->'home') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'home';
    END IF;
    v_home := NULLIF(btrim(p_data->>'home'), '');
    IF v_home IS NOT NULL AND v_home NOT IN ('auto', 'dashboard', 'milk', 'lab', 'stock', 'sales', 'cash') THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'home';
    END IF;
  END IF;
  IF p_data ? 'favorites' THEN
    v_fav := public.prod_prefs_hrefs(p_data->'favorites', 12, 'favorites');
  END IF;
  IF p_data ? 'hidden_menu' THEN
    v_hidden := public.prod_prefs_hrefs(p_data->'hidden_menu', 100, 'hidden_menu');
  END IF;
  IF p_data ? 'tablet_mode' THEN
    IF jsonb_typeof(p_data->'tablet_mode') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'tablet_mode';
    END IF;
    v_tablet := COALESCE((p_data->>'tablet_mode')::boolean, false);
  END IF;
  IF p_data ? 'requests_seen' THEN
    IF jsonb_typeof(p_data->'requests_seen') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'requests_seen';
    END IF;
    v_seen := COALESCE((p_data->>'requests_seen')::boolean, false);
  END IF;

  INSERT INTO public.prod_user_prefs AS up (user_id, company_id, home, favorites, hidden_menu, tablet_mode,
                                            requests_seen_at, updated_at)
  VALUES (v_uid, v_company_id, v_home, COALESCE(v_fav, '{}'), COALESCE(v_hidden, '{}'), COALESCE(v_tablet, false),
          CASE WHEN v_seen THEN now() END, now())
  ON CONFLICT (user_id) DO UPDATE
  SET company_id = EXCLUDED.company_id,
      home = CASE WHEN p_data ? 'home' THEN EXCLUDED.home ELSE up.home END,
      favorites = CASE WHEN p_data ? 'favorites' THEN EXCLUDED.favorites ELSE up.favorites END,
      hidden_menu = CASE WHEN p_data ? 'hidden_menu' THEN EXCLUDED.hidden_menu ELSE up.hidden_menu END,
      tablet_mode = CASE WHEN p_data ? 'tablet_mode' THEN EXCLUDED.tablet_mode ELSE up.tablet_mode END,
      requests_seen_at = CASE WHEN v_seen THEN now() ELSE up.requests_seen_at END,
      updated_at = now();

  RETURN public.prod_get_user_prefs();
END;
$$;

-- ─── 6) Onboarding status ─────────────────────────────────────────────────
-- ═══ prod_onboarding_status (new) ════════════════════════════════════════
-- Owner / admin (role) with has_permission('sozlamalar') (setup = settings;
-- same shared key as the 17 / 18 settings RPCs). Counts are active rows of
-- the caller's company; staff = active users other than the owner;
-- milk_settings = milk_item_id set; cash_opening_set = an account with
-- opening_balance <> 0 or any cash movement; accounting_set /
-- controls_reviewed = the settings row was saved by a user (updated_by set;
-- the seeded rows have NULL). steps_done counts true / > 0 entries of the
-- 11 steps.
CREATE OR REPLACE FUNCTION public.prod_onboarding_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_r jsonb;
  v_done integer;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('sozlamalar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF COALESCE(public.prod_ctl_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_r := jsonb_build_object(
    'warehouses', EXISTS (SELECT 1 FROM public.prod_warehouses WHERE company_id = v_company_id AND is_active),
    'items', (SELECT count(*) FROM public.prod_items WHERE company_id = v_company_id AND is_active),
    'recipes', (SELECT count(*) FROM public.prod_recipes WHERE company_id = v_company_id AND is_active),
    'milk_settings', EXISTS (SELECT 1 FROM public.prod_milk_settings
                             WHERE company_id = v_company_id AND milk_item_id IS NOT NULL),
    'suppliers', (SELECT count(*) FROM public.prod_suppliers WHERE company_id = v_company_id AND is_active),
    'customers', (SELECT count(*) FROM public.prod_customers WHERE company_id = v_company_id AND is_active),
    'price_lists', (SELECT count(*) FROM public.prod_price_lists WHERE company_id = v_company_id AND is_active),
    'cash_opening_set', EXISTS (SELECT 1 FROM public.prod_cash_accounts
                                WHERE company_id = v_company_id AND opening_balance <> 0)
                        OR EXISTS (SELECT 1 FROM public.prod_cash_movements WHERE company_id = v_company_id),
    'staff', (SELECT count(*) FROM public.users u
              WHERE u.company_id = v_company_id AND u.role IS DISTINCT FROM 'owner'
                AND COALESCE(u.status, 'active') = 'active'),
    'accounting_set', EXISTS (SELECT 1 FROM public.prod_company_accounting
                              WHERE company_id = v_company_id AND updated_by IS NOT NULL),
    'controls_reviewed', EXISTS (SELECT 1 FROM public.prod_control_settings
                                 WHERE company_id = v_company_id AND updated_by IS NOT NULL)
  );
  SELECT count(*) INTO v_done
  FROM jsonb_each(v_r) e
  WHERE (jsonb_typeof(e.value) = 'boolean' AND e.value = 'true'::jsonb)
     OR (jsonb_typeof(e.value) = 'number' AND (e.value #>> '{}')::numeric > 0);
  RETURN v_r || jsonb_build_object('steps_done', v_done, 'steps_total', 11);
END;
$$;

-- ─── 7) Repeat last sale ──────────────────────────────────────────────────
-- ═══ prod_last_sale_lines (new) ══════════════════════════════════════════
-- prod_sales. The customer's newest POSTED sale (doc_date, number) ->
-- { sale_id, number, sale_date (business date), warehouse_id,
-- price_list_id, lines: [{ item_id, item_name, unit, qty, price,
-- current_price }] } or NULL when there is none. current_price = the
-- prod_item_prices resolution for the customer's price list (list ->
-- default active list -> item.sale_price), informative only: prod_create_sale
-- prices server-side. Unknown / other company's customer -> 'not_found'.
CREATE OR REPLACE FUNCTION public.prod_last_sale_lines(p_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_pl uuid;
  v_sale public.prod_sales%ROWTYPE;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_sales') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_customer IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT price_list_id INTO v_pl FROM public.prod_customers WHERE id = p_customer AND company_id = v_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_sale
  FROM public.prod_sales
  WHERE company_id = v_company_id AND customer_id = p_customer AND status = 'posted'
  ORDER BY doc_date DESC, number DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'sale_id', v_sale.id, 'number', v_sale.number, 'sale_date', public.prod_biz_date(v_sale.doc_date),
    'warehouse_id', v_sale.warehouse_id, 'price_list_id', v_sale.price_list_id,
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'item_id', si.item_id, 'item_name', i.name, 'unit', si.unit, 'qty', si.qty, 'price', si.price,
        'current_price', COALESCE(
          (SELECT pli.price FROM public.prod_price_list_items pli
            JOIN public.prod_price_lists pl ON pl.id = pli.price_list_id AND pl.company_id = pli.company_id
           WHERE pli.price_list_id = v_pl AND pli.item_id = si.item_id AND pli.company_id = v_company_id
             AND pl.is_active),
          (SELECT dli.price FROM public.prod_price_lists dl
            JOIN public.prod_price_list_items dli ON dli.price_list_id = dl.id AND dli.company_id = dl.company_id
           WHERE dl.company_id = v_company_id AND dl.is_default AND dl.is_active AND dli.item_id = si.item_id),
          i.sale_price)
      ) ORDER BY si.sort_order, si.id)
      FROM public.prod_sale_items si
      JOIN public.prod_items i ON i.id = si.item_id AND i.company_id = si.company_id
      WHERE si.sale_id = v_sale.id AND si.company_id = v_company_id
    ), '[]'::jsonb)
  );
END;
$$;

-- ─── 8) Daily production plan ─────────────────────────────────────────────

-- ═══ prod_plan_requirements (new) ════════════════════════════════════════
-- prod_production. Lines of p_date (sort_order) + per material the recipe
-- components of the 'planned' lines scaled by planned_qty /
-- recipe.output_qty, summed, vs available = remaining of FREE lots
-- (hold_status 'free', expiry NULL or >= p_date, remaining > 0) in all
-- warehouses or p_warehouse_id (another company's -> 'not_found');
-- shortage = max(required - available, 0). Lines without a recipe add no
-- material. produced_qty = output_qty of the line's posted production.
CREATE OR REPLACE FUNCTION public.prod_plan_requirements(p_date date, p_warehouse_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_lines jsonb;
  v_mats jsonb;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_production') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'date';
  END IF;
  IF p_warehouse_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.prod_warehouses WHERE id = p_warehouse_id AND company_id = v_company_id) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id, 'item_id', p.item_id, 'item_name', i.name, 'unit', i.unit, 'planned_qty', p.planned_qty,
      'recipe_id', p.recipe_id, 'recipe_version', r.version, 'recipe_output_qty', r.output_qty,
      'status', p.status, 'production_id', p.production_id, 'note', p.note,
      'produced_qty', pr.output_qty
    ) ORDER BY p.sort_order, p.created_at, p.id), '[]'::jsonb)
  INTO v_lines
  FROM public.prod_production_plans p
  JOIN public.prod_items i ON i.id = p.item_id AND i.company_id = p.company_id
  LEFT JOIN public.prod_recipes r ON r.id = p.recipe_id AND r.company_id = p.company_id
  LEFT JOIN public.prod_productions pr ON pr.id = p.production_id AND pr.company_id = p.company_id
                                       AND pr.status = 'posted'
  WHERE p.company_id = v_company_id AND p.plan_date = p_date;

  WITH req AS (
    SELECT rl.item_id, sum(rl.qty * p.planned_qty / r.output_qty) AS required
    FROM public.prod_production_plans p
    JOIN public.prod_recipes r ON r.id = p.recipe_id AND r.company_id = p.company_id
    JOIN public.prod_recipe_lines rl ON rl.recipe_id = r.id AND rl.company_id = r.company_id
    WHERE p.company_id = v_company_id AND p.plan_date = p_date AND p.status = 'planned' AND r.output_qty > 0
    GROUP BY rl.item_id
  ), av AS (
    SELECT l.item_id,
           sum(GREATEST(l.opening_qty + COALESCE((SELECT sum(m.qty) FROM public.prod_stock_movements m
                                                  WHERE m.lot_id = l.id AND m.company_id = v_company_id), 0), 0))
             AS available
    FROM public.prod_lots l
    WHERE l.company_id = v_company_id
      AND l.item_id IN (SELECT req.item_id FROM req)
      AND l.hold_status = 'free'
      AND (l.expiry_date IS NULL OR l.expiry_date >= p_date)
      AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
    GROUP BY l.item_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'item_id', req.item_id, 'item_name', i.name, 'unit', i.unit,
      'required', round(req.required, 3), 'available', round(COALESCE(av.available, 0), 3),
      'shortage', round(GREATEST(req.required - COALESCE(av.available, 0), 0), 3)
    ) ORDER BY (req.required > COALESCE(av.available, 0)) DESC, i.name), '[]'::jsonb)
  INTO v_mats
  FROM req
  JOIN public.prod_items i ON i.id = req.item_id AND i.company_id = v_company_id
  LEFT JOIN av ON av.item_id = req.item_id;

  RETURN jsonb_build_object('date', p_date, 'lines', v_lines, 'materials', v_mats);
END;
$$;

-- ═══ prod_save_plan (new) ════════════════════════════════════════════════
-- prod_production. p_lines (array, <= 200) REPLACES the date's planned /
-- skipped lines: { id?, item_id, planned_qty > 0, recipe_id?, status?
-- ('planned' | 'skipped', default planned), note? (<= 500) }. With id ->
-- update (id of another company / date -> 'not_found'); without -> insert;
-- planned / skipped lines of the date not in the array -> deleted. Done
-- lines stay; a done line may be echoed back unchanged (same item_id and
-- planned_qty; skipped) but not edited (invalid_input DETAIL 'plan_done').
-- item: this company's, active, finished / semi (DETAIL 'item'); recipe:
-- of that item (DETAIL 'recipe'); NULL -> the item's active recipe (may
-- stay NULL). |p_date - today| > 366 -> DETAIL 'date'. sort_order = array
-- position. Lock: advisory 'prod_plan:<company>:<date>' -> the date's plan
-- rows FOR UPDATE (prod_create_production locks one plan row FOR UPDATE and
-- never takes the advisory lock: no cycle). Returns prod_plan_requirements.
CREATE OR REPLACE FUNCTION public.prod_save_plan(p_date date, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_uid uuid := auth.uid();
  v_line jsonb;
  v_pos integer := 0;
  v_id uuid;
  v_item uuid;
  v_qty numeric;
  v_recipe uuid;
  v_status text;
  v_note text;
  v_keep uuid[] := '{}';
  v_old public.prod_production_plans%ROWTYPE;
  v_type text;
  v_active boolean;
BEGIN
  PERFORM public.assert_business_type('production');
  IF NOT public.has_permission('prod_production') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_date IS NULL OR abs(p_date - public.prod_biz_date(now())) > 366 THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'date';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) > 200 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_plan:' || v_company_id::text || ':' || p_date::text, 0));
  PERFORM 1 FROM public.prod_production_plans
  WHERE company_id = v_company_id AND plan_date = p_date
  ORDER BY id
  FOR UPDATE;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    IF jsonb_typeof(v_line) <> 'object' THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_id := public.prod_juuid(v_line, 'id');
    v_item := public.prod_juuid(v_line, 'item_id');
    v_qty := public.prod_jnum(v_line, 'planned_qty', 3);
    v_recipe := public.prod_juuid(v_line, 'recipe_id');
    v_status := COALESCE(public.prod_jtext(v_line, 'status', 20), 'planned');
    v_note := public.prod_jtext(v_line, 'note', 500);
    IF v_item IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF v_id IS NOT NULL AND v_id = ANY (v_keep) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;

    IF v_id IS NOT NULL THEN
      SELECT * INTO v_old FROM public.prod_production_plans
      WHERE id = v_id AND company_id = v_company_id AND plan_date = p_date;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'not_found';
      END IF;
      IF v_old.status = 'done' THEN
        IF v_old.item_id <> v_item OR v_old.planned_qty <> v_qty OR v_status NOT IN ('done', 'planned') THEN
          RAISE EXCEPTION 'invalid_input' USING DETAIL = 'plan_done';
        END IF;
        v_keep := v_keep || v_id;
        v_pos := v_pos + 1;
        CONTINUE;
      END IF;
    END IF;

    IF v_status NOT IN ('planned', 'skipped') THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'status';
    END IF;
    SELECT item_type, is_active INTO v_type, v_active
    FROM public.prod_items WHERE id = v_item AND company_id = v_company_id;
    IF NOT FOUND OR NOT v_active OR v_type NOT IN ('finished', 'semi') THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'item';
    END IF;
    IF v_recipe IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.prod_recipes
                     WHERE id = v_recipe AND company_id = v_company_id AND item_id = v_item) THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'recipe';
      END IF;
    ELSE
      SELECT id INTO v_recipe FROM public.prod_recipes
      WHERE company_id = v_company_id AND item_id = v_item AND is_active
      ORDER BY version DESC LIMIT 1;
    END IF;

    IF v_id IS NOT NULL THEN
      UPDATE public.prod_production_plans
      SET item_id = v_item, planned_qty = v_qty, recipe_id = v_recipe, status = v_status, note = v_note,
          sort_order = LEAST(v_pos, 1000), updated_at = now(), updated_by = v_uid
      WHERE id = v_id AND company_id = v_company_id;
    ELSE
      INSERT INTO public.prod_production_plans (
        company_id, plan_date, item_id, planned_qty, recipe_id, status, note, sort_order,
        created_by, updated_by
      ) VALUES (
        v_company_id, p_date, v_item, v_qty, v_recipe, v_status, v_note, LEAST(v_pos, 1000), v_uid, v_uid
      )
      RETURNING id INTO v_id;
    END IF;
    v_keep := v_keep || v_id;
    v_pos := v_pos + 1;
  END LOOP;

  DELETE FROM public.prod_production_plans
  WHERE company_id = v_company_id AND plan_date = p_date AND status <> 'done'
    AND NOT (id = ANY (v_keep));

  RETURN public.prod_plan_requirements(p_date);
END;
$$;

-- Cancelled production -> its plan line back to 'planned' (fires for
-- prod_cancel_document, the only writer of status 'cancelled').
CREATE OR REPLACE FUNCTION public.prod_plan_on_production_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.prod_production_plans
  SET status = 'planned', production_id = NULL, updated_at = now(), updated_by = auth.uid()
  WHERE production_id = NEW.id AND company_id = NEW.company_id;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prod_plan_on_production_cancel() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER prod_plan_on_production_cancel
  AFTER UPDATE OF status ON public.prod_productions
  FOR EACH ROW
  WHEN (OLD.status = 'posted' AND NEW.status = 'cancelled')
  EXECUTE FUNCTION public.prod_plan_on_production_cancel();

-- ═══ prod_create_production (replaced, same signature) ═══════════════════
-- Body copied from 20261110000018 (latest definition). ONLY additions:
--   * optional p_data.plan_id: the plan line (prod_production_plans) is
--     locked FOR UPDATE right before prod_assert_date; unknown / other
--     company -> 'not_found'; status <> 'planned' -> invalid_input DETAIL
--     'plan_not_open'; item <> the MAIN output item -> invalid_input
--     DETAIL 'plan_item'. After the insert the line becomes 'done' with
--     production_id (the cancel trigger reverts it).
--   * return: + plan_id (NULL when not sent).
-- Lock order: plan row FOR UPDATE -> 17 / 18 order unchanged.
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
  v_hdr_item uuid;
  v_hdr_qty numeric;
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
  v_out_unit text;
  v_out_weight numeric;
  v_out_sale numeric;
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
  v_method text;
  v_o_items uuid[] := '{}';
  v_o_qtys numeric[] := '{}';
  v_o_whs uuid[] := '{}';
  v_o_shares numeric[] := '{}';
  v_o_refs numeric[] := '{}';
  v_o_w numeric[] := '{}';
  v_o_cost numeric[] := '{}';
  v_o_unit numeric[] := '{}';
  v_o_lot uuid;
  v_o_wh uuid;
  v_share numeric;
  v_ref numeric;
  v_w numeric;
  v_w_sum numeric := 0;
  v_alloc numeric := 0;
  v_n integer;
  v_outputs jsonb := '[]'::jsonb;
  v_id uuid;
  v_number integer;
  i integer;
  v_plan_id uuid;
  v_plan_item uuid;
  v_plan_status text;
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
  v_hdr_item := public.prod_juuid(p_data, 'output_item_id');
  v_hdr_qty := public.prod_jnum(p_data, 'output_qty', 3);
  v_note := public.prod_jtext(p_data, 'note', 500);
  v_recipe_id := public.prod_juuid(p_data, 'recipe_id');
  v_method := COALESCE(public.prod_jtext(p_data, 'allocation_method', 20), 'mass');
  v_plan_id := public.prod_juuid(p_data, 'plan_id');
  v_id := gen_random_uuid();
  v_ctl := public.prod_ctl_ctx(p_data, v_biz, 'prod_productions');

  IF v_method NOT IN ('mass', 'value', 'fixed') THEN
    RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocation_method';
  END IF;

  PERFORM public.prod_require_warehouse(v_company_id, v_warehouse_id);
  v_output_warehouse_id := COALESCE(v_output_warehouse_id, v_warehouse_id);

  -- Output list (main first).
  IF p_data->'outputs' IS NULL OR jsonb_typeof(p_data->'outputs') = 'null' THEN
    IF v_hdr_item IS NULL OR v_hdr_qty IS NULL OR v_hdr_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_o_items := ARRAY[v_hdr_item];
    v_o_qtys := ARRAY[v_hdr_qty];
    v_o_whs := ARRAY[v_output_warehouse_id];
    v_o_shares := ARRAY[NULL::numeric];
    v_o_refs := ARRAY[NULL::numeric];
  ELSE
    IF jsonb_typeof(p_data->'outputs') <> 'array'
       OR jsonb_array_length(p_data->'outputs') NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_data->'outputs')
    LOOP
      IF jsonb_typeof(v_line) <> 'object' THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
      END IF;
      v_item_id := public.prod_juuid(v_line, 'item_id');
      v_qty := public.prod_jnum(v_line, 'qty', 3);
      v_o_wh := COALESCE(public.prod_juuid(v_line, 'output_warehouse_id'), v_output_warehouse_id);
      v_share := public.prod_jnum(v_line, 'share_pct', 4);
      v_ref := public.prod_jnum(v_line, 'ref_price', 2);
      IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 OR v_item_id = ANY (v_o_items)
         OR (v_share IS NOT NULL AND v_share NOT BETWEEN 0 AND 100)
         OR (v_ref IS NOT NULL AND v_ref < 0) THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
      END IF;
      v_o_items := v_o_items || v_item_id;
      v_o_qtys := v_o_qtys || v_qty;
      v_o_whs := v_o_whs || v_o_wh;
      v_o_shares := array_append(v_o_shares, v_share);
      v_o_refs := array_append(v_o_refs, v_ref);
    END LOOP;
    IF (v_hdr_item IS NOT NULL AND v_hdr_item <> v_o_items[1])
       OR (v_hdr_qty IS NOT NULL AND v_hdr_qty <> v_o_qtys[1]) THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'outputs';
    END IF;
  END IF;
  v_n := cardinality(v_o_items);
  v_output_item_id := v_o_items[1];
  v_output_qty := v_o_qtys[1];

  -- Output items / warehouses + allocation weights.
  FOR i IN 1 .. v_n
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.prod_warehouses
      WHERE id = v_o_whs[i] AND company_id = v_company_id AND is_active
    ) THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    SELECT item_type, is_active, unit, weight_kg, sale_price
    INTO v_out_type, v_out_active, v_out_unit, v_out_weight, v_out_sale
    FROM public.prod_items
    WHERE id = v_o_items[i] AND company_id = v_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF NOT v_out_active OR v_out_type NOT IN ('finished', 'semi') THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    IF v_n = 1 THEN
      v_w := 1;
    ELSIF v_method = 'mass' THEN
      v_w := public.prod_qty_kg(v_o_qtys[i], v_out_unit, v_out_weight);
      IF v_w IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'output_weight';
      END IF;
    ELSIF v_method = 'value' THEN
      v_ref := COALESCE(v_o_refs[i], v_out_sale);
      IF v_ref IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'ref_price';
      END IF;
      v_o_refs[i] := v_ref;
      v_w := v_ref * v_o_qtys[i];
    ELSE
      IF v_o_shares[i] IS NULL THEN
        RAISE EXCEPTION 'invalid_input' USING DETAIL = 'share_pct';
      END IF;
      v_w := v_o_shares[i];
    END IF;
    v_o_w := v_o_w || v_w;
    v_w_sum := v_w_sum + v_w;
  END LOOP;
  IF v_n > 1 THEN
    IF v_method = 'fixed' AND v_w_sum <> 100 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'share_pct';
    END IF;
    IF v_w_sum <= 0 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = CASE v_method WHEN 'mass' THEN 'output_weight'
        WHEN 'value' THEN 'ref_price' ELSE 'share_pct' END;
    END IF;
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
       OR v_item_id = ANY (v_o_items)
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

  -- 19: optional plan line (row FOR UPDATE before the period row).
  IF v_plan_id IS NOT NULL THEN
    SELECT item_id, status INTO v_plan_item, v_plan_status
    FROM public.prod_production_plans
    WHERE id = v_plan_id AND company_id = v_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    IF v_plan_status <> 'planned' THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'plan_not_open';
    END IF;
    IF v_plan_item <> v_output_item_id THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'plan_item';
    END IF;
  END IF;

  PERFORM public.prod_assert_date(v_company_id, v_biz, 'create', p_data, 'prod_productions', v_id);

  -- Rule 1 (17): yield against the recipe, MAIN output only.
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

  PERFORM public.prod_lock_items_share(v_company_id, v_o_items);

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

  -- Cost split (last output takes the rounding remainder).
  FOR i IN 1 .. v_n
  LOOP
    IF i < v_n THEN
      v_line_cost := round(v_total_cost * v_o_w[i] / v_w_sum, 2);
      v_alloc := v_alloc + v_line_cost;
    ELSE
      v_line_cost := v_total_cost - v_alloc;
    END IF;
    IF v_line_cost < 0 THEN
      RAISE EXCEPTION 'invalid_input' USING DETAIL = 'allocation';
    END IF;
    v_o_cost := v_o_cost || v_line_cost;
    v_unit_cost := round(v_line_cost / v_o_qtys[i], 2);
    IF v_unit_cost >= 1e12 THEN
      RAISE EXCEPTION 'invalid_input';
    END IF;
    v_o_unit := v_o_unit || v_unit_cost;
  END LOOP;
  v_unit_cost := v_o_unit[1];

  PERFORM pg_advisory_xact_lock(hashtextextended('prod_production_no:' || v_company_id::text, 0));
  SELECT COALESCE(max(number), 0) + 1 INTO v_number
  FROM public.prod_productions WHERE company_id = v_company_id;

  SELECT full_name INTO v_user_name FROM public.users WHERE id = auth.uid();

  INSERT INTO public.prod_productions (
    id, company_id, number, doc_date, warehouse_id, output_warehouse_id, output_item_id, output_qty,
    total_cost, unit_cost, note, status, created_by, created_by_name,
    recipe_id, recipe_version, lot_pick_deviation, allocation_method
  ) VALUES (
    v_id, v_company_id, v_number, v_doc_date, v_warehouse_id, v_o_whs[1], v_output_item_id, v_output_qty,
    v_total_cost, v_unit_cost, v_note, 'posted', auth.uid(), v_user_name,
    v_recipe_id, v_recipe_version, v_deviation, v_method
  );

  FOR i IN 1 .. cardinality(v_item_ids)
  LOOP
    INSERT INTO public.prod_production_components (
      company_id, production_id, item_id, qty, unit_cost, total, planned_qty
    ) VALUES (
      v_company_id, v_id, v_item_ids[i], v_qtys[i], v_costs[i], v_totals[i], v_planned[i]
    );
  END LOOP;

  FOR i IN 1 .. v_n
  LOOP
    v_o_lot := public.prod_add_lot(
      v_company_id, v_o_whs[i], v_o_items[i], v_o_qtys[i], v_o_unit[i],
      NULL, NULL, NULL, 'production', v_id, NULL,
      public.prod_lot_expiry(v_company_id, v_o_items[i], v_doc_date),
      v_doc_date, NULL
    );
    v_share := CASE WHEN v_n = 1 THEN 100 ELSE round(v_o_w[i] * 100 / v_w_sum, 6) END;
    INSERT INTO public.prod_production_outputs (
      company_id, production_id, sort_order, item_id, warehouse_id, qty, share_pct, ref_price,
      cost, unit_cost, lot_id
    ) VALUES (
      v_company_id, v_id, i - 1, v_o_items[i], v_o_whs[i], v_o_qtys[i], v_share, v_o_refs[i],
      v_o_cost[i], v_o_unit[i], v_o_lot
    );
    v_outputs := v_outputs || jsonb_build_array(jsonb_build_object(
      'item_id', v_o_items[i], 'qty', v_o_qtys[i], 'cost', v_o_cost[i], 'unit_cost', v_o_unit[i],
      'share_pct', v_share, 'lot_id', v_o_lot
    ));
  END LOOP;

  IF v_plan_id IS NOT NULL THEN
    UPDATE public.prod_production_plans
    SET status = 'done', production_id = v_id, updated_at = now(), updated_by = auth.uid()
    WHERE id = v_plan_id AND company_id = v_company_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_id, 'number', v_number, 'total_cost', v_total_cost, 'unit_cost', v_unit_cost,
    'allocation_method', v_method, 'outputs', v_outputs, 'plan_id', v_plan_id
  );
END;
$$;

-- ═══ Grants ══════════════════════════════════════════════════════════════
-- CREATE OR REPLACE keeps existing ACLs; restated for the replaced RPC.
REVOKE EXECUTE ON FUNCTION public.prod_create_production(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_request_approval(text, jsonb, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_decide_approval(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_withdraw_approval(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_notifications() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_get_user_prefs() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_user_prefs(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_onboarding_status() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_last_sale_lines(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_plan_requirements(date, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.prod_save_plan(date, jsonb) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.prod_create_production(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_request_approval(text, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_decide_approval(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_withdraw_approval(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_get_user_prefs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_user_prefs(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_onboarding_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_last_sale_lines(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_plan_requirements(date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prod_save_plan(date, jsonb) TO authenticated;

COMMIT;

-- ─── Verification (run manually after applying) ────────────────────────────
-- -- RLS on + one SELECT policy on every new table:
-- SELECT c.relname, c.relrowsecurity, count(p.polname)
-- FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
-- WHERE c.relnamespace = 'public'::regnamespace
--   AND c.relname IN ('prod_approval_requests', 'prod_user_prefs', 'prod_production_plans')
-- GROUP BY 1, 2;
-- -- only authenticated/SELECT grants expected:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
--   AND table_name IN ('prod_approval_requests', 'prod_user_prefs', 'prod_production_plans');
