'use client'

// Shared building blocks for the production module pages (list toolbar,
// column settings, status badges, document form pieces). Floxen monochrome:
// color only for semantic status.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, Ban, ChevronDown, Columns3, Eye, Loader2, Plus, RotateCcw, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useSession } from '@/lib/session/SessionContext'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NOTE_MAX, itemTypeKey, type ProdDocStatus } from '@/lib/production'

export const prodFieldCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors disabled:bg-gray-50 dark:disabled:bg-gray-800/60 disabled:text-gray-500'
export const prodLabelCls = 'mb-1 block text-[13px] font-medium text-gray-700 dark:text-gray-300'
export const prodCardCls = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm'
export const thCls = 'px-4 py-3 text-left font-medium whitespace-nowrap'
export const thRightCls = 'px-4 py-3 text-right font-medium whitespace-nowrap'
export const tdCls = 'px-4 py-2.5'
export const trCls = 'border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors'
export const secondaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors'

const primaryBtnCls = 'flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors'

export function PageHeader({ title, subtitle, actionLabel, actionHref, onAction }: {
  title: string
  subtitle?: string
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {actionLabel && actionHref && (
        <Link href={actionHref} className={primaryBtnCls}><Plus className="h-4 w-4" /> {actionLabel}</Link>
      )}
      {actionLabel && !actionHref && onAction && (
        <button type="button" onClick={onAction} className={primaryBtnCls}><Plus className="h-4 w-4" /> {actionLabel}</button>
      )}
    </div>
  )
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
      <ArrowLeft className="h-3.5 w-3.5" /> {label}
    </Link>
  )
}

/**
 * Filter toolbar card: main filters on the left, reset + export / column
 * settings on the right. `more` holds rarely used filters behind a "Filtrlar"
 * toggle (shown while one of them is set: `moreActive`).
 */
export function FilterBar({ children, onReset, columns, more, moreActive }: {
  children: ReactNode
  onReset?: () => void
  columns?: ReactNode
  more?: ReactNode
  moreActive?: boolean
}) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const shown = open || !!moreActive
  return (
    <div className={cn(prodCardCls, 'p-3 flex flex-wrap items-center gap-2')}>
      {children}
      {more && (
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={shown} className={cn(secondaryBtnCls, moreActive && 'border-gray-400 dark:border-gray-500')}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> {t('prodUx.filters')}
        </button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {onReset && (
          <button type="button" onClick={onReset} className={secondaryBtnCls} title={t('production.common.reset')} aria-label={t('production.common.reset')}>
            <RotateCcw className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{t('production.common.reset')}</span>
          </button>
        )}
        {columns}
      </div>
      {more && shown && <div className="flex w-full flex-wrap items-center gap-2 border-t border-gray-100 dark:border-gray-800 pt-2">{more}</div>}
    </div>
  )
}

/** Opens a "new" dialog when the page is reached with ?new=1 (dashboard shortcuts); the param is then dropped. */
export function useOpenOnNewParam(open: () => void, ready = true) {
  const done = useRef(false)
  useEffect(() => {
    if (done.current || !ready) return
    done.current = true
    const url = new URL(window.location.href)
    if (url.searchParams.get('new') !== '1') return
    url.searchParams.delete('new')
    window.history.replaceState(null, '', url.pathname + url.search)
    open()
  }, [open, ready])
}

/**
 * Remembered default per user and per document type (localStorage, try/catch):
 * applied once when the options arrive and nothing is chosen yet (a single
 * option is chosen automatically). Returns `remember(id)` to call after a save.
 */
export function useRememberedDefault(kind: string, ids: string[], value: string, setValue: (id: string) => void) {
  const { userId } = useSession()
  const key = `stylepro-prod-last:${userId ?? 'anon'}:${kind}`
  const applied = useRef(false)
  const idsKey = ids.join('|')
  useEffect(() => {
    if (applied.current || !userId || idsKey === '') return
    applied.current = true
    if (value) return
    const list = idsKey.split('|')
    let saved = ''
    try { saved = window.localStorage.getItem(key) ?? '' } catch {}
    if (saved && list.includes(saved)) setValue(saved)
    else if (list.length === 1) setValue(list[0])
  }, [idsKey, userId, key, value, setValue])
  return useCallback((id: string) => {
    try { if (id) window.localStorage.setItem(key, id) } catch {}
  }, [key])
}

/** "Qo'shimcha" disclosure for advanced form fields; shown while one of them is set (`active`). */
export function MoreFields({ children, active, label, className }: {
  children: ReactNode
  active?: boolean
  label?: string
  className?: string
}) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const shown = open || !!active
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={shown}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', shown ? 'rotate-0' : '-rotate-90')} />
        {label ?? t('prodUx.more')}
      </button>
      {shown && <div className="mt-3">{children}</div>}
    </div>
  )
}

