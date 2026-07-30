'use client'

// Shared donut chart for the reports module (moliya's expense breakdown,
// inventar's product/category breakdown) — Apache ECharts donut (rounded
// slice corners, gaps between slices, top category legend) via the shared
// EChartsDonut wrapper, plus a custom legend row below it (so we keep
// control of the value+%+foyda layout, which ECharts' own legend can't show).

import { useState } from 'react'
import { EChartsDonut } from '@/components/charts/EChartsDonut'

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

export function DonutChart({
  data, formatValue, isDark, centerLabel, height = 280, valueLabel, profitLabel,
}: DonutChartProps) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  return (
    <div>
      <div className="relative">
        <EChartsDonut
          data={data}
          isDark={isDark}
          height={height}
          formatValue={formatValue}
          valueLabel={valueLabel}
          centerLabel={centerLabel}
          centerValue={formatValue(total)}
          onHoverChange={setHoveredIndex}
          tooltipExtra={index => {
            const d = data[index]
            if (!d || d.profit === undefined) return null
            return { label: profitLabel ?? '', value: formatValue(d.profit), negative: d.profit < 0 }
          }}
        />
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
