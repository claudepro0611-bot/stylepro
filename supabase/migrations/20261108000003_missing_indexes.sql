-- Missing performance indexes (purely additive; no data or grant changes).
--
-- Audit basis: final public schema reconstructed from every migration up to
-- 20261108000001. Rules applied:
--   (a) every company-scoped table needs an index LEADING on company_id,
--       because every RLS policy / SECURITY DEFINER RPC filters on it;
--   (b) every FK column needs an index leading on it, otherwise each
--       DELETE on the parent (incl. ON DELETE CASCADE / SET NULL / NO ACTION
--       checks) seq-scans the child table. The main trigger here is
--       delete_product -> cascade to product_sizes -> FK checks on every
--       ledger table that references product_sizes(id);
--   (c) a small number of (company_id, date) composites where app pages
--       filter by a date range (.gte('date').lte('date')) or order by date.
--
-- Deliberately NOT indexed (see report): created_by / completed_by FKs to
-- auth.users / users (only hit on rare staff-account deletion, never
-- filtered in app), invoices / invoice_items (dead schema), tiny lookup
-- tables (company_features.feature_key, stock_counts.warehouse_id,
-- stock_transfers.from/to_warehouse_id, supplier_returns.warehouse_id).
--
-- product_sizes note: company_id is already covered as the leading column
-- of UNIQUE product_sizes_variant_warehouse_key
-- (company_id, product_id, size, color, warehouse_id), which also serves
-- (company_id, product_id) lookups. What is missing is product_id alone
-- (FK cascade from products) and warehouse_id.
--
-- No CONCURRENTLY: migrations run inside a transaction. Every statement is
-- IF NOT EXISTS, so re-running is a no-op.

-- ─── product_sizes ────────────────────────────────────────────────────────
-- FK -> products ON DELETE CASCADE; also embedded selects products(product_sizes)
-- and BarcodeModal/kirim/brak .eq('product_id').
CREATE INDEX IF NOT EXISTS product_sizes_product_id_idx
  ON public.product_sizes (product_id);
-- FK -> warehouses; brak, peremeshenie, inventarizatsiya/[id], omborlar/[id],
-- yetkazuvchi-qaytarish all .eq('warehouse_id'). A warehouse belongs to one
-- company, so warehouse_id alone is as selective as (company_id, warehouse_id).
CREATE INDEX IF NOT EXISTS product_sizes_warehouse_id_idx
  ON public.product_sizes (warehouse_id);

-- ─── products ─────────────────────────────────────────────────────────────
-- FK -> warehouses ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS products_warehouse_id_idx
  ON public.products (warehouse_id);

-- ─── customers ────────────────────────────────────────────────────────────
-- FK -> price_lists ON DELETE SET NULL (delete_price_list).
CREATE INDEX IF NOT EXISTS customers_price_list_id_idx
  ON public.customers (price_list_id)
  WHERE price_list_id IS NOT NULL;

-- ─── transactions ─────────────────────────────────────────────────────────
-- FK -> users ON DELETE SET NULL: deleting a team user (jamoa) would
-- otherwise seq-scan the biggest table in the system.
CREATE INDEX IF NOT EXISTS transactions_cashier_id_idx
  ON public.transactions (cashier_id)
  WHERE cashier_id IS NOT NULL;
-- reports/sotuvlar, customers, sozlamalar (transactions_net) and
-- reports/foyda, customers (transaction_items !inner transactions) filter
-- .gte('date').lte('date') on top of the RLS company_id predicate.
CREATE INDEX IF NOT EXISTS transactions_company_date_idx
  ON public.transactions (company_id, date);

-- ─── transaction_items ────────────────────────────────────────────────────
-- FK -> products ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS transaction_items_product_id_idx
  ON public.transaction_items (product_id);
-- FK -> product_sizes (NO ACTION) + returns flow / SaleDetailDialog lookups.
CREATE INDEX IF NOT EXISTS transaction_items_product_size_id_idx
  ON public.transaction_items (product_size_id);

