'use client'

// Role-based start page of production users (also the "Zavod" tab of retail
// firms with the production add-on). Owner / admin get the director
// dashboard (+ onboarding checklist); operators get their desk, or
// "Mening ishlarim" with all their desks as compact sections. The switcher
// "Bosh sahifa: [Avto | Dashboard | ...]" lists only pages the user may see.

import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { Skeleton } from '@/components/ui/skeleton'
import { Segmented } from '@/components/production/ProdKit'
import { useIsOwnerOrAdmin } from '@/components/production/MilkKit'
import { ProductionDashboard } from '@/components/production/ProductionDashboard'
import type { HomeChoice } from '@/lib/prefs'
import { useHomePref } from './useHomePref'
import { OnboardingChecklist } from './OnboardingChecklist'
import { LabDesk, MilkDesk } from './MilkDesks'
import { StockDesk } from './StockDesk'
import { SalesDesk } from './SalesDesk'
import { CashDesk } from './CashDesk'
import type { DeskKind } from './homeApi'

const CHOICE_KEYS: Record<HomeChoice, TranslationKey> = {
  auto: 'prodHome.switcher.auto',
  dashboard: 'prodHome.switcher.dashboard',
  milk: 'prodHome.switcher.milk',
  lab: 'prodHome.switcher.lab',
  stock: 'prodHome.switcher.stock',
  sales: 'prodHome.switcher.sales',
  cash: 'prodHome.switcher.cash',
}

const DESK_TITLE_KEYS: Record<DeskKind, TranslationKey> = {
  milk: 'prodHome.desks.milk',
  lab: 'prodHome.desks.lab',
  stock: 'prodHome.desks.stock',
  sales: 'prodHome.desks.sales',
  cash: 'prodHome.desks.cash',
}

function Desk({ kind, compact }: { kind: DeskKind; compact?: boolean }) {
  switch (kind) {
    case 'milk': return <MilkDesk compact={compact} />
    case 'lab': return <LabDesk compact={compact} />
    case 'stock': return <StockDesk compact={compact} />
    case 'sales': return <SalesDesk compact={compact} />
    case 'cash': return <CashDesk compact={compact} />
  }
}

function HomeSwitcher({ value, options, onChange }: { value: HomeChoice; options: HomeChoice[]; onChange: (v: HomeChoice) => void }) {
  const { t } = useLanguage()
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-[13px] text-gray-500 dark:text-gray-400">{t('prodHome.switcher.label')}:</span>
      <Segmented<HomeChoice> value={value} onChange={onChange} options={options.map(o => ({ value: o, label: t(CHOICE_KEYS[o]) }))} />
    </div>
  )
}

export function ProductionHome() {
  const { t } = useLanguage()
  const { loading, choice, options, resolved, change } = useHomePref()
  const isManager = useIsOwnerOrAdmin()

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-7 w-48" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[110px] rounded-xl" />)}
        </div>
      </div>
    )
  }

  // A stored choice the user may no longer see falls back to Avto in the switcher too.
  const value: HomeChoice = options.includes(choice) ? choice : 'auto'
  const switcher = <HomeSwitcher value={value} options={options} onChange={change} />

  if (resolved.kind === 'dashboard') {
    return (
      <div className="min-w-0 space-y-5">
        <div className="flex justify-end">{switcher}</div>
        {isManager && <OnboardingChecklist />}
        <ProductionDashboard />
      </div>
    )
  }

  const title = resolved.kind === 'desk' ? t(DESK_TITLE_KEYS[resolved.desk]) : t('prodHome.desks.mine')
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        {switcher}
      </div>
      {resolved.kind === 'desk'
        ? <Desk kind={resolved.desk} />
        : (
          <div className="grid gap-5 xl:grid-cols-2">
            {resolved.desks.map(d => <Desk key={d} kind={d} compact />)}
          </div>
        )}
    </div>
  )
}
