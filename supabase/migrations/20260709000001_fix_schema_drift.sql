-- Fix schema drift: product_sizes was missing columns the app already queries
ALTER TABLE public.product_sizes
  ADD COLUMN IF NOT EXISTS purchase_price numeric(14,2),
  ADD COLUMN IF NOT EXISTS selling_price numeric(14,2),
  ADD COLUMN IF NOT EXISTS sku text;
