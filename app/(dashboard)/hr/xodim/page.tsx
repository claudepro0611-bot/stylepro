'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { UserPlus, Users, UserCheck, UserX, Clock3, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/Pagination'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { StatCard } from '@/components/ui/StatCard'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { formatDate, formatPhone } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { Employee, PositionHistoryEntry, RewardPenaltyEntry } from '@/lib/types'

const ITEMS_PER_PAGE = 10

const emptyForm = {
  firstName: '', lastName: '', phone: '', birthDate: '',
  positionId: '', positionName: '', departmentId: '', departmentName: '',
  salary: '', startDate: '', address: '', status: 'active' as Employee['status'],
}

interface EmployeeRow {
  id: string
  first_name: string
  last_name: string
  phone: string | null
  birth_date: string | null
  address: string | null
  position_id: string | null
  position_name: string | null
  department_id: string | null
  department_name: string | null
  salary: number
  start_date: string
  photo_url: string | null
  status: Employee['status']
}

function mapEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone ?? '',
    birthDate: row.birth_date ?? '',
    address: row.address ?? '',
    positionId: row.position_id ?? '',
    positionName: row.position_name ?? '',
    departmentId: row.department_id ?? '',
    departmentName: row.department_name ?? '',
    salary: Number(row.salary),
    startDate: row.start_date,
    photoUrl: row.photo_url ?? '',
    status: row.status,
    history: [],
  }
}

interface PositionHistoryRow {
  id: string
  date: string
  position_name: string | null
  department_name: string | null
  salary: number
  note: string | null
}

function mapHistory(row: PositionHistoryRow): PositionHistoryEntry {
  return {
    id: row.id,
    date: row.date,
    positionName: row.position_name ?? '',
    departmentName: row.department_name ?? '',
    salary: Number(row.salary),
    note: row.note ?? '',
  }
}

interface RewardPenaltyRow {
  id: string
  employee_id: string
  employee_name: string | null
  department_name: string | null
  type: RewardPenaltyEntry['type']
  type_id: string | null
  type_name: string | null
  amount: number
  date: string
  note: string | null
}

function mapRewardPenalty(row: RewardPenaltyRow): RewardPenaltyEntry {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? '',
    departmentName: row.department_name ?? '',
    type: row.type,
    typeId: row.type_id ?? '',
    typeName: row.type_name ?? '',
    amount: Number(row.amount),
    date: row.date,
    note: row.note ?? '',
  }
}

interface PositionOption {
  id: string
  name: string
  departmentId: string
  departmentName: string
}

