'use client'

import { useState, useEffect } from 'react'
import { CalendarDays, X } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'
import { FILTER_ALL, type DashboardPeriod } from '@/hooks/useDashboardFilter'
import type { DashboardConfig } from '@/hooks/useDashboardConfig'
import { DashboardCustomizeModal } from '@/components/dashboard/DashboardCustomizeModal'
import type { TranslationKey } from '@/lib/i18n/translations'

const PERIODS: { value: DashboardPeriod; key: TranslationKey }[] = [
  { value: 'today', key: 'dashboard.filters.periods.today' },
  { value: 'yesterday', key: 'dashboard.filters.periods.yesterday' },
  { value: 'week', key: 'dashboard.filters.periods.week' },
  { value: 'month', key: 'dashboard.filters.periods.month' },
  { value: 'year', key: 'dashboard.filters.periods.year' },
  { value: 'custom', key: 'dashboard.filters.periods.custom' },
]

const dateInputCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-8 pr-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-600 transition-colors'

interface DashboardFilterBarProps {
  config: DashboardConfig
  onCustomizeSave: (config: DashboardConfig) => void
  period: DashboardPeriod
  setPeriod: (p: DashboardPeriod) => void
  customStart: string
  setCustomStart: (s: string) => void
  customEnd: string
  setCustomEnd: (s: string) => void
  category: string
  setCategory: (c: string) => void
  paymentMethod: string
  setPaymentMethod: (p: string) => void
  hasActiveFilters: boolean
  reset: () => void
}

export function DashboardFilterBar({
  config, onCustomizeSave,
  period, setPeriod,
  customStart, setCustomStart,
  customEnd, setCustomEnd,
  category, setCategory,
  paymentMethod, setPaymentMethod,
  hasActiveFilters, reset,
}: DashboardFilterBarProps) {
  const { t } = useLanguage()

  // draft custom-range inputs, committed via "Qo'llash"
  const [draftStart, setDraftStart] = useState(customStart)
  const [draftEnd, setDraftEnd] = useState(customEnd)
  useEffect(() => { setDraftStart(customStart) }, [customStart])
  useEffect(() => { setDraftEnd(customEnd) }, [customEnd])

  function applyCustomRange() {
    setCustomStart(draftStart)
    setCustomEnd(draftEnd)
  }

  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 transition-colors duration-200 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Period tabs */}
        <div className="flex flex-wrap gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors duration-150',
                period === p.value
                  ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-gray-900/40 hover:text-gray-700 dark:hover:text-gray-300',
              )}
            >
              {t(p.key)}
            </button>
          ))}
        </div>

        <DashboardCustomizeModal config={config} onSave={onCustomizeSave} />
      </div>

      {/* Custom range */}
      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input
              type="date"
              value={draftStart}
              onChange={e => setDraftStart(e.target.value)}
              placeholder={t('dashboard.filters.customRange.start')}
              className={dateInputCls}
            />
          </div>
          <div className="relative">
            <CalendarDays className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input
              type="date"
              value={draftEnd}
              onChange={e => setDraftEnd(e.target.value)}
              placeholder={t('dashboard.filters.customRange.end')}
              className={dateInputCls}
            />
          </div>
          <button
            onClick={applyCustomRange}
            className="h-9 px-4 rounded-lg bg-slate-900 text-white text-[13px] font-medium transition-colors hover:bg-slate-800"
          >
            {t('dashboard.filters.customRange.apply')}
          </button>
        </div>
      )}

      {/* Active filter chips */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {period !== 'month' && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
              <CalendarDays className="h-3 w-3" />
              {t(PERIODS.find(p => p.value === period)?.key ?? 'dashboard.filters.periods.month')}
              <button onClick={() => setPeriod('month')} className="hover:text-gray-900 dark:hover:text-gray-100">
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {category !== FILTER_ALL && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
              {category}
              <button onClick={() => setCategory(FILTER_ALL)} className="hover:text-gray-900 dark:hover:text-gray-100">
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {paymentMethod !== FILTER_ALL && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
              {paymentMethod}
              <button onClick={() => setPaymentMethod(FILTER_ALL)} className="hover:text-gray-900 dark:hover:text-gray-100">
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          <button
            onClick={reset}
            className="text-[12px] font-medium text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            {t('dashboard.filters.clear')}
          </button>
        </div>
      )}
    </div>
  )
}
