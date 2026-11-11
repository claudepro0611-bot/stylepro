'use client'

// Chart building blocks of the production director dashboard: a themed card
// with per-block skeleton / empty state, a readable tooltip, a KPI sparkline,
// a donut with its legend (shared EChartsDonut renderer, same as the retail
// dashboard and the reports donuts) and the delta pill. Colors follow the
// retail dashboard's chart tokens so both dashboards look alike in light and
// dark mode.

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTheme } from 'next-themes'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { EChartsDonut } from '@/components/charts/EChartsDonut'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { sliceColor, type Slice } from '@/lib/production-dashboard'

/** Theme-aware chart tokens (same values as app/(dashboard)/dashboard/page.tsx). */
export function useChartTheme() {
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = mounted && resolvedTheme === 'dark'
  return {
    isDark,
    axisTick: { fill: isDark ? '#A1A1AA' : '#6B7280', fontSize: 11 },
    grid: { strokeDasharray: '3 3', stroke: isDark ? 'rgba(255,255,255,0.08)' : '#E5E7EB', vertical: false } as const,
    cursor: isDark ? 'rgba(255,255,255,0.06)' : '#F3F4F6',
    /** Main series (monochrome-strong, like the retail revenue line). */
    primary: isDark ? '#9AA8E0' : '#1B4965',
    /** Secondary / comparison series. */
    soft: '#A1A1AA',
    accent: '#62B6CB',
    /** Semantic: overdue / negative. */
    danger: isDark ? '#F87171' : '#DC2626',
    dotStroke: isDark ? '#111827' : '#FFFFFF',
  }
}

export function ChartCard({ title, subtitle, href, linkLabel, action, loading, empty, emptyText, height = 260, autoHeight, className, footer, children }: {
  title: string
  subtitle?: string
  href?: string
  linkLabel?: string
  action?: ReactNode
  loading: boolean
  empty: boolean
  emptyText: string
  /** Height of the plot (and of its skeleton / empty state). */
  height?: number
  /** Content sizes itself (donut + legend); `height` then only sizes the placeholders. */
  autoHeight?: boolean
  className?: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {action}
          {href && linkLabel && (
            <Link href={href} className="text-[13px] text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">{linkLabel}</Link>
          )}
        </div>
      </div>
      {loading ? (
        <Skeleton className="w-full rounded-lg" style={{ height }} />
      ) : empty ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-100 text-sm text-gray-400 dark:border-gray-800 dark:text-gray-500" style={{ height }}>
          {emptyText}
        </div>
      ) : (
        <div style={autoHeight ? undefined : { height }} className="min-w-0">{children}</div>
      )}
      {!loading && !empty && footer}
    </div>
  )
}

interface TooltipEntry { name?: string | number; dataKey?: string | number; value?: number | string; color?: string; payload?: Record<string, unknown> }

/**
 * Tooltip body: bucket label, then one row per series with its swatch and
 * formatted value. `extra` adds rows computed from the hovered datum.
 */
export function ChartTooltip({ active, payload, label, labelOf, names, format, extra }: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  labelOf?: (label: string) => string
  names?: Record<string, string>
  format: (value: number, key: string) => string
  extra?: (datum: Record<string, unknown>) => { label: string; value: string; tone?: 'negative' }[]
}) {
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload ?? {}
  const rows = extra ? extra(datum) : []
  const title = label === undefined ? '' : labelOf ? labelOf(String(label)) : String(label)
  return (
    <div className="min-w-[180px] space-y-1 rounded-lg border border-gray-200 bg-white p-2.5 text-[12px] shadow-md dark:border-gray-700 dark:bg-gray-900">
      {title && <p className="font-medium text-gray-500 dark:text-gray-400">{title}</p>}
      {payload.map(p => {
        const key = String(p.dataKey ?? p.name ?? '')
        return (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
              <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} />
              {names?.[key] ?? String(p.name ?? key)}
            </span>
            <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{format(Number(p.value ?? 0), key)}</span>
          </div>
        )
      })}
      {rows.map(r => (
        <div key={r.label} className="flex items-center justify-between gap-4 pl-3.5">
          <span className="text-gray-500 dark:text-gray-400">{r.label}</span>
          <span className={cn('font-medium tabular-nums', r.tone === 'negative' ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

export function LegendRow({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map(i => (
        <span key={i.label} className="flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400">
          {i.dashed
            ? <span className="inline-block w-4 shrink-0 border-t-2 border-dashed" style={{ borderColor: i.color }} />
            : <span className="inline-block h-2 w-4 shrink-0 rounded-sm" style={{ background: i.color }} />}
          {i.label}
        </span>
      ))}
    </div>
  )
}

/** Tiny monochrome trend line under a KPI value (no axes, no tooltip). */
export function Sparkline({ data }: { data: number[] }) {
  const { isDark } = useChartTheme()
  if (data.length < 2 || data.every(v => v === 0)) return <div className="h-8" />
  const points = data.map((v, i) => ({ i, v }))
  return (
    <div className="h-8">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
          <Line type="monotone" dataKey="v" stroke={isDark ? '#71717A' : '#9CA3AF'} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Green / red change pill vs the previous period; a muted dash when there is no base. */
export function DeltaPill({ value, title }: { value: number | null; title: string }) {
  if (value === null || !Number.isFinite(value)) {
    return <span title={title} className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">—</span>
  }
  const up = value >= 0
  return (
    <span title={title} className={cn(
      'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
      up ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400',
    )}>
      {up ? '+' : '−'}{Math.abs(value).toFixed(1)}%
    </span>
  )
}

/** Donut (max 6 slices, caller slices with topSlices) with a centre total and a value / % legend. */
export function DonutBlock({ slices, format, centerLabel, height = 200 }: {
  slices: Slice[]
  format: (n: number) => string
  centerLabel: string
  height?: number
}) {
  const { isDark } = useChartTheme()
  const [hovered, setHovered] = useState<number | null>(null)
  const data = slices.map((s, i) => ({ ...s, color: sliceColor(s.key, i) }))
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="flex h-full flex-col">
      <EChartsDonut
        data={data}
        isDark={isDark}
        height={height}
        formatValue={format}
        centerLabel={centerLabel}
        centerValue={format(total)}
        onHoverChange={setHovered}
        showLegend={false}
      />
      <div className="mt-2 space-y-1">
        {data.map((d, i) => (
          <div key={d.key} className={cn('-mx-1 flex items-center justify-between gap-3 rounded-md px-1 py-0.5 text-[12.5px] transition-colors', hovered === i && 'bg-gray-50 dark:bg-gray-800/60')}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: d.color }} />
              <span className="truncate text-gray-600 dark:text-gray-400">{d.name}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 tabular-nums">
              <span className="font-medium text-gray-900 dark:text-gray-100">{format(d.value)}</span>
              <span className="w-9 text-right text-gray-400 dark:text-gray-500">{total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : '0%'}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Loading placeholder for a list card body. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return <div className="space-y-2 p-4">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
}
