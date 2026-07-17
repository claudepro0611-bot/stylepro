'use client'

import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'

interface PaginationProps {
  currentPage: number
  totalPages: number
  totalItems: number
  itemsPerPage: number
  onPageChange: (page: number) => void
}

export function Pagination({ currentPage, totalPages, totalItems, itemsPerPage, onPageChange }: PaginationProps) {
  const { t } = useLanguage()
  if (totalPages <= 1) return null

  const start = (currentPage - 1) * itemsPerPage + 1
  const end = Math.min(currentPage * itemsPerPage, totalItems)

  const delta = 2
  const rangeStart = Math.max(1, currentPage - delta)
  const rangeEnd = Math.min(totalPages, currentPage + delta)
  const pages: number[] = []
  for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i)

  const btn = (p: number) => (
    <button
      key={p}
      onClick={() => onPageChange(p)}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded text-xs font-medium transition-colors',
        currentPage === p
          ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800',
      )}
    >
      {p}
    </button>
  )

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 transition-colors duration-200">
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {totalItems > 0 ? `${start}–${end} / ${totalItems} ${t('common.unitsSuffix')}` : t('common.noData')}
      </p>
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="flex h-7 w-7 items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {rangeStart > 1 && (
          <>
            {btn(1)}
            {rangeStart > 2 && <span className="text-gray-300 dark:text-gray-600 px-1 text-xs">…</span>}
          </>
        )}
        {pages.map(p => btn(p))}
        {rangeEnd < totalPages && (
          <>
            {rangeEnd < totalPages - 1 && <span className="text-gray-300 dark:text-gray-600 px-1 text-xs">…</span>}
            {btn(totalPages)}
          </>
        )}
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="flex h-7 w-7 items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
