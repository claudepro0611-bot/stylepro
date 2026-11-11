'use client'

// Mijoz to'lovlari (payments received from wholesale customers): list,
// "accept payment" dialog and cancel (owner/admin). Writes go through
// prod_create_customer_payment / prod_cancel_customer_payment only.
// Route guard: proxy.ts ('prod_customer_payments').

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CreditCard, Search } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { monthToDate } from '@/components/reports/ReportKit'
import {
  DocStatusBadge, FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls, useOpenOnNewParam,
} from '@/components/production/ProdKit'
import { PaymentCancelButton, PaymentMethodBadge } from '@/components/production/SupplierKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { AccountName, useCashAccounts } from '@/components/production/CashKit'
import {
  CustomerPaymentDialog, useCancelCustomerPayment, useProdCustomers, useSalesAvailable,
} from '@/components/production/SalesKit'
import { PROD_PAYMENT_METHODS, paymentMethodKey } from '@/lib/production'
import type { CustomerPaymentRow } from '@/lib/sales'
import { ExportButton } from '@/components/production/ReportKit'
import { downloadXlsx, x2 } from '@/lib/production-reports'

const PAGE_SIZE = 25

export default function ProdCustomerPaymentsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const available = useSalesAvailable()
  const { customers, reload: reloadCustomers } = useProdCustomers()
  const { available: cashAvailable, accounts } = useCashAccounts()

  const [rows, setRows] = useState<CustomerPaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [customerId, setCustomerId] = useState('')
  const [method, setMethod] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialogOpen, setDialogOpen] = useState(false)
  // ?new=1 (dashboard "Tezkor amallar") opens the create dialog right away.
  const openDialog = useCallback(() => setDialogOpen(true), [])
  useOpenOnNewParam(openDialog, available === true)

  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers])

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await fetchAllRows<CustomerPaymentRow>((from, to) => {
      // '*' brings account_id once migration 20261110000016 is live.
      let q = supabase.from('prod_customer_payments').select('*')
      if (range) q = q.gte('pay_date', range.from).lte('pay_date', range.to)
      if (customerId) q = q.eq('customer_id', customerId)
      if (method) q = q.eq('method', method)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [available, range, customerId, method, status, t])

  useEffect(() => { load() }, [load])

  const reloadAll = useCallback(() => { load(); reloadCustomers() }, [load, reloadCustomers])
  const { canCancel, cancel, busyId } = useCancelCustomerPayment(reloadAll)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q)
      || (customerById.get(r.customer_id)?.name ?? '').toLowerCase().includes(q)
      || (r.note ?? '').toLowerCase().includes(q))
  }, [rows, search, customerById])

  const totalReceived = useMemo(() => filtered.filter(r => r.status === 'posted').reduce((s, r) => s + Number(r.amount), 0), [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function exportXlsx() {
    downloadXlsx('zavod_mijoz_tolovlari', [
      t('production.common.number'), t('production.common.date'), t('prodSales.common.customer'), t('production.suppliers.method'),
      `${t('production.suppliers.amount')} (UZS)`, t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(r => [
      r.number, r.pay_date, customerById.get(r.customer_id)?.name ?? '', t(paymentMethodKey(r.method)), x2(Number(r.amount)),
      r.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.created_by_name ?? '', r.note ?? '',
    ]), t('prodSales.payments.title'))
  }

  function reset() {
    setRange(monthToDate())
    setCustomerId('')
    setMethod('')
    setStatus('')
    setSearch('')
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodSales.payments.title')}
        subtitle={t('prodSales.payments.subtitle')}
        actionLabel={available ? t('prodSales.payments.new') : undefined}
        onAction={() => setDialogOpen(true)}
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={reset} columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />} moreActive={!!method || !!status} more={<>
            <select value={method} onChange={e => setMethod(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
              <option value="">{t('production.suppliers.allMethods')}</option>
              {PROD_PAYMENT_METHODS.map(m => <option key={m} value={m}>{t(paymentMethodKey(m))}</option>)}
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
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.common.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
          </FilterBar>

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodSales.payments.empty')} emptyIcon={CreditCard}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.number')}</th>
                  <th className={thCls}>{t('production.common.date')}</th>
                  <th className={thCls}>{t('prodSales.common.customer')}</th>
                  <th className={thRightCls}>{t('production.suppliers.amount')}</th>
                  <th className={thCls}>{t('production.suppliers.method')}</th>
                  {cashAvailable && <th className={thCls}>{t('prodCash.common.account')}</th>}
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
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(r.pay_date)}</td>
                    <td className={tdCls}>
                      <Link href={`/zavod-mijozlar/${r.customer_id}`} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
                        {customerById.get(r.customer_id)?.name ?? '—'}
                      </Link>
                    </td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.amount))}</td>
                    <td className={tdCls}><PaymentMethodBadge method={r.method} /></td>
                    {cashAvailable && <td className={tdCls}><AccountName accounts={accounts} id={r.account_id} /></td>}
                    <td className={tdCls}><DocStatusBadge status={r.status} /></td>
                    <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>
                    <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>{r.note ?? ''}</td>
                    <td className={tdCls}>
                      <PaymentCancelButton show={canCancel && r.status === 'posted'} busy={busyId === r.id} onClick={() => cancel(r.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-900 dark:text-gray-100">
                  <td colSpan={cashAvailable ? 10 : 9} className="px-4 py-3 text-right">
                    {t('prodSales.payments.totalReceived')}: <b className="tabular-nums">{formatPrice(totalReceived)}</b>
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

      <CustomerPaymentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        customers={customers}
        onSaved={() => { setDialogOpen(false); reloadAll() }}
      />
    </div>
  )
}
