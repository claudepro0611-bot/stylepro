-- Add purchase_price and selling_price to stock_in_entries
ALTER TABLE public.stock_in_entries
  ADD COLUMN IF NOT EXISTS purchase_price numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selling_price numeric(14,2) DEFAULT 0;

-- Add entry_type to stock_out_entries to distinguish brak from normal sales
ALTER TABLE public.stock_out_entries
  ADD COLUMN IF NOT EXISTS entry_type text DEFAULT 'sale'
    CHECK (entry_type IN ('sale', 'brak'));
