'use client'

// Client side of the production controls (migration 20261110000017):
// control settings / period lock hook, the shared approval flow
// (useApprovalRetry: needs_approval -> owner / admin override dialog, staff
// explanation), the document date input with the control window, the
// "manual lot pick" badge and the approvals block of document pages. The
// server enforces every rule; this only explains and re-sends.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Send, ShieldCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { prodCardCls, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { prodErrorKey, type ProdRpcError } from '@/lib/production'
import { APPROVAL_LABEL_MAX, isApprovableRpc, isMissingError, requestApproval, requestPayload, rpcNameKey } from '@/lib/approvals'
import { toast } from '@/lib/toast'
import {
  DEFAULT_CONTROL_SETTINGS, OVERRIDE_NOTE_MAX, OVERRIDE_NOTE_MIN, addDaysYmd, backdateDaysFor, fetchControls, fetchDocOverrides,
  fillText, formatYmdDots, isOwnerAdminRole, needsApprovalRule, prodErrorText, ruleLabelKey, ruleMessage, todayYmd,
  type AuditRow, type ControlsState, type OverrideCtl, type RuleVars,
} from '@/lib/production-controls'

// ---------------------------------------------------------------------------
// Settings + period lock (one read per user, shared by every component)

const CACHE_MS = 60_000
let cache: { key: string; at: number; promise: Promise<ControlsState> } | null = null

function loadControls(key: string, force = false): Promise<ControlsState> {
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.promise
  const promise = fetchControls(createClient())
  cache = { key, at: Date.now(), promise }
  return promise
}

/** Drops the cached settings / lock (after saving them or closing a period). */
export function invalidateControls() {
  cache = null
}

const INITIAL: ControlsState = {
  available: false,
  settings: DEFAULT_CONTROL_SETTINGS,
  lock: { lockedUntil: null, lockedBy: null, lockedAt: null },
}

/**
 * Control settings (defaults while the row / migration is absent) and the
 * period lock. `available` is false while migration 20261110000017 is not
 * applied: callers then skip every control hint.
 */
export function useControls() {
  const { userId } = useSession()
  const [state, setState] = useState<ControlsState | null>(null)
  const key = userId ?? 'anon'

  useEffect(() => {
    let alive = true
    loadControls(key).then(s => { if (alive) setState(s) })
    return () => { alive = false }
  }, [key])

  const reload = useCallback(async () => {
    const s = await loadControls(key, true)
    setState(s)
    return s
  }, [key])

  return { ...(state ?? INITIAL), loading: state === null, reload }
}

export function useRole(): string | null {
  return useSession().profile?.role ?? null
}

// ---------------------------------------------------------------------------
// Approval flow

type RpcResult = { error: ProdRpcError | null }

/** The RPC a `call(null)` made (captured for an approval request, migration 20261110000019). */
interface CapturedRpc { name: string; args: Record<string, unknown> | undefined }

interface Pending {
  rule: string
  vars: RuleVars
  retry: (ctl: OverrideCtl) => PromiseLike<RpcResult>
  resolve: (r: RpcResult | null) => void
  request: CapturedRpc | null
  label?: string
}

type RpcFn = (this: unknown, name: string, args?: Record<string, unknown>, ...rest: unknown[]) => unknown

/**
 * Runs `fn` and records the first supabase.rpc(name, args) it starts
 * synchronously. Every caller writes `ctl => createClient().rpc(...)`, so the
 * request is captured without changing the call sites. The prototype method
 * is patched only for the synchronous part of `fn` (JS is single-threaded,
 * nothing else can run in between) and always restored.
 */
function captureRpc<T>(fn: () => T): { value: T; rpc: CapturedRpc | null } {
  let rpc: CapturedRpc | null = null
  let proto: { rpc: RpcFn } | null = null
  let original: RpcFn | null = null
  try {
    proto = Object.getPrototypeOf(createClient()) as { rpc: RpcFn }
    original = proto.rpc
    const orig = original
    proto.rpc = function (this: unknown, name: string, args?: Record<string, unknown>, ...rest: unknown[]) {
      if (!rpc && typeof name === 'string') rpc = { name, args }
      return orig.call(this, name, args, ...rest)
    }
  } catch {
    proto = null
  }
  try {
    return { value: fn(), rpc }
  } finally {
    if (proto && original) proto.rpc = original
  }
}

