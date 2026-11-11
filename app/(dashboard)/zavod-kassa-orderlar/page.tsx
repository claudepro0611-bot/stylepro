'use client'

// Kassa orderlari: manual cash-in (PKO) / cash-out (RKO) orders, create
// dialog, print and cancel (owner/admin). Writes go through
// prod_create_cash_order / prod_cancel_cash_doc('cash_order') only.
// Route guard: proxy.ts ('prod_cash').

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, Loader2, Printer, Receipt, Search } from 'lucide-react'
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
  DocStatusBadge, FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { ExportButton } from '@/components/production/ReportKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import {
  AccountName, CashOrderDialog, CashOrderPrint, useCancelCashDoc, useCashAccounts, useExpenseCategories,
} from '@/components/production/CashKit'
import { downloadXlsx, x2, ymdOf } from '@/lib/production-reports'
import { rangeToIsoBounds } from '@/lib/production'
import type { CashOrderRow } from '@/lib/cash'

const PAGE_SIZE = 25

const iconBtn = 'flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors disabled:opacity-40'

export default function CashOrdersPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { available, accounts, reload: reloadAccounts } = useCashAccounts()
  const categories = useExpenseCategories(!!available)

  const [rows, setRows] = useState<CashOrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [direction, setDirection] = useState('')
  const [accountId, setAccountId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [printing, setPrinting] = useState<CashOrderRow | null>(null)

  const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c.name])), [categories])

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    // doc_date is timestamptz: local-day bounds.
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<CashOrderRow>((from, to) => {
      let q = supabase.from('prod_cash_orders').select('*')
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (direction) q = q.eq('direction', direction)
      if (accountId) q = q.eq('account_id', accountId)
      if (status) q = q.eq('status', status)
      return q.order('doc_date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [available, range, direction, accountId, status, t])

  useEffect(() => { load() }, [load])

  const reloadAll = useCallback(() => { load(); reloadAccounts() }, [load, reloadAccounts])
  const { canCancel, cancel, busyId } = useCancelCashDoc('cash_order', reloadAll)

  // Print the selected order, then drop the print sheet.
  useEffect(() => {
    if (!printing) return
    const done = () => setPrinting(null)
    window.addEventListener('afterprint', done, { once: true })
    const id = window.setTimeout(() => window.print(), 50)
    return () => { window.clearTimeout(id); window.removeEventListener('afterprint', done) }
  }, [printing])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q)
      || (r.counterparty_name ?? '').toLowerCase().includes(q)
      || (r.purpose ?? '').toLowerCase().includes(q)
      || (r.note ?? '').toLowerCase().includes(q))
  }, [rows, search])

  const totals = useMemo(() => {
    const posted = filtered.filter(r => r.status === 'posted')
    return {
      in: posted.filter(r => r.direction === 'in').reduce((s, r) => s + Number(r.amount), 0),
      out: posted.filter(r => r.direction === 'out').reduce((s, r) => s + Number(r.amount), 0),
    }
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const dirLabel = (d: string) => (d === 'out' ? t('prodCash.common.out') : t('prodCash.common.in'))

  function exportXlsx() {
    downloadXlsx('kassa_orderlari', [
      t('production.common.number'), t('production.common.date'), t('prodCash.orders.direction'), t('prodCash.common.account'),
      `${t('prodCash.common.amount')} (UZS)`, t('prodCash.common.counterparty'), t('prodCash.common.category'), t('prodCash.common.purpose'),
      t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, ymdOf(r.doc_date), dirLabel(r.direction), accountById.get(r.account_id)?.name ?? '', x2(Number(r.amount)),
      r.counterparty_name ?? '', (r.category_id && categoryById.get(r.category_id)) || '', r.purpose ?? '',
      r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('prodCash.orders.title'))
  }

  function reset() {
    setRange(monthToDate())
    setDirection('')
    setAccountId('')
    setStatus('')
    setSearch('')
  }

  return (
    <div className="space-y-5">
      <div className="space-y-5 print:hidden">
        <PageHeader
          title={t('prodCash.orders.title')}
          subtitle={t('prodCash.orders.subtitle')}
          actionLabel={available ? t('prodCash.orders.new') : undefined}
          onAction={() => setDialogOpen(true)}
        />

        {available === false ? <NotAvailableNote /> : (
          <>
            <FilterBar onReset={reset} columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />}>
              <DateRangeFilter value={range} onChange={setRange} />
              <select value={direction} onChange={e => setDirection(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
                <option value="">{t('prodCash.orders.allDirections')}</option>
                <option value="in">{t('prodCash.common.in')}</option>
                <option value="out">{t('prodCash.common.out')}</option>
              </select>
              <select value={accountId} onChange={e => setAccountId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
                <option value="">{t('prodCash.common.allAccounts')}</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
                <option value="">{t('production.common.allStatuses')}</option>
                <option value="posted">{t('production.common.statusPosted')}</option>
                <option value="cancelled">{t('production.common.statusCancelled')}</option>
              </select>
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.common.search')} className={cn(prodFieldCls, 'pl-9')} />
              </div>
            </FilterBar>

            <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodCash.orders.empty')} emptyIcon={Receipt}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className={thCls}>{t('production.common.number')}</th>
                    <th className={thCls}>{t('production.common.date')}</th>
                    <th className={thCls}>{t('prodCash.orders.direction')}</th>
                    <th className={thCls}>{t('prodCash.common.account')}</th>
                    <th className={thRightCls}>{t('prodCash.common.amount')}</th>
                    <th className={thCls}>{t('prodCash.common.counterparty')}</th>
                    <th className={thCls}>{t('prodCash.common.purpose')}</th>
                    <th className={thCls}>{t('production.common.status')}</th>
                    <th className={thCls}>{t('production.common.author')}</th>
                    <th className={thRightCls}>{t('production.common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map(r => (
                    <tr key={r.id} className={cn(trCls, r.status === 'cancelled' && 'opacity-60')}>
                      <td className={cn(tdCls, 'whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{r.direction === 'out' ? t('prodCash.orders.rkoShort') : t('prodCash.orders.pkoShort')} #{r.number}</td>
                      <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>
                      <td className={tdCls}>
                        <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">{dirLabel(r.direction)}</span>
                      </td>
                      <td className={tdCls}><AccountName accounts={accounts} id={r.account_id} /></td>
                      <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium', r.direction === 'out' ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                        {r.direction === 'out' ? '−' : '+'}{formatPrice(Number(r.amount))}
                      </td>
                      <td className={cn(tdCls, 'max-w-[180px] truncate text-gray-700 dark:text-gray-300')}>{r.counterparty_name || '—'}</td>
                      <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>
                        {r.purpose || '—'}
                        {r.category_id && categoryById.get(r.category_id) && <p className="text-[12px] text-gray-400 dark:text-gray-500">{categoryById.get(r.category_id)}</p>}
                      </td>
                      <td className={tdCls}><DocStatusBadge status={r.status} /></td>
                      <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>
                      <td className={tdCls}>
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => setPrinting(r)} aria-label={t('prodReports.print.print')} title={t('prodReports.print.print')} className={cn(iconBtn, 'hover:text-gray-900 dark:hover:text-gray-100')}>
                            <Printer className="h-3.5 w-3.5" />
                          </button>
                          {canCancel && r.status === 'posted' && (
                            <button type="button" onClick={() => cancel(r.id)} disabled={busyId === r.id} aria-label={t('production.common.cancelDoc')} title={t('production.common.cancelDoc')} className={cn(iconBtn, 'hover:text-red-600 dark:hover:text-red-400')}>
                              {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-900 dark:text-gray-100">
                    <td colSpan={10} className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-x-6 gap-y-1">
                        <span>{t('prodCash.orders.totalIn')}: <b className="tabular-nums">{formatPrice(totals.in)}</b></span>
                        <span>{t('prodCash.orders.totalOut')}: <b className="tabular-nums">{formatPrice(totals.out)}</b></span>
                      </div>
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

      {printing && (
        <CashOrderPrint
          order={printing}
          accountName={accountById.get(printing.account_id)?.name ?? ''}
          categoryName={(printing.category_id && categoryById.get(printing.category_id)) || ''}
        />
      )}

      <CashOrderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        accounts={accounts}
        categories={categories}
        onSaved={() => { setDialogOpen(false); reloadAll() }}
      />
    </div>
  )
}
