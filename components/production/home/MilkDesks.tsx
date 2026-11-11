'use client'

// Weighbridge (prod_milk) and laboratory (prod_lab) desks.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { FlaskConical, List, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { localYmd } from '@/lib/utils/date'
import { formatQty, rangeToIsoBounds } from '@/lib/production'
import { MilkStatusBadge } from '@/components/production/MilkKit'
import { BigAction, DeskList, DeskShell, DeskStat, deskRowCls, hm } from './DeskKit'
import { fetchSupplierNames } from './homeApi'

interface IntakeRow { id: string; number: number; intake_date: string; supplier_id: string; net_kg: number; status: string; lab_at: string | null }

const COLS = 'id, number, intake_date, supplier_id, net_kg, status, lab_at'
const QUEUE_MAX = 30

function useIntakes(withQueue: boolean) {
  const [today, setToday] = useState<IntakeRow[]>([])
  const [queue, setQueue] = useState<IntakeRow[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const supabase = createClient()
    const day = localYmd()
    const { fromIso, toIso } = rangeToIsoBounds({ from: day, to: day })
    Promise.all([
      fetchAllRows<IntakeRow>((from, to) => supabase.from('prod_milk_intakes').select(COLS)
        .gte('intake_date', fromIso).lt('intake_date', toIso).order('intake_date', { ascending: false }).order('id').range(from, to)),
      // Waiting for the lab: every weighed intake, oldest first (also from earlier days).
      withQueue
        ? supabase.from('prod_milk_intakes').select(COLS).eq('status', 'weighed').order('intake_date').limit(QUEUE_MAX)
        : Promise.resolve({ data: [] as IntakeRow[] }),
      fetchSupplierNames(),
    ]).then(([t, q, n]) => {
      if (!active) return
      setToday(t.data)
      setQueue((q.data ?? []) as IntakeRow[])
      setNames(n)
      setLoading(false)
    })
    return () => { active = false }
  }, [withQueue])

  return { today, queue, names, loading }
}

export function MilkDesk({ compact }: { compact?: boolean }) {
  const { t } = useLanguage()
  const { today, names, loading } = useIntakes(false)
  const kg = t('production.units.kg')
  const live = useMemo(() => today.filter(r => r.status !== 'cancelled'), [today])
  const totalKg = live.reduce((s, r) => s + Number(r.net_kg), 0)
  const waiting = live.filter(r => r.status === 'weighed').length
  const rows = compact ? today.slice(0, 5) : today

  return (
    <DeskShell
      title={t('prodHome.desks.milk')}
      compact={compact}
      actions={<>
        <BigAction href="/sut-qabuli/yangi" label={t('prodHome.milk.newIntake')} icon={Plus} primary compact={compact} />
        <BigAction href="/sut-qabuli" label={t('prodHome.milk.allIntakes')} icon={List} compact={compact} />
      </>}
      stats={<>
        <DeskStat label={t('prodHome.milk.todayKg')} value={`${formatQty(totalKg)} ${kg}`} loading={loading} />
        <DeskStat label={t('prodHome.milk.todayCount')} value={String(live.length)} loading={loading} />
        <DeskStat label={t('prodHome.lab.waiting')} value={String(waiting)} tone={waiting > 0 ? 'warning' : undefined} loading={loading} />
      </>}
    >
      <DeskList title={t('prodHome.milk.todayList')} href="/sut-qabuli" loading={loading} empty={today.length === 0} emptyText={t('prodHome.milk.noneToday')}>
        {rows.map(r => (
          <Link key={r.id} href={`/sut-qabuli/${r.id}`} className={`${deskRowCls} hover:bg-gray-50 dark:hover:bg-gray-800/40`}>
            <span className="w-12 shrink-0 tabular-nums text-gray-400 dark:text-gray-500">{hm(r.intake_date)}</span>
            <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">#{r.number} {names.get(r.supplier_id) ?? ''}</span>
            <span className="shrink-0 tabular-nums text-gray-700 dark:text-gray-300">{formatQty(Number(r.net_kg))} {kg}</span>
            <MilkStatusBadge status={r.status} />
          </Link>
        ))}
      </DeskList>
    </DeskShell>
  )
}

export function LabDesk({ compact }: { compact?: boolean }) {
  const { t } = useLanguage()
  const { today, queue, names, loading } = useIntakes(true)
  const kg = t('production.units.kg')
  const day = localYmd()
  // Decided today (by lab time), whatever day the milk was weighed.
  const decidedToday = today.filter(r => r.lab_at && localYmd(new Date(r.lab_at)) === day)
  const accepted = decidedToday.filter(r => r.status === 'accepted' || r.status === 'conditional').length
  const rejected = decidedToday.filter(r => r.status === 'rejected').length
  const rows = compact ? queue.slice(0, 5) : queue

  return (
    <DeskShell
      title={t('prodHome.desks.lab')}
      compact={compact}
      stats={<>
        <DeskStat label={t('prodHome.lab.waiting')} value={String(queue.length)} tone={queue.length > 0 ? 'warning' : undefined} loading={loading} />
        <DeskStat label={t('prodHome.lab.acceptedToday')} value={String(accepted)} tone={accepted > 0 ? 'positive' : undefined} loading={loading} />
        <DeskStat label={t('prodHome.lab.rejectedToday')} value={String(rejected)} tone={rejected > 0 ? 'negative' : undefined} loading={loading} />
      </>}
    >
      <DeskList title={t('prodHome.lab.queue')} href="/sut-qabuli" loading={loading} empty={queue.length === 0} emptyText={t('prodHome.lab.queueEmpty')}>
        {rows.map(r => (
          <div key={r.id} className={deskRowCls}>
            <span className="w-12 shrink-0 tabular-nums text-gray-400 dark:text-gray-500">
              {localYmd(new Date(r.intake_date)) === day ? hm(r.intake_date) : `${r.intake_date.slice(8, 10)}.${r.intake_date.slice(5, 7)}`}
            </span>
            <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">#{r.number} {names.get(r.supplier_id) ?? ''}</span>
            <span className="shrink-0 tabular-nums text-gray-700 dark:text-gray-300">{formatQty(Number(r.net_kg))} {kg}</span>
            <Link
              href={`/sut-qabuli/${r.id}`}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
            >
              <FlaskConical className="h-4 w-4 opacity-90" /> {t('prodHome.lab.enterResult')}
            </Link>
          </div>
        ))}
      </DeskList>
    </DeskShell>
  )
}
