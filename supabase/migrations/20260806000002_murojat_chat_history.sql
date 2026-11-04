-- Two-way chat history for `murojat`-mode requests, plus a human-readable
-- ticket number for all requests (both modes).
--
-- Context: the Telegram webhook (app/api/telegram/webhook/route.ts) creates
-- a NEW public.requests row for every incoming text message from a linked
-- customer today. This migration adds the DB-side pieces needed to instead
-- persist a running conversation (public.murojat_messages) against a single
-- request, plus a ticket_number for display. It does NOT change the webhook
-- insert behavior itself — that is an app-layer change, out of scope here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- DESIGN NOTES (read before reviewing the SQL below)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- (a) ticket_number is a SINGLE GLOBAL SEQUENCE across ALL companies, not
--     per-company numbering. A bare `SERIAL` column is backed by one
--     sequence for the whole table regardless of company_id, so Company A's
--     tickets and Company B's tickets interleave in the same numbering
--     space (e.g. Company A gets #1, #3, #5 while Company B gets #2, #4).
--     This is almost certainly NOT what a human-readable "ticket #42 for my
--     shop" display wants long-term (per-company sequences are the more
--     common product expectation), but re-deriving per-company numbering
--     requires either a per-company sequence table or a
--     ROW_NUMBER()-over-partition backfill strategy, which is a product/
--     design decision, not something to silently decide inside a migration.
--     Implemented exactly as specified (global SERIAL) — flagging this
--     plainly for the next reviewer/product decision, not deviating from it.
--
-- (b) send_murojat_reply() below is DATABASE PERSISTENCE ONLY. It inserts
--     the store's reply into murojat_messages and returns the new row; it
--     does NOT call Telegram. Postgres functions cannot make outbound HTTP
--     calls without an extension like pg_net, and grepping every
--     `CREATE EXTENSION` in supabase/migrations/*.sql confirms pg_net (or
--     any HTTP-capable extension) is not installed in this project — adding
--     one is out of scope for this task. Actually delivering the reply to
--     Telegram (calling sendMessage() from lib/telegram.ts) is the
--     responsibility of the Next.js server action that calls this RPC, as a
--     separate step after the RPC returns successfully. See the function's
--     own comment below for the same note in context.
--
-- (c) RLS/grant pattern: public.murojat_messages follows the exact
--     "hardened at creation" convention already used for promotions/
--     promotion_products (20260723000004_promotions_vip_discounts.sql) —
--     ENABLE ROW LEVEL SECURITY + a single `FOR ALL` "Company isolation"
--     policy keyed on company_id = get_company_id(), plus an explicit
--     REVOKE of INSERT/UPDATE/DELETE from `authenticated` at creation time
--     (rather than leaving default Supabase grants in place and hardening
--     later, the way requests/customers originally shipped and were
--     patched in 20260723000009). SELECT is intentionally left alone: every
--     company-scoped table in this schema that gets this treatment relies
--     on Supabase's default `authenticated` SELECT grant + the RLS policy
--     to scope reads, and none of them issue an explicit
--     `GRANT SELECT ... TO authenticated` (see 20260723000004's comment
--     block for the rationale) — matched here for consistency rather than
--     inventing a new stance. No explicit REVOKE ... FROM anon either, same
--     precedent: anon requests carry no auth.uid(), so get_company_id()
--     resolves to NULL and the RLS predicate (company_id NOT NULL) can
--     never match — anon already sees/writes zero rows regardless of
--     table-level grants.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 1: ticket_number on public.requests
-- ═══════════════════════════════════════════════════════════════════════════
-- A bare SERIAL gets a backing sequence + NOT NULL DEFAULT nextval(...), but
-- Postgres does NOT implicitly add a uniqueness constraint on it. Since the
-- stated purpose is "sequential ID for easy reference / ticket display", an
-- explicit UNIQUE constraint is warranted for data integrity — nothing about
-- requests' existing constraints (see 20260612090011_requests.sql,
-- 20260730000002_requests_mode.sql, 20260806000001_requests_mode_rename.sql)
-- suggests duplicate ticket numbers would ever be acceptable, and leaving it
-- un-enforced would let a future manual UPDATE silently collide two tickets.
ALTER TABLE public.requests ADD COLUMN IF NOT EXISTS ticket_number SERIAL;

ALTER TABLE public.requests
  ADD CONSTRAINT requests_ticket_number_key UNIQUE (ticket_number);

-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 2: public.murojat_messages — persisted chat history
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.murojat_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.requests(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES public.customers(id),
  sender text NOT NULL CHECK (sender IN ('customer', 'store')),
  message text NOT NULL,
  sent_at timestamptz DEFAULT now(),
  telegram_message_id bigint
);

CREATE INDEX IF NOT EXISTS murojat_messages_company_id_idx ON public.murojat_messages(company_id);
CREATE INDEX IF NOT EXISTS murojat_messages_request_id_idx ON public.murojat_messages(request_id);

ALTER TABLE public.murojat_messages ENABLE ROW LEVEL SECURITY;

-- Single FOR ALL policy, matching the exact convention used on every other
-- table hardened at creation time in this schema (see promotions /
-- promotion_products, 20260723000004) rather than the split-policy-later
-- pattern used on the original requests/customers tables.
CREATE POLICY "Company isolation" ON public.murojat_messages
  FOR ALL
  USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

-- Close the standard Supabase default-grant leak immediately (see hard rule
-- in the security brief for this repo) rather than shipping the table
-- open and hardening it in a follow-up migration. Real writes go
-- exclusively through send_murojat_reply() (store side) and the Telegram
-- webhook's service-role client (customer side, bypasses RLS/grants
-- entirely — same as every other telegram-sourced write in this schema, see
-- 20260730000002's header comment for precedent). SELECT is intentionally
-- left as Supabase's default `authenticated` grant + RLS company scoping,
-- matching every sibling table.
REVOKE INSERT, UPDATE, DELETE ON public.murojat_messages FROM authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 3: send_murojat_reply(p_request_id, p_message) — persistence only
-- ═══════════════════════════════════════════════════════════════════════════
-- IMPORTANT: this RPC does NOT call Telegram. Postgres cannot make outbound
-- HTTP calls without an extension like pg_net, which is not installed in
-- this project (confirmed: no `CREATE EXTENSION` for pg_net or any
-- HTTP-capable extension exists anywhere in supabase/migrations/*.sql).
-- This function's sole job is to persist the store's reply as a row in
-- murojat_messages and return it. The caller (a Next.js server action) is
-- responsible for the separate step of actually delivering the message via
-- sendMessage() from lib/telegram.ts AFTER this RPC succeeds — do not
-- conflate the two.
--
-- Permission: gated on has_permission('requests'), the existing whitelisted
-- key already used by update_request() for this exact domain
-- (20260723000009_expenses_requests_hr_security.sql) — same feature area,
-- same key, no new permission introduced.
--
-- Company scoping: p_request_id is looked up WHERE company_id =
-- get_company_id() so a request belonging to another company can never be
-- replied to (the lookup simply returns NOT FOUND, raising below).
-- customer_id is derived server-side from the request row, never trusted
-- from the client, since it drives who the eventual Telegram send targets.
CREATE OR REPLACE FUNCTION public.send_murojat_reply(p_request_id uuid, p_message text)
RETURNS public.murojat_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_customer_id uuid;
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

  -- Ownership check + derive customer_id in one statement; the request must
  -- belong to the caller's own company.
  SELECT customer_id INTO v_customer_id
  FROM public.requests
  WHERE id = p_request_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- TASK 4: get_murojat_messages(p_request_id) — read history
-- ═══════════════════════════════════════════════════════════════════════════
-- No has_permission() gate — same treatment and rationale as
-- get_customer_loyalty_balance (20260723000007_loyalty_nasiya.sql): a pure,
-- company-scoped read with no side effects, and SELECT on murojat_messages
-- is already left open to `authenticated` + RLS company scoping above (this
-- RPC returns nothing more than an equivalent direct SELECT already would).
-- Cross-company access attempts are rejected the same way
-- get_customer_loyalty_balance rejects a foreign customer_id: RAISE
-- EXCEPTION rather than silently returning an empty set, so a caller
-- passing another company's request_id gets an explicit error instead of an
-- ambiguous "no messages yet".
CREATE OR REPLACE FUNCTION public.get_murojat_messages(p_request_id uuid)
RETURNS SETOF public.murojat_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.requests
    WHERE id = p_request_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Invalid request_id for this company';
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.murojat_messages
  WHERE request_id = p_request_id AND company_id = v_company_id
  ORDER BY sent_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_murojat_messages(uuid) TO authenticated;
