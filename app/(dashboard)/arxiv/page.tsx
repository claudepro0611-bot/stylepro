'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Printer, Search, Loader2, Archive as ArchiveIcon, RotateCcw } from 'lucide-react'
import { Pagination } from '@/components/ui/Pagination'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { ReturnModal, type ReturnableItem } from '@/components/arxiv/ReturnModal'
import { createClient } from '@/lib/supabase/client'
import { formatDateTime, formatDuration } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { Shift } from '@/lib/types'

const ITEMS_PER_PAGE = 20
const PAYMENT_METHODS = ['Naqd', 'Karta', 'Click', 'Payme']
const TODAY = new Date().toISOString().slice(0, 10)

type DatePreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

const DATE_PRESETS: { value: DatePreset; labelKey: TranslationKey }[] = [
  { value: 'today', labelKey: 'chiqim.datePresets.today' },
  { value: 'yesterday', labelKey: 'chiqim.datePresets.yesterday' },
  { value: 'week', labelKey: 'chiqim.datePresets.week' },
  { value: 'month', labelKey: 'chiqim.datePresets.month' },
  { value: 'custom', labelKey: 'chiqim.datePresets.custom' },
]

const pillCls = (active: boolean) =>
  cn(
    'px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors',
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
  )

const selectCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const dateInputCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function presetRange(preset: DatePreset | null, customFrom: string, customTo: string): [string, string] | null {
  if (!preset) return null
  const [ty, tm, td] = TODAY.split('-').map(Number)
  const today = new Date(Date.UTC(ty, tm - 1, td))

  switch (preset) {
    case 'today':
      return [TODAY, TODAY]
    case 'yesterday': {
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - 1)
      const s = ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
      return [s, s]
    }
    case 'week': {
      const d = new Date(today)
      const dow = (d.getUTCDay() + 6) % 7
      d.setUTCDate(d.getUTCDate() - dow)
      return [ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), TODAY]
    }
    case 'month':
      return [ymd(ty, tm, 1), TODAY]
    case 'custom':
      if (!customFrom || !customTo) return null
      return customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom]
  }
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

interface TransactionRow {
  id: string
  customer_name: string | null
  total_amount: number
  net_amount: number
  returned_amount: number
  status: string
  date: string
  created_at: string
  payment_method: string
  cashier_name: string | null
}

interface TransactionItemRow {
  id: string
  transaction_id: string
  product_id: string
  product_name: string
  quantity: number
  price: number
  returned_quantity: number
  product_size_id: string | null
}

function receiptNumber(id: string): string {
  return `#${id.slice(0, 8).toUpperCase()}`
}

