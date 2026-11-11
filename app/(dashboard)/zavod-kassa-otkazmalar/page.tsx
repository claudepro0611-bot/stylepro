'use client'

// Pul o'tkazmalari: transfers between cash / bank / card accounts, create
// dialog and cancel (owner/admin). Writes go through
// prod_create_cash_transfer / prod_cancel_cash_doc('cash_transfer') only.
// Route guard: proxy.ts ('prod_cash').

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, ArrowRight, Ban, Loader2, Search } from 'lucide-react'
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
import { AccountName, CashTransferDialog, useCancelCashDoc, useCashAccounts } from '@/components/production/CashKit'
import { downloadXlsx, x2, ymdOf } from '@/lib/production-reports'
import { rangeToIsoBounds } from '@/lib/production'
import type { CashTransferRow } from '@/lib/cash'

const PAGE_SIZE = 25

export default function CashTransfersPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { available, accounts, reload: reloadAccounts } = useCashAccounts()

  const [rows, setRows] = useState<CashTransferRow[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [accountId, setAccountId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialogOpen, setDialogOpen] = useState(false)

  const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    // doc_date is timestamptz: local-day bounds.
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<CashTransferRow>((from, to) => {
      let q = supabase.from('prod_cash_transfers').select('*')
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (accountId) q = q.or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`)
      if (status) q = q.eq('status', status)
      return q.order('doc_date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [available, range, accountId, status, t])

  useEffect(() => { load() }, [load])

  const reloadAll = useCallback(() => { load(); reloadAccounts() }, [load, reloadAccounts])
  const { canCancel, cancel, busyId } = useCancelCashDoc('cash_transfer', reloadAll)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || (r.note ?? '').toLowerCase().includes(q))
  }, [rows, search])

  const total = useMemo(() => filtered.filter(r => r.status === 'posted').reduce((s, r) => s + Number(r.amount), 0), [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function exportXlsx() {
    downloadXlsx('pul_otkazmalari', [
      t('production.common.number'), t('production.common.date'), t('prodCash.transfers.from'), t('prodCash.transfers.to'),
      `${t('prodCash.common.amount')} (UZS)`, t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, ymdOf(r.doc_date), accountById.get(r.from_account_id)?.name ?? '', accountById.get(r.to_account_id)?.name ?? '', x2(Number(r.amount)),
      r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('prodCash.transfers.title'))
  }

  function reset() {
    setRange(monthToDate())
    setAccountId('')
    setStatus('')
    setSearch('')
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodCash.transfers.title')}
        subtitle={t('prodCash.transfers.subtitle')}
        actionLabel={available ? t('prodCash.transfers.new') : undefined}
        onAction={() => setDialogOpen(true)}
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={reset} columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />}>
            <DateRangeFilter value={range} onChange={setRange} />
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

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodCash.transfers.empty')} emptyIcon={ArrowLeftRight}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.number')}</th>
                  <th className={thCls}>{t('production.common.date')}</th>
                  <th className={thCls}>{t('prodCash.transfers.from')}</th>
                  <th className="w-6" />
                  <th className={thCls}>{t('prodCash.transfers.to')}</th>
                  <th className={thRightCls}>{t('prodCash.common.amount')}</th>
                  <th className={thCls}>{t('production.common.status')}</th>
                  <th className={thCls}>{t('production.common.author')}</th>
                  <th className={thCls}>{t('production.common.note')}</th>
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr key={r.id} className={cn(trCls, r.status === 'cancelled' && 'opacity-60')}>
                    <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>
                    <td className={tdCls}><AccountName accounts={accounts} id={r.from_account_id} /></td>
                    <td className="py-2.5"><ArrowRight className="h-3.5 w-3.5 text-gray-300 dark:text-gray-600" /></td>
                    <td className={tdCls}><AccountName accounts={accounts} id={r.to_account_id} /></td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.amount))}</td>
                    <td className={tdCls}><DocStatusBadge status={r.status} /></td>
                    <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>
                    <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>{r.note ?? ''}</td>
                    <td className={tdCls}>
                      {canCancel && r.status === 'posted' && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => cancel(r.id)}
                            disabled={busyId === r.id}
                            aria-label={t('production.common.cancelDoc')}
                            title={t('production.common.cancelDoc')}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors"
                          >
                            {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-900 dark:text-gray-100">
                  <td colSpan={10} className="px-4 py-3 text-right">
                    {t('prodCash.transfers.total')}: <b className="tabular-nums">{formatPrice(total)}</b>
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

      <CashTransferDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        accounts={accounts}
        onSaved={() => { setDialogOpen(false); reloadAll() }}
      />
    </div>
  )
}
