'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Loader2, ArrowDownCircle, ShoppingBag, Undo2, Trash2, Package, type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { ReportPeriodFilterBar } from '@/components/reports/ReportPeriodFilterBar'
import { periodRange, type Period } from '@/lib/reports/period'

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

export default function InventarReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [period, setPeriod] = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [filterTab, setFilterTab] = useState<FilterTab>('all')

  const [products, setProducts] = useState<ProductRow[]>([])
  const [productSizes, setProductSizes] = useState<ProductSizeRow[]>([])
  const [stockInEntries, setStockInEntries] = useState<StockInRow[]>([])
  const [stockOutEntries, setStockOutEntries] = useState<StockOutRow[]>([])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [productsRes, sizesRes, stockInRes, stockOutRes] = await Promise.all([
      supabase.from('products').select('id, name'),
      supabase.from('product_sizes').select('id, product_id, size, color, stock, purchase_price'),
      supabase.from('stock_in_entries').select('quantity, total_amount, date, entry_type, product_size_id'),
      supabase.from('stock_out_entries').select('quantity, total_amount, date, entry_type, product_size_id'),
    ])

    if (productsRes.error || sizesRes.error || stockInRes.error || stockOutRes.error) {
      toast.error(t('common.error'))
    } else {
      setProducts((productsRes.data ?? []) as ProductRow[])
      setProductSizes((sizesRes.data ?? []) as ProductSizeRow[])
      setStockInEntries((stockInRes.data ?? []) as StockInRow[])
      setStockOutEntries((stockOutRes.data ?? []) as StockOutRow[])
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

  const productNameMap = useMemo(() => {
    const m = new Map<string, string>()
    products.forEach(p => m.set(p.id, p.name))
    return m
  }, [products])

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