export default function XodimPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [positions, setPositions] = useState<PositionOption[]>([])
  const [rewardPenalties, setRewardPenalties] = useState<RewardPenaltyEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Employee | null>(null)
  const [detailTab, setDetailTab] = useState('info')
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [
      { data: empRows, error: empError },
      { data: posRows, error: posError },
      { data: rpRows, error: rpError },
    ] = await Promise.all([
      supabase.from('employees_safe').select('*').order('created_at', { ascending: false }),
      supabase.from('positions').select('id, name, department_id, department_name').order('name'),
      supabase.from('reward_penalty_entries').select('*'),
    ])

    if (empError || posError || rpError) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }

    setEmployees((empRows as EmployeeRow[]).map(mapEmployee))
    setPositions((posRows as { id: string; name: string; department_id: string | null; department_name: string | null }[]).map(p => ({
      id: p.id, name: p.name, departmentId: p.department_id ?? '', departmentName: p.department_name ?? '',
    })))
    setRewardPenalties((rpRows as RewardPenaltyRow[]).map(mapRewardPenalty))
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const stats = useMemo(() => ({
    total: employees.length,
    active: employees.filter(e => e.status === 'active').length,
    onLeave: employees.filter(e => e.status === 'on-leave').length,
    terminated: employees.filter(e => e.status === 'terminated').length,
  }), [employees])

  const totalPages = Math.ceil(employees.length / ITEMS_PER_PAGE)
  const paginated = employees.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  const positionOptions = useMemo(() =>
    positions.map(p => ({ value: p.id, label: p.name, sublabel: p.departmentName })),
    [positions],
  )

  const employeeRewardsPenalties = useMemo(() => {
    if (!selected) return []
    return rewardPenalties
      .filter(rp => rp.employeeId === selected.id)
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [selected, rewardPenalties])

  const rpTotals = useMemo(() => {
    const totalReward = employeeRewardsPenalties.filter(rp => rp.type === 'reward').reduce((s, rp) => s + rp.amount, 0)
    const totalPenalty = employeeRewardsPenalties.filter(rp => rp.type === 'penalty').reduce((s, rp) => s + rp.amount, 0)
    return { totalReward, totalPenalty, net: totalReward - totalPenalty }
  }, [employeeRewardsPenalties])

  function initials(first: string, last: string) {
    return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase()
  }

  async function openDetail(e: Employee) {
    setSelected(e)
    setDetailTab('info')
    setIsDetailOpen(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('position_history_safe')
      .select('*')
      .eq('employee_id', e.id)
      .order('date', { ascending: false })
    if (!error) {
      setSelected({ ...e, history: (data as PositionHistoryRow[]).map(mapHistory) })
    }
  }

  function openAdd() {
    setForm(emptyForm)
    setIsAddOpen(true)
  }

  async function addEmployee() {
    if (!form.firstName.trim() || !form.lastName.trim() || !form.phone.trim() || !form.positionId || !form.salary) {
      toast.error(t('hr.xodim.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setSaving(false); toast.error(t('common.error')); return }
    const startDate = form.startDate || new Date().toISOString().split('T')[0]
    const { data: emp, error: empError } = await supabase
      .from('employees')
      .insert({
        company_id: companyId,
        first_name: form.firstName,
        last_name: form.lastName,
        phone: form.phone,
        birth_date: form.birthDate || null,
        address: form.address,
        position_id: form.positionId || null,
        position_name: form.positionName,
        department_id: form.departmentId || null,
        department_name: form.departmentName,
        salary: Number(form.salary),
        start_date: startDate,
        status: form.status,
      })
      .select()
      .single()

    if (empError || !emp) {
      setSaving(false)
      toast.error(t('common.error'))
      return
    }

    await supabase.from('position_history').insert({
      company_id: companyId,
      employee_id: emp.id,
      date: startDate,
      position_name: form.positionName,
      department_name: form.departmentName,
      salary: Number(form.salary),
      note: 'Ishga qabul qilindi',
    })

    setSaving(false)
    setIsAddOpen(false)
    toast.success(t('hr.xodim.toasts.addSuccess'))
    fetchData()
  }

  const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('hr.xodim.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('hr.xodim.subtitle')}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <UserPlus className="h-3.5 w-3.5" />
          {t('hr.xodim.addNew')}
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title={t('hr.xodim.stats.total')} value={stats.total} icon={<Users className="h-4 w-4" />} />
        <StatCard title={t('hr.xodim.stats.active')} value={stats.active} icon={<UserCheck className="h-4 w-4" />} />
        <StatCard title={t('hr.xodim.stats.onLeave')} value={stats.onLeave} icon={<Clock3 className="h-4 w-4" />} />
        <StatCard title={t('hr.xodim.stats.terminated')} value={stats.terminated} icon={<UserX className="h-4 w-4" />} />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t('hr.xodim.table.number')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t('hr.xodim.table.photo')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.xodim.table.fullName')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.xodim.table.position')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">{t('hr.xodim.table.department')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.xodim.table.salary')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">{t('hr.xodim.table.phone')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">{t('hr.xodim.table.startDate')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.xodim.table.status')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2 text-gray-400 dark:text-gray-500" />
                    <span className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center">
                    <Users className="h-8 w-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">{t('hr.xodim.notFound')}</p>
                  </td>
                </tr>
              ) : (
                paginated.map((e, i) => (
                  <tr
                    key={e.id}
                    onClick={() => openDetail(e)}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{(page - 1) * ITEMS_PER_PAGE + i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
                        {initials(e.firstName, e.lastName)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{e.firstName} {e.lastName}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{e.positionName}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell">{e.departmentName}</td>
                    <td className="px-4 py-3 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(e.salary)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 hidden lg:table-cell">{formatPhone(e.phone)}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell">{formatDate(e.startDate)}</td>
                    <td className="px-4 py-3">
                      <MiniBadge status={e.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={employees.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setPage}
        />
      </div>

      {/* Employee Detail Modal */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="sm:max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {initials(selected.firstName, selected.lastName)}
                  </div>
                  <div>
                    <DialogTitle className="text-base">{selected.firstName} {selected.lastName}</DialogTitle>
                    <div className="mt-1">
                      <MiniBadge status={selected.status} />
                    </div>
                  </div>
                </div>
              </DialogHeader>

              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList>
                  <TabsTrigger value="info">{t('hr.xodim.detail.tabs.info')}</TabsTrigger>
                  <TabsTrigger value="rewards">{t('hr.xodim.detail.tabs.rewards')}</TabsTrigger>
                  <TabsTrigger value="history">{t('hr.xodim.detail.tabs.history')}</TabsTrigger>
                </TabsList>

                <TabsContent value="info" className="mt-4 space-y-0">
                  {[
                    [t('hr.xodim.detail.info.fullName'), `${selected.firstName} ${selected.lastName}`],
                    [t('hr.xodim.detail.info.birthDate'), selected.birthDate ? formatDate(selected.birthDate) : '—'],
                    [t('hr.xodim.detail.info.phone'), formatPhone(selected.phone)],
                    [t('hr.xodim.detail.info.address'), selected.address || '—'],
                    [t('hr.xodim.detail.info.position'), selected.positionName],
                    [t('hr.xodim.detail.info.department'), selected.departmentName],
                    [t('hr.xodim.detail.info.salary'), formatPrice(selected.salary)],
                    [t('hr.xodim.detail.info.startDate'), formatDate(selected.startDate)],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <span className="text-sm text-gray-400 dark:text-gray-500">{label}</span>
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</span>
                    </div>
                  ))}
                  <div className="flex justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <span className="text-sm text-gray-400 dark:text-gray-500">{t('hr.xodim.detail.info.netSalary')}</span>
                    <span className={`text-sm font-semibold tabular-nums ${(rpTotals.totalReward - rpTotals.totalPenalty) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {formatPrice(selected.salary + rpTotals.totalReward - rpTotals.totalPenalty)}
                    </span>
                  </div>
                </TabsContent>

                <TabsContent value="rewards" className="mt-4">
                  <div className="grid grid-cols-3 gap-2 mb-4">
                    <div className="rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 p-3">
                      <p className="text-[11px] text-green-600 dark:text-green-400">{t('hr.xodim.detail.rewards.totalReward')}</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-green-700 dark:text-green-400">{formatPrice(rpTotals.totalReward)}</p>
                    </div>
                    <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
                      <p className="text-[11px] text-red-600 dark:text-red-400">{t('hr.xodim.detail.rewards.totalPenalty')}</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-red-700 dark:text-red-400">{formatPrice(rpTotals.totalPenalty)}</p>
                    </div>
                    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('hr.xodim.detail.rewards.net')}</p>
                      <p className="mt-1 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(rpTotals.net)}</p>
                    </div>
                  </div>
                  {employeeRewardsPenalties.length === 0 ? (
                    <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('hr.xodim.detail.rewards.empty')}</p>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {employeeRewardsPenalties.map(rp => (
                        <div key={rp.id} className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2.5">
                          <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{rp.typeName}</p>
                            <p className="text-[11px] text-gray-400 dark:text-gray-500">{formatDate(rp.date)}{rp.note ? ` · ${rp.note}` : ''}</p>
                          </div>
                          <span className={`text-sm font-semibold tabular-nums ${rp.type === 'reward' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {rp.type === 'reward' ? '+' : '-'}{formatPrice(rp.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="history" className="mt-4">
                  {selected.history.length === 0 ? (
                    <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('hr.xodim.detail.history.empty')}</p>
                  ) : (
                    <div className="space-y-3">
                      {selected.history.slice().reverse().map((h, idx) => (
                        <div key={h.id} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="h-2.5 w-2.5 rounded-full bg-gray-900 dark:bg-gray-100" />
                            {idx < selected.history.length - 1 && <div className="w-px flex-1 bg-gray-200 dark:bg-gray-700 mt-1" />}
                          </div>
                          <div className="pb-3">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{h.positionName} · {h.departmentName}</p>
                            <p className="text-[11px] text-gray-400 dark:text-gray-500">{formatDate(h.date)} · {formatPrice(h.salary)}</p>
                            {h.note && <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">{h.note}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>

              <DialogFooter showCloseButton />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Employee Modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('hr.xodim.modal.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2 max-h-[70vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.firstName')}</label>
                <input
                  value={form.firstName}
                  onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                  className={inputCls}
                  placeholder={t('hr.xodim.modal.firstNamePlaceholder')}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.lastName')}</label>
                <input
                  value={form.lastName}
                  onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                  className={inputCls}
                  placeholder={t('hr.xodim.modal.lastNamePlaceholder')}
                />
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.phone')}</label>
              <input
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className={inputCls}
                placeholder={t('hr.xodim.modal.phonePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.birthDate')}</label>
              <input
                type="date"
                value={form.birthDate}
                onChange={e => setForm(f => ({ ...f, birthDate: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.position')}</label>
              <SearchSelect
                options={positionOptions}
                value={form.positionId}
                onChange={v => {
                  const pos = positions.find(p => p.id === v)
                  setForm(f => ({
                    ...f,
                    positionId: v,
                    positionName: pos?.name ?? '',
                    departmentId: pos?.departmentId ?? '',
                    departmentName: pos?.departmentName ?? '',
                  }))
                }}
                placeholder={t('hr.xodim.modal.positionPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.department')}</label>
              <input value={form.departmentName} readOnly className={`${inputCls} bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400`} />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.salary')}</label>
              <input
                type="number"
                value={form.salary}
                onChange={e => setForm(f => ({ ...f, salary: e.target.value }))}
                className={inputCls}
                placeholder="3000000"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.startDate')}</label>
              <input
                type="date"
                value={form.startDate}
                onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.xodim.modal.address')}</label>
              <input
                value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className={inputCls}
                placeholder={t('hr.xodim.modal.addressPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('hr.xodim.modal.statusLabel')}</label>
              <div className="flex gap-2">
                {(['active', 'on-leave', 'terminated'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, status: s }))}
                    className={`flex-1 h-9 rounded-lg text-[12px] font-medium border transition-colors ${
                      form.status === s
                        ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    {s === 'active' ? t('status.active') : s === 'on-leave' ? t('status.onLeave') : t('status.terminated')}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={addEmployee} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
