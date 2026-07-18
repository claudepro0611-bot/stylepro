-- Promotions (aksiya) + VIP customer discount data model.
--
-- Closes audit finding: the `marketing` module (public.campaigns /
-- public.coupons, see 20260612090010_campaigns_coupons.sql) has RLS that
-- only checks company_id — no has_permission() gate on writes (the app
-- inserts into campaigns/coupons directly from the client in
-- app/(dashboard)/marketing/page.tsx's saveCampaign(), with no permission
-- check beyond RLS) and no REVOKE of Supabase's default authenticated/anon
-- grants. Any authenticated employee of a company — regardless of their
-- assigned `marketing` permission — can read/write it today.
--
-- Relationship to campaigns/coupons (read in full before writing this):
-- campaigns/coupons is a flat name + discount% + start/end date +
-- usage_count/usage_limit (+ optional coupon code) model with zero
-- product/category/store targeting, and nothing in sell_cart or anywhere
-- else ever applies a campaign/coupon discount to a real sale — it is
-- purely a tracked/displayed marketing artifact today. This migration does
-- NOT touch or repurpose campaigns/coupons: promotions/promotion_products
-- below is a genuinely different, additive concept (scope-based discount
-- rules — product/category/store — plus a read-only lookup helper meant
-- for a later, separate sell_cart integration) that coexists alongside the
-- older tables. campaigns/coupons still need the same REVOKE + RPC
-- hardening treatment as products/product_sizes/stock tables already got,
-- but that is a separate follow-up task (rewiring marketing/page.tsx off
-- direct table writes), not done here.
--
-- Note: app/(dashboard)/dashboard/page.tsx does NOT actually query
-- campaigns/coupons — its only "campaigns" reference is the translation
-- key 'dashboard.widgets.campaigns', a label in a customizable-KPI-widget
-- picker list, not a `.from('campaigns')` call. Only marketing/page.tsx
-- queries these tables. Documented here since the task brief's premise
-- ("both marketing/page.tsx and dashboard/page.tsx query them") doesn't
-- hold for dashboard/page.tsx on inspection.
--
-- get_company_id() itself (20260612090003_helper_functions.sql) is only
-- `SET search_path = public` — a known pre-existing gap, intentionally not
-- touched here (out of scope) — but every new function below is pinned to
-- `public, pg_temp` so this migration doesn't propagate that omission.

-- ─────────────────────────────────────────────────────────────────────────
-- Table: promotions
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  discount_percent numeric(5,2) NOT NULL CHECK (discount_percent >= 0 AND discount_percent <= 100),
  scope_type text NOT NULL CHECK (scope_type IN ('product', 'category', 'store')),
  -- Nullable; populated only when scope_type = 'category'. Same column
  -- name/type as products.category (20260612090004_products.sql: `category
  -- text`, nullable) so a promotion's category matches the product catalog
  -- directly with no lookup table or type coercion.
  category text,
  starts_on date,
  ends_on date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Defense in depth alongside the RPC-level validation below: never allow
  -- a category set on a non-category-scoped promotion, or a category-scoped
  -- promotion with no category — same "hard reject over ambiguous state"
  -- philosophy as sell_cart's discount validation.
  CONSTRAINT promotions_category_scope_chk CHECK (
    (scope_type = 'category' AND category IS NOT NULL)
    OR (scope_type <> 'category' AND category IS NULL)
  )
);

CREATE INDEX promotions_company_id_idx ON public.promotions(company_id);
CREATE INDEX promotions_company_scope_idx ON public.promotions(company_id, scope_type);
CREATE INDEX promotions_company_category_idx ON public.promotions(company_id, category) WHERE category IS NOT NULL;

CREATE TRIGGER promotions_set_updated_at
  BEFORE UPDATE ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

-- Single FOR ALL policy, matching the exact convention already used on
-- every other table that also gets a REVOKE below (product_sizes, products,
-- product_groups, stock_in_entries, stock_out_entries, transactions,
-- transaction_items) — none of those split SELECT vs. write policies after
-- their REVOKE either. The WITH CHECK half becomes unreachable for
-- `authenticated` once table-level INSERT/UPDATE privilege is revoked (the
-- privilege check happens before RLS is even evaluated), but SELECT still
-- needs company_id = get_company_id() to keep working — which this single
-- policy already provides, same as the existing precedent.
CREATE POLICY "Company isolation" ON public.promotions
  FOR ALL
  USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

