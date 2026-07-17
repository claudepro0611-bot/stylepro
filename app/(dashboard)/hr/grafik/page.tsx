'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTheme } from 'next-themes'
import {
  ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { Wallet, Trophy, Activity, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { StatCard } from '@/components/ui/StatCard'
import { createClient } from '@/lib/supabase/client'
import { formatDate } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { RewardPenaltyEntry } from '@/lib/types'
import type { TranslationKey } from '@/lib/i18n/translations'

interface EmployeeLite {
  id: string
  firstName: string
  lastName: string
  departmentName: string
}

interface DepartmentLite {
  id: string
  name: string
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

type Period = 'week' | 'month' | 'year' | 'custom'
type DisplayFilter = 'reward' | 'penalty' | 'both'

const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

function toDateStr(d: Date) {
  return d.toISOString().split('T')[0]
}

interface ChartPoint {
  label: string
  tooltipLabel: string
  reward: number
  penalty: number
}

function ChartTooltip({ active, payload, t, formatPrice }: {
  active?: boolean
  payload?: { payload: ChartPoint }[]
  t: (key: TranslationKey) => string
  formatPrice: (amount: number) => string
}) {
  if (!active || !payload?.[0]) return null
  const point = payload[0].payload
  const net = point.reward - point.penalty
  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg px-3 py-2.5 min-w-[190px]">
      <p className="text-[12px] font-semibold text-gray-900 dark:text-gray-100 mb-1.5">{point.tooltipLabel}</p>
      <div className="flex items-center justify-between gap-3 text-[12px] text-gray-600 dark:text-gray-300 py-0.5">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#10B981] shrink-0" />{t('hr.grafik.chart.legendReward')}</span>
        <span className="tabular-nums font-medium">{formatPrice(point.reward)}</span>
      </div>
      <div className="flex items-center justify-between gap-3 text-[12px] text-gray-600 dark:text-gray-300 py-0.5">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#EF4444] shrink-0" />{t('hr.grafik.chart.legendPenalty')}</span>
        <span className="tabular-nums font-medium">{formatPrice(point.penalty)}</span>
      </div>
      <div className="flex items-center justify-between gap-3 text-[12px] mt-1 pt-1.5 border-t border-gray-100 dark:border-gray-700">
        <span className="text-gray-500 dark:text-gray-400">{t('hr.grafik.chart.tooltipNet')}</span>
        <span className={`tabular-nums font-semibold ${net >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {net >= 0 ? '+' : ''}{formatPrice(net)}
        </span>
      </div>
    </div>
  )
}

export default function GrafikPage() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = mounted && resolvedTheme === 'dark'

  const [employees, setEmployees] = useState<EmployeeLite[]>([])
  const [departments, setDepartments] = useState<DepartmentLite[]>([])
  const [entries, setEntries] = useState<RewardPenaltyEntry[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [
      { data: empRows, error: empError },
      { data: deptRows, error: deptError },
      { data: entryRows, error: entryError },
    ] = await Promise.all([
      supabase.from('employees_safe').select('id, first_name, last_name, department_name'),
      supabase.from('departments').select('id, name').order('name'),
      supabase.from('reward_penalty_entries').select('*').order('date', { ascending: false }),
    ])

    if (empError || deptError || entryError) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }

    setEmployees((empRows as { id: string; first_name: string; last_name: string; department_name: string | null }[]).map(e => ({
      id: e.id, firstName: e.first_name, lastName: e.last_name, departmentName: e.department_name ?? '',
    })))
    setDepartments(deptRows as DepartmentLite[])
    setEntries((entryRows as RewardPenaltyRow[]).map(mapEntry))
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const [period, setPeriod] = useState<Period>('month')
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 29)
    return toDateStr(d)
  })
  const [endDate, setEndDate] = useState(() => toDateStr(new Date()))
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [employeeFilter, setEmployeeFilter] = useState('all')
  const [displayFilter, setDisplayFilter] = useState<DisplayFilter>('both')

  const axisTick = { fill: isDark ? '#6B7280' : '#9CA3AF', fontSize: 11 }
  const gridProps = { strokeDasharray: '3 3', stroke: isDark ? '#374151' : '#F3F4F6', vertical: false } as const
  const cursorLine = isDark ? '#374151' : '#E5E7EB'

  const employeeOptions = useMemo(() => [
    { value: 'all', label: t('hr.grafik.filters.allEmployees') },
    ...employees.map(e => ({ value: e.id, label: `${e.firstName} ${e.lastName}`, sublabel: e.departmentName })),
  ], [employees, t])

  const scopedEntries = useMemo(() =>
    entries.filter(e =>
      (departmentFilter === 'all' || e.departmentName === departmentFilter) &&
      (employeeFilter === 'all' || e.employeeId === employeeFilter),
    ),
    [entries, departmentFilter, employeeFilter],
  )

  const dateRange = useMemo(() => {
    const now = new Date()
    if (period === 'week') {
      const day = now.getDay()
      const diffToMonday = day === 0 ? -6 : 1 - day
      const monday = new Date(now); monday.setDate(now.getDate() + diffToMonday)
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
      return { start: monday, end: sunday }
    }
    if (period === 'year') {
      return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear(), 11, 31) }
    }
    if (period === 'custom') {
      return { start: new Date(startDate), end: new Date(endDate) }
    }
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 0) }
  }, [period, startDate, endDate])

  const periodEntries = useMemo(() => {
    const start = toDateStr(dateRange.start)
    const end = toDateStr(dateRange.end)
    return scopedEntries.filter(e => e.date >= start && e.date <= end)
  }, [scopedEntries, dateRange])

  const { chartData, xTicks } = useMemo(() => {
    const sumFor = (predicate: (e: RewardPenaltyEntry) => boolean, type: 'reward' | 'penalty') =>
      periodEntries.filter(e => e.type === type && predicate(e)).reduce((s, e) => s + e.amount, 0)

    if (period === 'week') {
      const data: ChartPoint[] = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(dateRange.start); d.setDate(dateRange.start.getDate() + i)
        const ds = toDateStr(d)
        return {
          label: t(`dashboard.weekdaysShort.${WEEKDAY_KEYS[i]}`),
          tooltipLabel: formatDate(ds),
          reward: sumFor(e => e.date === ds, 'reward'),
          penalty: sumFor(e => e.date === ds, 'penalty'),
        }
      })
      return { chartData: data, xTicks: undefined as string[] | undefined }
    }

    if (period === 'year') {
      const year = dateRange.start.getFullYear()
      const data: ChartPoint[] = MONTH_KEYS.map((key, m) => ({
        label: t(`dashboard.monthsShort.${key}`),
        tooltipLabel: `${t(`dashboard.monthsShort.${key}`)} ${year}`,
        reward: sumFor(e => { const d = new Date(e.date); return d.getFullYear() === year && d.getMonth() === m }, 'reward'),
        penalty: sumFor(e => { const d = new Date(e.date); return d.getFullYear() === year && d.getMonth() === m }, 'penalty'),
      }))
      return { chartData: data, xTicks: undefined as string[] | undefined }
    }

    const dayCount = Math.max(1, Math.round((dateRange.end.getTime() - dateRange.start.getTime()) / 86400000) + 1)

    if (dayCount <= 62) {
      const data: ChartPoint[] = Array.from({ length: dayCount }, (_, i) => {
        const d = new Date(dateRange.start); d.setDate(dateRange.start.getDate() + i)
        const ds = toDateStr(d)
        return {
          label: String(d.getDate()),
          tooltipLabel: formatDate(ds),
          reward: sumFor(e => e.date === ds, 'reward'),
          penalty: sumFor(e => e.date === ds, 'penalty'),
        }
      })
      let ticks: string[] | undefined
      if (period === 'month') {
        const lastDay = new Date(dateRange.end).getDate()
        ticks = Array.from(new Set([1, 5, 10, 15, 20, 25, lastDay])).map(String)
      }
      return { chartData: data, xTicks: ticks }
    }

    const data: ChartPoint[] = []
    const cursor = new Date(dateRange.start.getFullYear(), dateRange.start.getMonth(), 1)
    while (cursor <= dateRange.end) {
      const y = cursor.getFullYear()
      const m = cursor.getMonth()
      data.push({
        label: t(`dashboard.monthsShort.${MONTH_KEYS[m]}`),
        tooltipLabel: `${t(`dashboard.monthsShort.${MONTH_KEYS[m]}`)} ${y}`,
        reward: sumFor(e => { const d = new Date(e.date); return d.getFullYear() === y && d.getMonth() === m }, 'reward'),
        penalty: sumFor(e => { const d = new Date(e.date); return d.getFullYear() === y && d.getMonth() === m }, 'penalty'),
      })
      cursor.setMonth(cursor.getMonth() + 1)
    }
    return { chartData: data, xTicks: undefined as string[] | undefined }
  }, [period, periodEntries, dateRange, t])

  const stats = useMemo(() => {
    const totalRewards = periodEntries.filter(e => e.type === 'reward').reduce((s, e) => s + e.amount, 0)
    const totalPenalties = periodEntries.filter(e => e.type === 'penalty').reduce((s, e) => s + e.amount, 0)
    return { totalRewards, totalPenalties, net: totalRewards - totalPenalties }
  }, [periodEntries])

  function topList(type: 'reward' | 'penalty') {
    const map = new Map<string, { employeeId: string; employeeName: string; departmentName: string; total: number }>()
    periodEntries.filter(e => e.type === type).forEach(e => {
      const cur = map.get(e.employeeId) ?? { employeeId: e.employeeId, employeeName: e.employeeName, departmentName: e.departmentName, total: 0 }
      cur.total += e.amount
      map.set(e.employeeId, cur)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, 5)
  }

  const topRewards = useMemo(() => topList('reward'), [periodEntries])
  const topPenalties = useMemo(() => topList('penalty'), [periodEntries])
  const maxReward = Math.max(1, ...topRewards.map(r => r.total))
  const maxPenalty = Math.max(1, ...topPenalties.map(r => r.total))
  const topEmployeeName = topRewards[0]?.employeeName ?? t('hr.grafik.noData')

  const inputCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
  const tabBtnCls = (active: boolean) => `px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
  }`

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('hr.grafik.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('hr.grafik.subtitle')}</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title={t('hr.grafik.stats.totalRewards')} value={formatPrice(stats.totalRewards)} />
        <StatCard title={t('hr.grafik.stats.totalPenalties')} value={formatPrice(stats.totalPenalties)} />
        <StatCard title={t('hr.grafik.stats.netAddition')} value={formatPrice(stats.net)} icon={<Wallet className="h-4 w-4" />} />
        <StatCard title={t('hr.grafik.stats.topEmployee')} value={topEmployeeName} icon={<Trophy className="h-4 w-4" />} />
      </div>

      {/* Filter bar */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 transition-colors">
        <div className="flex flex-wrap items-center gap-3">
          {/* Period tabs */}
          <div className="flex gap-1.5">
            {([
              ['week', t('hr.grafik.filters.periodWeek')],
              ['month', t('hr.grafik.filters.periodMonth')],
              ['year', t('hr.grafik.filters.periodYear')],
              ['custom', t('hr.grafik.filters.periodCustom')],
            ] as const).map(([key, label]) => (
              <button key={key} onClick={() => setPeriod(key)} className={tabBtnCls(period === key)}>
                {label}
              </button>
            ))}
          </div>

          {/* Custom range */}
          {period === 'custom' && (
            <div className="flex items-center gap-2">
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputCls} />
              <span className="text-gray-300 dark:text-gray-600 text-sm">—</span>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className={inputCls} />
            </div>
          )}

          {/* Department dropdown */}
          <select
            value={departmentFilter}
            onChange={e => setDepartmentFilter(e.target.value)}
            className={`${inputCls} min-w-[160px]`}
          >
            <option value="all">{t('hr.grafik.filters.allDepartments')}</option>
            {departments.map(d => (
              <option key={d.id} value={d.name}>{d.name}</option>
            ))}
          </select>

          {/* Employee dropdown */}
          <div className="min-w-[200px] flex-1">
            <SearchSelect
              options={employeeOptions}
              value={employeeFilter}
              onChange={setEmployeeFilter}
              placeholder={t('hr.grafik.filters.allEmployees')}
            />
          </div>

          {/* Display toggle */}
          <div className="flex gap-1.5">
            {([
              ['reward', t('hr.grafik.filters.showReward')],
              ['penalty', t('hr.grafik.filters.showPenalty')],
              ['both', t('hr.grafik.filters.showBoth')],
            ] as const).map(([key, label]) => (
              <button key={key} onClick={() => setDisplayFilter(key)} className={tabBtnCls(displayFilter === key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main chart */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 transition-colors duration-200">
        <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-400 dark:text-gray-500">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('hr.grafik.chart.title')}</p>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">{toDateStr(dateRange.start)} — {toDateStr(dateRange.end)}</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-[12px] text-gray-500 dark:text-gray-400 shrink-0 mt-0.5">
            {(displayFilter === 'reward' || displayFilter === 'both') && (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[#10B981] shrink-0" />{t('hr.grafik.chart.legendReward')}
              </span>
            )}
            {(displayFilter === 'penalty' || displayFilter === 'both') && (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[#EF4444] shrink-0" />{t('hr.grafik.chart.legendPenalty')}
              </span>
            )}
          </div>
        </div>

        <div style={{ height: 300 }}>
          {loading ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </div>
          ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="label"
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                ticks={xTicks}
              />
              <YAxis
                tickFormatter={formatShortPrice}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                width={56}
              />
              <Tooltip content={<ChartTooltip t={t} formatPrice={formatPrice} />} cursor={{ stroke: cursorLine }} />
              {(displayFilter === 'reward' || displayFilter === 'both') && (
                <Area
                  type="monotone"
                  dataKey="reward"
                  stroke="#10B981"
                  strokeWidth={2}
                  fill="#10B981"
                  fillOpacity={0.08}
                  dot={{ r: 3, fill: '#10B981', strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                />
              )}
              {(displayFilter === 'penalty' || displayFilter === 'both') && (
                <Area
                  type="monotone"
                  dataKey="penalty"
                  stroke="#EF4444"
                  strokeWidth={2}
                  fill="#EF4444"
                  fillOpacity={0.08}
                  dot={{ r: 3, fill: '#EF4444', strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Top lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Top rewards */}
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5 transition-colors duration-200">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-100 dark:border-green-900 text-green-600 dark:text-green-400">
              <Trophy className="h-4 w-4" />
            </div>
            <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('hr.grafik.topRewards.title')}</p>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
          ) : topRewards.length === 0 ? (
            <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('hr.grafik.noEntries')}</p>
          ) : (
            <div className="space-y-3">
              {topRewards.map((item, i) => (
                <div key={item.employeeId} className="flex items-center gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{item.employeeName}</p>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{item.departmentName}</p>
                      </div>
                      <span className="text-sm font-semibold tabular-nums text-green-600 dark:text-green-400 shrink-0">{formatPrice(item.total)}</span>
                    </div>
                    <div className="h-1.5 mt-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <div className="h-full rounded-full bg-green-500" style={{ width: `${(item.total / maxReward) * 100}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top penalties */}
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5 transition-colors duration-200">
          <div className="mb-4">
            <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('hr.grafik.topPenalties.title')}</p>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
          ) : topPenalties.length === 0 ? (
            <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('hr.grafik.noEntries')}</p>
          ) : (
            <div className="space-y-3">
              {topPenalties.map((item, i) => (
                <div key={item.employeeId} className="flex items-center gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{item.employeeName}</p>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{item.departmentName}</p>
                      </div>
                      <span className="text-sm font-semibold tabular-nums text-red-600 dark:text-red-400 shrink-0">{formatPrice(item.total)}</span>
                    </div>
                    <div className="h-1.5 mt-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <div className="h-full rounded-full bg-red-500" style={{ width: `${(item.total / maxPenalty) * 100}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
