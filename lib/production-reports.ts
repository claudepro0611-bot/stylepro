// Read-side helpers for the production reports (/zavod-hisobotlar): ledger
// reads, turnover aggregation, lot trace and exports. Everything here only
// SELECTs (RLS-scoped, company-filtered by get_company_id() in the policies);
// no report writes anything.
//
// Ledger model (migration 20261110000013, lots):
//   * every movement posted since the lots migration carries a lot_id;
//   * movements posted before it (lot_id NULL) were folded into one OPENING
//     lot per (warehouse, item) with opening_qty = their sum and no movement.
// The reports therefore read lot-bearing movements only and treat each
// opening lot as an inflow at the lot's created_at (the migration moment).
// This keeps every closing balance equal to prod_lot_stock / prod_stock, at
// the price of not showing pre-lot history movement by movement.

import { fetchAllRows } from '@/lib/supabase/helpers'
import type { createClient } from '@/lib/supabase/client'
import { localYmd } from '@/lib/utils/date'
import { downloadCsv } from '@/components/reports/ReportKit'
import { LOT_COLUMNS, mapLot, type LotColumnsRow, type ProdItem, type ProdLot } from '@/lib/production'
import type { TranslationKey } from '@/lib/i18n/translations'

type Client = ReturnType<typeof createClient>

/** Long id lists are split so a PostgREST `in.(...)` URL stays short. */
const IN_CHUNK = 150

/** Document types that appear in the ledger, plus the synthetic 'opening'. */
export const LEDGER_DOC_TYPES = [
  'opening', 'receipt', 'production', 'separation', 'processing', 'transfer', 'conversion',
  'writeoff', 'stock_count', 'opening_balance', 'price_correction', 'sale', 'sale_return',
] as const

export function docTypeKey(docType: string): TranslationKey {
  return (LEDGER_DOC_TYPES as readonly string[]).includes(docType)
    ? `prodReports.docTypes.${docType as typeof LEDGER_DOC_TYPES[number]}`
    : 'prodReports.docTypes.other'
}

/** View page of a production document; null when it has none (conversion, opening). */
export function docHref(docType: string | null | undefined, docId: string | null | undefined): string | null {
  if (!docType || !docId) return null
  switch (docType) {
    case 'receipt': return `/xom-ashyo-kirim/${docId}`
    case 'production': return `/ishlab-chiqarish/${docId}`
    case 'processing': return `/qayta-ishlash/${docId}`
    case 'transfer': return `/zavod-kochirish/${docId}`
    case 'separation': return `/separatsiya/${docId}`
    case 'writeoff': return `/zavod-hisobdan-chiqarish/${docId}`
    case 'stock_count': return `/zavod-inventarizatsiya/${docId}`
    case 'opening_balance': return `/zavod-boshlangich-qoldiq/${docId}`
    case 'price_correction': return '/zavod-narx-tuzatish'
    case 'sale': return `/zavod-sotuv/${docId}`
    case 'sale_return': return `/zavod-qaytarishlar/${docId}`
    default: return null
  }
}

export const lotTraceHref = (lotId: string) => `/zavod-hisobotlar/partiya/${lotId}`

/** Reads `ids` in IN_CHUNK slices, each slice fully paginated (1000-row pages). */
export async function fetchByIds<T>(
  ids: string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: unknown }> {
  const out: T[] = []
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK)
    const { data, error } = await fetchAllRows<T>((from, to) => build(chunk, from, to))
    if (error) return { data: out, error }
    out.push(...data)
  }
  return { data: out, error: null }
}

// ---------------------------------------------------------------------------
// Ledger events (movements + opening lots)

export interface LedgerEvent {
  warehouseId: string
  itemId: string
  /** Signed quantity (+ in, - out). */
  qty: number
  /** qty x unit_cost of the movement (signed). */
  value: number
  docType: string
  isReversal: boolean
  /** Epoch ms. */
  ts: number
  fat: number | null
}

