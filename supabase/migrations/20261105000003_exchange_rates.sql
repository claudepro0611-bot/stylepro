-- ═══════════════════════════════════════════════════════════════════════
-- Exchange rates ("Valyuta kurslari"): per-company, per-day USD -> so'm
-- rate history. Follows the hardened-table precedent (loyalty_config in
-- 20260723000007, warehouses in 20260721000001):
--   - RLS enabled, SELECT scoped by company_id = get_company_id().
--   - Supabase default INSERT/UPDATE/DELETE grants revoked immediately;
--     every write goes through the SECURITY DEFINER RPCs below, pinned to
--     `SET search_path = public, pg_temp`, gated by has_permission(), with
--     a NULL company_id guard and company_id scoping on every statement.
--
-- Permission key: 'sozlamalar' (Settings page). Verified present in the
-- current has_permission() whitelist (latest definition:
-- 20260723000007_loyalty_nasiya.sql). No new key is added here.
--
-- Additive only: no DROP, no ALTER of existing objects, no data changes.
-- No existing client code reads/writes this table, so applying this
-- migration before the frontend ships is safe.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Table
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD')),
  rate numeric(14,2) NOT NULL CHECK (rate > 0),
  rate_date date NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'cbu')),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rates_company_currency_date_key
    UNIQUE (company_id, currency, rate_date)
);

COMMENT ON TABLE public.exchange_rates IS
  'Per-company daily exchange rates. Read via RLS (company-scoped SELECT); '
  'write ONLY via set_exchange_rate / delete_exchange_rate RPCs.';
COMMENT ON COLUMN public.exchange_rates.rate IS
  'How many so''m (UZS) equal 1 unit of `currency` on `rate_date`.';
COMMENT ON COLUMN public.exchange_rates.rate_date IS
  'Business date in Asia/Tashkent local time (never in the future).';

-- "Latest rate on or before date X" lookups:
--   WHERE company_id = ? AND currency = 'USD' AND rate_date <= ?
--   ORDER BY rate_date DESC LIMIT 1
CREATE INDEX exchange_rates_company_currency_date_desc_idx
  ON public.exchange_rates (company_id, currency, rate_date DESC);

-- set_updated_at() is used by earlier migrations but never defined in this
-- repo; create it only if the live database doesn't already have it.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_updated_at' AND p.pronargs = 0
  ) THEN
    CREATE FUNCTION public.set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public, pg_temp
    AS $fn$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $fn$;
  END IF;
END
$do$;

CREATE TRIGGER exchange_rates_set_updated_at
  BEFORE UPDATE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 2) RLS + grants (access model: RLS for reads, RPC-only for writes)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation (select)" ON public.exchange_rates
  FOR SELECT
  TO authenticated
  USING (company_id = public.get_company_id());

-- Close the Supabase default-grant leak immediately.
REVOKE INSERT, UPDATE, DELETE ON public.exchange_rates FROM authenticated;
-- anon has no legitimate use for this table at all (RLS would already
-- yield zero rows since get_company_id() is NULL for anon, but remove the
-- grants outright as defense in depth).
REVOKE ALL ON public.exchange_rates FROM anon;
GRANT SELECT ON public.exchange_rates TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) set_exchange_rate — upsert one rate per (company, currency, date)
-- ─────────────────────────────────────────────────────────────────────────
-- Single-statement INSERT ... ON CONFLICT DO UPDATE: atomic, no
-- read-then-write window. company_id and created_by are server-derived;
-- the client only supplies date/rate/currency/source, all validated here.
CREATE OR REPLACE FUNCTION public.set_exchange_rate(
  p_date date,
  p_rate numeric,
  p_currency text DEFAULT 'USD',
  p_source text DEFAULT 'manual'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_id uuid;
BEGIN
  IF NOT public.has_permission('sozlamalar') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  -- round(...,2) mirrors the numeric(14,2) column so e.g. 0.004 is
  -- rejected here with a clean message instead of tripping CHECK (rate > 0);
  -- upper bound avoids a raw numeric-overflow error for numeric(14,2).
  IF p_rate IS NULL OR round(p_rate, 2) <= 0 OR p_rate >= 1000000000000 THEN
    RAISE EXCEPTION 'Invalid rate';
  END IF;

  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Date is required';
  END IF;

  -- current_date is UTC on Supabase; compare against Tashkent local date.
  IF p_date > (now() AT TIME ZONE 'Asia/Tashkent')::date THEN
    RAISE EXCEPTION 'Date cannot be in the future';
  END IF;

  IF p_currency IS NULL OR p_currency NOT IN ('USD') THEN
    RAISE EXCEPTION 'Invalid currency';
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('manual', 'cbu') THEN
    RAISE EXCEPTION 'Invalid source';
  END IF;

  INSERT INTO public.exchange_rates (company_id, currency, rate, rate_date, source, created_by)
  VALUES (v_company_id, p_currency, p_rate, p_date, p_source, auth.uid())
  ON CONFLICT (company_id, currency, rate_date) DO UPDATE
    SET rate       = EXCLUDED.rate,
        source     = EXCLUDED.source,
        created_by = auth.uid(),
        updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_exchange_rate(date, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_exchange_rate(date, numeric, text, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) delete_exchange_rate — company-scoped single-row delete
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_exchange_rate(p_id uuid)
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

  DELETE FROM public.exchange_rates
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exchange rate not found';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_exchange_rate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_exchange_rate(uuid) TO authenticated;
