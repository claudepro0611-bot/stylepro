'use client'

// Hisobdan chiqarish (write-offs): list + export. Writes: prod_create_writeoff
// (yangi) and prod_cancel_document('writeoff'). Shows a note while migration
// 20261110000014 is not applied.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Trash2 } from 'lucide-react'
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
import { ExportButton } from '@/components/production/ReportKit'
import { NotAvailableNote, WriteoffReasonBadge, useInventoryDocs } from '@/components/production/InventoryKit'
import { rangeToIsoBounds } from '@/lib/production'
import { WRITEOFF_REASONS, writeoffReasonKey } from '@/lib/inventory'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25
const ID_CHUNK = 150

interface Row {
  id: string
  number: number
  doc_date: string
  warehouse_id: string
  reason: string
  note: string | null
  total_cost: number
  status: string
  created_by_name: string | null
}

export default function WriteoffListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useInventoryDocs()
  const { warehouses, warehouseById } = useProdRefs()

  const [rows, setRows] = useState<Row[]>([])
  const [lineCounts, setLineCounts] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [warehouseId, setWarehouseId] = useState('')
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<Row>((from, to) => {
      let q = supabase.from('prod_writeoffs')
        .select('id, number, doc_date, warehouse_id, reason, note, total_cost, status, created_by_name')
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      if (reason) q = q.eq('reason', reason)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    const counts = new Map<string, number>()
    const ids = data.map(r => r.id)
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK)
      const res = await fetchAllRows((from, to) =>
        supabase.from('prod_writeoff_items').select('id, writeoff_id').in('writeoff_id', chunk).order('id').range(from, to))
      for (const l of res.data) counts.set(l.writeoff_id, (counts.get(l.writeoff_id) ?? 0) + 1)
    }
    setRows(data)
    setLineCounts(counts)
    setPage(1)
    setLoading(false)
  }, [available, range, warehouseId, reason, status, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('writeoff', load)
  const { isVisible, toggle } = useHiddenColumns('zavod-hisobdan-chiqarish')
  const nameOf = useCallback((id: string) => warehouseById.get(id)?.name ?? '—', [warehouseById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || nameOf(r.warehouse_id).toLowerCase().includes(q) || (r.note ?? '').toLowerCase().includes(q))
  }, [rows, search, nameOf])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const columns = [
    { key: 'date', label: t('production.common.date') },
    { key: 'warehouse', label: t('production.common.warehouse') },
    { key: 'reason', label: t('prodInventory.common.reason') },
    { key: 'lines', label: t('prodInventory.common.itemsCount') },
    { key: 'total', label: t('prodInventory.writeoffs.totalCost') },
    { key: 'status', label: t('production.common.status') },
    { key: 'author', label: t('production.common.author') },
  ]

  function exportXlsx() {
    downloadXlsx('zavod_hisobdan_chiqarish', [
      t('production.common.number'), t('production.common.date'), t('production.common.warehouse'), t('prodInventory.common.reason'),
      t('prodInventory.common.itemsCount'), `${t('prodInventory.writeoffs.totalCost')} (UZS)`, t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), nameOf(r.warehouse_id), t(writeoffReasonKey(r.reason)), lineCounts.get(r.id) ?? 0,
      x2(Number(r.total_cost)), r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('prodInventory.writeoffs.title'))
  }

  function reset() {
    setRange(monthToDate())
    setWarehouseId('')
    setReason('')
    setStatus('')
    setSearch('')
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodInventory.writeoffs.title')}
        subtitle={t('prodInventory.writeoffs.subtitle')}
        actionLabel={available ? t('prodInventory.writeoffs.new') : undefined}
        actionHref="/zavod-hisobdan-chiqarish/yangi"
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={reset} columns={<><ExportButton onClick={exportXlsx} disabled={filtered.length === 0} /><ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} /></>}>
            <DateRangeFilter value={range} onChange={setRange} />
            <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
              <option value="">{t('production.common.allWarehouses')}</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select value={reason} onChange={e => setReason(e.target.value)} className={cn(prodFieldCls, 'w-44')}>
              <option value="">{t('prodInventory.common.allReasons')}</option>
              {WRITEOFF_REASONS.map(r => <option key={r} value={r}>{t(writeoffReasonKey(r))}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
              <option value="">{t('production.common.allStatuses')}</option>
              <option value="posted">{t('production.common.statusPosted')}</option>
              <option value="cancelled">{t('production.common.statusCancelled')}</option>
            </select>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('prodInventory.common.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
          </FilterBar>

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodInventory.writeoffs.empty')} emptyIcon={Trash2}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.number')}</th>
                  {isVisible('date') && <th className={thCls}>{t('production.common.date')}</th>}
                  {isVisible('warehouse') && <th className={thCls}>{t('production.common.warehouse')}</th>}
                  {isVisible('reason') && <th className={thCls}>{t('prodInventory.common.reason')}</th>}
                  {isVisible('lines') && <th className={thRightCls}>{t('prodInventory.common.itemsCount')}</th>}
                  {isVisible('total') && <th className={thRightCls}>{t('prodInventory.writeoffs.totalCost')}</th>}
                  {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
                  {isVisible('author') && <th className={thCls}>{t('production.common.author')}</th>}
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr key={r.id} onClick={() => router.push(`/zavod-hisobdan-chiqarish/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                    <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                    {isVisible('date') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>}
                    {isVisible('warehouse') && <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{nameOf(r.warehouse_id)}</td>}
                    {isVisible('reason') && <td className={tdCls}><WriteoffReasonBadge reason={r.reason} /></td>}
                    {isVisible('lines') && <td className={cn(tdCls, 'text-right tabular-nums text-gray-500 dark:text-gray-400')}>{lineCounts.get(r.id) ?? 0}</td>}
                    {isVisible('total') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.total_cost))}</td>}
                    {isVisible('status') && <td className={tdCls}><DocStatusBadge status={r.status} /></td>}
                    {isVisible('author') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>}
                    <td className={tdCls}>
                      <DocActions
                        viewHref={`/zavod-hisobdan-chiqarish/${r.id}`}
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
        </>
      )}
    </div>
  )
}
