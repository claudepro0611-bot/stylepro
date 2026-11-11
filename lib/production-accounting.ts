// Production accounting core (migration 20261110000018): accounting
// settings, purchase VAT math, co-product split preview, overhead pools /
// allocation reads, P&L and the server-side report RPCs. Every write goes
// through the SECURITY DEFINER RPCs; the client only previews with the same
// formulas. Every read degrades to "not available" (defaults / null) while
// the migration is not applied.

import type { TranslationKey } from '@/lib/i18n/translations'
import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { round2, type ProdItem, type ProdRpcError } from '@/lib/production'
import { prodErrorText } from '@/lib/production-controls'
import { toKg, type TurnoverRow } from '@/lib/production-reports'

type Client = ReturnType<typeof createClient>

// ---------------------------------------------------------------------------
// RPC availability

/** True when PostgREST could not find the function (migration not applied). */
export function isMissingRpc(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string | null; message?: string | null }
  if (e.code === 'PGRST202' || e.code === '42883') return true
  const m = e.message ?? ''
  return /could not find the function|function .* does not exist/i.test(m)
}

export type RpcOutcome<T> = { status: 'ok'; data: T } | { status: 'missing' } | { status: 'error'; error: ProdRpcError }

async function callRpc<T>(p: PromiseLike<{ data: unknown; error: { message: string; details?: string | null; code?: string } | null }>): Promise<RpcOutcome<T>> {
  try {
    const { data, error } = await p
    if (error) return isMissingRpc(error) ? { status: 'missing' } : { status: 'error', error }
    return { status: 'ok', data: data as T }
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : 'unknown' }
  }
}

// ---------------------------------------------------------------------------
// Settings

export const OVERHEAD_METHODS = ['per_kg', 'per_value', 'manual'] as const
export type OverheadMethod = typeof OVERHEAD_METHODS[number]

export interface AccountingSettings {
  vatPayer: boolean
  overheadMethod: OverheadMethod
  baseCurrency: string
  updatedAt: string | null
}

export const DEFAULT_ACCOUNTING: AccountingSettings = { vatPayer: false, overheadMethod: 'per_kg', baseCurrency: 'UZS', updatedAt: null }

export interface AccountingState {
  /** false while migration 20261110000018 is not applied. */
  available: boolean
  settings: AccountingSettings
}

interface AccountingRow { vat_payer?: boolean | null; overhead_method?: string | null; base_currency?: string | null; updated_at?: string | null }

export function mapAccounting(r: AccountingRow | null | undefined): AccountingSettings {
  if (!r) return DEFAULT_ACCOUNTING
  const m = (OVERHEAD_METHODS as readonly string[]).includes(r.overhead_method ?? '') ? (r.overhead_method as OverheadMethod) : 'per_kg'
  return { vatPayer: !!r.vat_payer, overheadMethod: m, baseCurrency: r.base_currency ?? 'UZS', updatedAt: r.updated_at ?? null }
}

export async function fetchAccounting(supabase: Client): Promise<AccountingState> {
  try {
    const { data, error } = await supabase.from('prod_company_accounting').select('vat_payer, overhead_method, base_currency, updated_at').maybeSingle()
    if (error) return { available: false, settings: DEFAULT_ACCOUNTING }
    return { available: true, settings: mapAccounting(data) }
  } catch {
    return { available: false, settings: DEFAULT_ACCOUNTING }
  }
}

export const overheadMethodKey = (m: string): TranslationKey =>
  (OVERHEAD_METHODS as readonly string[]).includes(m) ? (`prodAcct.settings.methods.${m as OverheadMethod}` as TranslationKey) : 'prodAcct.settings.methods.per_kg'

// ---------------------------------------------------------------------------
// Purchase VAT (same formulas as prod_vat_split / prod_vat_unit_cost)

export const STANDARD_VAT_RATE = 12

export interface VatSplit { net: number; vat: number; gross: number }

