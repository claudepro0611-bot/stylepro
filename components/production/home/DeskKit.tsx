'use client'

// Building blocks of the role desks: big action buttons, 2-3 numbers and one
// "today" list. A desk renders full-page, or compact as one section of
// "Mening ishlarim" (smaller heading, fewer rows, inside a card).

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { prodCardCls } from '@/components/production/ProdKit'

export const deskRowCls = 'flex items-center gap-3 border-b border-gray-50 dark:border-gray-800/60 px-4 py-2.5 last:border-0 text-sm'
export const deskLinkCls = 'text-[13px] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'

/** "HH:MM" of an ISO timestamp, local time. */
export function hm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function DeskShell({ title, subtitle, compact, actions, stats, children }: {
  title: string
  subtitle?: string
  compact?: boolean
  actions?: ReactNode
  stats?: ReactNode
  children?: ReactNode
}) {
  const body = (
    <>
      {actions && <div className={cn('grid gap-3', compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4')}>{actions}</div>}
      {stats && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{stats}</div>}
      {children}
    </>
  )
  if (compact) {
    return (
      <section className={cn(prodCardCls, 'space-y-4 p-4')}>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {body}
      </section>
    )
  }
  // Full page: the page heading (desk name) is drawn by ProductionHome.
  return (
    <div className="space-y-5">
      {subtitle && <p className="-mt-2 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
      {body}
    </div>
  )
}

/** Big action button; `primary` = the desk's main job (one per desk). */
export function BigAction({ href, label, icon: Icon, primary, compact }: {
  href: string
  label: string
  icon: LucideIcon
  primary?: boolean
  compact?: boolean
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-3 rounded-xl border font-medium transition-colors',
        compact ? 'min-h-11 px-3 py-2 text-sm' : 'min-h-16 px-4 py-3 text-base',
        primary
          ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800 dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white'
          : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800',
      )}
    >
      <Icon className={cn('shrink-0', compact ? 'h-4 w-4' : 'h-5 w-5', primary ? 'opacity-90' : 'text-gray-400')} />
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  )
}

export function DeskStat({ label, value, tone, loading }: {
  label: string
  value: string
  tone?: 'positive' | 'warning' | 'negative'
  loading?: boolean
}) {
  return (
    <div className="min-w-0 rounded-xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <p className="truncate text-[13px] text-gray-500 dark:text-gray-400">{label}</p>
      {loading
        ? <div className="mt-2 h-6 w-20 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
        : (
          <p className={cn(
            'mt-1 truncate text-xl font-semibold tabular-nums',
            tone === 'negative' ? 'text-red-600 dark:text-red-400'
              : tone === 'warning' ? 'text-amber-600 dark:text-amber-400'
                : tone === 'positive' ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-gray-900 dark:text-gray-100',
          )}>{value}</p>
        )}
    </div>
  )
}

export function DeskList({ title, href, loading, empty, emptyText, children, action }: {
  title: string
  href?: string
  loading: boolean
  empty: boolean
  emptyText: string
  children?: ReactNode
  action?: ReactNode
}) {
  const { t } = useLanguage()
  return (
    <div className={cn(prodCardCls, 'min-w-0 overflow-hidden')}>
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        <div className="flex items-center gap-3">
          {action}
          {href && <Link href={href} className={deskLinkCls}>{t('production.dashboard.viewAll')}</Link>}
        </div>
      </div>
      {loading ? (
        <div className="flex h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
      ) : empty ? (
        <p className="px-4 py-6 text-center text-sm text-gray-400 dark:text-gray-500">{emptyText}</p>
      ) : (
        <div>{children}</div>
      )}
    </div>
  )
}
