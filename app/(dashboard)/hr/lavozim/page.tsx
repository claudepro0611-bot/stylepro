'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Plus, Edit2, Trash2, AlertTriangle, Briefcase, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { Position } from '@/lib/types'

const emptyForm = { name: '', departmentId: '', departmentName: '', description: '', status: 'active' as Position['status'] }

interface PositionRow {
  id: string
  name: string
  department_id: string | null
  department_name: string | null
  description: string | null
  status: Position['status']
}

function mapPosition(row: PositionRow, employeesCount: number): Position {
  return {
    id: row.id,
    name: row.name,
    departmentId: row.department_id ?? '',
    departmentName: row.department_name ?? '',
    description: row.description ?? '',
    employeesCount,
    status: row.status,
  }
}

interface DepartmentLite {
  id: string
  name: string
}

export default function LavozimPage() {
  const { t } = useLanguage()
  const [positions, setPositions] = useState<Position[]>([])
  const [departments, setDepartments] = useState<DepartmentLite[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editPosition, setEditPosition] = useState<Position | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteTarget, setDeleteTarget] = useState<Position | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [
      { data: posRows, error: posError },
      { data: deptRows, error: deptError },
      { data: empRows, error: empError },
    ] = await Promise.all([
      supabase.from('positions').select('*').order('name'),
      supabase.from('departments').select('id, name').order('name'),
      supabase.from('employees_safe').select('position_id'),
    ])

    if (posError || deptError || empError) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }

    const empCountByPos = new Map<string, number>()
    for (const e of empRows as { position_id: string | null }[]) {
      if (e.position_id) empCountByPos.set(e.position_id, (empCountByPos.get(e.position_id) ?? 0) + 1)
    }

    setPositions((posRows as PositionRow[]).map(p => mapPosition(p, empCountByPos.get(p.id) ?? 0)))
    setDepartments(deptRows as DepartmentLite[])
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const departmentOptions = useMemo(() =>
    departments.map(d => ({ value: d.id, label: d.name })),
    [departments],
  )

  function openAdd() {
    setEditPosition(null)
    setForm(emptyForm)
    setIsFormOpen(true)
  }

  function openEdit(p: Position) {
    setEditPosition(p)
    setForm({ name: p.name, departmentId: p.departmentId, departmentName: p.departmentName, description: p.description, status: p.status })
    setIsFormOpen(true)
  }

  async function savePosition() {
    if (!form.name.trim() || !form.departmentId) {
      toast.error(t('hr.lavozim.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const payload = {
      name: form.name,
      department_id: form.departmentId,
      department_name: form.departmentName,
      description: form.description,
      status: form.status,
    }
    if (editPosition) {
      const { error } = await supabase.from('positions').update(payload).eq('id', editPosition.id)
      setSaving(false)
      if (error) {
        toast.error(t('common.error'))
        return
      }
      toast.success(t('hr.lavozim.toasts.updateSuccess'))
    } else {
      const companyId = await getCompanyId(supabase)
      if (!companyId) { setSaving(false); toast.error(t('common.error')); return }
      const { error } = await supabase.from('positions').insert({ ...payload, company_id: companyId })
      setSaving(false)
      if (error) {
        toast.error(t('common.error'))
        return
      }
      toast.success(t('hr.lavozim.toasts.addSuccess'))
    }
    setIsFormOpen(false)
    fetchData()
  }

  async function toggleStatus(p: Position) {
    const supabase = createClient()
    const newStatus = p.status === 'active' ? 'inactive' : 'active'
    const { error } = await supabase.from('positions').update({ status: newStatus }).eq('id', p.id)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    fetchData()
  }

  function confirmDelete(p: Position) {
    setDeleteTarget(p)
  }

  async function executeDelete() {
    if (!deleteTarget) return
    const supabase = createClient()
    const { error } = await supabase.from('positions').delete().eq('id', deleteTarget.id)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    toast.success(t('hr.lavozim.toasts.deleteSuccess'))
    setDeleteTarget(null)
    fetchData()
  }

  const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('hr.lavozim.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('hr.lavozim.subtitle')}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('hr.lavozim.addNew')}
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t('hr.lavozim.table.number')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.lavozim.table.name')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.lavozim.table.department')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.lavozim.table.employeesCount')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.lavozim.table.status')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.lavozim.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2 text-gray-400 dark:text-gray-500" />
                    <span className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
                  </td>
                </tr>
              ) : positions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Briefcase className="h-8 w-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">{t('hr.lavozim.notFound')}</p>
                  </td>
                </tr>
              ) : (
                positions.map((p, i) => (
                  <tr
                    key={p.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</p>
                      {p.description && <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate max-w-xs">{p.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{p.departmentName}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                        {p.employeesCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => toggleStatus(p)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                          p.status === 'active' ? 'bg-gray-900 dark:bg-gray-100' : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                        aria-label="toggle status"
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${
                            p.status === 'active' ? 'translate-x-4' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => openEdit(p)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => confirmDelete(p)}
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

      {/* Add / Edit Modal */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editPosition ? t('hr.lavozim.modal.editTitle') : t('hr.lavozim.modal.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.lavozim.modal.name')}</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className={inputCls}
                placeholder={t('hr.lavozim.modal.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.lavozim.modal.department')}</label>
              <SearchSelect
                options={departmentOptions}
                value={form.departmentId}
                onChange={v => {
                  const dep = departments.find(d => d.id === v)
                  setForm(f => ({ ...f, departmentId: v, departmentName: dep?.name ?? '' }))
                }}
                placeholder={t('hr.lavozim.modal.departmentPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.lavozim.modal.description')}</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
                placeholder={t('hr.lavozim.modal.descriptionPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('hr.lavozim.modal.statusLabel')}</label>
              <div className="flex gap-2">
                {(['active', 'inactive'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, status: s }))}
                    className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${
                      form.status === s
                        ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    {s === 'active' ? t('status.active') : t('status.inactive')}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={savePosition} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editPosition ? t('common.edit') : t('common.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('hr.lavozim.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('hr.lavozim.deleteConfirm')}</p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDelete}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