/**
 * rate 0 -> gross = round(q*p, 2); prices excl. VAT -> net = round(q*p, 2),
 * vat = round(net*r/100, 2), gross = net + vat; prices incl. VAT -> gross =
 * round(q*p, 2), vat = round(gross*r/(100+r), 2), net = gross - vat.
 */
export function vatSplit(qty: number, price: number, rate: number, pricesIncludeVat: boolean): VatSplit {
  const base = round2(qty * price)
  if (!(rate > 0)) return { net: base, vat: 0, gross: base }
  if (pricesIncludeVat) {
    const vat = round2((base * rate) / (100 + rate))
    return { net: round2(base - vat), vat, gross: base }
  }
  const vat = round2((base * rate) / 100)
  return { net: base, vat, gross: round2(base + vat) }
}

/** Lot unit cost of an entered price: ex VAT for a VAT payer (deductible), incl. VAT otherwise. */
export function vatUnitCost(price: number, rate: number, pricesIncludeVat: boolean, deductible: boolean): number {
  if (!(rate > 0)) return price
  if (deductible) return pricesIncludeVat ? round2((price * 100) / (100 + rate)) : price
  return pricesIncludeVat ? price : round2((price * (100 + rate)) / 100)
}

/** Parses a VAT rate (0..100, 2 decimals); null when invalid. */
export function parseVatRate(v: string): number | null {
  const s = v.replace(',', '.').trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// Co-products (same split as prod_create_production)

export const ALLOCATION_METHODS = ['mass', 'value', 'fixed'] as const
export type AllocationMethod = typeof ALLOCATION_METHODS[number]

export interface SplitInput { item: ProdItem | undefined; qty: number; refPrice: number | null; sharePct: number | null }
export interface SplitRow { weight: number | null; sharePct: number; cost: number; unitCost: number }
export type SplitError = 'output_weight' | 'ref_price' | 'share_pct' | null

/**
 * Weights: one output -> 1; mass -> kg-equivalent; value -> ref price (else
 * the item's sale price) x qty; fixed -> share %. cost_i = round(total * w_i
 * / sum w, 2), the last output takes the remainder; unit cost = round(cost /
 * qty, 2).
 */
export function splitCost(total: number, outputs: SplitInput[], method: AllocationMethod): { rows: SplitRow[]; error: SplitError } {
  const n = outputs.length
  let error: SplitError = null
  const weights = outputs.map(o => {
    if (n === 1) return 1
    if (method === 'mass') {
      const w = o.item ? toKg(o.qty, o.item) : null
      if (w === null) error = error ?? 'output_weight'
      return w
    }
    if (method === 'value') {
      const p = o.refPrice ?? (o.item?.salePrice ?? null)
      if (p === null || p === undefined) { error = error ?? 'ref_price'; return null }
      return p * o.qty
    }
    if (o.sharePct === null) { error = error ?? 'share_pct'; return null }
    return o.sharePct
  })
  const sum = weights.reduce<number>((s, w) => s + (w ?? 0), 0)
  if (n > 1 && method === 'fixed' && Math.abs(sum - 100) > 1e-9) error = error ?? 'share_pct'
  if (n > 1 && !error && !(sum > 0)) error = method === 'mass' ? 'output_weight' : method === 'value' ? 'ref_price' : 'share_pct'
  let used = 0
  const rows = outputs.map((o, i) => {
    const w = weights[i]
    const share = sum > 0 && w !== null ? (w / sum) * 100 : 0
    let cost: number
    if (i < n - 1) cost = sum > 0 && w !== null ? round2((total * w) / sum) : 0
    else cost = round2(total - used)
    used = round2(used + cost)
    return { weight: w, sharePct: share, cost, unitCost: o.qty > 0 ? round2(cost / o.qty) : 0 }
  })
  return { rows, error }
}

export interface ProductionOutput {
  id: string
  productionId: string
  sortOrder: number
  itemId: string
  warehouseId: string
  qty: number
  sharePct: number
  refPrice: number | null
  cost: number
  unitCost: number
  lotId: string | null
}

/** Outputs of one production; null while the table does not exist. */
export async function fetchProductionOutputs(supabase: Client, productionId: string): Promise<ProductionOutput[] | null> {
  const { data, error } = await supabase.from('prod_production_outputs').select('*').eq('production_id', productionId).order('sort_order')
  if (error) return null
  return (data ?? []).map(r => ({
    id: r.id, productionId: r.production_id, sortOrder: r.sort_order, itemId: r.item_id, warehouseId: r.warehouse_id,
    qty: Number(r.qty), sharePct: Number(r.share_pct), refPrice: r.ref_price === null ? null : Number(r.ref_price),
    cost: Number(r.cost), unitCost: Number(r.unit_cost), lotId: r.lot_id,
  }))
}

export interface RecipeOutput { itemId: string; qtyPerBatch: number }

/** By-products of a recipe; null while the table does not exist. */
export async function fetchRecipeOutputs(supabase: Client, recipeId: string): Promise<RecipeOutput[] | null> {
  const { data, error } = await supabase.from('prod_recipe_outputs').select('item_id, qty_per_batch, sort_order').eq('recipe_id', recipeId).order('sort_order')
  if (error) return null
  return (data ?? []).map(r => ({ itemId: r.item_id, qtyPerBatch: Number(r.qty_per_batch) }))
}

// ---------------------------------------------------------------------------
// Overhead pools

export const POOL_CATEGORIES = ['labour', 'energy', 'gas', 'water', 'rent', 'depreciation', 'repair', 'other'] as const
export type PoolCategory = typeof POOL_CATEGORIES[number]

export const poolCategoryKey = (c: string): TranslationKey =>
  (POOL_CATEGORIES as readonly string[]).includes(c) ? (`prodAcct.pools.categories.${c as PoolCategory}` as TranslationKey) : 'prodAcct.pools.categories.other'

export interface CostPool {
  id: string
  period: string
  category: string
  amount: number
  expenseCategoryId: string | null
  note: string
  status: string
  createdByName: string
  createdAt: string
}

/** "YYYY-MM" -> "YYYY-MM-01". */
export const monthStart = (ym: string) => `${ym.slice(0, 7)}-01`

export async function fetchCostPools(supabase: Client, period: string): Promise<CostPool[] | null> {
  const { data, error } = await supabase.from('prod_cost_pools').select('*').eq('period', period).order('created_at')
  if (error) return null
  return (data ?? []).map(r => ({
    id: r.id, period: r.period, category: r.category, amount: Number(r.amount), expenseCategoryId: r.expense_category_id,
    note: r.note ?? '', status: r.status, createdByName: r.created_by_name ?? '', createdAt: r.created_at,
  }))
}

export interface PoolSuggestion { expenseCategoryId: string | null; name: string; cashAmount: number; supplyAmount: number; amount: number; docCount: number; pooled: boolean }

export async function fetchPoolSuggestions(supabase: Client, period: string): Promise<PoolSuggestion[]> {
  const { data, error } = await supabase.from('prod_cost_pool_suggestions').select('*').eq('period', period)
  if (error) return []
  return (data ?? []).map(r => ({
    expenseCategoryId: r.expense_category_id, name: r.category_name ?? '', cashAmount: Number(r.cash_amount ?? 0),
    supplyAmount: Number(r.supply_amount ?? 0), amount: Number(r.amount ?? 0), docCount: Number(r.doc_count ?? 0), pooled: !!r.pooled,
  })).sort((a, b) => b.amount - a.amount)
}

export interface OverheadAllocation { outputId: string; productionId: string; itemId: string; method: string; base: number; amount: number; poolTotal: number }

export async function fetchAllocations(supabase: Client, period: string): Promise<OverheadAllocation[]> {
  const { data, error } = await fetchAllRows((from, to) => supabase.from('prod_overhead_allocations')
    .select('output_id, production_id, item_id, method, base, amount, pool_total').eq('period', period).order('id').range(from, to))
  if (error) return []
  return data.map(r => ({
    outputId: r.output_id, productionId: r.production_id, itemId: r.item_id, method: r.method,
    base: Number(r.base), amount: Number(r.amount), poolTotal: Number(r.pool_total),
  }))
}

export interface MonthOutput extends ProductionOutput { productionNumber: number; docDate: string }

/** Outputs of the posted productions of a month (manual allocation / result table). */
export async function fetchMonthOutputs(supabase: Client, fromIso: string, toIso: string): Promise<MonthOutput[]> {
  const { data: prods, error } = await fetchAllRows((from, to) => supabase.from('prod_productions')
    .select('id, number, doc_date').eq('status', 'posted').gte('doc_date', fromIso).lt('doc_date', toIso)
    .order('doc_date').order('id').range(from, to))
  if (error || prods.length === 0) return []
  const byId = new Map(prods.map(p => [p.id, p]))
  const out: MonthOutput[] = []
  const ids = prods.map(p => p.id)
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150)
    const res = await fetchAllRows((from, to) => supabase.from('prod_production_outputs').select('*').in('production_id', chunk).order('id').range(from, to))
    if (res.error) return []
    for (const r of res.data) {
      const p = byId.get(r.production_id)
      out.push({
        id: r.id, productionId: r.production_id, sortOrder: r.sort_order, itemId: r.item_id, warehouseId: r.warehouse_id,
        qty: Number(r.qty), sharePct: Number(r.share_pct), refPrice: r.ref_price === null ? null : Number(r.ref_price),
        cost: Number(r.cost), unitCost: Number(r.unit_cost), lotId: r.lot_id,
        productionNumber: p?.number ?? 0, docDate: p?.doc_date ?? '',
      })
    }
  }
  return out.sort((a, b) => (a.docDate < b.docDate ? -1 : a.docDate > b.docDate ? 1 : a.productionNumber - b.productionNumber || a.sortOrder - b.sortOrder))
}

