'use client'

// Mijozlar: the single customers hub — every customer with their stats for
// the chosen period, search/status filters, add-customer, and a click-through
// customer card (drawer). Replaces the old standalone /customers list.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, CreditCard, Search, UserCheck, UserPlus, Users, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatPhone } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { KpiGrid, downloadCsv, monthToDate, segBtnCls } from '@/components/reports/ReportKit'
import { Pagination } from '@/components/ui/Pagination'
import { CustomerDrawer } from '@/components/customers/CustomerDrawer'
import { AddCustomerDialog } from '@/components/customers/AddCustomerDialog'
import { useBranchColumn } from '@/components/customers/branchUi'
import { useBranchFilter } from '@/lib/session/useBranch'
import type { Customer } from '@/lib/types'

const PAGE_SIZE = 20
const STATUSES = ['all', 'VIP', 'Regular', 'New'] as const
type StatusFilter = typeof STATUSES[number]

interface TxnRow { id: string; customer_id: string | null; date: string; net_amount: number }
interface ItemRow { transaction_id: string; quantity: number; returned_quantity: number; transactions: { date: string; status: string } | null }
interface CustomerRow { id: string; full_name: string; phone: string | null; status: Customer['status']; last_purchase_date: string | null; created_at: string; branch_id?: string | null }
interface NasiyaRow { customer_id: string; type: string; amount: number }

interface Row {
  id: string
  name: string
  phone: string
  status: Customer['status']
  receipts: number
  qty: number
  amount: number
  avg: number
  lastDate: string
  debt: number
  branchId: string | null
}

type SortKey = 'name' | 'receipts' | 'qty' | 'amount' | 'avg' | 'lastDate' | 'debt'

function initials(name: string) {
  return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
}

