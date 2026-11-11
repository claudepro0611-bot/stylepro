'use client'

// Sales desk (prod_sales): new sale, today's sales, overdue customers and
// "repeat last sale" for the most frequent customers (prod_last_sale_lines;
// the form side reads ?customer=..&repeat=1).

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Contact, CreditCard, Plus, Repeat } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { DocStatusBadge } from '@/components/production/ProdKit'
import { useHasPermission } from '@/components/production/MilkKit'
import { rangeToIsoBounds, round2 } from '@/lib/production'
import { addDaysYmd } from '@/lib/production-dashboard'
import { BigAction, DeskList, DeskShell, DeskStat, deskRowCls, hm } from './DeskKit'
import { fetchLastSale, type LastSaleSummary } from './homeApi'

interface SaleRow { id: string; number: number; doc_date: string; customer_id: string; customer_name: string; total: number; status: string }
interface Debtor { id: string; name: string; overdue: number }
interface Frequent { id: string; name: string; count: number; last?: LastSaleSummary | null }

/** Frequent customers = most posted sales in this many days. */
const FREQUENT_DAYS = 60
const FREQUENT_TOP = 5
const DEBTORS_TOP = 5

export function SalesDesk({ compact }: { compact?: boolean }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const canPayments = useHasPermission('prod_customer_payments')
  const [today, setToday] = useState<SaleRow[]>([])
  const [debtors, setDebtors] = useState<Debtor[]>([])
  const [frequent, setFrequent] = useState<Frequent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const supabase = createClient()
    const day = localYmd()
    const { fromIso, toIso } = rangeToIsoBounds({ from: day, to: day })
    const recent = rangeToIsoBounds({ from: addDaysYmd(day, -FREQUENT_DAYS), to: day })
    Promise.all([
      supabase.from('prod_sales').select('id, number, doc_date, customer_id, customer_name, total, status')
        .gte('doc_date', fromIso).lt('doc_date', toIso).order('doc_date', { ascending: false }).limit(200),
      fetchAllRows<{ customer_id: string | null; name: string | null; overdue_1_15: number | null; overdue_16_30: number | null; overdue_31_plus: number | null }>((from, to) =>
        supabase.from('prod_customer_ageing').select('customer_id, name, overdue_1_15, overdue_16_30, overdue_31_plus')
          .gt('balance', 0).order('customer_id').range(from, to)),
      fetchAllRows<{ customer_id: string; customer_name: string }>((from, to) => supabase.from('prod_sales').select('customer_id, customer_name')
        .eq('status', 'posted').gte('doc_date', recent.fromIso).lt('doc_date', recent.toIso).order('id').range(from, to)),
    ]).then(async ([s, age, rec]) => {
      if (!active) return
      setToday((s.data ?? []) as SaleRow[])
      setDebtors(age.data
        .map(r => ({ id: r.customer_id ?? '', name: r.name ?? '', overdue: round2(Number(r.overdue_1_15 ?? 0) + Number(r.overdue_16_30 ?? 0) + Number(r.overdue_31_plus ?? 0)) }))
        .filter(d => d.id && d.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, DEBTORS_TOP))
      const counts = new Map<string, Frequent>()
      for (const r of rec.data) {
        const f = counts.get(r.customer_id) ?? { id: r.customer_id, name: r.customer_name, count: 0 }
        f.count += 1
        counts.set(r.customer_id, f)
      }
      const top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, FREQUENT_TOP)
      setFrequent(top)
      setLoading(false)
      // Last-sale summaries load after the lists are shown.
      const withLast = await Promise.all(top.map(async f => ({ ...f, last: await fetchLastSale(f.id) })))
      if (active) setFrequent(withLast)
    })
    return () => { active = false }
  }, [])

  const posted = useMemo(() => today.filter(s => s.status === 'posted'), [today])
  const todayTotal = posted.reduce((s, r) => s + Number(r.total), 0)
  const overdueTotal = debtors.reduce((s, d) => s + d.overdue, 0)
  const limit = compact ? 5 : 10
  // null = the helper says there is no posted sale to repeat.
  const repeatable = frequent.filter(f => f.last !== null)

  return (
    <DeskShell
      title={t('prodHome.desks.sales')}
      compact={compact}
      actions={<>
        <BigAction href="/zavod-sotuv/yangi" label={t('prodHome.sales.newSale')} icon={Plus} primary compact={compact} />
        {canPayments && <BigAction href="/zavod-mijoz-tolovlari?new=1" label={t('prodHome.sales.payment')} icon={CreditCard} compact={compact} />}
        <BigAction href="/zavod-mijozlar" label={t('prodHome.sales.customers')} icon={Contact} compact={compact} />
      </>}
      stats={<>
        <DeskStat label={t('prodHome.sales.todayTotal')} value={formatPrice(todayTotal)} loading={loading} />
        <DeskStat label={t('prodHome.sales.todayCount')} value={String(posted.length)} loading={loading} />
        <DeskStat label={t('prodHome.sales.overdueTotal')} value={formatPrice(overdueTotal)} tone={overdueTotal > 0 ? 'negative' : undefined} loading={loading} />
      </>}
    >
      <DeskList title={t('prodHome.sales.todayList')} href="/zavod-sotuv" loading={loading} empty={today.length === 0} emptyText={t('prodHome.sales.noneToday')}>
        {today.slice(0, limit).map(s => (
          <Link key={s.id} href={`/zavod-sotuv/${s.id}`} className={cn(deskRowCls, 'hover:bg-gray-50 dark:hover:bg-gray-800/40')}>
            <span className="w-12 shrink-0 tabular-nums text-gray-400 dark:text-gray-500">{hm(s.doc_date)}</span>
            <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">#{s.number} {s.customer_name}</span>
            <span className="shrink-0 tabular-nums font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(s.total))}</span>
            <DocStatusBadge status={s.status} />
          </Link>
        ))}
      </DeskList>
      <div className={cn('grid gap-4', !compact && 'lg:grid-cols-2')}>
        <DeskList title={t('prodHome.sales.repeatTitle')} loading={loading} empty={repeatable.length === 0} emptyText={t('prodHome.sales.noFrequent')}>
          {repeatable.map(f => (
            <div key={f.id} className={deskRowCls}>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-gray-900 dark:text-gray-100">{f.name}</span>
                {f.last && (
                  <span className="ml-1.5 text-[12px] text-gray-400 dark:text-gray-500">
                    {f.last.number !== null ? `#${f.last.number} · ` : ''}{f.last.itemNames.slice(0, 2).join(', ')}{f.last.lineCount > 2 ? ` +${f.last.lineCount - 2}` : ''}
                  </span>
                )}
              </span>
              <Link
                href={`/zavod-sotuv/yangi?customer=${encodeURIComponent(f.id)}&repeat=1`}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <Repeat className="h-4 w-4 text-gray-400" /> {t('prodHome.sales.repeat')}
              </Link>
            </div>
          ))}
        </DeskList>
        <DeskList title={t('prodHome.sales.overdueList')} href="/zavod-mijozlar" loading={loading} empty={debtors.length === 0} emptyText={t('prodHome.sales.noOverdue')}>
          {debtors.map(d => (
            <Link key={d.id} href={`/zavod-mijozlar/${d.id}`} className={cn(deskRowCls, 'hover:bg-gray-50 dark:hover:bg-gray-800/40')}>
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{d.name}</span>
              <span className="shrink-0 tabular-nums font-medium text-red-600 dark:text-red-400">{formatPrice(d.overdue)}</span>
            </Link>
          ))}
        </DeskList>
      </div>
    </DeskShell>
  )
}
