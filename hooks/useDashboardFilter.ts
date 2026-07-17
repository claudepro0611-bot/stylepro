'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Transaction } from '@/lib/types'

export type DashboardPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'custom'

export interface ChartBucket {
  label: string
  current: number
  previous: number
}

export interface DateRange {
  start: string // YYYY-MM-DD, inclusive
  end: string // YYYY-MM-DD, inclusive
}

export const FILTER_ALL = 'Barchasi'

const DAY_MS = 24 * 60 * 60 * 1000

// Transaction.date may be a plain 'YYYY-MM-DD' (mock data) or a full ISO timestamp (real POS sales)
function dateOnly(date: string) {
  return date.slice(0, 10)
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10)
}

function parseUTC(s: string) {
  return new Date(`${s}T00:00:00.000Z`)
}

function addDays(d: Date, days: number) {
  return new Date(d.getTime() + days * DAY_MS)
}

function startOfWeekUTC(d: Date) {
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  return addDays(d, -day)
}

function computeRange(period: DashboardPeriod, customStart: string, customEnd: string): { range: DateRange; prevRange: DateRange } {
  const today = parseUTC(ymd(new Date()))

  let start: Date
  let end: Date

  switch (period) {
    case 'today':
      start = today; end = today
      break
    case 'yesterday':
      start = addDays(today, -1); end = addDays(today, -1)
      break
    case 'week': {
      const weekStart = startOfWeekUTC(today)
      start = weekStart; end = addDays(weekStart, 6)
      break
    }
    case 'month':
      start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))
      break
    case 'year':
      start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1))
      end = new Date(Date.UTC(today.getUTCFullYear(), 11, 31))
      break
    case 'custom': {
      let s = customStart ? parseUTC(customStart) : today
      let e = customEnd ? parseUTC(customEnd) : today
      if (s.getTime() > e.getTime()) [s, e] = [e, s]
      start = s; end = e
      break
    }
  }

  const lengthDays = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1
  const prevEnd = addDays(start, -1)
  const prevStart = addDays(prevEnd, -(lengthDays - 1))

  return {
    range: { start: ymd(start), end: ymd(end) },
    prevRange: { start: ymd(prevStart), end: ymd(prevEnd) },
  }
}

function inRange(date: string, range: DateRange) {
  const d = dateOnly(date)
  return d >= range.start && d <= range.end
}

