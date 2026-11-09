-- POS catalog / lookups in a single round trip.
--
-- Why: app/(dashboard)/pos/page.tsx loaded products, product_sizes and
-- customers with plain PostgREST selects (silently capped at the API's
-- max-rows = 1000, so large stores lost items) and price_list_items with
-- sequential 1000-row pages. Clients are in Uzbekistan, the DB is in Seoul
-- (~250ms per round trip). Each function below returns ONE jsonb scalar,
-- which PostgREST does not row-cap, so the whole catalog arrives in one call.
--
-- Security model (deliberate):
--   * SECURITY INVOKER, read-only, STABLE. Rows are scoped by the SAME RLS
--     policies that scope today's direct selects ("Company isolation":
--     company_id = (select get_company_id())) on products, product_sizes,
--     customers, price_lists, price_list_items. The result is therefore
--     identical to what the caller can already read via PostgREST; no
--     privilege is added. Not SECURITY DEFINER on purpose: a definer
--     function would bypass RLS and would have to re-implement scoping.
--   * A caller with no company (get_company_id() IS NULL) matches no rows
--     under RLS and gets empty arrays, never another tenant's data.
--   * No has_permission() gate: today's direct selects have none either, so
--     adding one here would change behaviour, not tighten it.
--   * search_path pinned to public, pg_temp (pg_temp last so a temp table
--     cannot shadow a public table); all references are schema-qualified.
--
-- Shape: keys are the exact snake_case column names the client already maps.
-- numeric/integer columns are emitted as JSON numbers by jsonb_build_object.
-- coalesce(..., '[]') keeps empty sets as [] rather than null.
--
-- No table, grant, or policy changes. Additive only; safe to apply before
-- the client switches over (old direct selects keep working).

-- ─── pos_catalog ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_catalog()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'products', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',        p.id,
               'name',      p.name,
               'sku',       p.sku,
               'category',  p.category,
               'price',     p.price,
               'status',    p.status,
               'image_url', p.image_url
             )), '[]'::jsonb)
      FROM public.products p
      WHERE p.status = 'active'
    ),
    -- ALL visible variant rows, including stock = 0 (variant matrix shows
    -- zero-stock cells grayed out). Client drops rows of inactive products.
    'sizes', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',                        ps.id,
               'product_id',                ps.product_id,
               'size',                      ps.size,
               'color',                     ps.color,
               'stock',                     ps.stock,
               'purchase_price',            ps.purchase_price,
               'selling_price',             ps.selling_price,
               'sku',                       ps.sku,
               'companion_product_size_id', ps.companion_product_size_id
             )), '[]'::jsonb)
      FROM public.product_sizes ps
    )
  );
$$;

REVOKE ALL ON FUNCTION public.pos_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_catalog() TO authenticated;

-- ─── pos_lookups ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_lookups()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'customers', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',            c.id,
               'full_name',     c.full_name,
               'phone',         c.phone,
               'price_list_id', c.price_list_id
             )), '[]'::jsonb)
      FROM public.customers c
    ),
    'price_lists', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',             pl.id,
               'name',           pl.name,
               'base',           pl.base,
               'adjust_percent', pl.adjust_percent,
               'rounding',       pl.rounding,
               'is_active',      pl.is_active
             )), '[]'::jsonb)
      FROM public.price_lists pl
    ),
    'price_list_items', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'price_list_id',   pli.price_list_id,
               'product_size_id', pli.product_size_id,
               'price',           pli.price
             )), '[]'::jsonb)
      FROM public.price_list_items pli
    )
  );
$$;

REVOKE ALL ON FUNCTION public.pos_lookups() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_lookups() TO authenticated;
