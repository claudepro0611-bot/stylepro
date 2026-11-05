-- Adds a third rate source, 'market': the free open.er-api.com mid-market
-- rate, used when cbu.uz can't be reached (it times out from Vercel's
-- non-Uzbek servers). Kept distinct from 'cbu' so an unofficial rate is
-- never shown as the Central Bank's.

ALTER TABLE public.exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_source_check;
ALTER TABLE public.exchange_rates
  ADD CONSTRAINT exchange_rates_source_check CHECK (source IN ('manual', 'cbu', 'market'));

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

  IF p_source IS NULL OR p_source NOT IN ('manual', 'cbu', 'market') THEN
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
