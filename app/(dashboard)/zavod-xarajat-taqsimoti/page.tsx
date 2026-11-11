'use client'

// "Xarajat taqsimoti": monthly overhead cost pools (labour, energy, ...) and
// their allocation to the month's posted production outputs (migration
// 20261110000018). Owner / admin only: proxy.ts (OWNER_ADMIN_PATHS +
// 'prod_stock') redirects everyone else and the RPCs re-check. Writes go
// through prod_save_cost_pool / prod_cancel_cost_pool / prod_allocate_overhead
// only. Lots are NOT revalued: stock stays at material cost, the pool is a
// period expense in the P&L; the allocation feeds the full-cost report.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Ban, Lock, Pencil, PieChart, Plus } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  FilterBar, NoteField, PageHeader, Segmented, TableCard, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls,
  tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { ControlHint, useApprovalRetry, useControls, useRole } from '@/components/production/ControlKit'
import { AcctNote, useAccounting } from '@/components/production/AccountingKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { fillText, isOwnerAdminRole, monthEndYmd, todayYmd } from '@/lib/production-controls'
import { formatQty, rangeToIsoBounds, round2, unitKey } from '@/lib/production'
import { toKg } from '@/lib/production-reports'
import {
  OVERHEAD_METHODS, POOL_CATEGORIES, acctErrorText, fetchAllocations, fetchCostPools, fetchMonthOutputs, fetchPoolSuggestions,
  fetchProductCosts, monthStart, overheadMethodKey, poolCategoryKey,
  type CostPool, type MonthOutput, type OverheadAllocation, type OverheadMethod, type PoolCategory, type PoolSuggestion, type ProductCostRow,
} from '@/lib/production-accounting'

type View = 'production' | 'product'
interface ExpenseCategory { id: string; name: string }
interface PoolPreset { category: PoolCategory; amount: number; expenseCategoryId: string | null }

/** Best guess of the pool category from an expense category name (uz / ru / en). */
function guessCategory(name: string): PoolCategory {
  const n = name.toLowerCase()
  if (/elektr|электр|energ|свет/.test(n)) return 'energy'
  if (/gaz|газ/.test(n)) return 'gas'
  if (/suv|вода|водо|water/.test(n)) return 'water'
  if (/ijara|аренд|rent/.test(n)) return 'rent'
  if (/maosh|ish haq|зарплат|оклад|salary|wage|labou?r/.test(n)) return 'labour'
  if (/amortiz|аморт|depreci/.test(n)) return 'depreciation'
  if (/ta.?mir|ремонт|repair/.test(n)) return 'repair'
  return 'other'
}

const amountText = (v: string) => {
  const n = Number(v.replace(',', '.').replace(/\s/g, ''))
  return v.trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 100) / 100
}

