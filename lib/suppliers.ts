import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'

type Supabase = ReturnType<typeof createClient>

export type SupplierPaymentMethod = 'cash' | 'card' | 'transfer'
export const SUPPLIER_PAYMENT_METHODS: SupplierPaymentMethod[] = ['cash', 'card', 'transfer']

export interface Supplier {
  id: string
  name: string
  phone: string
  companyName: string
  inn: string
  address: string
  note: string
  openingBalance: number
  isActive: boolean
}

export interface SupplierWithBalance extends Supplier {
  purchases: number
  returned: number
  paid: number
  /** What we owe: opening + purchases − returned − paid. Negative = prepaid. */
  balance: number
  entries: number
  lastPurchase: string | null
}

interface SupplierRow {
  id: string
  name: string
  phone: string | null
  company_name: string | null
  inn: string | null
  address: string | null
  note: string | null
  opening_balance: number | null
  is_active: boolean
}

export function mapSupplier(r: SupplierRow): Supplier {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone ?? '',
    companyName: r.company_name ?? '',
    inn: r.inn ?? '',
    address: r.address ?? '',
    note: r.note ?? '',
    openingBalance: Number(r.opening_balance ?? 0),
    isActive: r.is_active,
  }
}

/** Purchase value of a kirim entry — same rule as the kirim report. */
export function entryAmount(e: { total_amount: number | null; quantity: number; purchase_price: number | null; unit_price?: number | null }): number {
  const total = Number(e.total_amount ?? 0)
  return total > 0 ? total : Number(e.quantity) * Number(e.purchase_price ?? e.unit_price ?? 0)
}

/** Value credited back by the supplier for a return. */
export function returnValue(items: { quantity: number; price: number }[]): number {
  return items.reduce((s, i) => s + Number(i.quantity) * Number(i.price), 0)
}

export async function fetchSuppliers(supabase: Supabase): Promise<Supplier[]> {
  const { data } = await supabase
    .from('suppliers')
    .select('id, name, phone, company_name, inn, address, note, opening_balance, is_active')
    .order('name')
  return ((data ?? []) as SupplierRow[]).map(mapSupplier)
}

export async function fetchSuppliersWithBalance(supabase: Supabase): Promise<SupplierWithBalance[]> {
  const [suppliers, entriesRes, paymentsRes, returnsRes] = await Promise.all([
    fetchSuppliers(supabase),
    fetchAllRows<{ supplier_id: string; total_amount: number | null; quantity: number; purchase_price: number | null; date: string }>((from, to) =>
      supabase.from('stock_in_entries')
        .select('supplier_id, total_amount, quantity, purchase_price, date')
        .eq('entry_type', 'purchase')
        .not('supplier_id', 'is', null)
        .order('id').range(from, to) as unknown as PromiseLike<{ data: { supplier_id: string; total_amount: number | null; quantity: number; purchase_price: number | null; date: string }[] | null; error: unknown }>),
    fetchAllRows<{ supplier_id: string; amount: number }>((from, to) =>
      supabase.from('supplier_payments').select('supplier_id, amount').order('id').range(from, to)),
    fetchAllRows<{ supplier_id: string; supplier_return_items: { quantity: number; price: number }[] }>((from, to) =>
      supabase.from('supplier_returns').select('supplier_id, supplier_return_items(quantity, price)').order('id').range(from, to)),
  ])

  const purchases = new Map<string, { sum: number; count: number; last: string | null }>()
  for (const e of entriesRes.data) {
    const p = purchases.get(e.supplier_id) ?? { sum: 0, count: 0, last: null }
    p.sum += entryAmount(e)
    p.count += 1
    if (!p.last || e.date > p.last) p.last = e.date
    purchases.set(e.supplier_id, p)
  }
  const paid = new Map<string, number>()
  for (const p of paymentsRes.data) paid.set(p.supplier_id, (paid.get(p.supplier_id) ?? 0) + Number(p.amount))

  const returned = new Map<string, number>()
  for (const r of returnsRes.data) returned.set(r.supplier_id, (returned.get(r.supplier_id) ?? 0) + returnValue(r.supplier_return_items))

  return suppliers.map(s => {
    const pur = purchases.get(s.id)
    const pd = paid.get(s.id) ?? 0
    const ret = returned.get(s.id) ?? 0
    const sum = pur?.sum ?? 0
    return {
      ...s,
      purchases: sum,
      returned: ret,
      paid: pd,
      balance: s.openingBalance + sum - ret - pd,
      entries: pur?.count ?? 0,
      lastPurchase: pur?.last ?? null,
    }
  })
}

/** Maps an RPC error from the supplier functions to a translation key. */
export function supplierErrorKey(message: string): 'common.forbidden' | 'suppliersPage.duplicateName' | 'suppliersPage.hasHistory' | 'suppliersPage.nameRequired' | 'suppliersPage.invalidAmount' | 'common.error' {
  if (message.includes('forbidden')) return 'common.forbidden'
  if (message.includes('suppliers_company_name_key') || message.includes('duplicate key')) return 'suppliersPage.duplicateName'
  if (message.includes('has history')) return 'suppliersPage.hasHistory'
  if (message.includes('name is required')) return 'suppliersPage.nameRequired'
  if (message.includes('Invalid amount')) return 'suppliersPage.invalidAmount'
  return 'common.error'
}
