'use client'

// Qaytarishlar (customer returns against wholesale sales): list + export.
// Returns are created from a sale (/zavod-sotuv/[id]/qaytarish); cancel via
// prod_cancel_document('sale_return').

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, Undo2 } from 'lucide-react'
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
  DocActions, DocStatusBadge, FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { ExportButton } from '@/components/production/ReportKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useProdCustomers, useSalesAvailable } from '@/components/production/SalesKit'
import { rangeToIsoBounds, round2 } from '@/lib/production'
import { RETURN_COLS, type ReturnRow } from '@/lib/sales'
import { dateTimeCell, downloadXlsx, fetchByIds, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25

export default function SaleReturnsListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useSalesAvailable()
  const { warehouses, warehouseById } = useProdRefs()
  const { customers } = useProdCustomers()

  const [rows, setRows] = useState<ReturnRow[]>([])
  const [saleNo, setSaleNo] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [customerId, setCustomerId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers])

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<ReturnRow>((from, to) => {
      let q = supabase.from('prod_sale_returns').select(RETURN_COLS)
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (customerId) q = q.eq('customer_id', customerId)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    const saleIds = [...new Set(data.map(r => r.sale_id))]
    const sRes = await fetchByIds<{ id: string; number: number }>(saleIds, (chunk, from, to) =>
      supabase.from('prod_sales').select('id, number').in('id', chunk).order('id').range(from, to))
    setSaleNo(new Map(sRes.data.map(s => [s.id, s.number])))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [available, range, customerId, warehouseId, status, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('sale_return', load)
  const nameOf = useCallback((id: string) => customerById.get(id)?.name ?? '—', [customerById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || String(saleNo.get(r.sale_id) ?? '').includes(q)
      || nameOf(r.customer_id).toLowerCase().includes(q) || (r.reason ?? '').toLowerCase().includes(q))
  }, [rows, search, nameOf, saleNo])

  const total = useMemo(() => round2(filtered.filter(r => r.status === 'posted').reduce((s, r) => s + Number(r.total), 0)), [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function exportXlsx() {
    downloadXlsx('zavod_qaytarishlar', [
      t('production.common.number'), t('production.common.date'), t('prodSales.common.customer'), t('prodSales.returns.sale'),
      t('production.common.warehouse'), t('prodInventory.common.reason'), `${t('prodSales.common.subtotal')} (UZS)`, `${t('prodSales.common.vat')} (UZS)`,
      `${t('prodSales.returns.credit')} (UZS)`, t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), nameOf(r.customer_id), saleNo.get(r.sale_id) ?? '', warehouseById.get(r.warehouse_id)?.name ?? '',
      r.reason ?? '', x2(Number(r.subtotal)), x2(Number(r.vat_amount)), x2(Number(r.total)),
      r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('prodSales.returns.title'))
  }

  function reset() {
    setRange(monthToDate())
    setCustomerId('')
    setWarehouseId('')
    setStatus('')
    setSearch('')
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('prodSales.returns.title')} subtitle={t('prodSales.returns.subtitle')} />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={reset} columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />} moreActive={!!warehouseId || !!status} more={<>
            <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
              <option value="">{t('production.common.allWarehouses')}</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
              <option value="">{t('production.common.allStatuses')}</option>
              <option value="posted">{t('production.common.statusPosted')}</option>
              <option value="cancelled">{t('production.common.statusCancelled')}</option>
            </select>
          </>}>
            <DateRangeFilter value={range} onChange={setRange} />
            <select value={customerId} onChange={e => setCustomerId(e.target.value)} className={cn(prodFieldCls, 'w-52')}>
              <option value="">{t('prodSales.common.allCustomers')}</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('prodSales.sales.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
          </FilterBar>

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodSales.returns.empty')} emptyIcon={Undo2}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.number')}</th>
                  <th className={thCls}>{t('production.common.date')}</th>
                  <th className={thCls}>{t('prodSales.common.customer')}</th>
                  <th className={thCls}>{t('prodSales.returns.sale')}</th>
                  <th className={thCls}>{t('production.common.warehouse')}</th>
                  <th className={thCls}>{t('prodInventory.common.reason')}</th>
                  <th className={thRightCls}>{t('prodSales.returns.credit')}</th>
                  <th className={thCls}>{t('production.common.status')}</th>
                  <th className={thCls}>{t('production.common.author')}</th>
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr key={r.id} onClick={() => router.push(`/zavod-qaytarishlar/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                    <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>
                    <td className={tdCls} onClick={e => e.stopPropagation()}>
                      <Link href={`/zavod-mijozlar/${r.customer_id}`} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">{nameOf(r.customer_id)}</Link>
                    </td>
                    <td className={tdCls} onClick={e => e.stopPropagation()}>
                      <Link href={`/zavod-sotuv/${r.sale_id}`} className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">#{saleNo.get(r.sale_id) ?? '—'}</Link>
                    </td>
                    <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(r.warehouse_id)?.name ?? '—'}</td>
                    <td className={cn(tdCls, 'max-w-[200px] truncate text-gray-500 dark:text-gray-400')}>{r.reason || '—'}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.total))}</td>
                    <td className={tdCls}><DocStatusBadge status={r.status} /></td>
                    <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>
                    <td className={tdCls}>
                      <DocActions viewHref={`/zavod-qaytarishlar/${r.id}`} canCancel={canCancel} posted={r.status === 'posted'} busy={busyId === r.id} onCancel={() => cancel(r.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-900 dark:text-gray-100">
                  <td colSpan={10} className="px-4 py-3 text-right">
                    {t('prodSales.returns.totalCredit')}: <b className="tabular-nums">{formatPrice(total)}</b>
                  </td>
                </tr>
              </tfoot>
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
