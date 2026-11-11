'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Recycle, Search } from 'lucide-react'
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
import { formatQty, rangeToIsoBounds, unitKey, warehousePairLabel } from '@/lib/production'
import { ExportButton } from '@/components/production/ReportKit'
import { dateTimeCell, downloadXlsx, x2, x3 } from '@/lib/production-reports'

const PAGE_SIZE = 25

interface Row {
  id: string
  number: number
  doc_date: string
  warehouse_id: string
  output_warehouse_id: string | null
  source_item_id: string
  source_qty: number
  processing_cost: number
  recovery_cost: number
  profit: number
  status: string
  created_by_name: string | null
}

export default function ProcessingListPage() {
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
      let q = supabase.from('prod_processings')
        .select('id, number, doc_date, warehouse_id, output_warehouse_id, source_item_id, source_qty, processing_cost, recovery_cost, profit, status, created_by_name')
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

  const { canCancel, cancel, busyId } = useCancelDoc('processing', load)
  const { isVisible, toggle } = useHiddenColumns('qayta-ishlash')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || (itemById.get(r.source_item_id)?.name ?? '').toLowerCase().includes(q))
  }, [rows, search, itemById])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const columns = [
    { key: 'date', label: t('production.common.date') },
    { key: 'item', label: t('production.processings.sourceItem') },
    { key: 'qty', label: t('production.common.qty') },
    { key: 'processingCost', label: t('production.processings.processingCost') },
    { key: 'recoveryCost', label: t('production.processings.recoveryCost') },
    { key: 'profit', label: t('production.processings.profit') },
    { key: 'warehouse', label: t('production.common.warehouse') },
    { key: 'status', label: t('production.common.status') },
  ]

  function exportXlsx() {
    downloadXlsx('qayta_ishlash', [
      t('production.common.number'), t('production.common.date'), t('production.common.item'), t('production.common.qty'), t('production.common.unit'),
      `${t('production.processings.processingCost')} (UZS)`, `${t('production.processings.recoveryCost')} (UZS)`, `${t('production.processings.profit')} (UZS)`,
      t('production.common.warehouse'), t('production.common.status'), t('production.common.author'),
    ], filtered.map(r => {
      const item = itemById.get(r.source_item_id)
      return [
        r.number, dateTimeCell(r.doc_date), item?.name ?? '', x3(Number(r.source_qty)), item ? t(unitKey(item.unit)) : '',
        x2(Number(r.processing_cost)), x2(Number(r.recovery_cost)), x2(Number(r.profit)),
        warehousePairLabel(warehouseById.get(r.warehouse_id)?.name ?? '', r.output_warehouse_id ? warehouseById.get(r.output_warehouse_id)?.name : null),
        r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '',
      ]
    }), t('production.processings.title'))
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
        title={t('production.processings.title')}
        subtitle={t('production.processings.subtitle')}
        actionLabel={t('production.processings.new')}
        actionHref="/qayta-ishlash/yangi"
      />

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

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.processings.empty')} emptyIcon={Recycle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.number')}</th>
              {isVisible('date') && <th className={thCls}>{t('production.common.date')}</th>}
              {isVisible('item') && <th className={thCls}>{t('production.processings.sourceItem')}</th>}
              {isVisible('qty') && <th className={thRightCls}>{t('production.common.qty')}</th>}
              {isVisible('processingCost') && <th className={thRightCls}>{t('production.processings.processingCost')}</th>}
              {isVisible('recoveryCost') && <th className={thRightCls}>{t('production.processings.recoveryCost')}</th>}
              {isVisible('profit') && <th className={thRightCls}>{t('production.processings.profit')}</th>}
              {isVisible('warehouse') && <th className={thCls}>{t('production.common.warehouse')}</th>}
              {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => {
              const item = itemById.get(r.source_item_id)
              const profit = Number(r.profit)
              return (
                <tr key={r.id} onClick={() => router.push(`/qayta-ishlash/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                  <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                  {isVisible('date') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>}
                  {isVisible('item') && <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{item?.name ?? '—'}</td>}
                  {isVisible('qty') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatQty(Number(r.source_qty))} {item ? t(unitKey(item.unit)) : ''}</td>}
                  {isVisible('processingCost') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.processing_cost))}</td>}
                  {isVisible('recoveryCost') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.recovery_cost))}</td>}
                  {isVisible('profit') && (
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium', profit < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                      {formatPrice(profit)}
                    </td>
                  )}
                  {isVisible('warehouse') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehousePairLabel(warehouseById.get(r.warehouse_id)?.name ?? '—', r.output_warehouse_id ? warehouseById.get(r.output_warehouse_id)?.name : null)}</td>}
                  {isVisible('status') && <td className={tdCls}><DocStatusBadge status={r.status} /></td>}
                  <td className={tdCls}>
                    <DocActions
                      viewHref={`/qayta-ishlash/${r.id}`}
                      canCancel={canCancel}
                      posted={r.status === 'posted'}
                      busy={busyId === r.id}
                      onCancel={() => cancel(r.id)}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableCard>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}
    </div>
  )
}
