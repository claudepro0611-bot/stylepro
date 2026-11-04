-- Perfume sold by volume (ml).
--  1) product_groups.size_type gains 'volume'.
--  2) product_sizes.companion_product_size_id: optional companion (bottle)
--     product_size that POS adds as a separate cart line. sell_cart is unchanged.
--  3) set_product_size_companion RPC: product_sizes has had INSERT/UPDATE/DELETE
--     revoked from `authenticated` (20260715000004), so the frontend must write
--     the companion link through this RPC, not a direct update.

-- ─── 1. size_type CHECK: add 'volume' ─────────────────────────────────────
-- The original inline CHECK (20260709000003_seed_warehouses.sql) got the
-- Postgres auto-name product_groups_size_type_check. Drop by lookup so this
-- also works if the name differs, then recreate idempotently.
DO $$
DECLARE
  v_con record;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.product_groups'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%size_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.product_groups DROP CONSTRAINT %I', v_con.conname);
  END LOOP;

  ALTER TABLE public.product_groups
    ADD CONSTRAINT product_groups_size_type_check
    CHECK (size_type IN ('clothing', 'shoe', 'universal', 'volume'));
END $$;

-- ─── 2. companion column ──────────────────────────────────────────────────
ALTER TABLE public.product_sizes
  ADD COLUMN IF NOT EXISTS companion_product_size_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'product_sizes_companion_product_size_id_fkey'
                   AND conrelid = 'public.product_sizes'::regclass) THEN
    ALTER TABLE public.product_sizes
      ADD CONSTRAINT product_sizes_companion_product_size_id_fkey
      FOREIGN KEY (companion_product_size_id)
      REFERENCES public.product_sizes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'product_sizes_companion_not_self'
                   AND conrelid = 'public.product_sizes'::regclass) THEN
    ALTER TABLE public.product_sizes
      ADD CONSTRAINT product_sizes_companion_not_self
      CHECK (companion_product_size_id IS NULL OR companion_product_size_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS product_sizes_companion_idx
  ON public.product_sizes (companion_product_size_id)
  WHERE companion_product_size_id IS NOT NULL;

-- Same-company guard (a plain FK does not check company_id).
CREATE OR REPLACE FUNCTION public.check_product_size_companion_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.companion_product_size_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.product_sizes c
      WHERE c.id = NEW.companion_product_size_id
        AND c.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'Companion must belong to the same company';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_sizes_companion_company_check ON public.product_sizes;
CREATE TRIGGER product_sizes_companion_company_check
  BEFORE INSERT OR UPDATE OF companion_product_size_id, company_id ON public.product_sizes
  FOR EACH ROW EXECUTE FUNCTION public.check_product_size_companion_company();

-- ─── 3. RPC: set / clear companion ───────────────────────────────────────
-- p_companion_id NULL clears the link. Both ids are looked up scoped by the
-- caller's company_id; the trigger above is a second line of defence.
CREATE OR REPLACE FUNCTION public.set_product_size_companion(p_id uuid, p_companion_id uuid)
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

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Product size is required';
  END IF;

  IF p_companion_id IS NOT NULL THEN
    IF p_companion_id = p_id THEN
      RAISE EXCEPTION 'A product size cannot be its own companion';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_sizes
                   WHERE id = p_companion_id AND company_id = v_company_id) THEN
      RAISE EXCEPTION 'Companion product size not found';
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
