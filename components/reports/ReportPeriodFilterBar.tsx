'use client'

import { periodRange, type Period } from '@/lib/reports/period'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'

// Shared period filter for the two reports pages (moliya/inventar), using the
// same calendar range picker as kirim/chiqim/arxiv/dashboard. A pick that
// matches a named period (today, last 7/30 days, last month, this year) maps
// back onto it; anything else becomes 'custom'.

interface ReportPeriodFilterBarProps {
  period: Period
  onPeriodChange: (p: Period) => void
  customFrom: string
  onCustomFromChange: (v: string) => void
  customTo: string
  onCustomToChange: (v: string) => void
}

const DEFAULT_PERIOD: Period = 'month'
const NAMED_PERIODS: Exclude<Period, 'custom'>[] = ['today', 'week', 'month', 'lastMonth', 'year']

export function ReportPeriodFilterBar({
  period, onPeriodChange, customFrom, onCustomFromChange, customTo, onCustomToChange,
}: ReportPeriodFilterBarProps) {
  const [from, to] = periodRange(period, customFrom, customTo)

  function handleChange(r: DateRangeValue | null) {
    if (!r) {
      onCustomFromChange('')
      onCustomToChange('')
      onPeriodChange(DEFAULT_PERIOD)
      return
    }
    const named = NAMED_PERIODS.find(p => {
      const [pf, pt] = periodRange(p, '', '')
      return pf === r.from && pt === r.to
    })
    if (named) { onPeriodChange(named); return }
    onCustomFromChange(r.from)
    onCustomToChange(r.to)
    onPeriodChange('custom')
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangeFilter value={{ from, to }} onChange={handleChange} />
    </div>
  )
}
