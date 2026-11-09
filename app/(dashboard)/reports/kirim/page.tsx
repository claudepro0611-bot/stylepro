'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Boxes, PackagePlus, TrendingUp, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useBranchFilter } from '@/lib/session/useBranch'
import { formatDate } from '@/lib/utils/formatters'
import { bucketGranularity, buildBuckets, bucketKey, bucketLabel } from '@/lib/reports/period'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { KpiGrid, ReportHeader, ReportTable, downloadCsv, monthToDate, segBtnCls, type ReportColumn } from '@/components/reports/ReportKit'

interface EntryRow {
  id: string
  product_id: string | null
  product_name: string | null
  category: string | null
  size: string | null
  color: string | null
  quantity: number
  purchase_price: number | null
  unit_price: number | null
  selling_price: number | null
  total_amount: number | null
  supplier: string | null
  date: string
  product_size_id: string | null
}

type Dim = 'product' | 'category' | 'warehouse' | 'date' | 'list'

interface GroupRow {
  key: string
  name: string
  sub?: string
  entries: number
  qty: number
  cost: number
  sales: number
  margin: number
}

const cost = (e: EntryRow) => {
  const total = Number(e.total_amount ?? 0)
  return total > 0 ? total : Number(e.quantity) * Number(e.purchase_price ?? e.unit_price ?? 0)
}
const sales = (e: EntryRow) => Number(e.quantity) * Number(e.selling_price ?? 0)

