'use client'

// Offline weighing UI: post-or-queue helper for prod_create_milk_intake and
// the "Oflayn navbatda: N ta" bar (list, retry, discard). Queue logic lives in
// lib/milk-offline.ts.

import { useState } from 'react'
import { CloudOff, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'
import { formatQty } from '@/lib/production'
import { fillText } from '@/lib/production-controls'
import { isNetworkError, type QueuedIntake, type useMilkOfflineQueue } from '@/lib/milk-offline'
import { useProdErrorText, type useApprovalRetry } from '@/components/production/ControlKit'

type Approval = ReturnType<typeof useApprovalRetry>
type Queue = ReturnType<typeof useMilkOfflineQueue>

export type IntakeSaveResult =
  | { kind: 'posted'; id?: string; number?: number }
  | { kind: 'queued' }
  | { kind: 'error'; error: { message?: string | null; details?: string | null } }
  | { kind: 'cancelled' }

/**
 * prod_create_milk_intake through the approval retry; a network failure puts
 * the payload (without override keys) into the offline queue instead.
 */
export async function saveIntakeOrQueue(approval: Approval, queue: Queue, payload: Record<string, unknown>, supplierName: string): Promise<IntakeSaveResult> {
  let res: { data: unknown; error: { message?: string | null; details?: string | null; code?: string | null } | null } | null
  try {
    res = await approval.run(ctl => createClient().rpc('prod_create_milk_intake', { p_data: { ...(ctl ?? {}), ...payload } as never }))
  } catch (e) {
    res = { data: null, error: { message: String(e) } }
  }
  if (!res) return { kind: 'cancelled' }
  if (res.error) {
    if (isNetworkError(res.error) && queue.enqueue(payload, supplierName)) return { kind: 'queued' }
    return { kind: 'error', error: res.error }
  }
  const d = res.data as { id?: string; number?: number } | null
  return { kind: 'posted', id: d?.id, number: d?.number }
}

function QueueRow({ item, onRetry, onDiscard, large }: { item: QueuedIntake; onRetry: () => void; onDiscard: () => void; large?: boolean }) {
  const { t } = useLanguage()
  const errorText = useProdErrorText()
  const at = new Date(String(item.payload.intake_date ?? item.queuedAt))
  const btn = cn('inline-flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors', large ? 'h-12 w-12' : 'h-8 w-8')
  return (
    <li className={cn('flex items-center gap-3 border-b border-gray-50 dark:border-gray-800/60 last:border-0 py-2', large ? 'text-lg' : 'text-sm')}>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-gray-900 dark:text-gray-100">{item.supplierName} · <span className="tabular-nums">{formatQty(item.netKg)} {t('production.units.kg')}</span></p>
        <p className={cn('tabular-nums text-gray-500 dark:text-gray-400', large ? 'text-lg' : 'text-[12px]')}>
          {Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {item.failed && <span className="ml-2 text-red-600 dark:text-red-400">{t('prodOps.offline.failed')}: {errorText(item.failed)}</span>}
        </p>
      </div>
      {item.failed && (
        <button type="button" onClick={onRetry} className={btn} title={t('prodOps.offline.retry')} aria-label={t('prodOps.offline.retry')}>
          <RotateCcw className={large ? 'h-5 w-5' : 'h-4 w-4'} />
        </button>
      )}
      <button type="button" onClick={onDiscard} className={cn(btn, 'hover:text-red-600 dark:hover:text-red-400')} title={t('prodOps.offline.discard')} aria-label={t('prodOps.offline.discard')}>
        <Trash2 className={large ? 'h-5 w-5' : 'h-4 w-4'} />
      </button>
    </li>
  )
}

/** "Oflayn navbatda: N ta" - click opens the queue. Renders nothing when empty. */
export function OfflineQueueBar({ queue, large }: { queue: Queue; large?: boolean }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (queue.count === 0) return null
  const failed = queue.items.filter(i => i.failed).length

  async function retryAll() {
    setBusy(true)
    await queue.flush()
    setBusy(false)
  }

  return (
    <div className={cn('rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10', large ? 'px-4 py-3' : 'px-4 py-2.5')}>
      <div className="flex flex-wrap items-center gap-3">
        <CloudOff className={cn('shrink-0 text-amber-600 dark:text-amber-400', large ? 'h-6 w-6' : 'h-4 w-4')} />
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className={cn('mr-auto text-left font-medium text-amber-800 dark:text-amber-300', large ? 'min-h-12 text-lg' : 'text-sm')}>
          {fillText(t('prodOps.offline.queued'), { n: queue.count })}
          {failed > 0 && <span className="ml-2 text-red-600 dark:text-red-400">({fillText(t('prodOps.offline.failedCount'), { n: failed })})</span>}
        </button>
        <button
          type="button"
          onClick={retryAll}
          disabled={busy}
          className={cn('inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-500/40 font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors', large ? 'min-h-12 px-4 text-lg' : 'h-8 px-3 text-sm')}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} {t('prodOps.offline.retryNow')}
        </button>
      </div>
      {open && (
        <div className={cn('mt-2 rounded-lg bg-white dark:bg-gray-900 px-3', large && 'px-4')}>
          <p className={cn('pt-2 text-gray-500 dark:text-gray-400', large ? 'text-lg' : 'text-[12px]')}>{t('prodOps.offline.hint')}</p>
          <ul>
            {queue.items.map(i => (
              <QueueRow
                key={i.cid}
                item={i}
                large={large}
                onRetry={() => queue.resend(i.cid)}
                onDiscard={() => { if (window.confirm(t('prodOps.offline.discardConfirm'))) queue.discard(i.cid) }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
