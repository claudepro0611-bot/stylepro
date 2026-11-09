'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { Package, Receipt, ShoppingBag, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useBranchFilter } from '@/lib/session/useBranch'
import { bucketGranularity, buildBuckets, bucketKey, bucketLabel } from '@/lib/reports/period'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { KpiGrid, ReportHeader, ReportTable, downloadCsv, monthToDate, segBtnCls, type ReportColumn } from '@/components/reports/ReportKit'

interface TxnRow {
  id: string
  date: string
  net_amount: number
  payment_method: string | null
  cashier_name: string | null
}

interface ItemRow {
  id: string
  transaction_id: string
  product_id: string | null
  product_name: string | null
  quantity: number
  returned_quantity: number
  price: number
  transactions: { date: string; status: string } | null
}

type Dim = 'product' | 'category' | 'cashier' | 'payment'

interface SalesRow {
  key: string
  name: string
  sub?: string
  receipts: number
  qty: number
  revenue: number
  share: number
}

export default function SalesReportPage() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [dim, setDim] = useState<Dim>('product')
  const [loading, setLoading] = useState(true)
  const [txns, setTxns] = useState<TxnRow[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [categories, setCategories] = useState<Map<string, string>>(new Map())
  const applyBranch = useBranchFilter()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const [txnRes, itemRes, productRes] = await Promise.all([
        fetchAllRows<TxnRow>((from, to) => {
          let q = applyBranch(supabase.from('transactions_net').select('id, date, net_amount, payment_method, cashier_name').eq('status', 'completed'))
          if (range) q = q.gte('date', range.from).lte('date', range.to)
          return q.order('id').range(from, to) as unknown as PromiseLike<{ data: TxnRow[] | null; error: unknown }>
        }),
        fetchAllRows<ItemRow>((from, to) => {
          let q = applyBranch(supabase.from('transaction_items')
            .select('id, transaction_id, product_id, product_name, quantity, returned_quantity, price, transactions!inner(date, status)')
            .eq('transactions.status', 'completed'))
          if (range) q = q.gte('transactions.date', range.from).lte('transactions.date', range.to)
          return q.order('id').range(from, to) as unknown as PromiseLike<{ data: ItemRow[] | null; error: unknown }>
        }),
        fetchAllRows<{ id: string; category: string | null }>((from, to) =>
          supabase.from('products').select('id, category').order('id').range(from, to)),
      ])
      if (cancelled) return
      setTxns(txnRes.data)
      setItems(itemRes.data)
      setCategories(new Map(productRes.data.map(p => [p.id, p.category ?? '—'])))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, applyBranch])

  const totals = useMemo(() => {
    const revenue = txns.reduce((s, x) => s + Number(x.net_amount), 0)
    const receipts = txns.filter(x => Number(x.net_amount) > 0).length
    const qty = items.reduce((s, i) => s + Math.max(0, i.quantity - (i.returned_quantity ?? 0)), 0)
    return { revenue, receipts, qty, avg: receipts > 0 ? revenue / receipts : 0 }
  }, [txns, items])

  const rows = useMemo<SalesRow[]>(() => {
    const map = new Map<string, SalesRow & { txnSet: Set<string> }>()
    const touch = (key: string, name: string, sub?: string) => {
      let r = map.get(key)
      if (!r) { r = { key, name, sub, receipts: 0, qty: 0, revenue: 0, share: 0, txnSet: new Set() }; map.set(key, r) }
      return r
    }
    if (dim === 'product' || dim === 'category') {
      for (const it of items) {
        const qty = Math.max(0, it.quantity - (it.returned_quantity ?? 0))
        if (qty <= 0) continue
        const category = (it.product_id && categories.get(it.product_id)) || '—'
        const r = dim === 'product'
          ? touch(it.product_id ?? it.product_name ?? '—', it.product_name ?? '—', category)
          : touch(category, category)
        r.qty += qty
        r.revenue += Number(it.price) * qty
        r.txnSet.add(it.transaction_id)
      }
    } else {
      const qtyByTxn = new Map<string, number>()
      for (const it of items) qtyByTxn.set(it.transaction_id, (qtyByTxn.get(it.transaction_id) ?? 0) + Math.max(0, it.quantity - (it.returned_quantity ?? 0)))
      for (const x of txns) {
        const name = dim === 'cashier' ? (x.cashier_name || '—') : (x.payment_method || '—')
        const r = touch(name, name)
        r.revenue += Number(x.net_amount)
        r.qty += qtyByTxn.get(x.id) ?? 0
        if (Number(x.net_amount) > 0) r.txnSet.add(x.id)
      }
    }
    const sum = Array.from(map.values()).reduce((s, r) => s + r.revenue, 0)
    return Array.from(map.values()).map(({ txnSet, ...r }) => ({ ...r, receipts: txnSet.size, share: sum > 0 ? (r.revenue / sum) * 100 : 0 }))
  }, [items, txns, categories, dim])

  // Daily (or weekly for long ranges) net revenue.
  const chartData = useMemo(() => {
    const dates = txns.map(x => x.date).sort()
    const from = range?.from ?? dates[0]
    const to = range?.to ?? dates[dates.length - 1]
    if (!from || !to) return []
    const gran = bucketGranularity(from, to)
    const buckets = buildBuckets(from, to, gran)
    const map = new Map(buckets.map(b => [b, 0]))
    for (const x of txns) {
      const k = bucketKey(x.date, from, gran)
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + Number(x.net_amount))
    }
    return buckets.map(b => ({ label: bucketLabel(b), revenue: map.get(b) ?? 0 }))
  }, [txns, range])

  const dimLabel: Record<Dim, string> = {
    product: t('reportsKit.product'),
    category: t('reportsKit.category'),
    cashier: t('salesReport.cashier'),
    payment: t('salesReport.payment'),
  }

  const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, '')}%`

  const columns: ReportColumn<SalesRow>[] = [
    {
      key: 'name', label: dimLabel[dim],
      render: r => (
        <div>
          <p className="text-gray-900 dark:text-gray-100">{r.name}</p>
          {r.sub && <p className="text-xs text-gray-400 dark:text-gray-500">{r.sub}</p>}
        </div>
      ),
      sortValue: r => r.name, footer: t('reportsKit.total'),
    },
    { key: 'receipts', label: t('salesReport.receipts'), align: 'right', render: r => r.receipts, sortValue: r => r.receipts, footer: dim === 'cashier' || dim === 'payment' ? totals.receipts : undefined },
    { key: 'qty', label: t('reportsKit.qty'), align: 'right', render: r => r.qty, sortValue: r => r.qty, footer: totals.qty },
    { key: 'revenue', label: t('salesReport.revenue'), align: 'right', render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.revenue)}</span>, sortValue: r => r.revenue, footer: formatPrice(rows.reduce((s, r) => s + r.revenue, 0)) },
    {
      key: 'share', label: t('salesReport.share'), align: 'right',
      render: r => (
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-16 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div className="h-full rounded-full bg-gray-900 dark:bg-gray-100" style={{ width: `${Math.min(100, r.share)}%` }} />
          </div>
          <span className="w-12 text-gray-500 dark:text-gray-400">{pct(r.share)}</span>
        </div>
      ),
      sortValue: r => r.share,
    },
  ]

  function exportCsv() {
    downloadCsv(`sotuvlar_${dim}`, [dimLabel[dim], t('salesReport.receipts'), t('reportsKit.qty'), t('salesReport.revenue'), t('salesReport.share')],
      [...rows].sort((a, b) => b.revenue - a.revenue).map(r => [r.name, r.receipts, r.qty, Math.round(r.revenue), r.share.toFixed(1)]))
  }

  const axisColor = isDark ? '#A1A1AA' : '#6B7280'
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : '#E5E7EB'

  return (
    <div className="space-y-6">
      <ReportHeader title={t('salesReport.title')} subtitle={t('salesReport.subtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')} showBranch>
        <div className="ml-auto inline-flex flex-wrap rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          {(['product', 'category', 'cashier', 'payment'] as const).map(d => (
            <button key={d} onClick={() => setDim(d)} className={segBtnCls(dim === d)}>{dimLabel[d]}</button>
          ))}
        </div>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('salesReport.receipts'), value: String(totals.receipts), icon: Receipt },
        { label: t('salesReport.itemsSold'), value: String(totals.qty), icon: Package },
        { label: t('salesReport.revenue'), value: formatPrice(totals.revenue), icon: Wallet },
        { label: t('salesReport.avgReceipt'), value: formatPrice(Math.round(totals.avg)), icon: ShoppingBag },
      ]} />

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5">
        <p className="mb-3 text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('salesReport.chartTitle')}</p>
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
                formatter={v => [formatPrice(Number(v)), t('salesReport.revenue')]}
              />
              <Bar dataKey="revenue" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={32} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <ReportTable
        key={dim}
        rows={rows}
        columns={columns}
        rowKey={r => r.key}
        loading={loading}
        emptyText={t('reportsKit.empty')}
        initialSort={{ key: 'revenue', dir: 'desc' }}
      />
    </div>
  )
}
