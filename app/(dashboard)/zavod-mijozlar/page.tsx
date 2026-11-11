'use client'

// Mijozlar (wholesale customers of the production module): list with
// balance and ageing, create / edit dialog, payment shortcut, export.
// Route guard: proxy.ts (PRODUCTION_PREFIXES + ROUTE_PERMISSIONS 'prod_sales').

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlarmClock, Banknote, Contact, Eye, Pencil, Search, Users, Wallet } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { KpiGrid } from '@/components/reports/ReportKit'
import {
  ActiveBadge, FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { ExportButton } from '@/components/production/ReportKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useHasPermission } from '@/components/production/MilkKit'
import {
  BalanceValue, CustomerFormDialog, CustomerPaymentDialog, usePriceLists, useProdCustomers, useSalesAvailable,
} from '@/components/production/SalesKit'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'
import { overdueOf, type ProdCustomer } from '@/lib/sales'

const iconBtn = 'flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'

export default function ProdCustomersPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useSalesAvailable()
  const { customers, ageing, loading, reload } = useProdCustomers()
  const { lists } = usePriceLists()
  const canPay = useHasPermission('prod_customer_payments')

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [onlyDebtors, setOnlyDebtors] = useState(false)
  const [onlyOverdue, setOnlyOverdue] = useState(false)
  const [editing, setEditing] = useState<ProdCustomer | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [payFor, setPayFor] = useState<string | undefined>(undefined)
  const [payOpen, setPayOpen] = useState(false)

  const listName = useMemo(() => new Map(lists.map(l => [l.id, l.name])), [lists])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return customers
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.legalName.toLowerCase().includes(q) || c.inn.includes(q) || c.phone.includes(q))
      .filter(c => !status || (status === 'active' ? c.isActive : !c.isActive))
      .filter(c => !onlyDebtors || c.balance > 0)
      .filter(c => !onlyOverdue || overdueOf(ageing?.get(c.id)) > 0)
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name))
  }, [customers, search, status, onlyDebtors, onlyOverdue, ageing])

  const totalDebt = useMemo(() => customers.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0), [customers])
  const totalOverdue = useMemo(() => (ageing ? [...ageing.values()].reduce((s, a) => s + overdueOf(a), 0) : 0), [ageing])
  const overdueCount = useMemo(() => (ageing ? [...ageing.values()].filter(a => overdueOf(a) > 0).length : 0), [ageing])

  const ageCell = (n: number | undefined, tone: 'none' | 'amber' | 'red') => (
    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap', !n ? 'text-gray-400 dark:text-gray-500'
      : tone === 'red' ? 'text-red-600 dark:text-red-400' : tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100')}>
      {n ? formatPrice(n) : '—'}
    </td>
  )

  function exportXlsx() {
    downloadXlsx('zavod_mijozlar', [
      t('production.common.name'), t('prodSales.common.legalName'), t('prodSales.common.inn'), t('production.suppliers.phone'),
      t('production.suppliers.address'), t('prodSales.common.contactPerson'), t('prodSales.common.priceList'),
      `${t('prodSales.common.creditLimit')} (UZS)`, t('prodInventory.ageing.paymentTerms'), t('prodSales.common.vatPayer'), t('production.common.status'),
      `${t('prodSales.customers.sold')} (UZS)`, `${t('prodSales.customers.returned')} (UZS)`, `${t('prodSales.customers.paid')} (UZS)`, `${t('prodSales.common.balance')} (UZS)`,
      t('prodInventory.ageing.notDue'), t('prodInventory.ageing.d1_15'), t('prodInventory.ageing.d16_30'), t('prodInventory.ageing.d31'), t('prodSales.customers.lastSale'),
    ], filtered.map(c => {
      const a = ageing?.get(c.id)
      return [
        c.name, c.legalName, c.inn, c.phone, c.address, c.contactPerson, c.priceListId ? listName.get(c.priceListId) ?? '' : '',
        c.creditLimit ?? '', c.paymentTermsDays ?? '', c.vatPayer ? t('prodSales.common.yes') : t('prodSales.common.no'),
        c.isActive ? t('production.common.active') : t('production.common.inactive'),
        x2(c.salesTotal), x2(c.returnsTotal), x2(c.paymentsTotal), x2(c.balance),
        x2(a?.notDue ?? 0), x2(a?.d1_15 ?? 0), x2(a?.d16_30 ?? 0), x2(a?.d31 ?? 0), c.lastSaleAt ? dateTimeCell(c.lastSaleAt) : '',
      ]
    }), t('prodSales.customers.title'))
  }

  function reset() {
    setSearch('')
    setStatus('')
    setOnlyDebtors(false)
    setOnlyOverdue(false)
  }

  const checkCls = 'flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-700 dark:text-gray-300'

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodSales.customers.title')}
        subtitle={t('prodSales.customers.subtitle')}
        actionLabel={available ? t('prodSales.customers.new') : undefined}
        onAction={() => { setEditing(null); setFormOpen(true) }}
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <KpiGrid items={[
            { label: t('prodSales.customers.totalDebt'), value: formatPrice(totalDebt), icon: Wallet, tone: totalDebt > 0 ? 'negative' : undefined },
            { label: t('prodSales.common.overdueDebt'), value: formatPrice(totalOverdue), icon: AlarmClock, tone: totalOverdue > 0 ? 'negative' : undefined },
            { label: t('prodSales.customers.overdueCount'), value: String(overdueCount), icon: Contact },
            { label: t('prodSales.customers.count'), value: String(customers.length), icon: Users },
          ]} />

          <FilterBar
            onReset={search || status || onlyDebtors || onlyOverdue ? reset : undefined}
            columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />}
          >
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('prodSales.customers.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
            <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
              <option value="">{t('production.common.allStatuses')}</option>
              <option value="active">{t('production.common.active')}</option>
              <option value="inactive">{t('production.common.inactive')}</option>
            </select>
            <label className={checkCls}>
              <input type="checkbox" checked={onlyDebtors} onChange={e => setOnlyDebtors(e.target.checked)} className="h-3.5 w-3.5 accent-slate-900 dark:accent-gray-100" />
              {t('prodSales.customers.onlyDebtors')}
            </label>
            <label className={checkCls}>
              <input type="checkbox" checked={onlyOverdue} onChange={e => setOnlyOverdue(e.target.checked)} className="h-3.5 w-3.5 accent-slate-900 dark:accent-gray-100" />
              {t('prodSales.customers.onlyOverdue')}
            </label>
          </FilterBar>

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodSales.customers.empty')} emptyIcon={Contact}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.name')}</th>
                  <th className={thCls}>{t('prodSales.common.inn')}</th>
                  <th className={thCls}>{t('production.suppliers.phone')}</th>
                  <th className={thRightCls}>{t('prodSales.common.creditLimit')}</th>
                  <th className={thRightCls}>{t('prodSales.common.balance')}</th>
                  <th className={thRightCls}>{t('prodInventory.ageing.notDue')}</th>
                  <th className={thRightCls}>{t('prodInventory.ageing.d1_15')}</th>
                  <th className={thRightCls}>{t('prodInventory.ageing.d16_30')}</th>
                  <th className={thRightCls}>{t('prodInventory.ageing.d31')}</th>
                  <th className={thCls}>{t('prodSales.customers.lastSale')}</th>
                  <th className={thCls}>{t('production.common.status')}</th>
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const a = ageing?.get(c.id)
                  const over = c.creditLimit !== null && c.balance > c.creditLimit
                  return (
                    <tr key={c.id} onClick={() => router.push(`/zavod-mijozlar/${c.id}`)} className={cn(trCls, 'cursor-pointer', !c.isActive && 'opacity-60')}>
                      <td className={tdCls}>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{c.name}</p>
                        {c.legalName && <p className="text-[12px] text-gray-400 dark:text-gray-500">{c.legalName}</p>}
                      </td>
                      <td className={cn(tdCls, 'tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{c.inn || '—'}</td>
                      <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{c.phone || '—'}</td>
                      <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap', over ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>
                        {c.creditLimit === null ? '—' : formatPrice(c.creditLimit)}
                      </td>
                      <td className={cn(tdCls, 'text-right')}><BalanceValue balance={c.balance} /></td>
                      {ageCell(a?.notDue, 'none')}
                      {ageCell(a?.d1_15, 'amber')}
                      {ageCell(a?.d16_30, 'red')}
                      {ageCell(a?.d31, 'red')}
                      <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{c.lastSaleAt ? formatDate(c.lastSaleAt) : '—'}</td>
                      <td className={tdCls}><ActiveBadge active={c.isActive} /></td>
                      <td className={tdCls}>
                        <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                          <Link href={`/zavod-mijozlar/${c.id}`} aria-label={t('production.common.view')} title={t('production.common.view')} className={iconBtn}>
                            <Eye className="h-3.5 w-3.5" />
                          </Link>
                          <button type="button" onClick={() => { setEditing(c); setFormOpen(true) }} aria-label={t('production.common.edit')} title={t('production.common.edit')} className={iconBtn}>
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {canPay && (
                            <button type="button" onClick={() => { setPayFor(c.id); setPayOpen(true) }} aria-label={t('prodSales.payments.new')} title={t('prodSales.payments.new')} className={iconBtn}>
                              <Banknote className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableCard>
        </>
      )}

      <CustomerFormDialog open={formOpen} onOpenChange={setFormOpen} customer={editing} priceLists={lists} onSaved={() => { setFormOpen(false); reload() }} />
      <CustomerPaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        customers={customers}
        customerId={payFor}
        onSaved={() => { setPayOpen(false); reload() }}
      />
    </div>
  )
}