export default function KirimReportPage() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [dim, setDim] = useState<Dim>('product')
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [warehouseOf, setWarehouseOf] = useState<Map<string, string>>(new Map())
  const applyBranch = useBranchFilter()

  // Variant → warehouse name (stock_in_entries has no warehouse column).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const [sizesRes, whRes] = await Promise.all([
        fetchAllRows<{ id: string; warehouse_id: string | null }>((from, to) => supabase.from('product_sizes').select('id, warehouse_id').order('id').range(from, to)),
        supabase.from('warehouses').select('id, name'),
      ])
      if (cancelled) return
      const whName = new Map(((whRes.data ?? []) as { id: string; name: string }[]).map(w => [w.id, w.name]))
      setWarehouseOf(new Map(sizesRes.data.map(s => [s.id, (s.warehouse_id && whName.get(s.warehouse_id)) || '—'])))
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const { data } = await fetchAllRows<EntryRow>((from, to) => {
        let q = applyBranch(supabase.from('stock_in_entries')
          .select('id, product_id, product_name, category, size, color, quantity, purchase_price, unit_price, selling_price, total_amount, supplier, date, product_size_id')
          .eq('entry_type', 'purchase'))
        if (range) q = q.gte('date', range.from).lte('date', `${range.to}T23:59:59`)
        return q.order('id').range(from, to) as unknown as PromiseLike<{ data: EntryRow[] | null; error: unknown }>
      })
      if (cancelled) return
      setEntries(data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, applyBranch])

  const totals = useMemo(() => {
    const c = entries.reduce((s, e) => s + cost(e), 0)
    const sl = entries.reduce((s, e) => s + sales(e), 0)
    return { entries: entries.length, qty: entries.reduce((s, e) => s + Number(e.quantity), 0), cost: c, sales: sl, profit: sl - c }
  }, [entries])

  const groups = useMemo<GroupRow[]>(() => {
    if (dim === 'list') return []
    const map = new Map<string, GroupRow>()
    for (const e of entries) {
      let key: string, name: string, sub: string | undefined
      if (dim === 'product') { key = e.product_id ?? e.product_name ?? '—'; name = e.product_name ?? '—'; sub = e.category ?? undefined }
      else if (dim === 'category') { key = name = e.category || '—' }
      else if (dim === 'warehouse') { key = name = (e.product_size_id && warehouseOf.get(e.product_size_id)) || '—' }
      else { key = e.date.slice(0, 10); name = formatDate(key) }
      const g = map.get(key) ?? { key, name, sub, entries: 0, qty: 0, cost: 0, sales: 0, margin: 0 }
      g.entries += 1
      g.qty += Number(e.quantity)
      g.cost += cost(e)
      g.sales += sales(e)
      map.set(key, g)
    }
    for (const g of map.values()) g.margin = g.sales > 0 ? ((g.sales - g.cost) / g.sales) * 100 : 0
    return Array.from(map.values())
  }, [entries, dim, warehouseOf])

  const chartData = useMemo(() => {
    const dates = entries.map(e => e.date.slice(0, 10)).sort()
    const from = range?.from ?? dates[0]
    const to = range?.to ?? dates[dates.length - 1]
    if (!from || !to) return []
    const gran = bucketGranularity(from, to)
    const buckets = buildBuckets(from, to, gran)
    const map = new Map(buckets.map(b => [b, 0]))
    for (const e of entries) {
      const k = bucketKey(e.date.slice(0, 10), from, gran)
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + cost(e))
    }
    return buckets.map(b => ({ label: bucketLabel(b), cost: map.get(b) ?? 0 }))
  }, [entries, range])

  const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, '')}%`

  const dimLabel: Record<Dim, string> = {
    product: t('reportsKit.product'),
    category: t('reportsKit.category'),
    warehouse: t('kirimReport.warehouse'),
    date: t('kirimReport.date'),
    list: t('kirimReport.list'),
  }

  const groupColumns: ReportColumn<GroupRow>[] = [
    {
      key: 'name', label: dimLabel[dim],
      render: g => (
        <div>
          <p className="text-gray-900 dark:text-gray-100">{g.name}</p>
          {g.sub && <p className="text-xs text-gray-400 dark:text-gray-500">{g.sub}</p>}
        </div>
      ),
      sortValue: g => (dim === 'date' ? g.key : g.name), footer: t('reportsKit.total'),
    },
    { key: 'entries', label: t('suppliersReport.entries'), align: 'right', render: g => g.entries, sortValue: g => g.entries, footer: totals.entries },
    { key: 'qty', label: t('suppliersReport.qty'), align: 'right', render: g => g.qty, sortValue: g => g.qty, footer: totals.qty },
    { key: 'cost', label: t('suppliersReport.amount'), align: 'right', render: g => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(g.cost)}</span>, sortValue: g => g.cost, footer: formatPrice(totals.cost) },
    { key: 'sales', label: t('kirimReport.salesValue'), align: 'right', render: g => <span className="text-gray-500 dark:text-gray-400">{formatPrice(g.sales)}</span>, sortValue: g => g.sales, footer: formatPrice(totals.sales) },
    { key: 'margin', label: t('profitReport.margin'), align: 'right', render: g => pct(g.margin), sortValue: g => g.margin },
  ]

  const listColumns: ReportColumn<EntryRow>[] = [
    { key: 'date', label: t('kirimReport.date'), render: e => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(e.date.slice(0, 10))}</span>, sortValue: e => e.date },
    {
      key: 'name', label: t('reportsKit.product'),
      render: e => (
        <div>
          <p className="text-gray-900 dark:text-gray-100">{e.product_name ?? '—'}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">{[e.color, e.size].filter(Boolean).join(' / ')}</p>
        </div>
      ),
      sortValue: e => e.product_name ?? '', footer: t('reportsKit.total'),
    },
    { key: 'warehouse', label: t('kirimReport.warehouse'), render: e => <span className="text-gray-500 dark:text-gray-400">{(e.product_size_id && warehouseOf.get(e.product_size_id)) || '—'}</span>, sortValue: e => (e.product_size_id && warehouseOf.get(e.product_size_id)) || '' },
    { key: 'qty', label: t('suppliersReport.qty'), align: 'right', render: e => e.quantity, sortValue: e => Number(e.quantity), footer: totals.qty },
    { key: 'purchase', label: t('kirimReport.purchasePrice'), align: 'right', render: e => formatPrice(Number(e.purchase_price ?? e.unit_price ?? 0)), sortValue: e => Number(e.purchase_price ?? e.unit_price ?? 0) },
    { key: 'selling', label: t('kirimReport.sellingPrice'), align: 'right', render: e => <span className="text-gray-500 dark:text-gray-400">{formatPrice(Number(e.selling_price ?? 0))}</span>, sortValue: e => Number(e.selling_price ?? 0) },
    { key: 'cost', label: t('suppliersReport.amount'), align: 'right', render: e => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(cost(e))}</span>, sortValue: e => cost(e), footer: formatPrice(totals.cost) },
    { key: 'supplier', label: t('suppliersReport.supplier'), render: e => <span className="text-gray-500 dark:text-gray-400">{e.supplier?.trim() || '—'}</span>, sortValue: e => e.supplier ?? '' },
  ]

  function exportCsv() {
    if (dim === 'list') {
      downloadCsv('kirim_royxat', [t('kirimReport.date'), t('reportsKit.product'), t('kirimReport.variant'), t('kirimReport.warehouse'), t('suppliersReport.qty'), t('kirimReport.purchasePrice'), t('kirimReport.sellingPrice'), t('suppliersReport.amount'), t('suppliersReport.supplier')],
        [...entries].sort((a, b) => b.date.localeCompare(a.date)).map(e => [e.date.slice(0, 10), e.product_name ?? '', [e.color, e.size].filter(Boolean).join(' / '), (e.product_size_id && warehouseOf.get(e.product_size_id)) || '', e.quantity, Number(e.purchase_price ?? e.unit_price ?? 0), Number(e.selling_price ?? 0), Math.round(cost(e)), e.supplier ?? '']))
      return
    }
    downloadCsv(`kirim_${dim}`, [dimLabel[dim], t('suppliersReport.entries'), t('suppliersReport.qty'), t('suppliersReport.amount'), t('kirimReport.salesValue'), t('profitReport.margin')],
      [...groups].sort((a, b) => b.cost - a.cost).map(g => [g.name, g.entries, g.qty, Math.round(g.cost), Math.round(g.sales), g.margin.toFixed(1)]))
  }

  const axisColor = isDark ? '#A1A1AA' : '#6B7280'
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : '#E5E7EB'

  return (
    <div className="space-y-6">
      <ReportHeader title={t('kirimReport.title')} subtitle={t('kirimReport.subtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')} showBranch>
        <div className="ml-auto inline-flex flex-wrap rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          {(['product', 'category', 'warehouse', 'date', 'list'] as const).map(d => (
            <button key={d} onClick={() => setDim(d)} className={segBtnCls(dim === d)}>{dimLabel[d]}</button>
          ))}
        </div>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('suppliersReport.entries'), value: String(totals.entries), icon: PackagePlus },
        { label: t('suppliersReport.qty'), value: String(totals.qty), icon: Boxes },
        { label: t('suppliersReport.amount'), value: formatPrice(totals.cost), icon: Wallet },
        { label: `${t('kirimReport.expectedProfit')} · ${formatShortPrice(totals.sales)}`, value: formatPrice(totals.profit), icon: TrendingUp, tone: totals.profit < 0 ? 'negative' : 'positive' },
      ]} />

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        <p className="mb-3 text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('kirimReport.chartTitle')}</p>
        {chartData.length === 0 ? (
          <div className="flex h-56 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('reportsKit.empty')}</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => formatShortPrice(Number(v))} width={55} />
              <Tooltip
                cursor={{ fill: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}
                contentStyle={{ background: isDark ? '#111827' : '#fff', border: `1px solid ${isDark ? '#374151' : '#E5E7EB'}`, borderRadius: 8, fontSize: 12 }}
                formatter={v => [formatPrice(Number(v)), t('suppliersReport.amount')]}
              />
              <Bar dataKey="cost" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {dim === 'list' ? (
        <ReportTable key="list" rows={entries} columns={listColumns} rowKey={e => e.id} loading={loading} emptyText={t('reportsKit.empty')} initialSort={{ key: 'date', dir: 'desc' }} />
      ) : (
        <ReportTable key={dim} rows={groups} columns={groupColumns} rowKey={g => g.key} loading={loading} emptyText={t('reportsKit.empty')} initialSort={dim === 'date' ? { key: 'name', dir: 'desc' } : { key: 'cost', dir: 'desc' }} />
      )}
    </div>
  )
}
