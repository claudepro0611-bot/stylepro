'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, Edit2, Trash2, LogIn, AlertTriangle, Building2, CheckCircle2, CalendarPlus, Blocks } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/StatCard'
import { createClient } from '@/lib/supabase/client'
import { deleteCompany, impersonateCompany, type CompanyRow, type CompanyStats } from '@/app/(dashboard)/super-admin/actions'
import { AddCompanyModal } from '@/components/super-admin/AddCompanyModal'
import { FeatureModal } from '@/components/super-admin/FeatureModal'

interface FirmsClientProps {
  companies: CompanyRow[]
  stats: CompanyStats
}

export function FirmsClient({ companies, stats }: FirmsClientProps) {
  const router = useRouter()
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CompanyRow | null>(null)
  const [featureTarget, setFeatureTarget] = useState<CompanyRow | null>(null)
  const [isPending, startTransition] = useTransition()
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null)

  function refresh() {
    startTransition(() => {
      router.refresh()
    })
  }

  async function handleImpersonate(company: CompanyRow) {
    setImpersonatingId(company.id)
    const result = await impersonateCompany(company.id)

    if ('error' in result && result.error) {
      toast.error(result.error)
      setImpersonatingId(null)
      return
    }

    if ('success' in result) {
      if (!result.tokenHash) {
        toast.error('Kirish amalga oshmadi')
        setImpersonatingId(null)
        return
      }

      const supabase = createClient()
      const { error } = await supabase.auth.verifyOtp({
        email: result.email,
        token: result.tokenHash,
        type: 'magiclink',
      })

      if (error) {
        toast.error('Kirish amalga oshmadi')
        setImpersonatingId(null)
        return
      }

      router.push('/dashboard')
      router.refresh()
    }
  }

  async function executeDelete() {
    if (!deleteTarget) return
    const result = await deleteCompany(deleteTarget.id)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }

    toast.success("Firma o'chirildi")
    setDeleteTarget(null)
    refresh()
  }

  return (
    <div className="space-y-6 max-w-screen-xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Firmalar</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Barcha ro&apos;yxatdan o&apos;tgan firmalar</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Firma qo&apos;shish
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title="Jami firmalar" value={stats.total} icon={<Building2 className="h-4 w-4" />} />
        <StatCard title="Faol firmalar" value={stats.active} icon={<CheckCircle2 className="h-4 w-4" />} />
        <StatCard title="Bugun qo'shilgan" value={stats.addedToday} icon={<CalendarPlus className="h-4 w-4" />} />
      </div>

      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">№</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Firma nomi</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Login</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">Xodimlar</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">Ombor limiti</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Yaratilgan sana</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">Amallar</th>
              </tr>
            </thead>
            <tbody>
              {companies.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center">
                    <Building2 className="h-8 w-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">Firmalar topilmadi</p>
                  </td>
                </tr>
              ) : (
                companies.map((c, i) => (
                  <tr
                    key={c.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.name}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{c.login ?? '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                        {c.usersCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ${
                        c.warehousesCount >= c.warehouseLimit
                          ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                      }`}>
                        {c.warehousesCount}/{c.warehouseLimit}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ${
                        c.status === 'active'
                          ? 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                      }`}>
                        {c.status === 'active' ? 'Faol' : 'Nofaol'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                      {new Date(c.createdAt).toISOString().split('T')[0]}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleImpersonate(c)}
                          disabled={impersonatingId === c.id || isPending}
                          className="flex items-center gap-1 h-7 px-2 rounded-md text-[12px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
                        >
                          <LogIn className="h-3.5 w-3.5" />
                          Kirish
                        </button>
                        <Link
                          href={`/super-admin/firms/${c.id}/edit`}
                          className="flex items-center gap-1 h-7 px-2 rounded-md text-[12px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                          Tahrirlash
                        </Link>
                        <button
                          onClick={() => setFeatureTarget(c)}
                          className="flex items-center gap-1 h-7 px-2 rounded-md text-[12px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          <Blocks className="h-3.5 w-3.5" />
                          Modullar
                        </button>
                        <button
                          onClick={() => setDeleteTarget(c)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 dark:hover:text-red-400 transition-colors"
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

      <AddCompanyModal open={isAddOpen} onOpenChange={setIsAddOpen} onCreated={refresh} />

      <FeatureModal company={featureTarget} open={!!featureTarget} onOpenChange={open => { if (!open) setFeatureTarget(null) }} />

      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Firmani o&apos;chirish
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium text-gray-900 dark:text-gray-100">{deleteTarget?.name}</span> firmasini o&apos;chirishni tasdiqlaysizmi? Bu amalni orqaga qaytarib bo&apos;lmaydi.
            </p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Bekor qilish</Button>
            <Button variant="destructive" onClick={executeDelete}>O&apos;chirish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
