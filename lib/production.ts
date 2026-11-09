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

export type ProdDocType = 'receipt' | 'production' | 'processing'
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