interface MovementRow {
  warehouse_id: string
  item_id: string
  qty: number
  unit_cost: number
  doc_type: string
  is_reversal: boolean
  created_at: string
  fat_pct: number | null
}

interface OpeningLotRow {
  warehouse_id: string
  item_id: string
  opening_qty: number
  unit_cost: number
  created_at: string
  fat_pct: number | null
}

/**
 * Every lot-bearing movement and every opening lot created before `toIso`
 * (exclusive), optionally one warehouse and/or a set of items. Returns null
 * when a read fails.
 */
export async function fetchLedgerEvents(
  supabase: Client,
  opts: { toIso: string; warehouseId?: string; itemIds?: string[] | null },
): Promise<LedgerEvent[] | null> {
  // A very long item list is filtered client-side instead of in the URL.
  const serverItems = opts.itemIds && opts.itemIds.length <= IN_CHUNK ? opts.itemIds : null
  const itemSet = opts.itemIds ? new Set(opts.itemIds) : null
  if (opts.itemIds && opts.itemIds.length === 0) return []

  const [movRes, lotRes] = await Promise.all([
    fetchAllRows<MovementRow>((from, to) => {
      let q = supabase.from('prod_stock_movements')
        .select('warehouse_id, item_id, qty, unit_cost, doc_type, is_reversal, created_at, fat_pct')
        .not('lot_id', 'is', null)
        .lt('created_at', opts.toIso)
      if (opts.warehouseId) q = q.eq('warehouse_id', opts.warehouseId)
      if (serverItems) q = q.in('item_id', serverItems)
      return q.order('created_at').order('id').range(from, to)
    }),
    fetchAllRows<OpeningLotRow>((from, to) => {
      let q = supabase.from('prod_lots')
        .select('warehouse_id, item_id, opening_qty, unit_cost, created_at, fat_pct')
        .eq('is_opening', true)
        .lt('created_at', opts.toIso)
      if (opts.warehouseId) q = q.eq('warehouse_id', opts.warehouseId)
      if (serverItems) q = q.in('item_id', serverItems)
      return q.order('created_at').order('id').range(from, to)
    }),
  ])
  if (movRes.error || lotRes.error) return null

  const events: LedgerEvent[] = []
  for (const l of lotRes.data) {
    const qty = Number(l.opening_qty)
    if (qty === 0 || (itemSet && !itemSet.has(l.item_id))) continue
    events.push({
      warehouseId: l.warehouse_id, itemId: l.item_id, qty, value: qty * Number(l.unit_cost),
      docType: 'opening', isReversal: false, ts: new Date(l.created_at).getTime(), fat: l.fat_pct === null ? null : Number(l.fat_pct),
    })
  }
  for (const m of movRes.data) {
    if (itemSet && !itemSet.has(m.item_id)) continue
    const qty = Number(m.qty)
    events.push({
      warehouseId: m.warehouse_id, itemId: m.item_id, qty, value: qty * Number(m.unit_cost),
      docType: m.doc_type, isReversal: !!m.is_reversal, ts: new Date(m.created_at).getTime(), fat: m.fat_pct === null ? null : Number(m.fat_pct),
    })
  }
  return events
}

// ---------------------------------------------------------------------------
// Turnover (oborot) aggregation

export interface Flow { qty: number; value: number }

const zero = (): Flow => ({ qty: 0, value: 0 })

export interface TurnoverRow {
  key: string
  /** null when rows are aggregated over every warehouse. */
  warehouseId: string | null
  itemId: string
  opening: Flow
  inflow: Flow
  outflow: Flow
  closing: Flow
  /** In / out of the period per doc_type (reversals net against their direction). */
  byDocType: Map<string, { in: Flow; out: Flow }>
  /** Weighted fat % of the closing balance; null when the item tracks no fat. */
  closingFat: number | null
}

const EPS = 0.0005

