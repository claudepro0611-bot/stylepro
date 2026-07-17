-- Add barcode column to product_sizes
ALTER TABLE public.product_sizes
ADD COLUMN IF NOT EXISTS barcode text;

-- Make barcode unique per company (prevent duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS product_sizes_barcode_unique
ON public.product_sizes(company_id, barcode)
WHERE barcode IS NOT NULL;

-- Index for fast barcode lookup during scanning
CREATE INDEX IF NOT EXISTS product_sizes_barcode_lookup
ON public.product_sizes(barcode)
WHERE barcode IS NOT NULL;
