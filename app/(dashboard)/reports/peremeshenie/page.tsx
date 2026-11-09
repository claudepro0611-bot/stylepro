'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { ArrowLeftRight, ArrowRight, Boxes, Layers, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useActiveBranchId } from '@/lib/session/useBranch'
import { formatDate } from '@/lib/utils/formatters'
import { bucketGranularity, buildBuckets, bucketKey, bucketLabel } from '@/lib/reports/period'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { KpiGrid, ReportHeader, ReportTable, downloadCsv, monthToDate, segBtnCls, type ReportColumn } from '@/components/reports/ReportKit'

interface ItemRow {
  id: string
  product_id: string | null
  product_name: string
  category: string | null
  size: string
  color: string
  quantity: number
  purchase_price: number
  stock_transfers: { number: number; date: string; from_warehouse_id: string; to_warehouse_id: string } | null
}

type Dim = 'product' | 'route' | 'date' | 'list'

interface GroupRow {
  key: string
  name: string
  sub?: string
  transfers: number
  qty: number
  value: number
}

const value = (i: ItemRow) => Number(i.quantity) * Number(i.purchase_price)

export default function TransfersReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [dim, setDim] = useState<Dim>('product')
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ItemRow[]>([])
  const [whName, setWhName] = useState<Map<string, string>>(new Map())
  const activeBranchId = useActiveBranchId()

  useEffect(() => {
    createClient().from('warehouses').select('id, name').then(({ data }) =>
      setWhName(new Map(((data ?? []) as { id: string; name: string }[]).map(w => [w.id, w.name]))))
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const { data } = await fetchAllRows<ItemRow>((from, to) => {
        let q = supabase.from('stock_transfer_items')
          .select('id, product_id, product_name, category, size, color, quantity, purchase_price, stock_transfers!inner(number, date, from_warehouse_id, to_warehouse_id)')
        if (range) q = q.gte('stock_transfers.date', range.from).lte('stock_transfers.date', range.to)
        // A transfer belongs to a branch when it leaves OR enters it.
        if (activeBranchId) q = q.or(`from_branch_id.eq.${activeBranchId},to_branch_id.eq.${activeBranchId}`, { referencedTable: 'stock_transfers' })
        return q.order('id').range(from, to) as unknown as PromiseLike<{ data: ItemRow[] | null; error: unknown }>
      })
      if (cancelled) return
      setItems(data.filter(i => i.stock_transfers))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, activeBranchId])

  const dateOf = (i: ItemRow) => i.stock_transfers?.date ?? ''
  const routeOf = (i: ItemRow) => `${whName.get(i.stock_transfers?.from_warehouse_id ?? '') ?? '—'} → ${whName.get(i.stock_transfers?.to_warehouse_id ?? '') ?? '—'}`

  const totals = useMemo(() => ({
    transfers: new Set(items.map(i => i.stock_transfers?.number)).size,
    qty: items.reduce((s, i) => s + Number(i.quantity), 0),
    value: items.reduce((s, i) => s + value(i), 0),
    products: new Set(items.map(i => i.product_id ?? i.product_name)).size,
  }), [items])

  const groups = useMemo<GroupRow[]>(() => {
    if (dim === 'list') return []
    const map = new Map<string, GroupRow & { nums: Set<number> }>()
    for (const i of items) {
      let key: string, name: string, sub: string | undefined
      if (dim === 'product') { key = i.product_id ?? i.product_name; name = i.product_name; sub = i.category ?? undefined }
      else if (dim === 'route') {
        key = `${i.stock_transfers?.from_warehouse_id}|${i.stock_transfers?.to_warehouse_id}`
        name = `${whName.get(i.stock_transfers?.from_warehouse_id ?? '') ?? '—'} → ${whName.get(i.stock_transfers?.to_warehouse_id ?? '') ?? '—'}`
      }
      else { key = i.stock_transfers?.date ?? ''; name = formatDate(key) }
      const g = map.get(key) ?? { key, name, sub, transfers: 0, qty: 0, value: 0, nums: new Set<number>() }
      if (i.stock_transfers) g.nums.add(i.stock_transfers.number)
      g.transfers = g.nums.size
      g.qty += Number(i.quantity)
      g.value += value(i)
      map.set(key, g)
    }
    return Array.from(map.values())
  }, [items, dim, whName])

  const chartData = useMemo(() => {
    const dates = items.map(dateOf).filter(Boolean).sort()
    const from = range?.from ?? dates[0]
    const to = range?.to ?? dates[dates.length - 1]
    if (!from || !to) return []
    const gran = bucketGranularity(from, to)
    const buckets = buildBuckets(from, to, gran)
    const map = new Map(buckets.map(b => [b, 0]))
    for (const i of items) {
      const k = bucketKey(dateOf(i), from, gran)
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + Number(i.quantity))
    }
    return buckets.map(b => ({ label: bucketLabel(b), qty: map.get(b) ?? 0 }))
  }, [items, range])

  const dimLabel: Record<Dim, string> = {
    product: t('reportsKit.product'),
    route: t('transfersReport.route'),
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
    { key: 'transfers', label: t('transfersReport.transfers'), align: 'right', render: g => g.transfers, sortValue: g => g.transfers, footer: totals.transfers },
    { key: 'qty', label: t('transfersReport.qty'), align: 'right', render: g => g.qty, sortValue: g => g.qty, footer: totals.qty },
    { key: 'value', label: t('transfersReport.value'), align: 'right', render: g => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(g.value)}</span>, sortValue: g => g.value, footer: formatPrice(totals.value) },
  ]

  const listColumns: ReportColumn<ItemRow>[] = [
    { key: 'date', label: t('kirimReport.date'), render: i => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(dateOf(i))}</span>, sortValue: i => `${dateOf(i)}|${String(i.stock_transfers?.number ?? 0).padStart(8, '0')}` },
    { key: 'number', label: t('transfers.number'), render: i => <span className="text-gray-500 dark:text-gray-400">#{i.stock_transfers?.number}</span>, sortValue: i => i.stock_transfers?.number ?? 0 },
    {
      key: 'name', label: t('reportsKit.product'),
      render: i => (
        <div>
          <p className="text-gray-900 dark:text-gray-100">{i.product_name}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">{[i.color, i.size].filter(Boolean).join(' / ')}</p>
        </div>
      ),
      sortValue: i => i.product_name, footer: t('reportsKit.total'),
    },
    {
      key: 'route', label: t('transfersReport.route'),
      render: i => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-gray-500 dark:text-gray-400">
          {whName.get(i.stock_transfers?.from_warehouse_id ?? '') ?? '—'}
          <ArrowRight className="h-3 w-3" />
          {whName.get(i.stock_transfers?.to_warehouse_id ?? '') ?? '—'}
        </span>
      ),
      sortValue: i => routeOf(i),
    },
    { key: 'qty', label: t('transfersReport.qty'), align: 'right', render: i => i.quantity, sortValue: i => Number(i.quantity), footer: totals.qty },
    { key: 'value', label: t('transfersReport.value'), align: 'right', render: i => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(value(i))}</span>, sortValue: i => value(i), footer: formatPrice(totals.value) },
  ]

  function exportCsv() {
    if (dim === 'list') {
      downloadCsv('peremeshenie_royxat', [t('kirimReport.date'), t('transfers.number'), t('reportsKit.product'), t('kirimReport.variant'), t('transfers.from'), t('transfers.to'), t('transfersReport.qty'), t('transfersReport.value')],
        [...items].sort((a, b) => dateOf(b).localeCompare(dateOf(a))).map(i => [
          dateOf(i), i.stock_transfers?.number ?? '', i.product_name, [i.color, i.size].filter(Boolean).join(' / '),
          whName.get(i.stock_transfers?.from_warehouse_id ?? '') ?? '', whName.get(i.stock_transfers?.to_warehouse_id ?? '') ?? '',
          i.quantity, Math.round(value(i)),
        ]))
      return
    }
    downloadCsv(`peremeshenie_${dim}`, [dimLabel[dim], t('transfersReport.transfers'), t('transfersReport.qty'), t('transfersReport.value')],
      [...groups].sort((a, b) => b.qty - a.qty).map(g => [g.name, g.transfers, g.qty, Math.round(g.value)]))
  }

  const axisColor = isDark ? '#A1A1AA' : '#6B7280'
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : '#E5E7EB'

  return (
    <div className="space-y-6">
      <ReportHeader title={t('transfersReport.title')} subtitle={t('transfersReport.subtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')} showBranch>
        <div className="ml-auto inline-flex flex-wrap rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          {(['product', 'route', 'date', 'list'] as const).map(d => (
            <button key={d} onClick={() => setDim(d)} className={segBtnCls(dim === d)}>{dimLabel[d]}</button>
          ))}
        </div>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('transfersReport.transfers'), value: String(totals.transfers), icon: ArrowLeftRight },
        { label: t('transfersReport.qty'), value: String(totals.qty), icon: Boxes },
        { label: t('transfersReport.products'), value: String(totals.products), icon: Layers },
        { label: t('transfersReport.value'), value: formatPrice(totals.value), icon: Wallet },
      ]} />

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        <p className="mb-3 text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('transfersReport.chartTitle')}</p>
        {chartData.length === 0 ? (
          <div className="flex h-56 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('reportsKit.empty')}</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
              <Tooltip
                cursor={{ fill: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}
                contentStyle={{ background: isDark ? '#111827' : '#fff', border: `1px solid ${isDark ? '#374151' : '#E5E7EB'}`, borderRadius: 8, fontSize: 12 }}
                formatter={v => [String(v), t('transfersReport.qty')]}
              />
              <Bar dataKey="qty" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {dim === 'list' ? (
        <ReportTable key="list" rows={items} columns={listColumns} rowKey={i => i.id} loading={loading} emptyText={t('reportsKit.empty')} initialSort={{ key: 'date', dir: 'desc' }} />
      ) : (
        <ReportTable key={dim} rows={groups} columns={groupColumns} rowKey={g => g.key} loading={loading} emptyText={t('reportsKit.empty')} initialSort={dim === 'date' ? { key: 'name', dir: 'desc' } : { key: 'qty', dir: 'desc' }} />
      )}
    </div>
  )
}
