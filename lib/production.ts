// Shared types, constants and read helpers for the production module
// (business_type = 'production'). Reads go straight to the RLS-scoped tables
// and views; every write goes through the prod_* / supply_* SECURITY DEFINER
// RPCs (INSERT/UPDATE/DELETE on these tables is revoked).

import type { Database } from '@/lib/database.types'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'

type Client = ReturnType<typeof createClient>

export const PROD_UNITS = ['kg', 'l', 'g', 'pcs', 'm'] as const
export type ProdUnit = typeof PROD_UNITS[number]

export const PROD_ITEM_TYPES = ['raw', 'semi', 'finished', 'packaging'] as const
export type ProdItemType = typeof PROD_ITEM_TYPES[number]

export const PROD_STORAGE_TYPES = ['raw', 'finished', 'production', 'processing', 'return'] as const
export type ProdStorageType = typeof PROD_STORAGE_TYPES[number]

export type ProdDocType = 'receipt' | 'production' | 'processing' | 'transfer' | 'separation'
  | 'writeoff' | 'stock_count' | 'opening_balance' | 'price_correction'
  | 'sale' | 'sale_return'
export type ProdDocStatus = 'posted' | 'cancelled'

export const NOTE_MAX = 500

export interface ProdItemGroup { id: string; name: string; isActive: boolean; createdAt: string }

export interface ProdItem {
  id: string
  groupId: string | null
  name: string
  sku: string
  barcode: string
  unit: ProdUnit
  weightKg: number | null
  itemType: ProdItemType
  minStock: number | null
  maxStock: number | null
  isActive: boolean
  description: string
  /** Default expiry of new lots (days after receipt / production); null = none. */
  shelfLifeDays: number | null
  /** Migration 20261110000014; undefined while the columns do not exist. */
  standardCost: number | null | undefined
  salePrice: number | null | undefined
  /** Days before expiry a lot is flagged "soon"; null = LOT_EXPIRY_WARN_DAYS. */
  expiryWarnDays: number | null | undefined
  createdAt: string
}

export interface ProdWarehouse { id: string; name: string; storageTypes: ProdStorageType[]; isActive: boolean; createdAt: string }

/**
 * Active warehouses whose storage types include any of `types`; all active
 * warehouses when none match (firms that never tagged their warehouses).
 */
export function warehousesFor(warehouses: ProdWarehouse[], types: ProdStorageType[]): ProdWarehouse[] {
  const active = warehouses.filter(w => w.isActive)
  const matching = active.filter(w => w.storageTypes.some(s => types.includes(s)))
  return matching.length ? matching : active
}

/** "A" or "A → B" when a document puts its output into another warehouse. */
export function warehousePairLabel(fromName: string, toName: string | null | undefined): string {
  return toName && toName !== fromName ? `${fromName} → ${toName}` : fromName
}

/** One prod_stock row (warehouse x item). */
export interface ProdStockRow { warehouseId: string; itemId: string; qty: number; value: number; avgCost: number }

export function unitKey(unit: string): TranslationKey {
  return (PROD_UNITS as readonly string[]).includes(unit) ? (`production.units.${unit}` as TranslationKey) : 'production.units.pcs'
}

export function itemTypeKey(type: string): TranslationKey {
  return (PROD_ITEM_TYPES as readonly string[]).includes(type) ? (`production.itemTypes.${type}` as TranslationKey) : 'production.itemTypes.raw'
}

export function storageTypeKey(type: string): TranslationKey {
  return (PROD_STORAGE_TYPES as readonly string[]).includes(type) ? (`production.storageTypes.${type}` as TranslationKey) : 'production.storageTypes.raw'
}

const qtyFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 })

/** Quantities are numeric(14,3): up to 3 decimals, thousands separated. */
export function formatQty(qty: number): string {
  return qtyFormatter.format(qty)
}

/** Round to the DB column scale so client totals match what the RPC stores. */
export const round3 = (n: number) => Math.round(n * 1000) / 1000
export const round2 = (n: number) => Math.round(n * 100) / 100
/** Recipe quantities and planned amounts are numeric(14,4). */
export const round4 = (n: number) => Math.round(n * 10000) / 10000