-- Close the exact leak this migration is fixing: Supabase's default
-- privileges grant `authenticated` (and `anon`) full CRUD on new public
-- tables regardless of RLS policy. All real writes now go exclusively
-- through the has_permission('marketing')-gated RPCs below.
--
-- No explicit REVOKE ... FROM anon here, matching the exact precedent set
-- by every other hardened table in this schema (20260715000004,
-- 20260718000001) — neither revokes from anon either. anon requests carry
-- no auth.uid(), so get_company_id() resolves to NULL for them and the RLS
-- predicate `company_id = get_company_id()` (company_id is NOT NULL) can
-- never be true — anon already sees/affects zero rows via RLS regardless
-- of table-level grants, so there is no new stance being invented here.
REVOKE INSERT, UPDATE, DELETE ON public.promotions FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Table: promotion_products
-- ─────────────────────────────────────────────────────────────────────────
-- Keyed on product_size_id, not product_id: sell_cart/transaction_items
-- already treat product_size_id as the pricing/stock unit (confirmed in
-- 20260715000002_search_path_and_permission_whitelist.sql's sell_cart —
-- every cart line keys on product_size_id), and get_best_promotion_discount
-- below is designed the same way (p_product_size_id), so a "product-scoped"
-- promotion targets the exact sellable variant, not the parent product.
CREATE TABLE public.promotion_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalized company_id for RLS/company-scoping consistency — same
  -- convention as transaction_items and stock_out_entries, which both
  -- denormalize company_id rather than relying on a join through
  -- transaction_id/product_size_id.
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  product_size_id uuid NOT NULL REFERENCES public.product_sizes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, product_size_id)
);

CREATE INDEX promotion_products_company_id_idx ON public.promotion_products(company_id);
CREATE INDEX promotion_products_promotion_id_idx ON public.promotion_products(promotion_id);
CREATE INDEX promotion_products_product_size_id_idx ON public.promotion_products(product_size_id);

ALTER TABLE public.promotion_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company isolation" ON public.promotion_products
  FOR ALL
  USING (company_id = public.get_company_id())
  WITH CHECK (company_id = public.get_company_id());

REVOKE INSERT, UPDATE, DELETE ON public.promotion_products FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- customers.vip_discount_percent
-- ─────────────────────────────────────────────────────────────────────────
-- Nullable, no default (stays NULL for existing rows). NULL and 0 are both
-- "not VIP" by the app's own reading of this spec, so a forced `DEFAULT 0`
-- would collapse that distinction for no benefit — leave it unset.
--
-- customers (20260612090005_customers.sql) has no REVOKE today — its
-- "Company isolation" FOR ALL RLS policy is the only guard, and any
-- authenticated user can already write any other customers column
-- (full_name, phone, status, ...) directly. That is a pre-existing gap,
-- not introduced or widened by this ALTER, and explicitly out of scope
-- here per the task brief — no REVOKE is added in this migration. The new
-- set_customer_vip RPC below is an additive, permission-gated write path;
-- it does not by itself close the pre-existing direct-write gap on this
-- column (documented in the final report).
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS vip_discount_percent numeric(5,2)
    CHECK (vip_discount_percent IS NULL OR (vip_discount_percent >= 0 AND vip_discount_percent <= 100));

-- ─────────────────────────────────────────────────────────────────────────
-- RPCs
-- ─────────────────────────────────────────────────────────────────────────

