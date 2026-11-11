'use client'

// Debitorlik: receivables of the wholesale customers (prod_customer_ageing):
// balance, not due and overdue buckets (payments and returns allocated FIFO
// to the oldest sales by due date), credit limit and payment terms. Current
// state, not period-bound. Route guard: proxy.ts ('prod_stock' + 'prod_sales').

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlarmClock, AlertTriangle, CalendarClock, Wallet } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { ReportHeader, ReportTable, type ReportColumn } from '@/components/reports/ReportKit'
import { BackLink, Segmented } from '@/components/production/ProdKit'
import { ProdKpiGrid } from '@/components/production/ReportKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { BalanceValue, useProdCustomers, useSalesAvailable } from '@/components/production/SalesKit'
import { round2 } from '@/lib/production'
import { overdueOf, type CustomerAgeing, type ProdCustomer } from '@/lib/sales'
import { downloadXlsx, x2 } from '@/lib/production-reports'

type Filter = 'debtors' | 'overdue' | 'overLimit' | 'all'

interface Row extends ProdCustomer { age: CustomerAgeing; overdue: number; overLimit: boolean }

const EMPTY: CustomerAgeing = { balance: 0, notDue: 0, d1_15: 0, d16_30: 0, d31: 0 }

export default function ReceivablesReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const available = useSalesAvailable()
  const { customers, ageing, loading } = useProdCustomers()
  const [filter, setFilter] = useState<Filter>('debtors')

  const all = useMemo<Row[]>(() => customers.map(c => {
    const age = ageing?.get(c.id) ?? EMPTY
    return { ...c, age, overdue: overdueOf(age), overLimit: c.creditLimit !== null && c.balance > c.creditLimit }
  }), [customers, ageing])

  const rows = useMemo(() => all.filter(r =>
    filter === 'all' ? true : filter === 'debtors' ? r.balance > 0 : filter === 'overdue' ? r.overdue > 0 : r.overLimit), [all, filter])

  const sum = useMemo(() => {
    const s = { debt: 0, notDue: 0, d1_15: 0, d16_30: 0, d31: 0, advance: 0 }
    for (const r of rows) {
      if (r.balance > 0) s.debt += r.balance
      else s.advance += -r.balance
      s.notDue += r.age.notDue
      s.d1_15 += r.age.d1_15
      s.d16_30 += r.age.d16_30
      s.d31 += r.age.d31
    }
    return s
  }, [rows])
  const overdueTotal = round2(sum.d1_15 + sum.d16_30 + sum.d31)
  const overLimitCount = all.filter(r => r.overLimit).length

  const ageCell = (n: number, tone: 'none' | 'amber' | 'red') => (
    <span className={cn(!n ? 'text-gray-400 dark:text-gray-500'
      : tone === 'red' ? 'text-red-600 dark:text-red-400' : tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100')}>
      {n ? formatPrice(n) : '—'}
    </span>
  )

  const columns: ReportColumn<Row>[] = [
    {
      key: 'name', label: t('prodSales.common.customer'), sortValue: r => r.name,
      render: r => (
        <Link href={`/zavod-mijozlar/${r.id}`} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
          {r.name}
          {r.inn && <span className="ml-1.5 text-[12px] tabular-nums text-gray-400 dark:text-gray-500">{r.inn}</span>}
        </Link>
      ),
      footer: t('production.common.total'),
    },
    {
      key: 'terms', label: t('prodInventory.ageing.paymentTerms'), align: 'right', sortValue: r => r.paymentTermsDays ?? -1,
      render: r => <span className="text-gray-500 dark:text-gray-400">{r.paymentTermsDays === null ? '—' : r.paymentTermsDays}</span>,
    },
    {
      key: 'limit', label: t('prodSales.common.creditLimit'), align: 'right', sortValue: r => r.creditLimit ?? -1,
      render: r => <span className={r.overLimit ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}>{r.creditLimit === null ? '—' : formatPrice(r.creditLimit)}</span>,
    },
    { key: 'balance', label: t('prodSales.common.balance'), align: 'right', sortValue: r => r.balance, render: r => <BalanceValue balance={r.balance} />, footer: formatPrice(sum.debt) },
    { key: 'notDue', label: t('prodInventory.ageing.notDue'), align: 'right', sortValue: r => r.age.notDue, render: r => ageCell(r.age.notDue, 'none'), footer: formatPrice(sum.notDue) },
    { key: 'd1', label: t('prodInventory.ageing.d1_15'), align: 'right', sortValue: r => r.age.d1_15, render: r => ageCell(r.age.d1_15, 'amber'), footer: formatPrice(sum.d1_15) },
    { key: 'd16', label: t('prodInventory.ageing.d16_30'), align: 'right', sortValue: r => r.age.d16_30, render: r => ageCell(r.age.d16_30, 'red'), footer: formatPrice(sum.d16_30) },
    { key: 'd31', label: t('prodInventory.ageing.d31'), align: 'right', sortValue: r => r.age.d31, render: r => ageCell(r.age.d31, 'red'), footer: formatPrice(sum.d31) },
    {
      key: 'lastSale', label: t('prodSales.customers.lastSale'), sortValue: r => r.lastSaleAt ?? '',
      render: r => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{r.lastSaleAt ? formatDate(r.lastSaleAt) : '—'}</span>,
    },
  ]

  function exportXlsx() {
    downloadXlsx('debitorlik', [
      t('prodSales.common.customer'), t('prodSales.common.legalName'), t('prodSales.common.inn'), t('production.suppliers.phone'),
      t('prodInventory.ageing.paymentTerms'), `${t('prodSales.common.creditLimit')} (UZS)`, `${t('prodSales.common.balance')} (UZS)`,
      t('prodInventory.ageing.notDue'), t('prodInventory.ageing.d1_15'), t('prodInventory.ageing.d16_30'), t('prodInventory.ageing.d31'),
      `${t('prodSales.common.overdueDebt')} (UZS)`, t('prodSales.customers.lastSale'),
    ], rows.map(r => [
      r.name, r.legalName, r.inn, r.phone, r.paymentTermsDays ?? '', r.creditLimit ?? '', x2(r.balance),
      x2(r.age.notDue), x2(r.age.d1_15), x2(r.age.d16_30), x2(r.age.d31), x2(r.overdue), r.lastSaleAt ? r.lastSaleAt.slice(0, 10) : '',
    ]), t('prodSales.reports.receivablesTitle'))
  }

  if (available === false || (available && !loading && ageing === null)) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
        <NotAvailableNote />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodSales.reports.receivablesTitle')}
        subtitle={t('prodSales.reports.receivablesSubtitle')}
        range={null}
        onExport={rows.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
        <Segmented
          options={[
            { value: 'debtors' as const, label: t('prodSales.customers.onlyDebtors') },
            { value: 'overdue' as const, label: t('prodSales.customers.onlyOverdue') },
            { value: 'overLimit' as const, label: t('prodSales.reports.overLimit') },
            { value: 'all' as const, label: t('prodReports.common.all') },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </ReportHeader>

      <ProdKpiGrid items={[
        { label: t('prodSales.customers.totalDebt'), value: formatPrice(sum.debt), icon: Wallet, tone: sum.debt > 0 ? 'negative' : undefined },
        { label: t('prodInventory.ageing.notDue'), value: formatPrice(sum.notDue), icon: CalendarClock },
        { label: t('prodSales.common.overdueDebt'), value: formatPrice(overdueTotal), sub: `31+: ${formatPrice(sum.d31)}`, icon: AlarmClock, tone: overdueTotal > 0 ? 'negative' : undefined },
        { label: t('prodSales.reports.overLimit'), value: String(overLimitCount), sub: sum.advance > 0 ? `${t('prodSales.common.advance')}: ${formatPrice(sum.advance)}` : undefined, icon: AlertTriangle, tone: overLimitCount > 0 ? 'warning' : undefined },
      ]} />

      <ReportTable
        rows={rows}
        columns={columns}
        rowKey={r => r.id}
        loading={loading || available === null}
        emptyText={t('prodReports.common.empty')}
        initialSort={{ key: 'balance', dir: 'desc' }}
        pageSize={50}
      />
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodSales.reports.receivablesNote')}</p>
    </div>
  )
}
