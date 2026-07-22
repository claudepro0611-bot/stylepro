'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Loader2, ArrowDownCircle, ShoppingBag, Undo2, Trash2, Package, type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { ReportPeriodFilterBar } from '@/components/reports/ReportPeriodFilterBar'
import { DonutChart, type DonutSlice } from '@/components/reports/DonutChart'
import { periodRange, bucketGranularity, buildBuckets, bucketKey, bucketLabel, type Period } from '@/lib/reports/period'

// ─── KPI card (same convention as dashboard/page.tsx's KpiCard/KpiIconBox) ──

function KpiIconBox({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
      <Icon className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
    </div>
  )
}

const KPI_CARD_CLS = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm hover:shadow-md transition-all duration-200 p-4'

interface KpiCardProps {
  title: string
  value: string
  subValue?: string
  icon: LucideIcon
  valueClassName?: string
}

function KpiCard({ title, value, subValue, icon, valueClassName }: KpiCardProps) {
  return (
    <div className={KPI_CARD_CLS}>
      <div className="flex items-start justify-between mb-3">
        <KpiIconBox icon={icon} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{title}</p>
      <p className={`text-lg font-semibold tabular-nums whitespace-nowrap ${valueClassName ?? 'text-gray-900 dark:text-gray-100'}`}>{value}</p>
      {subValue && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{subValue}</p>}
    </div>
  )
}

// ─── Row types ──────────────────────────────────────────────────────────────

interface ProductRow {
  id: string
  name: string
  category: string | null
}

interface ProductSizeRow {
  id: string
  product_id: string | null
  size: string | null
  color: string | null
  stock: number
  purchase_price: number | null
}

interface StockInRow {
  quantity: number
  total_amount: number
  date: string
  entry_type: string
  product_size_id: string | null
}

interface StockOutRow {
  quantity: number
  total_amount: number
  date: string
  entry_type: string | null
  product_size_id: string | null
}

// Chart B (product/category donut) derives BOTH revenue and profit from
// transaction_items so the two figures for the same slice are guaranteed
// consistent with each other — see the module doc comment above the donut
// memos below for why this is kept separate from the stock_out_entries-based
// `saleEntries` used by Chart A and the per-product table.
interface TxnRow {
  id: string
  date: string
  status: string
}

interface TxnItemRow {
  transaction_id: string
  product_id: string | null
  price: number
  purchase_price: number | null
  quantity: number
}

type FilterTab = 'all' | 'sold' | 'brak' | 'returned'

const FILTER_TABS: { value: FilterTab; labelKey: 'reports.inventar.filters.all' | 'reports.inventar.filters.sold' | 'reports.inventar.filters.brak' | 'reports.inventar.filters.returned' }[] = [
  { value: 'all', labelKey: 'reports.inventar.filters.all' },
  { value: 'sold', labelKey: 'reports.inventar.filters.sold' },
  { value: 'brak', labelKey: 'reports.inventar.filters.brak' },
  { value: 'returned', labelKey: 'reports.inventar.filters.returned' },
]

