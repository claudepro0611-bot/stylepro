'use client'

// UI pieces shared by the production reports (/zavod-hisobotlar) and the
// export buttons of the production list pages. Data helpers live in
// lib/production-reports.ts; the page header / date range / sortable table
// come from components/reports/ReportKit (same look as the retail reports).

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Download, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { prodFieldCls } from '@/components/production/ProdKit'

/**
 * Export (.xlsx). indigo-600 is the one accent CLAUDE.md reserves for
 * Export-class actions. Sized to sit next to the toolbar's secondary buttons.
 */
export function ExportButton({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label?: string }) {
  const { t } = useLanguage()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-3 text-sm font-medium text-white disabled:opacity-50 transition-colors"
    >
      <Download className="h-3.5 w-3.5" /> {label ?? t('prodReports.export')}
    </button>
  )
}

export interface ProdKpi {
  label: string
  value: string
  icon: LucideIcon
  sub?: string
  href?: string
  tone?: 'positive' | 'negative' | 'warning'
}

/** KPI cards (same layout as reports/ReportKit KpiGrid) with an optional sub line and link. */
export function ProdKpiGrid({ items, cols = 4 }: { items: ProdKpi[]; cols?: 3 | 4 }) {
  return (
    // One column below ~420px: long sums ("1 234 567 890 so'm") do not fit half a phone screen.
    <div className={cn('grid grid-cols-1 min-[420px]:grid-cols-2 gap-4', cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
      {items.map(k => {
        const body = (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
              <k.icon className="h-4 w-4 text-gray-400" />
            </div>
            <p className="mt-3 text-[12.5px] text-gray-500 dark:text-gray-400">{k.label}</p>
            <p className={cn(
              'mt-0.5 text-lg font-semibold tabular-nums break-words',
              k.tone === 'negative' ? 'text-red-600 dark:text-red-400'
                : k.tone === 'positive' ? 'text-emerald-600 dark:text-emerald-400'
                  : k.tone === 'warning' ? 'text-amber-700 dark:text-amber-400'
                    : 'text-gray-900 dark:text-gray-100',
            )}>{k.value}</p>
            {k.sub && <p className="mt-0.5 text-[12px] tabular-nums text-gray-500 dark:text-gray-400">{k.sub}</p>}
          </>
        )
        const cls = 'min-w-0 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-5'
        return k.href ? (
          <Link key={k.label} href={k.href} className={cn(cls, 'block hover:shadow-md transition-all duration-200')}>{body}</Link>
        ) : (
          <div key={k.label} className={cls}>{body}</div>
        )
      })}
    </div>
  )
}

/** Index card of a report. */
export function ReportNavCard({ href, title, description, icon: Icon }: { href: string; title: string; description: string; icon: LucideIcon }) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-4 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5 hover:shadow-md transition-all duration-200"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
        <Icon className="h-4 w-4 text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-100 transition-colors" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
        <p className="mt-0.5 text-[13px] text-gray-500 dark:text-gray-400">{description}</p>
      </div>
    </Link>
  )
}

/** Single date input with a label, styled like the other production fields. */
export function DateField({ value, onChange, label, max }: { value: string; onChange: (v: string) => void; label: string; max?: string }) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-gray-400">
      <span className="whitespace-nowrap">{label}</span>
      <input type="date" value={value} max={max} onChange={e => e.target.value && onChange(e.target.value)} className={cn(prodFieldCls, 'w-40')} />
    </label>
  )
}

/** Expand / collapse chevron for a table row. */
export function ExpandChevron({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={e => { e.stopPropagation(); onClick() }}
      className="flex h-4 w-4 shrink-0 items-center justify-center text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
    >
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
    </button>
  )
}

/** Quantity on top, money value below (turnover cells). */
export function QtyValueCell({ qty, value, muted }: { qty: ReactNode; value: ReactNode; muted?: boolean }) {
  return (
    <div className="text-right tabular-nums whitespace-nowrap">
      <p className={cn(muted ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100')}>{qty}</p>
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{value}</p>
    </div>
  )
}

/** Small inline select for report filter bars. */
export function FilterSelect({ value, onChange, children, className }: { value: string; onChange: (v: string) => void; children: ReactNode; className?: string }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={cn(prodFieldCls, 'w-48', className)}>
      {children}
    </select>
  )
}
