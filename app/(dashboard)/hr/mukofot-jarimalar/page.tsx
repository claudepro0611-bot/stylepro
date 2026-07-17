'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Gift, ShieldAlert, Wallet, CalendarDays, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/Pagination'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { StatCard } from '@/components/ui/StatCard'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { formatDate } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { RewardPenaltyEntry, RewardPenaltyTypeDef, RewardPenaltyKind } from '@/lib/types'

const ITEMS_PER_PAGE = 10
type Period = 'today' | 'week' | 'month' | 'custom'
type TypeFilter = 'all' | 'reward' | 'penalty'

interface EmployeeLite {
  id: string
  firstName: string
  lastName: string
  departmentName: string
  salary: number
}

interface RewardPenaltyTypeRow {
  id: string
  name: string
  amount: number
  kind: RewardPenaltyKind
  category: 'reward' | 'penalty'
  description: string | null
}

function mapType(row: RewardPenaltyTypeRow): RewardPenaltyTypeDef {
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    kind: row.kind,
    description: row.description ?? '',
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

function mapEntry(row: RewardPenaltyRow): RewardPenaltyEntry {
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

export default function MukofotJarimalarPage() {
  const router = useRouter()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [isOwner, setIsOwner] = useState<boolean | null>(null)
  const [employees, setEmployees] = useState<EmployeeLite[]>([])
  const [rewardTypes, setRewardTypes] = useState<RewardPenaltyTypeDef[]>([])
  const [penaltyTypes, setPenaltyTypes] = useState<RewardPenaltyTypeDef[]>([])
  const [entries, setEntries] = useState<RewardPenaltyEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [savingReward, setSavingReward] = useState(false)
  const [savingPenalty, setSavingPenalty] = useState(false)

  // Percent-based rewards/penalties are calculated from the employee's real
  // salary (computeAmount below), so this page needs the actual value, not
  // the employees_safe view's masked one for non-owners — restrict the
  // whole page to owners rather than let it silently compute 0 UZS for
  // everyone else.
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('users').select('role').eq('id', user.id).single()
      const owner = data?.role === 'owner'
      setIsOwner(owner)
      if (!owner) router.push('/hr/xodim')
    })
  }, [router])

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [
      { data: empRows, error: empError },
      { data: typeRows, error: typeError },
      { data: entryRows, error: entryError },
    ] = await Promise.all([
      supabase.from('employees_safe').select('id, first_name, last_name, department_name, salary'),
      supabase.from('reward_penalty_types').select('*'),
      supabase.from('reward_penalty_entries').select('*').order('date', { ascending: false }),
    ])

    if (empError || typeError || entryError) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }

    setEmployees((empRows as { id: string; first_name: string; last_name: string; department_name: string | null; salary: number }[]).map(e => ({
      id: e.id, firstName: e.first_name, lastName: e.last_name, departmentName: e.department_name ?? '', salary: Number(e.salary),
    })))
    const typeRowsTyped = typeRows as RewardPenaltyTypeRow[]
    setRewardTypes(typeRowsTyped.filter(r => r.category === 'reward').map(mapType))
    setPenaltyTypes(typeRowsTyped.filter(r => r.category === 'penalty').map(mapType))
    setEntries((entryRows as RewardPenaltyRow[]).map(mapEntry))
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const [page, setPage] = useState(1)
  const [period, setPeriod] = useState<Period>('month')
  const [employeeFilter, setEmployeeFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')

  const [isRewardOpen, setIsRewardOpen] = useState(false)
  const [isPenaltyOpen, setIsPenaltyOpen] = useState(false)
  const [rewardForm, setRewardForm] = useState({ employeeId: '', typeId: '', amount: '', date: '', note: '' })
  const [penaltyForm, setPenaltyForm] = useState({ employeeId: '', typeId: '', amount: '', date: '', reason: '' })

  const employeeOptions = useMemo(() =>
    employees.map(e => ({ value: e.id, label: `${e.firstName} ${e.lastName}`, sublabel: e.departmentName })),
    [employees],
  )
  const rewardTypeOptions = useMemo(() =>
    rewardTypes.map(rt => ({ value: rt.id, label: rt.name, sublabel: rt.kind === 'percent' ? `${rt.amount}%` : formatPrice(rt.amount) })),
    [rewardTypes, formatPrice],
  )
  const penaltyTypeOptions = useMemo(() =>
    penaltyTypes.map(pt => ({ value: pt.id, label: pt.name, sublabel: pt.kind === 'percent' ? `${pt.amount}%` : formatPrice(pt.amount) })),
    [penaltyTypes, formatPrice],
  )

  const filtered = useMemo(() => {
    let list = entries
    const now = new Date()
    if (period !== 'custom') {
      list = list.filter(e => {
        const d = new Date(e.date)
        if (period === 'today') {
          return d.toDateString() === now.toDateString()
        }
        if (period === 'week') {
          const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
          return diff >= 0 && diff < 7
        }
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      })
    }
    if (employeeFilter !== 'all') list = list.filter(e => e.employeeId === employeeFilter)
    if (typeFilter !== 'all') list = list.filter(e => e.type === typeFilter)
    return list.slice().sort((a, b) => b.date.localeCompare(a.date))
  }, [entries, period, employeeFilter, typeFilter])

  const stats = useMemo(() => {
    const now = new Date()
    const thisMonth = entries.filter(e => {
      const d = new Date(e.date)
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    })
    const totalRewards = entries.filter(e => e.type === 'reward').reduce((s, e) => s + e.amount, 0)
    const totalPenalties = entries.filter(e => e.type === 'penalty').reduce((s, e) => s + e.amount, 0)
    const thisMonthNet = thisMonth.reduce((s, e) => s + (e.type === 'reward' ? e.amount : -e.amount), 0)
    return {
      totalRewards,
      totalPenalties,
      net: totalRewards - totalPenalties,
      thisMonth: thisMonthNet,
    }
  }, [entries])

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE)
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  function openReward() {
    setRewardForm({ employeeId: '', typeId: '', amount: '', date: new Date().toISOString().split('T')[0], note: '' })
    setIsRewardOpen(true)
  }

  function openPenalty() {
    setPenaltyForm({ employeeId: '', typeId: '', amount: '', date: new Date().toISOString().split('T')[0], reason: '' })
    setIsPenaltyOpen(true)
  }

  function computeAmount(employeeId: string, typeId: string, types: typeof rewardTypes) {
    const emp = employees.find(e => e.id === employeeId)
    const type = types.find(t => t.id === typeId)
    if (!type) return ''
    if (type.kind === 'percent' && emp) return String(Math.round(emp.salary * (type.amount / 100)))
    return String(type.amount)
  }

  async function saveReward() {
    if (!rewardForm.employeeId || !rewardForm.typeId || !rewardForm.amount) {
      toast.error(t('hr.mukofotJarimalar.toasts.requiredError'))
      return
    }
    const emp = employees.find(e => e.id === rewardForm.employeeId)
    const type = rewardTypes.find(rt => rt.id === rewardForm.typeId)
    if (!emp || !type) return
    setSavingReward(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setSavingReward(false); toast.error(t('common.error')); return }
    const { error } = await supabase.from('reward_penalty_entries').insert({
      company_id: companyId,
      employee_id: emp.id,
      employee_name: `${emp.firstName} ${emp.lastName}`,
      department_name: emp.departmentName,
      type: 'reward',
      type_id: type.id,
      type_name: type.name,
      amount: Number(rewardForm.amount),
      date: rewardForm.date || new Date().toISOString().split('T')[0],
      note: rewardForm.note,
    })
    setSavingReward(false)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    setIsRewardOpen(false)
    toast.success(t('hr.mukofotJarimalar.toasts.rewardSuccess'))
    await fetchData()
  }

  async function savePenalty() {
    if (!penaltyForm.employeeId || !penaltyForm.typeId || !penaltyForm.amount || !penaltyForm.reason.trim()) {
      toast.error(t('hr.mukofotJarimalar.toasts.requiredError'))
      return
    }
    const emp = employees.find(e => e.id === penaltyForm.employeeId)
    const type = penaltyTypes.find(pt => pt.id === penaltyForm.typeId)
    if (!emp || !type) return
    setSavingPenalty(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setSavingPenalty(false); toast.error(t('common.error')); return }
    const { error } = await supabase.from('reward_penalty_entries').insert({
      company_id: companyId,
      employee_id: emp.id,
      employee_name: `${emp.firstName} ${emp.lastName}`,
      department_name: emp.departmentName,
      type: 'penalty',
      type_id: type.id,
      type_name: type.name,
      amount: Number(penaltyForm.amount),
      date: penaltyForm.date || new Date().toISOString().split('T')[0],
      note: penaltyForm.reason,
    })
    setSavingPenalty(false)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    setIsPenaltyOpen(false)
    toast.success(t('hr.mukofotJarimalar.toasts.penaltySuccess'))
    await fetchData()
  }

  const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  if (isOwner === null || !isOwner) return null

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('hr.mukofotJarimalar.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('hr.mukofotJarimalar.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={openReward}
            className="flex items-center gap-2 rounded-lg bg-green-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-green-700 transition-colors"
          >
            <Gift className="h-3.5 w-3.5" />
            {t('hr.mukofotJarimalar.giveReward')}
          </button>
          <button
            onClick={openPenalty}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-red-700 transition-colors"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            {t('hr.mukofotJarimalar.givePenalty')}
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title={t('hr.mukofotJarimalar.stats.totalRewards')} value={formatPrice(stats.totalRewards)} />
        <StatCard title={t('hr.mukofotJarimalar.stats.totalPenalties')} value={formatPrice(stats.totalPenalties)} />
        <StatCard title={t('hr.mukofotJarimalar.stats.netPayment')} value={formatPrice(stats.net)} icon={<Wallet className="h-4 w-4" />} />
        <StatCard title={t('hr.mukofotJarimalar.stats.thisMonth')} value={formatPrice(stats.thisMonth)} icon={<CalendarDays className="h-4 w-4" />} />
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1.5">
          {([
            ['today', t('hr.mukofotJarimalar.filters.periodToday')],
            ['week', t('hr.mukofotJarimalar.filters.periodWeek')],
            ['month', t('hr.mukofotJarimalar.filters.periodMonth')],
            ['custom', t('hr.mukofotJarimalar.filters.periodCustom')],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => { setPeriod(key); setPage(1) }}
              className={`px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                period === key
                  ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-[180px]">
          <SearchSelect
            options={[{ value: 'all', label: t('hr.mukofotJarimalar.filters.allEmployees') }, ...employeeOptions]}
            value={employeeFilter}
            onChange={v => { setEmployeeFilter(v); setPage(1) }}
            placeholder={t('hr.mukofotJarimalar.filters.allEmployees')}
          />
        </div>
        <div className="flex gap-1.5">
          {([
            ['all', t('hr.mukofotJarimalar.filters.typeAll')],
            ['reward', t('hr.mukofotJarimalar.filters.typeReward')],
            ['penalty', t('hr.mukofotJarimalar.filters.typePenalty')],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => { setTypeFilter(key); setPage(1) }}
              className={`px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                typeFilter === key
                  ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t('hr.mukofotJarimalar.table.number')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.mukofotJarimalar.table.date')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.mukofotJarimalar.table.employee')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">{t('hr.mukofotJarimalar.table.department')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.mukofotJarimalar.table.type')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.mukofotJarimalar.table.name')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('hr.mukofotJarimalar.table.amount')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">{t('hr.mukofotJarimalar.table.note')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('hr.mukofotJarimalar.notFound')}
                  </td>
                </tr>
              ) : (
                paginated.map((rp, i) => (
                  <tr
                    key={rp.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{(page - 1) * ITEMS_PER_PAGE + i + 1}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{formatDate(rp.date)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{rp.employeeName}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell">{rp.departmentName}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${rp.type === 'reward' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${rp.type === 'reward' ? 'bg-green-500' : 'bg-red-500'}`} />
                        {rp.type === 'reward' ? t('hr.mukofotJarimalar.filters.typeReward') : t('hr.mukofotJarimalar.filters.typePenalty')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{rp.typeName}</td>
                    <td className={`px-4 py-3 text-sm text-right font-semibold tabular-nums ${rp.type === 'reward' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {rp.type === 'reward' ? '+' : '-'}{formatPrice(rp.amount)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell max-w-xs truncate">{rp.note || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={filtered.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setPage}
        />
      </div>

      {/* Give Reward Modal */}
      <Dialog open={isRewardOpen} onOpenChange={setIsRewardOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gift className="h-4 w-4 text-green-600" />
              {t('hr.mukofotJarimalar.modal.rewardTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.employeeLabel')}</label>
              <SearchSelect
                options={employeeOptions}
                value={rewardForm.employeeId}
                onChange={v => setRewardForm(f => ({ ...f, employeeId: v, amount: computeAmount(v, f.typeId, rewardTypes) || f.amount }))}
                placeholder={t('hr.mukofotJarimalar.modal.employeePlaceholder')}
                focusRingClassName="focus:border-green-400 focus:ring-green-100 dark:focus:ring-green-900/40"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.typeLabel')}</label>
              <SearchSelect
                options={rewardTypeOptions}
                value={rewardForm.typeId}
                onChange={v => setRewardForm(f => ({ ...f, typeId: v, amount: computeAmount(f.employeeId, v, rewardTypes) || f.amount }))}
                placeholder={t('hr.mukofotJarimalar.modal.typePlaceholder')}
                focusRingClassName="focus:border-green-400 focus:ring-green-100 dark:focus:ring-green-900/40"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.amountLabel')}</label>
              <input
                type="number"
                value={rewardForm.amount}
                onChange={e => setRewardForm(f => ({ ...f, amount: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.dateLabel')}</label>
              <input
                type="date"
                value={rewardForm.date}
                onChange={e => setRewardForm(f => ({ ...f, date: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.noteLabel')}</label>
              <textarea
                value={rewardForm.note}
                onChange={e => setRewardForm(f => ({ ...f, note: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-green-400 focus:ring-2 focus:ring-green-100 dark:focus:ring-green-900/40 resize-none transition-colors"
                placeholder={t('hr.mukofotJarimalar.modal.notePlaceholder')}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsRewardOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveReward} disabled={savingReward} className="bg-green-600 text-white hover:bg-green-700">{savingReward ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Give Penalty Modal */}
      <Dialog open={isPenaltyOpen} onOpenChange={setIsPenaltyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-red-600" />
              {t('hr.mukofotJarimalar.modal.penaltyTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.employeeLabel')}</label>
              <SearchSelect
                options={employeeOptions}
                value={penaltyForm.employeeId}
                onChange={v => setPenaltyForm(f => ({ ...f, employeeId: v, amount: computeAmount(v, f.typeId, penaltyTypes) || f.amount }))}
                placeholder={t('hr.mukofotJarimalar.modal.employeePlaceholder')}
                focusRingClassName="focus:border-red-400 focus:ring-red-100 dark:focus:ring-red-900/40"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.typeLabel')}</label>
              <SearchSelect
                options={penaltyTypeOptions}
                value={penaltyForm.typeId}
                onChange={v => setPenaltyForm(f => ({ ...f, typeId: v, amount: computeAmount(f.employeeId, v, penaltyTypes) || f.amount }))}
                placeholder={t('hr.mukofotJarimalar.modal.typePlaceholder')}
                focusRingClassName="focus:border-red-400 focus:ring-red-100 dark:focus:ring-red-900/40"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.amountLabel')}</label>
              <input
                type="number"
                value={penaltyForm.amount}
                onChange={e => setPenaltyForm(f => ({ ...f, amount: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.dateLabel')}</label>
              <input
                type="date"
                value={penaltyForm.date}
                onChange={e => setPenaltyForm(f => ({ ...f, date: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.mukofotJarimalar.modal.reasonLabel')}</label>
              <textarea
                value={penaltyForm.reason}
                onChange={e => setPenaltyForm(f => ({ ...f, reason: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:ring-red-900/40 resize-none transition-colors"
                placeholder={t('hr.mukofotJarimalar.modal.reasonPlaceholder')}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsPenaltyOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={savePenalty} disabled={savingPenalty} className="bg-red-600 text-white hover:bg-red-700">{savingPenalty ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
