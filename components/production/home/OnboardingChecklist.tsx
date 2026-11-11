'use client'

// "Ishga tayyorlash": first-run checklist of a production firm, owner / admin
// only, shown on top of the dashboard until every step is done (then it can
// be hidden; remembered per company in localStorage). Status from
// prod_onboarding_status, else computed client-side (homeApi).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { useSession } from '@/lib/session/SessionContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { prodCardCls } from '@/components/production/ProdKit'
import { fetchOnboardingStatus, type OnboardingStatus } from './homeApi'

interface Step { key: string; href: string; title: TranslationKey; hint: TranslationKey; done: (s: OnboardingStatus) => boolean; ownerOnly?: boolean }

const STEPS: Step[] = [
  { key: 'warehouses', href: '/zavod-omborlar', title: 'prodHome.onboarding.warehouses', hint: 'prodHome.onboarding.warehousesHint', done: s => s.warehouses },
  { key: 'items', href: '/zavod-mahsulotlar', title: 'prodHome.onboarding.items', hint: 'prodHome.onboarding.itemsHint', done: s => s.items > 0 },
  { key: 'recipes', href: '/zavod-retseptlar', title: 'prodHome.onboarding.recipes', hint: 'prodHome.onboarding.recipesHint', done: s => s.recipes > 0 },
  { key: 'milk', href: '/sut-qabuli/sozlamalar', title: 'prodHome.onboarding.milk', hint: 'prodHome.onboarding.milkHint', done: s => s.milkSettings },
  { key: 'suppliers', href: '/zavod-yetkazuvchilar', title: 'prodHome.onboarding.suppliers', hint: 'prodHome.onboarding.suppliersHint', done: s => s.suppliers > 0 },
  { key: 'customers', href: '/zavod-mijozlar', title: 'prodHome.onboarding.customers', hint: 'prodHome.onboarding.customersHint', done: s => s.customers > 0 && s.priceLists > 0 },
  { key: 'cash', href: '/zavod-kassa', title: 'prodHome.onboarding.cash', hint: 'prodHome.onboarding.cashHint', done: s => s.cashOpeningSet },
  { key: 'staff', href: '/jamoa', title: 'prodHome.onboarding.staff', hint: 'prodHome.onboarding.staffHint', done: s => s.staff > 0 },
  // /zavod-nazorat is owner-only (proxy.ts); an admin does not get this step.
  { key: 'controls', href: '/zavod-nazorat', title: 'prodHome.onboarding.controls', hint: 'prodHome.onboarding.controlsHint', done: s => s.accountingSet && s.controlsReviewed, ownerOnly: true },
]

export function OnboardingChecklist() {
  const { t } = useLanguage()
  const { profile } = useSession()
  const isOwner = profile?.role === 'owner'
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [dismissed, setDismissed] = useLocalStorage<boolean>(`stylepro-prod-onboarding-hidden:${profile?.companyId ?? ''}`, false)

  useEffect(() => {
    let active = true
    fetchOnboardingStatus().then(s => { if (active) setStatus(s) })
    return () => { active = false }
  }, [])

  if (!status || dismissed) return null
  const steps = STEPS.filter(s => isOwner || !s.ownerOnly)
  const doneCount = steps.filter(s => s.done(status)).length
  const complete = doneCount === steps.length
  const pct = Math.round((doneCount / steps.length) * 100)
  const nextKey = steps.find(s => !s.done(status))?.key

  return (
    <section className={cn(prodCardCls, 'p-5')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('prodHome.onboarding.title')}</h2>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {complete ? t('prodHome.onboarding.complete') : t('prodHome.onboarding.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400">{doneCount} / {steps.length}</span>
          {complete && (
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <X className="h-4 w-4 text-gray-400" /> {t('prodHome.onboarding.hide')}
            </button>
          )}
        </div>
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        <div className="h-full rounded-full bg-gray-900 transition-all duration-200 dark:bg-gray-100" style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {steps.map((s, i) => {
          const done = s.done(status)
          return (
            <li key={s.key}>
              <Link
                href={s.href}
                className={cn(
                  'flex h-full items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                  s.key === nextKey
                    ? 'border-gray-300 bg-white hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:hover:bg-gray-800'
                    : 'border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60',
                )}
              >
                <span className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium',
                  done ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                )}>
                  {done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm font-medium', done ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100')}>{t(s.title)}</span>
                  <span className="block text-[12px] text-gray-400 dark:text-gray-500">{t(s.hint)}</span>
                </span>
                {!done && <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />}
              </Link>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
