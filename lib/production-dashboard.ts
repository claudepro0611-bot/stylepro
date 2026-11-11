// Pure helpers of the production (dairy plant) director dashboard
// (components/production/ProductionDashboard.tsx): period presets, the
// previous equal period, chart buckets and "top N + other" slicing. No
// Supabase access here; the component owns its queries.

import { localYmd } from '@/lib/utils/date'

export interface YmdRange { from: string; to: string }

export const DASH_PRESETS = ['today', 'last7', 'last30', 'thisMonth', 'lastMonth'] as const
export type DashPreset = typeof DASH_PRESETS[number]

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00`)
  d.setDate(d.getDate() + days)
  return localYmd(d)
}

/** Inclusive number of calendar days in the range. */
export function rangeDays(r: YmdRange): number {
  const a = new Date(`${r.from}T00:00:00`).getTime()
  const b = new Date(`${r.to}T00:00:00`).getTime()
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1)
}

export function presetRange(p: DashPreset, now = new Date()): YmdRange {
  const today = localYmd(now)
  switch (p) {
    case 'today': return { from: today, to: today }
    case 'last7': return { from: addDaysYmd(today, -6), to: today }
    case 'last30': return { from: addDaysYmd(today, -29), to: today }
    case 'thisMonth': return { from: localYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case 'lastMonth': return {
      from: localYmd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: localYmd(new Date(now.getFullYear(), now.getMonth(), 0)),
    }
  }
}

/** The preset a range equals (today's presets), or null for a custom range. */
export function matchPreset(r: YmdRange): DashPreset | null {
  return DASH_PRESETS.find(p => {
    const x = presetRange(p)
    return x.from === r.from && x.to === r.to
  }) ?? null
}

/** Equal-length period immediately before `r` (e.g. 1-11 Nov -> 21-31 Oct). */
export function previousRange(r: YmdRange): YmdRange {
  const n = rangeDays(r)
  return { from: addDaysYmd(r.from, -n), to: addDaysYmd(r.from, -1) }
}

/** Ranges longer than this are charted per month instead of per day. */
const MAX_DAILY_BUCKETS = 62

export type Granularity = 'day' | 'month'

export function granularityOf(r: YmdRange): Granularity {
  return rangeDays(r) > MAX_DAILY_BUCKETS ? 'month' : 'day'
}

/** Bucket key of a local "YYYY-MM-DD": the day itself or "YYYY-MM". */
export function bucketOf(ymd: string, g: Granularity): string {
  return g === 'month' ? ymd.slice(0, 7) : ymd
}

/** Every bucket key of the range, in order (so empty days still get a point). */
export function bucketKeys(r: YmdRange, g: Granularity): string[] {
  const out: string[] = []
  for (let d = r.from; d <= r.to; d = addDaysYmd(d, 1)) {
    const k = bucketOf(d, g)
    if (out[out.length - 1] !== k) out.push(k)
  }
  return out
}

/** Last local day covered by a bucket (clamped to the range end). */
export function bucketEndYmd(key: string, g: Granularity, rangeTo: string): string {
  if (g === 'day') return key
  const [y, m] = key.split('-').map(Number)
  const end = localYmd(new Date(y, m, 0))
  return end < rangeTo ? end : rangeTo
}

/** % change vs the previous value; null when there is nothing to compare with. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null
  return ((cur - prev) / Math.abs(prev)) * 100
}

export interface Slice { key: string; name: string; value: number }

/**
 * Largest `n` positive slices plus one "other" slice for the rest, so a donut
 * never has more than n + 1 slices.
 */
export function topSlices(slices: Slice[], n: number, otherName: string): Slice[] {
  const sorted = slices.filter(s => s.value > 0).sort((a, b) => b.value - a.value)
  if (sorted.length <= n + 1) return sorted
  const rest = sorted.slice(n).reduce((s, x) => s + x.value, 0)
  return [...sorted.slice(0, n), { key: '__other', name: otherName, value: rest }]
}

/**
 * Categorical palette of the dashboard charts, the same one the retail
 * dashboard and reports donuts use (mid-tones that read on both the white
 * and the gray-900 card). The last entry (neutral gray) is kept for "other".
 */
export const DASH_PALETTE = ['#2F7399', '#62B6CB', '#8B9BE0', '#5FA8D3', '#BEE9E8'] as const
export const DASH_OTHER_COLOR = '#A1A1AA'

export function sliceColor(key: string, index: number): string {
  return key === '__other' ? DASH_OTHER_COLOR : DASH_PALETTE[index % DASH_PALETTE.length]
}
