'use client'

// Daily production plan (migration 20261110000019): pick a date, list what to
// produce (product, qty, recipe = the item's active recipe), see the material
// requirements against free stock (shortages in red) and start each line in
// the production form (?plan=&item=&qty=&recipe=). Writes: prod_save_plan
// only. Before the migration the plan is kept locally and requirements are
// computed client-side from the recipes. Route guard: proxy.ts
// (ROUTE_PERMISSIONS '/zavod-reja' -> prod_production).

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, Factory, Plus, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { PageHeader, prodCardCls, prodFieldCls, tdCls, thCls, thRightCls, trCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useHasPermission } from '@/components/production/MilkKit'
import { formatQty, parseDecimal, prodErrorKey, round3, unitKey, type ProdRecipe, type ProdRpcError } from '@/lib/production'
import {
  computeRequirements, fetchPlan, fetchPlanRefs, fetchRequirementsRpc, savePlan,
  type PlanLine, type PlanRequirement, type PlanStatus,
} from '@/components/production/home/homeApi'

interface Draft { key: string; id: string; itemId: string; qty: string; recipeId: string | null; status: PlanStatus; productionId: string | null; note: string }

let seq = 0
const nextKey = () => `l${Date.now().toString(36)}${++seq}`

const pill = 'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'
const STATUS_TONE: Record<PlanStatus, string> = {
  planned: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  done: 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
  skipped: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
}

function toDraft(l: PlanLine): Draft {
  return { key: l.id || nextKey(), id: l.id, itemId: l.itemId, qty: String(l.plannedQty), recipeId: l.recipeId, status: l.status, productionId: l.productionId, note: l.note }
}

