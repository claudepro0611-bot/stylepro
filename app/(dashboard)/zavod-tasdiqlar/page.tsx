'use client'

// "Tasdiqlar": approval queue (migration 20261110000019). Staff / managers
// send documents that hit a control rule (ControlKit "Tasdiqlashga
// yuborish"); owners / admins approve (required note, the RPC then runs as
// the approver with the override) or reject. Requesters see their own
// requests and may withdraw pending ones. Route: every role of a production
// firm / the add-on (lib/business-type.ts); RLS limits the rows, and
// prod_decide_approval re-checks owner / admin.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BadgeCheck, Check, ExternalLink, ShieldAlert, Undo2, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PageHeader, Segmented, TableCard, prodCardCls, prodFieldCls, prodLabelCls, tdCls, thCls, trCls } from '@/components/production/ProdKit'
import { ExpandChevron } from '@/components/production/ReportKit'
import { useControls, useProdErrorText } from '@/components/production/ControlKit'
import { refreshProdNotifications } from '@/components/layout/useProdNotifications'
import { OVERRIDE_NOTE_MAX, OVERRIDE_NOTE_MIN, isOwnerAdminRole, ruleLabelKey, ruleMessage, type RuleVars } from '@/lib/production-controls'
import {
  approvalResultHref, decideApproval, fetchApprovals, isMissingError, payloadSummary, rpcNameKey, statusKey, statusPillCls,
  withdrawApproval, type ApprovalRequest, type ApprovalStatus,
} from '@/lib/approvals'

type Tab = 'pending' | 'history' | 'mine'

const HISTORY: ApprovalStatus[] = ['approved', 'rejected', 'failed', 'withdrawn']

/** rule_detail as interpolation vars (scalars only). */
function detailVars(d: Record<string, unknown> | null): RuleVars {
  const out: RuleVars = {}
  if (!d) return out
  for (const [k, v] of Object.entries(d)) if (typeof v === 'string' || typeof v === 'number') out[k] = v
  return out
}

interface DecideResult { approved: boolean; href: string | null; error: string; label: string }

