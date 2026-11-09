'use client'

// Shared building blocks for the production module pages (list toolbar,
// column settings, status badges, document form pieces). Floxen monochrome:
// color only for semantic status.

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, Ban, ChevronDown, Columns3, Eye, Loader2, Plus, RotateCcw, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
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

/** Filter toolbar card: filters on the left, reset + column settings on the right. */
export function FilterBar({ children, onReset, columns }: {
  children: ReactNode
  onReset?: () => void
  columns?: ReactNode
}) {
  const { t } = useLanguage()
  return (
    <div className={cn(prodCardCls, 'p-4 flex flex-wrap items-center gap-2')}>
      {children}
      <div className="ml-auto flex items-center gap-2">
        {onReset && (
          <button type="button" onClick={onReset} className={secondaryBtnCls}>
            <RotateCcw className="h-3.5 w-3.5" /> {t('production.common.reset')}
          </button>
        )}
        {columns}
      </div>
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
        <div className="overflow-x-auto">{children}</div>
      )}
    </div>
  )
}

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
  options: { value: T; label: string }[]
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
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
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

export function FormFooter({ onCancel, onSave, saving, disabled }: {
  onCancel: () => void
  onSave: () => void
  saving: boolean
  disabled?: boolean
}) {
  const { t } = useLanguage()
  return (
    <div className="flex items-center justify-end gap-2">
      <Button variant="outline" onClick={onCancel}>{t('production.common.cancel')}</Button>
      <Button onClick={onSave} disabled={saving || disabled} loading={saving}>{t('production.common.save')}</Button>
    </div>
  )
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