export default function ProductionPlanPage() {
  const { t } = useLanguage()
  const { profile } = useSession()
  const canProduction = useHasPermission('prod_production')
  const companyId = profile?.companyId ?? ''
  const { items, itemById, loading: refsLoading } = useProdRefs()

  const [date, setDate] = useState('')
  const [lines, setLines] = useState<Draft[]>([])
  const [server, setServer] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [recipes, setRecipes] = useState<ProdRecipe[]>([])
  const [free, setFree] = useState<Map<string, number>>(new Map())
  const [serverReq, setServerReq] = useState<PlanRequirement[] | null>(null)

  // Client clock only (avoids a hydration mismatch).
  useEffect(() => { setDate(localYmd()) }, [])

  const recipeById = useMemo(() => new Map(recipes.map(r => [r.id, r])), [recipes])
  const activeRecipeOf = useMemo(() => new Map(recipes.filter(r => r.isActive).map(r => [r.itemId, r])), [recipes])

  const load = useCallback(async () => {
    if (!date || !companyId) return
    setLoading(true)
    const [plan, refs, req] = await Promise.all([fetchPlan(companyId, date), fetchPlanRefs(date), fetchRequirementsRpc(date)])
    setServer(plan.server)
    setLines(plan.lines.map(toDraft))
    setRecipes(refs.recipes)
    setFree(refs.free)
    setServerReq(plan.server ? req : null)
    setDirty(false)
    setLoading(false)
  }, [date, companyId])

  useEffect(() => { void load() }, [load])

  function patch(key: string, p: Partial<Draft>) {
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...p } : l)))
    setDirty(true)
  }

  function addLine() {
    setLines(prev => [...prev, { key: nextKey(), id: '', itemId: '', qty: '', recipeId: null, status: 'planned', productionId: null, note: '' }])
    setDirty(true)
  }

  function removeLine(key: string) {
    setLines(prev => prev.filter(l => l.key !== key))
    setDirty(true)
  }

  const planLines: PlanLine[] = useMemo(() => lines
    .filter(l => l.itemId && parseDecimal(l.qty) > 0)
    .map(l => ({ id: l.id, itemId: l.itemId, plannedQty: round3(parseDecimal(l.qty)), recipeId: l.recipeId, status: l.status, productionId: l.productionId, note: l.note })), [lines])

  // Unsaved edits (or no server plan): requirements from the recipes, client-side.
  const requirements = useMemo(() => {
    const rows = !dirty && serverReq ? serverReq : computeRequirements(planLines, recipeById, free)
    return [...rows].sort((a, b) => (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0)
      || (itemById.get(a.itemId)?.name ?? '').localeCompare(itemById.get(b.itemId)?.name ?? ''))
  }, [dirty, serverReq, planLines, recipeById, free, itemById])
  const shortages = requirements.filter(r => r.shortage > 0).length

  const valid = lines.every(l => l.status === 'done' || (l.itemId && parseDecimal(l.qty) > 0))

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const { error } = await savePlan(companyId, date, planLines)
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error as ProdRpcError))); return }
    toast.success(t('production.common.saved'))
    await load()
  }

  const outputOptions = useMemo(() => items
    .filter(i => i.isActive && (i.itemType === 'finished' || i.itemType === 'semi'))
    .map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) })), [items, t])

  function startHref(l: Draft): string {
    const p = new URLSearchParams()
    if (server && l.id) p.set('plan', l.id)
    p.set('item', l.itemId)
    p.set('qty', String(round3(parseDecimal(l.qty))))
    if (l.recipeId) p.set('recipe', l.recipeId)
    return `/ishlab-chiqarish/yangi?${p.toString()}`
  }

  if (!canProduction) {
    return <div className={cn(prodCardCls, 'p-6 text-sm text-gray-500 dark:text-gray-400')}>{t('prodCash.dashboard.noAccess')}</div>
  }

  const busy = loading || refsLoading
  const unitOf = (itemId: string) => { const u = itemById.get(itemId)?.unit; return u ? t(unitKey(u)) : '' }

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader title={t('prodHome.plan.title')} subtitle={t('prodHome.plan.subtitle')} />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <CalendarDays className="h-4 w-4 text-gray-400" />
          <input
            type="date"
            value={date}
            onChange={e => { if (e.target.value) setDate(e.target.value) }}
            className={cn(prodFieldCls, 'w-44')}
          />
        </label>
        {!server && <span className="text-[12px] text-amber-700 dark:text-amber-400">{t('prodHome.plan.localMode')}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={addLine} disabled={busy}><Plus className="h-4 w-4" /> {t('prodHome.plan.addLine')}</Button>
          <Button onClick={save} loading={saving} disabled={busy || saving || !dirty}>{t('production.common.save')}</Button>
        </div>
      </div>

      {/* Plan lines */}
      <div className={cn(prodCardCls, 'overflow-x-auto')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800 dark:text-gray-400">
              <th className={thCls}>{t('production.common.item')}</th>
              <th className={thRightCls}>{t('production.common.qty')}</th>
              <th className={thCls}>{t('prodHome.plan.recipe')}</th>
              <th className={thCls}>{t('prodHome.plan.status')}</th>
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">{t('prodHome.common.loading')}</td></tr>
            ) : lines.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400 dark:text-gray-500">{t('prodHome.plan.empty')}</td></tr>
            ) : lines.map(l => {
              const done = l.status === 'done'
              const recipe = l.recipeId ? recipeById.get(l.recipeId) : undefined
              const canStart = !done && l.status === 'planned' && !!l.itemId && parseDecimal(l.qty) > 0 && (!server || (!dirty && !!l.id))
              return (
                <tr key={l.key} className={trCls}>
                  <td className={cn(tdCls, 'min-w-56')}>
                    {done || l.id
                      ? <span className="text-gray-900 dark:text-gray-100">{itemById.get(l.itemId)?.name ?? ''}</span>
                      : (
                        <SearchSelect
                          options={outputOptions}
                          value={l.itemId}
                          placeholder={t('prodHome.plan.pickItem')}
                          onChange={id => patch(l.key, { itemId: id, recipeId: activeRecipeOf.get(id)?.id ?? null })}
                        />
                      )}
                  </td>
                  <td className={cn(tdCls, 'text-right')}>
                    {done
                      ? <span className="tabular-nums">{formatQty(parseDecimal(l.qty))} {unitOf(l.itemId)}</span>
                      : (
                        <div className="flex items-center justify-end gap-1.5">
                          <input
                            inputMode="decimal"
                            value={l.qty}
                            onChange={e => patch(l.key, { qty: e.target.value })}
                            className={cn(prodFieldCls, 'w-28 text-right tabular-nums')}
                          />
                          <span className="w-8 text-left text-gray-400">{unitOf(l.itemId)}</span>
                        </div>
                      )}
                  </td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-600 dark:text-gray-400')}>
                    {recipe
                      ? `v${recipe.version} · ${formatQty(recipe.outputQty)} ${unitOf(l.itemId)}`
                      : l.itemId ? <span className="text-amber-700 dark:text-amber-400">{t('prodHome.plan.noRecipe')}</span> : ''}
                  </td>
                  <td className={tdCls}>
                    {done
                      ? <span className={cn(pill, STATUS_TONE.done)}>{t('prodHome.plan.statusDone')}</span>
                      : (
                        <select
                          value={l.status}
                          onChange={e => patch(l.key, { status: e.target.value as PlanStatus })}
                          className={cn(prodFieldCls, 'w-36')}
                        >
                          <option value="planned">{t('prodHome.plan.statusPlanned')}</option>
                          <option value="skipped">{t('prodHome.plan.statusSkipped')}</option>
                        </select>
                      )}
                  </td>
                  <td className={cn(tdCls, 'text-right')}>
                    <div className="flex items-center justify-end gap-2">
                      {done && l.productionId && (
                        <Link href={`/ishlab-chiqarish/${l.productionId}`} className="text-[13px] text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">
                          {t('prodHome.plan.openProduction')}
                        </Link>
                      )}
                      {!done && (
                        canStart ? (
                          <Link
                            href={startHref(l)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
                          >
                            <Factory className="h-4 w-4 opacity-90" /> {t('prodHome.plan.start')}
                          </Link>
                        ) : (
                          <span
                            title={server && (dirty || !l.id) ? t('prodHome.plan.saveFirst') : undefined}
                            className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-400 dark:border-gray-700 dark:text-gray-500"
                          >
                            <Factory className="h-4 w-4" /> {t('prodHome.plan.start')}
                          </span>
                        )
                      )}
                      {!done && (
                        <button
                          type="button"
                          onClick={() => removeLine(l.key)}
                          aria-label={t('production.common.remove')}
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {server && dirty && <p className="-mt-3 text-[12px] text-gray-400 dark:text-gray-500">{t('prodHome.plan.saveFirst')}</p>}

      {/* Material requirements vs free stock */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodHome.plan.requirements')}</h2>
          {shortages > 0 && <span className={cn(pill, 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400')}>{t('prodHome.plan.shortageCount')}: {shortages}</span>}
        </div>
        <div className={cn(prodCardCls, 'overflow-x-auto')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800 dark:text-gray-400">
                <th className={thCls}>{t('prodHome.plan.material')}</th>
                <th className={thRightCls}>{t('prodHome.plan.required')}</th>
                <th className={thRightCls}>{t('prodHome.plan.available')}</th>
                <th className={thRightCls}>{t('prodHome.plan.shortage')}</th>
              </tr>
            </thead>
            <tbody>
              {busy ? null : requirements.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400 dark:text-gray-500">{t('prodHome.plan.noRequirements')}</td></tr>
              ) : requirements.map(r => {
                const short = r.shortage > 0
                return (
                  <tr key={r.itemId} className={trCls}>
                    <td className={cn(tdCls, short ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>{itemById.get(r.itemId)?.name ?? ''}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>{formatQty(r.required)} {unitOf(r.itemId)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums text-gray-600 dark:text-gray-400')}>{formatQty(r.available)} {unitOf(r.itemId)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums', short ? 'font-semibold text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500')}>
                      {short ? `${formatQty(r.shortage)} ${unitOf(r.itemId)}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