/**
 * Splits events into opening (< fromMs), period [fromMs, toMs) and closing
 * (opening + period). A reversal is booked against the direction it undoes:
 * an inflow storno lowers inflow, an outflow storno lowers outflow, so a
 * document posted and cancelled in the same period nets to zero.
 * fromMs = null: no opening (everything is in the period).
 */
export function aggregateTurnover(
  events: LedgerEvent[],
  opts: { fromMs: number | null; toMs: number; byWarehouse: boolean },
): TurnoverRow[] {
  const rows = new Map<string, TurnoverRow & { fatQty: number; fatSum: number }>()
  for (const e of events) {
    if (e.ts >= opts.toMs) continue
    const key = opts.byWarehouse ? `${e.warehouseId}:${e.itemId}` : e.itemId
    let r = rows.get(key)
    if (!r) {
      r = {
        key, warehouseId: opts.byWarehouse ? e.warehouseId : null, itemId: e.itemId,
        opening: zero(), inflow: zero(), outflow: zero(), closing: zero(), byDocType: new Map(), closingFat: null,
        fatQty: 0, fatSum: 0,
      }
      rows.set(key, r)
    }
    r.closing.qty += e.qty
    r.closing.value += e.value
    if (e.fat !== null) { r.fatQty += e.qty; r.fatSum += e.qty * e.fat }

    if (opts.fromMs !== null && e.ts < opts.fromMs) {
      r.opening.qty += e.qty
      r.opening.value += e.value
      continue
    }
    let dt = r.byDocType.get(e.docType)
    if (!dt) { dt = { in: zero(), out: zero() }; r.byDocType.set(e.docType, dt) }
    const isIn = e.isReversal ? e.qty < 0 : e.qty > 0
    if (isIn) {
      r.inflow.qty += e.qty; r.inflow.value += e.value
      dt.in.qty += e.qty; dt.in.value += e.value
    } else {
      r.outflow.qty -= e.qty; r.outflow.value -= e.value
      dt.out.qty -= e.qty; dt.out.value -= e.value
    }
  }
  const out: TurnoverRow[] = []
  for (const r of rows.values()) {
    const touched = [r.opening, r.inflow, r.outflow, r.closing].some(f => Math.abs(f.qty) > EPS || Math.abs(f.value) > 0.005)
    if (!touched) continue
    const { fatQty, fatSum, ...row } = r
    out.push({ ...row, closingFat: Math.abs(fatQty) > EPS ? fatSum / fatQty : null })
  }
  return out
}

// ---------------------------------------------------------------------------
// Mass helpers (loss / yield)

/**
 * Quantity in kg when it can be expressed as mass: kg, g, and pieces / litres
 * of an item with weight_kg set (weight of one unit). null otherwise.
 */
export function toKg(qty: number, item: Pick<ProdItem, 'unit' | 'weightKg'> | undefined): number | null {
  if (!item) return null
  if (item.unit === 'kg') return qty
  if (item.unit === 'g') return qty / 1000
  if ((item.unit === 'pcs' || item.unit === 'l') && item.weightKg != null && item.weightKg > 0) return qty * item.weightKg
  return null
}

// ---------------------------------------------------------------------------
// Lot trace (partiya kuzatuvi)

export interface TraceMovement {
  id: string
  docType: string
  docId: string
  qty: number
  unitCost: number
  createdAt: string
  isReversal: boolean
  warehouseId: string
}

export interface TraceDocLink { docType: string; docId: string; nodes: TraceNode[] }

export interface TraceNode {
  lot: ProdLot
  movements: TraceMovement[]
  /** Documents that consumed this lot and the lots they produced (depth-limited). */
  children: TraceDocLink[]
  /** True when the depth limit stopped the walk below this node. */
  truncated: boolean
}

export interface TraceInput { lotId: string; lot: ProdLot | null; itemId: string; qty: number; unitCost: number }

