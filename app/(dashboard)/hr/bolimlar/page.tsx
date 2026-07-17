'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Plus, Edit2, Trash2, AlertTriangle, Building2, Users, Briefcase, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/StatCard'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { Department } from '@/lib/types'

const emptyForm = { name: '', managerId: '', managerName: '', description: '', status: 'active' as Department['status'] }

interface DepartmentRow {
  id: string
  name: string
  manager_id: string | null
  manager_name: string | null
  description: string | null
  status: Department['status']
}

function mapDepartment(row: DepartmentRow, employeesCount: number): Department {
  return {
    id: row.id,
    name: row.name,
    managerId: row.manager_id ?? '',
    managerName: row.manager_name ?? '',
    description: row.description ?? '',
    employeesCount,
    status: row.status,
  }
}

interface EmployeeLite {
  id: string
  firstName: string
  lastName: string
  positionName: string
  positionId: string
  departmentId: string
  status: 'active' | 'on-leave' | 'terminated'
}

interface PositionLite {
  id: string
  employeesCount: number
}

export default function BolimlarPage() {
  const { t } = useLanguage()
  const [departments, setDepartments] = useState<Department[]>([])
  const [employees, setEmployees] = useState<EmployeeLite[]>([])
  const [positions, setPositions] = useState<PositionLite[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editDept, setEditDept] = useState<Department | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteTarget, setDeleteTarget] = useState<Department | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [
      { data: deptRows, error: deptError },
      { data: empRows, error: empError },
      { data: posRows, error: posError },
    ] = await Promise.all([
      supabase.from('departments').select('*').order('name'),
      supabase.from('employees_safe').select('id, first_name, last_name, position_id, position_name, department_id, status'),
      supabase.from('positions').select('id'),
    ])

    if (deptError || empError || posError) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }

    const empList: EmployeeLite[] = (empRows as { id: string; first_name: string; last_name: string; position_id: string | null; position_name: string | null; department_id: string | null; status: EmployeeLite['status'] }[]).map(e => ({
      id: e.id,
      firstName: e.first_name,
      lastName: e.last_name,
      positionName: e.position_name ?? '',
      positionId: e.position_id ?? '',
      departmentId: e.department_id ?? '',
      status: e.status,
    }))

    const empCountByDept = new Map<string, number>()
    const empCountByPos = new Map<string, number>()
    for (const e of empList) {
      if (e.departmentId) empCountByDept.set(e.departmentId, (empCountByDept.get(e.departmentId) ?? 0) + 1)
      if (e.positionId) empCountByPos.set(e.positionId, (empCountByPos.get(e.positionId) ?? 0) + 1)
    }

    setDepartments((deptRows as DepartmentRow[]).map(d => mapDepartment(d, empCountByDept.get(d.id) ?? 0)))
    setEmployees(empList)
    setPositions((posRows as { id: string }[]).map(p => ({ id: p.id, employeesCount: empCountByPos.get(p.id) ?? 0 })))
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const managerOptions = useMemo(() =>
    employees.map(e => ({ value: e.id, label: `${e.firstName} ${e.lastName}`, sublabel: e.positionName })),
    [employees],
  )

  const stats = useMemo(() => ({
    total: departments.length,
    activeEmployees: employees.filter(e => e.status === 'active').length,
    openPositions: positions.filter(p => p.employeesCount === 0).length,
  }), [departments, employees, positions])

  function openAdd() {
    setEditDept(null)
    setForm(emptyForm)
    setIsFormOpen(true)
  }

  function openEdit(d: Department) {
    setEditDept(d)
    setForm({ name: d.name, managerId: d.managerId, managerName: d.managerName, description: d.description, status: d.status })
    setIsFormOpen(true)
  }

  async function saveDepartment() {
    if (!form.name.trim()) {
      toast.error(t('hr.bolimlar.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const payload = {
      name: form.name,
      manager_id: form.managerId || null,
      manager_name: form.managerName || null,
      description: form.description,
      status: form.status,
    }
    if (editDept) {
      const { error } = await supabase.from('departments').update(payload).eq('id', editDept.id)
      setSaving(false)
      if (error) {
        toast.error(t('common.error'))
        return
      }
      toast.success(t('hr.bolimlar.toasts.updateSuccess'))
    } else {
      const companyId = await getCompanyId(supabase)
      if (!companyId) { setSaving(false); toast.error(t('common.error')); return }
      const { error } = await supabase.from('departments').insert({ ...payload, company_id: companyId })
      setSaving(false)
      if (error) {
        toast.error(t('common.error'))
        return
      }
      toast.success(t('hr.bolimlar.toasts.addSuccess'))
    }
    setIsFormOpen(false)
    fetchData()
  }

  async function toggleStatus(d: Department) {
    const supabase = createClient()
    const newStatus = d.status === 'active' ? 'inactive' : 'active'
    const { error } = await supabase.from('departments').update({ status: newStatus }).eq('id', d.id)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    fetchData()
  }

  function confirmDelete(d: Department) {
    setDeleteTarget(d)
  }

  async function executeDelete() {
    if (!deleteTarget) return
    const supabase = createClient()
    const { error } = await supabase.from('departments').delete().eq('id', deleteTarget.id)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    toast.success(t('hr.bolimlar.toasts.deleteSuccess'))
    setDeleteTarget(null)
    fetchData()
  }

  const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('hr.bolimlar.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('hr.bolimlar.subtitle')}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('hr.bolimlar.addNew')}
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title={t('hr.bolimlar.stats.total')} value={stats.total} icon={<Building2 className="h-4 w-4" />} />
        <StatCard title={t('hr.bolimlar.stats.activeEmployees')} value={stats.activeEmployees} icon={<Users className="h-4 w-4" />} />
        <StatCard title={t('hr.bolimlar.stats.openPositions')} value={stats.openPositions} icon={<Briefcase className="h-4 w-4" />} />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t('hr.bolimlar.table.number')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.bolimlar.table.name')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.bolimlar.table.manager')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.bolimlar.table.employeesCount')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.bolimlar.table.status')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.bolimlar.table.actions')}</th>
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
              ) : departments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Building2 className="h-8 w-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">{t('hr.bolimlar.notFound')}</p>
                  </td>
                </tr>
              ) : (
                departments.map((d, i) => (
                  <tr
                    key={d.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
                      {d.description && <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate max-w-xs">{d.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{d.managerName || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                        {d.employeesCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => toggleStatus(d)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                          d.status === 'active' ? 'bg-gray-900 dark:bg-gray-100' : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                        aria-label="toggle status"
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${
                            d.status === 'active' ? 'translate-x-4' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => openEdit(d)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => confirmDelete(d)}
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
            <DialogTitle>{editDept ? t('hr.bolimlar.modal.editTitle') : t('hr.bolimlar.modal.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.bolimlar.modal.name')}</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className={inputCls}
                placeholder={t('hr.bolimlar.modal.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.bolimlar.modal.manager')}</label>
              <SearchSelect
                options={managerOptions}
                value={form.managerId}
                onChange={v => {
                  const emp = employees.find(e => e.id === v)
                  setForm(f => ({ ...f, managerId: v, managerName: emp ? `${emp.firstName} ${emp.lastName}` : '' }))
                }}
                placeholder={t('hr.bolimlar.modal.managerPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.bolimlar.modal.description')}</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
                placeholder={t('hr.bolimlar.modal.descriptionPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('hr.bolimlar.modal.statusLabel')}</label>
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
            <Button onClick={saveDepartment} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editDept ? t('common.edit') : t('common.add')}
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
              {t('hr.bolimlar.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('hr.bolimlar.deleteConfirm')}</p>
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
