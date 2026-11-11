// Wholesale sales of the production module (migration
// 20261110000015_production_sales.sql): B2B customers, price lists, sales
// (nakladnoy), sale returns and customer payments. Reads go to the RLS-scoped
// tables / views; every write goes through the SECURITY DEFINER RPCs
// (prod_save_customer, prod_save_price_list, prod_create_sale,
// prod_create_sale_return, prod_create_customer_payment,
// prod_cancel_customer_payment, prod_cancel_document('sale' | 'sale_return')).
// Every read degrades gracefully while the migration is not applied
// (probeSales() = false -> pages show the "available after update" note).

import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { localYmd } from '@/lib/utils/date'
import { round2, round3, type ProdItem } from '@/lib/production'

type Client = ReturnType<typeof createClient>

let probe: Promise<boolean> | null = null

/**
 * Whether migration 20261110000015 is live (prod_sales is readable).
 * Cached per page load; a failed probe is retried on the next call.
 */
export function probeSales(supabase: Client): Promise<boolean> {
  if (!probe) {
    probe = Promise.resolve(supabase.from('prod_sales').select('id').limit(1))
      .then(({ error }) => !error)
      .catch(() => false)
      .then(ok => {
        if (!ok) probe = null
        return ok
      })
  }
  return probe
}

/** prod_create_sale / prod_create_sale_return accept 1..500 lines. */
export const SALE_MAX_LINES = 500
/** Typical VAT rates in Uzbekistan; any 0..100 is accepted. */
export const VAT_PRESETS = [0, 12] as const

// ---------------------------------------------------------------------------
// Customers

export interface ProdCustomer {
  id: string
  name: string
  legalName: string
  inn: string
  phone: string
  address: string
  contactPerson: string
  priceListId: string | null
  creditLimit: number | null
  paymentTermsDays: number | null
  vatPayer: boolean
  note: string
  isActive: boolean
  createdAt: string
  /** Posted sales total (with VAT). */
  salesTotal: number
  returnsTotal: number
  paymentsTotal: number
  /** sales - returns - payments; positive = the customer owes us, negative = advance. */
  balance: number
  lastSaleAt: string | null
}

export interface CustomerAgeing { balance: number; notDue: number; d1_15: number; d16_30: number; d31: number }

export const overdueOf = (a: CustomerAgeing | undefined | null) => (a ? round2(a.d1_15 + a.d16_30 + a.d31) : 0)

const CUSTOMER_COLS = 'id, name, legal_name, inn, phone, address, contact_person, price_list_id, credit_limit, payment_terms_days, vat_payer, note, is_active, created_at'

const numOrNull = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v))

/** Customers with their balances; null when the tables are not available. */
export async function fetchProdCustomers(supabase: Client): Promise<ProdCustomer[] | null> {
  const [cRes, bRes] = await Promise.all([
    fetchAllRows((from, to) => supabase.from('prod_customers').select(CUSTOMER_COLS).order('name').order('id').range(from, to)),
    fetchAllRows((from, to) => supabase.from('prod_customer_balances')
      .select('customer_id, sales_total, returns_total, payments_total, balance, last_sale_at').order('customer_id').range(from, to)),
  ])
  if (cRes.error) return null
  const bal = new Map(bRes.data.filter(b => b.customer_id).map(b => [b.customer_id as string, b]))
  return cRes.data.map(c => {
    const b = bal.get(c.id)
    const salesTotal = Number(b?.sales_total ?? 0)
    const returnsTotal = Number(b?.returns_total ?? 0)
    const paymentsTotal = Number(b?.payments_total ?? 0)
    return {
      id: c.id,
      name: c.name,
      legalName: c.legal_name ?? '',
      inn: c.inn ?? '',
      phone: c.phone ?? '',
      address: c.address ?? '',
      contactPerson: c.contact_person ?? '',
      priceListId: c.price_list_id ?? null,
      creditLimit: numOrNull(c.credit_limit),
      paymentTermsDays: numOrNull(c.payment_terms_days),
      vatPayer: !!c.vat_payer,
      note: c.note ?? '',
      isActive: c.is_active,
      createdAt: c.created_at,
      salesTotal,
      returnsTotal,
      paymentsTotal,
      balance: b?.balance === null || b?.balance === undefined ? round2(salesTotal - returnsTotal - paymentsTotal) : Number(b.balance),
      lastSaleAt: b?.last_sale_at ?? null,
    }
  })
}

