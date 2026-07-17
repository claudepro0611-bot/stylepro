'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTheme } from 'next-themes'
import {
  LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import {
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { StatsPanel } from '@/components/ui/StatsPanel'
import type { TranslationKey } from '@/lib/i18n/translations'

type Period = 'week' | 'month' | 'year' | 'custom'

const TODAY = new Date().toISOString().slice(0, 10)

const DATE_PERIODS: { value: Period; labelKey: TranslationKey }[] = [
  { value: 'week', labelKey: 'reports.periods.week' },
  { value: 'month', labelKey: 'reports.periods.month' },
  { value: 'year', labelKey: 'reports.periods.year' },
  { value: 'custom', labelKey: 'reports.periods.custom' },
]

const PIE_COLORS = ['#10B981', '#6366F1', '#F97316', '#3B82F6', '#EC4899', '#F59E0B', '#8B5CF6', '#14B8A6']

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function periodRange(period: Period, customFrom: string, customTo: string): [string, string] {
  const [ty, tm, td] = TODAY.split('-').map(Number)
  switch (period) {
    case 'week': {
      const d = new Date(Date.UTC(ty, tm - 1, td))
      d.setUTCDate(d.getUTCDate() - 6)
      return [ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), TODAY]
    }
    case 'month': {
      const d = new Date(Date.UTC(ty, tm - 1, td))
      d.setUTCDate(d.getUTCDate() - 29)
      return [ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), TODAY]
    }
    case 'year':
      return [`${ty}-01-01`, TODAY]
    case 'custom':
      if (customFrom && customTo) return customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom]
      return [`${ty}-01-01`, TODAY]
  }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000)
}

