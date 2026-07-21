// Shared period-filter model for the reports module (moliya + inventar
// pages). Extends the six-option spec (Bugun / Bu hafta / Bu oy / O'tgan oy /
// Yil / custom) — the original app/(dashboard)/reports/page.tsx only
// supported week/month/year/custom; 'today' and 'lastMonth' are added here
// rather than duplicated as a parallel implementation.
import type { TranslationKey } from '@/lib/i18n/translations'

export type Period = 'today' | 'week' | 'month' | 'lastMonth' | 'year' | 'custom'

export const TODAY = new Date().toISOString().slice(0, 10)

export const DATE_PERIODS: { value: Period; labelKey: TranslationKey }[] = [
  { value: 'today', labelKey: 'reports.periods.today' },
  { value: 'week', labelKey: 'reports.periods.week' },
  { value: 'month', labelKey: 'reports.periods.month' },
  { value: 'lastMonth', labelKey: 'reports.periods.lastMonth' },
  { value: 'year', labelKey: 'reports.periods.year' },
  { value: 'custom', labelKey: 'reports.periods.custom' },
]

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function periodRange(period: Period, customFrom: string, customTo: string): [string, string] {
  const [ty, tm, td] = TODAY.split('-').map(Number)
  switch (period) {
    case 'today':
      return [TODAY, TODAY]
    case 'week': {
      const d = new Date(Date.UTC(ty, tm - 1, td))
      d.setUTCDate(d.getUTCDate() - 6)
      return [ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), TODAY]
    }
    case 'month': {
      const d = new Date(Date.UTC(ty, tm - 1, td))
      d.setUTCDate(d.getUTCDate() - 29)
      return [ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), TODAY]
    }
    case 'lastMonth': {
      // Previous full calendar month (1st to last day), not a rolling
      // 30-day window — distinct from 'month' above.
      let y = ty
      let m = tm - 1
      if (m === 0) { m = 12; y -= 1 }
      const first = ymd(y, m, 1)
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate() // day 0 of next month = last day of this month
      const last = ymd(y, m, lastDay)
      return [first, last]
    }
    case 'year':
      return [`${ty}-01-01`, TODAY]
    case 'custom':
      if (customFrom && customTo) return customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom]
      return [`${ty}-01-01`, TODAY]
  }
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000)
}
