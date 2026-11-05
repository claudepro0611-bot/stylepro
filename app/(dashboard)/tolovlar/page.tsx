'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, Loader2, Search, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import type { TranslationKey } from '@/lib/i18n/translations'

const ITEMS_PER_PAGE = 20
const PAYMENT_METHODS = ['Naqd', 'Karta', 'Click', 'Payme']

type PaymentKind = 'sale' | 'refund' | 'debt'

const KIND_LABEL: Record<PaymentKind, TranslationKey> = {
  sale: 'paymentsPage.kind.sale',
  refund: 'paymentsPage.kind.refund',
  debt: 'paymentsPage.kind.debt',
}

const KIND_BADGE: Record<PaymentKind, string> = {
  sale: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400',
  refund: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
  debt: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
}

interface PaymentRow {
  id: string
  kind: PaymentKind
  createdAt: string
  receipt: string
  customer: string
  method: string
  amount: number   // signed: refunds are negative
  cashier: string
}

interface TxnRow { id: string; customer_name: string | null; total_amount: number; created_at: string; payment_method: string | null; cashier_name: string | null; status: string }
interface ReturnRow { id: string; created_at: string; transactions: { id: string; customer_name: string | null; payment_method: string | null } | null; return_items: { refund_amount: number }[] }
interface NasiyaRow { id: string; amount: number; created_at: string; note: string | null; customers: { full_name: string | null } | null }

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

const selectCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