export interface LotTrace {
  root: TraceNode
  /** origin_lot_id chain, nearest first (transfer / unit change ancestors). */
  chain: ProdLot[]
  /** Lots consumed by the source document of the earliest ancestor. */
  inputs: TraceInput[]
  /** Milk intake behind a receipt lot, when any. */
  intake: { id: string; number: number } | null
  /** "docType:docId" -> document number. */
  docNumbers: Map<string, number>
  /** Sale id -> customer (recall: who received the lot). Empty while sales are not available. */
  saleCustomers: Map<string, { customerId: string; name: string }>
}

interface TraceMovementRow {
  id: string
  lot_id: string | null
  doc_type: string
  doc_id: string
  qty: number
  unit_cost: number
  created_at: string
  is_reversal: boolean
  warehouse_id: string
}

const MOVEMENT_COLS = 'id, lot_id, doc_type, doc_id, qty, unit_cost, created_at, is_reversal, warehouse_id'

function toTraceMovement(m: TraceMovementRow): TraceMovement {
  return {
    id: m.id, docType: m.doc_type, docId: m.doc_id, qty: Number(m.qty), unitCost: Number(m.unit_cost),
    createdAt: m.created_at, isReversal: !!m.is_reversal, warehouseId: m.warehouse_id,
  }
}

async function fetchLotsByIds(supabase: Client, ids: string[]): Promise<Map<string, ProdLot> | null> {
  const res = await fetchByIds<LotColumnsRow>(ids, (chunk, from, to) =>
    supabase.from('prod_lot_stock').select(LOT_COLUMNS).in('id', chunk).order('lot_no').range(from, to))
  if (res.error) return null
  return new Map(res.data.filter(r => r.id).map(r => [r.id as string, mapLot(r)]))
}

const DOC_TABLES = {
  receipt: 'prod_receipts',
  production: 'prod_productions',
  processing: 'prod_processings',
  transfer: 'prod_transfers',
  separation: 'prod_separations',
  writeoff: 'prod_writeoffs',
  stock_count: 'prod_stock_counts',
  opening_balance: 'prod_openings',
  price_correction: 'prod_price_corrections',
  sale: 'prod_sales',
  sale_return: 'prod_sale_returns',
} as const

/** Document numbers for display, keyed "docType:docId". Missing on read errors. */
export async function fetchDocNumbers(supabase: Client, docs: { docType: string; docId: string }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const byType = new Map<keyof typeof DOC_TABLES, string[]>()
  for (const d of docs) {
    if (!(d.docType in DOC_TABLES)) continue
    const k = d.docType as keyof typeof DOC_TABLES
    const arr = byType.get(k)
    if (arr) arr.push(d.docId)
    else byType.set(k, [d.docId])
  }
  await Promise.all([...byType.entries()].map(async ([type, ids]) => {
    const res = await fetchByIds<{ id: string; number: number }>(ids, (chunk, from, to) =>
      supabase.from(DOC_TABLES[type]).select('id, number').in('id', chunk).order('id').range(from, to))
    for (const r of res.data) out.set(`${type}:${r.id}`, r.number)
  }))
  return out
}

/** Single-source documents: what they produce comes from one lot (origin_lot_id). */
const ORIGIN_DOCS = new Set(['transfer', 'conversion'])

/**
 * Upstream (origin chain, source document, its consumed lots, milk intake) and
 * downstream (movements -> consuming documents -> lots they produced, up to
 * `depth` levels) of one lot. null when the lot is not found or a read fails.
 */