-- ─── create_promotion ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_promotion(
  p_name text,
  p_discount_percent numeric,
  p_scope_type text,
  p_category text,
  p_starts_on date,
  p_ends_on date,
  p_product_size_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_category text;
  v_id uuid;
  v_input_count integer;
  v_valid_count integer;
BEGIN
  IF NOT public.has_permission('marketing') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Promotion name is required';
  END IF;

  IF p_discount_percent IS NULL OR p_discount_percent < 0 OR p_discount_percent > 100 THEN
    RAISE EXCEPTION 'discount_percent must be between 0 and 100';
  END IF;

  IF p_scope_type IS NULL OR p_scope_type NOT IN ('product', 'category', 'store') THEN
    RAISE EXCEPTION 'Invalid scope_type: %', p_scope_type;
  END IF;

  v_category := NULLIF(trim(coalesce(p_category, '')), '');

  IF p_scope_type = 'category' THEN
    IF v_category IS NULL THEN
      RAISE EXCEPTION 'category is required when scope_type = ''category''';
    END IF;
  ELSE
    IF v_category IS NOT NULL THEN
      RAISE EXCEPTION 'category must be empty unless scope_type = ''category''';
    END IF;
  END IF;

  -- Hard reject mismatched scope/product_size_ids combinations rather than
  -- silently ignoring or clamping — same philosophy as sell_cart's
  -- discount validation (20260723000001/000002).
  IF p_scope_type = 'product' THEN
    IF p_product_size_ids IS NULL OR cardinality(p_product_size_ids) = 0 THEN
      RAISE EXCEPTION 'p_product_size_ids is required when scope_type = ''product''';
    END IF;
  ELSE
    IF p_product_size_ids IS NOT NULL AND cardinality(p_product_size_ids) > 0 THEN
      RAISE EXCEPTION 'p_product_size_ids must be empty unless scope_type = ''product''';
    END IF;
  END IF;

  IF p_scope_type = 'product' THEN
    SELECT count(DISTINCT x) INTO v_input_count FROM unnest(p_product_size_ids) x;
    SELECT count(DISTINCT ps.id) INTO v_valid_count
      FROM public.product_sizes ps
      WHERE ps.id = ANY(p_product_size_ids) AND ps.company_id = v_company_id;

    IF v_valid_count IS DISTINCT FROM v_input_count THEN
      RAISE EXCEPTION 'One or more product sizes do not belong to this company';
    END IF;
  END IF;

  INSERT INTO public.promotions (
    company_id, name, discount_percent, scope_type, category, starts_on, ends_on
  ) VALUES (
    v_company_id, trim(p_name), p_discount_percent, p_scope_type, v_category, p_starts_on, p_ends_on
  )
  RETURNING id INTO v_id;

  IF p_scope_type = 'product' THEN
    INSERT INTO public.promotion_products (company_id, promotion_id, product_size_id)
    SELECT v_company_id, v_id, x FROM (SELECT DISTINCT unnest(p_product_size_ids) AS x) u;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_promotion(text, numeric, text, text, date, date, uuid[]) TO authenticated;

-- ─── update_promotion ───────────────────────────────────────────────────
-- Full-field replace (not a jsonb partial-update like update_product/
-- update_product_group) — matches the task brief's "same field set" spec.
-- p_is_active is appended (not part of create_promotion's inputs, but a
-- required toggle for an existing promotion); p_product_size_ids fully
-- replaces the promotion's product set for scope_type = 'product' (delete
-- + reinsert, both company-scoped single statements — no cross-statement
-- read-then-write race, since nothing here depends on a stock/money value
-- read earlier in the function).
CREATE OR REPLACE FUNCTION public.update_promotion(
  p_id uuid,
  p_name text,
  p_discount_percent numeric,
  p_scope_type text,
  p_category text,
  p_starts_on date,
  p_ends_on date,
  p_is_active boolean,
  p_product_size_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company_id uuid;
  v_category text;
  v_input_count integer;
  v_valid_count integer;
BEGIN
  IF NOT public.has_permission('marketing') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Promotion name is required';
  END IF;

  IF p_discount_percent IS NULL OR p_discount_percent < 0 OR p_discount_percent > 100 THEN
    RAISE EXCEPTION 'discount_percent must be between 0 and 100';
  END IF;

  IF p_scope_type IS NULL OR p_scope_type NOT IN ('product', 'category', 'store') THEN
    RAISE EXCEPTION 'Invalid scope_type: %', p_scope_type;
  END IF;

  v_category := NULLIF(trim(coalesce(p_category, '')), '');

  IF p_scope_type = 'category' THEN
    IF v_category IS NULL THEN
      RAISE EXCEPTION 'category is required when scope_type = ''category''';
    END IF;
  ELSE
    IF v_category IS NOT NULL THEN
      RAISE EXCEPTION 'category must be empty unless scope_type = ''category''';
    END IF;
  END IF;

  IF p_scope_type = 'product' THEN
    IF p_product_size_ids IS NULL OR cardinality(p_product_size_ids) = 0 THEN
      RAISE EXCEPTION 'p_product_size_ids is required when scope_type = ''product''';
    END IF;
  ELSE
    IF p_product_size_ids IS NOT NULL AND cardinality(p_product_size_ids) > 0 THEN
      RAISE EXCEPTION 'p_product_size_ids must be empty unless scope_type = ''product''';
    END IF;
  END IF;

  IF p_scope_type = 'product' THEN
    SELECT count(DISTINCT x) INTO v_input_count FROM unnest(p_product_size_ids) x;
    SELECT count(DISTINCT ps.id) INTO v_valid_count
      FROM public.product_sizes ps
      WHERE ps.id = ANY(p_product_size_ids) AND ps.company_id = v_company_id;

    IF v_valid_count IS DISTINCT FROM v_input_count THEN
      RAISE EXCEPTION 'One or more product sizes do not belong to this company';
    END IF;
  END IF;

  UPDATE public.promotions SET
    name = trim(p_name),
    discount_percent = p_discount_percent,
    scope_type = p_scope_type,
    category = v_category,
    starts_on = p_starts_on,
    ends_on = p_ends_on,
    is_active = COALESCE(p_is_active, is_active)
  WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Promotion not found';
  END IF;

  DELETE FROM public.promotion_products
  WHERE promotion_id = p_id AND company_id = v_company_id;

  IF p_scope_type = 'product' THEN
    INSERT INTO public.promotion_products (company_id, promotion_id, product_size_id)
    SELECT v_company_id, p_id, x FROM (SELECT DISTINCT unnest(p_product_size_ids) AS x) u;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_promotion(uuid, text, numeric, text, text, date, date, boolean, uuid[]) TO authenticated;

-- ─── delete_promotion ───────────────────────────────────────────────────
-- promotion_products rows cascade via the ON DELETE CASCADE FK — no
-- manual join-table delete needed.
CREATE OR REPLACE FUNCTION public.delete_promotion(p_id uuid)
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

  DELETE FROM public.promotions WHERE id = p_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Promotion not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_promotion(uuid) TO authenticated;

-- ─── set_customer_vip ───────────────────────────────────────────────────
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
  SET vip_discount_percent = p_vip_discount_percent
  WHERE id = p_customer_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_customer_vip(uuid, numeric) TO authenticated;

-- ─── get_best_promotion_discount ────────────────────────────────────────
-- Read-only lookup helper for a later, separate sell_cart integration (not
-- done here). No has_permission() gate — read-only, and the intended
-- caller (sell_cart) is already gated on 'pos'. Still validates
-- p_product_size_id belongs to the caller's own company before returning
-- anything, same as every other company-scoped lookup in this schema.
--
-- NULL starts_on/ends_on are treated as open-ended bounds (a promotion with
-- no starts_on has always started; one with no ends_on never ends) rather
-- than requiring both to be set — simpler UX for an indefinite/ongoing
-- promotion, and symmetrical with promotions.starts_on/ends_on both being
-- nullable columns in the first place.
--
-- Returns 0 (never NULL) when nothing matches, so a future caller can use
-- it directly in arithmetic without a COALESCE.
CREATE OR REPLACE FUNCTION public.get_best_promotion_discount(
  p_product_size_id uuid,
  p_date date DEFAULT current_date
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_company_id uuid;
  v_category text;
  v_discount numeric;
BEGIN
  v_company_id := public.get_company_id();
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'No company for current user';
  END IF;

  SELECT p.category INTO v_category
  FROM public.product_sizes ps
  JOIN public.products p ON p.id = ps.product_id AND p.company_id = v_company_id
  WHERE ps.id = p_product_size_id AND ps.company_id = v_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product size not found';
  END IF;

  SELECT COALESCE(MAX(pr.discount_percent), 0) INTO v_discount
  FROM public.promotions pr
  WHERE pr.company_id = v_company_id
    AND pr.is_active = true
    AND (pr.starts_on IS NULL OR pr.starts_on <= p_date)
    AND (pr.ends_on IS NULL OR pr.ends_on >= p_date)
    AND (
      pr.scope_type = 'store'
      OR (pr.scope_type = 'category' AND pr.category = v_category)
      OR (
        pr.scope_type = 'product'
        AND EXISTS (
          SELECT 1 FROM public.promotion_products pp
          WHERE pp.promotion_id = pr.id
            AND pp.product_size_id = p_product_size_id
            AND pp.company_id = v_company_id
        )
      )
    );

  RETURN COALESCE(v_discount, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_best_promotion_discount(uuid, date) TO authenticated;