export default function CustomersHubPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [loading, setLoading] = useState(true)
  const [txns, setTxns] = useState<TxnRow[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  const [debts, setDebts] = useState<Map<string, number>>(new Map())
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [buyersOnly, setBuyersOnly] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'amount', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const applyBranch = useBranchFilter()
  const branchCol = useBranchColumn()
  const showBranch = branchCol.show

  const loadCustomers = useCallback(async () => {
    const supabase = createClient()
    // branch_id is only selected when the branch column is shown (multi-branch
    // owner/admin on "All branches"), so single-branch installs send the same query as before.
    const custCols = `id, full_name, phone, status, last_purchase_date, created_at${showBranch ? ', branch_id' : ''}`
    const [custRes, nasiyaRes] = await Promise.all([
      fetchAllRows<CustomerRow>((from, to) => applyBranch(supabase.from('customers').select(custCols)).order('id').range(from, to) as unknown as PromiseLike<{ data: CustomerRow[] | null; error: unknown }>),
      fetchAllRows<NasiyaRow>((from, to) => applyBranch(supabase.from('nasiya_transactions').select('customer_id, type, amount')).order('id').range(from, to)),
    ])
    setCustomers(custRes.data)
    const d = new Map<string, number>()
    for (const n of nasiyaRes.data) d.set(n.customer_id, (d.get(n.customer_id) ?? 0) + (n.type === 'given' ? 1 : -1) * Number(n.amount))
    setDebts(d)
  }, [applyBranch, showBranch])

  useEffect(() => { loadCustomers() }, [loadCustomers])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const [txnRes, itemRes] = await Promise.all([
        fetchAllRows<TxnRow>((from, to) => {
          let q = applyBranch(supabase.from('transactions_net').select('id, customer_id, date, net_amount').eq('status', 'completed'))
          if (range) q = q.gte('date', range.from).lte('date', range.to)
          return q.order('id').range(from, to) as unknown as PromiseLike<{ data: TxnRow[] | null; error: unknown }>
        }),
        fetchAllRows<ItemRow>((from, to) => {
          let q = applyBranch(supabase.from('transaction_items')
            .select('transaction_id, quantity, returned_quantity, transactions!inner(date, status)')
            .eq('transactions.status', 'completed'))
          if (range) q = q.gte('transactions.date', range.from).lte('transactions.date', range.to)
          return q.order('id').range(from, to) as unknown as PromiseLike<{ data: ItemRow[] | null; error: unknown }>
        }),
      ])
      if (cancelled) return
      setTxns(txnRes.data)
      setItems(itemRes.data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, applyBranch])

  // Per-customer stats for the period, plus guest (no customer) totals.
  const { rows, guest } = useMemo(() => {
    const qtyByTxn = new Map<string, number>()
    for (const it of items) qtyByTxn.set(it.transaction_id, (qtyByTxn.get(it.transaction_id) ?? 0) + Math.max(0, it.quantity - (it.returned_quantity ?? 0)))
    const stats = new Map<string, { receipts: number; qty: number; amount: number }>()
    const guest = { receipts: 0, amount: 0 }
    for (const x of txns) {
      const amount = Number(x.net_amount)
      if (!x.customer_id) {
        guest.amount += amount
        if (amount > 0) guest.receipts += 1
        continue
      }
      const s = stats.get(x.customer_id) ?? { receipts: 0, qty: 0, amount: 0 }
      s.amount += amount
      s.qty += qtyByTxn.get(x.id) ?? 0
      if (amount > 0) s.receipts += 1
      stats.set(x.customer_id, s)
    }
    const rows: Row[] = customers.map(c => {
      const s = stats.get(c.id) ?? { receipts: 0, qty: 0, amount: 0 }
      return {
        id: c.id, name: c.full_name, phone: c.phone ?? '', status: c.status,
        receipts: s.receipts, qty: s.qty, amount: s.amount,
        avg: s.receipts > 0 ? s.amount / s.receipts : 0,
        lastDate: c.last_purchase_date ?? '',
        debt: Math.max(0, debts.get(c.id) ?? 0),
        branchId: c.branch_id ?? null,
      }
    })
    return { rows, guest }
  }, [txns, items, customers, debts])

  const filtered = useMemo(() => {
    let list = rows
    if (buyersOnly) list = list.filter(r => r.receipts > 0)
    if (status !== 'all') list = list.filter(r => r.status === status)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter(r => r.name.toLowerCase().includes(q) || r.phone.includes(q))
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const va = a[sort.key], vb = b[sort.key]
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * dir
    })
  }, [rows, buyersOnly, status, search, sort])

  const totals = useMemo(() => {
    const buyers = rows.filter(r => r.receipts > 0)
    const amount = buyers.reduce((s, r) => s + r.amount, 0)
    const all = amount + guest.amount
    return {
      customers: rows.length,
      buyers: buyers.length,
      amount,
      share: all > 0 ? (amount / all) * 100 : 0,
      avg: buyers.length > 0 ? amount / buyers.length : 0,
      debt: rows.reduce((s, r) => s + r.debt, 0),
      debtors: rows.filter(r => r.debt > 0).length,
    }
  }, [rows, guest])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function toggleSort(key: SortKey) {
    setSort(prev => (prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }))
    setPage(1)
  }

  function exportCsv() {
    downloadCsv('mijozlar', [t('customersReport.customer'), t('customersReport.phone'), t('customersReport.status'), t('salesReport.receipts'), t('customersReport.items'), t('customersReport.amount'), t('salesReport.avgReceipt'), t('customersReport.lastPurchase'), t('customersReport.debt')],
      filtered.map(r => [r.name, r.phone, r.status, r.receipts, r.qty, Math.round(r.amount), Math.round(r.avg), r.lastDate, Math.round(r.debt)]))
  }

  const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, '')}%`

  const th = (key: SortKey, label: string, right = true) => (
    <th className={cn('px-4 py-3 font-medium whitespace-nowrap', right ? 'text-right' : 'text-left')}>
      <button onClick={() => toggleSort(key)} className={cn('inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 transition-colors', sort.key === key && 'text-gray-900 dark:text-gray-100')}>
        {label}{sort.key === key && <span className="text-[10px]">{sort.dir === 'desc' ? '▼' : '▲'}</span>}
      </button>
    </th>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('sidebar.customers')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{totals.customers} {t('customers.countSuffix')} · {t('customersReport.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setAddOpen(true)} className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-white transition-colors">
            <UserPlus className="h-4 w-4" /> {t('customers.addNew')}
          </button>
        </div>
      </div>

      <KpiGrid items={[
        { label: t('customersReport.buyers'), value: `${totals.buyers} / ${totals.customers}`, icon: Users },
        { label: `${t('customersReport.amount')} · ${pct(totals.share)}`, value: formatPrice(totals.amount), icon: Wallet },
        { label: t('customersReport.avgPerCustomer'), value: formatPrice(Math.round(totals.avg)), icon: UserCheck },
        { label: `${t('customersReport.totalDebt')} · ${totals.debtors}`, value: formatPrice(totals.debt), icon: CreditCard, tone: totals.debt > 0 ? 'negative' : undefined },
      ]} />

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={r => { setRange(r); setPage(1) }} />
        <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          {STATUSES.map(s => (
            <button key={s} onClick={() => { setStatus(s); setPage(1) }} className={segBtnCls(status === s)}>
              {s === 'all' ? t('customers.filterAll') : s === 'New' ? t('customers.filterNew') : s}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 select-none">
          <input type="checkbox" checked={buyersOnly} onChange={e => { setBuyersOnly(e.target.checked); setPage(1) }} className="h-4 w-4 rounded border-gray-300" />
          {t('customersReport.buyersOnly')}
        </label>
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('customers.searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500" />
        </div>
        <button onClick={exportCsv} className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-medium text-white transition-colors">
          {t('reportsKit.export')}
        </button>
      </div>

      {guest.receipts > 0 && (
        <p className="-mt-2 text-[12.5px] text-gray-500 dark:text-gray-400">
          {t('customersReport.guest')}: <span className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">{guest.receipts}</span> {t('customersReport.receiptsShort')} · <span className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(guest.amount)}</span>
        </p>
      )}

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading && customers.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">{t('common.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('customers.notFound')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  {th('name', t('customersReport.customer'), false)}
                  {th('receipts', t('salesReport.receipts'))}
                  {th('qty', t('customersReport.items'))}
                  {th('amount', t('customersReport.amount'))}
                  {th('avg', t('salesReport.avgReceipt'))}
                  {th('lastDate', t('customersReport.lastPurchase'))}
                  {th('debt', t('customersReport.debt'))}
                  {showBranch && <th className="px-4 py-3 text-left font-medium whitespace-nowrap">{t('branchCustomers.branchColumn')}</th>}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className={cn(loading && 'opacity-60 transition-opacity')}>
                {paginated.map(r => (
                  <tr key={r.id} onClick={() => setOpenId(r.id)} className="group cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300">{initials(r.name)}</div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate font-medium text-gray-900 dark:text-gray-100">{r.name}</p>
                            <MiniBadge status={r.status} />
                          </div>
                          {r.phone && <p className="text-xs text-gray-400 dark:text-gray-500">{formatPhone(r.phone)}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{r.receipts || <span className="text-gray-300 dark:text-gray-600">—</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300">{r.qty || <span className="text-gray-300 dark:text-gray-600">—</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{r.amount ? formatPrice(r.amount) : <span className="font-normal text-gray-300 dark:text-gray-600">—</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700 dark:text-gray-300 whitespace-nowrap">{r.avg ? formatPrice(Math.round(r.avg)) : <span className="text-gray-300 dark:text-gray-600">—</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">{r.lastDate ? formatDate(r.lastDate) : '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{r.debt > 0 ? <span className="text-red-600 dark:text-red-400">{formatPrice(r.debt)}</span> : <span className="text-gray-300 dark:text-gray-600">—</span>}</td>
                    {showBranch && <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400 whitespace-nowrap">{branchCol.branchName(r.branchId)}</td>}
                    <td className="pr-3 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-400"><ChevronRight className="h-4 w-4" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />

      <CustomerDrawer customerId={openId} onClose={() => setOpenId(null)} onChanged={loadCustomers} />
      <AddCustomerDialog open={addOpen} onOpenChange={setAddOpen} onCreated={loadCustomers} />
    </div>
  )
}
