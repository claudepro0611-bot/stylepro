'use client'

// Kassa hisoboti: per account opening / in / out / closing for a period and
// the period's outflows by expense category (documents without a category
// are grouped by their type). Opening = running_balance of the last line
// before the period (prod_cash_movements_v) or the opening balance; in / out
// are by original direction, net of cancelled documents (same rule as
// prod_cash_balances). Internal transfers move money between accounts: they
// show in the account rows but are left out of the category breakdown.
// Route guard: proxy.ts ('prod_stock' parent prefix + 'prod_cash').

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDownCircle, ArrowUpCircle, Landmark, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { ReportHeader, ReportTable, monthToDate, type ReportColumn } from '@/components/reports/ReportKit'
import { type DateRangeValue } from '@/components/ui/date-range-filter'
import { BackLink } from '@/components/production/ProdKit'
import { ProdKpiGrid } from '@/components/production/ReportKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { AccountKindIcon, useCashAccounts } from '@/components/production/CashKit'
import { rangeToIsoBounds, round2 } from '@/lib/production'
import { downloadXlsx, x2 } from '@/lib/production-reports'
import {
  accountKindKey, accountPeriod, cashSourceKey, fetchBalanceBefore, fetchCashMovements,
  type CashAccount, type CashAccountPeriod, type CashMovement,
} from '@/lib/cash'

interface AccountRow extends CashAccountPeriod { account: CashAccount }
interface CategoryRow { key: string; name: string; amount: number; count: number }

