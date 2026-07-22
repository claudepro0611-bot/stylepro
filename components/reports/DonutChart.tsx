'use client'

// Shared donut chart for the reports module (moliya's expense breakdown,
// inventar's product/category breakdown) — modern donut with hover-enlarge
// slices, a center total label, and a custom legend row (recharts' default
// Legend is dropped in favor of this so we control the value+%+foyda layout).

import { useState } from 'react'
import {
  PieChart, Pie, Cell, Sector, Tooltip, ResponsiveContainer,
} from 'recharts'
import type { PieSectorDataItem, PieLabelRenderProps } from 'recharts/types/polar/Pie'

export interface DonutSlice {
  key: string
  name: string
  value: number
  color: string
  /** Optional net-profit figure for this slice (so'm, can be negative — a
   * loss-making product/category is a real, unclamped negative number, not
   * clamped to 0). Only populated by callers that have profit data
   * (currently inventar's product/category donut, sourced from
   * transaction_items); left undefined by simpler donuts with no profit
   * concept (e.g. moliya's expense breakdown), which then render the
   * legend/tooltip without the extra profit row below. */
  profit?: number
}

interface DonutChartProps {
  data: DonutSlice[]
  formatValue: (n: number) => string
  isDark: boolean
  centerLabel: string
  height?: number
  /** Row labels for the tooltip/legend's revenue and profit lines — only
   * read when `data` entries actually carry `profit`; callers without
   * profit data don't need to pass these. */
  valueLabel?: string
  profitLabel?: string
}

// recharts 3.8.1 removed the old public `activeIndex` prop from Pie (see
// types/polar/Pie.d.ts — only `activeShape`/`inactiveShape` remain, both
// marked @deprecated in favor of a `shape` render prop, but still the only
// mechanism available for a per-slice hover-enlarge effect on this version).
// Pie internally tracks which slice is hovered via its own state and swaps
// in `activeShape` for that slice automatically — no external activeIndex
// wiring is needed (or possible) for the enlarge effect itself. We still
// track our own `hoveredIndex` via onMouseEnter/onMouseLeave below, but for
// a different purpose: syncing the legend row highlight to the hovered
// slice, which recharts has no built-in hook for.
function renderActiveShape(props: PieSectorDataItem) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props
  return (
    <Sector
      cx={cx}
      cy={cy}
      innerRadius={innerRadius}
      outerRadius={(outerRadius ?? 0) + 10}
      startAngle={startAngle}
      endAngle={endAngle}
      fill={fill}
      style={{ transition: 'd 200ms ease-out' }}
    />
  )
}

const RADIAN = Math.PI / 180

// Custom label renderer — replaces the previous `label={({percent}) => ...}`
// callback (which relied on recharts' default outside-label positioning and
// could overlap the legend below the chart at typical card widths). This
// computes an explicit point at the slice's mid-angle, half-way between the
// inner and outer radius, so the % text always sits inside its own slice.
function renderSliceLabel(props: PieLabelRenderProps) {
  const { cx, cy, midAngle, innerRadius, outerRadius, percent } = props
  if (!percent || percent <= 0.08) return null
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5
  const x = cx + radius * Math.cos(-(midAngle ?? 0) * RADIAN)
  const y = cy + radius * Math.sin(-(midAngle ?? 0) * RADIAN)
  return (
    <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  )
}

function DonutTooltip({ active, payload, formatValue, total, valueLabel, profitLabel }: {
  active?: boolean
  payload?: { payload: DonutSlice }[]
  formatValue: (n: number) => string
  total: number
  valueLabel?: string
  profitLabel?: string
}) {
  if (!active || !payload?.[0]) return null
  const d = payload[0].payload
  const pct = total > 0 ? (d.value / total) * 100 : 0
  return (
    <div className="rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-sm px-3 py-2 min-w-[160px]">
      <p className="text-[12px] font-semibold text-gray-900 dark:text-gray-100 mb-1">{d.name}</p>
      <div className="flex items-center justify-between gap-4 text-[12px] text-gray-500 dark:text-gray-400 py-0.5">
        <span>{valueLabel}</span>
        <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatValue(d.value)}</span>
      </div>
      {d.profit !== undefined && (
        <div className="flex items-center justify-between gap-4 text-[12px] text-gray-500 dark:text-gray-400 py-0.5">
          <span>{profitLabel}</span>
          <span className={`font-medium tabular-nums ${d.profit < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>
            {formatValue(d.profit)}
          </span>
        </div>
      )}
      <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{pct.toFixed(0)}%</div>
    </div>
  )
}

// `isDark` is accepted for API compatibility with existing callers (both
// moliya and inventar pass it) but isn't read here: the legend/tooltip below
// are styled with Tailwind's `dark:` variants directly rather than JS-side
// isDark branching.
export function DonutChart({
  data, formatValue, centerLabel, height = 280, valueLabel, profitLabel,
}: DonutChartProps) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              labelLine={false}
              label={renderSliceLabel}
              activeShape={renderActiveShape}
              onMouseEnter={(_, index) => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              isAnimationActive={true}
              animationBegin={0}
              animationDuration={600}
              animationEasing="ease-out"
            >
              {data.map(d => <Cell key={d.key} fill={d.color} />)}
            </Pie>
            <Tooltip content={<DonutTooltip formatValue={formatValue} total={total} valueLabel={valueLabel} profitLabel={profitLabel} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-[11px] text-gray-400 dark:text-gray-500">{centerLabel}</p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatValue(total)}</p>
        </div>
      </div>

      {/* Custom legend — a 2nd line with "foyda" appears per row only when
          the slice carries profit data, so plain (no-profit) donuts like
          moliya's keep the original single-line row. */}
      <div className="mt-3 space-y-1.5">
        {data.map((d, i) => (
          <div
            key={d.key}
            className={`rounded-md px-1 -mx-1 py-0.5 transition-colors ${hoveredIndex === i ? 'bg-gray-50 dark:bg-gray-800/60' : ''}`}
          >
            <div className="flex items-center justify-between gap-3 text-[12.5px]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: d.color }} />
                <span className="truncate text-gray-600 dark:text-gray-400">{d.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 tabular-nums">
                <span className="font-medium text-gray-900 dark:text-gray-100">{formatValue(d.value)}</span>
                <span className="w-9 text-right text-gray-400 dark:text-gray-500">
                  {total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : '0%'}
                </span>
              </div>
            </div>
            {d.profit !== undefined && (
              <div className="flex items-center justify-between gap-3 pl-[18px] text-[11px] text-gray-400 dark:text-gray-500">
                <span>{profitLabel}</span>
                <span className={`font-medium tabular-nums ${d.profit < 0 ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                  {formatValue(d.profit)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
