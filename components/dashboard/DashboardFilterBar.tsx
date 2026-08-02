'use client'

import { useState, useEffect } from 'react'
import { CalendarDays, Download, Filter, X } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'
import { FILTER_ALL, type DashboardPeriod } from '@/hooks/useDashboardFilter'
import type { DashboardConfig } from '@/hooks/useDashboardConfig'
import { Switch } from '@/components/ui/switch'
import { DatePickerField } from '@/components/ui/date-picker-field'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { TranslationKey } from '@/lib/i18n/translations'

const PERIODS: { value: DashboardPeriod; key: TranslationKey }[] = [
  { value: 'today', key: 'dashboard.filters.periods.today' },
  { value: 'yesterday', key: 'dashboard.filters.periods.yesterday' },
  { value: 'week', key: 'dashboard.filters.periods.week' },
  { value: 'month', key: 'dashboard.filters.periods.month' },
  { value: 'year', key: 'dashboard.filters.periods.year' },
  { value: 'custom', key: 'dashboard.filters.periods.custom' },
]

const FILTER_SECTIONS: { titleKey: TranslationKey; rows: { key: keyof DashboardConfig; labelKey: TranslationKey }[] }[] = [
  {
    titleKey: 'dashboard.customize.sections.kpiCards',
    rows: [
      { key: 'showMonthlyRevenue', labelKey: 'dashboard.kpi.revenue' },
      { key: 'showTotalSales', labelKey: 'dashboard.kpi.sales' },
      { key: 'showLowStock', labelKey: 'dashboard.kpi.lowStock' },
      { key: 'showMonthlyGoal', labelKey: 'dashboard.kpi.monthlyGoal' },
      { key: 'showTodaySales', labelKey: 'dashboard.kpi.todaySales' },
    ],
  },
  {
    titleKey: 'dashboard.customize.sections.charts',
    rows: [
      { key: 'showDailyChart', labelKey: 'dashboard.customize.items.dailyChart' },
      { key: 'showTopProducts', labelKey: 'dashboard.topProducts.title' },
    ],
  },
  {
    titleKey: 'dashboard.customize.sections.tables',
    rows: [
      { key: 'showRecentSales', labelKey: 'dashboard.recentSales.title' },
    ],
  },
]

function FilterPanel({ config, onSave }: { config: DashboardConfig; onSave: (config: DashboardConfig) => void }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DashboardConfig>(config)

  useEffect(() => {
    if (open) setDraft(config)
  }, [open, config])

  const toggle = (key: keyof DashboardConfig) => {
    setDraft(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSave = () => {
    onSave(draft)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          />
        }
      >
        <Filter className="h-4 w-4" />
        {t('dashboard.filterButton')}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dashboard.customize.title')}</DialogTitle>
          <DialogDescription>{t('dashboard.customize.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {FILTER_SECTIONS.map((section, i) => (
            <div key={section.titleKey}>
              {i > 0 && <div className="border-t border-gray-100 dark:border-gray-800 mb-4" />}
              <p className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 tracking-wide uppercase mb-2">
                {t(section.titleKey)}
              </p>
              <div className="space-y-2.5">
                {section.rows.map(row => (
                  <div key={row.key} className="flex items-center justify-between">
                    <span className="text-[13px] text-gray-700 dark:text-gray-300">{t(row.labelKey)}</span>
                    <Switch checked={draft[row.key]} onCheckedChange={() => toggle(row.key)} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-3 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
          >
            {t('common.save')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface DashboardFilterBarProps {
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
  config: DashboardConfig
  onCustomizeSave: (config: DashboardConfig) => void
}

export function DashboardFilterBar({
  period, setPeriod,
  customStart, setCustomStart,
  customEnd, setCustomEnd,
  category, setCategory,
  paymentMethod, setPaymentMethod,
  hasActiveFilters, reset,
  config, onCustomizeSave,
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Period tabs */}
        <div className="flex flex-wrap gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors duration-150',
                period === p.value
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-gray-900/40 hover:text-gray-700 dark:hover:text-gray-300',
              )}
            >
              {t(p.key)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <FilterPanel config={config} onSave={onCustomizeSave} />
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 text-sm font-medium transition-colors shadow-lg shadow-blue-600/20"
          >
            <Download className="h-3.5 w-3.5" />
            Eksport
          </button>
        </div>
      </div>

      {/* Custom range */}
      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <DatePickerField
            onChange={setDraftStart}
            placeholder={t('dashboard.filters.customRange.start')}
            value={draftStart}
          />
          <DatePickerField
            onChange={setDraftEnd}
            placeholder={t('dashboard.filters.customRange.end')}
            value={draftEnd}
          />
          <button
            onClick={applyCustomRange}
            className="h-9 px-4 rounded-lg bg-blue-600 text-white text-[13px] font-medium transition-colors hover:bg-blue-700"
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
