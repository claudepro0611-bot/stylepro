// Inventory documents of the production module (migration
// 20261110000014_production_inventory_docs.sql): write-offs, stock counts,
// opening balances, price corrections, lot hold, supplier ageing. Reads go
// to the RLS-scoped tables; every write goes through the SECURITY DEFINER
// RPCs (prod_create_writeoff, prod_save_stock_count, prod_post_stock_count,
// prod_delete_stock_count_draft, prod_create_opening,
// prod_create_price_correction, prod_set_lot_hold, prod_amend_milk_lab,
// prod_cancel_document). Every read degrades gracefully while the migration
// is not applied (probeInventoryDocs() = false -> pages show a note).

import type { TranslationKey } from '@/lib/i18n/translations'
import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { round2, round3 } from '@/lib/production'

type Client = ReturnType<typeof createClient>

let probe: Promise<boolean> | null = null

/**
 * Whether migration 20261110000014 is live (prod_writeoffs is readable).
 * Cached per page load; a failed probe is retried on the next call.
 */
export function probeInventoryDocs(supabase: Client): Promise<boolean> {
  if (!probe) {
    probe = Promise.resolve(supabase.from('prod_writeoffs').select('id').limit(1))
      .then(({ error }) => !error)
      .catch(() => false)
      .then(ok => {
        if (!ok) probe = null
        return ok
      })
  }
  return probe
}

// ---------------------------------------------------------------------------
// Write-offs

export const WRITEOFF_REASONS = ['spoiled', 'expired', 'damaged', 'lab_reject', 'sample', 'other'] as const
export type WriteoffReason = typeof WRITEOFF_REASONS[number]

export function writeoffReasonKey(reason: string): TranslationKey {
  return (WRITEOFF_REASONS as readonly string[]).includes(reason)
    ? (`prodInventory.reasons.${reason}` as TranslationKey)
    : 'prodInventory.reasons.other'
}

/** prod_create_writeoff / prod_create_opening accept 1..500 lines; stock counts 1..2000. */
export const INVENTORY_MAX_LINES = 500
export const STOCK_COUNT_MAX_LINES = 2000

export type StockCountStatus = 'draft' | 'posted' | 'cancelled'

// ---------------------------------------------------------------------------
// Price corrections

export interface PriceCorrection {
  id: string
  number: number
  docDate: string
  receiptId: string
  receiptItemId: string
  itemId: string
  warehouseId: string
  supplierId: string | null
  qty: number
  oldPrice: number
  newPrice: number
  debtDelta: number
  stockQty: number
  stockDelta: number
  consumedQty: number
  consumedVariance: number
  note: string
  status: string
  createdByName: string
  createdAt: string
  cancelledAt: string | null
}

export const PRICE_CORRECTION_COLS = 'id, number, doc_date, receipt_id, receipt_item_id, item_id, warehouse_id, supplier_id, qty, old_price, new_price, debt_delta, stock_qty, stock_delta, consumed_qty, consumed_variance, note, status, created_by_name, created_at, cancelled_at'

interface PriceCorrectionRow {
  id: string; number: number; doc_date: string; receipt_id: string; receipt_item_id: string; item_id: string
  warehouse_id: string; supplier_id: string | null; qty: number; old_price: number; new_price: number; debt_delta: number
  stock_qty: number; stock_delta: number; consumed_qty: number; consumed_variance: number; note: string | null
  status: string; created_by_name: string | null; created_at: string; cancelled_at: string | null
}

export function mapPriceCorrection(r: PriceCorrectionRow): PriceCorrection {
  return {
    id: r.id,
    number: r.number,
    docDate: r.doc_date,
    receiptId: r.receipt_id,
    receiptItemId: r.receipt_item_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    supplierId: r.supplier_id,
    qty: Number(r.qty),
    oldPrice: Number(r.old_price),
    newPrice: Number(r.new_price),
    debtDelta: Number(r.debt_delta),
    stockQty: Number(r.stock_qty),
    stockDelta: Number(r.stock_delta),
    consumedQty: Number(r.consumed_qty),
    consumedVariance: Number(r.consumed_variance),
    note: r.note ?? '',
    status: r.status,
    createdByName: r.created_by_name ?? '',
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
  }
}

/** Corrections of one receipt (all statuses, newest first); null when not available. */
export async function fetchReceiptCorrections(supabase: Client, receiptId: string): Promise<PriceCorrection[] | null> {
  const { data, error } = await supabase.from('prod_price_corrections').select(PRICE_CORRECTION_COLS)
    .eq('receipt_id', receiptId).order('number', { ascending: false })
  if (error) return null
  return ((data ?? []) as PriceCorrectionRow[]).map(mapPriceCorrection)
}

/** Effective line price = new_price of the latest posted correction of the line, else the line price. */
export function effectiveLinePrice(lineId: string, linePrice: number, corrections: PriceCorrection[]): number {
  const latest = corrections
    .filter(c => c.receiptItemId === lineId && c.status === 'posted')
    .sort((a, b) => b.number - a.number)[0]
  return latest ? latest.newPrice : linePrice
}

/** Ids of the corrections that may be cancelled: the latest posted one of each line. */
export function latestCorrectionIds(corrections: PriceCorrection[]): Set<string> {
  const best = new Map<string, PriceCorrection>()
  for (const c of corrections) {
    if (c.status !== 'posted') continue
    const cur = best.get(c.receiptItemId)
    if (!cur || c.number > cur.number) best.set(c.receiptItemId, c)
  }
  return new Set([...best.values()].map(c => c.id))
}

/** A lot of a receipt line that a correction would revalue (remaining > 0 in the receipt warehouse). */
export interface RevaluedLot { id: string; remaining: number; unitCost: number }

