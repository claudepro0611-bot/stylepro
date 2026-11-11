'use client'

// Inventarizatsiya (stock counts): drafts, posted and cancelled counts.
// Writes happen on the editor / view pages (prod_save_stock_count,
// prod_post_stock_count, prod_delete_stock_count_draft, prod_cancel_document).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardCheck, Eye, Search } from 'lucide-react'
import Link from 'next/link'
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
import { FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { ExportButton } from '@/components/production/ReportKit'
import { CountStatusBadge, NotAvailableNote, useInventoryDocs } from '@/components/production/InventoryKit'
import { rangeToIsoBounds } from '@/lib/production'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25

interface Row {
  id: string
  number: number
  doc_date: string
  warehouse_id: string
  note: string | null
  status: string
  shortage_value: number
  surplus_value: number
  created_by_name: string | null
  posted_by_name: string | null
}

export default function StockCountListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useInventoryDocs()
  const { warehouses, warehouseById } = useProdRefs()

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [warehouseId, setWarehouseId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<Row>((from, to) => {
      let q = supabase.from('prod_stock_counts')
        .select('id, number, doc_date, warehouse_id, note, status, shortage_value, surplus_value, created_by_name, posted_by_name')
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [available, range, warehouseId, status, t])

  useEffect(() => { load() }, [load])

  const nameOf = useCallback((id: string) => warehouseById.get(id)?.name ?? '—', [warehouseById])
  const statusLabel = (s: string) => (s === 'draft' ? t('prodInventory.common.statusDraft') : s === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || nameOf(r.warehouse_id).toLowerCase().includes(q))
  }, [rows, search, nameOf])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function exportXlsx() {
    downloadXlsx('zavod_inventarizatsiya', [
      t('production.common.number'), t('production.common.date'), t('production.common.warehouse'), t('production.common.status'),
      `${t('prodInventory.counts.shortage')} (UZS)`, `${t('prodInventory.counts.surplus')} (UZS)`, t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), nameOf(r.warehouse_id), statusLabel(r.status),
      x2(Number(r.shortage_value)), x2(Number(r.surplus_value)), r.posted_by_name ?? r.created_by_name ?? '', r.note ?? '',
    ]), t('prodInventory.counts.title'))
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
        title={t('prodInventory.counts.title')}
        subtitle={t('prodInventory.counts.subtitle')}
        actionLabel={available ? t('prodInventory.counts.new') : undefined}
        actionHref="/zavod-inventarizatsiya/yangi"
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={reset} columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />}>
            <DateRangeFilter value={range} onChange={setRange} />
            <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
              <option value="">{t('production.common.allWarehouses')}</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
              <option value="">{t('production.common.allStatuses')}</option>
              <option value="draft">{t('prodInventory.common.statusDraft')}</option>
              <option value="posted">{t('production.common.statusPosted')}</option>
              <option value="cancelled">{t('production.common.statusCancelled')}</option>
            </select>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('prodInventory.common.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
          </FilterBar>

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodInventory.counts.empty')} emptyIcon={ClipboardCheck}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.number')}</th>
                  <th className={thCls}>{t('production.common.date')}</th>
                  <th className={thCls}>{t('production.common.warehouse')}</th>
                  <th className={thRightCls}>{t('prodInventory.counts.shortage')}</th>
                  <th className={thRightCls}>{t('prodInventory.counts.surplus')}</th>
                  <th className={thCls}>{t('production.common.status')}</th>
                  <th className={thCls}>{t('production.common.author')}</th>
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr key={r.id} onClick={() => router.push(`/zavod-inventarizatsiya/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                    <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>
                    <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{nameOf(r.warehouse_id)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap', Number(r.shortage_value) > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400')}>{r.status === 'draft' ? '—' : formatPrice(Number(r.shortage_value))}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap', Number(r.surplus_value) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400')}>{r.status === 'draft' ? '—' : formatPrice(Number(r.surplus_value))}</td>
                    <td className={tdCls}><CountStatusBadge status={r.status} /></td>
                    <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.posted_by_name ?? r.created_by_name ?? '—'}</td>
                    <td className={tdCls}>
                      <div className="flex justify-end" onClick={e => e.stopPropagation()}>
                        <Link href={`/zavod-inventarizatsiya/${r.id}`} aria-label={t('production.common.view')} title={t('production.common.view')} className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                          <Eye className="h-3.5 w-3.5" />
                        </Link>
                      </div>
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
