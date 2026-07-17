'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { UserPlus, Users, UserCheck, Gauge, Edit2, Trash2, Loader2, AlertTriangle, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/StatCard'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { AddUserModal } from '@/components/jamoa/AddUserModal'
import { EditUserModal } from '@/components/jamoa/EditUserModal'
import { getTeamData, deleteTeamUser, type TeamUserRow } from '@/app/(dashboard)/jamoa/actions'

export default function JamoaPage() {
  const { t } = useLanguage()
  const [users, setUsers] = useState<TeamUserRow[]>([])
  const [userLimit, setUserLimit] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<TeamUserRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TeamUserRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const errorToastShown = useRef(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getTeamData()
      if ('error' in data) {
        setError(data.error)
        if (!errorToastShown.current) {
          errorToastShown.current = true
          toast.error(data.error)
        }
      } else {
        setError(null)
        errorToastShown.current = false
        setUsers(data.users)
        setUserLimit(data.userLimit)
      }
    } catch {
      setError(t('common.error'))
      if (!errorToastShown.current) {
        errorToastShown.current = true
        toast.error(t('common.error'))
      }
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const activeCount = users.filter(u => u.status === 'active').length
  const nonOwnerCount = users.filter(u => u.role !== 'owner').length
  const limitReached = nonOwnerCount >= userLimit

  async function executeDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const result = await deleteTeamUser(deleteTarget.id)
    setDeleting(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }

    toast.success(t('jamoa.toasts.deleteSuccess'))
    setDeleteTarget(null)
    fetchData()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('jamoa.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('jamoa.subtitle')}</p>
        </div>
        {!error && (
          <button
            onClick={() => setIsAddOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            {t('jamoa.addUser')}
          </button>
        )}
      </div>

      {error && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm py-16 text-center transition-colors">
          <AlertCircle className="h-8 w-8 text-amber-500 mb-3" />
          <p className="text-sm text-gray-600 dark:text-gray-400">{error}</p>
        </div>
      )}

      {!error && (
      <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title={t('jamoa.stats.total')} value={users.length} icon={<Users className="h-4 w-4" />} />
        <StatCard title={t('jamoa.stats.active')} value={activeCount} icon={<UserCheck className="h-4 w-4" />} />
        <StatCard title={t('jamoa.stats.limit')} value={`${nonOwnerCount} / ${userLimit}`} icon={<Gauge className="h-4 w-4" />} />
      </div>

      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t('jamoa.table.number')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('jamoa.table.name')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('jamoa.table.login')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('jamoa.table.status')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('jamoa.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2 text-gray-400 dark:text-gray-500" />
                    <span className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <Users className="h-8 w-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">{t('jamoa.notFound')}</p>
                  </td>
                </tr>
              ) : (
                users.map((u, i) => (
                  <tr
                    key={u.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{u.fullName}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{u.login}</td>
                    <td className="px-4 py-3">
                      <MiniBadge status={u.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => setEditTarget(u)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(u)}
                          disabled={u.role === 'owner'}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}

      <AddUserModal open={isAddOpen} onOpenChange={setIsAddOpen} onCreated={fetchData} limitReached={limitReached} />

      <EditUserModal user={editTarget} onOpenChange={open => { if (!open) setEditTarget(null) }} onUpdated={fetchData} />

      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('jamoa.deleteConfirmTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium text-gray-900 dark:text-gray-100">{deleteTarget?.fullName}</span> — {t('jamoa.deleteConfirmText')}
            </p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDelete} disabled={deleting}>
              {deleting ? t('common.loading') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
