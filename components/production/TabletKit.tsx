'use client'

// Touch building blocks for the weigh station / lab tablet mode: the
// tablet-mode switch (prefs.tablet_mode or ?tablet=1, ?tablet=0 forces it off),
// a full-screen shell, a big numeric keypad and big value fields.
// Touch targets >= 48 px, text >= 18 px.

import { useEffect, useState, type ReactNode } from 'react'
import { Delete, X } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { usePrefs } from '@/lib/prefs'
import { cn } from '@/lib/utils'

/** null while the URL / prefs are unknown (first client render). */
export function useTabletMode(): boolean | null {
  const { prefs, loading } = usePrefs()
  const [param, setParam] = useState<'on' | 'off' | 'none' | null>(null)
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('tablet')
    setParam(v === '1' ? 'on' : v === '0' ? 'off' : 'none')
  }, [])
  if (param === null) return null
  if (param === 'on') return true
  if (param === 'off') return false
  if (loading) return null
  return prefs.tabletMode
}

export const tabletBtn = 'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 text-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'
export const tabletPrimaryBtn = cn(tabletBtn, 'bg-slate-900 hover:bg-slate-800 text-white dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900')
export const tabletSecondaryBtn = cn(tabletBtn, 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800')
export const tabletCardCls = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm'

/** Full-screen layer above the dashboard shell (sidebar / header hidden). */
export function TabletShell({ title, right, onExit, children }: {
  title: string
  right?: ReactNode
  onExit: () => void
  children: ReactNode
}) {
  const { t } = useLanguage()
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-gray-950 text-lg">
      <div className="flex min-h-16 flex-wrap items-center gap-3 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2">
        <h1 className="mr-auto text-xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        {right}
        <button type="button" onClick={onExit} className={tabletSecondaryBtn}>
          <X className="h-5 w-5" /> {t('prodOps.tablet.exit')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>
    </div>
  )
}

/** Appends a key to a decimal text value (one separator, max 3 decimals, max 9 chars). */
export function keypadInput(value: string, key: string): string {
  if (key === 'back') return value.slice(0, -1)
  if (key === 'clear') return ''
  if (key === '.') {
    if (value.includes('.')) return value
    return value === '' ? '0.' : `${value}.`
  }
  if (value.length >= 9) return value
  const dot = value.indexOf('.')
  if (dot >= 0 && value.length - dot > 3) return value
  if (value === '0') return key
  return value + key
}

const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', 'back'] as const

export function Keypad({ onKey, className }: { onKey: (key: string) => void; className?: string }) {
  const { t } = useLanguage()
  return (
    <div className={cn('grid grid-cols-3 gap-2', className)}>
      {KEYS.map(k => (
        <button
          key={k}
          type="button"
          onClick={() => onKey(k)}
          aria-label={k === 'back' ? t('prodOps.tablet.backspace') : k === '.' ? ',' : k}
          className="flex h-16 items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-2xl font-medium tabular-nums text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-800 transition-colors select-none"
        >
          {k === 'back' ? <Delete className="h-6 w-6" /> : k === '.' ? ',' : k}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onKey('clear')}
        className="col-span-3 flex h-12 items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-lg font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors select-none"
      >
        {t('prodOps.tablet.clear')}
      </button>
    </div>
  )
}

/** Tap-to-select value box; the active one receives keypad input. */
export function BigValueField({ label, value, unit, active, invalid, onSelect, placeholder = '0' }: {
  label: string
  value: string
  unit?: string
  active: boolean
  invalid?: boolean
  onSelect: () => void
  placeholder?: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'flex min-h-20 w-full flex-col items-start justify-center rounded-xl border bg-white dark:bg-gray-900 px-4 py-2 text-left transition-colors',
        active ? 'border-gray-900 dark:border-gray-100 shadow-sm' : 'border-gray-200 dark:border-gray-700',
        invalid && 'border-red-400 dark:border-red-500',
      )}
    >
      <span className="text-lg text-gray-500 dark:text-gray-400">{label}</span>
      <span className={cn('text-3xl font-semibold tabular-nums', value ? 'text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600')}>
        {value ? value.replace('.', ',') : placeholder}
        {unit && <span className="ml-1.5 text-xl font-medium text-gray-400 dark:text-gray-500">{unit}</span>}
      </span>
    </button>
  )
}
