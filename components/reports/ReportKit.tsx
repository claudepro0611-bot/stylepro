'use client'

// Shared building blocks for the "Hisobotlar" report pages: header with a
// date range + export, KPI cards, and a sortable table. Every report uses
// the same pieces so they look and behave identically.

import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Download, Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { localYmd } from '@/lib/utils/date'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { BranchScopeLabel } from '@/components/reports/BranchScopeLabel'

export function monthToDate(): DateRangeValue {
  const now = new Date()
  return { from: localYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to: localYmd(now) }
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const csv = [headers, ...rows].map(r => r.map(cell).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}_${localYmd()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function ReportHeader({
  title, subtitle, range, onRangeChange, onExport, exportLabel, children, showBranch = false,
}: {
  title: string
  subtitle: string
  /** Show the active branch (Header switcher) under the subtitle when multi-branch. */
  showBranch?: boolean
  range: DateRangeValue | null
  onRangeChange?: (r: DateRangeValue | null) => void
  onExport?: () => void
  exportLabel: string
  children?: ReactNode
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>
          {showBranch && <BranchScopeLabel className="mt-1" />}
        </div>
        {onExport && (
          <button onClick={onExport} className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-medium text-white transition-colors">
            <Download className="h-4 w-4" /> {exportLabel}
          </button>
        )}
      </div>
      {(onRangeChange || children) && (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 flex flex-wrap items-center gap-2">
          {onRangeChange && <DateRangeFilter value={range} onChange={onRangeChange} />}
          {children}
        </div>
      )}
    </div>
  )
}

export function KpiGrid({ items }: { items: { label: string; value: string; icon: LucideIcon; tone?: 'positive' | 'negative' }[] }) {
  return (
    <div className={cn('grid grid-cols-2 gap-4', items.length >= 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
      {items.map(k => (
        <div key={k.label} className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
            <k.icon className="h-4 w-4 text-gray-400" />
          </div>
          <p className="mt-3 text-[12.5px] text-gray-500 dark:text-gray-400">{k.label}</p>
          <p className={cn(
            'mt-0.5 text-lg font-semibold tabular-nums',
            k.tone === 'negative' ? 'text-red-600 dark:text-red-400' : k.tone === 'positive' ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-gray-100',
          )}>{k.value}</p>
        </div>
      ))}
    </div>
  )
}

export interface ReportColumn<T> {
  key: string
  label: string
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
  sortValue?: (row: T) => number | string
  footer?: ReactNode
}

export function ReportTable<T>({
  rows, columns, rowKey, loading, emptyText, initialSort, pageSize = 25, onRowClick, selectedKey,
}: {
  rows: T[]
  columns: ReportColumn<T>[]
  rowKey: (row: T) => string
  loading: boolean
  emptyText: string
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  pageSize?: number
  onRowClick?: (row: T) => void
  selectedKey?: string | null
}) {
  const [sort, setSort] = useState(initialSort ?? null)
  const [page, setPage] = useState(1)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find(c => c.key === sort.key)
    if (!col?.sortValue) return rows
    const get = col.sortValue
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b)
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, columns, sort])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const paginated = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)
  const hasFooter = columns.some(c => c.footer !== undefined)

  function toggleSort(key: string) {
    setSort(prev => (prev?.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))
    setPage(1)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
        ) : rows.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{emptyText}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  {columns.map(c => (
                    <th key={c.key} className={cn('px-4 py-3 font-medium whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left')}>
                      {c.sortValue ? (
                        <button onClick={() => toggleSort(c.key)} className={cn('inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100 transition-colors', sort?.key === c.key && 'text-gray-900 dark:text-gray-100')}>
                          {c.label}
                          {sort?.key === c.key && (sort.dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                        </button>
                      ) : c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr
                    key={rowKey(r)}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={cn(
                      'border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors',
                      onRowClick && 'cursor-pointer',
                      selectedKey === rowKey(r) && 'bg-indigo-50/60 dark:bg-indigo-950/30',
                    )}
                  >
                    {columns.map(c => (
                      <td key={c.key} className={cn('px-4 py-2.5', c.align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : 'text-left')}>{c.render(r)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {hasFooter && (
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    {columns.map(c => (
                      <td key={c.key} className={cn('px-4 py-3', c.align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : 'text-left')}>{c.footer ?? ''}</td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
      <Pagination currentPage={safePage} totalPages={totalPages} totalItems={sorted.length} itemsPerPage={pageSize} onPageChange={setPage} />
    </div>
  )
}

export const segBtnCls = (active: boolean) => cn(
  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
  active
    ? 'bg-indigo-600 dark:bg-indigo-500 shadow-sm border border-indigo-600 dark:border-indigo-500 text-white'
    : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
)