/**
 * Wraps a create / post RPC call. `call(ctl)` must send the SAME payload
 * every time, adding `ctl` (`{ override: true, override_note }`) where the
 * RPC expects it (top level of p_data, the lab object, or p_ctl). On
 * 'needs_approval' an owner / admin gets the approval dialog (reason >= 5
 * chars, "Tasdiqlab saqlash" re-sends with the override); staff / manager see
 * the explanation and "Tasdiqlashga yuborish": the captured RPC + payload go
 * to the owner / admin queue (/zavod-tasdiqlar; before migration
 * 20261110000019 the old "Egasidan tasdiq so'rang" hint).
 *
 * Resolves with the final RPC result, or null when the dialog was closed
 * without saving. Render `dialog` once in the component (inside the parent
 * DialogContent when the form itself is a dialog).
 */
export function useApprovalRetry() {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)

  /**
   * `label`: optional human summary of the document for the approval queue
   * ("Ishlab chiqarish: Qaymoq 100 kg"); default = document type + rule text.
   */
  const run = useCallback(async <R extends RpcResult>(
    call: (ctl: OverrideCtl | null) => PromiseLike<R>,
    vars?: RuleVars,
    label?: string,
  ): Promise<R | null> => {
    const captured = captureRpc(() => call(null))
    const first = await captured.value
    const rule = needsApprovalRule(first.error)
    if (!rule) return first
    return new Promise<R | null>(resolve => {
      const p: Pending = {
        rule,
        vars: vars ?? {},
        retry: ctl => call(ctl),
        resolve: r => resolve(r as R | null),
        request: captured.rpc,
        label,
      }
      pendingRef.current = p
      setPending(p)
    })
  }, [])

  const finish = useCallback((r: RpcResult | null) => {
    const p = pendingRef.current
    pendingRef.current = null
    setPending(null)
    p?.resolve(r)
  }, [])

  const dialog = <ApprovalDialog pending={pending} onDone={finish} />
  return { run, dialog }
}

