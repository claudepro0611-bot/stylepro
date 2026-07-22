'use client'

// Shared donut chart for the reports module (moliya's expense breakdown,
// inventar's product/category breakdown) — modern donut with hover-enlarge
// slices, a center total label, and a custom legend row (recharts' default
// Legend is dropped in favor of this so we control the value+% layout).

import {
  PieChart, Pie, Cell, Sector, Tooltip, ResponsiveContainer,
} from 'recharts'
import type { PieSectorDataItem } from 'recharts/types/polar/Pie'

export interface DonutSlice {
  key: string
  name: string
  value: number
  color: string
}

interface DonutChartProps {
  data: DonutSlice[]
  formatValue: (n: number) => string
  isDark: boolean
  centerLabel: string
  height?: number
}

function renderActiveShape(props: PieSectorDataItem) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props
  return (
    <Sector
      cx={cx}
      cy={cy}
      innerRadius={innerRadius}
      outerRadius={(outerRadius ?? 0) + 8}
      startAngle={startAngle}
      endAngle={endAngle}
      fill={fill}
    />
  )
}

export function DonutChart({ data, formatValue, isDark, centerLabel, height = 280 }: DonutChartProps) {
  const total = data.reduce((s, d) => s + d.value, 0)

  const tooltipStyle = {
    contentStyle: { background: isDark ? '#111827' : '#fff', border: '1px solid ' + (isDark ? '#374151' : '#E5E7EB'), borderRadius: 8, fontSize: 12 },
    labelStyle: { color: isDark ? '#D1D5DB' : '#374151' },
  }

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
              label={({ percent }) => (percent ?? 0) > 0.05 ? `${((percent ?? 0) * 100).toFixed(0)}%` : ''}
              activeShape={renderActiveShape}
            >
              {data.map(d => <Cell key={d.key} fill={d.color} />)}
            </Pie>
            <Tooltip {...tooltipStyle} formatter={(v) => formatValue(Number(v))} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-[11px] text-gray-400 dark:text-gray-500">{centerLabel}</p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatValue(total)}</p>
        </div>
      </div>

      {/* Custom legend */}
      <div className="mt-3 space-y-1.5">
        {data.map(d => (
          <div key={d.key} className="flex items-center justify-between gap-3 text-[12.5px]">
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
        ))}
      </div>
    </div>
  )
}