/**
 * Lots of one receipt line that still hold stock in the receipt warehouse:
 * the receipt lot plus the lots of earlier posted corrections of the line
 * (as prod_create_price_correction selects them). null when lots are not available.
 */
export async function fetchLineLots(
  supabase: Client,
  opts: { receiptId: string; warehouseId: string; itemId: string; correctionIds: string[] },
): Promise<RevaluedLot[] | null> {
  const sources = [opts.receiptId, ...opts.correctionIds]
  const { data, error } = await fetchAllRows((from, to) => supabase.from('prod_lot_stock')
    .select('id, remaining_qty, unit_cost, source_doc_type, source_doc_id')
    .eq('warehouse_id', opts.warehouseId).eq('item_id', opts.itemId).in('source_doc_id', sources)
    .gt('remaining_qty', 0).order('id').range(from, to))
  if (error) return null
  return data
    .filter(r => r.id && (r.source_doc_type === 'receipt' || r.source_doc_type === 'price_correction'))
    .map(r => ({ id: r.id as string, remaining: Number(r.remaining_qty ?? 0), unitCost: Number(r.unit_cost ?? 0) }))
}

export interface CorrectionPreview {
  debtDelta: number
  stockQty: number
  stockDelta: number
  consumedQty: number
  consumedVariance: number
}

/** Mirrors prod_create_price_correction's accounting and rounding. lots null = stock part unknown. */
export function previewCorrection(qty: number, oldPrice: number, newPrice: number, lots: RevaluedLot[] | null): CorrectionPreview {
  const diff = newPrice - oldPrice
  const stockQty = round3((lots ?? []).reduce((s, l) => s + l.remaining, 0))
  const stockDelta = round2((lots ?? []).reduce((s, l) => s + round2(l.remaining * newPrice) - round2(l.remaining * l.unitCost), 0))
  const consumedQty = Math.max(0, round3(qty - stockQty))
  return {
    debtDelta: round2(diff * qty),
    stockQty,
    stockDelta,
    consumedQty,
    consumedVariance: round2(diff * consumedQty),
  }
}

// ---------------------------------------------------------------------------
// Supplier ageing (prod_supplier_ageing)

export interface SupplierAgeing { balance: number; notDue: number; d1_15: number; d16_30: number; d31: number }

/** Ageing per supplier id; null when the view is not available. */
export async function fetchSupplierAgeing(supabase: Client): Promise<Map<string, SupplierAgeing> | null> {
  const { data, error } = await fetchAllRows((from, to) => supabase.from('prod_supplier_ageing')
    .select('supplier_id, balance, not_due, overdue_1_15, overdue_16_30, overdue_31_plus').order('supplier_id').range(from, to))
  if (error) return null
  return new Map(data.filter(r => r.supplier_id).map(r => [r.supplier_id as string, {
    balance: Number(r.balance ?? 0),
    notDue: Number(r.not_due ?? 0),
    d1_15: Number(r.overdue_1_15 ?? 0),
    d16_30: Number(r.overdue_16_30 ?? 0),
    d31: Number(r.overdue_31_plus ?? 0),
  }]))
}

// ---------------------------------------------------------------------------
// Recipe versions (prod_recipe_versions)

export interface RecipeVersionLine { itemId: string; qty: number; sortOrder: number; note: string }

export interface RecipeVersion {
  version: number
  outputItemId: string
  outputQty: number
  lines: RecipeVersionLine[]
  isActive: boolean | null
  note: string
  savedByName: string
  savedAt: string
}

function parseVersionLines(v: unknown): RecipeVersionLine[] {
  if (!Array.isArray(v)) return []
  return v
    .map(x => (x && typeof x === 'object' ? x as Record<string, unknown> : null))
    .filter((x): x is Record<string, unknown> => !!x && typeof x.item_id === 'string')
    .map(x => ({ itemId: x.item_id as string, qty: Number(x.qty ?? 0), sortOrder: Number(x.sort_order ?? 0), note: typeof x.note === 'string' ? x.note : '' }))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/** Every saved version of a recipe, newest first; null when not available. */
export async function fetchRecipeVersions(supabase: Client, recipeId: string): Promise<RecipeVersion[] | null> {
  const { data, error } = await supabase.from('prod_recipe_versions')
    .select('version, output_item_id, output_qty, lines, is_active, note, saved_by_name, saved_at')
    .eq('recipe_id', recipeId).order('version', { ascending: false })
  if (error) return null
  return (data ?? []).map(r => ({
    version: r.version,
    outputItemId: r.output_item_id,
    outputQty: Number(r.output_qty),
    lines: parseVersionLines(r.lines),
    isActive: r.is_active,
    note: r.note ?? '',
    savedByName: r.saved_by_name ?? '',
    savedAt: r.saved_at,
  }))
}

// ---------------------------------------------------------------------------
// Small parsers

/** '' -> null; a whole number min..max; undefined = invalid. */
export function parseIntInRange(v: string, min: number, max: number): number | null | undefined {
  const s = v.trim()
  if (!s) return null
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  return n >= min && n <= max ? n : undefined
}

/** '' -> null; a non-negative decimal (2 places); undefined = invalid. */
export function parseMoneyOrNull(v: string): number | null | undefined {
  const s = v.replace(',', '.').replace(/\s/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? round2(n) : undefined
}

/** '' -> null; a non-negative decimal (3 places), 0 allowed; undefined = invalid. */
export function parseQtyOrNull(v: string): number | null | undefined {
  const s = v.replace(',', '.').replace(/\s/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? round3(n) : undefined
}
