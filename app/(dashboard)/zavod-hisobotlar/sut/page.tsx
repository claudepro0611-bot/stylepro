'use client'

// Sut qabuli hisoboti: per day or per supplier - deliveries, received kg
// (accepted + conditional), kg-weighted fat / protein, amount, average price,
// conditional, rejected (count / kg) and lab-pending intakes.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Ban, Droplets, Milk, Wallet } from 'lucide-react'
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
import { useProdSuppliers } from '@/components/production/SupplierKit'
import { formatQty, rangeToIsoBounds } from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { MILK_INTAKE_COLS, aggregateMilk, downloadXlsx, x2, x3, ymdOf, type MilkAgg, type MilkIntakeLite } from '@/lib/production-reports'

type GroupBy = 'day' | 'supplier'

export default function MilkReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { suppliers } = useProdSuppliers()
  const supplierName = useMemo(() => new Map(suppliers.map(s => [s.id, s.name])), [suppliers])

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [groupBy, setGroupBy] = useState<GroupBy>('day')
  const [supplierId, setSupplierId] = useState('')
  const [rows, setRows] = useState<MilkIntakeLite[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    fetchAllRows<MilkIntakeLite>((from, to) => {
      let q = supabase.from('prod_milk_intakes').select(MILK_INTAKE_COLS).neq('status', 'cancelled')
      if (bounds) q = q.gte('intake_date', bounds.fromIso).lt('intake_date', bounds.toIso)
      if (supplierId) q = q.eq('supplier_id', supplierId)
      return q.order('intake_date').order('id').range(from, to)
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) toast.error(t('productionErrors.unknown'))
      setRows(data)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [range, supplierId, t])

  const groups = useMemo(() => aggregateMilk(rows, r => (groupBy === 'day' ? ymdOf(r.intake_date) : r.supplier_id)), [rows, groupBy])
  const total = useMemo(() => aggregateMilk(rows, () => 'all')[0] ?? null, [rows])

  const label = (g: MilkAgg) => (groupBy === 'day' ? formatDate(`${g.key}T00:00:00`) : supplierName.get(g.key) ?? '—')
  const kg = t('production.units.kg')
  const avgPrice = (g: MilkAgg) => (g.receivedKg > 0 ? g.amount / g.receivedKg : 0)

  const columns: ReportColumn<MilkAgg>[] = [
    {
      key: 'key', label: groupBy === 'day' ? t('production.common.date') : t('production.milk.supplier'),
      sortValue: g => (groupBy === 'day' ? g.key : label(g)),
      render: g => groupBy === 'supplier'
        ? <Link href={`/zavod-yetkazuvchilar/${g.key}`} className="font-medium text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">{label(g)}</Link>
        : <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{label(g)}</span>,
      footer: t('production.common.total'),
    },
    { key: 'count', label: t('prodReports.milk.deliveries'), align: 'right', sortValue: g => g.count, render: g => g.count, footer: total?.count ?? 0 },
    {
      key: 'kg', label: t('prodReports.milk.receivedKg'), align: 'right', sortValue: g => g.receivedKg,
      render: g => <span className="font-medium text-gray-900 dark:text-gray-100">{formatQty(g.receivedKg)} {kg}</span>,
      footer: `${formatQty(total?.receivedKg ?? 0)} ${kg}`,
    },
    { key: 'fat', label: t('production.milk.fat'), align: 'right', sortValue: g => g.fat ?? -1, render: g => formatPct(g.fat), footer: formatPct(total?.fat) },
    { key: 'protein', label: t('production.milk.protein'), align: 'right', sortValue: g => g.protein ?? -1, render: g => formatPct(g.protein), footer: formatPct(total?.protein) },
    {
      key: 'amount', label: t('production.milk.amount'), align: 'right', sortValue: g => g.amount,
      render: g => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(g.amount)}</span>,
      footer: formatPrice(total?.amount ?? 0),
    },
    { key: 'price', label: t('prodReports.milk.avgPrice'), align: 'right', sortValue: avgPrice, render: g => <span className="text-gray-500 dark:text-gray-400">{formatPrice(avgPrice(g))}</span>, footer: total ? formatPrice(avgPrice(total)) : '' },
    { key: 'conditional', label: t('production.milk.status.conditional'), align: 'right', sortValue: g => g.conditional, render: g => <span className={g.conditional ? 'text-amber-700 dark:text-amber-400' : 'text-gray-400'}>{g.conditional}</span>, footer: total?.conditional ?? 0 },
    {
      key: 'rejected', label: t('production.milk.status.rejected'), align: 'right', sortValue: g => g.rejectedKg,
      render: g => <span className={g.rejected ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}>{g.rejected}{g.rejected ? ` · ${formatQty(g.rejectedKg)} ${kg}` : ''}</span>,
      footer: total?.rejected ? `${total.rejected} · ${formatQty(total.rejectedKg)} ${kg}` : '0',
    },
    { key: 'pending', label: t('prodReports.milk.pending'), align: 'right', sortValue: g => g.pending, render: g => <span className="text-gray-500 dark:text-gray-400">{g.pending}</span>, footer: total?.pending ?? 0 },
  ]

  function exportXlsx() {
    downloadXlsx(`sut_${groupBy}`, [
      groupBy === 'day' ? t('production.common.date') : t('production.milk.supplier'),
      t('prodReports.milk.deliveries'), `${t('prodReports.milk.receivedKg')} (${kg})`, t('production.milk.fat'), t('production.milk.protein'),
      `${t('production.milk.amount')} (UZS)`, `${t('prodReports.milk.avgPrice')} (UZS)`, t('production.milk.status.conditional'),
      t('production.milk.status.rejected'), `${t('prodReports.milk.rejectedKg')} (${kg})`, t('prodReports.milk.pending'),
    ], [...groups].sort((a, b) => a.key.localeCompare(b.key)).map(g => [
      groupBy === 'day' ? g.key : label(g), g.count, x3(g.receivedKg), g.fat === null ? '' : x3(g.fat), g.protein === null ? '' : x3(g.protein),
      x2(g.amount), x2(avgPrice(g)), g.conditional, g.rejected, x3(g.rejectedKg), g.pending,
    ]), t('prodReports.milk.title'))
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodReports.milk.title')}
        subtitle={t('prodReports.milk.subtitle')}
        range={range}
        onRangeChange={setRange}
        onExport={groups.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
        <FilterSelect value={supplierId} onChange={setSupplierId} className="w-56">
          <option value="">{t('production.suppliers.allSuppliers')}</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </FilterSelect>
        <Segmented
          className="ml-auto"
          options={[
            { value: 'day' as const, label: t('prodReports.milk.byDay') },
            { value: 'supplier' as const, label: t('prodReports.milk.bySupplier') },
          ]}
          value={groupBy}
          onChange={setGroupBy}
        />
      </ReportHeader>

      <ProdKpiGrid items={[
        { label: t('prodReports.milk.receivedKg'), value: `${formatQty(total?.receivedKg ?? 0)} ${kg}`, sub: `${total?.count ?? 0} ${t('prodReports.milk.deliveriesLower')}`, icon: Milk },
        { label: t('prodReports.milk.avgFatProtein'), value: `${formatPct(total?.fat)} / ${formatPct(total?.protein)}`, icon: Droplets },
        { label: t('production.milk.amount'), value: formatPrice(total?.amount ?? 0), sub: total ? `${t('prodReports.milk.avgPrice')}: ${formatPrice(avgPrice(total))}` : undefined, icon: Wallet },
        {
          label: t('production.milk.status.rejected'), value: `${total?.rejected ?? 0} · ${formatQty(total?.rejectedKg ?? 0)} ${kg}`,
          sub: `${t('production.milk.status.conditional')}: ${total?.conditional ?? 0}`, icon: Ban, tone: total?.rejected ? 'negative' : undefined,
        },
      ]} />

      <ReportTable
        key={groupBy}
        rows={groups}
        columns={columns}
        rowKey={g => g.key}
        loading={loading}
        emptyText={t('prodReports.common.empty')}
        initialSort={groupBy === 'day' ? { key: 'key', dir: 'desc' } : { key: 'kg', dir: 'desc' }}
        pageSize={50}
      />
    </div>
  )
}
