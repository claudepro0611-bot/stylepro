-- Phase 5: color as a real tracked dimension in product_sizes.
--
-- Pre-flight (run and reported before this file was written):
--   SELECT count(*) FROM product_sizes;                              -> 2
--   SELECT count(*) FROM products WHERE array_length(colors, 1) > 0;  -> 1
--
-- Deviation from the literal brief, flagged here: step 1c asked to "add
-- color text column to stock_in_entries and stock_out_entries (nullable;
-- backfill from product_sizes via product_size_id)". Both tables already
-- have a nullable `color text` column from the very first schema
-- (20260612090008_stock_movements.sql) — it is NOT new, and it is already
-- populated by real client-supplied values (kirim's shared color field,
-- sell_cart's colors[0] guess), not derived from product_sizes (which had
-- no color column at all until this migration). Backfilling these two
-- ledger tables' `color` FROM the brand-new product_sizes.color — which is
-- '' for every pre-existing row per step 1d — would overwrite genuine
-- historical color text with blanks. Skipping that backfill entirely; no
-- ALTER needed on either ledger table since the column already exists in
-- the exact shape asked for (nullable text).

-- ─── Step 1a: color column on product_sizes ────────────────────────────
ALTER TABLE public.product_sizes ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '';

-- ─── Step 1b: unique key becomes (company_id, product_id, size, color) ─
ALTER TABLE public.product_sizes
  DROP CONSTRAINT IF EXISTS product_sizes_company_id_product_id_size_key;
ALTER TABLE public.product_sizes
  ADD CONSTRAINT product_sizes_company_id_product_id_size_color_key
  UNIQUE (company_id, product_id, size, color);

-- ─── Step 1d verification (row count must be unchanged by this file) ───
-- Existing rows get color = '' via the DEFAULT above — no color invented
-- for historical data. Verified with a row-count check immediately after
-- applying this migration (reported alongside the pre-flight numbers).