/** Ageing per customer id; null when the view is not available. */
export async function fetchCustomerAgeing(supabase: Client): Promise<Map<string, CustomerAgeing> | null> {
  const { data, error } = await fetchAllRows((from, to) => supabase.from('prod_customer_ageing')
    .select('customer_id, balance, not_due, overdue_1_15, overdue_16_30, overdue_31_plus').order('customer_id').range(from, to))
  if (error) return null
  return new Map(data.filter(r => r.customer_id).map(r => [r.customer_id as string, {
    balance: Number(r.balance ?? 0),
    notDue: Number(r.not_due ?? 0),
    d1_15: Number(r.overdue_1_15 ?? 0),
    d16_30: Number(r.overdue_16_30 ?? 0),
    d31: Number(r.overdue_31_plus ?? 0),
  }]))
}

// ---------------------------------------------------------------------------
// Price lists

export interface PriceList {
  id: string
  name: string
  currency: string
  isDefault: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
  /** item id -> price (UZS, without VAT). */
  prices: Map<string, number>
}

/** Price lists with their prices; null when not available. */
export async function fetchPriceLists(supabase: Client): Promise<PriceList[] | null> {
  const [lRes, iRes] = await Promise.all([
    supabase.from('prod_price_lists').select('id, name, currency, is_default, is_active, created_at, updated_at').order('name'),
    fetchAllRows((from, to) => supabase.from('prod_price_list_items').select('price_list_id, item_id, price').order('price_list_id').order('item_id').range(from, to)),
  ])
  if (lRes.error) return null
  const byList = new Map<string, Map<string, number>>()
  for (const r of iRes.data) {
    const m = byList.get(r.price_list_id) ?? new Map<string, number>()
    m.set(r.item_id, Number(r.price))
    byList.set(r.price_list_id, m)
  }
  return (lRes.data ?? []).map(l => ({
    id: l.id,
    name: l.name,
    currency: l.currency ?? 'UZS',
    isDefault: !!l.is_default,
    isActive: !!l.is_active,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    prices: byList.get(l.id) ?? new Map(),
  }))
}

/**
 * Mirrors prod_create_sale's price resolution (inactive lists are skipped):
 * the sale's list, else the customer's list, else the default list, else
 * item.sale_price; null = none (the RPC raises invalid_input / no_price
 * without an explicit price).
 */
export function resolvePrice(
  itemId: string,
  opts: { lists: PriceList[]; saleListId: string | null; customerListId: string | null; item: Pick<ProdItem, 'salePrice'> | undefined },
): number | null {
  const byId = new Map(opts.lists.filter(l => l.isActive).map(l => [l.id, l]))
  const tryList = (id: string | null) => (id ? byId.get(id)?.prices.get(itemId) : undefined)
  const fromList = tryList(opts.saleListId) ?? tryList(opts.customerListId) ?? opts.lists.find(l => l.isDefault && l.isActive)?.prices.get(itemId)
  if (fromList !== undefined) return fromList
  return opts.item?.salePrice ?? null
}

// ---------------------------------------------------------------------------
// Sale math (mirrors prod_create_sale's rounding for the live preview; the
// server recomputes everything)

export function lineAmount(qty: number, price: number, discountPct: number): number {
  return round2(qty * price * (1 - discountPct / 100))
}

export function vatOf(amount: number, vatRate: number): number {
  return round2((amount * vatRate) / 100)
}

export interface SaleTotals { subtotal: number; vat: number; total: number; cost: number; margin: number }

export function saleTotals(lines: { amount: number; cost: number }[], vatRate: number): SaleTotals {
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0))
  const vat = round2(lines.reduce((s, l) => s + vatOf(l.amount, vatRate), 0))
  const cost = round2(lines.reduce((s, l) => s + l.cost, 0))
  return { subtotal, vat, total: round2(subtotal + vat), cost, margin: round2(subtotal - cost) }
}

/** Margin % of revenue; null without revenue. */
export function marginPct(margin: number, revenue: number): number | null {
  return revenue > 0 ? (margin / revenue) * 100 : null
}

export function formatMarginPct(p: number | null): string {
  return p === null ? '—' : `${p.toFixed(1)}%`
}

/** Credit warning returned by prod_create_sale (or computed for the preview). */
export interface CreditWarning { limit: number; balanceBefore: number; balanceAfter: number }

export function creditPreview(customer: Pick<ProdCustomer, 'creditLimit' | 'balance'> | undefined, total: number): CreditWarning | null {
  if (!customer || customer.creditLimit === null) return null
  const after = round2(customer.balance + total)
  return after > customer.creditLimit ? { limit: customer.creditLimit, balanceBefore: customer.balance, balanceAfter: after } : null
}