export default function CostPoolsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const role = useRole()
  const allowed = isOwnerAdminRole(role)
  const accounting = useAccounting()
  const controls = useControls()
  const { itemById } = useProdRefs()
  const approval = useApprovalRetry()

  const [month, setMonth] = useState('')
  const [pools, setPools] = useState<CostPool[]>([])
  const [suggestions, setSuggestions] = useState<PoolSuggestion[]>([])
  const [allocs, setAllocs] = useState<OverheadAllocation[]>([])
  const [outputs, setOutputs] = useState<MonthOutput[]>([])
  const [costs, setCosts] = useState<ProductCostRow[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [method, setMethod] = useState<OverheadMethod | null>(null)
  const [manual, setManual] = useState<Record<string, string>>({})
  const [view, setView] = useState<View>('production')
  const [dialog, setDialog] = useState<{ pool: CostPool | null; preset: PoolPreset | null } | null>(null)
  const [allocating, setAllocating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Client clock only (avoids a hydration mismatch).
  useEffect(() => { setMonth(todayYmd().slice(0, 7)) }, [])

  const period = month ? monthStart(month) : ''
  const effMethod: OverheadMethod = method ?? accounting.settings.overheadMethod

  const load = useCallback(async () => {
    if (!period) return
    setLoading(true)
    const supabase = createClient()
    const { fromIso, toIso } = rangeToIsoBounds({ from: period, to: monthEndYmd(period.slice(0, 7)) })
    const [p, s, a, o, c, cats] = await Promise.all([
      fetchCostPools(supabase, period),
      fetchPoolSuggestions(supabase, period),
      fetchAllocations(supabase, period),
      fetchMonthOutputs(supabase, fromIso, toIso),
      fetchProductCosts(supabase, { month: period }),
      supabase.from('expense_categories').select('id, name').order('name'),
    ])
    setPools(p ?? [])
    setSuggestions(s)
    setAllocs(a)
    setOutputs(o)
    setCosts(c ?? [])
    setCategories((cats.data ?? []) as ExpenseCategory[])
    setManual({})
    setLoading(false)
  }, [period])

  useEffect(() => {
    if (!allowed || !accounting.available) return
    load()
  }, [load, allowed, accounting.available])

  const posted = useMemo(() => pools.filter(p => p.status === 'posted'), [pools])
  const poolTotal = round2(posted.reduce((s, p) => s + p.amount, 0))
  const allocated = round2(allocs.reduce((s, a) => s + a.amount, 0))
  const hasAlloc = allocs.length > 0
  const outdated = hasAlloc ? round2(allocs[0].poolTotal) !== poolTotal : poolTotal > 0
  const today = todayYmd()
  const closed = !!controls.lock.lockedUntil && !!period && controls.lock.lockedUntil >= period
  const future = !!period && period > today
  const readOnly = closed || future
  const catName = useMemo(() => new Map(categories.map(c => [c.id, c.name])), [categories])
  const openSuggestions = suggestions.filter(s => !s.pooled && s.amount > 0)
  const outputById = useMemo(() => new Map(outputs.map(o => [o.id, o])), [outputs])

  const manualSum = round2(outputs.reduce((s, o) => s + (amountText(manual[o.id] ?? '') ?? 0), 0))
  const manualLeft = round2(poolTotal - manualSum)

  async function allocate() {
    if (!period || allocating) return
    if (effMethod === 'manual' && manualLeft !== 0) { toast.error(t('prodAcct.errors.allocations_sum')); return }
    setAllocating(true)
    const allocations = effMethod === 'manual'
      ? outputs.map(o => ({ output_id: o.id, amount: amountText(manual[o.id] ?? '') ?? 0 })).filter(a => a.amount > 0)
      : undefined
    const res = await approval.run(ctl => createClient().rpc('prod_allocate_overhead', {
      p_month: period,
      p_ctl: { method: effMethod, ...(allocations ? { allocations } : {}), ...ctl },
    }))
    setAllocating(false)
    if (!res) return
    if (res.error) { toast.error(acctErrorText(t, res.error)); return }
    const d = (res.data ?? {}) as { rows?: number; allocated?: number; skipped?: number }
    toast.success(fillText(t('prodAcct.pools.allocatedToast'), { rows: d.rows ?? 0, amount: formatPrice(Number(d.allocated ?? 0)) })
      + (d.skipped ? ` · ${fillText(t('prodAcct.pools.skipped'), { n: d.skipped })}` : ''))
    load()
  }

  async function cancelPool(p: CostPool) {
    if (!window.confirm(t('prodAcct.pools.cancelConfirm'))) return
    setBusyId(p.id)
    const res = await approval.run(() => createClient().rpc('prod_cancel_cost_pool', { p_id: p.id }))
    setBusyId(null)
    if (!res) return
    if (res.error) { toast.error(acctErrorText(t, res.error)); return }
    toast.success(t('prodAcct.pools.cancelled'))
    if ((res.data as { allocation_cleared?: boolean } | null)?.allocation_cleared) toast.info(t('prodAcct.pools.allocationCleared'))
    load()
  }

  if (!allowed || (!accounting.loading && !accounting.available)) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('prodAcct.pools.title')} />
        <AcctNote text={!allowed ? t('prodAcct.ownerAdminOnly') : t('prodAcct.notAvailable')} />
      </div>
    )
  }

  const baseText = (a: OverheadAllocation) => {
    if (a.method === 'per_kg') return `${formatQty(a.base)} ${t('production.units.kg')}`
    return formatPrice(a.base)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodAcct.pools.title')}
        subtitle={t('prodAcct.pools.subtitle')}
        actionLabel={readOnly ? undefined : t('prodAcct.pools.new')}
        onAction={readOnly ? undefined : () => setDialog({ pool: null, preset: null })}
      />

      <FilterBar>
        <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-gray-400">
          <span>{t('prodAcct.pools.month')}</span>
          <input type="month" value={month} max={today.slice(0, 7)} onChange={e => e.target.value && setMonth(e.target.value)} className={cn(prodFieldCls, 'w-44')} />
        </label>
        <Segmented<OverheadMethod>
          value={effMethod}
          onChange={setMethod}
          options={OVERHEAD_METHODS.map(m => ({ value: m, label: t(overheadMethodKey(m)) }))}
        />
        {!readOnly && (
          <Button onClick={allocate} loading={allocating} disabled={allocating || poolTotal <= 0 || loading}>
            <PieChart className="h-3.5 w-3.5" /> {hasAlloc ? t('prodAcct.pools.reallocate') : t('prodAcct.pools.allocate')}
          </Button>
        )}
      </FilterBar>

      {closed && (
        <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400">
          <Lock className="h-3.5 w-3.5" /> {t('prodAcct.pools.closed')}
        </div>
      )}
      {!readOnly && !loading && poolTotal > 0 && outdated && (
        <ControlHint>{hasAlloc ? t('prodAcct.pools.needsRerun') : t('prodAcct.pools.notAllocated')}</ControlHint>
      )}

      <TableCard loading={loading || accounting.loading} empty={posted.length === 0 && openSuggestions.length === 0} emptyText={t('prodAcct.pools.empty')} emptyIcon={PieChart}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('prodAcct.pools.category')}</th>
              <th className={thCls}>{t('prodAcct.pools.expenseCategory')}</th>
              <th className={thCls}>{t('production.common.note')}</th>
              <th className={thCls}>{t('production.common.author')}</th>
              <th className={thRightCls}>{t('prodAcct.pools.amount')}</th>
              <th className={cn(thCls, 'w-20')} />
            </tr>
          </thead>
          <tbody>
            {posted.map(p => (
              <tr key={p.id} className={trCls}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{t(poolCategoryKey(p.category))}</td>
                <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{p.expenseCategoryId ? catName.get(p.expenseCategoryId) ?? '—' : '—'}</td>
                <td className={cn(tdCls, 'max-w-xs truncate text-gray-500 dark:text-gray-400')} title={p.note}>{p.note || '—'}</td>
                <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{p.createdByName || '—'}</td>
                <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(p.amount)}</td>
                <td className={tdCls}>
                  {!readOnly && (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setDialog({ pool: p, preset: null })}
                        title={t('prodAcct.pools.edit')}
                        aria-label={t('prodAcct.pools.edit')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => cancelPool(p)}
                        disabled={busyId === p.id}
                        title={t('prodAcct.pools.cancel')}
                        aria-label={t('prodAcct.pools.cancel')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors"
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!readOnly && openSuggestions.map(s => (
              <tr key={`s:${s.expenseCategoryId ?? 'none'}`} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 bg-gray-50/60 dark:bg-gray-800/30">
                <td colSpan={4} className={cn(tdCls, 'text-[13px] text-gray-500 dark:text-gray-400')}>
                  {fillText(t('prodAcct.pools.suggestionLine'), { name: s.name || t('prodAcct.pools.noCategory'), amount: formatPrice(s.amount) })}
                  <span className="ml-1.5 text-[11px] text-gray-400 dark:text-gray-500">({fillText(t('prodAcct.pools.suggestionDocs'), { n: s.docCount })})</span>
                </td>
                <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(s.amount)}</td>
                <td className={cn(tdCls, 'text-right')}>
                  <button
                    type="button"
                    onClick={() => setDialog({ pool: null, preset: { category: guessCategory(s.name), amount: s.amount, expenseCategoryId: s.expenseCategoryId } })}
                    className="inline-flex items-center gap-1 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" /> {t('prodAcct.pools.addSuggestion')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
              <td colSpan={4} className="px-4 py-3">{t('prodAcct.pools.total')}</td>
              <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(poolTotal)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </TableCard>

      {!readOnly && effMethod === 'manual' && !loading && outputs.length > 0 && poolTotal > 0 && (
        <div className={cn(prodCardCls, 'overflow-hidden')}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodAcct.pools.manualTitle')}</h2>
            <span className={cn('text-[13px] tabular-nums', manualLeft === 0 ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400')}>
              {fillText(t('prodAcct.pools.manualLeft'), { amount: formatPrice(manualLeft) })}
            </span>
          </div>
          <p className="border-b border-gray-50 dark:border-gray-800/60 px-4 py-2 text-[12px] text-gray-500 dark:text-gray-400">{t('prodAcct.pools.manualHint')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {outputs.map(o => {
                  const item = itemById.get(o.itemId)
                  return (
                    <tr key={o.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">#{o.productionNumber} · {formatDate(o.docDate)}</td>
                      <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(o.qty)} {item ? t(unitKey(item.unit)) : ''}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(o.cost)}</td>
                      <td className="px-4 py-2 w-44">
                        <input
                          inputMode="decimal"
                          value={manual[o.id] ?? ''}
                          onChange={e => setManual(prev => ({ ...prev, [o.id]: e.target.value }))}
                          placeholder="0"
                          className={cn(prodFieldCls, 'h-8 text-right tabular-nums')}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodAcct.pools.allocation')}</h2>
            {hasAlloc && (
              <p className="text-[12px] text-gray-500 dark:text-gray-400">
                {t(overheadMethodKey(allocs[0].method))} · {formatPrice(allocated)}
              </p>
            )}
          </div>
          <Segmented<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'production', label: t('prodAcct.pools.byProduction') },
              { value: 'product', label: t('prodAcct.pools.byProduct') },
            ]}
          />
        </div>
        {loading ? null : view === 'production' ? (
          !hasAlloc ? (
            <div className="flex h-24 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('prodAcct.pools.notAllocatedShort')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className={thCls}>{t('prodAcct.pools.production')}</th>
                    <th className={thCls}>{t('production.common.item')}</th>
                    <th className={thRightCls}>{t('production.common.qty')}</th>
                    <th className={thRightCls}>{t('prodAcct.pools.base')}</th>
                    <th className={thRightCls}>{t('prodAcct.pools.overhead')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allocs.map(a => {
                    const o = outputById.get(a.outputId)
                    const item = itemById.get(a.itemId)
                    return (
                      <tr key={a.outputId} className={trCls}>
                        <td className={tdCls}>
                          <Link href={`/ishlab-chiqarish/${a.productionId}`} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
                            #{o?.productionNumber ?? '—'}
                          </Link>
                          {o?.docDate && <span className="ml-2 text-[12px] text-gray-400 dark:text-gray-500">{formatDate(o.docDate)}</span>}
                        </td>
                        <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{item?.name ?? '—'}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{o ? `${formatQty(o.qty)} ${item ? t(unitKey(item.unit)) : ''}` : '—'}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{baseText(a)}</td>
                        <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(a.amount)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    <td colSpan={4} className="px-4 py-3">{t('production.common.total')}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(allocated)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        ) : costs.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('prodReports.common.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.item')}</th>
                  <th className={thRightCls}>{t('production.common.qty')}</th>
                  <th className={thRightCls}>{t('prodAcct.costReport.material')}</th>
                  <th className={thRightCls}>{t('prodAcct.pools.overhead')}</th>
                  <th className={thRightCls}>{t('prodAcct.costReport.full')}</th>
                  <th className={thRightCls}>{t('prodAcct.costReport.fullUnit')}</th>
                </tr>
              </thead>
              <tbody>
                {costs.map(c => {
                  const item = itemById.get(c.itemId)
                  const kg = item ? toKg(c.qty, item) : null
                  return (
                    <tr key={c.itemId} className={trCls}>
                      <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{item?.name ?? c.itemName}</td>
                      <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')} title={kg !== null ? `${formatQty(kg)} ${t('production.units.kg')}` : undefined}>
                        {formatQty(c.qty)} {c.itemUnit ? t(unitKey(c.itemUnit)) : ''}
                      </td>
                      <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(c.materialCost)}</td>
                      <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(c.overhead)}</td>
                      <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(c.fullCost)}</td>
                      <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{c.fullUnitCost === null ? '—' : formatPrice(c.fullUnitCost)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodAcct.pools.inventoryNote')}</p>

      <PoolDialog
        open={dialog !== null}
        pool={dialog?.pool ?? null}
        preset={dialog?.preset ?? null}
        period={period}
        categories={categories}
        onClose={() => setDialog(null)}
        onSaved={cleared => {
          setDialog(null)
          if (cleared) toast.info(t('prodAcct.pools.allocationCleared'))
          load()
        }}
      />
      {approval.dialog}
    </div>
  )
}

function PoolDialog({ open, pool, preset, period, categories, onClose, onSaved }: {
  open: boolean
  pool: CostPool | null
  preset: PoolPreset | null
  period: string
  categories: ExpenseCategory[]
  onClose: () => void
  onSaved: (allocationCleared: boolean) => void
}) {
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const [category, setCategory] = useState<PoolCategory>('other')
  const [amount, setAmount] = useState('')
  const [expenseCategoryId, setExpenseCategoryId] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setCategory(((pool?.category ?? preset?.category ?? 'other') as PoolCategory))
    setAmount(pool ? String(pool.amount) : preset ? String(preset.amount) : '')
    setExpenseCategoryId(pool?.expenseCategoryId ?? preset?.expenseCategoryId ?? '')
    setNote(pool?.note ?? '')
  }, [open, pool, preset])

  const amountNum = amountText(amount)
  const valid = amountNum !== null && amountNum > 0 && !!period

  async function save() {
    if (!valid || saving) return
    setSaving(true)
    const res = await approval.run(ctl => createClient().rpc('prod_save_cost_pool', {
      p_id: pool?.id ?? null,
      p_data: {
        ...ctl,
        period: pool?.period ?? period,
        category,
        amount: amountNum,
        expense_category_id: expenseCategoryId || null,
        note: note.trim() || null,
      },
    }))
    setSaving(false)
    if (!res) return
    if (res.error) { toast.error(acctErrorText(t, res.error)); return }
    toast.success(t('prodAcct.pools.saved'))
    onSaved(!!(res.data as { allocation_cleared?: boolean } | null)?.allocation_cleared)
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !saving) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{pool ? t('prodAcct.pools.edit') : t('prodAcct.pools.new')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={e => { e.preventDefault(); save() }}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save() } }}
        >
          <label className="block">
            <span className={prodLabelCls}>{t('prodAcct.pools.category')}</span>
            <select value={category} onChange={e => setCategory(e.target.value as PoolCategory)} className={prodFieldCls}>
              {POOL_CATEGORIES.map(c => <option key={c} value={c}>{t(poolCategoryKey(c))}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodAcct.pools.amount')}</span>
            <input
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              className={cn(prodFieldCls, 'text-right tabular-nums', amount.trim() !== '' && !valid && 'border-red-300 dark:border-red-500/50')}
            />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodAcct.pools.expenseCategory')}</span>
            <select value={expenseCategoryId} onChange={e => setExpenseCategoryId(e.target.value)} className={prodFieldCls}>
              <option value="">{t('prodAcct.pools.none')}</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodAcct.pools.expenseCategoryHint')}</span>
          </label>
          <NoteField value={note} onChange={setNote} />
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
        <DialogFooter className="mt-2">
          <button type="button" onClick={onClose} disabled={saving} className={secondaryBtnCls}>{t('production.common.cancel')}</button>
          <Button onClick={save} loading={saving} disabled={saving || !valid}>{t('production.common.save')}</Button>
        </DialogFooter>
        {approval.dialog}
      </DialogContent>
    </Dialog>
  )
}
