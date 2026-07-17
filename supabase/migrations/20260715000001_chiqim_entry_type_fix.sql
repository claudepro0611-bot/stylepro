-- Phase 1 regression fix: manual chiqim was wired to stock_out(p_entry_type
-- => 'sale'), indistinguishable from a real POS sale in stock_out_entries.
-- Add a distinct 'manual' entry_type for it.

ALTER TABLE public.stock_out_entries
  DROP CONSTRAINT stock_out_entries_entry_type_check;

ALTER TABLE public.stock_out_entries
  ADD CONSTRAINT stock_out_entries_entry_type_check
  CHECK (entry_type IN ('sale', 'brak', 'manual'));

-- One-off backfill: a 'sale' row is only reclassified to 'manual' if it has
-- no plausible matching transactions/transaction_items row (same company,
-- product, quantity, price and date) — i.e. it could not have come from a
-- POS sell_cart call. There is no FK from stock_out_entries back to
-- transactions, so this is a heuristic, not a certainty.
--
-- On the linked database as of this migration, this UPDATE affects 0 rows:
-- every existing entry_type='sale' row has a matching transaction_items
-- row, so none are distinguishable as chiqim-origin. It's included anyway
-- so any other environment with real historical chiqim rows gets corrected.
UPDATE public.stock_out_entries soe
SET entry_type = 'manual'
WHERE soe.entry_type = 'sale'
  AND NOT EXISTS (
    SELECT 1 FROM public.transaction_items ti
    JOIN public.transactions t ON t.id = ti.transaction_id
    WHERE ti.company_id = soe.company_id
      AND ti.product_id = soe.product_id
      AND ti.quantity = soe.quantity
      AND ti.price = soe.sell_price
      AND t.date = soe.date
  );
