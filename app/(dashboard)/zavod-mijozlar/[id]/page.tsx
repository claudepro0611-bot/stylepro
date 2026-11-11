'use client'

// Customer card: requisites, balance / ageing KPIs and tabs with the
// customer's sales, returns, payments and a running-balance ledger
// (sale = debit, return / payment = credit; posted documents only).

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { AlarmClock, Banknote, CreditCard, FileText, Loader2, Pencil, Plus, Receipt, Undo2, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { KpiGrid } from '@/components/reports/ReportKit'
import {
  ActiveBadge, BackLink, DocActions, DocStatusBadge, InfoField, Segmented, TableCard,
  prodCardCls, secondaryBtnCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useHasPermission } from '@/components/production/MilkKit'
import { PaymentCancelButton, PaymentMethodBadge } from '@/components/production/SupplierKit'
import {
  BalanceValue, CustomerFormDialog, CustomerPaymentDialog, useCancelCustomerPayment, usePriceLists, useProdCustomers, useSalesAvailable,
} from '@/components/production/SalesKit'
import {
  CUSTOMER_PAYMENT_COLS, RETURN_COLS, SALE_COLS, overdueOf,
  type CustomerPaymentRow, type ReturnRow, type SaleRow,
} from '@/lib/sales'

type Tab = 'sales' | 'returns' | 'payments' | 'ledger'

interface LedgerRow { key: string; ymd: string; sortTs: string; href: string | null; label: string; debit: number; credit: number; balance: number }

export default function ProdCustomerViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useSalesAvailable()
  const { warehouseById } = useProdRefs()
  const { customers, ageing, loading: customersLoading, reload: reloadCustomers } = useProdCustomers()
  const { lists } = usePriceLists()
  const canPay = useHasPermission('prod_customer_payments')

  const [tab, setTab] = useState<Tab>('sales')
  const [sales, setSales] = useState<SaleRow[]>([])
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [payments, setPayments] = useState<CustomerPaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)

  const customer = customers.find(c => c.id === id) ?? null
  const age = ageing?.get(id)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [sRes, rRes, pRes] = await Promise.all([
      fetchAllRows<SaleRow>((from, to) => supabase.from('prod_sales').select(SALE_COLS).eq('customer_id', id).order('number', { ascending: false }).range(from, to)),
      fetchAllRows<ReturnRow>((from, to) => supabase.from('prod_sale_returns').select(RETURN_COLS).eq('customer_id', id).order('number', { ascending: false }).range(from, to)),
      fetchAllRows<CustomerPaymentRow>((from, to) => supabase.from('prod_customer_payments').select(CUSTOMER_PAYMENT_COLS).eq('customer_id', id).order('number', { ascending: false }).range(from, to)),
    ])
    if (sRes.error || rRes.error || pRes.error) toast.error(t('productionErrors.unknown'))
    setSales(sRes.data)
    setReturns(rRes.data)
    setPayments(pRes.data)
    setLoading(false)
  }, [id, t])

  useEffect(() => { if (available) load() }, [available, load])

  const reloadAll = useCallback(() => { load(); reloadCustomers() }, [load, reloadCustomers])
  const { canCancel: canCancelSale, cancel: cancelSale, busyId: saleBusyId } = useCancelDoc('sale', reloadAll)
  const { canCancel: canCancelReturn, cancel: cancelReturn, busyId: returnBusyId } = useCancelDoc('sale_return', reloadAll)
  const { canCancel: canCancelPayment, cancel: cancelPayment, busyId: paymentBusyId } = useCancelCustomerPayment(reloadAll)

  const saleNo = useMemo(() => new Map(sales.map(s => [s.id, s.number])), [sales])

  const ledger = useMemo<LedgerRow[]>(() => {
    const entries = [
      ...sales.filter(s => s.status === 'posted').map(s => ({
        key: `s-${s.id}`, ymd: localYmd(new Date(s.doc_date)), sortTs: s.doc_date, href: `/zavod-sotuv/${s.id}`,
        label: `${t('prodSales.customers.saleDoc')} #${s.number}`, debit: Number(s.total), credit: 0,
      })),
      ...returns.filter(r => r.status === 'posted').map(r => ({
        key: `r-${r.id}`, ymd: localYmd(new Date(r.doc_date)), sortTs: r.doc_date, href: `/zavod-qaytarishlar/${r.id}`,
        label: `${t('prodSales.customers.returnDoc')} #${r.number}${saleNo.has(r.sale_id) ? ` · ${t('prodSales.customers.saleDoc')} #${saleNo.get(r.sale_id)}` : ''}`,
        debit: 0, credit: Number(r.total),
      })),
      ...payments.filter(p => p.status === 'posted').map(p => ({
        key: `p-${p.id}`, ymd: p.pay_date, sortTs: p.created_at, href: null,
        label: `${t('prodSales.customers.paymentDoc')} #${p.number}`, debit: 0, credit: Number(p.amount),
      })),
    ].sort((a, b) => a.ymd.localeCompare(b.ymd) || a.sortTs.localeCompare(b.sortTs))
    const out: LedgerRow[] = []
    for (const e of entries) {
      const prev = out.length ? out[out.length - 1].balance : 0
      out.push({ ...e, balance: Math.round((prev + e.debit - e.credit) * 100) / 100 })
    }
    return out
  }, [sales, returns, payments, saleNo, t])

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-mijozlar" label={t('prodSales.customers.title')} />
        <NotAvailableNote />
      </div>
    )
  }
  if (customersLoading || available === null) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!customer) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-mijozlar" label={t('prodSales.customers.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const debitTotal = ledger.reduce((s, e) => s + e.debit, 0)
  const creditTotal = ledger.reduce((s, e) => s + e.credit, 0)
  const overdue = overdueOf(age)
  const priceListName = customer.priceListId ? lists.find(l => l.id === customer.priceListId)?.name ?? '—' : t('prodSales.common.defaultPriceList')
  const money = (n: number) => <span className="tabular-nums">{formatPrice(n)}</span>

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-mijozlar" label={t('prodSales.customers.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{customer.name}</h1>
          <ActiveBadge active={customer.isActive} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/zavod-mijozlar/${customer.id}/akt-sverka`} className={secondaryBtnCls}>
            <FileText className="h-3.5 w-3.5" /> {t('aktSverka.title')}
          </Link>
          <Button variant="outline" onClick={() => setFormOpen(true)}>
            <Pencil className="h-3.5 w-3.5" /> {t('production.common.edit')}
          </Button>
          {canPay && (
            <Button variant="outline" onClick={() => setPayOpen(true)}>
              <Banknote className="h-3.5 w-3.5" /> {t('prodSales.payments.new')}
            </Button>
          )}
          {customer.isActive && (
            <Button onClick={() => router.push(`/zavod-sotuv/yangi?customer=${customer.id}`)}>
              <Plus className="h-3.5 w-3.5" /> {t('prodSales.sales.new')}
            </Button>
          )}
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4')}>
        <InfoField label={t('prodSales.common.legalName')}>{customer.legalName || '—'}</InfoField>
        <InfoField label={t('prodSales.common.inn')}><span className="tabular-nums">{customer.inn || '—'}</span></InfoField>
        <InfoField label={t('production.suppliers.phone')}>{customer.phone || '—'}</InfoField>
        <InfoField label={t('prodSales.common.contactPerson')}>{customer.contactPerson || '—'}</InfoField>
        <InfoField label={t('production.suppliers.address')}>{customer.address || '—'}</InfoField>
        <InfoField label={t('prodSales.common.priceList')}>{priceListName}</InfoField>
        <InfoField label={t('prodSales.common.creditLimit')}>{customer.creditLimit === null ? '—' : money(customer.creditLimit)}</InfoField>
        <InfoField label={t('prodInventory.ageing.paymentTerms')}>
          {customer.paymentTermsDays === null ? '—' : `${customer.paymentTermsDays} ${t('prodInventory.ageing.days')}`}
        </InfoField>
        <InfoField label={t('prodSales.common.vatPayer')}>{customer.vatPayer ? t('prodSales.common.yes') : t('prodSales.common.no')}</InfoField>
        <InfoField label={t('prodSales.customers.lastSale')}>{customer.lastSaleAt ? formatDate(customer.lastSaleAt) : '—'}</InfoField>
        {customer.note && (
          <div className="col-span-2 lg:col-span-4">
            <InfoField label={t('production.common.note')}><span className="whitespace-pre-wrap font-normal">{customer.note}</span></InfoField>
          </div>
        )}
      </div>

      <KpiGrid items={[
        { label: t('prodSales.customers.sold'), value: formatPrice(customer.salesTotal), icon: Receipt },
        { label: t('prodSales.customers.returnedAndPaid'), value: formatPrice(customer.returnsTotal + customer.paymentsTotal), icon: CreditCard },
        customer.balance < 0
          ? { label: t('prodSales.common.advance'), value: formatPrice(-customer.balance), icon: Wallet, tone: 'positive' as const }
          : { label: t('prodSales.common.balance'), value: formatPrice(customer.balance), icon: Wallet, tone: customer.balance > 0 ? 'negative' as const : undefined },
        { label: t('prodSales.common.overdueDebt'), value: formatPrice(overdue), icon: AlarmClock, tone: overdue > 0 ? 'negative' as const : undefined },
      ]} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          options={[
            { value: 'sales' as const, label: `${t('prodSales.customers.tabSales')} (${sales.length})` },
            { value: 'returns' as const, label: `${t('prodSales.customers.tabReturns')} (${returns.length})` },
            { value: 'payments' as const, label: `${t('prodSales.customers.tabPayments')} (${payments.length})` },
            { value: 'ledger' as const, label: t('prodSales.customers.tabLedger') },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'ledger' && <span className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.suppliers.postedOnly')}</span>}
      </div>

      {tab === 'sales' && (
        <TableCard loading={loading} empty={sales.length === 0} emptyText={t('prodSales.sales.empty')} emptyIcon={Receipt}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.number')}</th>
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thCls}>{t('production.common.warehouse')}</th>
                <th className={thCls}>{t('prodInventory.ageing.dueDate')}</th>
                <th className={thRightCls}>{t('prodSales.common.totalWithVat')}</th>
                <th className={thCls}>{t('production.common.status')}</th>
                <th className={thRightCls}>{t('production.common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sales.map(s => (
                <tr key={s.id} onClick={() => router.push(`/zavod-sotuv/${s.id}`)} className={cn(trCls, 'cursor-pointer', s.status === 'cancelled' && 'opacity-60')}>
                  <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{s.number}</td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(s.doc_date)}</td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(s.warehouse_id)?.name ?? '—'}</td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{s.due_date ? formatDate(s.due_date) : '—'}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(s.total))}</td>
                  <td className={tdCls}><DocStatusBadge status={s.status} /></td>
                  <td className={tdCls}>
                    <DocActions viewHref={`/zavod-sotuv/${s.id}`} canCancel={canCancelSale} posted={s.status === 'posted'} busy={saleBusyId === s.id} onCancel={() => cancelSale(s.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      {tab === 'returns' && (
        <TableCard loading={loading} empty={returns.length === 0} emptyText={t('prodSales.returns.empty')} emptyIcon={Undo2}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.number')}</th>
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thCls}>{t('prodSales.returns.sale')}</th>
                <th className={thCls}>{t('production.common.warehouse')}</th>
                <th className={thRightCls}>{t('prodSales.returns.credit')}</th>
                <th className={thCls}>{t('production.common.status')}</th>
                <th className={thRightCls}>{t('production.common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {returns.map(r => (
                <tr key={r.id} onClick={() => router.push(`/zavod-qaytarishlar/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                  <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{saleNo.has(r.sale_id) ? `#${saleNo.get(r.sale_id)}` : '—'}</td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(r.warehouse_id)?.name ?? '—'}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.total))}</td>
                  <td className={tdCls}><DocStatusBadge status={r.status} /></td>
                  <td className={tdCls}>
                    <DocActions viewHref={`/zavod-qaytarishlar/${r.id}`} canCancel={canCancelReturn} posted={r.status === 'posted'} busy={returnBusyId === r.id} onCancel={() => cancelReturn(r.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      {tab === 'payments' && (
        <TableCard loading={loading} empty={payments.length === 0} emptyText={t('prodSales.payments.empty')} emptyIcon={CreditCard}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.number')}</th>
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thRightCls}>{t('production.suppliers.amount')}</th>
                <th className={thCls}>{t('production.suppliers.method')}</th>
                <th className={thCls}>{t('production.common.status')}</th>
                <th className={thCls}>{t('production.common.author')}</th>
                <th className={thCls}>{t('production.common.note')}</th>
                <th className={thRightCls}>{t('production.common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id} className={cn(trCls, p.status === 'cancelled' && 'opacity-60')}>
                  <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{p.number}</td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(p.pay_date)}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(p.amount))}</td>
                  <td className={tdCls}><PaymentMethodBadge method={p.method} /></td>
                  <td className={tdCls}><DocStatusBadge status={p.status} /></td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{p.created_by_name ?? '—'}</td>
                  <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>{p.note ?? ''}</td>
                  <td className={tdCls}>
                    <PaymentCancelButton show={canCancelPayment && p.status === 'posted'} busy={paymentBusyId === p.id} onClick={() => cancelPayment(p.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      {tab === 'ledger' && (
        <TableCard loading={loading} empty={ledger.length === 0} emptyText={t('prodSales.customers.ledgerEmpty')} emptyIcon={FileText}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thCls}>{t('production.suppliers.document')}</th>
                <th className={thRightCls}>{t('aktSverka.debit')}</th>
                <th className={thRightCls}>{t('aktSverka.credit')}</th>
                <th className={thRightCls}>{t('production.suppliers.runningBalance')}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map(e => (
                <tr key={e.key} className={trCls}>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(e.ymd)}</td>
                  <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>
                    {e.href ? <Link href={e.href} className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">{e.label}</Link> : e.label}
                  </td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{e.debit ? formatPrice(e.debit) : ''}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{e.credit ? formatPrice(e.credit) : ''}</td>
                  <td className={cn(tdCls, 'text-right')}><BalanceValue balance={e.balance} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800/50 font-medium text-gray-900 dark:text-gray-100">
                <td colSpan={2} className="px-4 py-3">{t('production.common.total')}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(debitTotal)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(creditTotal)}</td>
                <td className="px-4 py-3 text-right"><BalanceValue balance={Math.round((debitTotal - creditTotal) * 100) / 100} /></td>
              </tr>
            </tfoot>
          </table>
        </TableCard>
      )}

      <CustomerFormDialog open={formOpen} onOpenChange={setFormOpen} customer={customer} priceLists={lists} onSaved={() => { setFormOpen(false); reloadCustomers() }} />
      <CustomerPaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        customers={customers}
        customerId={customer.id}
        onSaved={() => { setPayOpen(false); reloadAll() }}
      />
    </div>
  )
}