export function useDashboardFilter(transactions: Transaction[], categoryById: Map<string, string>) {
  const [period, setPeriod] = useState<DashboardPeriod>('month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [category, setCategory] = useState(FILTER_ALL)
  const [paymentMethod, setPaymentMethod] = useState(FILTER_ALL)
  const [isPending, setIsPending] = useState(false)

  const { range, prevRange } = useMemo(
    () => computeRange(period, customStart, customEnd),
    [period, customStart, customEnd],
  )

  // brief recalculation indicator for a smooth UI transition when filters change
  useEffect(() => {
    setIsPending(true)
    const timeout = setTimeout(() => setIsPending(false), 250)
    return () => clearTimeout(timeout)
  }, [period, customStart, customEnd, category, paymentMethod])

  const filteredTransactions = useMemo(() => transactions.filter(tx => {
    if (tx.status !== 'completed') return false
    if (!inRange(tx.date, range)) return false
    if (paymentMethod !== FILTER_ALL && tx.paymentMethod !== paymentMethod) return false
    if (category !== FILTER_ALL && !tx.products.some(p => categoryById.get(p.productId) === category)) return false
    return true
  }), [transactions, range, category, paymentMethod, categoryById])

  const prevFilteredTransactions = useMemo(() => transactions.filter(tx => {
    if (tx.status !== 'completed') return false
    if (!inRange(tx.date, prevRange)) return false
    if (paymentMethod !== FILTER_ALL && tx.paymentMethod !== paymentMethod) return false
    if (category !== FILTER_ALL && !tx.products.some(p => categoryById.get(p.productId) === category)) return false
    return true
  }), [transactions, prevRange, category, paymentMethod, categoryById])

  const hasActiveFilters = period !== 'month' || category !== FILTER_ALL || paymentMethod !== FILTER_ALL

  function reset() {
    setPeriod('month')
    setCustomStart('')
    setCustomEnd('')
    setCategory(FILTER_ALL)
    setPaymentMethod(FILTER_ALL)
  }

  return {
    period, setPeriod,
    customStart, setCustomStart,
    customEnd, setCustomEnd,
    category, setCategory,
    paymentMethod, setPaymentMethod,
    range, prevRange,
    filteredTransactions, prevFilteredTransactions,
    hasActiveFilters,
    isPending,
    reset,
  }
}

// ─── Chart bucket builder ───────────────────────────────────────────────────
// Adapts the comparison chart's granularity to the selected period's length:
// single day -> 2-hour buckets, up to a week -> daily (weekday names),
// up to a month -> daily (day numbers), longer -> monthly.

export function buildChartBuckets(
  range: DateRange,
  prevRange: DateRange,
  curTxns: Transaction[],
  prvTxns: Transaction[],
  weekdayLabels: string[],
  monthLabels: string[],
): ChartBucket[] {
  const start = parseUTC(range.start)
  const end = parseUTC(range.end)
  const prevStart = parseUTC(prevRange.start)
  const daysInRange = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1

  if (daysInRange <= 1) {
    const HOUR_BUCKETS = ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00']
    const buckets = HOUR_BUCKETS.map(label => ({ label, current: 0, previous: 0 }))
    const add = (tx: Transaction, key: 'current' | 'previous') => {
      const ts = tx.createdAt ?? tx.date
      const hour = ts.length > 10 ? new Date(ts).getHours() : 0
      const idx = Math.min(Math.floor(hour / 2), buckets.length - 1)
      buckets[idx][key] += tx.totalAmount
    }
    curTxns.forEach(tx => add(tx, 'current'))
    prvTxns.forEach(tx => add(tx, 'previous'))
    return buckets
  }

  if (daysInRange <= 31) {
    const buckets: ChartBucket[] = []
    for (let i = 0; i < daysInRange; i++) {
      const d = addDays(start, i)
      const label = daysInRange <= 7 ? weekdayLabels[(d.getUTCDay() + 6) % 7] : String(d.getUTCDate())
      buckets.push({ label, current: 0, previous: 0 })
    }
    curTxns.forEach(tx => {
      const idx = Math.round((parseUTC(dateOnly(tx.date)).getTime() - start.getTime()) / DAY_MS)
      if (idx >= 0 && idx < buckets.length) buckets[idx].current += tx.totalAmount
    })
    prvTxns.forEach(tx => {
      const idx = Math.round((parseUTC(dateOnly(tx.date)).getTime() - prevStart.getTime()) / DAY_MS)
      if (idx >= 0 && idx < buckets.length) buckets[idx].previous += tx.totalAmount
    })
    return buckets
  }

  const monthsInRange = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1
  const buckets: ChartBucket[] = []
  for (let i = 0; i < monthsInRange; i++) {
    const m = (start.getUTCMonth() + i) % 12
    buckets.push({ label: monthLabels[m], current: 0, previous: 0 })
  }
  const monthIndex = (d: Date, base: Date) =>
    (d.getUTCFullYear() - base.getUTCFullYear()) * 12 + (d.getUTCMonth() - base.getUTCMonth())
  curTxns.forEach(tx => {
    const idx = monthIndex(parseUTC(dateOnly(tx.date)), start)
    if (idx >= 0 && idx < buckets.length) buckets[idx].current += tx.totalAmount
  })
  prvTxns.forEach(tx => {
    const idx = monthIndex(parseUTC(dateOnly(tx.date)), prevStart)
    if (idx >= 0 && idx < buckets.length) buckets[idx].previous += tx.totalAmount
  })
  return buckets
}
