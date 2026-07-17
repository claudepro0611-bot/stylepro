'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'

export interface SearchSelectOption {
  value: string
  label: string
  sublabel?: string
  disabled?: boolean
}

interface SearchSelectProps {
  options: SearchSelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder: string
  focusRingClassName?: string
}

export function SearchSelect({ options, value, onChange, placeholder, focusRingClassName }: SearchSelectProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
  const selected = options.find(o => o.value === value)

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-left text-sm outline-none transition-colors focus:ring-2',
          selected ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500',
          focusRingClassName ?? 'focus:border-gray-400 dark:focus:border-gray-600 focus:ring-gray-100 dark:focus:ring-gray-800',
        )}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1.5 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 shadow-lg">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('common.searchPlaceholder')}
              className="h-8 w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-8 pr-2 text-[13px] text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-600 transition-colors"
            />
          </div>
          <div className="max-h-52 space-y-0.5 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-gray-400 dark:text-gray-500">{t('common.notFound')}</p>
            ) : filtered.map(o => (
              <button
                key={o.value}
                type="button"
                disabled={o.disabled}
                onClick={() => { onChange(o.value); setOpen(false); setSearch('') }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                  o.disabled
                    ? 'cursor-not-allowed text-gray-300 dark:text-gray-600'
                    : value === o.value
                      ? 'bg-gray-100 dark:bg-gray-800 font-medium text-gray-900 dark:text-gray-100'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800',
                )}
              >
                <span className="truncate">{o.label}</span>
                {o.sublabel && <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{o.sublabel}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