export async function fetchLotTrace(supabase: Client, lotId: string, depth = 3): Promise<LotTrace | null> {
  try {
    const { data: lotRow, error } = await supabase.from('prod_lot_stock').select(LOT_COLUMNS).eq('id', lotId).maybeSingle()
    if (error || !lotRow?.id) return null
    const lot = mapLot(lotRow)

    // Upstream: origin chain (cycle-safe, max 20 hops).
    const chain: ProdLot[] = []
    const seenUp = new Set([lot.id])
    let cur = lot
    while (cur.originLotId && !seenUp.has(cur.originLotId) && chain.length < 20) {
      const { data } = await supabase.from('prod_lot_stock').select(LOT_COLUMNS).eq('id', cur.originLotId).maybeSingle()
      if (!data?.id) break
      cur = mapLot(data)
      seenUp.add(cur.id)
      chain.push(cur)
    }
    const earliest = chain.length ? chain[chain.length - 1] : lot

    let inputs: TraceInput[] = []
    if (earliest.sourceDocId && earliest.sourceDocType && !ORIGIN_DOCS.has(earliest.sourceDocType) && earliest.sourceDocType !== 'receipt') {
      const { data: inMovs } = await supabase.from('prod_stock_movements').select(MOVEMENT_COLS)
        .eq('doc_id', earliest.sourceDocId).eq('doc_type', earliest.sourceDocType).eq('is_reversal', false)
        .lt('qty', 0).not('lot_id', 'is', null).order('created_at').order('id')
      const rows = (inMovs ?? []) as TraceMovementRow[]
      const lotsById = await fetchLotsByIds(supabase, rows.map(r => r.lot_id as string)) ?? new Map<string, ProdLot>()
      inputs = rows.map(r => {
        const l = lotsById.get(r.lot_id as string) ?? null
        return { lotId: r.lot_id as string, lot: l, itemId: l?.itemId ?? '', qty: Math.abs(Number(r.qty)), unitCost: Number(r.unit_cost) }
      })
    }

    let intake: LotTrace['intake'] = null
    if (earliest.sourceDocType === 'receipt' && earliest.sourceDocId) {
      const { data } = await supabase.from('prod_milk_intakes').select('id, number')
        .eq('receipt_id', earliest.sourceDocId).neq('status', 'cancelled').limit(1).maybeSingle()
      intake = data ?? null
    }

    // Downstream, level by level.
    const root: TraceNode = { lot, movements: [], children: [], truncated: false }
    const visited = new Set([lot.id])
    let level: TraceNode[] = [root]
    for (let d = 0; d <= depth && level.length; d++) {
      const ids = level.map(n => n.lot.id)
      const movRes = await fetchByIds<TraceMovementRow>(ids, (chunk, from, to) =>
        supabase.from('prod_stock_movements').select(MOVEMENT_COLS).in('lot_id', chunk).order('created_at').order('id').range(from, to))
      if (movRes.error) return null
      const byLot = new Map<string, TraceMovement[]>()
      for (const m of movRes.data) {
        const arr = byLot.get(m.lot_id as string)
        if (arr) arr.push(toTraceMovement(m))
        else byLot.set(m.lot_id as string, [toTraceMovement(m)])
      }
      for (const n of level) n.movements = byLot.get(n.lot.id) ?? []

      // Consuming documents of this level (outflows that are not reversals).
      const docsOf = (n: TraceNode) => {
        const m = new Map<string, { docType: string; docId: string }>()
        for (const mv of n.movements) {
          if (mv.qty < 0 && !mv.isReversal && mv.docId !== n.lot.sourceDocId) m.set(`${mv.docType}:${mv.docId}`, { docType: mv.docType, docId: mv.docId })
        }
        return [...m.values()]
      }
      if (d === depth) {
        for (const n of level) n.truncated = docsOf(n).length > 0
        break
      }
      const docIds = [...new Set(level.flatMap(n => docsOf(n).map(x => x.docId)))]
      const prodRes = await fetchByIds<LotColumnsRow>(docIds, (chunk, from, to) =>
        supabase.from('prod_lot_stock').select(LOT_COLUMNS).in('source_doc_id', chunk).order('lot_no').range(from, to))
      if (prodRes.error) return null
      const producedByDoc = new Map<string, ProdLot[]>()
      for (const r of prodRes.data) {
        if (!r.id) continue
        const l = mapLot(r)
        const arr = producedByDoc.get(l.sourceDocId as string)
        if (arr) arr.push(l)
        else producedByDoc.set(l.sourceDocId as string, [l])
      }
      const next: TraceNode[] = []
      for (const n of level) {
        n.children = docsOf(n).map(doc => {
          const produced = (producedByDoc.get(doc.docId) ?? [])
            .filter(l => !ORIGIN_DOCS.has(doc.docType) || l.originLotId === n.lot.id)
          const nodes = produced.filter(l => !visited.has(l.id)).map(l => {
            visited.add(l.id)
            const child: TraceNode = { lot: l, movements: [], children: [], truncated: false }
            next.push(child)
            return child
          })
          return { docType: doc.docType, docId: doc.docId, nodes }
        })
      }
      level = next
    }

    // Document numbers for every document on the page.
    const docs: { docType: string; docId: string }[] = []
    const collect = (n: TraceNode) => {
      for (const m of n.movements) docs.push({ docType: m.docType, docId: m.docId })
      if (n.lot.sourceDocType && n.lot.sourceDocId) docs.push({ docType: n.lot.sourceDocType, docId: n.lot.sourceDocId })
      n.children.forEach(c => c.nodes.forEach(collect))
    }
    collect(root)
    for (const l of chain) if (l.sourceDocType && l.sourceDocId) docs.push({ docType: l.sourceDocType, docId: l.sourceDocId })
    const docNumbers = await fetchDocNumbers(supabase, docs)

    // Recall: customers of the sales that consumed any lot on the page.
    const saleCustomers = new Map<string, { customerId: string; name: string }>()
    const saleIds = [...new Set(docs.filter(d => d.docType === 'sale').map(d => d.docId))]
    if (saleIds.length) {
      const sRes = await fetchByIds<{ id: string; customer_id: string; customer_name: string | null }>(saleIds, (chunk, from, to) =>
        supabase.from('prod_sales').select('id, customer_id, customer_name').in('id', chunk).order('id').range(from, to))
      for (const s of sRes.data) saleCustomers.set(s.id, { customerId: s.customer_id, name: s.customer_name ?? '' })
    }

    return { root, chain, inputs, intake, docNumbers, saleCustomers }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Expiry buckets

export type ExpiryBucket = 'expired' | 'd3' | 'd7' | 'later'

export const EXPIRY_BUCKETS: ExpiryBucket[] = ['expired', 'd3', 'd7', 'later']

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  d.setDate(d.getDate() + days)
  return localYmd(d)
}

/**
 * expiryDate "YYYY-MM-DD" -> bucket relative to today. 'd3' = "expiring
 * soon": within the item's expiry_warn_days (default 3), 'd7' = within 7 days.
 */
export function expiryBucket(expiryDate: string, today: string, warnDays = 3): ExpiryBucket {
  if (expiryDate < today) return 'expired'
  if (expiryDate <= addDaysYmd(today, warnDays > 0 ? warnDays : 3)) return 'd3'
  if (expiryDate <= addDaysYmd(today, 7)) return 'd7'
  return 'later'
}

/** Whole days from today to the expiry date (negative = days overdue). */
export function daysUntil(expiryDate: string, today: string): number {
  const a = new Date(`${today}T00:00:00`).getTime()
  const b = new Date(`${expiryDate}T00:00:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

// ---------------------------------------------------------------------------
// Export

export type ExportCell = string | number | null | undefined

/**
 * .xlsx download through SheetJS (already a dependency, loaded on demand so
 * the report bundles stay small); falls back to the shared CSV helper when
 * the library cannot be loaded. Numbers stay numbers so Excel can sum them.
 */
export async function downloadXlsx(filename: string, headers: string[], rows: ExportCell[][], sheetName = 'Data') {
  const clean = rows.map(r => r.map(c => (c === null || c === undefined ? '' : c)))
  try {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([headers, ...clean])
    ws['!cols'] = headers.map((h, i) => ({
      wch: Math.min(40, Math.max(h.length, ...clean.slice(0, 200).map(r => String(r[i] ?? '').length)) + 2),
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
    XLSX.writeFile(wb, `${filename}_${localYmd()}.xlsx`)
  } catch {
    downloadCsv(filename, headers, clean)
  }
}

/** Rounds for export cells (avoids 0.30000000000000004 in Excel). */
export const x2 = (n: number) => Math.round(n * 100) / 100
export const x3 = (n: number) => Math.round(n * 1000) / 1000

/** Local date "YYYY-MM-DD" of an ISO timestamp, for export / grouping. */
export const ymdOf = (iso: string) => localYmd(new Date(iso))

/** "YYYY-MM-DD HH:mm" local time of an ISO timestamp, for export cells. */
export function dateTimeCell(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${localYmd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Milk intake aggregation (Sut qabuli report, supplier quality, dashboard)

export interface MilkIntakeLite {
  id: string
  intake_date: string
  supplier_id: string
  status: string
  net_kg: number
  fat_pct: number | null
  protein_pct: number | null
  acidity: number | null
  amount: number | null
}

export const MILK_INTAKE_COLS = 'id, intake_date, supplier_id, status, net_kg, fat_pct, protein_pct, acidity, amount'

export interface MilkAgg {
  key: string
  /** Every non-cancelled intake. */
  count: number
  /** accepted + conditional (went to stock). */
  receivedKg: number
  /** kg-weighted averages; null without measurements. */
  fat: number | null
  protein: number | null
  acidity: number | null
  amount: number
  conditional: number
  rejected: number
  rejectedKg: number
  /** Weighed, lab pending. */
  pending: number
}

/**
 * Groups intakes by `keyOf`. Cancelled intakes are ignored. Quality averages
 * are kg-weighted over `quality`: 'received' (accepted + conditional, the
 * milk that was paid for) or 'tested' (also rejected: supplier quality).
 */
export function aggregateMilk(rows: MilkIntakeLite[], keyOf: (r: MilkIntakeLite) => string, quality: 'received' | 'tested' = 'received'): MilkAgg[] {
  const m = new Map<string, MilkAgg & { fw: number; fs: number; pw: number; ps: number; aw: number; asum: number }>()
  for (const r of rows) {
    if (r.status === 'cancelled') continue
    const key = keyOf(r)
    let a = m.get(key)
    if (!a) {
      a = { key, count: 0, receivedKg: 0, fat: null, protein: null, acidity: null, amount: 0, conditional: 0, rejected: 0, rejectedKg: 0, pending: 0, fw: 0, fs: 0, pw: 0, ps: 0, aw: 0, asum: 0 }
      m.set(key, a)
    }
    const kg = Number(r.net_kg)
    a.count++
    const received = r.status === 'accepted' || r.status === 'conditional'
    if (received) { a.receivedKg += kg; a.amount += Number(r.amount ?? 0) }
    if (r.status === 'conditional') a.conditional++
    if (r.status === 'rejected') { a.rejected++; a.rejectedKg += kg }
    if (r.status === 'weighed') a.pending++
    if (received || (quality === 'tested' && r.status === 'rejected')) {
      if (r.fat_pct !== null) { a.fw += kg; a.fs += kg * Number(r.fat_pct) }
      if (r.protein_pct !== null) { a.pw += kg; a.ps += kg * Number(r.protein_pct) }
      if (r.acidity !== null) { a.aw += kg; a.asum += kg * Number(r.acidity) }
    }
  }
  return [...m.values()].map(({ fw, fs, pw, ps, aw, asum, ...a }) => ({
    ...a,
    fat: fw > 0 ? fs / fw : null,
    protein: pw > 0 ? ps / pw : null,
    acidity: aw > 0 ? asum / aw : null,
  }))
}