export default function TolovlarPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [range, setRange] = useState<DateRangeValue | null>(() => {
    const today = localYmd()
    return { from: today, to: today }
  })
  const [methodFilter, setMethodFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState<'all' | PaymentKind>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    let active = true
    ;(async () => {
      const supabase = createClient()
      const [txns, returns, nasiya] = await Promise.all([
        fetchAllRows<TxnRow>((from, to) =>
          supabase.from('transactions')
            .select('id, customer_name, total_amount, created_at, payment_method, cashier_name, status')
            .eq('status', 'completed')
            .order('id').range(from, to) as unknown as PromiseLike<{ data: TxnRow[] | null; error: unknown }>),
        fetchAllRows<ReturnRow>((from, to) =>
          supabase.from('returns')
            .select('id, created_at, transactions(id, customer_name, payment_method), return_items(refund_amount)')
            .order('id').range(from, to) as unknown as PromiseLike<{ data: ReturnRow[] | null; error: unknown }>),
        fetchAllRows<NasiyaRow>((from, to) =>
          supabase.from('nasiya_transactions')
            .select('id, amount, created_at, note, customers(full_name)')
            .eq('type', 'repaid')
            .order('id').range(from, to) as unknown as PromiseLike<{ data: NasiyaRow[] | null; error: unknown }>),
      ])
      if (!active) return
      const list: PaymentRow[] = []
      for (const tx of txns.data) {
        if (Number(tx.total_amount) <= 0) continue
        list.push({
          id: `s-${tx.id}`, kind: 'sale', createdAt: tx.created_at,
          receipt: `#${tx.id.slice(0, 8).toUpperCase()}`, customer: tx.customer_name ?? '—',
          method: tx.payment_method ?? '—', amount: Number(tx.total_amount), cashier: tx.cashier_name ?? '—',
        })
      }
      for (const r of returns.data) {
        const refund = r.return_items.reduce((s, i) => s + Number(i.refund_amount), 0)
        if (refund <= 0) continue
        list.push({
          id: `r-${r.id}`, kind: 'refund', createdAt: r.created_at,
          receipt: r.transactions ? `#${r.transactions.id.slice(0, 8).toUpperCase()}` : '—',
          customer: r.transactions?.customer_name ?? '—', method: r.transactions?.payment_method ?? '—',
          amount: -refund, cashier: '—',
        })
      }
      for (const n of nasiya.data) {
        list.push({
          id: `n-${n.id}`, kind: 'debt', createdAt: n.created_at, receipt: '—',
          customer: n.customers?.full_name ?? '—', method: '—', amount: Number(n.amount), cashier: '—',
        })
      }
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setRows(list)
      setLoading(false)
    })()
    return () => { active = false }
  }, [])

  const filtered = useMemo(() => {
    let list = rows
    if (range) {
      list = list.filter(r => {
        const day = localYmd(new Date(r.createdAt))
        return day >= range.from && day <= range.to
      })
    }
    if (methodFilter !== 'all') list = list.filter(r => r.method === methodFilter)
    if (kindFilter !== 'all') list = list.filter(r => r.kind === kindFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(r => r.customer.toLowerCase().includes(q) || r.receipt.toLowerCase().includes(q) || r.cashier.toLowerCase().includes(q))
    }
    return list
  }, [rows, range, methodFilter, kindFilter, search])

  // Net per payment method (sales minus refunds); debt repayments have no
  // recorded method, so they get their own card.
  const byMethod = useMemo(() => {
    const map = new Map<string, number>(PAYMENT_METHODS.map(m => [m, 0]))
    let debt = 0
    for (const r of filtered) {
      if (r.kind === 'debt') debt += r.amount
      else map.set(r.method, (map.get(r.method) ?? 0) + r.amount)
    }
    return { map, debt }
  }, [filtered])
  const netTotal = filtered.reduce((s, r) => s + r.amount, 0)

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE))
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  function exportCSV() {
    const headers = [t('paymentsPage.date'), t('paymentsPage.type'), t('paymentsPage.receipt'), t('paymentsPage.customer'), t('paymentsPage.method'), t('paymentsPage.amount'), t('paymentsPage.cashier')]
    const data = filtered.map(r => [formatDateTime(r.createdAt), t(KIND_LABEL[r.kind]), r.receipt, r.customer, r.method, String(r.amount), r.cashier])
    const csv = [headers, ...data].map(r => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tolovlar_${localYmd()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('paymentsPage.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('paymentsPage.subtitle')}</p>
        </div>
        <button onClick={exportCSV} disabled={filtered.length === 0}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50">
          <Download className="h-4 w-4" /> {t('paymentsPage.export')}
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <div className="col-span-2 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-5">
          <p className="text-[12.5px] text-gray-500 dark:text-gray-400">{t('paymentsPage.netTotal')}</p>
          <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(netTotal)}</p>
        </div>
        {PAYMENT_METHODS.map(m => (
          <div key={m} className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-5">
            <p className="text-[12.5px] text-gray-500 dark:text-gray-400">{m}</p>
            <p className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(byMethod.map.get(m) ?? 0)}</p>
          </div>
        ))}
      </div>
      {byMethod.debt > 0 && (
        <p className="-mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t('paymentsPage.kind.debt')}: <span className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(byMethod.debt)}</span>
        </p>
      )}

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={r => { setRange(r); setPage(1) }} />
        <select value={methodFilter} onChange={e => { setMethodFilter(e.target.value); setPage(1) }} className={selectCls}>
          <option value="all">{t('paymentsPage.allMethods')}</option>
          {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={kindFilter} onChange={e => { setKindFilter(e.target.value as 'all' | PaymentKind); setPage(1) }} className={selectCls}>
          <option value="all">{t('paymentsPage.allTypes')}</option>
          {(Object.keys(KIND_LABEL) as PaymentKind[]).map(k => <option key={k} value={k}>{t(KIND_LABEL[k])}</option>)}
        </select>
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('paymentsPage.search')}
            className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500" />
        </div>
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
            <Wallet className="h-6 w-6" /> {t('paymentsPage.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3 font-medium">{t('paymentsPage.date')}</th>
                  <th className="px-4 py-3 font-medium">{t('paymentsPage.type')}</th>
                  <th className="px-4 py-3 font-medium">{t('paymentsPage.receipt')}</th>
                  <th className="px-4 py-3 font-medium">{t('paymentsPage.customer')}</th>
                  <th className="px-4 py-3 font-medium">{t('paymentsPage.method')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('paymentsPage.amount')}</th>
                  <th className="px-4 py-3 font-medium">{t('paymentsPage.cashier')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr key={r.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-gray-700 dark:text-gray-300 tabular-nums">{formatDateTime(r.createdAt)}</td>
                    <td className="px-4 py-3"><span className={cn('rounded-full px-2 py-0.5 text-xs', KIND_BADGE[r.kind])}>{t(KIND_LABEL[r.kind])}</span></td>
                    <td className="px-4 py-3 font-mono text-[12.5px] text-gray-700 dark:text-gray-300">{r.receipt}</td>
                    <td className="px-4 py-3 text-gray-900 dark:text-gray-100">{r.customer}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{r.method}</td>
                    <td className={cn('px-4 py-3 text-right tabular-nums font-medium', r.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>
                      {r.amount < 0 ? `−${formatPrice(-r.amount)}` : formatPrice(r.amount)}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{r.cashier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination currentPage={page} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
    </div>
  )
}
