'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Boxes, FileX, Layers, Wallet } from 'lucide-react'
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
  note: string | null
  date: string
  product_size_id: string | null
}

type Dim = 'product' | 'category' | 'reason' | 'date' | 'list'

interface GroupRow {
  key: string
  name: string
  sub?: string
  entries: number
  qty: number
  loss: number
}

export default function WriteoffReportPage() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [dim, setDim] = useState<Dim>('product')
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [costOf, setCostOf] = useState<Map<string, number>>(new Map())
  const applyBranch = useBranchFilter()

  // Variant → purchase price. Write-offs are valued at cost (what the shop
  // actually lost), same as the brak line in the financial report.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const { data } = await fetchAllRows<{ id: string; purchase_price: number | null }>((from, to) =>
        supabase.from('product_sizes').select('id, purchase_price').order('id').range(from, to))
      if (cancelled) return
      setCostOf(new Map(data.map(s => [s.id, Number(s.purchase_price ?? 0)])))
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const { data } = await fetchAllRows<EntryRow>((from, to) => {
        let q = applyBranch(supabase.from('stock_out_entries')
          .select('id, product_id, product_name, category, size, color, quantity, note, date, product_size_id')
          .eq('entry_type', 'brak'))
        if (range) q = q.gte('date', range.from).lte('date', `${range.to}T23:59:59`)
        return q.order('id').range(from, to) as unknown as PromiseLike<{ data: EntryRow[] | null; error: unknown }>
      })
      if (cancelled) return
      setEntries(data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, applyBranch])

  const unitCost = (e: EntryRow) => (e.product_size_id ? costOf.get(e.product_size_id) ?? 0 : 0)
  const loss = (e: EntryRow) => Number(e.quantity) * unitCost(e)
  const reasonOf = (e: EntryRow) => e.note?.trim() || t('writeoffReport.noReason')

  const totals = useMemo(() => {
    const products = new Set(entries.map(e => e.product_id ?? e.product_name ?? ''))
    return {
      entries: entries.length,
      qty: entries.reduce((s, e) => s + Number(e.quantity), 0),
      loss: entries.reduce((s, e) => s + Number(e.quantity) * (e.product_size_id ? costOf.get(e.product_size_id) ?? 0 : 0), 0),
      products: products.size,
    }
  }, [entries, costOf])

  const groups = useMemo<GroupRow[]>(() => {
    if (dim === 'list') return []
    const map = new Map<string, GroupRow>()
    for (const e of entries) {
      let key: string, name: string, sub: string | undefined
      if (dim === 'product') { key = e.product_id ?? e.product_name ?? '—'; name = e.product_name ?? '—'; sub = e.category ?? undefined }
      else if (dim === 'category') { key = name = e.category || '—' }
      else if (dim === 'reason') { key = name = e.note?.trim() || t('writeoffReport.noReason') }
      else { key = e.date.slice(0, 10); name = formatDate(key) }
      const g = map.get(key) ?? { key, name, sub, entries: 0, qty: 0, loss: 0 }
      g.entries += 1
      g.qty += Number(e.quantity)
      g.loss += Number(e.quantity) * (e.product_size_id ? costOf.get(e.product_size_id) ?? 0 : 0)
      map.set(key, g)
    }
    return Array.from(map.values())
  }, [entries, dim, costOf, t])

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
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + Number(e.quantity) * (e.product_size_id ? costOf.get(e.product_size_id) ?? 0 : 0))
    }
    return buckets.map(b => ({ label: bucketLabel(b), loss: map.get(b) ?? 0 }))
  }, [entries, range, costOf])

  const dimLabel: Record<Dim, string> = {
    product: t('reportsKit.product'),
    category: t('reportsKit.category'),
    reason: t('writeoffReport.reason'),
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
    { key: 'entries', label: t('writeoffReport.entries'), align: 'right', render: g => g.entries, sortValue: g => g.entries, footer: totals.entries },
    { key: 'qty', label: t('writeoffReport.qty'), align: 'right', render: g => g.qty, sortValue: g => g.qty, footer: totals.qty },
    { key: 'loss', label: t('writeoffReport.loss'), align: 'right', render: g => <span className="font-medium text-red-600 dark:text-red-400">{formatPrice(g.loss)}</span>, sortValue: g => g.loss, footer: formatPrice(totals.loss) },
    { key: 'share', label: t('writeoffReport.share'), align: 'right', render: g => `${(totals.loss > 0 ? (g.loss / totals.loss) * 100 : 0).toFixed(1).replace(/\.0$/, '')}%`, sortValue: g => g.loss },
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
    { key: 'qty', label: t('writeoffReport.qty'), align: 'right', render: e => e.quantity, sortValue: e => Number(e.quantity), footer: totals.qty },
    { key: 'cost', label: t('kirimReport.purchasePrice'), align: 'right', render: e => <span className="text-gray-500 dark:text-gray-400">{formatPrice(unitCost(e))}</span>, sortValue: e => unitCost(e) },
    { key: 'loss', label: t('writeoffReport.loss'), align: 'right', render: e => <span className="font-medium text-red-600 dark:text-red-400">{formatPrice(loss(e))}</span>, sortValue: e => loss(e), footer: formatPrice(totals.loss) },
    { key: 'reason', label: t('writeoffReport.reason'), render: e => <span className="text-gray-500 dark:text-gray-400">{reasonOf(e)}</span>, sortValue: e => reasonOf(e) },
  ]

  function exportCsv() {
    if (dim === 'list') {
      downloadCsv('spisaniya_royxat', [t('kirimReport.date'), t('reportsKit.product'), t('kirimReport.variant'), t('writeoffReport.qty'), t('kirimReport.purchasePrice'), t('writeoffReport.loss'), t('writeoffReport.reason')],
        [...entries].sort((a, b) => b.date.localeCompare(a.date)).map(e => [e.date.slice(0, 10), e.product_name ?? '', [e.color, e.size].filter(Boolean).join(' / '), e.quantity, unitCost(e), Math.round(loss(e)), reasonOf(e)]))
      return
    }
    downloadCsv(`spisaniya_${dim}`, [dimLabel[dim], t('writeoffReport.entries'), t('writeoffReport.qty'), t('writeoffReport.loss')],
      [...groups].sort((a, b) => b.loss - a.loss).map(g => [g.name, g.entries, g.qty, Math.round(g.loss)]))
  }

  const axisColor = isDark ? '#A1A1AA' : '#6B7280'
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : '#E5E7EB'

  return (
    <div className="space-y-6">
      <ReportHeader title={t('writeoffReport.title')} subtitle={t('writeoffReport.subtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')} showBranch>
        <div className="ml-auto inline-flex flex-wrap rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          {(['product', 'category', 'reason', 'date', 'list'] as const).map(d => (
            <button key={d} onClick={() => setDim(d)} className={segBtnCls(dim === d)}>{dimLabel[d]}</button>
          ))}
        </div>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('writeoffReport.entries'), value: String(totals.entries), icon: FileX },
        { label: t('writeoffReport.qty'), value: String(totals.qty), icon: Boxes },
        { label: t('writeoffReport.products'), value: String(totals.products), icon: Layers },
        { label: t('writeoffReport.loss'), value: formatPrice(totals.loss), icon: Wallet, tone: totals.loss > 0 ? 'negative' : undefined },
      ]} />

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        <p className="mb-3 text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('writeoffReport.chartTitle')}</p>
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
                formatter={v => [formatPrice(Number(v)), t('writeoffReport.loss')]}
              />
              <Bar dataKey="loss" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {dim === 'list' ? (
        <ReportTable key="list" rows={entries} columns={listColumns} rowKey={e => e.id} loading={loading} emptyText={t('reportsKit.empty')} initialSort={{ key: 'date', dir: 'desc' }} />
      ) : (
        <ReportTable key={dim} rows={groups} columns={groupColumns} rowKey={g => g.key} loading={loading} emptyText={t('reportsKit.empty')} initialSort={dim === 'date' ? { key: 'name', dir: 'desc' } : { key: 'loss', dir: 'desc' }} />
      )}
    </div>
  )
}
