'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2, Pencil, Plus, Power, PowerOff, Star, Store, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { branchErrorKey, isAllBranchRole, type BranchOverviewRow } from '@/lib/branches'
import { BranchFormDialog, type EditableBranch } from '@/components/filiallar/BranchFormDialog'

const thCls = 'px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400'
const iconBtnCls = 'flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400'

export default function FiliallarPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const { loading: sessionLoading, profile, refreshBranches } = useSession()
  const allowed = isAllBranchRole(profile?.role)

  const [rows, setRows] = useState<BranchOverviewRow[]>([])
  const [branchLimit, setBranchLimit] = useState(1)
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<EditableBranch | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BranchOverviewRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Client-side guard (proxy.ts already redirects server-side).
  useEffect(() => {
    if (!sessionLoading && !allowed) router.replace('/dashboard')
  }, [sessionLoading, allowed, router])

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data, error }, { data: companyData }] = await Promise.all([
      supabase.rpc('branch_overview'),
      supabase.from('companies').select('branch_limit').single(),
    ])
    if (error) {
      toast.error(t(branchErrorKey(error.message, error.code) ?? 'common.error'))
    } else {
      setRows(((data ?? []) as BranchOverviewRow[]).map(r => ({
        ...r,
        warehouse_count: Number(r.warehouse_count ?? 0),
        user_count: Number(r.user_count ?? 0),
      })))
      setBranchLimit((companyData as { branch_limit: number } | null)?.branch_limit ?? 1)
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    if (!sessionLoading && allowed) load()
  }, [sessionLoading, allowed, load])

  const afterMutation = useCallback(async () => {
    await Promise.all([load(), refreshBranches()])
  }, [load, refreshBranches])

  const limitReached = rows.length >= branchLimit

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(r: BranchOverviewRow) {
    setEditing({ id: r.id, name: r.name, address: r.address, phone: r.phone })
    setFormOpen(true)
  }

  async function runAction(id: string, call: () => PromiseLike<{ error: { message: string; code?: string } | null }>, successKey: Parameters<typeof t>[0]) {
    setBusyId(id)
    const { error } = await call()
    setBusyId(null)
    if (error) {
      toast.error(t(branchErrorKey(error.message, error.code) ?? 'common.error'))
      return
    }
    toast.success(t(successKey))
    afterMutation()
  }

  function makeDefault(r: BranchOverviewRow) {
    runAction(r.id, () => createClient().rpc('set_default_branch', { p_id: r.id }), 'branches.toasts.defaultSet')
  }

  function toggleActive(r: BranchOverviewRow) {
    const next = !r.is_active
    runAction(
      r.id,
      () => createClient().rpc('set_branch_active', { p_id: r.id, p_active: next }),
      next ? 'branches.toasts.activated' : 'branches.toasts.deactivated',
    )
  }

  async function executeDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const { error } = await createClient().rpc('delete_branch', { p_id: deleteTarget.id })
    setDeleting(false)
    if (error) {
      toast.error(t(branchErrorKey(error.message, error.code) ?? 'common.error'))
      return
    }
    setDeleteTarget(null)
    toast.success(t('branches.toasts.deleted'))
    afterMutation()
  }

  if (sessionLoading || !allowed) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('branches.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('branches.subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={openCreate}
          disabled={loading || limitReached}
          className={cn(
            'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
            loading || limitReached
              ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              : 'bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900',
          )}
        >
          <Plus className="h-4 w-4" />
          {t('branches.addNew')}
        </button>
        <span className="rounded-lg bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-xs font-medium tabular-nums text-gray-600 dark:text-gray-400">
          {rows.length}/{branchLimit}
        </span>
      </div>

      {!loading && limitReached && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('branches.limitReached')}
        </div>
      )}

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Store className="h-6 w-6 text-gray-300 dark:text-gray-600" />
            {t('branches.empty')}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className={cn(thCls, 'text-left')}>{t('branches.table.name')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('branches.table.address')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('branches.table.phone')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('branches.table.warehouses')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('branches.table.users')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('branches.table.status')}</th>
                    <th className={cn(thCls, 'text-center')}>{t('branches.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const busy = busyId === r.id
                    const canDelete = !r.is_default && r.warehouse_count === 0 && r.user_count === 0
                    return (
                      <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex w-9 h-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
                              <Store className="h-4 w-4 text-gray-400" />
                            </div>
                            <div className="flex min-w-0 items-center gap-2">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{r.name}</p>
                              {r.is_default && (
                                <span className="shrink-0 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
                                  {t('branches.defaultBadge')}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{r.address || '—'}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 tabular-nums">{r.phone || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100">{r.warehouse_count}</td>
                        <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100">{r.user_count}</td>
                        <td className="px-4 py-3">
                          {r.is_active ? (
                            <span className="rounded-full bg-green-100 dark:bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                              {t('branches.status.active')}
                            </span>
                          ) : (
                            <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                              {t('branches.status.inactive')}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => openEdit(r)}
                              disabled={busy}
                              title={t('branches.actions.edit')}
                              aria-label={t('branches.actions.edit')}
                              className={iconBtnCls}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => makeDefault(r)}
                              disabled={busy || r.is_default || !r.is_active}
                              title={t('branches.actions.makeDefault')}
                              aria-label={t('branches.actions.makeDefault')}
                              className={iconBtnCls}
                            >
                              <Star className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleActive(r)}
                              disabled={busy || r.is_default}
                              title={t(r.is_active ? 'branches.actions.deactivate' : 'branches.actions.activate')}
                              aria-label={t(r.is_active ? 'branches.actions.deactivate' : 'branches.actions.activate')}
                              className={iconBtnCls}
                            >
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : r.is_active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => { if (canDelete) setDeleteTarget(r) }}
                              disabled={busy || !canDelete}
                              title={canDelete ? t('branches.actions.delete') : t('branches.deleteBlocked')}
                              aria-label={t('branches.actions.delete')}
                              className={cn(
                                'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                                canDelete && !busy
                                  ? 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
                                  : 'text-gray-300 dark:text-gray-600 cursor-not-allowed',
                              )}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
              {rows.length} {t('branches.shownSuffix')}
            </div>
          </>
        )}
      </div>

      <BranchFormDialog
        open={formOpen}
        branch={editing}
        onOpenChange={setFormOpen}
        onSaved={afterMutation}
      />

      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('branches.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-2">
            <p className="font-medium text-gray-900 dark:text-gray-100">{deleteTarget?.name}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('branches.deleteConfirm')}</p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDelete} disabled={deleting} loading={deleting}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