export interface ProductCostRow {
  month: string; itemId: string; itemName: string; itemUnit: string; qty: number; materialCost: number; overhead: number
  fullCost: number; materialUnitCost: number | null; fullUnitCost: number | null
}

export async function fetchProductCosts(supabase: Client, opts: { month?: string; fromMonth?: string; toMonth?: string }): Promise<ProductCostRow[] | null> {
  const { data, error } = await fetchAllRows((from, to) => {
    let q = supabase.from('prod_product_costs_month').select('*')
    if (opts.month) q = q.eq('month', opts.month)
    if (opts.fromMonth) q = q.gte('month', opts.fromMonth)
    if (opts.toMonth) q = q.lte('month', opts.toMonth)
    return q.order('month').order('item_id').range(from, to)
  })
  if (error) return null
  return data.map(r => ({
    month: r.month ?? '', itemId: r.item_id ?? '', itemName: r.item_name ?? '', itemUnit: r.item_unit ?? '',
    qty: Number(r.qty ?? 0), materialCost: Number(r.material_cost ?? 0), overhead: Number(r.overhead ?? 0), fullCost: Number(r.full_cost ?? 0),
    materialUnitCost: r.material_unit_cost === null ? null : Number(r.material_unit_cost),
    fullUnitCost: r.full_unit_cost === null ? null : Number(r.full_unit_cost),
  }))
}

