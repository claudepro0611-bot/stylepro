'use client'

// Kassa va bank: account cards (balance, today's in / out), create / edit
// dialog. Click a card -> /zavod-kassa/[id] (kassa daftari). Writes go
// through prod_save_cash_account only. Route guard: proxy.ts ('prod_cash').

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeftRight, FileBarChart, Info, Landmark, Loader2, Pencil, Plus, Receipt } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { ActiveBadge, PageHeader, prodCardCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useHasPermission } from '@/components/production/MilkKit'
import { AccountKindIcon, CashAccountDialog, useCashAccounts } from '@/components/production/CashKit'
import { paymentMethodKey } from '@/lib/production'
import { accountKindKey, fetchTodayTotals, needsOpeningBalance, type CashAccount } from '@/lib/cash'

export default function CashAccountsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { available, accounts, loading, reload } = useCashAccounts()
  const [today, setToday] = useState<Map<string, { in: number; out: number }>>(new Map())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CashAccount | null>(null)
  // The cash report lives under /zavod-hisobotlar, which also needs 'prod_stock'.
  const canReports = useHasPermission('prod_stock')

  useEffect(() => {
    if (!available) return
    let active = true
    fetchTodayTotals(createClient()).then(m => { if (active) setToday(m) })
    return () => { active = false }
  }, [available, accounts])

  const activeAccounts = useMemo(() => accounts.filter(a => a.isActive), [accounts])
  const inactiveAccounts = useMemo(() => accounts.filter(a => !a.isActive), [accounts])
  const total = useMemo(() => activeAccounts.reduce((s, a) => s + a.balance, 0), [activeAccounts])
  // Seeded / new accounts start at 0 with no movements: ask for the real opening balance
  // (supplier payments and agent issues are refused with insufficient_funds until then).
  const needsOpening = activeAccounts.some(needsOpeningBalance)

  function openNew() { setEditing(null); setDialogOpen(true) }
  function openEdit(a: CashAccount) { setEditing(a); setDialogOpen(true) }

  function card(a: CashAccount) {
    const day = today.get(a.id)
    return (
      <div key={a.id} className={cn(prodCardCls, 'relative p-5 hover:shadow-md transition-all duration-200', !a.isActive && 'opacity-60')}>
        <Link href={`/zavod-kassa/${a.id}`} className="absolute inset-0 rounded-xl" aria-label={a.name} />
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
              <AccountKindIcon kind={a.kind} className="h-4 w-4 text-gray-400" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{a.name}</p>
              <p className="truncate text-[12px] text-gray-500 dark:text-gray-400">
                {t(accountKindKey(a.kind))}{a.bankName ? ` · ${a.bankName}` : ''}{a.accountNo ? ` · ${a.accountNo}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => openEdit(a)}
            aria-label={t('production.common.edit')}
            title={t('production.common.edit')}
            className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-4 text-[12.5px] text-gray-500 dark:text-gray-400">{t('prodCash.common.balance')}</p>
        <p className={cn('mt-0.5 text-xl font-semibold tabular-nums', a.balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>
          {formatPrice(a.balance)}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-gray-100 dark:border-gray-800 pt-3 text-[12px]">
          <div>
            <p className="text-gray-500 dark:text-gray-400">{t('prodCash.common.todayIn')}</p>
            <p className={cn('tabular-nums font-medium', day?.in ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500')}>{formatPrice(day?.in ?? 0)}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-gray-400">{t('prodCash.common.todayOut')}</p>
            <p className={cn('tabular-nums font-medium', day?.out ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500')}>{formatPrice(day?.out ?? 0)}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {!a.isActive && <ActiveBadge active={false} />}
          {a.defaultFor.map(m => (
            <span key={m} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400">{t(paymentMethodKey(m))}</span>
          ))}
          {a.lastMoveAt && (
            <span className="ml-auto text-[11px] text-gray-400 dark:text-gray-500">{t('prodCash.accounts.lastMove')}: {formatDateTime(a.lastMoveAt)}</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodCash.accounts.title')}
        subtitle={t('prodCash.accounts.subtitle')}
        actionLabel={available ? t('prodCash.accounts.new') : undefined}
        onAction={openNew}
      />

      {available === false ? <NotAvailableNote /> : loading || available === null ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
      ) : (
        <>
          <div className={cn(prodCardCls, 'flex flex-wrap items-center gap-x-6 gap-y-3 p-5')}>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
                <Landmark className="h-4 w-4 text-gray-400" />
              </div>
              <div>
                <p className="text-[12.5px] text-gray-500 dark:text-gray-400">{t('prodCash.common.totalBalance')}</p>
                <p className={cn('text-lg font-semibold tabular-nums', total < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>{formatPrice(total)}</p>
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Link href="/zavod-kassa-orderlar" className={secondaryBtnCls}><Receipt className="h-3.5 w-3.5" /> {t('prodCash.nav.orders')}</Link>
              <Link href="/zavod-kassa-otkazmalar" className={secondaryBtnCls}><ArrowLeftRight className="h-3.5 w-3.5" /> {t('prodCash.nav.transfers')}</Link>
              {canReports && <Link href="/zavod-hisobotlar/kassa" className={secondaryBtnCls}><FileBarChart className="h-3.5 w-3.5" /> {t('prodCash.nav.report')}</Link>}
            </div>
          </div>

          {needsOpening && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {t('prodCash.accounts.setOpeningHint')}
            </div>
          )}

          {accounts.length === 0 ? (
            <div className={cn(prodCardCls, 'flex h-48 flex-col items-center justify-center gap-3 text-sm text-gray-400 dark:text-gray-500')}>
              <Landmark className="h-6 w-6" />
              {t('prodCash.accounts.empty')}
              <button type="button" onClick={openNew} className={secondaryBtnCls}><Plus className="h-3.5 w-3.5" /> {t('prodCash.accounts.new')}</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {activeAccounts.map(card)}
            </div>
          )}

          {inactiveAccounts.length > 0 && (
            <div className="space-y-3">
              <p className="text-[13px] font-medium text-gray-500 dark:text-gray-400">{t('prodCash.accounts.inactiveHint')}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{inactiveAccounts.map(card)}</div>
            </div>
          )}
        </>
      )}

      <CashAccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={editing}
        accounts={accounts}
        onSaved={() => { setDialogOpen(false); reload() }}
      />
    </div>
  )
}
