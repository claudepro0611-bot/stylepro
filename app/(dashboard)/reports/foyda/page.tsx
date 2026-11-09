'use client'

import { useEffect, useMemo, useState } from 'react'
import { Coins, Percent, ShoppingBag, TrendingUp } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useBranchFilter } from '@/lib/session/useBranch'
import { cn } from '@/lib/utils'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { KpiGrid, ReportHeader, ReportTable, downloadCsv, monthToDate, segBtnCls, type ReportColumn } from '@/components/reports/ReportKit'

interface ItemRow {
  id: string
  product_id: string | null
  product_name: string | null
  quantity: number
  returned_quantity: number
  price: number
  purchase_price: number | null
  transactions: { date: string; status: string } | null
}

interface ProfitRow {
  key: string
  name: string
  category: string
  qty: number
  revenue: number
  cost: number
  profit: number
  margin: number
}

type GroupBy = 'product' | 'category'

export default function ProfitReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [groupBy, setGroupBy] = useState<GroupBy>('product')
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<ItemRow[]>([])
  const [categories, setCategories] = useState<Map<string, string>>(new Map())
  const applyBranch = useBranchFilter()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const [itemsRes, productsRes] = await Promise.all([
        fetchAllRows<ItemRow>((from, to) => {
          // transaction_items.branch_id is a denormalized copy of its sale's branch.
          let q = applyBranch(supabase.from('transaction_items')
            .select('id, product_id, product_name, quantity, returned_quantity, price, purchase_price, transactions!inner(date, status)')
            .eq('transactions.status', 'completed'))
          if (range) q = q.gte('transactions.date', range.from).lte('transactions.date', range.to)
          return q.order('id').range(from, to) as unknown as PromiseLike<{ data: ItemRow[] | null; error: unknown }>
        }),
        fetchAllRows<{ id: string; category: string | null }>((from, to) =>
          supabase.from('products').select('id, category').order('id').range(from, to)),
      ])
      if (cancelled) return
      setItems(itemsRes.data)
      setCategories(new Map(productsRes.data.map(p => [p.id, p.category ?? '—'])))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, applyBranch])

  const rows = useMemo<ProfitRow[]>(() => {
    const map = new Map<string, ProfitRow>()
    for (const it of items) {
      const qty = Math.max(0, it.quantity - (it.returned_quantity ?? 0))
      if (qty <= 0) continue
      const category = (it.product_id && categories.get(it.product_id)) || '—'
      const key = groupBy === 'product' ? (it.product_id ?? it.product_name ?? '—') : category
      let r = map.get(key)
      if (!r) {
        r = { key, name: groupBy === 'product' ? (it.product_name ?? '—') : category, category, qty: 0, revenue: 0, cost: 0, profit: 0, margin: 0 }
        map.set(key, r)
      }
      r.qty += qty
      r.revenue += Number(it.price) * qty
      r.cost += Number(it.purchase_price ?? 0) * qty
    }
    for (const r of map.values()) {
      r.profit = r.revenue - r.cost
      r.margin = r.revenue > 0 ? (r.profit / r.revenue) * 100 : 0
    }
    return Array.from(map.values())
  }, [items, categories, groupBy])

  const totals = useMemo(() => {
    const revenue = rows.reduce((s, r) => s + r.revenue, 0)
    const cost = rows.reduce((s, r) => s + r.cost, 0)
    const qty = rows.reduce((s, r) => s + r.qty, 0)
    return { revenue, cost, qty, profit: revenue - cost, margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0 }
  }, [rows])

  const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, '')}%`

  const columns: ReportColumn<ProfitRow>[] = [
    {
      key: 'name', label: groupBy === 'product' ? t('reportsKit.product') : t('reportsKit.category'),
      render: r => (
        <div>
          <p className="text-gray-900 dark:text-gray-100">{r.name}</p>
          {groupBy === 'product' && <p className="text-xs text-gray-400 dark:text-gray-500">{r.category}</p>}
        </div>
      ),
      sortValue: r => r.name, footer: t('reportsKit.total'),
    },
    { key: 'qty', label: t('reportsKit.qty'), align: 'right', render: r => r.qty, sortValue: r => r.qty, footer: totals.qty },
    { key: 'revenue', label: t('profitReport.revenue'), align: 'right', render: r => formatPrice(r.revenue), sortValue: r => r.revenue, footer: formatPrice(totals.revenue) },
    { key: 'cost', label: t('profitReport.cost'), align: 'right', render: r => <span className="text-gray-500 dark:text-gray-400">{formatPrice(r.cost)}</span>, sortValue: r => r.cost, footer: formatPrice(totals.cost) },
    {
      key: 'profit', label: t('profitReport.profit'), align: 'right',
      render: r => <span className={cn('font-medium', r.profit < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>{formatPrice(r.profit)}</span>,
      sortValue: r => r.profit, footer: formatPrice(totals.profit),
    },
    {
      key: 'margin', label: t('profitReport.margin'), align: 'right',
      render: r => (
        <span className={cn('rounded-full px-2 py-0.5 text-xs',
          r.margin < 0 ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
            : r.margin < 15 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
              : 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400')}>
          {pct(r.margin)}
        </span>
      ),
      sortValue: r => r.margin, footer: pct(totals.margin),
    },
  ]

  function exportCsv() {
    downloadCsv('foyda', [groupBy === 'product' ? t('reportsKit.product') : t('reportsKit.category'), t('reportsKit.qty'), t('profitReport.revenue'), t('profitReport.cost'), t('profitReport.profit'), t('profitReport.margin')],
      [...rows].sort((a, b) => b.profit - a.profit).map(r => [r.name, r.qty, Math.round(r.revenue), Math.round(r.cost), Math.round(r.profit), r.margin.toFixed(1)]))
  }

  return (
    <div className="space-y-6">
      <ReportHeader title={t('profitReport.title')} subtitle={t('profitReport.subtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')} showBranch>
        <div className="ml-auto inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          <button onClick={() => setGroupBy('product')} className={segBtnCls(groupBy === 'product')}>{t('reportsKit.byProduct')}</button>
          <button onClick={() => setGroupBy('category')} className={segBtnCls(groupBy === 'category')}>{t('reportsKit.byCategory')}</button>
        </div>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('profitReport.revenue'), value: formatPrice(totals.revenue), icon: ShoppingBag },
        { label: t('profitReport.cost'), value: formatPrice(totals.cost), icon: Coins },
        { label: t('profitReport.profit'), value: formatPrice(totals.profit), icon: TrendingUp, tone: totals.profit < 0 ? 'negative' : 'positive' },
        { label: t('profitReport.margin'), value: pct(totals.margin), icon: Percent },
      ]} />

      <p className="-mt-2 text-[12px] text-gray-400 dark:text-gray-500">{t('profitReport.note')}</p>

      <ReportTable
        key={groupBy}
        rows={rows}
        columns={columns}
        rowKey={r => r.key}
        loading={loading}
        emptyText={t('reportsKit.empty')}
        initialSort={{ key: 'profit', dir: 'desc' }}
      />
    </div>
  )
}