// ---------------------------------------------------------------------------
// P&L (prod_pnl)

export const PNL_METRICS = ['revenue', 'cogs', 'gross_profit', 'writeoffs', 'production_losses', 'price_variance', 'overhead', 'other_expenses', 'operating_profit'] as const
export type PnlMetric = typeof PNL_METRICS[number]
/** Metrics with detail lines in total.detail. */
export const PNL_DETAIL_METRICS = ['revenue', 'cogs', 'writeoffs', 'production_losses', 'price_variance', 'overhead', 'other_expenses'] as const
export type PnlDetailMetric = typeof PNL_DETAIL_METRICS[number]
export const PNL_GROUPS = ['month', 'week', 'day', 'total'] as const
export type PnlGroup = typeof PNL_GROUPS[number]

export type PnlNumbers = Record<PnlMetric | 'separation_loss_value', number>
export interface PnlRow extends PnlNumbers { period: string; from: string; to: string }
export interface PnlDetail { kind: string; ref: string | null; name: string | null; amount: number }
export interface PnlResult {
  from: string
  to: string
  group: PnlGroup
  vatPayer: boolean
  rows: PnlRow[]
  total: PnlNumbers & { detail: Record<PnlDetailMetric, PnlDetail[]> }
}

const n0 = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0)

function mapNumbers(r: Record<string, unknown>): PnlNumbers {
  return {
    revenue: n0(r.revenue), cogs: n0(r.cogs), gross_profit: n0(r.gross_profit), writeoffs: n0(r.writeoffs),
    production_losses: n0(r.production_losses), price_variance: n0(r.price_variance), overhead: n0(r.overhead),
    other_expenses: n0(r.other_expenses), operating_profit: n0(r.operating_profit), separation_loss_value: n0(r.separation_loss_value),
  }
}

