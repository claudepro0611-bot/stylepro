'use client'

import { DATE_PERIODS, type Period } from '@/lib/reports/period'
import { useLanguage } from '@/lib/i18n/LanguageContext'

// Shared period-filter bar for the two reports pages (moliya/inventar) —
// same pill/date-input conventions as the original reports/page.tsx and
// customers/page.tsx's Karta tab filters, extracted here so both pages don't
// duplicate the pill row + custom date range inputs.

interface ReportPeriodFilterBarProps {
  period: Period
  onPeriodChange: (p: Period) => void
  customFrom: string
  onCustomFromChange: (v: string) => void
  customTo: string
  onCustomToChange: (v: string) => void
}

const PILL_CLS = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
  }`

const DATE_INPUT_CLS = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

export function ReportPeriodFilterBar({
  period, onPeriodChange, customFrom, onCustomFromChange, customTo, onCustomToChange,
}: ReportPeriodFilterBarProps) {
  const { t } = useLanguage()

  return (
    <div className="flex flex-wrap items-center gap-2">
      {DATE_PERIODS.map(dp => (
        <button key={dp.value} onClick={() => onPeriodChange(dp.value)} className={PILL_CLS(period === dp.value)}>
          {t(dp.labelKey)}
        </button>
      ))}
      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 ml-1">
          <input type="date" value={customFrom} onChange={e => onCustomFromChange(e.target.value)} className={DATE_INPUT_CLS} />
          <span className="text-[12px] text-gray-400">—</span>
          <input type="date" value={customTo} onChange={e => onCustomToChange(e.target.value)} className={DATE_INPUT_CLS} />
        </div>
      )}
    </div>
  )
}
