'use client'

import { useMemo, useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useTheme } from 'next-themes'
import {
  Trophy, BarChart3,
  MoreHorizontal, Search, Check,
  Wallet, ShoppingBag, PackageSearch, Target, CalendarCheck,
  SlidersHorizontal, Download,
  type LucideIcon,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useDashboardFilter, buildChartBuckets } from '@/hooks/useDashboardFilter'
import { useDashboardConfig } from '@/hooks/useDashboardConfig'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { usePaymentStatus } from '@/lib/usePaymentStatus'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { DashboardFilterBar } from '@/components/dashboard/DashboardFilterBar'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { Product, Transaction } from '@/lib/types'

// ─── constants ────────────────────────────────────────────────────────────────

const SLICE_COLORS = ['#6366F1', '#F97316', '#10B981', '#3B82F6', '#F59E0B', '#EC4899']

function KpiIconBox({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
      <Icon className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
    </div>
  )
}

function TrendBadge({ value }: { value: number }) {
  const up = value >= 0
  return (
    <span className={cn(
      'text-xs font-medium rounded-md px-1.5 py-0.5 shrink-0',
      up
        ? 'text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-500/10'
        : 'text-red-500 bg-red-50 dark:text-red-400 dark:bg-red-500/10',
    )}>
      {up ? '↑' : '↓'} {Math.abs(value).toFixed(1)}%
    </span>
  )
}

const CARD_CLS = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm hover:shadow-md transition-all duration-200'

const KPI_CARD_CLS = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm hover:shadow-md transition-all duration-200 p-4'

const WIDGET_OPTION_KEYS: TranslationKey[] = [
  'dashboard.widgets.revenue', 'dashboard.widgets.avgCheck', 'dashboard.widgets.newOrders',
  'dashboard.widgets.activeCustomers', 'dashboard.widgets.stockStatus', 'dashboard.widgets.campaigns',
  'dashboard.widgets.requests', 'dashboard.widgets.conversion',
]

const WEEKDAY_KEYS: TranslationKey[] = [
  'dashboard.weekdaysShort.mon', 'dashboard.weekdaysShort.tue', 'dashboard.weekdaysShort.wed',
  'dashboard.weekdaysShort.thu', 'dashboard.weekdaysShort.fri', 'dashboard.weekdaysShort.sat', 'dashboard.weekdaysShort.sun',
]
const MONTH_KEYS: TranslationKey[] = [
  'dashboard.monthsShort.jan', 'dashboard.monthsShort.feb', 'dashboard.monthsShort.mar', 'dashboard.monthsShort.apr',
  'dashboard.monthsShort.may', 'dashboard.monthsShort.jun', 'dashboard.monthsShort.jul', 'dashboard.monthsShort.aug',
  'dashboard.monthsShort.sep', 'dashboard.monthsShort.oct', 'dashboard.monthsShort.nov', 'dashboard.monthsShort.dec',
]

function pct(curr: number, prev: number) {
  if (prev === 0) return 0
  return ((curr - prev) / prev) * 100
}

// ─── WidgetMenu ───────────────────────────────────────────────────────────────