export async function fetchPnl(supabase: Client, from: string, to: string, group: PnlGroup): Promise<RpcOutcome<PnlResult>> {
  const res = await callRpc<Record<string, unknown>>(supabase.rpc('prod_pnl', { p_from: from, p_to: to, p_group: group }))
  if (res.status !== 'ok') return res
  const d = res.data ?? {}
  const total = (d.total ?? {}) as Record<string, unknown>
  const detailRaw = (total.detail ?? {}) as Record<string, unknown>
  const detail = Object.fromEntries(PNL_DETAIL_METRICS.map(m => [m, ((detailRaw[m] ?? []) as Record<string, unknown>[]).map(x => ({
    kind: String(x.kind ?? ''), ref: x.ref === null || x.ref === undefined ? null : String(x.ref),
    name: x.name === null || x.name === undefined ? null : String(x.name), amount: n0(x.amount),
  }))])) as Record<PnlDetailMetric, PnlDetail[]>
  return {
    status: 'ok',
    data: {
      from: String(d.from ?? from), to: String(d.to ?? to), group: (d.group as PnlGroup) ?? group, vatPayer: !!d.vat_payer,
      rows: ((d.rows ?? []) as Record<string, unknown>[]).map(r => ({
        ...mapNumbers(r), period: String(r.period ?? ''), from: String(r.from ?? ''), to: String(r.to ?? ''),
      })),
      total: { ...mapNumbers(total), detail },
    },
  }
}

const PNL_KINDS = ['sales', 'returns', 'returns_restocked', 'writeoff', 'count_shortage', 'count_surplus', 'return_loss', 'processing', 'price_correction', 'cash_order', 'supply_expense'] as const

/** Label key of a P&L detail kind (overhead kinds are pool categories). */
export function pnlKindKey(metric: PnlDetailMetric, kind: string): TranslationKey {
  if (metric === 'overhead') return poolCategoryKey(kind)
  return (PNL_KINDS as readonly string[]).includes(kind) ? (`prodAcct.pnl.kinds.${kind as typeof PNL_KINDS[number]}` as TranslationKey) : 'prodAcct.pnl.kinds.other'
}

// ---------------------------------------------------------------------------
// Server-side reports