export default function CashReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { available, accounts, loading: accountsLoading } = useCashAccounts()
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [movements, setMovements] = useState<CashMovement[]>([])
  const [openings, setOpenings] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)

  const bounds = useMemo(() => (range ? rangeToIsoBounds(range) : null), [range])

  useEffect(() => {
    if (!available || accountsLoading) return
    let active = true
    setLoading(true)
    const supabase = createClient()
    Promise.all([
      fetchCashMovements(supabase, { fromIso: bounds?.fromIso, toIso: bounds?.toIso }),
      // One small query per account (a firm has a handful): the balance just before the period.
      Promise.all(accounts.map(async a => [a.id, bounds ? await fetchBalanceBefore(supabase, a, bounds.fromIso) : a.openingBalance] as const)),
    ]).then(([{ data, error }, before]) => {
      if (!active) return
      if (error) toast.error(t('productionErrors.unknown'))
      setMovements(data)
      setOpenings(new Map(before))
      setLoading(false)
    })
    return () => { active = false }
  }, [available, accountsLoading, accounts, bounds, t])

  const rows = useMemo<AccountRow[]>(() => {
    const byAccount = new Map<string, CashMovement[]>()
    for (const m of movements) {
      const list = byAccount.get(m.accountId) ?? []
      list.push(m)
      byAccount.set(m.accountId, list)
    }
    return accounts
      .map(a => ({ account: a, ...accountPeriod(openings.get(a.id) ?? a.openingBalance, byAccount.get(a.id) ?? []) }))
      // Inactive accounts only when they had something in the period.
      .filter(r => r.account.isActive || r.opening !== 0 || r.totalIn !== 0 || r.totalOut !== 0)
  }, [accounts, movements, openings])

  const sum = useMemo(() => rows.reduce((s, r) => ({
    opening: round2(s.opening + r.opening), totalIn: round2(s.totalIn + r.totalIn),
    totalOut: round2(s.totalOut + r.totalOut), closing: round2(s.closing + r.closing),
  }), { opening: 0, totalIn: 0, totalOut: 0, closing: 0 }), [rows])

  const categories = useMemo<CategoryRow[]>(() => {
    const map = new Map<string, CategoryRow>()
    for (const m of movements) {
      if (m.sourceType === 'cash_transfer') continue
      // Outflow (+) or the reversal of one (-); reversals of inflows are ignored.
      const delta = !m.isReversal && m.amount < 0 ? -m.amount : m.isReversal && m.amount > 0 ? -m.amount : 0
      if (!delta) continue
      const key = m.categoryId ? `c:${m.categoryId}` : `s:${m.sourceType}`
      const name = m.categoryId ? (m.categoryName || t('prodCash.common.category')) : t(cashSourceKey(m.sourceType))
      const cur = map.get(key) ?? { key, name, amount: 0, count: 0 }
      cur.amount = round2(cur.amount + delta)
      cur.count += delta > 0 ? 1 : -1 // a reversal takes its document back out
      map.set(key, cur)
    }
    return [...map.values()].filter(c => c.amount !== 0).sort((a, b) => b.amount - a.amount)
  }, [movements, t])
  const categoryTotal = round2(categories.reduce((s, c) => s + c.amount, 0))

  const money = (n: number, tone?: 'in' | 'out') => (
    <span className={cn(
      'tabular-nums whitespace-nowrap',
      !n ? 'text-gray-400 dark:text-gray-500'
        : tone === 'in' ? 'text-emerald-600 dark:text-emerald-400'
          : tone === 'out' ? 'text-red-600 dark:text-red-400'
            : n < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100',
    )}>{formatPrice(n)}</span>
  )

  const columns: ReportColumn<AccountRow>[] = [
    {
      key: 'name', label: t('prodCash.common.account'), sortValue: r => r.account.name,
      render: r => {
        return (
          <Link href={`/zavod-kassa/${r.account.id}`} className="inline-flex items-center gap-2 text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
            <AccountKindIcon kind={r.account.kind} className="h-3.5 w-3.5 text-gray-400" /> {r.account.name}
            <span className="text-[12px] text-gray-400 dark:text-gray-500">{t(accountKindKey(r.account.kind))}</span>
          </Link>
        )
      },
      footer: t('production.common.total'),
    },
    { key: 'opening', label: t('prodCash.common.opening'), align: 'right', sortValue: r => r.opening, render: r => money(r.opening), footer: formatPrice(sum.opening) },
    { key: 'in', label: t('prodCash.common.in'), align: 'right', sortValue: r => r.totalIn, render: r => money(r.totalIn, 'in'), footer: formatPrice(sum.totalIn) },
    { key: 'out', label: t('prodCash.common.out'), align: 'right', sortValue: r => r.totalOut, render: r => money(r.totalOut, 'out'), footer: formatPrice(sum.totalOut) },
    { key: 'closing', label: t('prodCash.common.closing'), align: 'right', sortValue: r => r.closing, render: r => <b className="font-semibold">{money(r.closing)}</b>, footer: formatPrice(sum.closing) },
  ]

  const categoryColumns: ReportColumn<CategoryRow>[] = [
    { key: 'name', label: t('prodCash.common.category'), sortValue: r => r.name, render: r => <span className="text-gray-900 dark:text-gray-100">{r.name}</span>, footer: t('production.common.total') },
    { key: 'count', label: t('prodCash.common.operations'), align: 'right', sortValue: r => r.count, render: r => <span className="tabular-nums text-gray-500 dark:text-gray-400">{r.count}</span> },
    { key: 'amount', label: t('prodCash.common.amount'), align: 'right', sortValue: r => r.amount, render: r => money(r.amount), footer: formatPrice(categoryTotal) },
    {
      key: 'share', label: t('prodCash.report.share'), align: 'right', sortValue: r => r.amount,
      render: r => <span className="tabular-nums text-gray-500 dark:text-gray-400">{categoryTotal ? `${((r.amount / categoryTotal) * 100).toFixed(1)}%` : '—'}</span>,
    },
  ]

  function exportXlsx() {
    downloadXlsx('kassa_hisoboti', [
      t('prodCash.common.account'), t('prodCash.common.type'), `${t('prodCash.common.opening')} (UZS)`, `${t('prodCash.common.in')} (UZS)`,
      `${t('prodCash.common.out')} (UZS)`, `${t('prodCash.common.closing')} (UZS)`,
    ], [
      ...rows.map(r => [r.account.name, t(accountKindKey(r.account.kind)), x2(r.opening), x2(r.totalIn), x2(r.totalOut), x2(r.closing)]),
      [t('production.common.total'), '', x2(sum.opening), x2(sum.totalIn), x2(sum.totalOut), x2(sum.closing)],
      [],
      [t('prodCash.report.byCategory'), '', '', '', t('prodCash.common.amount'), t('prodCash.report.share')],
      ...categories.map(c => [c.name, '', '', '', x2(c.amount), categoryTotal ? x2((c.amount / categoryTotal) * 100) : '']),
    ], t('prodCash.report.title'))
  }

  const back = <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />

  if (available === false) return <div className="space-y-5">{back}<NotAvailableNote /></div>

  const busy = loading || accountsLoading || available === null

  return (
    <div className="space-y-5">
      {back}
      <ReportHeader
        title={t('prodCash.report.title')}
        subtitle={t('prodCash.report.subtitle')}
        range={range}
        onRangeChange={setRange}
        onExport={!busy && rows.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      />

      <ProdKpiGrid items={[
        { label: t('prodCash.common.opening'), value: formatPrice(sum.opening), icon: Wallet },
        { label: t('prodCash.common.in'), value: formatPrice(sum.totalIn), icon: ArrowDownCircle, tone: sum.totalIn > 0 ? 'positive' : undefined },
        { label: t('prodCash.common.out'), value: formatPrice(sum.totalOut), icon: ArrowUpCircle, tone: sum.totalOut > 0 ? 'negative' : undefined },
        { label: t('prodCash.common.closing'), value: formatPrice(sum.closing), icon: Landmark, tone: sum.closing < 0 ? 'negative' : undefined },
      ]} />

      <ReportTable rows={rows} columns={columns} rowKey={r => r.account.id} loading={busy} emptyText={t('prodCash.accounts.empty')} />
      <p className="-mt-3 text-[12px] text-gray-400 dark:text-gray-500">{t('prodCash.report.transfersNote')}</p>

      <h2 className="pt-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodCash.report.byCategory')}</h2>
      <ReportTable
        rows={categories}
        columns={categoryColumns}
        rowKey={r => r.key}
        loading={busy}
        emptyText={t('prodReports.common.empty')}
        initialSort={{ key: 'amount', dir: 'desc' }}
      />
    </div>
  )
}
