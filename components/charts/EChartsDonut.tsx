'use client'

// Shared Apache ECharts donut renderer used by the reports module's
// DonutChart (moliya/inventar) and the dashboard's "Top mahsulotlar" chart.
// Callers keep their own value/percent/profit legend rows below the chart
// (plain Tailwind markup, not chart-library-specific) — this component owns
// the pie/donut canvas itself: rounded slice corners, visible gaps between
// slices, donut shape, a top category legend, and an optional center total
// label rendered in-canvas (so it always aligns with the donut hole, even
// though the series center is offset down to make room for the legend).

import dynamic from 'next/dynamic'
import type { EChartsOption } from 'echarts'

// echarts-for-react touches `window` at import time, so it must be loaded
// client-only (this file is already 'use client', but Next still does an
// initial SSR pass of client components for hydration).
const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false })

export interface EChartsDonutSlice {
  key: string
  name: string
  value: number
  color: string
}

interface EChartsDonutProps {
  data: EChartsDonutSlice[]
  isDark: boolean
  height?: number
  /** Inner/outer radius as ECharts percentage strings. */
  radius?: [string, string]
  /** Formats the raw value for the tooltip (currency, unit count, etc). */
  formatValue?: (n: number) => string
  /** Label for the primary value row in the tooltip (e.g. "Daromad"). */
  valueLabel?: string
  /** Optional extra tooltip line appended below the value row (e.g. profit). */
  tooltipExtra?: (index: number) => { label: string; value: string; negative?: boolean } | null
  onHoverChange?: (index: number | null) => void
  centerLabel?: string
  centerValue?: string
  /** Shows ECharts' own top category legend. Defaults to true; pass false
   * when the caller already renders its own richer legend row (name + color
   * + value + % + profit) below the chart, to avoid showing the same
   * category names twice. */
  showLegend?: boolean
}

export function EChartsDonut({
  data, isDark, height = 240, radius = ['55%', '78%'], formatValue, valueLabel, tooltipExtra, onHoverChange,
  centerLabel, centerValue, showLegend = true,
}: EChartsDonutProps) {
  const cardBg = isDark ? '#111827' : '#FFFFFF'
  const tooltipBg = isDark ? '#1F2937' : '#FFFFFF'
  const tooltipBorder = isDark ? '#374151' : '#E5E7EB'
  const tooltipText = isDark ? '#F3F4F6' : '#111827'
  const legendText = isDark ? '#9CA3AF' : '#4B5563'
  const mutedText = isDark ? '#6B7280' : '#9CA3AF'

  const total = data.reduce((s, d) => s + d.value, 0)

  // Vertical anchor (as a % of the container) shared by the pie series and
  // the center-label graphic so the two always line up. Shifted down only
  // when the top legend is shown, to leave room for it.
  const centerY = showLegend ? '58%' : '50%'

  const option: EChartsOption = {
    backgroundColor: 'transparent',
    legend: showLegend
      ? {
          top: 0,
          left: 'center',
          icon: 'circle',
          itemWidth: 8,
          itemHeight: 8,
          textStyle: { color: legendText, fontSize: 11 },
        }
      : undefined,
    tooltip: {
      trigger: 'item',
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      borderWidth: 1,
      extraCssText: 'border-radius:8px;padding:8px 12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);',
      textStyle: { color: tooltipText, fontSize: 12 },
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params
        const idx = p.dataIndex ?? 0
        const raw = typeof p.value === 'number' ? p.value : Number(p.value)
        const valueStr = formatValue ? formatValue(raw) : String(raw)
        const pct = total > 0 ? ((raw / total) * 100).toFixed(0) : '0'
        const extra = tooltipExtra?.(idx)
        const extraRow = extra
          ? `<div style="display:flex;justify-content:space-between;gap:16px;color:${mutedText};margin-top:2px;">
               <span>${extra.label}</span>
               <span style="font-weight:500;color:${extra.negative ? '#dc2626' : tooltipText};">${extra.value}</span>
             </div>`
          : ''
        return `<div style="min-width:140px;">
            <div style="font-weight:600;margin-bottom:4px;">${p.marker}${p.name}</div>
            <div style="display:flex;justify-content:space-between;gap:16px;">
              <span style="color:${mutedText};">${valueLabel ?? ''}</span>
              <span style="font-weight:500;">${valueStr}</span>
            </div>
            ${extraRow}
            <div style="color:${mutedText};font-size:11px;margin-top:2px;">${pct}%</div>
          </div>`
      },
    },
    series: [
      {
        type: 'pie',
        radius,
        center: ['50%', centerY],
        avoidLabelOverlap: false,
        padAngle: 3,
        itemStyle: {
          borderRadius: 8,
          borderColor: cardBg,
          borderWidth: 2,
        },
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scaleSize: 6,
        },
        data: data.map(d => ({ name: d.name, value: d.value, itemStyle: { color: d.color } })),
      },
    ],
    graphic:
      centerLabel || centerValue
        ? {
            elements: [
              {
                type: 'text',
                left: 'center',
                top: `${parseFloat(centerY) - 6}%`,
                style: { text: centerLabel ?? '', fill: mutedText, fontSize: 11, align: 'center' },
              },
              {
                type: 'text',
                left: 'center',
                top: `${parseFloat(centerY)}%`,
                style: { text: centerValue ?? '', fill: tooltipText, fontSize: 14, fontWeight: 600, align: 'center' },
              },
            ],
          }
        : undefined,
  }

  return (
    <ReactECharts
      option={option}
      notMerge
      lazyUpdate
      style={{ height, width: '100%' }}
      onEvents={
        onHoverChange
          ? {
              mouseover: (params: { dataIndex?: number }) => onHoverChange(params.dataIndex ?? null),
              mouseout: () => onHoverChange(null),
              globalout: () => onHoverChange(null),
            }
          : undefined
      }
    />
  )
}