export default function ArxivPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [activeTab, setActiveTab] = useState<'shifts' | 'sales'>('shifts')
  const [loading, setLoading] = useState(true)

  const [shifts, setShifts] = useState<Shift[]>([])
  const [transactions, setTransactions] = useState<TransactionRow[]>([])
  const [items, setItems] = useState<TransactionItemRow[]>([])
  const [products, setProducts] = useState<{ id: string; name: string }[]>([])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [shiftsRes, txnsRes, itemsRes, productsRes] = await Promise.all([
      supabase.from('shifts').select('*').eq('status', 'closed').order('started_at', { ascending: false }),
      supabase.from('transactions_net').select('id, customer_name, total_amount, net_amount, returned_amount, status, date, created_at, payment_method, cashier_name').order('created_at', { ascending: false }),
      supabase.from('transaction_items').select('id, transaction_id, product_id, product_name, quantity, price, returned_quantity, product_size_id'),
      supabase.from('products').select('id, name').order('name'),
    ])

    setShifts((shiftsRes.data ?? []) as Shift[])
    setTransactions((txnsRes.data ?? []) as TransactionRow[])
    setItems((itemsRes.data ?? []) as TransactionItemRow[])
    setProducts((productsRes.data ?? []) as { id: string; name: string }[])
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const itemsByTxn = useMemo(() => {
    const map = new Map<string, TransactionItemRow[]>()
    for (const item of items) {
      const arr = map.get(item.transaction_id) ?? []
      arr.push(item)
      map.set(item.transaction_id, arr)
    }
    return map
  }, [items])

  // A transaction is returnable at all only if at least one of its lines has
  // a recorded product_size_id — legacy sales predating the Phase 3 backfill
  // (see 20260717000001_returns_flow.sql) can't be tied to a variant.
  function isTxnReturnable(txnId: string): boolean {
    return (itemsByTxn.get(txnId) ?? []).some(i => i.product_size_id !== null)
  }

  // ─── Tab 1: Shift reports ──────────────────────────────────────────────
  const [shiftDatePreset, setShiftDatePreset] = useState<DatePreset | null>(null)
  const [shiftCustomFrom, setShiftCustomFrom] = useState('')
  const [shiftCustomTo, setShiftCustomTo] = useState('')
  const [shiftCashierFilter, setShiftCashierFilter] = useState('all')
  const [shiftPage, setShiftPage] = useState(1)
  const [selectedShift, setSelectedShift] = useState<Shift | null>(null)

  const shiftCashierOptions = useMemo(() => {
    const set = new Set<string>()
    shifts.forEach(s => { if (s.cashier_name) set.add(s.cashier_name) })
    return Array.from(set).sort()
  }, [shifts])

  const filteredShifts = useMemo(() => {
    let list = shifts
    const range = presetRange(shiftDatePreset, shiftCustomFrom, shiftCustomTo)
    if (range) {
      const [from, to] = range
      list = list.filter(s => {
        const day = s.started_at.slice(0, 10)
        return day >= from && day <= to
      })
    }
    if (shiftCashierFilter !== 'all') {
      list = list.filter(s => s.cashier_name === shiftCashierFilter)
    }
    return list
  }, [shifts, shiftDatePreset, shiftCustomFrom, shiftCustomTo, shiftCashierFilter])

  const shiftTotalPages = Math.max(1, Math.ceil(filteredShifts.length / ITEMS_PER_PAGE))
  const paginatedShifts = filteredShifts.slice((shiftPage - 1) * ITEMS_PER_PAGE, shiftPage * ITEMS_PER_PAGE)

  // ─── Tab 2: Sales archive ───────────────────────────────────────────────
  const [saleDatePreset, setSaleDatePreset] = useState<DatePreset | null>(null)
  const [saleCustomFrom, setSaleCustomFrom] = useState('')
  const [saleCustomTo, setSaleCustomTo] = useState('')
  const [saleProductFilter, setSaleProductFilter] = useState('all')
  const [saleCashierFilter, setSaleCashierFilter] = useState('all')
  const [salePaymentFilter, setSalePaymentFilter] = useState('all')
  const [saleSearch, setSaleSearch] = useState('')
  const [salePage, setSalePage] = useState(1)
  const [selectedTxn, setSelectedTxn] = useState<TransactionRow | null>(null)
  const [returnTxnId, setReturnTxnId] = useState<string | null>(null)

  const saleCashierOptions = useMemo(() => {
    const set = new Set<string>()
    transactions.forEach(tr => { if (tr.cashier_name) set.add(tr.cashier_name) })
    return Array.from(set).sort()
  }, [transactions])

  const filteredSales = useMemo(() => {
    let list = transactions
    const range = presetRange(saleDatePreset, saleCustomFrom, saleCustomTo)
    if (range) {
      const [from, to] = range
      list = list.filter(tr => {
        const day = tr.created_at.slice(0, 10)
        return day >= from && day <= to
      })
    }
    if (saleCashierFilter !== 'all') {
      list = list.filter(tr => tr.cashier_name === saleCashierFilter)
    }
    if (salePaymentFilter !== 'all') {
      list = list.filter(tr => tr.payment_method === salePaymentFilter)
    }
    if (saleProductFilter !== 'all') {
      list = list.filter(tr => (itemsByTxn.get(tr.id) ?? []).some(i => i.product_id === saleProductFilter))
    }
    if (saleSearch.trim()) {
      const q = saleSearch.trim().toLowerCase()
      list = list.filter(tr =>
        (tr.customer_name ?? '').toLowerCase().includes(q) ||
        receiptNumber(tr.id).toLowerCase().includes(q) ||
        (tr.cashier_name ?? '').toLowerCase().includes(q),
      )
    }
    return list
  }, [transactions, saleDatePreset, saleCustomFrom, saleCustomTo, saleCashierFilter, salePaymentFilter, saleProductFilter, saleSearch, itemsByTxn])

  const saleTotalPages = Math.max(1, Math.ceil(filteredSales.length / ITEMS_PER_PAGE))
  const paginatedSales = filteredSales.slice((salePage - 1) * ITEMS_PER_PAGE, salePage * ITEMS_PER_PAGE)

  function exportCSV() {
    const headers = [
      t('arxiv.salesTable.time'), t('arxiv.salesTable.receipt'), t('arxiv.salesTable.cashier'),
      t('arxiv.salesTable.customer'), t('arxiv.salesTable.amount'), t('arxiv.salesTable.payment'),
    ]
    const rows = filteredSales.map(tr => [
      formatDateTime(tr.created_at), receiptNumber(tr.id), tr.cashier_name ?? '',
      tr.customer_name ?? '', String(tr.net_amount), tr.payment_method,
    ])
    const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `sotuvlar_arxivi_${TODAY}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('arxiv.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('arxiv.subtitle')}</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
        {(['shifts', 'sales'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-4 py-2.5 text-[13.5px] font-medium border-b-2 -mb-px transition-colors',
              activeTab === tab
                ? 'border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100'
                : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300',
            )}
          >
            {tab === 'shifts' ? t('arxiv.tabs.shifts') : t('arxiv.tabs.sales')}
          </button>
        ))}
      </div>

      {activeTab === 'shifts' ? (
        <div className="space-y-4">
          {/* Filters */}
          <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 space-y-3 transition-colors duration-200">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-gray-400 dark:text-gray-500 mr-1 shrink-0">{t('arxiv.filters.period')}</span>
              {DATE_PRESETS.map(dp => (
                <button
                  key={dp.value}
                  onClick={() => { setShiftDatePreset(shiftDatePreset === dp.value ? null : dp.value); setShiftPage(1) }}
                  className={pillCls(shiftDatePreset === dp.value)}
                >
                  {t(dp.labelKey)}
                </button>
              ))}
              {shiftDatePreset === 'custom' && (
                <div className="flex flex-wrap items-center gap-2 ml-1">
                  <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('chiqim.from')}</span>
                  <input type="date" value={shiftCustomFrom} onChange={e => { setShiftCustomFrom(e.target.value); setShiftPage(1) }} className={dateInputCls} />
                  <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('chiqim.to')}</span>
                  <input type="date" value={shiftCustomTo} onChange={e => { setShiftCustomTo(e.target.value); setShiftPage(1) }} className={dateInputCls} />
                </div>
              )}
            </div>
            <div className="h-px bg-gray-100 dark:bg-gray-800" />
            <div className="flex flex-wrap items-center gap-2">
              <select value={shiftCashierFilter} onChange={e => { setShiftCashierFilter(e.target.value); setShiftPage(1) }} className={selectCls}>
                <option value="all">{t('arxiv.filters.allCashiers')}</option>
                {shiftCashierOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Table */}
          <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
            {loading ? (
              <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common.loading')}
              </div>
            ) : filteredShifts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                  <ArchiveIcon className="h-6 w-6 text-gray-300 dark:text-gray-600" />
                </div>
                <p className="text-sm text-gray-400 dark:text-gray-500">{t('arxiv.empty')}</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 dark:bg-gray-800/50">
                      <tr className="border-b border-gray-100 dark:border-gray-800">
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.shiftsTable.date')}</th>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.shiftsTable.cashier')}</th>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.shiftsTable.duration')}</th>
                        <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.shiftsTable.sales')}</th>
                        <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.shiftsTable.amount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedShifts.map((s, i) => (
                        <tr
                          key={s.id}
                          onClick={() => setSelectedShift(s)}
                          className={cn(
                            'border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer transition-colors',
                            i % 2 !== 0 && 'bg-gray-50/50 dark:bg-gray-800/30',
                          )}
                        >
                          <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDateTime(s.started_at)}</td>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{s.cashier_name}</td>
                          <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 tabular-nums">{formatDuration(s.started_at, s.ended_at)}</td>
                          <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400 tabular-nums">{s.total_sales}</td>
                          <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{formatPrice(s.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination currentPage={shiftPage} totalPages={shiftTotalPages} totalItems={filteredShifts.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setShiftPage} />
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Filters */}
          <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 space-y-3 transition-colors duration-200">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-gray-400 dark:text-gray-500 mr-1 shrink-0">{t('arxiv.filters.date')}</span>
              {DATE_PRESETS.map(dp => (
                <button
                  key={dp.value}
                  onClick={() => { setSaleDatePreset(saleDatePreset === dp.value ? null : dp.value); setSalePage(1) }}
                  className={pillCls(saleDatePreset === dp.value)}
                >
                  {t(dp.labelKey)}
                </button>
              ))}
              {saleDatePreset === 'custom' && (
                <div className="flex flex-wrap items-center gap-2 ml-1">
                  <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('chiqim.from')}</span>
                  <input type="date" value={saleCustomFrom} onChange={e => { setSaleCustomFrom(e.target.value); setSalePage(1) }} className={dateInputCls} />
                  <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('chiqim.to')}</span>
                  <input type="date" value={saleCustomTo} onChange={e => { setSaleCustomTo(e.target.value); setSalePage(1) }} className={dateInputCls} />
                </div>
              )}
            </div>
            <div className="h-px bg-gray-100 dark:bg-gray-800" />
            <div className="flex flex-wrap items-center gap-2">
              <select value={saleProductFilter} onChange={e => { setSaleProductFilter(e.target.value); setSalePage(1) }} className={selectCls}>
                <option value="all">{t('arxiv.filters.allProducts')}</option>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={saleCashierFilter} onChange={e => { setSaleCashierFilter(e.target.value); setSalePage(1) }} className={selectCls}>
                <option value="all">{t('arxiv.filters.allCashiers')}</option>
                {saleCashierOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={salePaymentFilter} onChange={e => { setSalePaymentFilter(e.target.value); setSalePage(1) }} className={selectCls}>
                <option value="all">{t('arxiv.filters.allPaymentTypes')}</option>
                {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder={t('header.searchPlaceholder')}
                  value={saleSearch}
                  onChange={e => { setSaleSearch(e.target.value); setSalePage(1) }}
                  className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-4 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
                />
              </div>
              <button
                onClick={exportCSV}
                className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                {t('arxiv.csv')}
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
            {loading ? (
              <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common.loading')}
              </div>
            ) : filteredSales.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                  <ArchiveIcon className="h-6 w-6 text-gray-300 dark:text-gray-600" />
                </div>
                <p className="text-sm text-gray-400 dark:text-gray-500">{t('arxiv.empty')}</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50 dark:bg-gray-800/50">
                      <tr className="border-b border-gray-100 dark:border-gray-800">
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.time')}</th>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.receipt')}</th>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.cashier')}</th>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.customer')}</th>
                        <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.amount')}</th>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.payment')}</th>
                        <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedSales.map((tr, i) => (
                        <tr
                          key={tr.id}
                          onClick={() => setSelectedTxn(tr)}
                          className={cn(
                            'border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer transition-colors',
                            i % 2 !== 0 && 'bg-gray-50/50 dark:bg-gray-800/30',
                          )}
                        >
                          <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDateTime(tr.created_at)}</td>
                          <td className="px-4 py-3 text-sm font-mono text-gray-700 dark:text-gray-300">{receiptNumber(tr.id)}</td>
                          <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">{tr.cashier_name ?? '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{tr.customer_name ?? '—'}</td>
                          <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{formatPrice(tr.net_amount)}</td>
                          <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{tr.payment_method}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <MiniBadge status={tr.status} />
                              {!isTxnReturnable(tr.id) && (
                                <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">
                                  {t('arxiv.legacyBadge')}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination currentPage={salePage} totalPages={saleTotalPages} totalItems={filteredSales.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setSalePage} />
              </>
            )}
          </div>
        </div>
      )}

      {/* Shift detail modal */}
      <Dialog open={!!selectedShift} onOpenChange={open => !open && setSelectedShift(null)}>
        <DialogContent className="sm:max-w-md">
          {selectedShift && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between gap-3">
                  <DialogTitle>{t('arxiv.shiftModal.title')}</DialogTitle>
                  <button
                    onClick={() => window.print()}
                    className="print:hidden flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    {t('pos.shift.print')}
                  </button>
                </div>
              </DialogHeader>
              <div className="mt-2 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.cashier')}</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{selectedShift.cashier_name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.date')}</span>
                  <span className="text-gray-900 dark:text-gray-100">{formatDateTime(selectedShift.started_at)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.duration')}</span>
                  <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatDuration(selectedShift.started_at, selectedShift.ended_at)}</span>
                </div>

                <div className="h-px bg-gray-100 dark:bg-gray-800 my-1" />

                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.totalSales')}</span>
                  <span className="text-gray-900 dark:text-gray-100 tabular-nums">{selectedShift.total_sales}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{t('pos.shift.totalAmount')}</span>
                  <span className="font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(selectedShift.total_amount)}</span>
                </div>

                <div className="h-px bg-gray-100 dark:bg-gray-800 my-1" />

                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Naqd</span>
                  <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(selectedShift.cash_amount)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Karta</span>
                  <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(selectedShift.card_amount)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Click</span>
                  <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(selectedShift.click_amount)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Payme</span>
                  <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(selectedShift.payme_amount)}</span>
                </div>

                <div className="h-px bg-gray-100 dark:bg-gray-800 my-1" />

                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{t('pos.shift.cashInRegister')}</span>
                  <span className="font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(Number(selectedShift.initial_cash) + Number(selectedShift.cash_amount))}</span>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Receipt modal */}
      <Dialog open={!!selectedTxn} onOpenChange={open => !open && setSelectedTxn(null)}>
        <DialogContent className="sm:max-w-md">
          {selectedTxn && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <DialogTitle className="font-mono">{t('arxiv.receiptModal.title')} {receiptNumber(selectedTxn.id)}</DialogTitle>
                    {!isTxnReturnable(selectedTxn.id) && (
                      <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400 shrink-0">
                        {t('arxiv.legacyBadge')}
                      </span>
                    )}
                  </div>
                  <div className="print:hidden flex items-center gap-2">
                    {selectedTxn.status !== 'cancelled' && isTxnReturnable(selectedTxn.id) && (
                      <button
                        onClick={() => setReturnTxnId(selectedTxn.id)}
                        className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t('arxiv.returnButton')}
                      </button>
                    )}
                    <button
                      onClick={() => window.print()}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      {t('arxiv.receiptModal.print')}
                    </button>
                  </div>
                </div>
                {selectedTxn.status === 'cancelled' && (
                  <p className="text-xs text-red-500 dark:text-red-400 mt-1">{t('arxiv.returnModal.fullyReturned')}</p>
                )}
              </DialogHeader>
              <div className="mt-2 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.time')}</span>
                  <span className="text-gray-900 dark:text-gray-100">{formatDateTime(selectedTxn.created_at)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.cashier')}</span>
                  <span className="text-gray-900 dark:text-gray-100">{selectedTxn.cashier_name ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.customer')}</span>
                  <span className="text-gray-900 dark:text-gray-100">{selectedTxn.customer_name ?? '—'}</span>
                </div>

                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-800/50">
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="pb-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.receiptModal.product')}</th>
                      <th className="pb-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.receiptModal.quantity')}</th>
                      <th className="pb-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.receiptModal.price')}</th>
                      <th className="pb-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('arxiv.receiptModal.total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(itemsByTxn.get(selectedTxn.id) ?? []).map((item, i) => (
                      <tr key={i} className="border-b border-gray-100 dark:border-gray-800">
                        <td className="py-2.5 text-gray-900 dark:text-gray-100">{item.product_name}</td>
                        <td className="py-2.5 text-right text-gray-500 dark:text-gray-400 tabular-nums">{item.quantity}</td>
                        <td className="py-2.5 text-right text-gray-500 dark:text-gray-400 tabular-nums">{formatPrice(item.price)}</td>
                        <td className="py-2.5 text-right font-medium text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(item.price * item.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {selectedTxn.returned_amount > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 dark:text-gray-400">{t('arxiv.receiptModal.returned')}</span>
                    <span className="text-red-500 dark:text-red-400 tabular-nums">-{formatPrice(selectedTxn.returned_amount)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-gray-100 dark:border-gray-800 pt-2">
                  <span className="font-bold text-gray-900 dark:text-gray-100">{t('arxiv.receiptModal.total')}</span>
                  <span className="font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(selectedTxn.net_amount)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{t('arxiv.salesTable.payment')}</span>
                  <span className="text-gray-900 dark:text-gray-100">{selectedTxn.payment_method}</span>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ReturnModal
        transactionId={returnTxnId}
        items={(itemsByTxn.get(returnTxnId ?? '') ?? []).map((item): ReturnableItem => ({
          id: item.id,
          productName: item.product_name,
          quantity: item.quantity,
          returnedQuantity: item.returned_quantity,
          returnable: item.product_size_id !== null,
        }))}
        onOpenChange={open => { if (!open) setReturnTxnId(null) }}
        onReturned={() => { setReturnTxnId(null); setSelectedTxn(null); fetchAll() }}
      />
    </div>
  )
}