/** prod_report_turnover rows (per warehouse x item); 'missing' before the migration. */
export async function fetchTurnoverRpc(supabase: Client, opts: { from: string | null; to: string; warehouseId?: string; groupId?: string }): Promise<RpcOutcome<TurnoverRow[]>> {
  const res = await callRpc<{ rows?: Record<string, unknown>[] }>(supabase.rpc('prod_report_turnover', {
    p_from: opts.from, p_to: opts.to, p_warehouse: opts.warehouseId || null, p_group: opts.groupId || null,
  }))
  if (res.status !== 'ok') return res
  const rows = (res.data?.rows ?? []).map(r => {
    const by = new Map<string, { in: { qty: number; value: number }; out: { qty: number; value: number } }>()
    for (const [k, v] of Object.entries((r.by_doc_type ?? {}) as Record<string, Record<string, unknown>>)) {
      by.set(k, { in: { qty: n0(v.in_qty), value: n0(v.in_value) }, out: { qty: n0(v.out_qty), value: n0(v.out_value) } })
    }
    const wh = String(r.warehouse_id ?? '')
    const item = String(r.item_id ?? '')
    return {
      key: `${wh}:${item}`, warehouseId: wh, itemId: item,
      opening: { qty: n0(r.opening_qty), value: n0(r.opening_value) },
      inflow: { qty: n0(r.in_qty), value: n0(r.in_value) },
      outflow: { qty: n0(r.out_qty), value: n0(r.out_value) },
      closing: { qty: n0(r.closing_qty), value: n0(r.closing_value) },
      byDocType: by,
      closingFat: r.closing_fat === null || r.closing_fat === undefined ? null : Number(r.closing_fat),
    } satisfies TurnoverRow
  })
  return { status: 'ok', data: rows }
}

/** Sums per-warehouse turnover rows into per-item rows (fat weighted by closing qty). */
export function mergeTurnoverByItem(rows: TurnoverRow[]): TurnoverRow[] {
  const m = new Map<string, TurnoverRow & { fq: number; fs: number }>()
  for (const r of rows) {
    let a = m.get(r.itemId)
    if (!a) {
      a = { key: r.itemId, warehouseId: null, itemId: r.itemId, opening: { qty: 0, value: 0 }, inflow: { qty: 0, value: 0 }, outflow: { qty: 0, value: 0 }, closing: { qty: 0, value: 0 }, byDocType: new Map(), closingFat: null, fq: 0, fs: 0 }
      m.set(r.itemId, a)
    }
    for (const k of ['opening', 'inflow', 'outflow', 'closing'] as const) { a[k].qty += r[k].qty; a[k].value += r[k].value }
    for (const [d, f] of r.byDocType) {
      const x = a.byDocType.get(d) ?? { in: { qty: 0, value: 0 }, out: { qty: 0, value: 0 } }
      x.in.qty += f.in.qty; x.in.value += f.in.value; x.out.qty += f.out.qty; x.out.value += f.out.value
      a.byDocType.set(d, x)
    }
    if (r.closingFat !== null) { a.fq += r.closing.qty; a.fs += r.closing.qty * r.closingFat }
  }
  return [...m.values()].map(({ fq, fs, ...r }) => ({ ...r, closingFat: Math.abs(fq) > 0.0005 ? fs / fq : null }))
}

export interface SalesRpcRow {
  key: string; name: string | null; unit: string | null; qty: number | null; salesAmount: number; returnsAmount: number
  revenue: number; vat: number; total: number; cost: number | null; margin: number | null; salesCount: number
}

export async function fetchSalesRpc(supabase: Client, from: string, to: string, by: 'product' | 'customer' | 'group' | 'day' | 'month'): Promise<RpcOutcome<{ rows: SalesRpcRow[]; salesCount: number }>> {
  const res = await callRpc<{ rows?: Record<string, unknown>[]; totals?: Record<string, unknown> }>(supabase.rpc('prod_report_sales', { p_from: from, p_to: to, p_by: by }))
  if (res.status !== 'ok') return res
  const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    status: 'ok',
    data: {
      rows: (res.data?.rows ?? []).map(r => ({
        key: String(r.key ?? ''), name: r.name === null || r.name === undefined ? null : String(r.name), unit: r.unit === null || r.unit === undefined ? null : String(r.unit),
        qty: nn(r.qty), salesAmount: n0(r.sales_amount), returnsAmount: n0(r.returns_amount), revenue: n0(r.revenue), vat: n0(r.vat),
        total: n0(r.total), cost: nn(r.cost), margin: nn(r.margin), salesCount: n0(r.sales_count),
      })),
      salesCount: n0(res.data?.totals?.sales_count),
    },
  }
}

