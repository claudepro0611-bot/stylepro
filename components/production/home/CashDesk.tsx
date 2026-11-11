'use client'

// Cashier desk (prod_cash): account balances, today's in / out, order shortcuts.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDownCircle, ArrowUpCircle, CreditCard, Truck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { useHasPermission } from '@/components/production/MilkKit'
import { useCashAccounts } from '@/components/production/CashKit'
import { accountKindKey, fetchTodayTotals } from '@/lib/cash'
import { BigAction, DeskList, DeskShell, DeskStat, deskRowCls } from './DeskKit'

export function CashDesk({ compact }: { compact?: boolean }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const canPayments = useHasPermission('prod_customer_payments')
  const canSuppliers = useHasPermission('prod_suppliers')
  const { available, accounts, loading: accLoading } = useCashAccounts()
  const [todayBy, setTodayBy] = useState<Map<string, { in: number; out: number }>>(new Map())
  const [todayLoading, setTodayLoading] = useState(true)

  useEffect(() => {
    if (!available) { if (available === false) setTodayLoading(false); return }
    let active = true
    fetchTodayTotals(createClient()).then(m => { if (active) { setTodayBy(m); setTodayLoading(false) } })
    return () => { active = false }
  }, [available])

  const loading = accLoading || todayLoading || available === null
  const active = accounts.filter(a => a.isActive)
  const total = active.reduce((s, a) => s + a.balance, 0)
  const sums = [...todayBy.values()].reduce((s, v) => ({ in: s.in + v.in, out: s.out + v.out }), { in: 0, out: 0 })

  return (
    <DeskShell
      title={t('prodHome.desks.cash')}
      compact={compact}
      actions={<>
        {/* direction= is a hint for the order dialog; it opens either way. */}
        <BigAction href="/zavod-kassa-orderlar?new=1&direction=in" label={t('prodHome.cash.inOrder')} icon={ArrowDownCircle} primary compact={compact} />
        <BigAction href="/zavod-kassa-orderlar?new=1&direction=out" label={t('prodHome.cash.outOrder')} icon={ArrowUpCircle} compact={compact} />
        {canPayments && <BigAction href="/zavod-mijoz-tolovlari?new=1" label={t('prodHome.sales.payment')} icon={CreditCard} compact={compact} />}
        {canSuppliers && <BigAction href="/zavod-yetkazuvchi-tolovlar" label={t('prodHome.cash.supplierPayment')} icon={Truck} compact={compact} />}
      </>}
      stats={<>
        <DeskStat label={t('prodHome.cash.balance')} value={formatPrice(total)} tone={total < 0 ? 'negative' : undefined} loading={loading} />
        <DeskStat label={t('prodHome.cash.todayIn')} value={formatPrice(sums.in)} tone={sums.in > 0 ? 'positive' : undefined} loading={loading} />
        <DeskStat label={t('prodHome.cash.todayOut')} value={formatPrice(sums.out)} tone={sums.out > 0 ? 'negative' : undefined} loading={loading} />
      </>}
    >
      <DeskList title={t('prodHome.cash.accounts')} href="/zavod-kassa" loading={loading} empty={active.length === 0} emptyText={t('prodHome.cash.noAccounts')}>
        {active.map(a => {
          const d = todayBy.get(a.id)
          return (
            <Link key={a.id} href={`/zavod-kassa/${a.id}`} className={cn(deskRowCls, 'hover:bg-gray-50 dark:hover:bg-gray-800/40')}>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-gray-900 dark:text-gray-100">{a.name}</span>
                <span className="ml-1.5 text-[12px] text-gray-400 dark:text-gray-500">{t(accountKindKey(a.kind))}</span>
              </span>
              {d && (d.in > 0 || d.out > 0) && (
                <span className="hidden shrink-0 text-[12px] tabular-nums text-gray-400 dark:text-gray-500 sm:inline">
                  +{formatPrice(d.in)} / -{formatPrice(d.out)}
                </span>
              )}
              <span className={cn('shrink-0 tabular-nums font-medium', a.balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>
                {formatPrice(a.balance)}
              </span>
            </Link>
          )
        })}
      </DeskList>
    </DeskShell>
  )
}
