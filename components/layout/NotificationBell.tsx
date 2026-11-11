'use client'

// Header bell: prod_notifications() feed (migration 20261110000019) for
// production firms and retail firms with the production add-on. Hidden while
// the feed is not available.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell, ChevronRight } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'
import { notifTitle, type NotifSeverity } from '@/lib/approvals'
import { useProdNotifications } from '@/components/layout/useProdNotifications'

const dotCls: Record<NotifSeverity, string> = {
  danger: 'bg-red-500',
  warn: 'bg-amber-500',
  info: 'bg-gray-400 dark:bg-gray-500',
}

const countCls: Record<NotifSeverity, string> = {
  danger: 'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400',
  warn: 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400',
  info: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
}

const SEVERITY_ORDER: Record<NotifSeverity, number> = { danger: 0, warn: 1, info: 2 }

export function NotificationBell() {
  const { t } = useLanguage()
  const { available, items, refresh } = useProdNotifications()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!available) return null

  const total = items.reduce((s, n) => s + n.count, 0)
  const sorted = [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const worst = sorted[0]?.severity

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => { setOpen(v => !v); if (!open) refresh() }}
        aria-label={t('prodShell.notif.title')}
        title={t('prodShell.notif.title')}
        className="relative flex h-8 w-8 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <Bell className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        {total > 0 && (
          <span className={cn(
            'absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full px-1 text-[10px] font-semibold leading-4 text-white text-center ring-2 ring-white dark:ring-gray-900',
            worst === 'danger' ? 'bg-red-500' : worst === 'warn' ? 'bg-amber-500' : 'bg-gray-700 dark:bg-gray-500',
          )}>
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 px-4 py-3">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodShell.notif.title')}</span>
            {total > 0 && <span className="text-[12px] text-gray-400 dark:text-gray-500">{total}</span>}
          </div>
          {sorted.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-gray-500 dark:text-gray-400">{t('prodShell.notif.empty')}</p>
          ) : (
            <ul className="max-h-[420px] overflow-y-auto py-1">
              {sorted.map(n => {
                const body = (
                  <>
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', dotCls[n.severity])} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900 dark:text-gray-100">{notifTitle(t, n)}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', countCls[n.severity])}>{n.count}</span>
                      </span>
                      {n.sample.length > 0 && (
                        <span className="mt-0.5 block truncate text-[12px] text-gray-500 dark:text-gray-400">
                          {n.sample.join(', ')}{n.count > n.sample.length ? ', ...' : ''}
                        </span>
                      )}
                    </span>
                    {n.href && <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-gray-400" />}
                  </>
                )
                const cls = 'flex w-full items-start gap-2.5 px-4 py-2.5 text-left'
                return (
                  <li key={n.kind}>
                    {n.href ? (
                      <Link href={n.href} onClick={() => setOpen(false)} className={cn(cls, 'hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors')}>
                        {body}
                      </Link>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