export function parseCreditWarning(v: unknown): CreditWarning | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.limit === undefined || o.limit === null) return null
  return { limit: Number(o.limit), balanceBefore: Number(o.balance_before ?? 0), balanceAfter: Number(o.balance_after ?? 0) }
}

/** Due date preview: doc date + payment terms (null without terms). */
export function dueDateOf(docYmd: string, termsDays: number | null): string | null {
  if (termsDays === null || !docYmd) return null
  const d = new Date(`${docYmd}T00:00:00`)
  d.setDate(d.getDate() + termsDays)
  return localYmd(d)
}

// ---------------------------------------------------------------------------
// Rows

export interface SaleRow {
  id: string; number: number; doc_date: string; customer_id: string; warehouse_id: string; price_list_id: string | null
  due_date: string | null; vat_rate: number; subtotal: number; vat_amount: number; total: number; cost_total: number; margin: number
  vehicle_no: string | null; driver: string | null; note: string | null; status: string
  created_by_name: string | null; created_at: string; cancelled_at: string | null
}

export const SALE_COLS = 'id, number, doc_date, customer_id, warehouse_id, price_list_id, due_date, vat_rate, subtotal, vat_amount, total, cost_total, margin, vehicle_no, driver, note, status, created_by_name, created_at, cancelled_at'

export interface SaleItemRow {
  id: string; sale_id: string; sort_order: number; item_id: string
  /** The item's unit at sale time (print this, not the current item unit). */
  unit: string
  qty: number; price: number; discount_pct: number
  /** 'manual' | 'sale_list' | 'customer_list' | 'default_list' | 'item'. */
  price_source: string
  amount: number; vat_amount: number; total: number; cost: number; unit_cost: number
}

export const SALE_ITEM_COLS = 'id, sale_id, sort_order, item_id, unit, qty, price, discount_pct, price_source, amount, vat_amount, total, cost, unit_cost'

export interface ReturnRow {
  id: string; number: number; doc_date: string; sale_id: string; customer_id: string; warehouse_id: string
  reason: string | null; note: string | null; subtotal: number; vat_amount: number; total: number; cost_total: number
  /** Cost of the non-restocked lines (value treated as loss). */
  loss_cost: number
  status: string; created_by_name: string | null; created_at: string; cancelled_at: string | null
}

export const RETURN_COLS = 'id, number, doc_date, sale_id, customer_id, warehouse_id, reason, note, subtotal, vat_amount, total, cost_total, loss_cost, status, created_by_name, created_at, cancelled_at'

export interface ReturnItemRow { id: string; return_id: string; sale_item_id: string; item_id: string; qty: number; restock: boolean; amount: number; vat_amount: number; total: number; cost: number }

export const RETURN_ITEM_COLS = 'id, return_id, sale_item_id, item_id, qty, restock, amount, vat_amount, total, cost'

export interface CustomerPaymentRow {
  id: string; number: number; pay_date: string; customer_id: string; amount: number; method: string
  note: string | null; status: string; created_by_name: string | null; created_at: string
  /** Cash & bank (migration 20261110000016); only when selected with '*'. */
  account_id?: string | null
}

export const CUSTOMER_PAYMENT_COLS = 'id, number, pay_date, customer_id, amount, method, note, status, created_by_name, created_at'

/** Already returned qty per sale line (posted returns only, prod_sale_item_returnable). */
export async function fetchReturnedBySaleItem(supabase: Client, saleId: string): Promise<Map<string, number>> {
  const { data } = await supabase.from('prod_sale_item_returnable').select('sale_item_id, returned_qty').eq('sale_id', saleId)
  const out = new Map<string, number>()
  for (const r of data ?? []) if (r.sale_item_id) out.set(r.sale_item_id, round3(Number(r.returned_qty ?? 0)))
  return out
}

/** Credit of a returned quantity of a sale line: price incl. discount, plus the sale's VAT. */
export function returnLineAmounts(line: Pick<SaleItemRow, 'price' | 'discount_pct' | 'qty' | 'cost'>, qty: number, vatRate: number) {
  const amount = lineAmount(qty, Number(line.price), Number(line.discount_pct))
  const vat = vatOf(amount, vatRate)
  const soldQty = Number(line.qty)
  const cost = soldQty > 0 ? round2((Number(line.cost) * qty) / soldQty) : 0
  return { amount, vat, total: round2(amount + vat), cost }
}
