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

export type ProdDocType = 'receipt' | 'production' | 'processing' | 'transfer'
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
  'duplicate_name', 'already_cancelled', 'negative_balance', 'business_type_immutable',
] as const

/** Maps a RAISE EXCEPTION '<code>' message from the prod_* RPCs to a translation key. */
export function prodErrorKey(message: string | null | undefined): TranslationKey {
  const msg = message ?? ''
  const code = ERROR_CODES.find(c => msg.includes(c))
  if (code) return `productionErrors.${code}` as TranslationKey
  // Unique violations surface as Postgres 23505 text when the RPC does not map them.
  if (/duplicate key|unique/i.test(msg)) return 'productionErrors.duplicate_name'
  return 'productionErrors.unknown'
}

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
  const [supRes, balRes] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase.from('prod_suppliers').select('id, name, phone, address, note, is_active, created_at').order('name').order('id').range(from, to)),
    fetchAllRows((from, to) =>
      supabase.from('prod_supplier_balances').select('supplier_id, purchased, paid, debt, last_receipt_at, last_payment_at').order('supplier_id').range(from, to)),
  ])
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

/**
 * Yield % (output / input * 100) when output and inputs are comparable: the
 * output is mass or volume and every mass/volume input is in the same group.
 * Piece and length inputs (packaging) are ignored. Null when not comparable.
 */
export function yieldPercent(output: { qty: number; unit: ProdUnit } | null, inputs: { qty: number; unit: ProdUnit }[]): number | null {
  if (!output || !(output.qty > 0)) return null
  const outGroup = unitGroupOf(output.unit)
  if (outGroup !== 'mass' && outGroup !== 'volume') return null
  let input = 0
  for (const l of inputs) {
    if (!(l.qty > 0)) continue
    const g = unitGroupOf(l.unit)
    if (g === 'pcs' || g === 'm') continue
    if (g !== outGroup) return null
    input += toGroupQty(l.qty, l.unit)
  }
  if (!(input > 0)) return null
  return (toGroupQty(output.qty, output.unit) / input) * 100
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
