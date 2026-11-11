'use client'

// Sotuv hisoboti: net wholesale sales (posted sales minus posted returns,
// prod_sales_lines_v) by product, by customer or by day: quantity, revenue
// (without VAT), VAT, COGS, margin, margin %. Cost and margin are shown to
// owner / admin only. Route guard: proxy.ts ('prod_stock' + 'prod_sales').

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Banknote, Percent, Receipt, Undo2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { ReportHeader, ReportTable, monthToDate, type ReportColumn } from '@/components/reports/ReportKit'
import { BackLink, Segmented } from '@/components/production/ProdKit'
import { FilterSelect, ProdKpiGrid } from '@/components/production/ReportKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useProdCustomers, useSalesAvailable, useSeesMargin } from '@/components/production/SalesKit'
import { formatQty, rangeToIsoBounds, round2, round3, unitKey } from '@/lib/production'
import { formatMarginPct, marginPct } from '@/lib/sales'
import { downloadXlsx, x2, x3, ymdOf } from '@/lib/production-reports'

type Mode = 'product' | 'customer' | 'day'

interface LineRow {
  row_kind: string | null; doc_date: string | null; customer_id: string | null; customer_name: string | null; warehouse_id: string | null
  item_id: string | null; item_name: string | null; item_unit: string | null; group_id: string | null; sale_id: string | null; return_id: string | null
  qty: number | null; amount: number | null; vat_amount: number | null; total: number | null; cost: number | null; margin: number | null
}

interface Agg {
  key: string
  label: string
  href: string | null
  unit: string | null
  qty: number
  returnedQty: number
  revenue: number
  returns: number
  vat: number
  total: number
  cost: number
  margin: number
  docs: number
}

const COLS = 'row_kind, doc_date, customer_id, customer_name, warehouse_id, item_id, item_name, item_unit, group_id, sale_id, return_id, qty, amount, vat_amount, total, cost, margin'