-- ─── stock_in_entries ─────────────────────────────────────────────────────
-- FK -> product_sizes (NO ACTION).
CREATE INDEX IF NOT EXISTS stock_in_entries_product_size_id_idx
  ON public.stock_in_entries (product_size_id);
-- reports/kirim, reports/yetkazuvchilar, xaridlar: .gte('date').lte('date');
-- kirim page: .order('date').
CREATE INDEX IF NOT EXISTS stock_in_entries_company_date_idx
  ON public.stock_in_entries (company_id, date);

-- ─── stock_out_entries ────────────────────────────────────────────────────
-- FK -> product_sizes (NO ACTION).
CREATE INDEX IF NOT EXISTS stock_out_entries_product_size_id_idx
  ON public.stock_out_entries (product_size_id);
-- reports/spisaniya: .gte('date').lte('date'); brak page: .order('date').
CREATE INDEX IF NOT EXISTS stock_out_entries_company_date_idx
  ON public.stock_out_entries (company_id, date);

-- ─── expenses ─────────────────────────────────────────────────────────────
-- Had NO company_id index at all. (company_id, date) covers the RLS
-- predicate plus reports/xarajatlar .gte/.lte('date') and xarajatlar
-- .order('date').
CREATE INDEX IF NOT EXISTS expenses_company_date_idx
  ON public.expenses (company_id, date);
-- FK -> expense_categories (NO ACTION; category delete check).
CREATE INDEX IF NOT EXISTS expenses_category_id_idx
  ON public.expenses (category_id);

-- ─── return_items ─────────────────────────────────────────────────────────
-- FK -> product_sizes (NO ACTION). (No company_id column; scoped via returns.)
CREATE INDEX IF NOT EXISTS return_items_product_size_id_idx
  ON public.return_items (product_size_id);

-- ─── reward_penalty_entries ───────────────────────────────────────────────
-- FK -> reward_penalty_types ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS reward_penalty_entries_type_id_idx
  ON public.reward_penalty_entries (type_id);

-- ─── murojat_messages ─────────────────────────────────────────────────────
-- FK -> customers (NO ACTION; customer delete check).
CREATE INDEX IF NOT EXISTS murojat_messages_customer_id_idx
  ON public.murojat_messages (customer_id);

-- ─── stock_count_items ────────────────────────────────────────────────────
-- No index leading on company_id (only count_id / product_size_id);
-- inventarizatsiya list page reads it company-wide.
CREATE INDEX IF NOT EXISTS stock_count_items_company_id_idx
  ON public.stock_count_items (company_id);

-- ─── price_list_items ─────────────────────────────────────────────────────
-- PK is (price_list_id, product_size_id); product_size_id alone is needed
-- for the ON DELETE CASCADE from product_sizes.
CREATE INDEX IF NOT EXISTS price_list_items_product_size_id_idx
  ON public.price_list_items (product_size_id);

-- ─── stock_transfer_items ─────────────────────────────────────────────────
-- No index leading on company_id; reports/peremeshenie reads it company-wide.
CREATE INDEX IF NOT EXISTS stock_transfer_items_company_id_idx
  ON public.stock_transfer_items (company_id);
-- FKs -> products / product_sizes ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS stock_transfer_items_product_id_idx
  ON public.stock_transfer_items (product_id);
CREATE INDEX IF NOT EXISTS stock_transfer_items_from_product_size_id_idx
  ON public.stock_transfer_items (from_product_size_id);
CREATE INDEX IF NOT EXISTS stock_transfer_items_to_product_size_id_idx
  ON public.stock_transfer_items (to_product_size_id);

-- ─── supplier_return_items ────────────────────────────────────────────────
-- No index leading on company_id.
CREATE INDEX IF NOT EXISTS supplier_return_items_company_id_idx
  ON public.supplier_return_items (company_id);
-- FKs -> product_sizes / products ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS supplier_return_items_product_size_id_idx
  ON public.supplier_return_items (product_size_id);
CREATE INDEX IF NOT EXISTS supplier_return_items_product_id_idx
  ON public.supplier_return_items (product_id);
