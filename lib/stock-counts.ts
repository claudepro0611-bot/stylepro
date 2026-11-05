import type { TranslationKey } from '@/lib/i18n/translations'

// Local row types for the stock_counts / stock_count_items tables. These are
// declared here (instead of read from lib/database.types.ts) until the
// generated Supabase types include the new tables.

export type StockCountStatus = 'draft' | 'completed' | 'cancelled'

export interface StockCountRow {
  id: string
  number: number
  warehouse_id: string
  status: StockCountStatus
  note: string | null
  created_at: string
  completed_at: string | null
  zero_uncounted: boolean
}

export interface StockCountItemRow {
  id: string
  count_id: string
  product_size_id: string
  counted_qty: number
  expected_qty: number | null
  purchase_price: number | null
}

export const STOCK_COUNT_STATUS_LABEL_KEYS: Record<StockCountStatus, TranslationKey> = {
  draft: 'stockCount.status.draft',
  completed: 'stockCount.status.completed',
  cancelled: 'stockCount.status.cancelled',
}

export const STOCK_COUNT_STATUS_PILL: Record<StockCountStatus, string> = {
  draft: 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400',
  completed: 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400',
  cancelled: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
}

export function formatCountNumber(n: number): string {
  return `INV-${String(n).padStart(4, '0')}`
}

// Maps the RPC exception texts agreed with the DB layer to i18n keys.
const ERROR_KEYS: [string, TranslationKey][] = [
  ['forbidden', 'common.forbidden'],
  ['Warehouse not found', 'stockCount.errors.warehouseNotFound'],
  ['Open count exists', 'stockCount.errors.openExists'],
  ['Count not found', 'stockCount.errors.countNotFound'],
  ['Count is not open', 'stockCount.errors.countNotOpen'],
  ['Item not in this warehouse', 'stockCount.errors.itemNotInWarehouse'],
  ['Invalid quantity', 'stockCount.errors.invalidQuantity'],
  ['Completed count cannot be deleted', 'stockCount.errors.completedCannotDelete'],
]

export function stockCountErrorKey(message: string | undefined | null): TranslationKey {
  if (message) {
    for (const [needle, key] of ERROR_KEYS) if (message.includes(needle)) return key
  }
  return 'common.error'
}