export default function SalesReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const available = useSalesAvailable()
  const seesMargin = useSeesMargin()
  const { warehouses, groups, itemById, loading: refsLoading } = useProdRefs()
  const { customers } = useProdCustomers()

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [mode, setMode] = useState<Mode>('product')
  const [warehouseId, setWarehouseId] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [lines, setLines] = useState<LineRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!available) return
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    fetchAllRows<LineRow>((from, to) => {
      let q = supabase.from('prod_sales_lines_v').select(COLS)
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      if (customerId) q = q.eq('customer_id', customerId)
      if (groupId) q = q.eq('group_id', groupId)
      return q.order('doc_date').order('sale_item_id').range(from, to)
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) toast.error(t('productionErrors.unknown'))
      setLines(data)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [available, range, warehouseId, customerId, groupId, t])

  const rows = useMemo<Agg[]>(() => {
    const m = new Map<string, Agg & { docSet: Set<string> }>()
    for (const l of lines) {
      const key = mode === 'product' ? l.item_id ?? '' : mode === 'customer' ? l.customer_id ?? '' : ymdOf(l.doc_date ?? '')
      let a = m.get(key)
      if (!a) {
        const item = l.item_id ? itemById.get(l.item_id) : undefined
        a = {
          key,
          label: mode === 'product' ? item?.name ?? l.item_name ?? '—' : mode === 'customer' ? l.customer_name ?? '—' : key,
          href: mode === 'customer' && l.customer_id ? `/zavod-mijozlar/${l.customer_id}` : null,
          unit: mode === 'product' ? item?.unit ?? l.item_unit : null,
          qty: 0, returnedQty: 0, revenue: 0, returns: 0, vat: 0, total: 0, cost: 0, margin: 0, docs: 0, docSet: new Set(),
        }
        m.set(key, a)
      }
      const isReturn = l.row_kind === 'return'
      const qty = Number(l.qty ?? 0)
      const amount = Number(l.amount ?? 0)
      if (isReturn) { a.returnedQty += -qty; a.returns += -amount } else if (l.sale_id) a.docSet.add(l.sale_id)
      a.qty += qty
      a.revenue += amount
      a.vat += Number(l.vat_amount ?? 0)
      a.total += Number(l.total ?? 0)
      a.cost += Number(l.cost ?? 0)
      a.margin += Number(l.margin ?? 0)
    }
    return [...m.values()].map(({ docSet, ...a }) => ({
      ...a, docs: docSet.size, qty: round3(a.qty), returnedQty: round3(a.returnedQty), revenue: round2(a.revenue), returns: round2(a.returns),
      vat: round2(a.vat), total: round2(a.total), cost: round2(a.cost), margin: round2(a.margin),
    }))
  }, [lines, mode, itemById])

  const sum = useMemo(() => rows.reduce((s, r) => ({
    revenue: s.revenue + r.revenue, returns: s.returns + r.returns, vat: s.vat + r.vat, total: s.total + r.total, cost: s.cost + r.cost, margin: s.margin + r.margin,
  }), { revenue: 0, returns: 0, vat: 0, total: 0, cost: 0, margin: 0 }), [rows])
  const saleCount = useMemo(() => new Set(lines.filter(l => l.row_kind !== 'return' && l.sale_id).map(l => l.sale_id)).size, [lines])

  const keyLabel = mode === 'product' ? t('production.common.item') : mode === 'customer' ? t('prodSales.common.customer') : t('production.common.date')

  const columns: ReportColumn<Agg>[] = [
    {
      key: 'label', label: keyLabel, sortValue: r => (mode === 'day' ? r.key : r.label),
      render: r => r.href
        ? <Link href={r.href} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">{r.label}</Link>
        : <span className="text-gray-900 dark:text-gray-100">{mode === 'day' ? formatDate(r.key) : r.label}</span>,
      footer: t('production.common.total'),
    },
    ...(mode === 'product' ? [{
      key: 'qty', label: t('prodSales.reports.netQty'), align: 'right' as const, sortValue: (r: Agg) => r.qty,
      render: (r: Agg) => (
        <span className="text-gray-900 dark:text-gray-100">
          {formatQty(r.qty)} {r.unit ? t(unitKey(r.unit)) : ''}
          {r.returnedQty > 0 && <span className="ml-1 text-[11px] text-gray-400 dark:text-gray-500">(−{formatQty(r.returnedQty)})</span>}
        </span>
      ),
    }] : [{
      key: 'docs', label: t('prodSales.reports.docs'), align: 'right' as const, sortValue: (r: Agg) => r.docs,
      render: (r: Agg) => <span className="text-gray-700 dark:text-gray-300">{r.docs}</span>,
      footer: String(saleCount),
    }]),
    {
      key: 'revenue', label: t('prodSales.reports.revenue'), align: 'right', sortValue: r => r.revenue,
      render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.revenue)}</span>,
      footer: formatPrice(sum.revenue),
    },
    {
      key: 'returns', label: t('prodSales.reports.returns'), align: 'right', sortValue: r => r.returns,
      render: r => <span className="text-gray-500 dark:text-gray-400">{r.returns ? formatPrice(r.returns) : '—'}</span>,
      footer: formatPrice(sum.returns),
    },
    {
      key: 'vat', label: t('prodSales.common.vat'), align: 'right', sortValue: r => r.vat,
      render: r => <span className="text-gray-500 dark:text-gray-400">{formatPrice(r.vat)}</span>,
      footer: formatPrice(sum.vat),
    },
    ...(seesMargin ? [
      {
        key: 'cost', label: t('prodSales.reports.cogs'), align: 'right' as const, sortValue: (r: Agg) => r.cost,
        render: (r: Agg) => <span className="text-gray-500 dark:text-gray-400">{formatPrice(r.cost)}</span>,
        footer: formatPrice(sum.cost),
      },
      {
        key: 'margin', label: t('prodSales.common.margin'), align: 'right' as const, sortValue: (r: Agg) => r.margin,
        render: (r: Agg) => <span className={r.margin < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}>{formatPrice(r.margin)}</span>,
        footer: formatPrice(sum.margin),
      },
      {
        key: 'marginPct', label: t('prodSales.common.marginPct'), align: 'right' as const, sortValue: (r: Agg) => marginPct(r.margin, r.revenue) ?? -1e9,
        render: (r: Agg) => <span className="text-gray-500 dark:text-gray-400">{formatMarginPct(marginPct(r.margin, r.revenue))}</span>,
        footer: formatMarginPct(marginPct(sum.margin, sum.revenue)),
      },
    ] : []),
  ]

  function exportXlsx() {
    downloadXlsx(`sotuv_${mode}`, [
      keyLabel, ...(mode === 'product' ? [t('prodSales.reports.netQty'), t('production.common.unit')] : [t('prodSales.reports.docs')]),
      `${t('prodSales.reports.revenue')} (UZS)`, `${t('prodSales.reports.returns')} (UZS)`, `${t('prodSales.common.vat')} (UZS)`, `${t('prodSales.common.totalWithVat')} (UZS)`,
      ...(seesMargin ? [`${t('prodSales.reports.cogs')} (UZS)`, `${t('prodSales.common.margin')} (UZS)`, t('prodSales.common.marginPct')] : []),
    ], rows.map(r => [
      mode === 'day' ? r.key : r.label,
      ...(mode === 'product' ? [x3(r.qty), r.unit ? t(unitKey(r.unit)) : ''] : [r.docs]),
      x2(r.revenue), x2(r.returns), x2(r.vat), x2(r.total),
      ...(seesMargin ? [x2(r.cost), x2(r.margin), (() => { const p = marginPct(r.margin, r.revenue); return p === null ? '' : Math.round(p * 10) / 10 })()] : []),
    ]), t('prodSales.reports.salesTitle'))
  }

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
        <NotAvailableNote />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodSales.reports.salesTitle')}
        subtitle={t('prodSales.reports.salesSubtitle')}
        range={range}
        onRangeChange={setRange}
        onExport={rows.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
        <FilterSelect value={warehouseId} onChange={setWarehouseId} className="w-44">
          <option value="">{t('production.common.allWarehouses')}</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </FilterSelect>
        <FilterSelect value={customerId} onChange={setCustomerId}>
          <option value="">{t('prodSales.common.allCustomers')}</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </FilterSelect>
        <FilterSelect value={groupId} onChange={setGroupId} className="w-44">
          <option value="">{t('prodReports.common.allGroups')}</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </FilterSelect>
        <Segmented
          className="ml-auto"
          options={[
            { value: 'product' as const, label: t('prodSales.reports.byProduct') },
            { value: 'customer' as const, label: t('prodSales.reports.byCustomer') },
            { value: 'day' as const, label: t('prodSales.reports.byDay') },
          ]}
          value={mode}
          onChange={setMode}
        />
      </ReportHeader>

      <ProdKpiGrid items={[
        { label: t('prodSales.reports.revenue'), value: formatPrice(sum.revenue), sub: `${saleCount} ${t('prodSales.reports.docsLower')}`, icon: Receipt },
        { label: t('prodSales.reports.returns'), value: formatPrice(sum.returns), icon: Undo2, tone: sum.returns > 0 ? 'warning' : undefined },
        { label: t('prodSales.common.vat'), value: formatPrice(sum.vat), sub: `${t('prodSales.common.totalWithVat')}: ${formatPrice(sum.total)}`, icon: Banknote },
        seesMargin
          ? { label: t('prodSales.common.margin'), value: formatPrice(sum.margin), sub: `${t('prodSales.reports.cogs')}: ${formatPrice(sum.cost)} · ${formatMarginPct(marginPct(sum.margin, sum.revenue))}`, icon: Percent, tone: sum.margin < 0 ? 'negative' : undefined }
          : { label: t('prodSales.common.totalWithVat'), value: formatPrice(sum.total), icon: Percent },
      ]} />

      <ReportTable
        key={mode}
        rows={rows}
        columns={columns}
        rowKey={r => r.key}
        loading={loading || refsLoading || available === null}
        emptyText={t('prodReports.common.empty')}
        initialSort={mode === 'day' ? { key: 'label', dir: 'desc' } : { key: 'revenue', dir: 'desc' }}
        pageSize={50}
      />
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodSales.reports.salesNote')}</p>
    </div>
  )
}
