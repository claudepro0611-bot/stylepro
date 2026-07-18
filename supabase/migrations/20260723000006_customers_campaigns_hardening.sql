-- Closes three audit findings on top of the promotions/VIP work
-- (20260723000004/000005):
--
-- 1) CRITICAL (new): public.customers (20260612090005_customers.sql) has
--    only a company-scoped "Company isolation" RLS policy — no
--    has_permission() gate, and Supabase's default authenticated/anon
--    grants on INSERT/UPDATE/DELETE were never revoked. Because
--    vip_discount_percent (20260723000004) lives on this same table and
--    sell_cart (20260723000005) reads it unconditionally for pricing, any
--    authenticated employee could previously bypass the
--    has_permission('marketing')-gated set_customer_vip RPC entirely via
--    `supabase.from('customers').update({ vip_discount_percent: 100 })` and
--    grant up to 100% off every future sale. This migration revokes direct
--    write privilege and adds a has_permission('customers')-gated
--    create_customer RPC so the existing "Add Customer" UI
--    (app/(dashboard)/customers/page.tsx's addCustomer(), not touched by
--    this migration) has a safe replacement path to move to next.
--
-- 2) campaigns/coupons (20260612090010_campaigns_coupons.sql): same
--    default-grant leak, flagged but explicitly deferred in
--    20260723000004's header comment ("still need the same REVOKE + RPC
--    hardening treatment ... but that is a separate follow-up task"). Per
--    the current task brief, only the REVOKE half is done now (no UI
--    reads/writes these tables anymore per the marketing page rewrite, so
--    there is no RPC to build yet) — SELECT is kept for any future
--    admin/reporting view.
--
-- 3) get_company_id() (20260612090003_helper_functions.sql) is
--    `SET search_path = public` only, missing the `pg_temp` pin that every
--    other SECURITY DEFINER function in this schema already has
--    (20260716000001). Reproduced verbatim below with only the SET clause
--    changed — logic untouched.
--
-- Verified, not re-touched here (see final report for the full quoted SQL
-- and reasoning):
--   - set_customer_vip (20260723000004) already has SECURITY DEFINER,
--     SET search_path = public, pg_temp, has_permission('marketing'),
--     a NULL company_id guard, and a company-scoped single-column UPDATE.
--   - sell_cart (20260723000005) already validates p_customer_id belongs
--     to the caller's own company_id (SELECT ... WHERE id = p_customer_id
--     AND company_id = v_company_id, IF NOT FOUND THEN RAISE EXCEPTION)
--     before reading vip_discount_percent from it.
--   - 'customers' is already a whitelisted key in both lib/permissions.ts's
--     PERMISSION_KEYS and has_permission()'s v_valid_keys array
--     (20260716000001) — no whitelist change needed.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) public.customers — close the direct-write gap
-- ─────────────────────────────────────────────────────────────────────────
-- SELECT is intentionally kept: app/(dashboard)/pos/page.tsx,
-- app/(dashboard)/chiqim/page.tsx and app/(dashboard)/customers/page.tsx
-- all read this table directly via `.select(...)` for lookups/listing, and
-- RLS ("Company isolation") already scopes those reads to the caller's own
-- company_id.
REVOKE INSERT, UPDATE, DELETE ON public.customers FROM authenticated;

-- ─── create_customer ────────────────────────────────────────────────────
-- Replacement write path for app/(dashboard)/customers/page.tsx's
-- addCustomer(), which currently does a direct client-side
-- `.insert()` (full_name, phone, email, address, status). Same field set,
-- same required-field validation the frontend already performs
-- (fullName/phone required), server-enforced here too since REVOKE alone
-- would otherwise silently break that feature. Frontend rewiring itself is
-- out of scope for this migration.
CREATE OR REPLACE FUNCTION public.create_customer(
  p_full_name text,
  p_phone text,
  p_email text,
  p_address text,
  p_status text DEFAULT 'New'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
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

  -- Matches the table's own CHECK constraint
  -- (status in ('VIP', 'Regular', 'New')); defaults to 'New' for a
  -- NULL/blank input, same default the column itself has.
  v_status := NULLIF(trim(coalesce(p_status, '')), '');
  IF v_status IS NULL THEN
    v_status := 'New';
  END IF;
  IF v_status NOT IN ('VIP', 'Regular', 'New') THEN
    RAISE EXCEPTION 'Invalid status: %', v_status;
  END IF;

  INSERT INTO public.customers (
    company_id, full_name, phone, email, address, status
  ) VALUES (
    v_company_id,
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

GRANT EXECUTE ON FUNCTION public.create_customer(text, text, text, text, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) public.campaigns / public.coupons — orphaned but still writable
-- ─────────────────────────────────────────────────────────────────────────
-- SELECT kept (no active UI references either table per the marketing page
-- rewrite, but the tables/data still exist and a future admin/reporting
-- view may read them).
REVOKE INSERT, UPDATE, DELETE ON public.campaigns FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.coupons FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) get_company_id() — pin pg_temp in search_path
-- ─────────────────────────────────────────────────────────────────────────
-- Logic reproduced verbatim from 20260612090003_helper_functions.sql;
-- only the SET search_path clause changes (public -> public, pg_temp).
create or replace function public.get_company_id()
returns uuid
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select company_id from public.users where id = auth.uid()
$$;