function ApprovalDialog({ pending, onDone }: { pending: Pending | null; onDone: (r: RpcResult | null) => void }) {
  const { t } = useLanguage()
  const role = useRole()
  const { settings } = useControls()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canApprove = isOwnerAdminRole(role)
  // Staff / manager: send the document to the owner / admin queue (migration 20261110000019).
  const [requestUnavailable, setRequestUnavailable] = useState(false)
  const canRequest = !canApprove && !!pending?.request && isApprovableRpc(pending.request.name) && !requestUnavailable

  // A fresh request (new pending object) starts with an empty reason.
  useEffect(() => {
    if (!pending) return
    setNote('')
    setError('')
  }, [pending])

  const explanation = pending ? ruleMessage(t, pending.rule, settings, role, pending.vars) : ''
  const trimmed = note.trim()
  const noteOk = trimmed.length >= OVERRIDE_NOTE_MIN && trimmed.length <= OVERRIDE_NOTE_MAX

  async function sendRequest() {
    if (!pending?.request || busy) return
    setBusy(true)
    setError('')
    const docType = t(rpcNameKey(pending.request.name))
    const label = (pending.label?.trim() || `${docType}: ${explanation}`).slice(0, APPROVAL_LABEL_MAX)
    const { error: err } = await requestApproval(
      createClient(), pending.request.name, requestPayload(pending.request.name, pending.request.args),
      pending.rule === 'unknown' ? null : pending.rule, label,
    )
    setBusy(false)
    if (err) {
      if (isMissingError(err)) { setRequestUnavailable(true); return }
      setError(prodErrorText(t, err))
      return
    }
    toast.success(t('prodShell.approvals.sent'))
    onDone(null)
  }

  async function approve() {
    if (!pending || !noteOk || busy) return
    setBusy(true)
    setError('')
    const r = await pending.retry({ override: true, override_note: trimmed })
    setBusy(false)
    // A missing / short note is answered here; any other result goes back to the form.
    if (r.error && prodErrorKey(r.error) === 'productionErrors.override_note') {
      setError(t('productionErrors.override_note'))
      return
    }
    if (r.error && needsApprovalRule(r.error)) {
      setError(ruleMessage(t, needsApprovalRule(r.error) ?? '', settings, role))
      return
    }
    setNote('')
    onDone(r)
  }

  return (
    <Dialog open={pending !== null} onOpenChange={o => { if (!o && !busy) onDone(null) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('prodControls.approval.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 text-[13px] text-amber-900 dark:text-amber-200">
              <p className="font-medium">{explanation}</p>
              <p className="mt-1 text-amber-800 dark:text-amber-300">{t('prodControls.approval.whoApproves')}</p>
            </div>
          </div>
          {canApprove ? (
            <>
              <label className="block">
                <span className={prodLabelCls}>{t('prodControls.approval.reason')}</span>
                <textarea
                  value={note}
                  rows={3}
                  maxLength={OVERRIDE_NOTE_MAX}
                  autoFocus
                  onChange={e => setNote(e.target.value.slice(0, OVERRIDE_NOTE_MAX))}
                  placeholder={t('prodControls.approval.reasonPlaceholder')}
                  className={cn(prodFieldCls, 'h-auto py-2 resize-none')}
                />
                <span className={cn('mt-1 block text-[11px]', trimmed.length > 0 && !noteOk ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500')}>
                  {t('prodControls.approval.reasonMin')}
                </span>
              </label>
              <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodControls.approval.logged')}</p>
            </>
          ) : canRequest ? (
            <div className="rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2.5">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('prodShell.approvals.requestTitle')}</p>
              <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">{t('prodShell.approvals.requestHint')}</p>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2.5">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('prodControls.approval.askOwner')}</p>
              <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">{t('prodControls.approval.staffHint')}</p>
            </div>
          )}
          {error && <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onDone(null)} disabled={busy}>
            {canApprove ? t('production.common.cancel') : t('prodControls.approval.close')}
          </Button>
          {canApprove && (
            <Button onClick={approve} loading={busy} disabled={busy || !noteOk}>{t('prodControls.approval.confirm')}</Button>
          )}
          {canRequest && (
            <Button onClick={sendRequest} loading={busy} disabled={busy}>
              <Send className="h-3.5 w-3.5" /> {t('prodShell.approvals.send')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** t + prodErrorText bound to the current language (control-aware error messages). */
export function useProdErrorText() {
  const { t } = useLanguage()
  return useCallback((err: ProdRpcError) => prodErrorText(t, err), [t])
}

// ---------------------------------------------------------------------------
// Document date input

/**
 * <input type="date"> of a document: max = today + future_days, min = the day
 * after the closed period; warns (does not block) when the date is older
 * than the caller's backdate window (saving then needs approval). Behaves
 * like the plain input while the controls are not available.
 */
export function DocDateInput({ value, onChange, className, disabled }: {
  value: string
  onChange: (v: string) => void
  className?: string
  disabled?: boolean
}) {
  const { t } = useLanguage()
  const role = useRole()
  const { available, settings, lock } = useControls()
  const today = todayYmd()
  const max = available ? addDaysYmd(today, settings.futureDays) : undefined
  const min = available && lock.lockedUntil ? addDaysYmd(lock.lockedUntil, 1) : undefined
  const days = backdateDaysFor(role, settings)
  const closed = available && !!value && !!lock.lockedUntil && value <= lock.lockedUntil
  const future = available && !!value && !!max && value > max
  const back = available && !!value && !closed && value < addDaysYmd(today, -days)

  return (
    <>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className={cn(prodFieldCls, (closed || future) && 'border-red-300 dark:border-red-500/50', className)}
      />
      {closed ? (
        <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
          {fillText(t('prodControls.date.closed'), { date: formatYmdDots(lock.lockedUntil) })}
        </span>
      ) : future ? (
        <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
          {fillText(t('prodControls.date.future'), { date: formatYmdDots(max) })}
        </span>
      ) : back ? (
        <span className="mt-1 block text-[11px] text-amber-700 dark:text-amber-400">
          {fillText(t(isOwnerAdminRole(role) ? 'prodControls.date.backdateAdmin' : 'prodControls.date.backdate'), { days })}
        </span>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Badges and hints

const amberPill = 'inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-500/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-700 dark:text-amber-400'

/** "Partiya qo'lda tanlangan": the document's lot picks differ from FEFO (lot_pick_deviation). */
export function ManualPickBadge({ show }: { show: boolean | null | undefined }) {
  const { t } = useLanguage()
  if (!show) return null
  return <span className={amberPill} title={t('prodControls.badges.manualPickHint')}>{t('prodControls.badges.manualPick')}</span>
}

/** lot_pick_deviation of a select('*') row; false while the column does not exist. */
export function pickDeviationOf(row: unknown): boolean {
  return !!row && typeof row === 'object' && (row as { lot_pick_deviation?: unknown }).lot_pick_deviation === true
}

type DeviationTable = 'prod_productions' | 'prod_processings' | 'prod_separations' | 'prod_transfers' | 'prod_writeoffs' | 'prod_sales'

/**
 * Ids (of `ids`) whose lot picks deviate from FEFO. Separate light query so
 * the list selects stay unchanged; empty while the column does not exist.
 */
export function usePickDeviations(table: DeviationTable, ids: string[]): Set<string> {
  const [set, setSet] = useState<Set<string>>(() => new Set())
  const idsKey = ids.join(',')
  useEffect(() => {
    let alive = true
    const list = idsKey ? idsKey.split(',') : []
    if (!list.length) { setSet(new Set()); return }
    const supabase = createClient()
    const wanted = new Set(list)
    // Deviating documents are rare: short lists ask by id, long ones read every
    // deviating id (newest first, capped) and intersect.
    const queries = list.length <= 150
      ? [supabase.from(table).select('id').eq('lot_pick_deviation', true).in('id', list)]
      : [supabase.from(table).select('id').eq('lot_pick_deviation', true).order('created_at', { ascending: false }).limit(2000)]
    Promise.all(queries)
      .then(results => {
        if (!alive) return
        const next = new Set<string>()
        for (const r of results) for (const row of (r.error ? [] : r.data ?? []) as { id: string }[]) if (wanted.has(row.id)) next.add(row.id)
        setSet(next)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [table, idsKey])
  return set
}

/** Inline warning / error row under a form section (tolerance hints). */
export function ControlHint({ tone = 'warn', children, className }: { tone?: 'warn' | 'error' | 'ok'; children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]',
      tone === 'error'
        ? 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300'
        : tone === 'ok'
          ? 'border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400'
          : 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300',
      className,
    )}>
      {tone !== 'ok' && <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </div>
  )
}

/**
 * Approvals of one document ("Tasdiqlangan: user, reason") from the audit
 * log. Owner / admin only (others read 0 rows); renders nothing when there
 * are none or the log is not available.
 */
export function DocOverrides({ docId, reloadKey }: { docId: string; reloadKey?: unknown }) {
  const { t } = useLanguage()
  const role = useRole()
  const [rows, setRows] = useState<AuditRow[]>([])
  const allowed = isOwnerAdminRole(role)

  useEffect(() => {
    if (!allowed || !docId) return
    let alive = true
    fetchDocOverrides(createClient(), docId).then(r => { if (alive) setRows(r) })
    return () => { alive = false }
  }, [allowed, docId, reloadKey])

  if (!allowed || rows.length === 0) return null
  return (
    <div className={cn(prodCardCls, 'p-4 space-y-2 print:hidden')}>
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <ShieldCheck className="h-4 w-4 text-gray-400" /> {t('prodControls.overrides.title')}
      </h2>
      <ul className="space-y-1.5">
        {rows.map(r => (
          <li key={r.id} className="text-[13px] text-gray-700 dark:text-gray-300">
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {fillText(t('prodControls.overrides.line'), { user: r.userName || '—', reason: r.note })}
            </span>
            <span className="ml-2 text-[12px] text-gray-500 dark:text-gray-400">
              {r.rule ? t(ruleLabelKey(r.rule)) : ''} · {formatDateTime(r.at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