/** Card section whose title folds its body (detail pages). */
export function CollapsibleCard({ title, defaultOpen = true, action, children }: {
  title: string
  defaultOpen?: boolean
  action?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cn(prodCardCls, 'overflow-hidden')}>
      <div className={cn('flex items-center justify-between gap-3 px-4 py-3', open && 'border-b border-gray-100 dark:border-gray-800')}>
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex min-w-0 items-center gap-1.5 text-left text-sm font-semibold text-gray-900 dark:text-gray-100">
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200', open ? 'rotate-0' : '-rotate-90')} />
          <span className="truncate">{title}</span>
        </button>
        {action}
      </div>
      {open && children}
    </div>
  )
}

export interface ColumnDef { key: string; label: string }

/** Hidden column keys, persisted per list in localStorage. */
export function useHiddenColumns(storageKey: string) {
  const [hidden, setHidden] = useLocalStorage<string[]>(`stylepro-cols:${storageKey}`, [])
  const isVisible = (key: string) => !hidden.includes(key)
  const toggle = (key: string) => setHidden(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]))
  return { isVisible, toggle }
}

export function ColumnSettings({ columns, isVisible, toggle }: {
  columns: ColumnDef[]
  isVisible: (key: string) => boolean
  toggle: (key: string) => void
}) {
  const { t } = useLanguage()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={secondaryBtnCls} aria-label={t('production.common.columns')}>
        <Columns3 className="h-3.5 w-3.5" /> {t('production.common.columns')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('production.common.columns')}</DropdownMenuLabel>
          {columns.map(c => (
            <DropdownMenuCheckboxItem key={c.key} checked={isVisible(c.key)} onCheckedChange={() => toggle(c.key)} closeOnClick={false}>
              {c.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Card around a table with loading and empty states. */
export function TableCard({ loading, empty, emptyText, emptyIcon: EmptyIcon, children }: {
  loading: boolean
  empty: boolean
  emptyText: string
  emptyIcon: LucideIcon
  children: ReactNode
}) {
  return (
    <div className={cn(prodCardCls, 'overflow-hidden')}>
      {loading ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
      ) : empty ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
          <EmptyIcon className="h-6 w-6" />
          {emptyText}
        </div>
      ) : (
        <div className={stickyTableCls}>{children}</div>
      )}
    </div>
  )
}

/** Scroll box of list tables: sticky header and totals row; tables scroll inside their card. */
export const stickyTableCls = cn(
  'max-h-[calc(100dvh-15rem)] min-h-48 overflow-auto',
  '[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-white dark:[&_thead_th]:bg-gray-900',
  '[&_tfoot_td]:sticky [&_tfoot_td]:bottom-0 [&_tfoot_td]:z-10 [&_tfoot_td]:bg-gray-50 dark:[&_tfoot_td]:bg-gray-800',
)

export function DocStatusBadge({ status }: { status: string }) {
  const { t } = useLanguage()
  const cancelled = (status as ProdDocStatus) === 'cancelled'
  return (
    <span className={cn(
      'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
      cancelled
        ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
        : 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
    )}>
      {cancelled ? t('production.common.statusCancelled') : t('production.common.statusPosted')}
    </span>
  )
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useLanguage()
  return (
    <span className={cn(
      'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
      active
        ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400'
        : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
    )}>
      {active ? t('production.common.active') : t('production.common.inactive')}
    </span>
  )
}

/** Item type is categorical, not a status: kept monochrome. */
export function ItemTypeBadge({ type }: { type: string }) {
  const { t } = useLanguage()
  return (
    <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-gray-700 dark:text-gray-300">
      {t(itemTypeKey(type))}
    </span>
  )
}

/** Monochrome segmented control (Floxen active state = elevation, not color). */
export function Segmented<T extends string>({ options, value, onChange, className }: {
  options: { value: T; label: string; disabled?: boolean; title?: string }[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={cn('inline-flex flex-wrap rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5', className)}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          disabled={o.disabled}
          title={o.title}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            value === o.value
              ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
              : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function NoteField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  const { t } = useLanguage()
  return (
    <label className="block">
      <span className={prodLabelCls}>{label ?? t('production.common.note')}</span>
      <textarea
        value={value}
        maxLength={NOTE_MAX}
        rows={3}
        onChange={e => onChange(e.target.value.slice(0, NOTE_MAX))}
        placeholder={t('production.common.notePlaceholder')}
        className={cn(prodFieldCls, 'h-auto py-2 resize-none')}
      />
      <span className="mt-1 block text-right text-[11px] tabular-nums text-gray-400 dark:text-gray-500">{value.length}/{NOTE_MAX}</span>
    </label>
  )
}

export interface TotalRow { label: string; value: string; tone?: 'positive' | 'negative'; strong?: boolean }

export function TotalsBox({ rows }: { rows: TotalRow[] }) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-4 space-y-2">
      {rows.map(r => (
        <div key={r.label} className={cn('flex items-center justify-between gap-4 text-sm', r.strong && 'border-t border-gray-200 dark:border-gray-700 pt-2')}>
          <span className="text-gray-500 dark:text-gray-400">{r.label}</span>
          <span className={cn(
            'tabular-nums',
            r.strong ? 'font-semibold' : 'font-medium',
            r.tone === 'negative' ? 'text-red-600 dark:text-red-400' : r.tone === 'positive' ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-gray-100',
          )}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

const FOCUSABLE = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]), select:not([disabled]), textarea:not([disabled])'

/**
 * Sticky bottom save bar of document forms (optionally with the document
 * total). It also wires the form keyboard: Ctrl+S / Ctrl+Enter saves, Enter in
 * a field moves to the next field, and the element marked data-autofocus (or
 * its first control) gets focus when the form opens.
 */
export function FormFooter({ onCancel, onSave, saving, disabled, total, inline }: {
  onCancel: () => void
  onSave: () => void
  saving: boolean
  disabled?: boolean
  total?: { label: string; value: string }
  /** Inside a side column: plain row instead of the full-width sticky bar. */
  inline?: boolean
}) {
  const { t } = useLanguage()
  const state = useRef({ onSave, saving, disabled })
  useEffect(() => { state.current = { onSave, saving, disabled } })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>('[data-autofocus]')
      if (!el) return
      const target = el.matches(`${FOCUSABLE}, button`) ? el : el.querySelector<HTMLElement>(`${FOCUSABLE}, button`)
      target?.focus()
    }, 50)
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        e.preventDefault()
        const s = state.current
        if (!s.saving && !s.disabled) s.onSave()
        return
      }
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || e.isComposing) return
      const el = e.target as HTMLElement | null
      if (!el || !el.matches('input, select') || el.closest('[data-enter-ignore], [role="dialog"]')) return
      const root = el.closest('main') ?? document.body
      const list = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(n => n.offsetParent !== null)
      const i = list.indexOf(el)
      if (i < 0) return
      e.preventDefault()
      list[i + 1]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', onKey) }
  }, [])

  return (
    <div className={cn(
      'flex flex-wrap items-center justify-end gap-x-4 gap-y-2 print:hidden',
      !inline && 'sticky bottom-0 z-20 -mx-6 -mb-5 border-t border-gray-100 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 px-6 py-3 backdrop-blur',
    )}>
      {total && (
        <div className="mr-auto min-w-0 text-sm">
          <span className="text-gray-500 dark:text-gray-400">{total.label}: </span>
          <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{total.value}</span>
        </div>
      )}
      <span className="hidden text-[12px] text-gray-400 dark:text-gray-500 lg:inline">{t('prodUx.saveHint')}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onCancel}>{t('production.common.cancel')}</Button>
        <Button onClick={onSave} disabled={saving || disabled} loading={saving}>{t('production.common.save')}</Button>
      </div>
    </div>
  )
}