export default function ApprovalsPage() {
  const { t } = useLanguage()
  const { userId, profile } = useSession()
  const role = profile?.role ?? null
  const canDecide = isOwnerAdminRole(role)
  const { settings } = useControls()
  const errorText = useProdErrorText()

  const [tab, setTab] = useState<Tab>('mine')
  const [rows, setRows] = useState<ApprovalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(true)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [deciding, setDeciding] = useState<{ req: ApprovalRequest; approve: boolean } | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [lastResult, setLastResult] = useState<DecideResult | null>(null)

  // Owners / admins start on the queue once the role is known; ?tab=mine
  // (the "my requests" notification) opens their own list instead.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab')
    if (wanted === 'mine') setTab('mine')
    else if (canDecide) setTab(wanted === 'history' ? 'history' : 'pending')
  }, [canDecide])

  // Only the latest load may write (the tab can switch while one is in flight).
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    if (!userId || !profile) return
    const my = ++loadSeq.current
    setLoading(true)
    const data = await fetchApprovals(createClient(),
      tab === 'pending' ? { statuses: ['pending'] }
        : tab === 'history' ? { statuses: HISTORY }
          : { requestedBy: userId })
    if (my !== loadSeq.current) return
    setAvailable(data !== null)
    setRows(data ?? [])
    setOpen(new Set())
    setLoading(false)
  }, [tab, userId, profile])

  useEffect(() => { void load() }, [load])

  const tabs = useMemo(() => [
    ...(canDecide ? [
      { value: 'pending' as const, label: t('prodShell.approvals.tabs.pending') },
      { value: 'history' as const, label: t('prodShell.approvals.tabs.history') },
    ] : []),
    { value: 'mine' as const, label: t('prodShell.approvals.tabs.mine') },
  ], [canDecide, t])

  function toggle(id: string) {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startDecide(req: ApprovalRequest, approve: boolean) {
    setDeciding({ req, approve })
    setNote('')
    setDialogError('')
  }

  const trimmed = note.trim()
  const noteOk = deciding?.approve
    ? trimmed.length >= OVERRIDE_NOTE_MIN && trimmed.length <= OVERRIDE_NOTE_MAX
    : trimmed.length <= OVERRIDE_NOTE_MAX

  async function confirmDecide() {
    if (!deciding || !noteOk || busy) return
    const { req, approve } = deciding
    setBusy(true)
    setDialogError('')
    const { data, error } = await decideApproval(createClient(), req.id, approve, trimmed)
    setBusy(false)
    if (error) {
      setDialogError(isMissingError(error) ? t('prodShell.approvals.notAvailable') : errorText(error))
      return
    }
    setDeciding(null)
    refreshProdNotifications()
    if (approve) {
      // prod_decide_approval returns the updated request (status / result / error).
      const r = (data && typeof data === 'object' ? data : {}) as { status?: string; result?: unknown; error?: string | null; error_detail?: string | null }
      const failed = r.status === 'failed' || !!r.error
      const res: DecideResult = {
        approved: !failed,
        href: failed ? null : approvalResultHref({ rpcName: req.rpcName, payload: req.payload, result: r.result ?? null }),
        error: failed ? errorText({ message: r.error ?? '', details: r.error_detail ?? '' }) : '',
        label: req.label,
      }
      setLastResult(res)
      if (failed) toast.error(t('prodShell.approvals.failed'))
      else toast.success(t('prodShell.approvals.approvedToast'))
    } else {
      setLastResult(null)
      toast.success(t('prodShell.approvals.rejectedToast'))
    }
    void load()
  }

  async function withdraw(req: ApprovalRequest) {
    if (!window.confirm(t('prodShell.approvals.withdrawConfirm'))) return
    const { error } = await withdrawApproval(createClient(), req.id)
    if (error) { toast.error(errorText(error)); return }
    toast.success(t('prodShell.approvals.withdrawn'))
    refreshProdNotifications()
    void load()
  }

  if (!loading && !available) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('prodShell.approvals.title')} />
        <div className={cn(prodCardCls, 'flex items-center gap-3 p-6 text-sm text-gray-500 dark:text-gray-400')}>
          <ShieldAlert className="h-4 w-4 shrink-0 text-gray-400" />
          {t('prodShell.approvals.notAvailable')}
        </div>
      </div>
    )
  }

  const showRequester = tab !== 'mine'
  const colCount = showRequester ? 7 : 6

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodShell.approvals.title')}
        subtitle={t(canDecide ? 'prodShell.approvals.subtitleAdmin' : 'prodShell.approvals.subtitleStaff')}
      />

      {tabs.length > 1 && <Segmented options={tabs} value={tab} onChange={setTab} />}

      {lastResult && (
        <div className={cn(
          'flex items-start gap-2.5 rounded-xl border px-4 py-3 text-[13px]',
          lastResult.approved
            ? 'border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-green-800 dark:text-green-300'
            : 'border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-red-800 dark:text-red-300',
        )}>
          {lastResult.approved ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <X className="mt-0.5 h-4 w-4 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{lastResult.approved ? t('prodShell.approvals.resultOk') : t('prodShell.approvals.resultFailed')}</p>
            <p className="mt-0.5 truncate">{lastResult.label}</p>
            {lastResult.error && <p className="mt-0.5">{lastResult.error}</p>}
            {lastResult.href && (
              <Link href={lastResult.href} className="mt-1 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline">
                {t('prodShell.approvals.openDoc')} <ExternalLink className="h-3 w-3" />
              </Link>
            )}
          </div>
          <button type="button" onClick={() => setLastResult(null)} aria-label={t('prodControls.approval.close')} className="shrink-0 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <TableCard
        loading={loading}
        empty={rows.length === 0}
        emptyText={t(tab === 'pending' ? 'prodShell.approvals.emptyPending' : 'prodShell.approvals.empty')}
        emptyIcon={BadgeCheck}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={cn(thCls, 'w-8')} />
              <th className={thCls}>{t('prodShell.approvals.cols.at')}</th>
              {showRequester && <th className={thCls}>{t('prodShell.approvals.cols.who')}</th>}
              <th className={thCls}>{t('prodShell.approvals.cols.what')}</th>
              <th className={thCls}>{t('prodShell.approvals.cols.rule')}</th>
              <th className={thCls}>{t('prodShell.approvals.cols.status')}</th>
              <th className={cn(thCls, 'text-right')} />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isOpen = open.has(r.id)
              const explanation = ruleMessage(t, r.rule, settings, role, detailVars(r.ruleDetail))
              const summary = payloadSummary(r.payload)
              const href = r.status === 'approved' ? approvalResultHref(r) : null
              return (
                <Fragment key={r.id}>
                  <tr className={cn(trCls, 'cursor-pointer align-top')} onClick={() => toggle(r.id)}>
                    <td className={tdCls}><ExpandChevron open={isOpen} onClick={() => toggle(r.id)} label={t('prodShell.approvals.details')} /></td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.createdAt)}</td>
                    {showRequester && <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{r.requestedByName || '—'}</td>}
                    <td className={tdCls}>
                      <div className="font-medium text-gray-900 dark:text-gray-100">{r.label || t(rpcNameKey(r.rpcName))}</div>
                      <div className="text-[12px] text-gray-500 dark:text-gray-400">{t(rpcNameKey(r.rpcName))}</div>
                    </td>
                    <td className={cn(tdCls, 'max-w-[300px]')}>
                      <div className="text-gray-700 dark:text-gray-300">{t(ruleLabelKey(r.rule))}</div>
                    </td>
                    <td className={tdCls}>
                      <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', statusPillCls(r.status))}>{t(statusKey(r.status))}</span>
                    </td>
                    <td className={cn(tdCls, 'text-right whitespace-nowrap')} onClick={e => e.stopPropagation()}>
                      {r.status === 'pending' && canDecide && tab === 'pending' && (role === 'owner' || r.requestedBy !== userId) && (
                        <div className="inline-flex gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => startDecide(r, false)}>{t('prodShell.approvals.reject')}</Button>
                          <Button size="sm" onClick={() => startDecide(r, true)}>{t('prodShell.approvals.approve')}</Button>
                        </div>
                      )}
                      {r.status === 'pending' && tab === 'mine' && r.requestedBy === userId && (
                        <Button size="sm" variant="outline" onClick={() => withdraw(r)}>
                          <Undo2 className="h-3.5 w-3.5" /> {t('prodShell.approvals.withdraw')}
                        </Button>
                      )}
                      {href && (
                        <Link href={href} className="inline-flex items-center gap-1 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                          {t('prodShell.approvals.openDoc')} <ExternalLink className="h-3 w-3" />
                        </Link>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-gray-50 dark:border-gray-800/60 bg-gray-50/60 dark:bg-gray-800/30">
                      <td />
                      <td colSpan={colCount - 1} className="px-4 py-3">
                        <div className="grid gap-3 text-[13px] md:grid-cols-2">
                          <div className="space-y-1">
                            <p className="text-[12px] font-medium text-gray-500 dark:text-gray-400">{t('prodShell.approvals.why')}</p>
                            <p className="text-gray-800 dark:text-gray-200">{explanation}</p>
                            {r.decidedAt && (
                              <>
                                <p className="pt-2 text-[12px] font-medium text-gray-500 dark:text-gray-400">{t('prodShell.approvals.decision')}</p>
                                <p className="text-gray-800 dark:text-gray-200">
                                  {r.decidedByName || '—'} · {formatDateTime(r.decidedAt)}
                                </p>
                                {r.decisionNote && <p className="text-gray-600 dark:text-gray-400">{r.decisionNote}</p>}
                              </>
                            )}
                            {r.status === 'failed' && r.error && (
                              <p className="pt-1 text-red-600 dark:text-red-400">{errorText({ message: r.error, details: r.errorDetail })}</p>
                            )}
                          </div>
                          <div className="space-y-1">
                            <p className="text-[12px] font-medium text-gray-500 dark:text-gray-400">{t('prodShell.approvals.payload')}</p>
                            {summary.length === 0 ? (
                              <p className="text-gray-500 dark:text-gray-400">—</p>
                            ) : (
                              <ul className="space-y-0.5 font-mono text-[12px] text-gray-700 dark:text-gray-300">
                                {summary.map(line => <li key={line} className="break-all">{line}</li>)}
                              </ul>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </TableCard>

      <Dialog open={deciding !== null} onOpenChange={o => { if (!o && !busy) setDeciding(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t(deciding?.approve ? 'prodShell.approvals.approveTitle' : 'prodShell.approvals.rejectTitle')}</DialogTitle>
          </DialogHeader>
          {deciding && (
            <div className="space-y-4">
              <div className="rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2.5 text-[13px]">
                <p className="font-medium text-gray-900 dark:text-gray-100">{deciding.req.label || t(rpcNameKey(deciding.req.rpcName))}</p>
                <p className="mt-1 text-gray-600 dark:text-gray-400">{ruleMessage(t, deciding.req.rule, settings, role, detailVars(deciding.req.ruleDetail))}</p>
                <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">{deciding.req.requestedByName || '—'} · {formatDateTime(deciding.req.createdAt)}</p>
              </div>
              <label className="block">
                <span className={prodLabelCls}>{t(deciding.approve ? 'prodControls.approval.reason' : 'prodShell.approvals.rejectNote')}</span>
                <textarea
                  value={note}
                  rows={3}
                  maxLength={OVERRIDE_NOTE_MAX}
                  autoFocus
                  onChange={e => setNote(e.target.value.slice(0, OVERRIDE_NOTE_MAX))}
                  placeholder={t(deciding.approve ? 'prodControls.approval.reasonPlaceholder' : 'prodShell.approvals.rejectPlaceholder')}
                  className={cn(prodFieldCls, 'h-auto py-2 resize-none')}
                />
                {deciding.approve && (
                  <span className={cn('mt-1 block text-[11px]', trimmed.length > 0 && !noteOk ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500')}>
                    {t('prodControls.approval.reasonMin')}
                  </span>
                )}
              </label>
              {deciding.approve && <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodShell.approvals.approveHint')}</p>}
              {dialogError && <p className="text-[12px] text-red-600 dark:text-red-400">{dialogError}</p>}
            </div>
          )}
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setDeciding(null)} disabled={busy}>{t('production.common.cancel')}</Button>
            <Button
              variant={deciding?.approve ? 'default' : 'destructive'}
              onClick={confirmDecide}
              loading={busy}
              disabled={busy || !noteOk}
            >
              {t(deciding?.approve ? 'prodShell.approvals.approve' : 'prodShell.approvals.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
