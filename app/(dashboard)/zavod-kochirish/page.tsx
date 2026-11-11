'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight, Search } from 'lucide-react'
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
import { rangeToIsoBounds } from '@/lib/production'
import { ExportButton } from '@/components/production/ReportKit'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25
// Keeps the .in() filter well below URL length limits.
const ID_CHUNK = 150

interface Row {
  id: string
  number: number
  doc_date: string
  from_warehouse_id: string
  to_warehouse_id: string
  note: string | null
  total: number
  status: string
  created_by_name: string | null
}

export default function TransferListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { warehouses, warehouseById } = useProdRefs()

  const [rows, setRows] = useState<Row[]>([])
  const [lineCounts, setLineCounts] = useState<Map<string, number>>(new Map())
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
      let q = supabase.from('prod_transfers')
        .select('id, number, doc_date, from_warehouse_id, to_warehouse_id, note, total, status, created_by_name')
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (warehouseId) q = q.or(`from_warehouse_id.eq.${warehouseId},to_warehouse_id.eq.${warehouseId}`)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))

    // Line counts ("Mahsulotlar soni") for the loaded documents.
    const counts = new Map<string, number>()
    const ids = data.map(r => r.id)
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK)
      const res = await fetchAllRows((from, to) =>
        supabase.from('prod_transfer_items').select('id, transfer_id').in('transfer_id', chunk).order('id').range(from, to))
      for (const l of res.data) counts.set(l.transfer_id, (counts.get(l.transfer_id) ?? 0) + 1)
    }

    setRows(data)
    setLineCounts(counts)
    setPage(1)
    setLoading(false)
  }, [range, warehouseId, status, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('transfer', load)
  const { isVisible, toggle } = useHiddenColumns('zavod-kochirish')

  const nameOf = useCallback((id: string) => warehouseById.get(id)?.name ?? '—', [warehouseById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q)
      || nameOf(r.from_warehouse_id).toLowerCase().includes(q)
      || nameOf(r.to_warehouse_id).toLowerCase().includes(q))
  }, [rows, search, nameOf])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const columns = [
    { key: 'date', label: t('production.common.date') },
    { key: 'from', label: t('production.transfers.from') },
    { key: 'to', label: t('production.transfers.to') },
    { key: 'lines', label: t('production.transfers.itemsCount') },
    { key: 'total', label: t('production.common.total') },
    { key: 'status', label: t('production.common.status') },
    { key: 'author', label: t('production.common.author') },
  ]

  function exportXlsx() {
    downloadXlsx('zavod_kochirish', [
      t('production.common.number'), t('production.common.date'), t('production.transfers.from'), t('production.transfers.to'),
      t('production.transfers.itemsCount'), `${t('production.common.total')} (UZS)`, t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), nameOf(r.from_warehouse_id), nameOf(r.to_warehouse_id), lineCounts.get(r.id) ?? 0,
      x2(Number(r.total)), r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('production.transfers.title'))
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
        title={t('production.transfers.title')}
        subtitle={t('production.transfers.subtitle')}
        actionLabel={t('production.transfers.new')}
        actionHref="/zavod-kochirish/yangi"
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
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.transfers.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.transfers.empty')} emptyIcon={ArrowLeftRight}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.number')}</th>
              {isVisible('date') && <th className={thCls}>{t('production.common.date')}</th>}
              {isVisible('from') && <th className={thCls}>{t('production.transfers.from')}</th>}
              {isVisible('to') && <th className={thCls}>{t('production.transfers.to')}</th>}
              {isVisible('lines') && <th className={thRightCls}>{t('production.transfers.itemsCount')}</th>}
              {isVisible('total') && <th className={thRightCls}>{t('production.common.total')}</th>}
              {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
              {isVisible('author') && <th className={thCls}>{t('production.common.author')}</th>}
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => (
              <tr key={r.id} onClick={() => router.push(`/zavod-kochirish/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                {isVisible('date') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>}
                {isVisible('from') && <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{nameOf(r.from_warehouse_id)}</td>}
                {isVisible('to') && <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{nameOf(r.to_warehouse_id)}</td>}
                {isVisible('lines') && <td className={cn(tdCls, 'text-right tabular-nums text-gray-500 dark:text-gray-400')}>{lineCounts.get(r.id) ?? 0}</td>}
                {isVisible('total') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.total))}</td>}
                {isVisible('status') && <td className={tdCls}><DocStatusBadge status={r.status} /></td>}
                {isVisible('author') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>}
                <td className={tdCls}>
                  <DocActions
                    viewHref={`/zavod-kochirish/${r.id}`}
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