/** Parses a user-typed decimal ("1,5" or "1.5"); NaN-safe, never negative. */
export function parseDecimal(value: string): number {
  const n = Number(value.replace(',', '.').replace(/\s/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

const ERROR_CODES = [
  'forbidden', 'wrong_business_type', 'not_found', 'insufficient_stock', 'invalid_input',
  'duplicate_name', 'duplicate', 'already_cancelled', 'negative_balance', 'business_type_immutable',
  // Controls (migration 20261110000017).
  'needs_approval', 'period_closed', 'self_cancel',
] as const

/** invalid_input DETAILs with their own message (migration 20261110000014). */
const INVALID_INPUT_DETAILS = ['lot_on_hold', 'warehouse_has_stock', 'has_price_correction', 'not_latest', 'lot_used', 'has_returns', 'credit_limit', 'no_price', 'over_return', 'unit_changed',
  // Controls (migration 20261110000017).
  'future_date', 'expiry_in_past', 'override_note', 'already_closed', 'not_closed'] as const
const DUPLICATE_DETAILS = ['name', 'sku', 'barcode', 'inn'] as const

/** A PostgREST error ({ message, details }) or just its message. */
export type ProdRpcError = string | { message?: string | null; details?: string | null } | null | undefined

/**
 * Maps a RAISE EXCEPTION '<code>' (USING DETAIL ...) from the prod_* RPCs to
 * a translation key. Pass the whole error so DETAILs can be told apart.
 */
export function prodErrorKey(err: ProdRpcError): TranslationKey {
  const msg = (typeof err === 'string' ? err : err?.message) ?? ''
  const details = (typeof err === 'string' ? '' : err?.details) ?? ''
  // Sales (migration 20261110000015): enforced credit limit and cancelling a sale that has returns.
  if (/credit_limit/.test(msg) || /credit_limit/.test(details)) return 'productionErrors.credit_limit'
  if (/has_returns/.test(msg) || details === 'has_returns') return 'productionErrors.has_returns'
  // Cash & bank (migration 20261110000016).
  if (/insufficient_funds/.test(msg) || details === 'insufficient_funds') return 'prodCash.errors.insufficient_funds'
  if (details === 'no_account' || /no_account/.test(msg)) return 'prodCash.errors.no_account'
  if (details === 'account_inactive') return 'prodCash.errors.account_inactive'
  if (details === 'account_has_balance' || /account_has_balance/.test(msg)) return 'prodCash.errors.account_has_balance'
  if (details === 'account_has_movements') return 'prodCash.errors.account_has_movements'
  const code = ERROR_CODES.find(c => msg === c) ?? ERROR_CODES.find(c => msg.includes(c))
  // Controls (migration 20261110000017): non-overridable forbidden rules and the reopen note.
  if (code === 'forbidden' && details === 'antibiotic') return 'productionErrors.antibiotic'
  if (code === 'forbidden' && details === 'supplier_price_change') return 'productionErrors.supplier_price_change'
  if (code === 'invalid_input' && details === 'note') return 'productionErrors.reopen_note'
  if (code === 'duplicate') {
    const d = DUPLICATE_DETAILS.find(x => details === x)
    return d === 'sku' ? 'productionErrors.duplicate_sku' : d === 'barcode' ? 'productionErrors.duplicate_barcode'
      : d === 'inn' ? 'productionErrors.duplicate_inn' : 'productionErrors.duplicate_name'
  }
  if (code === 'invalid_input') {
    const d = INVALID_INPUT_DETAILS.find(x => details === x || msg.includes(x))
    if (d) return `productionErrors.${d}` as TranslationKey
  }
  if (code) return `productionErrors.${code}` as TranslationKey
  // Unique violations surface as Postgres 23505 text when the RPC does not map them.
  if (/duplicate key|unique/i.test(msg)) return 'productionErrors.duplicate_name'
  return 'productionErrors.unknown'
}

const numOrUndef = (v: number | null | undefined): number | null | undefined =>
  v === undefined ? undefined : v === null ? null : Number(v)

function mapItem(r: Database['public']['Tables']['prod_items']['Row']): ProdItem {
  return {
    id: r.id,
    groupId: r.group_id,
    name: r.name,
    sku: r.sku ?? '',
    barcode: r.barcode ?? '',
    unit: ((PROD_UNITS as readonly string[]).includes(r.unit) ? r.unit : 'pcs') as ProdUnit,
    weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    itemType: ((PROD_ITEM_TYPES as readonly string[]).includes(r.item_type) ? r.item_type : 'raw') as ProdItemType,
    minStock: r.min_stock === null ? null : Number(r.min_stock),
    maxStock: r.max_stock === null ? null : Number(r.max_stock),
    isActive: r.is_active,
    description: r.description ?? '',
    // undefined until migration 20261110000013 adds the column.
    shelfLifeDays: r.shelf_life_days === null || r.shelf_life_days === undefined ? null : Number(r.shelf_life_days),
    // undefined until migration 20261110000014 adds the columns.
    standardCost: numOrUndef(r.standard_cost),
    salePrice: numOrUndef(r.sale_price),
    expiryWarnDays: numOrUndef(r.expiry_warn_days),
    createdAt: r.created_at,
  }
}

export async function fetchProdItems(supabase: Client): Promise<ProdItem[]> {
  const { data } = await fetchAllRows((from, to) =>
    supabase.from('prod_items').select('*').order('name').order('id').range(from, to))
  return data.map(mapItem)
}

export async function fetchProdGroups(supabase: Client): Promise<ProdItemGroup[]> {
  const { data } = await supabase.from('prod_item_groups').select('id, name, is_active, created_at').order('name')
  return (data ?? []).map(g => ({ id: g.id, name: g.name, isActive: g.is_active, createdAt: g.created_at }))
}

export async function fetchProdWarehouses(supabase: Client): Promise<ProdWarehouse[]> {
  const { data } = await supabase.from('prod_warehouses').select('id, name, storage_types, is_active, created_at').order('created_at')
  return (data ?? []).map(w => ({
    id: w.id,
    name: w.name,
    storageTypes: (w.storage_types ?? []).filter((s): s is ProdStorageType => (PROD_STORAGE_TYPES as readonly string[]).includes(s)),
    isActive: w.is_active,
    createdAt: w.created_at,
  }))
}

/**
 * prod_stock rows (the view keeps zero-qty rows, so they are always dropped);
 * optionally one warehouse, optionally only positive qty.
 */
export async function fetchProdStock(supabase: Client, opts: { warehouseId?: string; positiveOnly?: boolean } = {}): Promise<ProdStockRow[]> {
  const { data } = await fetchAllRows((from, to) => {
    let q = supabase.from('prod_stock').select('warehouse_id, item_id, qty, value, avg_cost')
    if (opts.warehouseId) q = q.eq('warehouse_id', opts.warehouseId)
    q = opts.positiveOnly ? q.gt('qty', 0) : q.neq('qty', 0)
    return q.order('warehouse_id').order('item_id').range(from, to)
  })
  return data
    .filter(r => r.warehouse_id && r.item_id)
    .map(r => ({
      warehouseId: r.warehouse_id as string,
      itemId: r.item_id as string,
      qty: Number(r.qty ?? 0),
      value: Number(r.value ?? 0),
      avgCost: Number(r.avg_cost ?? 0),
    }))
}

/**
 * Weighted-average fat % per "warehouseId:itemId" (prod_stock_quality view),
 * only for rows that track fat. Empty map when the view is not available.
 */
export async function fetchProdStockFat(supabase: Client, warehouseId?: string): Promise<Map<string, number>> {
  const { data } = await fetchAllRows((from, to) => {
    let q = supabase.from('prod_stock_quality').select('warehouse_id, item_id, avg_fat').not('avg_fat', 'is', null)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    return q.order('warehouse_id').order('item_id').range(from, to)
  })
  return new Map(data
    .filter(r => r.warehouse_id && r.item_id && r.avg_fat !== null)
    .map(r => [`${r.warehouse_id}:${r.item_id}`, Number(r.avg_fat)]))
}

/** "2026-11-09" + "14:30" (local) -> ISO timestamptz for doc_date. */
export function localDateTimeToIso(date: string, time: string): string {
  const d = new Date(`${date}T${time || '00:00'}:00`)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

export function nowHm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Owner/admin only may cancel posted documents (the RPC re-checks). */
export function canCancelDocuments(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/** Local-day DateRangeValue ("YYYY-MM-DD" inclusive) -> [fromIso, toIsoExclusive) for timestamptz filters. */
export function rangeToIsoBounds(range: { from: string; to: string }): { fromIso: string; toIso: string } {
  const from = new Date(`${range.from}T00:00:00`)
  const to = new Date(`${range.to}T00:00:00`)
  to.setDate(to.getDate() + 1)
  return { fromIso: from.toISOString(), toIso: to.toISOString() }
}

// ---------------------------------------------------------------------------
// Production suppliers (prod_suppliers + prod_supplier_balances view). Writes
// go through prod_save_supplier / prod_create_supplier_payment /
// prod_cancel_supplier_payment only.

export const PROD_PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const
export type ProdPaymentMethod = typeof PROD_PAYMENT_METHODS[number]

export function paymentMethodKey(method: string): TranslationKey {
  if (method === 'card') return 'production.suppliers.methodCard'
  if (method === 'transfer') return 'production.suppliers.methodTransfer'
  return 'production.suppliers.methodCash'
}

export interface ProdSupplier {
  id: string
  name: string
  phone: string
  address: string
  note: string
  isActive: boolean
  createdAt: string
  /** Base raw-milk price per kg (Sut qabuli); null = settings default. */
  milkPricePerKg: number | null
  /** Payment terms (days after the receipt); null = due at once; undefined = column not available yet. */
  paymentTermsDays: number | null | undefined
  /** Posted receipts total. */
  purchased: number
  /** Posted payments total. */
  paid: number
  /** purchased - paid; negative = advance. */
  debt: number
  lastReceiptAt: string | null
  lastPaymentAt: string | null
}

/** Suppliers with their balances (suppliers without activity get zeros). */
export async function fetchProdSuppliers(supabase: Client): Promise<ProdSupplier[]> {
  const baseCols = 'id, name, phone, address, note, is_active, created_at'
  const [supFull, balRes] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase.from('prod_suppliers').select('id, name, phone, address, note, is_active, created_at, milk_price_per_kg, payment_terms_days').order('name').order('id').range(from, to)),
    fetchAllRows((from, to) =>
      supabase.from('prod_supplier_balances').select('supplier_id, purchased, paid, debt, last_receipt_at, last_payment_at').order('supplier_id').range(from, to)),
  ])
  // Safety net while migrations 20261110000014 (payment_terms_days) /
  // 20261110000010 (milk_price_per_kg) are not yet applied: fall back to the
  // older column lists so supplier pages keep working.
  type SupRow = { id: string; name: string; phone: string | null; address: string | null; note: string | null; is_active: boolean; created_at: string; milk_price_per_kg: number | null; payment_terms_days?: number | null }
  let supRes: { data: SupRow[]; error: unknown } = supFull
  if (supFull.error) {
    const mid = await fetchAllRows((from, to) =>
      supabase.from('prod_suppliers').select(`${baseCols}, milk_price_per_kg`).order('name').order('id').range(from, to))
    supRes = mid.error
      ? await fetchAllRows((from, to) =>
        supabase.from('prod_suppliers').select(baseCols).order('name').order('id').range(from, to))
        .then(r => ({ ...r, data: r.data.map(x => ({ ...x, milk_price_per_kg: null as number | null })) }))
      : mid
  }
  const bal = new Map(balRes.data.filter(b => b.supplier_id).map(b => [b.supplier_id as string, b]))
  return supRes.data.map(s => {
    const b = bal.get(s.id)
    const purchased = Number(b?.purchased ?? 0)
    const paid = Number(b?.paid ?? 0)
    return {
      id: s.id,
      name: s.name,
      phone: s.phone ?? '',
      address: s.address ?? '',
      note: s.note ?? '',
      isActive: s.is_active,
      createdAt: s.created_at,
      milkPricePerKg: s.milk_price_per_kg === null || s.milk_price_per_kg === undefined ? null : Number(s.milk_price_per_kg),
      paymentTermsDays: numOrUndef(s.payment_terms_days),
      purchased,
      paid,
      debt: b?.debt === null || b?.debt === undefined ? round2(purchased - paid) : Number(b.debt),
      lastReceiptAt: b?.last_receipt_at ?? null,
      lastPaymentAt: b?.last_payment_at ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// Units: stock and every DB quantity stay in the item's base unit. The UI lets
// kg items be entered in kg or g and l items in l or ml, converting to the
// base unit before anything is sent.

export type EntryUnit = ProdUnit | 'ml'

/** The smaller entry unit of a base unit (kg -> g, l -> ml), or null. */
export function subUnitOf(base: ProdUnit): EntryUnit | null {
  if (base === 'kg') return 'g'
  if (base === 'l') return 'ml'
  return null
}

/** Units a quantity of this base unit may be typed in. */
export function entryUnitsOf(base: ProdUnit): EntryUnit[] {
  const sub = subUnitOf(base)
  return sub ? [base, sub] : [base]
}

const isSubUnit = (base: ProdUnit, u: EntryUnit) => u !== base && subUnitOf(base) === u

/** Entered value -> base unit. */
export function toBaseQty(value: number, base: ProdUnit, u: EntryUnit): number {
  return isSubUnit(base, u) ? value / 1000 : value
}

/** Base unit -> entry unit. */
export function fromBaseQty(qty: number, base: ProdUnit, u: EntryUnit): number {
  return isSubUnit(base, u) ? qty * 1000 : qty
}

/** Smaller unit for amounts below 1 kg / 1 l (0.25 kg -> g). */
export function smartUnit(qty: number, base: ProdUnit): EntryUnit {
  const sub = subUnitOf(base)
  return sub && qty !== 0 && Math.abs(qty) < 1 ? sub : base
}

export function entryUnitKey(u: EntryUnit): TranslationKey {
  return u === 'ml' ? 'production.units.ml' : unitKey(u)
}

/** Number for an <input> value: up to 4 decimals, no thousands separators. */
export function toInputString(n: number): string {
  if (!Number.isFinite(n) || n === 0) return ''
  return String(Number(n.toFixed(4)))
}

const qty4Formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 })

/** Recipe / planned quantities: numeric(14,4). */
export function formatQty4(qty: number): string {
  return qty4Formatter.format(qty)
}

/** 0.25 kg -> { 250, 'g' }; amounts of 1 and more stay in the base unit. */
export function smartQty(qty: number, base: ProdUnit): { value: number; unit: EntryUnit } {
  const unit = smartUnit(qty, base)
  return { value: fromBaseQty(qty, base, unit), unit }
}

/** Unit groups for totals and yield: mass (kg, g), volume (l), pieces, length. */
export type UnitGroup = 'mass' | 'volume' | 'pcs' | 'm'

export function unitGroupOf(base: ProdUnit): UnitGroup {
  if (base === 'kg' || base === 'g') return 'mass'
  if (base === 'l') return 'volume'
  return base
}

/** Base quantity -> the group's canonical unit (g counted in kg). */
export function toGroupQty(qty: number, base: ProdUnit): number {
  return base === 'g' ? qty / 1000 : qty
}

export const GROUP_UNIT: Record<UnitGroup, ProdUnit> = { mass: 'kg', volume: 'l', pcs: 'pcs', m: 'm' }

/** Sums base quantities per unit group (in kg / l / pcs / m), keeping a stable order. */
export function sumByUnitGroup(lines: { qty: number; unit: ProdUnit }[]): { group: UnitGroup; qty: number }[] {
  const order: UnitGroup[] = ['mass', 'volume', 'pcs', 'm']
  const sums = new Map<UnitGroup, number>()
  for (const l of lines) {
    if (!(l.qty > 0)) continue
    const g = unitGroupOf(l.unit)
    sums.set(g, (sums.get(g) ?? 0) + toGroupQty(l.qty, l.unit))
  }
  return order.filter(g => sums.has(g)).map(g => ({ group: g, qty: sums.get(g)! }))
}

/** A yield line: base quantity + unit, and the weight of one unit (pcs) when known. */
export interface YieldLine { qty: number; unit: ProdUnit; weightKg?: number | null }

/** Pieces with a known unit weight count as mass (qty x weight_kg kg). */
function yieldGroupQty(l: YieldLine): { group: UnitGroup; qty: number } {
  if (l.unit === 'pcs' && l.weightKg != null && l.weightKg > 0) return { group: 'mass', qty: l.qty * l.weightKg }
  return { group: unitGroupOf(l.unit), qty: toGroupQty(l.qty, l.unit) }
}

/**
 * Yield % (output / input * 100) when output and inputs are comparable: the
 * output is mass or volume and every mass/volume input is in the same group.
 * Pieces count as mass when their weight_kg is passed (a cup of yogurt of
 * 0.4 kg), otherwise piece and length inputs (packaging) are ignored.
 * Callers pass no weight for packaging so the tara never counts as input.
 * Null when not comparable.
 */
export function yieldPercent(output: YieldLine | null, inputs: YieldLine[]): number | null {
  if (!output || !(output.qty > 0)) return null
  const out = yieldGroupQty(output)
  if (out.group !== 'mass' && out.group !== 'volume') return null
  let input = 0
  for (const l of inputs) {
    if (!(l.qty > 0)) continue
    const g = yieldGroupQty(l)
    if (g.group === 'pcs' || g.group === 'm') continue
    if (g.group !== out.group) return null
    input += g.qty
  }
  if (!(input > 0)) return null
  return (out.qty / input) * 100
}

/** Weight of one unit for yield: none for packaging (tara is not product mass). */
export function yieldWeightOf(item: Pick<ProdItem, 'itemType' | 'weightKg'> | undefined): number | null {
  if (!item || item.itemType === 'packaging') return null
  return item.weightKg
}

// ---------------------------------------------------------------------------
// Recipes (prod_recipes + prod_recipe_lines). Writes go through
// prod_save_recipe only. One active recipe per finished/semi item.

export const RECIPE_MAX_LINES = 200

export interface ProdRecipeLine { id: string; itemId: string; qty: number; sortOrder: number; note: string }

export interface ProdRecipe {
  id: string
  itemId: string
  /** Batch size in the output item's base unit. */
  outputQty: number
  version: number
  isActive: boolean
  note: string
  createdByName: string
  createdAt: string
  updatedAt: string
  lines: ProdRecipeLine[]
}

type RecipeRow = Database['public']['Tables']['prod_recipes']['Row']
type RecipeLineRow = Database['public']['Tables']['prod_recipe_lines']['Row']

function mapRecipe(r: RecipeRow, lines: RecipeLineRow[]): ProdRecipe {
  return {
    id: r.id,
    itemId: r.item_id,
    outputQty: Number(r.output_qty),
    version: r.version,
    isActive: r.is_active,
    note: r.note ?? '',
    createdByName: r.created_by_name ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lines: lines
      .map(l => ({ id: l.id, itemId: l.item_id, qty: Number(l.qty), sortOrder: l.sort_order, note: l.note ?? '' }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  }
}

/** All recipes of the company (optionally active only) with their lines. */
export async function fetchProdRecipes(supabase: Client, opts: { activeOnly?: boolean } = {}): Promise<ProdRecipe[]> {
  const [recRes, lineRes] = await Promise.all([
    fetchAllRows((from, to) => {
      let q = supabase.from('prod_recipes').select('*')
      if (opts.activeOnly) q = q.eq('is_active', true)
      return q.order('created_at').order('id').range(from, to)
    }),
    fetchAllRows((from, to) =>
      supabase.from('prod_recipe_lines').select('*').order('recipe_id').order('sort_order').order('id').range(from, to)),
  ])
  const byRecipe = new Map<string, RecipeLineRow[]>()
  for (const l of lineRes.data) {
    const arr = byRecipe.get(l.recipe_id)
    if (arr) arr.push(l)
    else byRecipe.set(l.recipe_id, [l])
  }
  return recRes.data.map(r => mapRecipe(r, byRecipe.get(r.id) ?? []))
}

export async function fetchProdRecipe(supabase: Client, id: string): Promise<ProdRecipe | null> {
  const [recRes, lineRes] = await Promise.all([
    supabase.from('prod_recipes').select('*').eq('id', id).maybeSingle(),
    supabase.from('prod_recipe_lines').select('*').eq('recipe_id', id).order('sort_order').order('id'),
  ])
  return recRes.data ? mapRecipe(recRes.data, lineRes.data ?? []) : null
}

/** The active recipe of one output item, or null. */
export async function fetchActiveRecipe(supabase: Client, itemId: string): Promise<ProdRecipe | null> {
  const { data } = await supabase.from('prod_recipes').select('id').eq('item_id', itemId).eq('is_active', true).maybeSingle()
  return data ? fetchProdRecipe(supabase, data.id) : null
}

/** Weighted average cost per item over all warehouses (value / qty of positive stock). */
export async function fetchAvgCosts(supabase: Client): Promise<Map<string, number>> {
  const rows = await fetchProdStock(supabase, { positiveOnly: true })
  const acc = new Map<string, { qty: number; value: number }>()
  for (const r of rows) {
    const a = acc.get(r.itemId) ?? { qty: 0, value: 0 }
    a.qty += r.qty
    a.value += r.value
    acc.set(r.itemId, a)
  }
  return new Map([...acc].map(([id, a]) => [id, a.qty > 0 ? a.value / a.qty : 0]))
}

// ---------------------------------------------------------------------------
// Separation ("Separatsiya"): whole milk -> cream + skim (obrat) by the fat
// balance. Writes go through prod_create_separation only; the server
// recomputes everything. computeSeparation mirrors its formulas and rounding
// (kg to 3 decimals, money to 2) for the live preview.

export const SEPARATION_ALLOCATIONS = ['skim_price', 'value', 'fat'] as const
export type SeparationAllocation = typeof SEPARATION_ALLOCATIONS[number]

export const SEPARATION_DEFAULT_SKIM_FAT = 0.05
export const SEPARATION_MAX_LOSS_PCT = 10
export const SEPARATION_MAX_FAT = 90
export const SEPARATION_CREAM_FAT_CHIPS = [10, 20, 30, 33, 35] as const

export function toSeparationAllocation(v: unknown): SeparationAllocation {
  return (SEPARATION_ALLOCATIONS as readonly unknown[]).includes(v) ? (v as SeparationAllocation) : 'skim_price'
}

/** Names that look like cream / skim milk (uz, ru, en). */
export const CREAM_NAME_RE = /qaymoq|сливк|cream/i
export const SKIM_NAME_RE = /obrat|обрат|обезжир|снят|skim/i

export type SeparationIssue =
  | 'milk_qty' | 'milk_fat' | 'fat_order' | 'cream_fat_max' | 'loss_range'
  | 'cream_qty' | 'skim_qty' | 'outputs_over_milk'
  | 'fat_balance' | 'skim_over_cost' | 'prices_missing'

export interface SeparationInput {
  milkQty: number
  /** % */
  milkFat: number
  creamFat: number
  skimFat: number
  lossPct: number
  /** Actual (Fakt) outputs; null = use the calculated value. */
  creamActual: number | null
  skimActual: number | null
  /** Cost of the milk taken: round2(milkQty x avg cost). */
  milkCost: number
  method: SeparationAllocation
  skimPrice: number | null
  creamRefPrice: number | null
  skimRefPrice: number | null
}

export interface SeparationResult {
  /** Fat percentages are in a usable order (0 <= s < m < c <= 90) and loss is 0..10. */
  fatsOk: boolean
  lossKg: number
  creamCalc: number
  skimCalc: number
  cream: number
  skim: number
  /** milk - cream - skim of the actual outputs. */
  lossActual: number
  /** Cream share of the milk, %. */
  creamSharePct: number
  milkFatKg: number
  outputsFatKg: number
  lossFatKg: number
  /** milk fat - (cream + skim + loss) fat, kg. */
  fatDiffKg: number
  /** 'impossible' = the outputs hold more fat than the milk had. */
  balance: 'ok' | 'warn' | 'impossible'
  creamTotal: number
  skimTotal: number
  creamUnitCost: number
  skimUnitCost: number
  issues: SeparationIssue[]
}

/** Milk needed for a target cream amount (inverse of the fat balance, with loss). */
export function milkForCream(creamKg: number, milkFat: number, creamFat: number, skimFat: number, lossPct: number): number {
  if (!(creamKg > 0) || !(milkFat > skimFat) || !(creamFat > milkFat) || !(lossPct >= 0 && lossPct < 100)) return 0
  return round3((creamKg * (creamFat - skimFat)) / (milkFat - skimFat) / (1 - lossPct / 100))
}

export function computeSeparation(p: SeparationInput): SeparationResult {
  const issues: SeparationIssue[] = []
  const milk = round3(p.milkQty)
  const m = p.milkFat
  const c = p.creamFat
  const s = p.skimFat
  if (!(milk > 0)) issues.push('milk_qty')
  if (!(m > 0)) issues.push('milk_fat')
  const fatOrder = s >= 0 && s < m && m < c
  if (m > 0 && !fatOrder) issues.push('fat_order')
  if (c > SEPARATION_MAX_FAT) issues.push('cream_fat_max')
  const lossOk = p.lossPct >= 0 && p.lossPct <= SEPARATION_MAX_LOSS_PCT
  if (!lossOk) issues.push('loss_range')
  const fatsOk = m > 0 && fatOrder && c <= SEPARATION_MAX_FAT && lossOk

  let lossKg = 0
  let creamCalc = 0
  let skimCalc = 0
  if (fatsOk && milk > 0) {
    lossKg = round3((milk * p.lossPct) / 100)
    const net = round3(milk - lossKg)
    creamCalc = round3((net * (m - s)) / (c - s))
    skimCalc = round3(net - creamCalc)
  }
  const cream = round3(p.creamActual ?? creamCalc)
  const skim = round3(p.skimActual ?? skimCalc)
  const lossActual = round3(milk - cream - skim)
  if (fatsOk && milk > 0) {
    if (!(cream > 0)) issues.push('cream_qty')
    if (!(skim > 0)) issues.push('skim_qty')
    if (lossActual < 0) issues.push('outputs_over_milk')
  }

  // Fat balance: whatever is lost carries the milk's own fat.
  const milkFatKg = round3((milk * m) / 100)
  const outputsFatKg = round3((cream * c) / 100 + (skim * s) / 100)
  const lossFatKg = round3((Math.max(lossActual, 0) * m) / 100)
  const fatDiffKg = round3(milkFatKg - outputsFatKg - lossFatKg)
  const tol = Math.max(milkFatKg * 0.02, 0.01)
  const balance: SeparationResult['balance'] = !(milkFatKg > 0) || Math.abs(fatDiffKg) <= tol
    ? 'ok'
    : outputsFatKg > milkFatKg * 1.05 + 0.01 ? 'impossible' : 'warn'
  if (fatsOk && milk > 0 && balance === 'impossible') issues.push('fat_balance')

  // Cost allocation of the milk cost between cream and skim.
  let creamTotal = 0
  let skimTotal = 0
  const milkCost = round2(p.milkCost)
  if (cream > 0 && skim > 0) {
    if (p.method === 'skim_price') {
      if (p.skimPrice === null) issues.push('prices_missing')
      skimTotal = round2(skim * (p.skimPrice ?? 0))
      if (skimTotal > milkCost) issues.push('skim_over_cost')
      creamTotal = round2(milkCost - skimTotal)
    } else {
      const wc = p.method === 'value' ? cream * (p.creamRefPrice ?? 0) : cream * c
      const ws = p.method === 'value' ? skim * (p.skimRefPrice ?? 0) : skim * s
      if (p.method === 'value' && !((p.creamRefPrice ?? 0) > 0 && (p.skimRefPrice ?? 0) > 0)) issues.push('prices_missing')
      creamTotal = wc + ws > 0 ? round2((milkCost * wc) / (wc + ws)) : milkCost
      skimTotal = round2(milkCost - creamTotal)
    }
  }

  return {
    fatsOk,
    lossKg,
    creamCalc,
    skimCalc,
    cream,
    skim,
    lossActual,
    creamSharePct: milk > 0 ? (cream / milk) * 100 : 0,
    milkFatKg,
    outputsFatKg,
    lossFatKg,
    fatDiffKg,
    balance,
    creamTotal,
    skimTotal,
    creamUnitCost: cream > 0 ? round2(creamTotal / cream) : 0,
    skimUnitCost: skim > 0 ? round2(skimTotal / skim) : 0,
    issues,
  }
}

// ---------------------------------------------------------------------------
// Lots ("partiya"): every inflow is a lot with its own unit cost, fat %,
// supplier and expiry; every outflow consumes lots, automatically in FEFO
// order (expiry_date nulls last, received_at, lot_no) or from lots the user
// picked. Reads come from the prod_lot_stock view; the stock-touching RPCs
// accept optional pick arrays [{lot_id, qty}]. Every read degrades to null
// ("lots not available") while migration 20261110000013 is not applied, so
// callers fall back to the average-cost behaviour.

export interface ProdLot {
  id: string
  lotNo: string
  warehouseId: string
  itemId: string
  receivedAt: string
  /** "YYYY-MM-DD" or null. */
  expiryDate: string | null
  unitCost: number
  fatPct: number | null
  proteinPct: number | null
  supplierId: string | null
  supplierName: string
  remainingQty: number
  value: number
  isOpening: boolean
  sourceDocType: string | null
  sourceDocId: string | null
  originLotId: string | null
  /** Quarantine status (migration 20261110000014); 'free' while not available. */
  holdStatus: LotHoldStatus
  holdReason: string
  holdAt: string | null
}

export const LOT_HOLD_STATUSES = ['free', 'hold', 'blocked'] as const
export type LotHoldStatus = typeof LOT_HOLD_STATUSES[number]

export function toLotHoldStatus(v: unknown): LotHoldStatus {
  return v === 'hold' || v === 'blocked' ? v : 'free'
}

/**
 * How a consuming document treats held / blocked lots (mirrors prod_consume's
 * p_hold_mode): 'strict' (production, processing, separation) = FEFO and
 * picks use free lots only; 'pick' (transfer) = FEFO free only, explicit picks
 * may take any lot; 'any' (write-off, stock-count shortage) = FEFO takes free
 * lots first, then held ones, picks of any status.
 */
export type LotHoldMode = 'strict' | 'pick' | 'any'

export const isLotFree = (lot: Pick<ProdLot, 'holdStatus'>) => lot.holdStatus === 'free'

/** Whether the user may pick this lot by hand in the given mode. */
export function lotPickable(lot: Pick<ProdLot, 'holdStatus'>, mode: LotHoldMode): boolean {
  return mode !== 'strict' || isLotFree(lot)
}

/** One user-picked lot of a consumed line (sent as {lot_id, qty}). */
export interface LotPick { lotId: string; qty: number }

/** Lots within this many days of expiry are highlighted amber. */
export const LOT_EXPIRY_WARN_DAYS = 3

type LotStockRow = Database['public']['Views']['prod_lot_stock']['Row']

export const LOT_COLUMNS = 'id, lot_no, warehouse_id, item_id, received_at, expiry_date, unit_cost, fat_pct, protein_pct, supplier_id, supplier_name, remaining_qty, value, is_opening, source_doc_type, source_doc_id, origin_lot_id'

/** LOT_COLUMNS + the hold columns of migration 20261110000014 (readLots falls back to LOT_COLUMNS). */
export const LOT_COLUMNS_HOLD = 'id, lot_no, warehouse_id, item_id, received_at, expiry_date, unit_cost, fat_pct, protein_pct, supplier_id, supplier_name, remaining_qty, value, is_opening, source_doc_type, source_doc_id, origin_lot_id, hold_status, hold_reason, hold_at'

export type LotColumnsRow = Pick<LotStockRow,
  'id' | 'lot_no' | 'warehouse_id' | 'item_id' | 'received_at' | 'expiry_date' | 'unit_cost' | 'fat_pct' | 'protein_pct'
  | 'supplier_id' | 'supplier_name' | 'remaining_qty' | 'value' | 'is_opening' | 'source_doc_type' | 'source_doc_id' | 'origin_lot_id'>
  & Partial<Pick<LotStockRow, 'hold_status' | 'hold_reason' | 'hold_at'>>

const numOrNull = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v))

export function mapLot(r: LotColumnsRow): ProdLot {
  return {
    id: r.id ?? '',
    lotNo: r.lot_no ?? '',
    warehouseId: r.warehouse_id ?? '',
    itemId: r.item_id ?? '',
    receivedAt: r.received_at ?? '',
    expiryDate: r.expiry_date ?? null,
    unitCost: Number(r.unit_cost ?? 0),
    fatPct: numOrNull(r.fat_pct),
    proteinPct: numOrNull(r.protein_pct),
    supplierId: r.supplier_id ?? null,
    supplierName: r.supplier_name ?? '',
    remainingQty: Number(r.remaining_qty ?? 0),
    value: Number(r.value ?? 0),
    isOpening: !!r.is_opening,
    sourceDocType: r.source_doc_type ?? null,
    sourceDocId: r.source_doc_id ?? null,
    originLotId: r.origin_lot_id ?? null,
    holdStatus: toLotHoldStatus(r.hold_status),
    holdReason: r.hold_reason ?? '',
    holdAt: r.hold_at ?? null,
  }
}

/** FEFO order: expiry_date (nulls last), then received_at, then lot_no. */
export function compareLotsFefo(a: ProdLot, b: ProdLot): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1
    if (b.expiryDate === null) return -1
    return a.expiryDate < b.expiryDate ? -1 : 1
  }
  if (a.receivedAt !== b.receivedAt) {
    const ta = new Date(a.receivedAt).getTime()
    const tb = new Date(b.receivedAt).getTime()
    if (ta !== tb) return ta < tb ? -1 : 1
  }
  return a.lotNo < b.lotNo ? -1 : a.lotNo > b.lotNo ? 1 : 0
}

/**
 * Reads lots with the hold columns, falling back to the pre-20261110000014
 * column list (every lot then counts as free). null when lots are not available.
 */
async function readLots(build: (cols: string, from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<ProdLot[] | null> {
  try {
    let res = await fetchAllRows((from, to) => build(LOT_COLUMNS_HOLD, from, to))
    if (res.error) res = await fetchAllRows((from, to) => build(LOT_COLUMNS, from, to))
    if (res.error) return null
    return (res.data as LotColumnsRow[]).filter(r => r.id && r.item_id && r.warehouse_id).map(mapLot).sort(compareLotsFefo)
  } catch {
    return null
  }
}

/**
 * Lots with remaining_qty > 0 of one warehouse (optionally one item), FEFO
 * ordered. null when prod_lot_stock is not available (migration not applied).
 */
export function fetchProdLots(supabase: Client, opts: { warehouseId: string; itemId?: string }): Promise<ProdLot[] | null> {
  return readLots((cols, from, to) => {
    let q = supabase.from('prod_lot_stock').select(cols).eq('warehouse_id', opts.warehouseId).gt('remaining_qty', 0)
    if (opts.itemId) q = q.eq('item_id', opts.itemId)
    return q
      .order('expiry_date', { ascending: true, nullsFirst: false })
      .order('received_at')
      .order('lot_no')
      .range(from, to)
  })
}

/** Lots that still hold (or owe) stock, all warehouses or one; null when not available. Stock drill-in. */
export function fetchProdStockLots(supabase: Client, warehouseId?: string): Promise<ProdLot[] | null> {
  return readLots((cols, from, to) => {
    let q = supabase.from('prod_lot_stock').select(cols).neq('remaining_qty', 0)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    return q.order('warehouse_id').order('item_id').order('lot_no').range(from, to)
  })
}

export interface LotTake { lot: ProdLot; qty: number; cost: number }

export interface LotAllocation {
  takes: LotTake[]
  qty: number
  /** Sum of round2(qty x lot unit cost), as prod_consume computes it. */
  cost: number
  /** Qty-weighted fat over lots that carry fat; null when none do. */
  fatPct: number | null
  /** Requested qty the lots could not cover (0 when fully covered). */
  short: number
}

function summarize(takes: LotTake[], requested: number): LotAllocation {
  const qty = round3(takes.reduce((s, x) => s + x.qty, 0))
  const cost = round2(takes.reduce((s, x) => s + x.cost, 0))
  let fq = 0
  let fs = 0
  for (const x of takes) {
    if (x.lot.fatPct === null) continue
    fq += x.qty
    fs += x.qty * x.lot.fatPct
  }
  return { takes, qty, cost, fatPct: fq > 0 ? fs / fq : null, short: Math.max(0, round3(requested - qty)) }
}

/**
 * What automatic (FEFO) consumption of `qty` would take from `lots` (already
 * FEFO ordered). Held / blocked lots are skipped ('strict', 'pick') or taken
 * after every free lot ('any'), as prod_consume does.
 */
export function allocateFefo(lots: ProdLot[], qty: number, mode: LotHoldMode = 'strict'): LotAllocation {
  const takes: LotTake[] = []
  let left = round3(qty)
  const order = mode === 'any'
    ? [...lots.filter(isLotFree), ...lots.filter(l => !isLotFree(l))]
    : lots.filter(isLotFree)
  for (const lot of order) {
    if (!(left > 0)) break
    if (!(lot.remainingQty > 0)) continue
    const q = round3(Math.min(left, lot.remainingQty))
    takes.push({ lot, qty: q, cost: round2(q * lot.unitCost) })
    left = round3(left - q)
  }
  return summarize(takes, qty)
}

/** The user's picks priced at their lots' costs (unknown lots are skipped). */
export function allocatePicks(lots: ProdLot[], picks: LotPick[], requested: number): LotAllocation {
  const byId = new Map(lots.map(l => [l.id, l]))
  const takes: LotTake[] = []
  for (const p of picks) {
    const lot = byId.get(p.lotId)
    if (!lot || !(p.qty > 0)) continue
    const q = round3(p.qty)
    takes.push({ lot, qty: q, cost: round2(q * lot.unitCost) })
  }
  return summarize(takes, requested)
}

/** Picks are complete when they sum exactly to the line qty, no lot is over-picked and every lot may be picked in `mode`. */
export function picksValid(lots: ProdLot[], picks: LotPick[], requested: number, mode: LotHoldMode = 'strict'): boolean {
  if (!picks.length) return false
  const byId = new Map(lots.map(l => [l.id, l]))
  for (const p of picks) {
    const lot = byId.get(p.lotId)
    if (!lot || !(p.qty > 0) || round3(p.qty) > lot.remainingQty || !lotPickable(lot, mode)) return false
  }
  return round3(picks.reduce((s, p) => s + p.qty, 0)) === round3(requested)
}

/**
 * Line consumption: the picked lots when there are picks, else the FEFO
 * preview. null when lots are not available (caller falls back to avg_cost).
 */
export function lineAllocation(lots: ProdLot[] | null | undefined, picks: LotPick[] | null | undefined, qty: number, mode: LotHoldMode = 'strict'): LotAllocation | null {
  if (!lots) return null
  return picks && picks.length ? allocatePicks(lots, picks, qty) : allocateFefo(lots, qty, mode)
}

/** RPC payload of a pick list; undefined (key omitted = automatic FEFO) when there are none. */
export function picksPayload(picks: LotPick[] | null | undefined): { lot_id: string; qty: number }[] | undefined {
  return picks && picks.length ? picks.map(p => ({ lot_id: p.lotId, qty: round3(p.qty) })) : undefined
}

/** The item's expiry warning window (prod_items.expiry_warn_days), else LOT_EXPIRY_WARN_DAYS. */
export function expiryWarnDaysOf(item: Pick<ProdItem, 'expiryWarnDays'> | null | undefined): number {
  const d = item?.expiryWarnDays
  return d != null && d > 0 ? d : LOT_EXPIRY_WARN_DAYS
}

/**
 * 'expired' | 'soon' (within warnDays, default LOT_EXPIRY_WARN_DAYS) | 'ok';
 * null without an expiry date. today = "YYYY-MM-DD".
 */
export function lotExpiryState(expiryDate: string | null, today: string, warnDays: number = LOT_EXPIRY_WARN_DAYS): 'expired' | 'soon' | 'ok' | null {
  if (!expiryDate) return null
  if (expiryDate < today) return 'expired'
  const d = new Date(`${today}T00:00:00`)
  d.setDate(d.getDate() + (warnDays > 0 ? warnDays : LOT_EXPIRY_WARN_DAYS))
  const limit = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return expiryDate <= limit ? 'soon' : 'ok'
}

/** One consumed-lot line of a document (outflow movement joined to its lot). */
export interface DocLotLine {
  lotId: string
  lotNo: string
  itemId: string
  warehouseId: string
  supplierName: string
  /** Positive consumed quantity. */
  qty: number
  unitCost: number
  total: number
}

/** A lot a document created, with the quantity it received (remaining may be lower). */
export interface DocProducedLot extends ProdLot { receivedQty: number }

export interface DocLots { consumed: DocLotLine[]; produced: DocProducedLot[] }

/**
 * Lots used by a document (its non-reversal outflow movements that carry a
 * lot) and lots it produced (prod_lots.source_doc_id). null when lots are
 * not available or any read fails, so the page renders nothing.
 */
export async function fetchDocLots(supabase: Client, docId: string): Promise<DocLots | null> {
  try {
    const [movRes, prodRes] = await Promise.all([
      supabase.from('prod_stock_movements')
        .select('id, lot_id, item_id, warehouse_id, qty, unit_cost')
        .eq('doc_id', docId).eq('is_reversal', false).not('lot_id', 'is', null)
        .order('created_at').order('id'),
      supabase.from('prod_lot_stock').select(LOT_COLUMNS).eq('source_doc_id', docId).order('lot_no'),
    ])
    if (movRes.error || prodRes.error) return null
    const all = movRes.data ?? []
    const movs = all.filter(m => Number(m.qty) < 0)
    const inflowByLot = new Map<string, number>()
    for (const m of all) {
      if (Number(m.qty) > 0 && m.lot_id) inflowByLot.set(m.lot_id, (inflowByLot.get(m.lot_id) ?? 0) + Number(m.qty))
    }
    const lotIds = [...new Set(movs.map(m => m.lot_id).filter((x): x is string => !!x))]
    const lotById = new Map<string, ProdLot>()
    if (lotIds.length) {
      const { data, error } = await supabase.from('prod_lot_stock').select(LOT_COLUMNS).in('id', lotIds)
      if (error) return null
      for (const r of data ?? []) if (r.id) lotById.set(r.id, mapLot(r))
      // Safety net in case the view only lists lots that still hold stock:
      // read fully consumed lots straight from prod_lots (+ supplier names).
      const missing = lotIds.filter(id => !lotById.has(id))
      if (missing.length) {
        const { data: raw } = await supabase.from('prod_lots').select('id, lot_no, supplier_id').in('id', missing)
        const supIds = [...new Set((raw ?? []).map(r => r.supplier_id).filter((x): x is string => !!x))]
        const { data: sups } = supIds.length
          ? await supabase.from('prod_suppliers').select('id, name').in('id', supIds)
          : { data: [] as { id: string; name: string }[] }
        const supName = new Map((sups ?? []).map(x => [x.id, x.name]))
        for (const r of raw ?? []) {
          lotById.set(r.id, mapLot({
            id: r.id, lot_no: r.lot_no, warehouse_id: null, item_id: null, received_at: null, expiry_date: null,
            unit_cost: null, fat_pct: null, protein_pct: null, supplier_id: r.supplier_id,
            supplier_name: r.supplier_id ? supName.get(r.supplier_id) ?? null : null,
            remaining_qty: null, value: null, is_opening: null, source_doc_type: null, source_doc_id: null, origin_lot_id: null,
          }))
        }
      }
    }
    const consumed: DocLotLine[] = movs.map(m => {
      const lot = lotById.get(m.lot_id as string)
      const qty = Math.abs(Number(m.qty))
      const unitCost = Number(m.unit_cost)
      return {
        lotId: m.lot_id as string,
        lotNo: lot?.lotNo ?? '',
        itemId: m.item_id,
        warehouseId: m.warehouse_id,
        supplierName: lot?.supplierName ?? '',
        qty,
        unitCost,
        total: round2(qty * unitCost),
      }
    })
    const produced = (prodRes.data ?? []).filter(r => r.id).map(r => {
      const lot = mapLot(r)
      return { ...lot, receivedQty: round3(inflowByLot.get(lot.id) ?? lot.remainingQty) }
    })
    return { consumed, produced }
  } catch {
    return null
  }
}

/**
 * Exact line cost: the lots (picked or FEFO preview) when available, with any
 * quantity the lots do not cover priced at avg_cost; avg_cost alone without lots.
 */
export function lineCost(alloc: LotAllocation | null, qty: number, avgCost: number): number {
  if (!alloc) return round2(qty * avgCost)
  return round2(alloc.cost + (alloc.short > 0 ? round2(alloc.short * avgCost) : 0))
}

/**
 * Picks remembered together with the (warehouse, item, qty) they were made
 * for. When any of those change the picks no longer apply (activePicks
 * returns null), which resets the line to automatic FEFO.
 */
export interface LinePicks { warehouseId: string; itemId: string; qty: number; picks: LotPick[] }

export function makeLinePicks(warehouseId: string, itemId: string, qty: number, picks: LotPick[] | null): LinePicks | null {
  return picks && picks.length ? { warehouseId, itemId, qty: round3(qty), picks } : null
}

export function activePicks(p: LinePicks | null | undefined, warehouseId: string, itemId: string, qty: number): LotPick[] | null {
  if (!p || p.warehouseId !== warehouseId || p.itemId !== itemId || p.qty !== round3(qty)) return null
  return p.picks
}