function WidgetMenu() {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<TranslationKey>(WIDGET_OPTION_KEYS[0])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = WIDGET_OPTION_KEYS.filter(key =>
    t(key).toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <MoreHorizontal className="h-4 w-4 text-gray-400" />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-52 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl overflow-hidden">
          <div className="px-3 pt-3 pb-2 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[12px] font-semibold text-gray-800 dark:text-gray-200 mb-2">{t('dashboard.changeWidget')}</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400 pointer-events-none" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('header.searchPlaceholder')}
                className="w-full h-7 rounded-md bg-gray-100 dark:bg-gray-800 pl-7 pr-3 text-[12px] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none"
              />
            </div>
          </div>
          <div className="max-h-44 overflow-y-auto py-1">
            {filtered.map(key => (
              <button
                key={key}
                onClick={() => { setSelected(key); setOpen(false); setQuery('') }}
                className="flex w-full items-center justify-between px-3 py-2 text-[13px] hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <span className={selected === key ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}>
                  {t(key)}
                </span>
                {selected === key && <Check className="h-3.5 w-3.5 text-orange-500 shrink-0" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-[12px] text-gray-400">{t('dashboard.notFound')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Daily sales custom tooltip ──────────────────────────────────────────────

function DailySalesTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ name: string; value: number }>
  label?: string
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  if (!active || !payload?.length) return null
  const curVal  = payload.find(p => p.name === 'current')?.value ?? 0
  const prevVal = payload.find(p => p.name === 'previous')?.value ?? 0
  const diff = curVal - prevVal
  const up = diff >= 0
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl p-3 min-w-[196px] space-y-1.5">
      <p className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
        {t('dashboard.dailySales.tooltipTime')}: {label}
      </p>
      <div className="space-y-1">
        <p className="text-[12px] text-gray-900 dark:text-gray-100 font-medium flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm bg-gray-900 dark:bg-gray-100 shrink-0" />
          {t('dashboard.current')}: {formatPrice(curVal)}
        </p>
        <p className="text-[12px] text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-gray-300 dark:bg-gray-600 shrink-0" style={{ borderTop: '2px dashed currentColor', background: 'none' }} />
          {t('dashboard.previous')}: {formatPrice(prevVal)}
        </p>
      </div>
      {(curVal > 0 || prevVal > 0) && (
        <p className={`text-[12px] font-semibold border-t border-gray-100 dark:border-gray-800 pt-1.5 ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
          {t('dashboard.dailySales.tooltipDiff')}: {up ? '↑' : '↓'} {formatPrice(Math.abs(diff))}
        </p>
      )}
    </div>
  )
}

// ─── Top products donut tooltip ──────────────────────────────────────────────

interface TopProductSlice {
  name: string
  qty: number
  revenue: number
  pct: number
  color: string
}

function TopProductsTooltip({ active, payload }: {
  active?: boolean
  payload?: Array<{ payload: TopProductSlice }>
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="rounded-xl bg-white border border-gray-200 shadow-xl p-3 min-w-[170px] space-y-1">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-900">
        <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
        {d.name}
      </p>
      <p className="text-[12px] text-gray-500">
        {t('dashboard.topProducts.tooltipRevenue')}: <span className="font-medium text-gray-700">{formatPrice(d.revenue)}</span>
      </p>
      <p className="text-[12px] text-gray-500">
        {t('dashboard.topProducts.tooltipSales')}: <span className="font-medium text-gray-700">{d.qty} {t('dashboard.unitsSuffix')}</span>
      </p>
      <p className="text-[12px] text-gray-500">
        {t('dashboard.topProducts.tooltipShare')}: <span className="font-medium text-gray-700">{d.pct}%</span>
      </p>
    </div>
  )
}

// ─── KPI card (cards 1 & 2) ───────────────────────────────────────────────────

interface KpiCardProps {
  title: string
  value: string
  change: number
  changeLabel: string
  icon: LucideIcon
  isPending?: boolean
}

function KpiCard({ title, value, change, changeLabel, icon, isPending }: KpiCardProps) {
  return (
    <div className={KPI_CARD_CLS}>
      <div className="flex items-start justify-between mb-3">
        <KpiIconBox icon={icon} />
        {!isPending && <TrendBadge value={change} />}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{title}</p>
      {isPending ? (
        <Skeleton className="h-[22px] w-24" />
      ) : (
        <>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{value}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{changeLabel}</p>
        </>
      )}
    </div>
  )
}

// ─── Card 3: Low stock ────────────────────────────────────────────────────────

function LowStockCard({ count, isPending }: { count: number; isPending?: boolean }) {
  const { t } = useLanguage()
  const hasLow = count > 0
  return (
    <Link href="/inventory" className="block h-full">
      <div className={cn(KPI_CARD_CLS, 'h-full hover:border-gray-200 dark:hover:border-gray-700')}>
        <div className="flex items-start justify-between mb-3">
          <KpiIconBox icon={PackageSearch} />
          {!isPending && hasLow && (
            <span className="inline-flex items-center rounded-md bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400 shrink-0">
              {t('dashboard.kpiLowStockSub')}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t('dashboard.kpi.lowStock')}</p>
        {isPending ? (
          <Skeleton className="h-[22px] w-12" />
        ) : (
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{count}</p>
        )}
      </div>
    </Link>
  )
}

// ─── Card 4: Monthly goal ─────────────────────────────────────────────────────

function MonthlyGoalCard({ current, goal, isPending }: { current: number; goal: number; isPending?: boolean }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const pctVal = Math.min(100, goal > 0 ? Math.round((current / goal) * 100) : 0)
  return (
    <div className={KPI_CARD_CLS}>
      <div className="flex items-start justify-between mb-3">
        <KpiIconBox icon={Target} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t('dashboard.kpi.monthlyGoal')}</p>
      {isPending ? (
        <>
          <Skeleton className="h-[22px] w-14" />
          <Skeleton className="h-1 w-full mt-3 rounded-full" />
          <Skeleton className="h-[12px] w-28 mt-2" />
        </>
      ) : (
        <>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{pctVal}%</p>
          <div className="mt-2 h-1 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-gray-900 dark:bg-gray-100 transition-all duration-500"
              style={{ width: `${pctVal}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 tabular-nums truncate">
            {formatPrice(current)} / {formatPrice(goal)}
          </p>
        </>
      )}
    </div>
  )
}

// ─── Card 5: Today's sales ────────────────────────────────────────────────────

function TodaySalesCard({ title, count, revenue, prevCount, changeLabel, isPending }: {
  title: string; count: number; revenue: number; prevCount: number; changeLabel: string; isPending?: boolean
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const changeVal = prevCount > 0 ? ((count - prevCount) / prevCount) * 100 : 0
  return (
    <div className={KPI_CARD_CLS}>
      <div className="flex items-start justify-between mb-3">
        <KpiIconBox icon={CalendarCheck} />
        {!isPending && prevCount > 0 && <TrendBadge value={changeVal} />}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{title}</p>
      {isPending ? (
        <>
          <Skeleton className="h-[22px] w-16" />
          <Skeleton className="h-[14px] w-20 mt-1" />
        </>
      ) : (
        <>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{count} {t('dashboard.unitsSuffix')}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{changeLabel}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 tabular-nums">{formatPrice(revenue)}</p>
        </>
      )}
    </div>
  )
}

// ─── Card 6: Net profit (revenue - expenses for the selected period) ─────────

function NetProfitCard({ amount, isPending }: { amount: number; isPending?: boolean }) {
  const { formatPrice } = useCurrency()
  const positive = amount >= 0
  return (
    <div className={KPI_CARD_CLS}>
      <div className="flex items-start justify-between mb-3">
        <KpiIconBox icon={Wallet} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">Sof foyda</p>
      {isPending ? (
        <Skeleton className="h-[22px] w-24" />
      ) : (
        <p className={cn('text-lg font-semibold tabular-nums whitespace-nowrap', positive ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400')}>
          {formatPrice(amount)}
        </p>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const paymentStatus = usePaymentStatus()
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = mounted && resolvedTheme === 'dark'

  const [config, setConfig] = useDashboardConfig()
  const [monthlyGoal] = useLocalStorage<number>('stylepro-monthly-goal', 10000000)
  const [products, setProducts] = useState<Product[]>([])
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([])
  const [allExpenses, setAllExpenses] = useState<{ amount: number; date: string }[]>([])
  const [lowStockCount2, setLowStockCount2] = useState(0)
  const [dataLoading, setDataLoading] = useState(true)
  const [companyBalance, setCompanyBalance] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    const supabase = createClient()

    async function load() {
      const [{ data: productRows }, { data: transactionRows }, { data: productSizeRows }, { data: companyRow }, { data: expenseRows }] = await Promise.all([
        supabase.from('products').select('*'),
        supabase
          .from('transactions_net')
          .select('*, transaction_items(product_id, product_name, quantity, price)')
          .order('created_at', { ascending: false }),
        supabase.from('product_sizes').select('product_id, stock'),
        supabase.from('companies').select('balance').maybeSingle(),
        supabase.from('expenses').select('amount, date'),
      ])

      if (!active) return
      setCompanyBalance(companyRow ? Number(companyRow.balance ?? 0) : null)

      const mapped = (productRows ?? []).map(p => ({
        id: p.id,
        name: p.name,
        sku: p.sku ?? '',
        category: p.category ?? '',
        price: Number(p.price),
        description: p.description ?? '',
        colors: p.colors ?? [],
        minStock: p.min_stock,
        imageUrl: p.image_url ?? '',
        status: p.status as Product['status'],
        warehouseId: p.warehouse_id ?? '',
      }))
      setProducts(mapped)
      const minStockMap = new Map(mapped.map(p => [p.id, p.minStock]))
      const lowCount = (productSizeRows ?? []).filter((sz: { product_id: string; stock: number }) =>
        sz.stock > 0 && sz.stock <= (minStockMap.get(sz.product_id) ?? 5)
      ).length
      setLowStockCount2(lowCount)

      setAllTransactions((transactionRows ?? []).map(tx => ({
        id: tx.id ?? '',
        customerId: tx.customer_id ?? '',
        customerName: tx.customer_name ?? '',
        products: (tx.transaction_items ?? []).map((i: { product_id: string | null; product_name: string | null; quantity: number; price: number }) => ({
          productId: i.product_id ?? '',
          productName: i.product_name ?? '',
          quantity: i.quantity,
          price: Number(i.price),
        })),
        // Net of returns (transactions_net.net_amount = total_amount - returned_amount),
        // not the gross sale total — see supabase/migrations/20260717000001_returns_flow.sql.
        totalAmount: Number(tx.net_amount),
        date: tx.date ?? '',
        createdAt: tx.created_at ?? '',
        paymentMethod: tx.payment_method ?? '',
        invoiceId: tx.invoice_id ?? '',
        status: tx.status as Transaction['status'],
      })))

      setAllExpenses((expenseRows ?? []).map(e => ({ amount: Number(e.amount), date: e.date })))

      setDataLoading(false)
    }

    load()
    return () => { active = false }
  }, [])

  const categoryById = useMemo(() => {
    const map = new Map<string, string>()
    products.forEach(p => map.set(p.id, p.category))
    return map
  }, [products])

  const {
    period, setPeriod,
    customStart, setCustomStart,
    customEnd, setCustomEnd,
    category, setCategory,
    paymentMethod, setPaymentMethod,
    range, prevRange,
    filteredTransactions, prevFilteredTransactions,
    hasActiveFilters, isPending: filterPending, reset,
  } = useDashboardFilter(allTransactions, categoryById)

  const isPending = dataLoading || filterPending

  const axisTick = { fill: isDark ? '#6B7280' : '#9CA3AF', fontSize: 11 }
  const gridProps = { strokeDasharray: '3 3', stroke: isDark ? '#374151' : '#F3F4F6', vertical: false } as const
  const monoStrong = isDark ? '#F3F4F6' : '#111827'
  const monoSoft   = isDark ? '#4B5563' : '#D1D5DB'
  const cursorArea = isDark ? '#374151' : '#F3F4F6'

  const curRevenue = useMemo(() => filteredTransactions.reduce((s, tx) => s + tx.totalAmount, 0), [filteredTransactions])
  const prvRevenue = useMemo(() => prevFilteredTransactions.reduce((s, tx) => s + tx.totalAmount, 0), [prevFilteredTransactions])

  // Same date range as the revenue KPI cards, so "Sof foyda" reflects the
  // currently selected period rather than all-time expenses.
  const curExpenses = useMemo(
    () => allExpenses
      .filter(e => e.date >= range.start && e.date <= range.end)
      .reduce((s, e) => s + e.amount, 0),
    [allExpenses, range],
  )
  const netProfit = curRevenue - curExpenses


  // Recent sales — most recent completed transactions
  const recentSales = useMemo(
    () => [...allTransactions]
      .filter(tx => tx.status === 'completed')
      .sort((a, b) => (b.createdAt ?? b.date).localeCompare(a.createdAt ?? a.date))
      .slice(0, 10),
    [allTransactions],
  )

  // Top products by category — donut chart, reacts to the active filters
  const topProductsChart = useMemo<TopProductSlice[]>(() => {
    const map: Record<string, { qty: number; revenue: number }> = {}
    filteredTransactions.forEach(tx =>
      tx.products.forEach(item => {
        const cat = categoryById.get(item.productId) ?? t('dashboard.topProducts.others')
        if (!map[cat]) map[cat] = { qty: 0, revenue: 0 }
        map[cat].qty += item.quantity
        map[cat].revenue += item.price * item.quantity
      }),
    )
    const sorted = Object.entries(map)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.qty - a.qty)

    const top = sorted.slice(0, 4)
    const rest = sorted.slice(4)
    const restTotal = rest.reduce(
      (acc, r) => ({ qty: acc.qty + r.qty, revenue: acc.revenue + r.revenue }),
      { qty: 0, revenue: 0 },
    )

    const slices = [...top]
    if (restTotal.qty > 0) slices.push({ name: t('dashboard.topProducts.others'), ...restTotal })

    const total = slices.reduce((s, x) => s + x.qty, 0)
    return slices.map((s, i) => ({
      ...s,
      pct: total > 0 ? Math.round((s.qty / total) * 100) : 0,
      color: SLICE_COLORS[i % SLICE_COLORS.length],
    }))
  }, [t, categoryById, filteredTransactions])

  const topProductsTotal = topProductsChart.reduce((s, p) => s + p.qty, 0)

  // Comparison chart — granularity adapts to the selected period
  const weekdayLabels = WEEKDAY_KEYS.map(t)
  const monthLabels = MONTH_KEYS.map(t)
  const chartBuckets = useMemo(
    () => buildChartBuckets(range, prevRange, filteredTransactions, prevFilteredTransactions, weekdayLabels, monthLabels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, prevRange, filteredTransactions, prevFilteredTransactions, t],
  )

  return (
    <div className="space-y-5">
      {paymentStatus.daysLeft !== null && paymentStatus.daysLeft >= 0 && paymentStatus.daysLeft <= 3 && (
        <div className="mb-4 text-sm text-red-600 dark:text-red-400">
          To&apos;lovga {paymentStatus.daysLeft} kun qoldi — {paymentStatus.monthlyFee.toLocaleString()} UZS
        </div>
      )}

      {companyBalance !== null && companyBalance < 0 && (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-900 rounded-lg px-4 py-3">
          <span className="text-sm text-red-700 dark:text-red-300">
            ⚠️ Balans manfiy ({companyBalance.toLocaleString()} UZS). Iltimos to&apos;lov qiling.
          </span>
        </div>
      )}

      {/* Header + toolbar row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('dashboard.title')}</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
            Filtr
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 text-sm font-medium transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Eksport
          </button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <DashboardFilterBar
        config={config} onCustomizeSave={setConfig}
        period={period} setPeriod={setPeriod}
        customStart={customStart} setCustomStart={setCustomStart}
        customEnd={customEnd} setCustomEnd={setCustomEnd}
        category={category} setCategory={setCategory}
        paymentMethod={paymentMethod} setPaymentMethod={setPaymentMethod}
        hasActiveFilters={hasActiveFilters}
        reset={reset}
      />

      {/* KPI cards */}
      {(config.showMonthlyRevenue || config.showTotalSales || config.showLowStock || config.showMonthlyGoal || config.showTodaySales) && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 items-stretch">
          {config.showMonthlyRevenue && (
            <KpiCard
              title={t(`dashboard.periodLabels.revenue.${period}`)}
              value={formatPrice(curRevenue)}
              change={pct(curRevenue, prvRevenue)}
              changeLabel={t('dashboard.vsPrevPeriod')}
              icon={Wallet}
              isPending={isPending}
            />
          )}
          <NetProfitCard amount={netProfit} isPending={isPending} />
          {config.showTotalSales && (
            <KpiCard
              title={t('dashboard.kpi.sales')}
              value={`${filteredTransactions.length} ${t('dashboard.unitsSuffix')}`}
              change={pct(filteredTransactions.length, prevFilteredTransactions.length)}
              changeLabel={t('dashboard.vsPrevPeriod')}
              icon={ShoppingBag}
              isPending={isPending}
            />
          )}
          {config.showLowStock && <LowStockCard count={lowStockCount2} isPending={isPending} />}
          {config.showMonthlyGoal && <MonthlyGoalCard current={curRevenue} goal={monthlyGoal} isPending={isPending} />}
          {config.showTodaySales && (
            <TodaySalesCard
              title={t(`dashboard.periodLabels.sales.${period}`)}
              count={filteredTransactions.length}
              revenue={curRevenue}
              prevCount={prevFilteredTransactions.length}
              changeLabel={t('dashboard.vsPrevPeriod')}
              isPending={isPending}
            />
          )}
        </div>
      )}

      {/* ── Main chart card: Jami daromad — full width ── */}
      <div className={cn(CARD_CLS, 'p-6')}>
        <div className="flex items-start justify-between mb-1">
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('dashboard.totalRevenue')}</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tabular-nums mt-0.5">{formatPrice(curRevenue)}</p>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <div className="flex items-center gap-4 mt-1">
              <span className="flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400">
                <span className="inline-block h-2 w-4 rounded-sm shrink-0" style={{ background: monoStrong }} />
                {t('dashboard.current')}
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-gray-400 dark:text-gray-500">
                <span className="inline-block h-2 w-4 rounded-sm shrink-0" style={{ background: monoSoft }} />
                {t('dashboard.previous')}
              </span>
            </div>
            <WidgetMenu />
          </div>
        </div>

        <div style={{ height: 240 }} className="mt-4">
          {isPending ? (
            <Skeleton className="h-full w-full rounded-lg" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartBuckets} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <defs>
                  <linearGradient id="gradCur" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={monoStrong} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={monoStrong} stopOpacity={0.01} />
                  </linearGradient>
                  <linearGradient id="gradPrv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={monoSoft} stopOpacity={0.10} />
                    <stop offset="95%" stopColor={monoSoft} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} interval={Math.max(0, Math.floor(chartBuckets.length / 8))} />
                <YAxis tickFormatter={formatShortPrice} tick={axisTick} axisLine={false} tickLine={false} width={52} />
                <Tooltip
                  contentStyle={{ borderRadius: 8, border: `1px solid ${isDark ? '#374151' : '#E5E7EB'}`, background: isDark ? '#1F2937' : '#fff', fontSize: 12, color: isDark ? '#F3F4F6' : '#111827' }}
                  formatter={(v, name) => [formatPrice(v as number), name === 'current' ? t('dashboard.current') : t('dashboard.previous')]}
                  cursor={{ stroke: cursorArea, strokeWidth: 1 }}
                />
                <Area type="monotone" dataKey="previous" stroke={monoSoft} strokeWidth={1.5} fill="url(#gradPrv)" dot={false} />
                <Area type="monotone" dataKey="current"  stroke={monoStrong} strokeWidth={2} fill="url(#gradCur)" dot={false} activeDot={{ r: 4, fill: monoStrong, stroke: isDark ? '#1F2937' : '#fff', strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Bottom row: Sotuv (bar chart) + Top mahsulotlar (donut) ── */}
      {(config.showDailyChart || config.showTopProducts) && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Sotuv — bar chart (current vs previous period) */}
        {config.showDailyChart && (
        <div className={cn(CARD_CLS, 'p-6', !config.showTopProducts && 'md:col-span-2')}>
          <div className="flex items-center justify-between mb-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <BarChart3 className="h-4 w-4 text-gray-400 dark:text-gray-500" />
              {t('dashboard.dailySales.title')}
            </p>
            <WidgetMenu />
          </div>
          <div className="flex items-center gap-4 mb-3">
            <span className="flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400">
              <span className="inline-block h-2 w-4 rounded-sm shrink-0" style={{ background: monoStrong }} />
              {t('dashboard.current')}
            </span>
            <span className="flex items-center gap-1.5 text-[12px] text-gray-400 dark:text-gray-500">
              <span className="inline-block h-2 w-4 rounded-sm shrink-0" style={{ background: monoSoft }} />
              {t('dashboard.previous')}
            </span>
          </div>

          <div style={{ height: 220 }}>
            {isPending ? (
              <Skeleton className="h-full w-full rounded-lg" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartBuckets} margin={{ top: 4, right: 4, bottom: 0, left: 4 }} barGap={4}>
                  <CartesianGrid {...gridProps} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: isDark ? '#6B7280' : '#9CA3AF', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    interval={Math.max(0, Math.floor(chartBuckets.length / 8))}
                  />
                  <YAxis
                    tickFormatter={formatShortPrice}
                    tick={axisTick}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <Tooltip
                    content={<DailySalesTooltip />}
                    cursor={{ fill: cursorArea }}
                  />
                  <Bar dataKey="previous" name="previous" fill={monoSoft} radius={[4, 4, 0, 0]} maxBarSize={24} />
                  <Bar dataKey="current" name="current" fill={monoStrong} radius={[4, 4, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
        )}

        {/* Top mahsulotlar — donut chart */}
        {config.showTopProducts && (
        <div className={cn(CARD_CLS, 'p-6', !config.showDailyChart && 'md:col-span-2')}>
          <div className="flex items-center justify-between mb-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Trophy className="h-4 w-4 text-gray-400 dark:text-gray-500" />
              {t('dashboard.topProducts.title')}
            </p>
            <WidgetMenu />
          </div>

          {isPending ? (
            <>
              <div className="flex items-center justify-center" style={{ height: 200 }}>
                <Skeleton className="h-[200px] w-[200px] rounded-full" />
              </div>
              <div className="mt-5 space-y-2.5">
                {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[16px] w-full" />)}
              </div>
            </>
          ) : (
            <>
              <div className="relative" style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip content={<TopProductsTooltip />} />
                    <Pie
                      data={topProductsChart}
                      dataKey="qty"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={2}
                      stroke={isDark ? '#111827' : '#FFFFFF'}
                      strokeWidth={2}
                    >
                      {topProductsChart.map(slice => (
                        <Cell key={slice.name} fill={slice.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('dashboard.topProducts.centerLabel')}</p>
                  <p className="text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                    {topProductsTotal} {t('dashboard.unitsSuffix')}
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-2.5">
                {topProductsChart.map(p => (
                  <div key={p.name} className="flex items-center justify-between text-[13px]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: p.color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)' }}
                      />
                      <span className="text-gray-700 dark:text-gray-300 truncate">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-gray-900 dark:text-gray-100 font-medium tabular-nums">
                        {p.qty} {t('dashboard.unitsSuffix')}
                      </span>
                      <span className="text-gray-400 dark:text-gray-500 tabular-nums w-9 text-right">{p.pct}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        )}
      </div>
      )}

      {/* ── So'nggi sotuvlar ── */}
      {config.showRecentSales && (
      <div className={cn(CARD_CLS, 'p-6')}>
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('dashboard.recentSales.title')}</p>
          <WidgetMenu />
        </div>

        {recentSales.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('dashboard.recentSales.empty')}</p>
        ) : (
          <div className="overflow-x-auto -mx-6">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-400 dark:text-gray-500">
                  <th className="px-6 py-2 font-medium">{t('dashboard.recentSales.table.customer')}</th>
                  <th className="px-6 py-2 font-medium">{t('dashboard.recentSales.table.products')}</th>
                  <th className="px-6 py-2 font-medium text-right">{t('dashboard.recentSales.table.amount')}</th>
                  <th className="px-6 py-2 font-medium">{t('dashboard.recentSales.table.payment')}</th>
                  <th className="px-6 py-2 font-medium">{t('dashboard.recentSales.table.date')}</th>
                </tr>
              </thead>
              <tbody>
                {recentSales.map(tx => (
                  <tr key={tx.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-6 py-2.5 text-gray-900 dark:text-gray-100 font-medium whitespace-nowrap">
                      {tx.customerName || t('dashboard.recentSales.guestCustomer')}
                    </td>
                    <td className="px-6 py-2.5 text-gray-500 dark:text-gray-400 max-w-xs truncate">
                      {tx.products.map(p => `${p.productName} ×${p.quantity}`).join(', ')}
                    </td>
                    <td className="px-6 py-2.5 text-right text-gray-900 dark:text-gray-100 font-medium tabular-nums whitespace-nowrap">
                      {formatPrice(tx.totalAmount)}
                    </td>
                    <td className="px-6 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">{tx.paymentMethod}</td>
                    <td className="px-6 py-2.5 text-gray-400 dark:text-gray-500 whitespace-nowrap">{formatDateTime(tx.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