/** Inline validation message under a field. */
export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null
  return <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">{children}</span>
}

/** Read-only label/value pair for document view pages. */
export function InfoField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[12px] text-gray-500 dark:text-gray-400">{label}</p>
      <div className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">{children}</div>
    </div>
  )
}

/** Amallar cell: view + cancel (cancel only for posted docs and owner/admin). */
export function DocActions({ viewHref, canCancel, posted, busy, onCancel }: {
  viewHref: string
  canCancel: boolean
  posted: boolean
  busy: boolean
  onCancel: () => void
}) {
  const { t } = useLanguage()
  const iconBtn = 'flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'
  return (
    <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
      <Link href={viewHref} aria-label={t('production.common.view')} title={t('production.common.view')} className={iconBtn}>
        <Eye className="h-3.5 w-3.5" />
      </Link>
      {canCancel && posted && (
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label={t('production.common.cancelDoc')}
          title={t('production.common.cancelDoc')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}

/** Placeholder shown instead of a SearchSelect until its prerequisite (warehouse) is chosen. */
export function DisabledSelect({ placeholder }: { placeholder: string }) {
  return (
    <div className="flex h-9 w-full cursor-not-allowed items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 px-3 text-sm text-gray-400 dark:text-gray-500">
      <span className="truncate">{placeholder}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
    </div>
  )
}