function shortLabel(dateStr: string, useMonth: boolean): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  if (useMonth) {
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
  }
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`
}

interface StockInRow {
  product_id: string
  product_name: string
  category: string | null
  quantity: number
  purchase_price: number
  selling_price: number
  date: string
}

interface TxnItemRow {
  transaction_id: string
  product_id: string | null
  product_name: string | null
  quantity: number
  price: number
  purchase_price: number
}

interface TxnRow {
  id: string
  net_amount: number
  date: string
  status: string
}

interface BrakOutRow {
  quantity: number
  sell_price: number
  total_amount: number
  date: string
}

export default function ReportsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [period, setPeriod] = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(true)

  const [transactions, setTransactions] = useState<TxnRow[]>([])
  const [txnItems, setTxnItems] = useState<TxnItemRow[]>([])
  const [stockInEntries, setStockInEntries] = useState<StockInRow[]>([])
  const [brakEntries, setBrakEntries] = useState<BrakOutRow[]>([])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [txnRes, itemRes, stockRes, brakRes] = await Promise.all([
      supabase.from('transactions_net').select('id, net_amount, date, status').eq('status', 'completed'),
      supabase.from('transaction_items').select('transaction_id, product_id, product_name, quantity, price, purchase_price'),
      supabase.from('stock_in_entries').select('product_id, product_name, category, quantity, purchase_price, selling_price, date'),
      supabase.from('stock_out_entries').select('quantity, sell_price, total_amount, date').eq('entry_type', 'brak'),
    ])
    if (txnRes.error || itemRes.error || stockRes.error) {
      toast.error(t('common.error'))
    } else {
      setTransactions((txnRes.data ?? []) as TxnRow[])
      setTxnItems((itemRes.data ?? []) as TxnItemRow[])
      setStockInEntries((stockRes.data ?? []) as StockInRow[])
      setBrakEntries((brakRes.data ?? []) as BrakOutRow[])
    }
    setLoading(false)
  }, [t])

  useEffect(() => { fetchAll() }, [fetchAll])

  const [from, to] = useMemo(() => periodRange(period, customFrom, customTo), [period, customFrom, customTo])

  const filteredTxns = useMemo(() =>
    transactions.filter(tx => { const d = tx.date.slice(0, 10); return d >= from && d <= to }),
    [transactions, from, to],
  )

  const filteredBrak = useMemo(() =>
    brakEntries.filter(e => { const d = e.date.slice(0, 10); return d >= from && d <= to }),
    [brakEntries, from, to],
  )

  const txnIdSet = useMemo(() => new Set(filteredTxns.map(t => t.id)), [filteredTxns])
  const filteredItems = useMemo(() =>
    txnItems.filter(i => txnIdSet.has(i.transaction_id)),
    [txnItems, txnIdSet],
  )

  const totalRevenue = useMemo(() => filteredTxns.reduce((s, t) => s + Number(t.net_amount), 0), [filteredTxns])
  const totalCost = useMemo(() => filteredItems.reduce((s, i) => s + Number(i.purchase_price) * Number(i.quantity), 0), [filteredItems])
  const brakLoss = useMemo(() => filteredBrak.reduce((s, e) => s + Number(e.total_amount), 0), [filteredBrak])
  const netProfit = useMemo(() => totalRevenue - totalCost - brakLoss, [totalRevenue, totalCost, brakLoss])

  const useMonthBuckets = useMemo(() => period === 'year' || daysBetween(from, to) > 90, [period, from, to])

  const txnDateMap = useMemo(() => {
    const m = new Map<string, string>()
    transactions.forEach(t => m.set(t.id, t.date.slice(0, 10)))
    return m
  }, [transactions])

  const chartData = useMemo(() => {
    if (useMonthBuckets) {
      const months: { key: string; label: string; revenue: number; cost: number; profit: number }[] = []
      const fromYear = parseInt(from.slice(0, 4))
      const fromMonth = parseInt(from.slice(5, 7))
      const toYear = parseInt(to.slice(0, 4))
      const toMonth = parseInt(to.slice(5, 7))
      let y = fromYear, m = fromMonth
      while (y < toYear || (y === toYear && m <= toMonth)) {
        const key = `${y}-${String(m).padStart(2, '0')}`
        const rev = transactions.filter(t => t.status === 'completed' && t.date.startsWith(key)).reduce((s, t) => s + Number(t.net_amount), 0)
        const cost = txnItems.filter(i => txnDateMap.get(i.transaction_id)?.startsWith(key)).reduce((s, i) => s + Number(i.purchase_price) * Number(i.quantity), 0)
        const brak = brakEntries.filter(e => e.date.startsWith(key)).reduce((s, e) => s + Number(e.total_amount), 0)
        months.push({ key, label: shortLabel(key + '-01', true), revenue: rev, cost, profit: rev - cost - brak })
        m++
        if (m > 12) { m = 1; y++ }
      }
      return months
    } else {
      const days: { key: string; label: string; revenue: number; cost: number; profit: number }[] = []
      const nDays = daysBetween(from, to) + 1
      for (let i = 0; i < nDays; i++) {
        const day = addDays(from, i)
        const rev = transactions.filter(t => t.status === 'completed' && t.date.slice(0, 10) === day).reduce((s, t) => s + Number(t.net_amount), 0)
        const cost = txnItems.filter(i => txnDateMap.get(i.transaction_id) === day).reduce((s, i) => s + Number(i.purchase_price) * Number(i.quantity), 0)
        const brak = brakEntries.filter(e => e.date.slice(0, 10) === day).reduce((s, e) => s + Number(e.total_amount), 0)
        days.push({ key: day, label: shortLabel(day, false), revenue: rev, cost, profit: rev - cost - brak })
      }
      return days
    }
  }, [useMonthBuckets, from, to, transactions, txnItems, txnDateMap, brakEntries])

  const catMap = useMemo(() => {
    const m = new Map<string, string>()
    stockInEntries.forEach(e => { if (e.product_id && e.category) m.set(e.product_id, e.category) })
    return m
  }, [stockInEntries])

  const donutData = useMemo(() => {
    const catRevenue = new Map<string, number>()
    filteredItems.forEach(item => {
      const cat = (item.product_id ? catMap.get(item.product_id) : null) ?? 'Boshqalar'
      catRevenue.set(cat, (catRevenue.get(cat) ?? 0) + Number(item.quantity) * Number(item.price))
    })
    return Array.from(catRevenue.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [filteredItems, catMap])

  const productProfitTable = useMemo(() => {
    const prodMap = new Map<string, { name: string; sold: number; revenue: number; totalCost: number; category: string }>()
    filteredItems.forEach(item => {
      const key = item.product_id ?? item.product_name ?? ''
      const name = item.product_name ?? ''
      const cat = (item.product_id ? catMap.get(item.product_id) : null) ?? ''
      const qty = Number(item.quantity)
      const prev = prodMap.get(key) ?? { name, sold: 0, revenue: 0, totalCost: 0, category: cat }
      prodMap.set(key, {
        ...prev,
        sold: prev.sold + qty,
        revenue: prev.revenue + qty * Number(item.price),
        totalCost: prev.totalCost + qty * Number(item.purchase_price),
      })
    })

    const rows = Array.from(prodMap.entries()).map(([id, data]) => {
      const avgSellingPrice = data.sold > 0 ? data.revenue / data.sold : 0
      const avgPurchasePrice = data.sold > 0 ? data.totalCost / data.sold : 0
      const profit = data.revenue - data.totalCost
      return { id, ...data, avgSellingPrice, avgPurchasePrice, profit }
    }).sort((a, b) => b.profit - a.profit)

    return rows
  }, [filteredItems, catMap])

  const tableTotals = useMemo(() => ({
    sold: productProfitTable.reduce((s, r) => s + r.sold, 0),
    revenue: productProfitTable.reduce((s, r) => s + r.revenue, 0),
    profit: productProfitTable.reduce((s, r) => s + r.profit, 0),
  }), [productProfitTable])

  const pillCls = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
      active ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
    }`

  const dateInputCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  const axisColor = isDark ? '#6B7280' : '#9CA3AF'
  const gridColor = isDark ? '#374151' : '#F3F4F6'

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('reports.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('reports.subtitle')}</p>
      </div>

      {/* Period filter */}
      <div className="flex flex-wrap items-center gap-2">
        {DATE_PERIODS.map(dp => (
          <button key={dp.value} onClick={() => setPeriod(dp.value)} className={pillCls(period === dp.value)}>
            {t(dp.labelKey)}
          </button>
        ))}
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 ml-1">
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className={dateInputCls} />
            <span className="text-[12px] text-gray-400">—</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className={dateInputCls} />
          </div>
        )}
      </div>

      {/* KPI cards */}
      <StatsPanel storageKey="reports-stats-open" title={t('reports.kpi.statsTitle')}>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-4">
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('reports.kpi.totalRevenue')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(totalRevenue)}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('reports.kpi.totalCost')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(totalCost)}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('reports.kpi.netProfit')}</p>
            <p className={`text-[22px] font-medium tabular-nums mt-1 ${netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{formatPrice(netProfit)}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('reports.kpi.brakLoss')}</p>
            <p className="text-[22px] font-medium text-red-600 dark:text-red-400 tabular-nums mt-1">{formatPrice(brakLoss)}</p>
          </div>
        </div>
      </StatsPanel>

      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        {/* Line chart — 3 lines */}
        <div className="xl:col-span-3 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-4">{t('reports.chart.revenueDynamics')}</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="label" tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} width={55} />
                <Tooltip
                  contentStyle={{ background: isDark ? '#111827' : '#fff', border: '1px solid ' + (isDark ? '#374151' : '#E5E7EB'), borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: isDark ? '#D1D5DB' : '#374151' }}
                  formatter={(value) => formatPrice(Number(value ?? 0))}
                />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Line type="monotone" dataKey="revenue" name={t('reports.chart.revenue')} stroke="#10B981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="cost" name={t('reports.chart.cost')} stroke="#EF4444" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="profit" name={t('reports.chart.profit')} stroke="#3B82F6" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Donut chart — category profit */}
        <div className="xl:col-span-2 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-4">{t('reports.chart.salesByCategory')}</p>
          {donutData.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-gray-400">{t('reports.notFound')}</div>
          ) : (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donutData} cx="50%" cy="50%" innerRadius="55%" outerRadius="85%" paddingAngle={2} dataKey="value">
                    {donutData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: isDark ? '#111827' : '#fff', border: '1px solid ' + (isDark ? '#374151' : '#E5E7EB'), borderRadius: 8, fontSize: 12 }}
                    formatter={(value) => formatPrice(Number(value ?? 0))}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-2 space-y-1.5">
            {donutData.slice(0, 5).map((d, i) => (
              <div key={d.name} className="flex items-center justify-between text-[12px]">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="text-gray-600 dark:text-gray-400 truncate max-w-[100px]">{d.name}</span>
                </div>
                <span className="text-gray-900 dark:text-gray-100 font-medium tabular-nums">{formatPrice(d.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Product profit table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.table.title')}</p>
        </div>
        {productProfitTable.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-gray-400">{t('reports.notFound')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide">№</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.table.product')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.table.sold')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.table.purchasePrice')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.table.sellingPrice')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.table.profit')}</th>
                </tr>
              </thead>
              <tbody>
                {productProfitTable.map((row, i) => (
                  <tr key={row.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}>
                    <td className="px-4 py-3 text-[12px] text-gray-400">{i + 1}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{row.name}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400 tabular-nums">{row.sold} {t('reports.unitsSuffix')}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400 tabular-nums">{formatPrice(row.avgPurchasePrice)}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400 tabular-nums">{formatPrice(row.avgSellingPrice)}</td>
                    <td className={`px-4 py-3 text-sm text-right font-semibold tabular-nums ${row.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{formatPrice(row.profit)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('reports.table.total')}</td>
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{tableTotals.sold} {t('reports.unitsSuffix')}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(tableTotals.revenue)}</td>
                  <td className={`px-4 py-3 text-sm text-right font-bold tabular-nums ${tableTotals.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{formatPrice(tableTotals.profit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
