'use client'

// Separatsiya (milk -> cream + skim) documents with period KPIs.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Droplets, Milk, Percent, Search, Split } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { monthToDate } from '@/components/reports/ReportKit'
import {
  ColumnSettings, DocActions, DocStatusBadge, FilterBar, PageHeader, TableCard, useHiddenColumns,
  prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { MilkKpi } from '@/components/production/MilkKit'
import { formatQty, rangeToIsoBounds, round3, warehousePairLabel } from '@/lib/production'
import { ExportButton } from '@/components/production/ReportKit'
import { dateTimeCell, downloadXlsx, x2, x3 } from '@/lib/production-reports'
import { formatPct } from '@/lib/milk'
import type { Database } from '@/lib/database.types'

const PAGE_SIZE = 25

type Row = Pick<Database['public']['Tables']['prod_separations']['Row'],
  'id' | 'number' | 'doc_date' | 'warehouse_id' | 'output_warehouse_id' | 'milk_item_id' | 'cream_item_id' | 'skim_item_id' |
  'milk_qty' | 'milk_fat' | 'cream_fat' | 'cream_qty' | 'skim_qty' | 'loss_qty' | 'cream_unit_cost' | 'skim_unit_cost' |
  'status' | 'created_by_name'>

export default function SeparationListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { warehouses, itemById, warehouseById } = useProdRefs()

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [warehouseId, setWarehouseId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<Row>((from, to) => {
      let q = supabase.from('prod_separations')
        .select('id, number, doc_date, warehouse_id, output_warehouse_id, milk_item_id, cream_item_id, skim_item_id, milk_qty, milk_fat, cream_fat, cream_qty, skim_qty, loss_qty, cream_unit_cost, skim_unit_cost, status, created_by_name')
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (warehouseId) q = q.or(`warehouse_id.eq.${warehouseId},output_warehouse_id.eq.${warehouseId}`)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [range, warehouseId, status, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('separation', load)
  const { isVisible, toggle } = useHiddenColumns('separatsiya')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^#/, '')
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q)
      || [r.milk_item_id, r.cream_item_id, r.skim_item_id].some(id => (itemById.get(id)?.name ?? '').toLowerCase().includes(q)))
  }, [rows, search, itemById])

  const kpi = useMemo(() => {
    let milk = 0, cream = 0, skim = 0
    for (const r of filtered) {
      if (r.status !== 'posted') continue
      milk += Number(r.milk_qty)
      cream += Number(r.cream_qty)
      skim += Number(r.skim_qty)
    }
    return { milk: round3(milk), cream: round3(cream), skim: round3(skim), yieldPct: milk > 0 ? (cream / milk) * 100 : null }
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const kg = t('production.units.kg')
  const columns = [
    { key: 'date', label: t('production.common.date') },
    { key: 'milk', label: t('production.separation.milkCol') },
    { key: 'cream', label: t('production.separation.creamCol') },
    { key: 'skim', label: t('production.separation.skimCol') },
    { key: 'loss', label: t('production.separation.lossCol') },
    { key: 'creamCost', label: t('production.separation.creamCostCol') },
    { key: 'skimCost', label: t('production.separation.skimCostCol') },
    { key: 'warehouse', label: t('production.common.warehouse') },
    { key: 'status', label: t('production.common.status') },
    { key: 'author', label: t('production.common.author') },
  ]

  function exportXlsx() {
    downloadXlsx('separatsiya', [
      t('production.common.number'), t('production.common.date'), `${t('production.separation.milkCol')} (${kg})`, t('production.separation.fatPct'),
      `${t('production.separation.creamCol')} (${kg})`, `${t('production.separation.creamLabel')} ${t('production.separation.fatPct')}`,
      `${t('production.separation.skimCol')} (${kg})`, `${t('production.separation.lossCol')} (${kg})`,
      `${t('production.separation.creamCostCol')} (UZS)`, `${t('production.separation.skimCostCol')} (UZS)`,
      t('production.common.warehouse'), t('production.common.status'), t('production.common.author'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), x3(Number(r.milk_qty)), Number(r.milk_fat), x3(Number(r.cream_qty)), Number(r.cream_fat),
      x3(Number(r.skim_qty)), x3(Number(r.loss_qty)), x2(Number(r.cream_unit_cost)), x2(Number(r.skim_unit_cost)),
      warehousePairLabel(warehouseById.get(r.warehouse_id)?.name ?? '', warehouseById.get(r.output_warehouse_id)?.name),
      r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '',
    ]), t('production.separation.title'))
  }

  function reset() {
    setRange(monthToDate())
    setWarehouseId('')
    setStatus('')
    setSearch('')
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('production.separation.title')}
        subtitle={t('production.separation.subtitle')}
        actionLabel={t('production.separation.new')}
        actionHref="/separatsiya/yangi"
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <MilkKpi icon={Milk} label={t('production.separation.kpiMilk')} value={`${formatQty(kpi.milk)} ${kg}`} />
        <MilkKpi icon={Droplets} label={t('production.separation.kpiCream')} value={`${formatQty(kpi.cream)} ${kg}`} />
        <MilkKpi icon={Split} label={t('production.separation.kpiSkim')} value={`${formatQty(kpi.skim)} ${kg}`} />
        <MilkKpi icon={Percent} label={t('production.separation.kpiYield')} value={kpi.yieldPct === null ? '—' : `${formatPct(kpi.yieldPct)}%`} />
      </div>

      <FilterBar onReset={reset} columns={<><ExportButton onClick={exportXlsx} disabled={filtered.length === 0} /><ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} /></>}>
        <DateRangeFilter value={range} onChange={setRange} />
        <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
          <option value="">{t('production.common.allWarehouses')}</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
          <option value="">{t('production.common.allStatuses')}</option>
          <option value="posted">{t('production.common.statusPosted')}</option>
          <option value="cancelled">{t('production.common.statusCancelled')}</option>
        </select>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.common.searchDoc')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.separation.empty')} emptyIcon={Split}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.number')}</th>
              {isVisible('date') && <th className={thCls}>{t('production.common.date')}</th>}
              {isVisible('milk') && <th className={thRightCls}>{t('production.separation.milkCol')}</th>}
              {isVisible('cream') && <th className={thRightCls}>{t('production.separation.creamCol')}</th>}
              {isVisible('skim') && <th className={thRightCls}>{t('production.separation.skimCol')}</th>}
              {isVisible('loss') && <th className={thRightCls}>{t('production.separation.lossCol')}</th>}
              {isVisible('creamCost') && <th className={thRightCls}>{t('production.separation.creamCostCol')}</th>}
              {isVisible('skimCost') && <th className={thRightCls}>{t('production.separation.skimCostCol')}</th>}
              {isVisible('warehouse') && <th className={thCls}>{t('production.common.warehouse')}</th>}
              {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
              {isVisible('author') && <th className={thCls}>{t('production.common.author')}</th>}
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => (
              <tr key={r.id} onClick={() => router.push(`/separatsiya/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                {isVisible('date') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>}
                {isVisible('milk') && (
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>
                    {formatQty(Number(r.milk_qty))} <span className="text-gray-400 dark:text-gray-500">({formatPct(r.milk_fat)}%)</span>
                  </td>
                )}
                {isVisible('cream') && (
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>
                    {formatQty(Number(r.cream_qty))} <span className="font-normal text-gray-400 dark:text-gray-500">({formatPct(r.cream_fat)}%)</span>
                  </td>
                )}
                {isVisible('skim') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatQty(Number(r.skim_qty))}</td>}
                {isVisible('loss') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatQty(Number(r.loss_qty))}</td>}
                {isVisible('creamCost') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.cream_unit_cost))}</td>}
                {isVisible('skimCost') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(Number(r.skim_unit_cost))}</td>}
                {isVisible('warehouse') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehousePairLabel(warehouseById.get(r.warehouse_id)?.name ?? '—', warehouseById.get(r.output_warehouse_id)?.name)}</td>}
                {isVisible('status') && <td className={tdCls}><DocStatusBadge status={r.status} /></td>}
                {isVisible('author') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>}
                <td className={tdCls}>
                  <DocActions
                    viewHref={`/separatsiya/${r.id}`}
                    canCancel={canCancel}
                    posted={r.status === 'posted'}
                    busy={busyId === r.id}
                    onCancel={() => cancel(r.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}
    </div>
  )
}