export interface DashSeriesPoint { period: string; revenue: number | null; cogs: number | null; margin: number | null; milkKg: number | null; avgFat: number | null; outputKg: number | null; cashBalance: number | null }
export interface DashTotals { revenue: number | null; cogs: number | null; margin: number | null; milkKg: number | null; avgFat: number | null; outputKg: number | null; cashBalance: number | null }
export interface DashRpc {
  series: DashSeriesPoint[]
  totals: DashTotals
  prevTotals: DashTotals
  salesByGroup: { groupId: string | null; groupName: string | null; revenue: number }[] | null
  outflows: { source: string; categoryId: string | null; categoryName: string | null; amount: number }[] | null
}

function mapDashTotals(r: Record<string, unknown> | null | undefined): DashTotals {
  const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  const x = r ?? {}
  return { revenue: nn(x.revenue), cogs: nn(x.cogs), margin: nn(x.margin), milkKg: nn(x.milk_kg), avgFat: nn(x.avg_fat), outputKg: nn(x.output_kg), cashBalance: nn(x.cash_balance) }
}

export async function fetchDashboardRpc(supabase: Client, from: string, to: string, group: 'day' | 'month'): Promise<RpcOutcome<DashRpc>> {
  const res = await callRpc<Record<string, unknown>>(supabase.rpc('prod_report_dashboard', { p_from: from, p_to: to, p_group: group }))
  if (res.status !== 'ok') return res
  const d = res.data ?? {}
  const sbg = d.sales_by_group as Record<string, unknown>[] | null | undefined
  const out = d.outflows as Record<string, unknown>[] | null | undefined
  return {
    status: 'ok',
    data: {
      series: ((d.series ?? []) as Record<string, unknown>[]).map(s => ({ period: String(s.period ?? ''), ...mapDashTotals(s) })),
      totals: mapDashTotals(d.totals as Record<string, unknown>),
      prevTotals: mapDashTotals(d.prev_totals as Record<string, unknown>),
      salesByGroup: sbg ? sbg.map(g => ({ groupId: g.group_id ? String(g.group_id) : null, groupName: g.group_name ? String(g.group_name) : null, revenue: n0(g.revenue) })) : null,
      outflows: out ? out.map(o => ({ source: String(o.source ?? ''), categoryId: o.category_id ? String(o.category_id) : null, categoryName: o.category_name ? String(o.category_name) : null, amount: n0(o.amount) })) : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Errors

const ACCT_INVALID_DETAILS = [
  'vat_rate', 'output_weight', 'ref_price', 'share_pct', 'allocation_method', 'outputs', 'allocations_sum', 'allocations',
  'output_id', 'no_base', 'category', 'amount', 'period', 'method', 'allocation',
] as const

/** prodErrorText plus the invalid_input / duplicate DETAILs of migration 20261110000018. */
export function acctErrorText(t: (k: TranslationKey) => string, err: ProdRpcError): string {
  const msg = (typeof err === 'string' ? err : err?.message) ?? ''
  const det = (typeof err === 'string' ? '' : err?.details) ?? ''
  if (msg.includes('invalid_input') && (ACCT_INVALID_DETAILS as readonly string[]).includes(det)) {
    return t(`prodAcct.errors.${det as typeof ACCT_INVALID_DETAILS[number]}` as TranslationKey)
  }
  if (msg.includes('duplicate') && det === 'expense_category_id') return t('prodAcct.errors.duplicate_pool')
  return prodErrorText(t, err)
}
