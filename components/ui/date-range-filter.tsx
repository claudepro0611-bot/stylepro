'use client'

import { useState } from 'react'
import { CalendarIcon, ChevronDown } from 'lucide-react'
import type { DateRange } from '@daypicker/react'
import { enUS, ru, uz } from '@daypicker/react/locale'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { cn } from '@/lib/utils'
import { localYmd } from '@/lib/utils/date'

export const toYmd = localYmd

export interface DateRangeValue {
  from: string // YYYY-MM-DD, inclusive
  to: string   // YYYY-MM-DD, inclusive
}

const LOCALES = { uz, ru, en: enUS }


function parseYmd(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function formatDmy(value: string): string {
  const [y, m, d] = value.split('-')
  return `${d}.${m}.${y}`
}

function quickRanges(): { key: TranslationKey; range: DateRangeValue }[] {
  const now = new Date()
  const today = toYmd(now)
  const daysAgo = (n: number) => toYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n))
  const monthStart = toYmd(new Date(now.getFullYear(), now.getMonth(), 1))
  const prevMonthStart = toYmd(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const prevMonthEnd = toYmd(new Date(now.getFullYear(), now.getMonth(), 0))
  return [
    { key: 'common.dateRange.today', range: { from: today, to: today } },
    { key: 'common.dateRange.yesterday', range: { from: daysAgo(1), to: daysAgo(1) } },
    { key: 'common.dateRange.last7', range: { from: daysAgo(6), to: today } },
    { key: 'common.dateRange.last30', range: { from: daysAgo(29), to: today } },
    { key: 'common.dateRange.thisMonth', range: { from: monthStart, to: today } },
    { key: 'common.dateRange.lastMonth', range: { from: prevMonthStart, to: prevMonthEnd } },
  ]
}

interface DateRangeFilterProps {
  value: DateRangeValue | null
  onChange: (value: DateRangeValue | null) => void
  className?: string
}

export function DateRangeFilter({ value, onChange, className }: DateRangeFilterProps) {
  const { t, language } = useLanguage()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange | undefined>()
  const [month, setMonth] = useState<Date>(() => new Date())

  const handleOpenChange = (next: boolean) => {
    if (next) {
      const from = parseYmd(value?.from)
      setDraft(value ? { from, to: parseYmd(value.to) } : undefined)
      setMonth(from ?? new Date())
    }
    setOpen(next)
  }

  const commit = (range: DateRangeValue | null) => {
    onChange(range)
    setOpen(false)
  }

  const apply = () => {
    if (!draft?.from) return
    const from = toYmd(draft.from)
    const to = toYmd(draft.to ?? draft.from)
    commit(from <= to ? { from, to } : { from: to, to: from })
  }

  const label = value
    ? value.from === value.to
      ? formatDmy(value.from)
      : `${formatDmy(value.from)} – ${formatDmy(value.to)}`
    : t('common.dateRange.placeholder')

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              'flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] outline-none transition-colors focus:border-gray-400 dark:focus:border-gray-500',
              value
                ? 'border-gray-100 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
                : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800',
              className,
            )}
          />
        }
      >
        <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span className="whitespace-nowrap">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex gap-1 overflow-x-auto border-b border-gray-100 p-2 sm:w-36 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r dark:border-gray-800">
            {quickRanges().map(q => {
              const active = value?.from === q.range.from && value?.to === q.range.to
              return (
                <button
                  key={q.key}
                  type="button"
                  onClick={() => commit(q.range)}
                  className={cn(
                    'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors',
                    active
                      ? 'border border-slate-900 bg-slate-900 text-white shadow-sm dark:border-white dark:bg-white dark:text-gray-900'
                      : 'border border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100',
                  )}
                >
                  {t(q.key)}
                </button>
              )
            })}
          </div>
          <div className="p-2">
            <Calendar
              mode="range"
              selected={draft}
              onSelect={setDraft}
              month={month}
              onMonthChange={setMonth}
              locale={LOCALES[language]}
              weekStartsOn={1}
              disabled={{ after: new Date() }}
            />
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-gray-100 px-1 pt-2 dark:border-gray-800">
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {draft?.from
                  ? `${formatDmy(toYmd(draft.from))}${draft.to && toYmd(draft.to) !== toYmd(draft.from) ? ` – ${formatDmy(toYmd(draft.to))}` : ''}`
                  : t('common.dateRange.hint')}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => commit(null)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  {t('common.dateRange.clear')}
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={!draft?.from}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
                >
                  {t('common.dateRange.apply')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
