-- Foundation for atomic stock RPCs (sell_cart / stock_in / stock_out):
-- 1) link ledger rows to the exact variant row they affected
-- 2) sanitize any pre-existing negative stock, then make it impossible again

ALTER TABLE public.stock_in_entries
  ADD COLUMN IF NOT EXISTS product_size_id uuid REFERENCES public.product_sizes(id);

ALTER TABLE public.stock_out_entries
  ADD COLUMN IF NOT EXISTS product_size_id uuid REFERENCES public.product_sizes(id);

-- Backfill: only where (company_id, product_id, size) resolves to exactly one
-- product_sizes row. Ledger tables carry no warehouse_id of their own, but in
-- practice a product's size_type pins it to a single warehouse, so matching
-- on (company_id, product_id, size) is equivalent to matching by warehouse
-- too. Ambiguous or unmatched legacy rows are left NULL on purpose.
WITH matches AS (
  SELECT
    id AS product_size_id,
    company_id,
    product_id,
    size,
    count(*) OVER (PARTITION BY company_id, product_id, size) AS match_count
  FROM public.product_sizes
)
UPDATE public.stock_in_entries e
SET product_size_id = m.product_size_id
FROM matches m
WHERE e.product_size_id IS NULL
  AND e.company_id = m.company_id
  AND e.product_id = m.product_id
  AND e.size = m.size
  AND m.match_count = 1;

WITH matches AS (
  SELECT
    id AS product_size_id,
    company_id,
    product_id,
    size,
    count(*) OVER (PARTITION BY company_id, product_id, size) AS match_count
  FROM public.product_sizes
)
UPDATE public.stock_out_entries e
SET product_size_id = m.product_size_id
FROM matches m
WHERE e.product_size_id IS NULL
  AND e.company_id = m.company_id
  AND e.product_id = m.product_id
  AND e.size = m.size
  AND m.match_count = 1;

-- Sanitize then constrain: any stock that went negative under the old
-- non-atomic write paths is clamped to 0 before the CHECK is added, so the
-- ALTER TABLE itself doesn't fail against existing rows.
UPDATE public.product_sizes SET stock = 0 WHERE stock < 0;

ALTER TABLE public.product_sizes
  ADD CONSTRAINT stock_non_negative CHECK (stock >= 0);
