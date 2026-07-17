-- Close audit finding C3: RLS on these tables only ever checked company_id,
-- never the app's role/permission model, so any authenticated user of a
-- company could mutate them directly from the browser regardless of their
-- permissions. All legitimate writes to these 5 tables now go exclusively
-- through the has_permission()-gated RPCs (sell_cart, stock_in, stock_out,
-- delete_stock_in_entry, delete_stock_out_entry) — confirmed by grepping
-- app/ for any remaining .insert/.update/.upsert/.delete on them (none).
--
-- SELECT is left untouched: every page still reads these tables directly
-- for catalogs, dashboards and history lists, and RLS's company_id check
-- still applies to those reads exactly as before.
--
-- `service_role` (used by lib/supabase/server.ts's supabaseServer inside
-- 'use server' actions) is unaffected by these REVOKEs — it bypasses table
-- grants and RLS entirely, and no actions.ts file touches these tables
-- today anyway.
REVOKE INSERT, UPDATE, DELETE ON public.product_sizes FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.stock_in_entries FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.stock_out_entries FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.transactions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.transaction_items FROM authenticated;

-- Re-affirm the RPC grants explicitly in this migration too, so this file
-- is a complete, self-contained statement of "these are the only write
-- paths" even though they were already granted in the previous migration.
GRANT EXECUTE ON FUNCTION public.sell_cart(jsonb, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stock_in(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stock_out(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_stock_in_entry(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_stock_out_entry(uuid) TO authenticated;
