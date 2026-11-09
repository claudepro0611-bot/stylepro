'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Calculator, Receipt, Tags, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useBranchFilter } from '@/lib/session/useBranch'
import { formatDate } from '@/lib/utils/formatters'
import { bucketGranularity, buildBuckets, bucketKey, bucketLabel } from '@/lib/reports/period'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { KpiGrid, ReportHeader, ReportTable, downloadCsv, monthToDate, segBtnCls, type ReportColumn } from '@/components/reports/ReportKit'

interface ExpenseRow {
  id: string
  amount: number
  payment_method: string
  date: string
  note: string | null
  category_id: string | null
  expense_categories: { name: string; color: string | null } | null
}

type Dim = 'category' | 'payment' | 'date' | 'list'

interface GroupRow {
  key: string
  name: string
  color?: string | null
  count: number
  amount: number
}

export default function ExpensesReportPage() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [dim, setDim] = useState<Dim>('category')
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<ExpenseRow[]>([])
  const applyBranch = useBranchFilter()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const { data } = await fetchAllRows<ExpenseRow>((from, to) => {
        let q = applyBranch(supabase.from('expenses')
          .select('id, amount, payment_method, date, note, category_id, expense_categories(name, color)'))
        if (range) q = q.gte('date', range.from).lte('date', `${range.to}T23:59:59`)
        return q.order('id').range(from, to) as unknown as PromiseLike<{ data: ExpenseRow[] | null; error: unknown }>
      })
      if (cancelled) return
      setRows(data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, applyBranch])

  const categoryOf = (e: ExpenseRow) => e.expense_categories?.name || t('expensesReport.uncategorized')
  const paymentOf = (m: string) => {
    if (m === 'cash') return t('expensesReport.cash')
    if (m === 'card') return t('expensesReport.card')
    if (m === 'transfer') return t('expensesReport.transfer')
    return m || '—'
  }

  const groups = useMemo<GroupRow[]>(() => {
    if (dim === 'list') return []
    const map = new Map<string, GroupRow>()
    for (const e of rows) {
      let key: string, name: string, color: string | null | undefined
      if (dim === 'category') { key = e.category_id ?? '—'; name = e.expense_categories?.name || t('expensesReport.uncategorized'); color = e.expense_categories?.color }
      else if (dim === 'payment') { key = e.payment_method; name = paymentOf(e.payment_method) }
      else { key = e.date.slice(0, 10); name = formatDate(key) }
      const g = map.get(key) ?? { key, name, color, count: 0, amount: 0 }
      g.count += 1
      g.amount += Number(e.amount)
      map.set(key, g)
    }
    return Array.from(map.values())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dim, t])

  const totals = useMemo(() => {
    const amount = rows.reduce((s, e) => s + Number(e.amount), 0)
    const byCat = new Map<string, { name: string; amount: number }>()
    for (const e of rows) {
      const k = e.category_id ?? '—'
      const c = byCat.get(k) ?? { name: e.expense_categories?.name || t('expensesReport.uncategorized'), amount: 0 }
      c.amount += Number(e.amount)
      byCat.set(k, c)
    }
    const top = [...byCat.values()].sort((a, b) => b.amount - a.amount)[0]
    return { count: rows.length, amount, avg: rows.length ? amount / rows.length : 0, top }
  }, [rows, t])

  const chartData = useMemo(() => {
    const dates = rows.map(e => e.date.slice(0, 10)).sort()
    const from = range?.from ?? dates[0]
    const to = range?.to ?? dates[dates.length - 1]
    if (!from || !to) return []
    const gran = bucketGranularity(from, to)
    const buckets = buildBuckets(from, to, gran)
    const map = new Map(buckets.map(b => [b, 0]))
    for (const e of rows) {
      const k = bucketKey(e.date.slice(0, 10), from, gran)
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + Number(e.amount))
    }
    return buckets.map(b => ({ label: bucketLabel(b), amount: map.get(b) ?? 0 }))
  }, [rows, range])

  const pct = (n: number) => `${(totals.amount > 0 ? (n / totals.amount) * 100 : 0).toFixed(1).replace(/\.0$/, '')}%`

  const dimLabel: Record<Dim, string> = {
    category: t('expensesReport.category'),
    payment: t('expensesReport.payment'),
    date: t('kirimReport.date'),
    list: t('kirimReport.list'),
  }

  const groupColumns: ReportColumn<GroupRow>[] = [
    {
      key: 'name', label: dimLabel[dim],
      render: g => (
        <div className="flex items-center gap-2">
          {dim === 'category' && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g.color || '#9ca3af' }} />}
          <span className="text-gray-900 dark:text-gray-100">{g.name}</span>
        </div>
      ),
      sortValue: g => (dim === 'date' ? g.key : g.name), footer: t('reportsKit.total'),
    },
    { key: 'count', label: t('expensesReport.count'), align: 'right', render: g => g.count, sortValue: g => g.count, footer: totals.count },
    { key: 'amount', label: t('expensesReport.amount'), align: 'right', render: g => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(g.amount)}</span>, sortValue: g => g.amount, footer: formatPrice(totals.amount) },
    { key: 'share', label: t('writeoffReport.share'), align: 'right', render: g => pct(g.amount), sortValue: g => g.amount },
  ]

  const listColumns: ReportColumn<ExpenseRow>[] = [
    { key: 'date', label: t('kirimReport.date'), render: e => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(e.date.slice(0, 10))}</span>, sortValue: e => e.date, footer: t('reportsKit.total') },
    {
      key: 'category', label: t('expensesReport.category'),
      render: e => (
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.expense_categories?.color || '#9ca3af' }} />
          <span className="text-gray-900 dark:text-gray-100">{categoryOf(e)}</span>
        </div>
      ),
      sortValue: e => categoryOf(e),
    },
    { key: 'payment', label: t('expensesReport.payment'), render: e => <span className="text-gray-500 dark:text-gray-400">{paymentOf(e.payment_method)}</span>, sortValue: e => e.payment_method },
    { key: 'note', label: t('expensesReport.note'), render: e => <span className="text-gray-500 dark:text-gray-400">{e.note?.trim() || '—'}</span> },
    { key: 'amount', label: t('expensesReport.amount'), align: 'right', render: e => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(e.amount))}</span>, sortValue: e => Number(e.amount), footer: formatPrice(totals.amount) },
  ]

  function exportCsv() {
    if (dim === 'list') {
      downloadCsv('xarajatlar_royxat', [t('kirimReport.date'), t('expensesReport.category'), t('expensesReport.payment'), t('expensesReport.note'), t('expensesReport.amount')],
        [...rows].sort((a, b) => b.date.localeCompare(a.date)).map(e => [e.date.slice(0, 10), categoryOf(e), paymentOf(e.payment_method), e.note ?? '', Number(e.amount)]))
      return
    }
    downloadCsv(`xarajatlar_${dim}`, [dimLabel[dim], t('expensesReport.count'), t('expensesReport.amount')],
      [...groups].sort((a, b) => b.amount - a.amount).map(g => [g.name, g.count, Math.round(g.amount)]))
  }

  const axisColor = isDark ? '#A1A1AA' : '#6B7280'
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : '#E5E7EB'

  return (
    <div className="space-y-6">
      <ReportHeader title={t('expensesReport.title')} subtitle={t('expensesReport.subtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')} showBranch>
        <div className="ml-auto inline-flex flex-wrap rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          {(['category', 'payment', 'date', 'list'] as const).map(d => (
            <button key={d} onClick={() => setDim(d)} className={segBtnCls(dim === d)}>{dimLabel[d]}</button>
          ))}
        </div>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('expensesReport.amount'), value: formatPrice(totals.amount), icon: Wallet },
        { label: t('expensesReport.count'), value: String(totals.count), icon: Receipt },
        { label: t('expensesReport.avg'), value: formatPrice(totals.avg), icon: Calculator },
        { label: `${t('expensesReport.topCategory')}${totals.top ? ` · ${totals.top.name}` : ''}`, value: totals.top ? formatPrice(totals.top.amount) : '—', icon: Tags },
      ]} />

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        <p className="mb-3 text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('expensesReport.chartTitle')}</p>
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
                formatter={v => [formatPrice(Number(v)), t('expensesReport.amount')]}
              />
              <Bar dataKey="amount" fill="#f59e0b" radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {dim === 'list' ? (
        <ReportTable key="list" rows={rows} columns={listColumns} rowKey={e => e.id} loading={loading} emptyText={t('reportsKit.empty')} initialSort={{ key: 'date', dir: 'desc' }} />
      ) : (
        <ReportTable key={dim} rows={groups} columns={groupColumns} rowKey={g => g.key} loading={loading} emptyText={t('reportsKit.empty')} initialSort={dim === 'date' ? { key: 'name', dir: 'desc' } : { key: 'amount', dir: 'desc' }} />
      )}
    </div>
  )
}
