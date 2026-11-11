'use client'

// Boshlang'ich qoldiq (opening balance documents): each line became a lot.
// Writes: prod_create_opening (yangi), prod_cancel_document('opening_balance').

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PackageOpen, Search } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import {
  DocActions, DocStatusBadge, FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { ExportButton } from '@/components/production/ReportKit'
import { NotAvailableNote, useInventoryDocs } from '@/components/production/InventoryKit'
import { rangeToIsoBounds } from '@/lib/production'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25

interface Row {
  id: string
  number: number
  doc_date: string
  warehouse_id: string
  note: string | null
  total: number
  status: string
  created_by_name: string | null
}

export default function OpeningListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useInventoryDocs()
  const { warehouses, warehouseById } = useProdRefs()

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  // Opening balances are rare: show all time by default.
  const [range, setRange] = useState<DateRangeValue | null>(null)
  const [warehouseId, setWarehouseId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<Row>((from, to) => {
      let q = supabase.from('prod_openings').select('id, number, doc_date, warehouse_id, note, total, status, created_by_name')
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [available, range, warehouseId, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('opening_balance', load)
  const nameOf = useCallback((id: string) => warehouseById.get(id)?.name ?? '—', [warehouseById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || nameOf(r.warehouse_id).toLowerCase().includes(q))
  }, [rows, search, nameOf])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function exportXlsx() {
    downloadXlsx('zavod_boshlangich_qoldiq', [
      t('production.common.number'), t('production.common.date'), t('production.common.warehouse'), `${t('production.common.total')} (UZS)`,
      t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), nameOf(r.warehouse_id), x2(Number(r.total)),
      r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('prodInventory.openings.title'))
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodInventory.openings.title')}
        subtitle={t('prodInventory.openings.subtitle')}
        actionLabel={available ? t('prodInventory.openings.new') : undefined}
        actionHref="/zavod-boshlangich-qoldiq/yangi"
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={() => { setRange(null); setWarehouseId(''); setSearch('') }} columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />}>
            <DateRangeFilter value={range} onChange={setRange} />
            <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
              <option value="">{t('production.common.allWarehouses')}</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('prodInventory.common.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
          </FilterBar>

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodInventory.openings.empty')} emptyIcon={PackageOpen}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.number')}</th>
                  <th className={thCls}>{t('production.common.date')}</th>
                  <th className={thCls}>{t('production.common.warehouse')}</th>
                  <th className={thRightCls}>{t('production.common.total')}</th>
                  <th className={thCls}>{t('production.common.status')}</th>
                  <th className={thCls}>{t('production.common.author')}</th>
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr key={r.id} onClick={() => router.push(`/zavod-boshlangich-qoldiq/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                    <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>
                    <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{nameOf(r.warehouse_id)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.total))}</td>
                    <td className={tdCls}><DocStatusBadge status={r.status} /></td>
                    <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>
                    <td className={tdCls}>
                      <DocActions viewHref={`/zavod-boshlangich-qoldiq/${r.id}`} canCancel={canCancel} posted={r.status === 'posted'} busy={busyId === r.id} onCancel={() => cancel(r.id)} />
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