const PILL_CLS = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
  }`

// 5th+ categories beyond this cap are grouped into a single "Other" slice so
// a long product catalog doesn't produce a pie chart with dozens of slivers.
const TOP_CATEGORY_COUNT = 5
// Top-N products shown in the "Mahsulot bo'yicha" donut tab, with the rest
// grouped into an "Other" slice (same convention as categories above).
const TOP_PRODUCT_COUNT = 7

// Cyclic palette for the donut's top-N slices. Reserved separately: slate-400
// (OTHER_COLOR) is always used for the "Boshqalar" bucket regardless of how
// many regular slices precede it — it is never assigned via the cyclic index.
const CATEGORY_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#f43f5e', '#06b6d4']
const OTHER_COLOR = '#94a3b8'

type PieTab = 'product' | 'category'

export default function InventarReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [period, setPeriod] = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [filterTab, setFilterTab] = useState<FilterTab>('all')
  const [pieTab, setPieTab] = useState<PieTab>('product')

  const [products, setProducts] = useState<ProductRow[]>([])
  const [productSizes, setProductSizes] = useState<ProductSizeRow[]>([])
  const [stockInEntries, setStockInEntries] = useState<StockInRow[]>([])
  const [stockOutEntries, setStockOutEntries] = useState<StockOutRow[]>([])
  const [transactions, setTransactions] = useState<TxnRow[]>([])
  const [txnItems, setTxnItems] = useState<TxnItemRow[]>([])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [productsRes, sizesRes, stockInRes, stockOutRes, txnRes, txnItemRes] = await Promise.all([
      supabase.from('products').select('id, name, category'),
      supabase.from('product_sizes').select('id, product_id, size, color, stock, purchase_price'),
      supabase.from('stock_in_entries').select('quantity, total_amount, date, entry_type, product_size_id'),
      supabase.from('stock_out_entries').select('quantity, total_amount, date, entry_type, product_size_id'),
      supabase.from('transactions').select('id, date, status').eq('status', 'completed'),
      supabase.from('transaction_items').select('transaction_id, product_id, price, purchase_price, quantity'),
    ])

    if (productsRes.error || sizesRes.error || stockInRes.error || stockOutRes.error || txnRes.error || txnItemRes.error) {
      toast.error(t('common.error'))
    } else {
      setProducts((productsRes.data ?? []) as ProductRow[])
      setProductSizes((sizesRes.data ?? []) as ProductSizeRow[])
      setStockInEntries((stockInRes.data ?? []) as StockInRow[])
      setStockOutEntries((stockOutRes.data ?? []) as StockOutRow[])
      setTransactions((txnRes.data ?? []) as TxnRow[])
      setTxnItems((txnItemRes.data ?? []) as TxnItemRow[])
    }
    setLoading(false)
  }, [t])

  useEffect(() => { fetchAll() }, [fetchAll])

  const [from, to] = useMemo(() => periodRange(period, customFrom, customTo), [period, customFrom, customTo])
  const inRange = useCallback((d: string) => { const day = d.slice(0, 10); return day >= from && day <= to }, [from, to])

  const filteredStockIn = useMemo(() => stockInEntries.filter(e => inRange(e.date)), [stockInEntries, inRange])
  const filteredStockOut = useMemo(() => stockOutEntries.filter(e => inRange(e.date)), [stockOutEntries, inRange])

  const purchaseEntries = useMemo(() => filteredStockIn.filter(e => e.entry_type === 'purchase'), [filteredStockIn])
  const returnEntries = useMemo(() => filteredStockIn.filter(e => e.entry_type === 'return'), [filteredStockIn])
  const saleEntries = useMemo(() => filteredStockOut.filter(e => e.entry_type === 'sale'), [filteredStockOut])
  const brakEntries = useMemo(() => filteredStockOut.filter(e => e.entry_type === 'brak'), [filteredStockOut])

  // Period-filtered transaction_items for Chart B (product/category donut),
  // joined through transactions.date — same pattern as
  // app/(dashboard)/reports/moliya/page.tsx's filteredItems/txnIdSet.
  const filteredTxns = useMemo(() => transactions.filter(txn => inRange(txn.date)), [transactions, inRange])
  const txnIdSet = useMemo(() => new Set(filteredTxns.map(txn => txn.id)), [filteredTxns])
  const filteredTxnItems = useMemo(() => txnItems.filter(i => txnIdSet.has(i.transaction_id)), [txnItems, txnIdSet])

  // ─── Chart A: Kirim/Sotuv/Qaytarish/Brak grouped by day or week ───────────
  // Bucketing rule (shared with moliya's trend chart, see
  // lib/reports/period.ts): daily buckets when the selected range is ≤31
  // days, weekly buckets for longer ranges.
  const granularity = useMemo(() => bucketGranularity(from, to), [from, to])
  const buckets = useMemo(() => buildBuckets(from, to, granularity), [from, to, granularity])

  const movementData = useMemo(() => {
    interface Bucket { stockIn: number; sold: number; returned: number; brak: number }
    const map = new Map<string, Bucket>()
    buckets.forEach(b => map.set(b, { stockIn: 0, sold: 0, returned: 0, brak: 0 }))
    const add = (rows: { date: string; quantity: number }[], key: keyof Bucket) => {
      rows.forEach(e => {
        const entry = map.get(bucketKey(e.date, from, granularity))
        if (!entry) return
        entry[key] += Number(e.quantity)
      })
    }
    add(purchaseEntries, 'stockIn')
    add(saleEntries, 'sold')
    add(returnEntries, 'returned')
    add(brakEntries, 'brak')
    return buckets.map(b => ({ label: bucketLabel(b), ...map.get(b)! }))
  }, [buckets, purchaseEntries, saleEntries, returnEntries, brakEntries, from, granularity])

  const productNameMap = useMemo(() => {
    const m = new Map<string, string>()
    products.forEach(p => m.set(p.id, p.name))
    return m
  }, [products])

  // ─── Chart B: top categories / top products by sale revenue + profit ──────
  // Sourced from transaction_items (not the stock_out_entries-based
  // saleEntries used elsewhere on this page) so revenue and profit for the
  // same slice always reconcile — see TxnItemRow's doc comment above.
  const categoryByProductId = useMemo(() => {
    const m = new Map<string, string>()
    products.forEach(p => m.set(p.id, p.category || t('reports.inventar.charts.other')))
    return m
  }, [products, t])

  interface RevenueProfit { revenue: number; profit: number }

  const categoryData = useMemo<DonutSlice[]>(() => {
    const otherLabel = t('reports.inventar.charts.other')
    const totals = new Map<string, RevenueProfit>()
    filteredTxnItems.forEach(item => {
      const category = categoryByProductId.get(item.product_id ?? '') ?? otherLabel
      const revenue = Number(item.price) * Number(item.quantity)
      const profit = (Number(item.price) - Number(item.purchase_price ?? 0)) * Number(item.quantity)
      const cur = totals.get(category) ?? { revenue: 0, profit: 0 }
      cur.revenue += revenue
      cur.profit += profit
      totals.set(category, cur)
    })
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1].revenue - a[1].revenue)
    const top = sorted.slice(0, TOP_CATEGORY_COUNT)
    const rest = sorted.slice(TOP_CATEGORY_COUNT)
    const rows = top.map(([name, v]) => ({ name, ...v }))
    if (rest.length > 0) {
      const restRevenue = rest.reduce((s, [, v]) => s + v.revenue, 0)
      const restProfit = rest.reduce((s, [, v]) => s + v.profit, 0)
      if (restRevenue > 0) rows.push({ name: otherLabel, revenue: restRevenue, profit: restProfit })
    }
    return rows.filter(r => r.revenue > 0).map((r, i) => ({
      key: r.name,
      name: r.name,
      value: r.revenue,
      profit: r.profit,
      color: r.name === otherLabel ? OTHER_COLOR : CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }))
  }, [filteredTxnItems, categoryByProductId, t])

  // Top 7 products by sale revenue for the "Mahsulot bo'yicha" donut tab,
  // with the remainder grouped into a "Boshqalar" slice (same convention as
  // categoryData above).
  const productRevenueData = useMemo<DonutSlice[]>(() => {
    const otherLabel = t('reports.inventar.charts.other')
    const totals = new Map<string, RevenueProfit>()
    filteredTxnItems.forEach(item => {
      const productId = item.product_id ?? ''
      const revenue = Number(item.price) * Number(item.quantity)
      const profit = (Number(item.price) - Number(item.purchase_price ?? 0)) * Number(item.quantity)
      const cur = totals.get(productId) ?? { revenue: 0, profit: 0 }
      cur.revenue += revenue
      cur.profit += profit
      totals.set(productId, cur)
    })
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1].revenue - a[1].revenue)
    const top = sorted.slice(0, TOP_PRODUCT_COUNT)
    const rest = sorted.slice(TOP_PRODUCT_COUNT)
    const rows = top.map(([productId, v], i) => ({
      key: productId || `unknown-${i}`,
      name: productNameMap.get(productId) ?? otherLabel,
      ...v,
    }))
    if (rest.length > 0) {
      const restRevenue = rest.reduce((s, [, v]) => s + v.revenue, 0)
      const restProfit = rest.reduce((s, [, v]) => s + v.profit, 0)
      if (restRevenue > 0) rows.push({ key: '__other__', name: otherLabel, revenue: restRevenue, profit: restProfit })
    }
    return rows.filter(r => r.revenue > 0).map((r, i) => ({
      key: r.key,
      name: r.name,
      value: r.revenue,
      profit: r.profit,
      color: r.name === otherLabel ? OTHER_COLOR : CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }))
  }, [filteredTxnItems, productNameMap, t])

  const pieData = pieTab === 'product' ? productRevenueData : categoryData

  const axisColor = isDark ? '#6B7280' : '#9CA3AF'
  const gridColor = isDark ? '#374151' : '#F3F4F6'
  const tooltipStyle = {
    contentStyle: { background: isDark ? '#111827' : '#fff', border: '1px solid ' + (isDark ? '#374151' : '#E5E7EB'), borderRadius: 8, fontSize: 12 },
    labelStyle: { color: isDark ? '#D1D5DB' : '#374151' },
  }

  // ─── KPI cards ────────────────────────────────────────────────────────────

  const stockInQty = useMemo(() => purchaseEntries.reduce((s, e) => s + Number(e.quantity), 0), [purchaseEntries])
  const stockInAmount = useMemo(() => purchaseEntries.reduce((s, e) => s + Number(e.total_amount), 0), [purchaseEntries])
  const soldQty = useMemo(() => saleEntries.reduce((s, e) => s + Number(e.quantity), 0), [saleEntries])
  const returnedQty = useMemo(() => returnEntries.reduce((s, e) => s + Number(e.quantity), 0), [returnEntries])
  const returnedAmount = useMemo(() => returnEntries.reduce((s, e) => s + Number(e.total_amount), 0), [returnEntries])
  const brakQty = useMemo(() => brakEntries.reduce((s, e) => s + Number(e.quantity), 0), [brakEntries])

  const purchasePriceBySize = useMemo(() => {
    const m = new Map<string, number>()
    productSizes.forEach(ps => m.set(ps.id, Number(ps.purchase_price ?? 0)))
    return m
  }, [productSizes])

  // Same "current product_sizes.purchase_price" approximation convention
  // already accepted elsewhere in this codebase (e.g. the original
  // reports/page.tsx's brak-loss calculation) — not a new gap introduced here.
  const brakLossAmount = useMemo(() =>
    brakEntries.reduce((s, e) => s + Number(e.quantity) * (purchasePriceBySize.get(e.product_size_id ?? '') ?? 0), 0),
    [brakEntries, purchasePriceBySize],
  )

  // Current on-hand total — NOT period-filtered.
  const remainingQty = useMemo(() => productSizes.reduce((s, ps) => s + Number(ps.stock), 0), [productSizes])

  // ─── Per-product table ────────────────────────────────────────────────────

  interface ProductTableRow {
    id: string
    name: string
    colorSize: string
    stockIn: number
    sold: number
    returned: number
    brak: number
    remaining: number
    revenue: number
  }

  const productTable = useMemo<ProductTableRow[]>(() => {
    return productSizes.map(ps => {
      const stockIn = purchaseEntries.filter(e => e.product_size_id === ps.id).reduce((s, e) => s + Number(e.quantity), 0)
      const sold = saleEntries.filter(e => e.product_size_id === ps.id).reduce((s, e) => s + Number(e.quantity), 0)
      const returned = returnEntries.filter(e => e.product_size_id === ps.id).reduce((s, e) => s + Number(e.quantity), 0)
      const brak = brakEntries.filter(e => e.product_size_id === ps.id).reduce((s, e) => s + Number(e.quantity), 0)
      const revenue = saleEntries.filter(e => e.product_size_id === ps.id).reduce((s, e) => s + Number(e.total_amount), 0)
      const colorSize = [ps.color, ps.size].filter(Boolean).join(' / ')
      return {
        id: ps.id,
        name: productNameMap.get(ps.product_id ?? '') ?? '',
        colorSize,
        stockIn,
        sold,
        returned,
        brak,
        remaining: Number(ps.stock),
        revenue,
      }
    }).filter(row => {
      if (filterTab === 'sold') return row.sold > 0
      if (filterTab === 'brak') return row.brak > 0
      if (filterTab === 'returned') return row.returned > 0
      return true
    }).sort((a, b) => b.revenue - a.revenue)
  }, [productSizes, purchaseEntries, saleEntries, returnEntries, brakEntries, productNameMap, filterTab])

  const tableTotals = useMemo(() => ({
    stockIn: productTable.reduce((s, r) => s + r.stockIn, 0),
    sold: productTable.reduce((s, r) => s + r.sold, 0),
    returned: productTable.reduce((s, r) => s + r.returned, 0),
    brak: productTable.reduce((s, r) => s + r.brak, 0),
    remaining: productTable.reduce((s, r) => s + r.remaining, 0),
    revenue: productTable.reduce((s, r) => s + r.revenue, 0),
  }), [productTable])

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
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('reports.inventar.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('reports.inventar.subtitle')}</p>
      </div>

      <ReportPeriodFilterBar
        period={period}
        onPeriodChange={setPeriod}
        customFrom={customFrom}
        onCustomFromChange={setCustomFrom}
        customTo={customTo}
        onCustomToChange={setCustomTo}
      />

      {/* KPI cards */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
        <KpiCard
          title={t('reports.inventar.kpi.stockIn')}
          value={`${stockInQty} ${t('common.unitsSuffix')}`}
          subValue={formatPrice(stockInAmount)}
          icon={ArrowDownCircle}
        />
        <KpiCard
          title={t('reports.inventar.kpi.sold')}
          value={`${soldQty} ${t('common.unitsSuffix')}`}
          icon={ShoppingBag}
        />
        <KpiCard
          title={t('reports.inventar.kpi.returned')}
          value={`${returnedQty} ${t('common.unitsSuffix')}`}
          subValue={formatPrice(returnedAmount)}
          icon={Undo2}
        />
        <KpiCard
          title={t('reports.inventar.kpi.brak')}
          value={`${brakQty} ${t('common.unitsSuffix')}`}
          subValue={formatPrice(brakLossAmount)}
          icon={Trash2}
          valueClassName="text-red-600 dark:text-red-400"
        />
        <KpiCard
          title={t('reports.inventar.kpi.remaining')}
          value={`${remainingQty} ${t('common.unitsSuffix')}`}
          icon={Package}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.inventar.charts.movementTitle')}</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={movementData}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="label" tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                <Tooltip {...tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="stockIn" name={t('reports.inventar.charts.stockIn')} fill="#2563eb" radius={[2, 2, 0, 0]} />
                <Bar dataKey="sold" name={t('reports.inventar.charts.sold')} fill="#059669" radius={[2, 2, 0, 0]} />
                <Bar dataKey="returned" name={t('reports.inventar.charts.returned')} fill="#f59e0b" radius={[2, 2, 0, 0]} />
                <Bar dataKey="brak" name={t('reports.inventar.charts.brak')} fill="#ef4444" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.inventar.charts.salesBreakdownTitle')}</p>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setPieTab('product')} className={PILL_CLS(pieTab === 'product')}>
                {t('reports.inventar.charts.byProduct')}
              </button>
              <button onClick={() => setPieTab('category')} className={PILL_CLS(pieTab === 'category')}>
                {t('reports.inventar.charts.byCategory')}
              </button>
            </div>
          </div>
          <div className="p-4">
            <DonutChart
              data={pieData}
              formatValue={formatPrice}
              isDark={isDark}
              centerLabel={t('reports.table.total')}
              height={280}
              valueLabel={t('reports.inventar.charts.revenueLabel')}
              profitLabel={t('reports.inventar.charts.profitLabel')}
            />
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_TABS.map(tab => (
          <button key={tab.value} onClick={() => setFilterTab(tab.value)} className={PILL_CLS(filterTab === tab.value)}>
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Per-product table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.inventar.table.title')}</p>
        </div>
        {productTable.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-gray-400">{t('common.noData')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide">№</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.product')}</th>
                  <th className="px-4 py-3 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.colorSize')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.stockIn')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.sold')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.returned')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.brak')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.remaining')}</th>
                  <th className="px-4 py-3 text-right text-[11px] font-medium text-gray-400 uppercase tracking-wide">{t('reports.inventar.table.revenue')}</th>
                </tr>
              </thead>
              <tbody>
                {productTable.map((row, i) => (
                  <tr key={row.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}>
                    <td className="px-4 py-3 text-[12px] text-gray-400">{i + 1}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{row.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{row.colorSize || '—'}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400 tabular-nums">{row.stockIn}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400 tabular-nums">{row.sold}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400 tabular-nums">{row.returned}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400 tabular-nums">{row.brak}</td>
                    <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-100 font-medium tabular-nums">{row.remaining}</td>
                    <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(row.revenue)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('reports.table.total')}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{tableTotals.stockIn}</td>
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{tableTotals.sold}</td>
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{tableTotals.returned}</td>
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{tableTotals.brak}</td>
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{tableTotals.remaining}</td>
                  <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(tableTotals.revenue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
