'use client'

// Kassa daftari of one account: movements of a period with the running
// balance (computed in prod_cash_movements_v over the whole history, so it
// stays correct under any filter), type filter, "show cancelled" toggle,
// Excel export and print. Route guard: proxy.ts ('prod_cash').

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowDownCircle, ArrowUpCircle, BookOpen, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { monthToDate } from '@/components/reports/ReportKit'
import {
  ActiveBadge, BackLink, FilterBar, TableCard, prodCardCls, prodFieldCls, secondaryBtnCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { ExportButton } from '@/components/production/ReportKit'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import {
  AccountKindIcon, CashOrderDialog, useCashAccounts, useExpenseCategories,
} from '@/components/production/CashKit'
import { rangeToIsoBounds } from '@/lib/production'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'
import {
  CASH_SOURCE_TYPES, accountKindKey, accountPeriod, cashSourceHref, cashSourceKey, fetchBalanceBefore, fetchCashMovements,
  type CashMovement,
} from '@/lib/cash'

const PAGE_SIZE = 50

export default function CashLedgerPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { id } = useParams<{ id: string }>()
  const { available, accounts, loading: accountsLoading, reload: reloadAccounts } = useCashAccounts()
  const categories = useExpenseCategories(!!available)

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [source, setSource] = useState('')
  const [showCancelled, setShowCancelled] = useState(false)
  const [movements, setMovements] = useState<CashMovement[]>([])
  const [opening, setOpening] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [orderDir, setOrderDir] = useState<'in' | 'out' | null>(null)

  const account = useMemo(() => accounts.find(a => a.id === id), [accounts, id])
  const openingBalance = account?.openingBalance
  const bounds = useMemo(() => (range ? rangeToIsoBounds(range) : null), [range])

  const load = useCallback(async () => {
    if (!available || openingBalance === undefined) return
    setLoading(true)
    const supabase = createClient()
    const [res, before] = await Promise.all([
      fetchCashMovements(supabase, { accountId: id, fromIso: bounds?.fromIso, toIso: bounds?.toIso }),
      bounds ? fetchBalanceBefore(supabase, { id, openingBalance }, bounds.fromIso) : Promise.resolve(openingBalance),
    ])
    if (res.error) toast.error(t('productionErrors.unknown'))
    setMovements(res.data)
    setOpening(before)
    setPage(1)
    setLoading(false)
  }, [available, id, openingBalance, bounds, t])

  useEffect(() => { load() }, [load])

  const ledger = useMemo(() => {
    // Period figures over every line (net of reversals); the filters only hide rows.
    const period = accountPeriod(opening, movements)
    const closing = movements.length ? movements[movements.length - 1].runningBalance : opening
    const shown = movements.filter(m => (!source || m.sourceType === source) && (showCancelled || m.sourceStatus !== 'cancelled'))
    const shownTotals = accountPeriod(0, shown)
    return {
      rows: shown.slice().reverse(), // newest first on screen
      opening: period.opening,
      closing,
      totalIn: period.totalIn,
      totalOut: period.totalOut,
      shownIn: shownTotals.totalIn,
      shownOut: shownTotals.totalOut,
    }
  }, [movements, opening, source, showCancelled])

  const totalPages = Math.max(1, Math.ceil(ledger.rows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = ledger.rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const docLabel = (m: CashMovement) => `${t(cashSourceKey(m.sourceType))}${m.sourceNumber !== null ? ` #${m.sourceNumber}` : ''}`
  // Transfers have no counterparty: show the other account.
  const partyOf = (m: CashMovement) => m.counterpartyName || m.peerAccountName

  function exportXlsx() {
    if (!account) return
    downloadXlsx(`kassa_daftari_${account.name}`, [
      t('production.common.date'), t('prodCash.ledger.document'), t('prodCash.common.counterparty'), t('prodCash.common.category'),
      `${t('prodCash.common.in')} (UZS)`, `${t('prodCash.common.out')} (UZS)`, `${t('prodCash.ledger.running')} (UZS)`,
      t('production.common.status'), t('production.common.note'), t('production.common.author'),
    ], ledger.rows.slice().reverse().map(r => [
      dateTimeCell(r.moveDate), `${docLabel(r)}${r.isReversal ? ` (${t('prodCash.ledger.reversal')})` : ''}`, partyOf(r), r.categoryName,
      r.amount > 0 ? x2(r.amount) : '', r.amount < 0 ? x2(-r.amount) : '', x2(r.runningBalance),
      r.sourceStatus === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), r.note, r.createdByName,
    ]), t('prodCash.ledger.title'))
  }

  const header = (
    <BackLink href="/zavod-kassa" label={t('prodCash.accounts.title')} />
  )

  if (available === false) return <div className="space-y-5">{header}<NotAvailableNote /></div>
  if (accountsLoading || available === null) {
    return <div className="space-y-5">{header}<div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div></div>
  }
  if (!account) {
    return <div className="space-y-5">{header}<div className={cn(prodCardCls, 'p-6 text-sm text-gray-500 dark:text-gray-400')}>{t('prodCash.ledger.notFound')}</div></div>
  }

  const periodLabel = range ? `${formatDate(range.from)} — ${formatDate(range.to)}` : t('prodReports.common.all')

  return (
    <div className="space-y-5">
      <div className="space-y-5 print:hidden">
        {header}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
              <AccountKindIcon kind={account.kind} className="h-4 w-4 text-gray-400" />
            </div>
            <div>
              <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
                {account.name} {!account.isActive && <ActiveBadge active={false} />}
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('prodCash.ledger.title')} · {t(accountKindKey(account.kind))}{account.bankName ? ` · ${account.bankName}` : ''}{account.accountNo ? ` · ${account.accountNo}` : ''}{account.mfo ? ` · ${t('prodCash.accounts.mfo')} ${account.mfo}` : ''}
              </p>
            </div>
          </div>
          {account.isActive && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setOrderDir('in')} className={secondaryBtnCls}><ArrowDownCircle className="h-3.5 w-3.5" /> {t('prodCash.orders.pko')}</button>
              <button type="button" onClick={() => setOrderDir('out')} className={secondaryBtnCls}><ArrowUpCircle className="h-3.5 w-3.5" /> {t('prodCash.orders.rko')}</button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: t('prodCash.common.opening'), value: ledger.opening },
            { label: t('prodCash.common.in'), value: ledger.totalIn, tone: 'in' as const },
            { label: t('prodCash.common.out'), value: ledger.totalOut, tone: 'out' as const },
            { label: t('prodCash.common.closing'), value: ledger.closing },
          ].map(k => (
            <div key={k.label} className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-5">
              <p className="text-[12.5px] text-gray-500 dark:text-gray-400">{k.label}</p>
              <p className={cn(
                'mt-0.5 text-lg font-semibold tabular-nums',
                k.tone === 'in' && k.value > 0 ? 'text-emerald-600 dark:text-emerald-400'
                  : k.tone === 'out' && k.value > 0 ? 'text-red-600 dark:text-red-400'
                    : !k.tone && k.value < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100',
              )}>{formatPrice(k.value)}</p>
            </div>
          ))}
        </div>

        <FilterBar
          onReset={() => { setRange(monthToDate()); setSource(''); setShowCancelled(false) }}
          columns={(
            <>
              <PrintButton />
              <ExportButton onClick={exportXlsx} disabled={ledger.rows.length === 0} />
            </>
          )}
        >
          <DateRangeFilter value={range} onChange={setRange} />
          <select value={source} onChange={e => { setSource(e.target.value); setPage(1) }} className={cn(prodFieldCls, 'w-56')}>
            <option value="">{t('prodCash.ledger.allTypes')}</option>
            {CASH_SOURCE_TYPES.map(s => <option key={s} value={s}>{t(cashSourceKey(s))}</option>)}
          </select>
          <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-700 dark:text-gray-300">
            <Switch checked={showCancelled} onCheckedChange={v => { setShowCancelled(v); setPage(1) }} />
            {t('prodCash.common.showCancelled')}
          </label>
        </FilterBar>

        <TableCard loading={loading} empty={ledger.rows.length === 0} emptyText={t('prodCash.ledger.empty')} emptyIcon={BookOpen}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thCls}>{t('prodCash.ledger.document')}</th>
                <th className={thCls}>{t('prodCash.common.counterparty')}</th>
                <th className={thRightCls}>{t('prodCash.common.in')}</th>
                <th className={thRightCls}>{t('prodCash.common.out')}</th>
                <th className={thRightCls}>{t('prodCash.ledger.running')}</th>
                <th className={thCls}>{t('production.common.note')}</th>
                <th className={thCls}>{t('production.common.author')}</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map(r => (
                <tr key={r.id} className={cn(trCls, r.sourceStatus === 'cancelled' && 'opacity-60')}>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.moveDate)}</td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-900 dark:text-gray-100')}>
                    {cashSourceHref(r.sourceType) ? (
                      <Link href={cashSourceHref(r.sourceType) as string} className="hover:text-gray-600 dark:hover:text-gray-400 transition-colors">{docLabel(r)}</Link>
                    ) : docLabel(r)}
                    {r.isReversal && <span className="ml-1.5 inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400">{t('prodCash.ledger.reversal')}</span>}
                    {r.categoryName && <p className="text-[12px] text-gray-400 dark:text-gray-500">{r.categoryName}</p>}
                  </td>
                  <td className={cn(tdCls, 'max-w-[200px] truncate text-gray-700 dark:text-gray-300')}>{partyOf(r) || '—'}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap', r.amount > 0 ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-gray-300 dark:text-gray-600')}>
                    {r.amount > 0 ? formatPrice(r.amount) : '—'}
                  </td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap', r.amount < 0 ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-600')}>
                    {r.amount < 0 ? formatPrice(-r.amount) : '—'}
                  </td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(r.runningBalance)}</td>
                  <td className={cn(tdCls, 'max-w-[200px] truncate text-gray-500 dark:text-gray-400')}>{r.note}</td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.createdByName || '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm font-medium text-gray-900 dark:text-gray-100">
                <td colSpan={3} className="px-4 py-3">{t('production.common.total')}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(ledger.shownIn)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(ledger.shownOut)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(ledger.closing)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </TableCard>
        {ledger.rows.length > PAGE_SIZE && (
          <Pagination currentPage={safePage} totalPages={totalPages} totalItems={ledger.rows.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
        )}
      </div>

      <PrintSheet title={t('prodCash.ledger.title')} signatures={[t('prodCash.orders.signCashier'), t('prodCash.orders.signAccountant')]}>
        <PrintFields rows={[
          { label: t('prodCash.common.account'), value: `${account.name} (${t(accountKindKey(account.kind))})` },
          { label: t('prodCash.common.period'), value: periodLabel },
          { label: t('prodCash.common.opening'), value: formatPrice(ledger.opening) },
          { label: t('prodCash.common.closing'), value: formatPrice(ledger.closing) },
        ]} />
        <PrintTable
          columns={[
            { label: t('production.common.date') }, { label: t('prodCash.ledger.document') }, { label: t('prodCash.common.counterparty') },
            { label: t('prodCash.common.in'), right: true }, { label: t('prodCash.common.out'), right: true }, { label: t('prodCash.ledger.running'), right: true },
          ]}
          rows={ledger.rows.slice().reverse().map(r => [
            formatDateTime(r.moveDate), `${docLabel(r)}${r.isReversal ? ` (${t('prodCash.ledger.reversal')})` : ''}`, partyOf(r) || r.note || '',
            r.amount > 0 ? formatPrice(r.amount) : '', r.amount < 0 ? formatPrice(-r.amount) : '', formatPrice(r.runningBalance),
          ])}
          total={[t('production.common.total'), '', '', formatPrice(ledger.shownIn), formatPrice(ledger.shownOut), formatPrice(ledger.closing)]}
        />
      </PrintSheet>

      <CashOrderDialog
        open={orderDir !== null}
        onOpenChange={o => { if (!o) setOrderDir(null) }}
        accounts={accounts}
        categories={categories}
        initialDirection={orderDir ?? 'in'}
        accountId={account.id}
        onSaved={() => { setOrderDir(null); load(); reloadAccounts() }}
      />
    </div>
  )
}
