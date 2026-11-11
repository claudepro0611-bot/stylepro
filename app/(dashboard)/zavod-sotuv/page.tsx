'use client'

// Sotuv (wholesale sales / nakladnoy of the production module): list with
// filters (period, customer, warehouse, status), totals and export. Writes:
// prod_create_sale (yangi) and prod_cancel_document('sale'). Shows a note
// while migration 20261110000015 is not applied.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Receipt, Search } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { monthToDate } from '@/components/reports/ReportKit'
import {
  ColumnSettings, DocActions, DocStatusBadge, FilterBar, PageHeader, TableCard, useHiddenColumns,
  prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { ManualPickBadge, usePickDeviations } from '@/components/production/ControlKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { ExportButton } from '@/components/production/ReportKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useProdCustomers, useSalesAvailable, useSeesMargin } from '@/components/production/SalesKit'
import { rangeToIsoBounds, round2 } from '@/lib/production'
import { SALE_COLS, formatMarginPct, marginPct, type SaleRow } from '@/lib/sales'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25

export default function SalesListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useSalesAvailable()
  const seesMargin = useSeesMargin()
  const { warehouses, warehouseById } = useProdRefs()
  const { customers } = useProdCustomers()

  const [rows, setRows] = useState<SaleRow[]>([])
  const pickDeviations = usePickDeviations('prod_sales', useMemo(() => rows.map(r => r.id), [rows]))
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [customerId, setCustomerId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers])

  // ?customer=<id> (from the customer card) only on the client.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('customer')
    if (c) setCustomerId(c)
  }, [])

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<SaleRow>((from, to) => {
      let q = supabase.from('prod_sales').select(SALE_COLS)
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (customerId) q = q.eq('customer_id', customerId)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [available, range, customerId, warehouseId, status, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('sale', load)
  const { isVisible, toggle } = useHiddenColumns('zavod-sotuv')
  const nameOf = useCallback((id: string) => customerById.get(id)?.name ?? '—', [customerById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || nameOf(r.customer_id).toLowerCase().includes(q)
      || (r.vehicle_no ?? '').toLowerCase().includes(q) || (r.driver ?? '').toLowerCase().includes(q) || (r.note ?? '').toLowerCase().includes(q))
  }, [rows, search, nameOf])

  const totals = useMemo(() => {
    const posted = filtered.filter(r => r.status === 'posted')
    const sum = (f: (r: SaleRow) => number) => round2(posted.reduce((s, r) => s + f(r), 0))
    return { count: posted.length, subtotal: sum(r => Number(r.subtotal)), vat: sum(r => Number(r.vat_amount)), total: sum(r => Number(r.total)), margin: sum(r => Number(r.margin)) }
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const today = localYmd()

  const columns = [
    { key: 'date', label: t('production.common.date') },
    { key: 'warehouse', label: t('production.common.warehouse') },
    { key: 'due', label: t('prodInventory.ageing.dueDate') },
    { key: 'subtotal', label: t('prodSales.common.subtotal') },
    { key: 'vat', label: t('prodSales.common.vat') },
    { key: 'total', label: t('prodSales.common.totalWithVat') },
    ...(seesMargin ? [{ key: 'margin', label: t('prodSales.common.margin') }] : []),
    { key: 'vehicle', label: t('prodSales.common.vehicle') },
    { key: 'status', label: t('production.common.status') },
    { key: 'author', label: t('production.common.author') },
  ]
  const show = (k: string) => isVisible(k) && (k !== 'margin' || seesMargin)

  function exportXlsx() {
    downloadXlsx('zavod_sotuv', [
      t('production.common.number'), t('production.common.date'), t('prodSales.common.customer'), t('prodSales.common.inn'), t('production.common.warehouse'),
      t('prodInventory.ageing.dueDate'), t('prodSales.common.vatRate'), `${t('prodSales.common.subtotal')} (UZS)`, `${t('prodSales.common.vat')} (UZS)`,
      `${t('prodSales.common.totalWithVat')} (UZS)`,
      ...(seesMargin ? [`${t('prodSales.common.cost')} (UZS)`, `${t('prodSales.common.margin')} (UZS)`] : []),
      t('prodSales.common.vehicle'), t('prodSales.common.driver'), t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), nameOf(r.customer_id), customerById.get(r.customer_id)?.inn ?? '', warehouseById.get(r.warehouse_id)?.name ?? '',
      r.due_date ?? '', Number(r.vat_rate), x2(Number(r.subtotal)), x2(Number(r.vat_amount)), x2(Number(r.total)),
      ...(seesMargin ? [x2(Number(r.cost_total)), x2(Number(r.margin))] : []),
      r.vehicle_no ?? '', r.driver ?? '', r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'),
      r.created_by_name ?? '', r.note ?? '',
    ]), t('prodSales.sales.title'))
  }

  function reset() {
    setRange(monthToDate())
    setCustomerId('')
    setWarehouseId('')
    setStatus('')
    setSearch('')
  }

  const money = (n: number) => <span className="tabular-nums">{formatPrice(n)}</span>

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodSales.sales.title')}
        subtitle={t('prodSales.sales.subtitle')}
        actionLabel={available ? t('prodSales.sales.new') : undefined}
        actionHref="/zavod-sotuv/yangi"
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={reset} columns={<><ExportButton onClick={exportXlsx} disabled={filtered.length === 0} /><ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} /></>} moreActive={!!warehouseId || !!status} more={<>
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

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodSales.sales.empty')} emptyIcon={Receipt}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.number')}</th>
                  {show('date') && <th className={thCls}>{t('production.common.date')}</th>}
                  <th className={thCls}>{t('prodSales.common.customer')}</th>
                  {show('warehouse') && <th className={thCls}>{t('production.common.warehouse')}</th>}
                  {show('due') && <th className={thCls}>{t('prodInventory.ageing.dueDate')}</th>}
                  {show('subtotal') && <th className={thRightCls}>{t('prodSales.common.subtotal')}</th>}
                  {show('vat') && <th className={thRightCls}>{t('prodSales.common.vat')}</th>}
                  {show('total') && <th className={thRightCls}>{t('prodSales.common.totalWithVat')}</th>}
                  {show('margin') && <th className={thRightCls}>{t('prodSales.common.margin')}</th>}
                  {show('vehicle') && <th className={thCls}>{t('prodSales.common.vehicle')}</th>}
                  {show('status') && <th className={thCls}>{t('production.common.status')}</th>}
                  {show('author') && <th className={thCls}>{t('production.common.author')}</th>}
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => {
                  const overdue = r.status === 'posted' && !!r.due_date && r.due_date < today
                  return (
                    <tr key={r.id} onClick={() => router.push(`/zavod-sotuv/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                      <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                      {show('date') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>}
                      <td className={tdCls} onClick={e => e.stopPropagation()}>
                        <Link href={`/zavod-mijozlar/${r.customer_id}`} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">{nameOf(r.customer_id)}</Link>
                      </td>
                      {show('warehouse') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(r.warehouse_id)?.name ?? '—'}</td>}
                      {show('due') && (
                        <td className={cn(tdCls, 'whitespace-nowrap', overdue ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>
                          {r.due_date ? formatDate(r.due_date) : '—'}
                        </td>
                      )}
                      {show('subtotal') && <td className={cn(tdCls, 'text-right whitespace-nowrap text-gray-700 dark:text-gray-300')}>{money(Number(r.subtotal))}</td>}
                      {show('vat') && <td className={cn(tdCls, 'text-right whitespace-nowrap text-gray-500 dark:text-gray-400')}>{Number(r.vat_amount) ? money(Number(r.vat_amount)) : '—'}</td>}
                      {show('total') && <td className={cn(tdCls, 'text-right whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{money(Number(r.total))}</td>}
                      {show('margin') && (
                        <td className={cn(tdCls, 'text-right whitespace-nowrap', Number(r.margin) < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300')}>
                          {money(Number(r.margin))}
                          <span className="ml-1 text-[11px] text-gray-400 dark:text-gray-500">{formatMarginPct(marginPct(Number(r.margin), Number(r.subtotal)))}</span>
                        </td>
                      )}
                      {show('vehicle') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{r.vehicle_no || '—'}</td>}
                      {show('status') && <td className={tdCls}><span className="inline-flex flex-wrap items-center gap-1"><DocStatusBadge status={r.status} /><ManualPickBadge show={pickDeviations.has(r.id)} /></span></td>}
                      {show('author') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>}
                      <td className={tdCls}>
                        <DocActions viewHref={`/zavod-sotuv/${r.id}`} canCancel={canCancel} posted={r.status === 'posted'} busy={busyId === r.id} onCancel={() => cancel(r.id)} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
              <span className="text-gray-500 dark:text-gray-400">{t('prodSales.sales.postedCount')}: <b className="tabular-nums text-gray-900 dark:text-gray-100">{totals.count}</b></span>
              <span className="text-gray-500 dark:text-gray-400">{t('prodSales.common.subtotal')}: <b className="tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(totals.subtotal)}</b></span>
              <span className="text-gray-500 dark:text-gray-400">{t('prodSales.common.vat')}: <b className="tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(totals.vat)}</b></span>
              <span className="text-gray-500 dark:text-gray-400">{t('prodSales.common.totalWithVat')}: <b className="tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(totals.total)}</b></span>
              {seesMargin && (
                <span className="text-gray-500 dark:text-gray-400">
                  {t('prodSales.common.margin')}: <b className="tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(totals.margin)}</b> ({formatMarginPct(marginPct(totals.margin, totals.subtotal))})
                </span>
              )}
            </div>
          </TableCard>
          {filtered.length > PAGE_SIZE && (
            <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
          )}
        </>
      )}
    </div>
  )
}
