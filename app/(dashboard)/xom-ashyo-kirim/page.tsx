'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Milk, PackagePlus, Search } from 'lucide-react'
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
import { useProdSuppliers } from '@/components/production/SupplierKit'
import { rangeToIsoBounds } from '@/lib/production'
import { localYmd } from '@/lib/utils/date'
import { formatYmd } from '@/components/production/LotPicker'
import { ExportButton } from '@/components/production/ReportKit'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25

interface Row {
  id: string
  number: number
  doc_date: string
  warehouse_id: string
  supplier_id: string | null
  supplier_name: string | null
  note: string | null
  total: number
  status: string
  created_by_name: string | null
  /** Migration 20261110000014; undefined while the column does not exist. */
  due_date?: string | null
}

const RECEIPT_COLS = 'id, number, doc_date, warehouse_id, supplier_id, supplier_name, note, total, status, created_by_name'

export default function ReceiptListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { warehouses, warehouseById } = useProdRefs()
  const { suppliers } = useProdSuppliers()
  const supplierNameById = useMemo(() => new Map(suppliers.map(s => [s.id, s.name])), [suppliers])
  // Live name via supplier_id (renames are not written back); snapshot otherwise.
  const supplierLabel = useCallback((r: Row) => (r.supplier_id && supplierNameById.get(r.supplier_id)) || r.supplier_name || '', [supplierNameById])

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
    const read = (cols: string) => fetchAllRows<Row>((from, to) => {
      let q = supabase.from('prod_receipts').select(cols)
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>
    })
    // due_date exists after migration 20261110000014; older schema -> without it.
    let res = await read(`${RECEIPT_COLS}, due_date`)
    if (res.error) res = await read(RECEIPT_COLS)
    const { data, error } = res
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [range, warehouseId, status, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('receipt', load)
  const { isVisible, toggle } = useHiddenColumns('xom-ashyo-kirim')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || supplierLabel(r).toLowerCase().includes(q))
  }, [rows, search, supplierLabel])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  // Receipts posted by Sut qabuli are cancelled through the intake
  // (prod_cancel_document rejects them): receipt id -> intake id.
  const [intakeByReceipt, setIntakeByReceipt] = useState<Map<string, string>>(new Map())
  const pageIds = paginated.map(r => r.id).join(',')
  useEffect(() => {
    if (!pageIds) { setIntakeByReceipt(new Map()); return }
    let cancelled = false
    createClient().from('prod_milk_intakes').select('id, receipt_id').in('receipt_id', pageIds.split(',')).neq('status', 'cancelled')
      .then(({ data }) => {
        if (cancelled) return
        setIntakeByReceipt(new Map((data ?? []).filter(i => i.receipt_id).map(i => [i.receipt_id as string, i.id])))
      })
    return () => { cancelled = true }
  }, [pageIds])

  const hasDue = rows.some(r => r.due_date)
  const today = localYmd()
  const columns = [
    { key: 'date', label: t('production.common.date') },
    { key: 'supplier', label: t('production.receipts.supplier') },
    { key: 'warehouse', label: t('production.common.warehouse') },
    { key: 'total', label: t('production.common.total') },
    ...(hasDue ? [{ key: 'due', label: t('prodInventory.ageing.dueDate') }] : []),
    { key: 'status', label: t('production.common.status') },
    { key: 'author', label: t('production.common.author') },
    { key: 'note', label: t('production.common.note') },
  ]

  function exportXlsx() {
    downloadXlsx('xom_ashyo_kirim', [
      t('production.common.number'), t('production.common.date'), t('production.receipts.supplier'), t('production.common.warehouse'),
      `${t('production.common.total')} (UZS)`, t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, dateTimeCell(r.doc_date), supplierLabel(r), warehouseById.get(r.warehouse_id)?.name ?? '', x2(Number(r.total)),
      r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('production.receipts.title'))
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
        title={t('production.receipts.title')}
        subtitle={t('production.receipts.subtitle')}
        actionLabel={t('production.receipts.new')}
        actionHref="/xom-ashyo-kirim/yangi"
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
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.receipts.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.receipts.empty')} emptyIcon={PackagePlus}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.number')}</th>
              {isVisible('date') && <th className={thCls}>{t('production.common.date')}</th>}
              {isVisible('supplier') && <th className={thCls}>{t('production.receipts.supplier')}</th>}
              {isVisible('warehouse') && <th className={thCls}>{t('production.common.warehouse')}</th>}
              {isVisible('total') && <th className={thRightCls}>{t('production.common.total')}</th>}
              {hasDue && isVisible('due') && <th className={thCls}>{t('prodInventory.ageing.dueDate')}</th>}
              {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
              {isVisible('author') && <th className={thCls}>{t('production.common.author')}</th>}
              {isVisible('note') && <th className={thCls}>{t('production.common.note')}</th>}
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => (
              <tr key={r.id} onClick={() => router.push(`/xom-ashyo-kirim/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                {isVisible('date') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>}
                {isVisible('supplier') && <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{supplierLabel(r) || '—'}</td>}
                {isVisible('warehouse') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(r.warehouse_id)?.name ?? '—'}</td>}
                {isVisible('total') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.total))}</td>}
                {hasDue && isVisible('due') && (
                  <td className={cn(tdCls, 'whitespace-nowrap', r.due_date && r.status === 'posted' && r.due_date < today ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>
                    {r.due_date ? formatYmd(r.due_date) : '—'}
                  </td>
                )}
                {isVisible('status') && <td className={tdCls}><DocStatusBadge status={r.status} /></td>}
                {isVisible('author') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>}
                {isVisible('note') && <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>{r.note ?? ''}</td>}
                <td className={tdCls}>
                  <div className="flex items-center justify-end gap-1">
                    {intakeByReceipt.has(r.id) && (
                      <Link
                        href={`/sut-qabuli/${intakeByReceipt.get(r.id)}`}
                        onClick={e => e.stopPropagation()}
                        title={t('production.milk.openIntake')}
                        aria-label={t('production.milk.openIntake')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                      >
                        <Milk className="h-3.5 w-3.5" />
                      </Link>
                    )}
                    <DocActions
                      viewHref={`/xom-ashyo-kirim/${r.id}`}
                      canCancel={canCancel && !intakeByReceipt.has(r.id)}
                      posted={r.status === 'posted'}
                      busy={busyId === r.id}
                      onCancel={() => cancel(r.id)}
                    />
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
    </div>
  )
}
