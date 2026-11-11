'use client'

// "Davrni yopish": production period lock (prod_period_locks, migration
// 20261110000017). Owner only: proxy.ts redirects everyone else and
// prod_close_period / prod_reopen_period re-check. Nothing dated on or before
// locked_until can be posted or cancelled. History comes from the audit log.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Lock, LockOpen, ShieldAlert } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PageHeader, prodCardCls, prodFieldCls, prodLabelCls, tdCls, thCls, trCls } from '@/components/production/ProdKit'
import { invalidateControls, useControls, useProdErrorText, useRole } from '@/components/production/ControlKit'
import {
  OVERRIDE_NOTE_MAX, OVERRIDE_NOTE_MIN, auditActionKey, fetchAuditLog, fillText, formatYmdDots, monthEndYmd, todayYmd,
  type AuditRow,
} from '@/lib/production-controls'
import type { Language } from '@/lib/i18n/translations'

const MONTHS_BACK = 36

const LOCALE: Record<Language, string> = { uz: 'uz-UZ', ru: 'ru-RU', en: 'en-US' }

function monthLabel(ym: string, lang: Language): string {
  const [y, m] = ym.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
  } catch {
    return ym
  }
}

/** "YYYY-MM" of the finished months, newest first. */
function finishedMonths(today: string): string[] {
  const [y, m] = today.split('-').map(Number)
  const out: string[] = []
  for (let i = 1; i <= MONTHS_BACK; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

const lockOf = (j: AuditRow['new']): string | null => {
  const v = j?.locked_until
  return typeof v === 'string' ? v : null
}

export default function PeriodClosePage() {
  const { t, language } = useLanguage()
  const errorText = useProdErrorText()
  const role = useRole()
  const controls = useControls()
  const isOwner = role === 'owner'
  const lockedUntil = controls.lock.lockedUntil
  const today = todayYmd()

  const [history, setHistory] = useState<AuditRow[] | null>(null)
  const [closeMonth, setCloseMonth] = useState('')
  const [reopenTo, setReopenTo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'close' | 'reopen' | null>(null)

  const loadHistory = useCallback(async () => {
    const rows = await fetchAuditLog(createClient(), { entity: 'prod_period_locks' }, 100)
    setHistory((rows ?? []).filter(r => r.action === 'period_close' || r.action === 'period_reopen'))
  }, [])

  useEffect(() => { if (isOwner) loadHistory() }, [isOwner, loadHistory])

  // Close: finished months ending after the current lock. Reopen: month ends before it.
  const months = useMemo(() => finishedMonths(today), [today])
  const closable = months.filter(ym => !lockedUntil || monthEndYmd(ym) > lockedUntil)
  const reopenable = months.filter(ym => !!lockedUntil && monthEndYmd(ym) < lockedUntil)

  useEffect(() => {
    setCloseMonth(prev => (closable.includes(prev) ? prev : closable[0] ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closable.join(',')])

  const lastClose = history?.find(r => r.action === 'period_close' || r.action === 'period_reopen') ?? null

  async function refresh() {
    invalidateControls()
    await controls.reload()
    await loadHistory()
  }

  async function close() {
    if (!closeMonth) return
    const until = monthEndYmd(closeMonth)
    if (!window.confirm(fillText(t('prodControls.period.closeConfirm'), { date: formatYmdDots(until) }))) return
    setBusy('close')
    const { error } = await createClient().rpc('prod_close_period', { p_until: until })
    setBusy(null)
    if (error) { toast.error(errorText(error)); return }
    toast.success(t('prodControls.period.closed'))
    await refresh()
  }

  const trimmed = note.trim()
  const noteOk = trimmed.length >= OVERRIDE_NOTE_MIN && trimmed.length <= OVERRIDE_NOTE_MAX

  async function reopen() {
    if (!noteOk || !lockedUntil) return
    setBusy('reopen')
    const { error } = await createClient().rpc('prod_reopen_period', { p_until: reopenTo ? monthEndYmd(reopenTo) : null, p_note: trimmed })
    setBusy(null)
    if (error) { toast.error(errorText(error)); return }
    toast.success(t('prodControls.period.reopened'))
    setNote('')
    setReopenTo('')
    await refresh()
  }

  if (controls.loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!isOwner || !controls.available) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('prodControls.period.title')} />
        <div className={cn(prodCardCls, 'flex items-center gap-3 p-6 text-sm text-gray-500 dark:text-gray-400')}>
          <ShieldAlert className="h-4 w-4 shrink-0 text-gray-400" />
          {!isOwner ? t('prodControls.ownerOnly') : t('prodControls.notAvailable')}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('prodControls.period.title')} subtitle={t('prodControls.period.subtitle')} />

      <div className={cn(prodCardCls, 'p-4 sm:p-6')}>
        <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodControls.period.current')}</p>
        <div className="mt-1 flex items-center gap-2">
          {lockedUntil ? <Lock className="h-4 w-4 text-gray-400" /> : <LockOpen className="h-4 w-4 text-gray-400" />}
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {lockedUntil ? fillText(t('prodControls.period.closedUntil'), { date: formatYmdDots(lockedUntil) }) : t('prodControls.period.open')}
          </p>
        </div>
        {lockedUntil && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodControls.period.closedBy')}</p>
              <p className="font-medium text-gray-900 dark:text-gray-100">{lastClose?.userName || '—'}</p>
            </div>
            <div>
              <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodControls.period.closedAt')}</p>
              <p className="font-medium text-gray-900 dark:text-gray-100">{controls.lock.lockedAt ? formatDateTime(controls.lock.lockedAt) : '—'}</p>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className={cn(prodCardCls, 'p-4 sm:p-6 space-y-4')}>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodControls.period.closeTitle')}</h2>
          {closable.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('prodControls.period.noMonths')}</p>
          ) : (
            <>
              <label className="block">
                <span className={prodLabelCls}>{t('prodControls.period.closeMonth')}</span>
                <select value={closeMonth} onChange={e => setCloseMonth(e.target.value)} className={prodFieldCls}>
                  {closable.map(ym => <option key={ym} value={ym}>{monthLabel(ym, language)}</option>)}
                </select>
                <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodControls.period.closeHint')}</span>
              </label>
              {closeMonth && (
                <p className="text-sm text-gray-700 dark:text-gray-300">{fillText(t('prodControls.period.closeThrough'), { date: formatYmdDots(monthEndYmd(closeMonth)) })}</p>
              )}
              <div className="flex justify-end">
                <Button onClick={close} loading={busy === 'close'} disabled={!!busy || !closeMonth}>
                  <Lock className="h-4 w-4" /> {t('prodControls.period.closeAction')}
                </Button>
              </div>
            </>
          )}
        </div>

        {lockedUntil && (
          <div className={cn(prodCardCls, 'p-4 sm:p-6 space-y-4')}>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodControls.period.reopenTitle')}</h2>
            <label className="block">
              <span className={prodLabelCls}>{t('prodControls.period.reopenTo')}</span>
              <select value={reopenTo} onChange={e => setReopenTo(e.target.value)} className={prodFieldCls}>
                <option value="">{t('prodControls.period.reopenFully')}</option>
                {reopenable.map(ym => <option key={ym} value={ym}>{formatYmdDots(monthEndYmd(ym))} · {monthLabel(ym, language)}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('prodControls.period.reopenNote')}</span>
              <textarea
                value={note}
                rows={3}
                maxLength={OVERRIDE_NOTE_MAX}
                onChange={e => setNote(e.target.value.slice(0, OVERRIDE_NOTE_MAX))}
                className={cn(prodFieldCls, 'h-auto py-2 resize-none')}
              />
              <span className={cn('mt-1 block text-[11px]', trimmed.length > 0 && !noteOk ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500')}>
                {t('prodControls.period.reopenNoteHint')}
              </span>
            </label>
            <div className="flex justify-end">
              <Button variant="outline" onClick={reopen} loading={busy === 'reopen'} disabled={!!busy || !noteOk}>
                <LockOpen className="h-4 w-4" /> {t('prodControls.period.reopenAction')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodControls.period.history')}</h2>
        {history === null ? (
          <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
        ) : history.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('prodControls.period.historyEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('prodControls.audit.at')}</th>
                  <th className={thCls}>{t('prodControls.audit.user')}</th>
                  <th className={thCls}>{t('prodControls.audit.action')}</th>
                  <th className={thCls}>{t('prodControls.period.from')}</th>
                  <th className={thCls}>{t('prodControls.period.to')}</th>
                  <th className={thCls}>{t('prodControls.audit.note')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map(r => (
                  <tr key={r.id} className={trCls}>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.at)}</td>
                    <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{r.userName || '—'}</td>
                    <td className={tdCls}>
                      <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">{t(auditActionKey(r.action))}</span>
                    </td>
                    <td className={cn(tdCls, 'tabular-nums text-gray-500 dark:text-gray-400')}>{formatYmdDots(lockOf(r.old))}</td>
                    <td className={cn(tdCls, 'tabular-nums text-gray-900 dark:text-gray-100')}>{formatYmdDots(lockOf(r.new))}</td>
                    <td className={cn(tdCls, 'max-w-[320px] text-gray-500 dark:text-gray-400')}>{r.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
