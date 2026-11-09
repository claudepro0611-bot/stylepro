'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, DisabledSelect, FormFooter, NoteField, PageHeader, TotalsBox,
  prodCardCls, prodFieldCls, prodLabelCls, type TotalRow,
} from '@/components/production/ProdKit'
import { UnitQtyInput, entryToBase, useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs, useWarehouseStock } from '@/components/production/useProdRefs'
import {
  fetchActiveRecipe, formatQty, fromBaseQty, localDateTimeToIso, nowHm, parseDecimal, prodErrorKey, round2, round3, round4,
  smartUnit, sumByUnitGroup, toInputString, unitKey, warehousesFor, yieldPercent,
  type EntryUnit, type ProdItem, type ProdRecipe,
} from '@/lib/production'

/**
 * value === null: the line follows the recipe norm (rescaled whenever the
 * produced quantity changes). Typing into Fakt detaches it from the norm.
 */
interface ComponentLine { itemId: string; value: string | null; unit: EntryUnit }

// Fakt is stored with 3 decimals, the norm with 4: ignore the rounding gap.
const EPS = 0.0005

function recipeLines(recipe: ProdRecipe, itemById: Map<string, ProdItem>, keepUnits?: Map<string, EntryUnit>): ComponentLine[] {
  return recipe.lines.map(l => {
    const base = itemById.get(l.itemId)?.unit ?? 'pcs'
    return { itemId: l.itemId, value: null, unit: keepUnits?.get(l.itemId) ?? smartUnit(l.qty, base) }
  })
}

export default function NewProductionPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { smart, inUnit, groups } = useQtyFormat()
  const { items, warehouses, itemById } = useProdRefs()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  // null: the user has not picked one yet, so the default below applies.
  const [outputWarehouseChoice, setOutputWarehouseChoice] = useState<string | null>(null)
  const [outputItemId, setOutputItemId] = useState('')
  const [outputQty, setOutputQty] = useState('')
  const [lines, setLines] = useState<ComponentLine[]>([])
  const [recipe, setRecipe] = useState<ProdRecipe | null>(null)
  const [recipeLoading, setRecipeLoading] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const recipeReq = useRef(0)

  const { stock, loading: stockLoading } = useWarehouseStock(warehouseId)

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

  // Components come from a raw/production warehouse, the output goes to a
  // finished/production one (both fall back to every active warehouse).
  const rawWarehouses = useMemo(() => warehousesFor(warehouses, ['raw', 'production']), [warehouses])
  const outputWarehouses = useMemo(() => warehousesFor(warehouses, ['finished', 'production']), [warehouses])
  const defaultOutputId = warehouses.find(w => w.isActive && w.storageTypes.includes('finished'))?.id
    ?? (outputWarehouses.some(w => w.id === warehouseId) ? warehouseId : '')
  const outputWarehouseId = outputWarehouseChoice ?? defaultOutputId
  const outputItem = itemById.get(outputItemId)
  const outUnitLabel = outputItem ? t(unitKey(outputItem.unit)) : ''

  const outputOptions = useMemo(() => items
    .filter(i => i.isActive && (i.itemType === 'finished' || i.itemType === 'semi') && !lines.some(l => l.itemId === i.id))
    .map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) })), [items, lines, t])

  // Extra components: only what the chosen warehouse actually holds.
  const componentOptions = useMemo(() => items
    .filter(i => stock.has(i.id) && i.id !== outputItemId && !lines.some(l => l.itemId === i.id))
    .map(i => ({
      value: i.id,
      label: i.name,
      sublabel: `${t('production.common.available')}: ${formatQty(stock.get(i.id)!.qty)} ${t(unitKey(i.unit))}`,
    })), [items, stock, outputItemId, lines, t])

  const recipeQty = useMemo(() => new Map((recipe?.lines ?? []).map(l => [l.itemId, l.qty])), [recipe])
  const outQty = parseDecimal(outputQty)
  const scale = recipe && recipe.outputQty > 0 ? outQty / recipe.outputQty : 0

  const computed = lines.map(l => {
    const item = itemById.get(l.itemId)
    const base = item?.unit ?? 'pcs'
    const perBatch = recipeQty.get(l.itemId)
    const planned = perBatch === undefined ? null : round4(perBatch * scale)
    const display = l.value ?? (planned ? toInputString(fromBaseQty(planned, base, l.unit)) : '')
    const fact = round3(entryToBase(display, base, l.unit))
    const diff = planned === null ? null : fact - planned
    const s = stock.get(l.itemId)
    const available = s?.qty ?? 0
    const avg = s?.avgCost ?? 0
    return {
      ...l, item, base, planned, display, fact, diff, available, avg,
      total: round2(fact * avg),
      normTotal: planned === null ? 0 : round2(planned * avg),
      over: fact > available,
      edited: planned !== null && l.value !== null,
    }
  })
  const totalCost = round2(computed.reduce((sum, c) => sum + c.total, 0))
  const unitCost = outQty > 0 ? round2(totalCost / outQty) : 0
  const normCost = round2(computed.reduce((sum, c) => sum + c.normTotal, 0))
  const factInputs = computed.map(c => ({ qty: c.fact, unit: c.base }))
  const yieldPct = outputItem ? yieldPercent({ qty: outQty, unit: outputItem.unit }, factInputs) : null
  const canReset = !!recipe && (computed.some(c => c.edited) || recipe.lines.some(rl => !lines.some(l => l.itemId === rl.itemId)))

  const valid = !!warehouseId && !!outputWarehouseId && !!outputItemId && round3(outQty) > 0 && computed.length > 0
    && computed.every(c => c.fact > 0 && !c.over)

  async function changeOutput(id: string) {
    setOutputItemId(id)
    const req = ++recipeReq.current
    setRecipe(null)
    // Keep only what the user typed; recipe-following lines belong to the old item.
    setLines(prev => prev.filter(l => l.value !== null && l.itemId !== id))
    if (!id) return
    setRecipeLoading(true)
    const r = await fetchActiveRecipe(createClient(), id)
    if (req !== recipeReq.current) return
    setRecipeLoading(false)
    setRecipe(r)
    if (r) {
      setLines(prev => [...recipeLines(r, itemById), ...prev.filter(l => !r.lines.some(rl => rl.itemId === l.itemId))])
    }
  }

  function changeWarehouse(id: string) {
    setWarehouseId(id)
    // Extra components belong to the old warehouse's stock; recipe lines stay.
    setLines(recipe ? recipeLines(recipe, itemById) : [])
  }

  function patchLine(itemId: string, patch: Partial<ComponentLine>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...patch } : l)))
  }

  function resetAll() {
    if (!recipe) return
    const units = new Map(lines.map(l => [l.itemId, l.unit]))
    setLines(prev => [...recipeLines(recipe, itemById, units), ...prev.filter(l => !recipe.lines.some(rl => rl.itemId === l.itemId))])
  }

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_create_production', {
      p_data: {
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        output_warehouse_id: outputWarehouseId,
        output_item_id: outputItemId,
        output_qty: round3(outQty),
        note: note.trim() || null,
        recipe_id: recipe?.id ?? null,
        components: computed.map(c => ({
          item_id: c.itemId,
          qty: c.fact,
          planned_qty: c.planned === null ? null : round4(c.planned),
        })),
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error.message))); return }
    const id = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(id ? `/ishlab-chiqarish/${id}` : '/ishlab-chiqarish')
  }

  const totalRows: TotalRow[] = [
    { label: t('production.productions.totalConsumption'), value: groups(sumByUnitGroup(factInputs)) },
  ]
  if (yieldPct !== null) totalRows.push({ label: t('production.productions.yield'), value: `${yieldPct.toFixed(1)}%` })
  if (recipe) {
    const d = round2(totalCost - normCost)
    totalRows.push({
      label: t('production.productions.normCostDiff'),
      value: `${d > 0 ? '+' : ''}${formatPrice(d)}`,
      tone: d > 0 ? 'negative' : d < 0 ? 'positive' : undefined,
    })
  }
  totalRows.push(
    { label: t('production.productions.totalCost'), value: formatPrice(totalCost) },
    { label: t('production.productions.unitCost'), value: outputItem ? `${formatPrice(unitCost)} / ${outUnitLabel}` : formatPrice(unitCost), strong: true },
  )

  return (
    <div className="space-y-5">
      <BackLink href="/ishlab-chiqarish" label={t('production.productions.title')} />
      <PageHeader title={t('production.productions.newTitle')} />

      <div className={cn(prodCardCls, 'p-6 space-y-5')}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.date')}</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.time')}</span>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.productions.rawWarehouse')}</span>
            <select value={warehouseId} onChange={e => changeWarehouse(e.target.value)} className={prodFieldCls}>
              <option value="">{t('production.productions.chooseRawWarehouse')}</option>
              {rawWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.productions.outputWarehouse')}</span>
            <select value={outputWarehouseId} onChange={e => setOutputWarehouseChoice(e.target.value)} className={prodFieldCls}>
              <option value="">{t('production.productions.chooseOutputWarehouse')}</option>
              {outputWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-3">
            <span className={prodLabelCls}>{t('production.productions.outputItem')}</span>
            {warehouseId ? (
              <SearchSelect options={outputOptions} value={outputItemId} onChange={changeOutput} placeholder={t('production.common.selectItem')} />
            ) : (
              <DisabledSelect placeholder={t('production.common.chooseWarehouseFirst')} />
            )}
            {outputItemId && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]">
                {recipeLoading ? (
                  <span className="inline-flex items-center gap-1.5 text-gray-400"><Loader2 className="h-3 w-3 animate-spin" /> {t('production.productions.recipeLoading')}</span>
                ) : recipe && outputItem ? (
                  <Link
                    href={`/zavod-retseptlar/${recipe.id}`}
                    className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                  >
                    {t('production.productions.recipe')} v{recipe.version} · {t('production.productions.batchLower')} {smart(recipe.outputQty, outputItem.unit)}
                  </Link>
                ) : (
                  <>
                    <span className="text-gray-500 dark:text-gray-400">{t('production.productions.noRecipe')}</span>
                    <Link href={`/zavod-retseptlar/yangi?item=${outputItemId}`} className="font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                      {t('production.productions.createRecipe')}
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.qty')}</span>
            <div className="relative">
              <input
                inputMode="decimal"
                value={outputQty}
                onChange={e => setOutputQty(e.target.value)}
                onFocus={e => e.target.select()}
                disabled={!warehouseId}
                placeholder="0"
                className={cn(prodFieldCls, 'pr-12 tabular-nums')}
              />
              {outputItem && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{outUnitLabel}</span>}
            </div>
          </label>
        </div>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.productions.components')}</h2>
            {canReset && (
              <button
                type="button"
                onClick={resetAll}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
              >
                <RotateCcw className="h-3 w-3" /> {t('production.productions.resetToNorm')}
              </button>
            )}
          </div>
          <div className="w-full sm:w-80">
            {!warehouseId ? (
              <DisabledSelect placeholder={t('production.common.chooseWarehouseFirst')} />
            ) : stockLoading ? (
              <div className="flex h-9 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
            ) : (
              <SearchSelect
                options={componentOptions}
                value=""
                onChange={id => {
                  const base = itemById.get(id)?.unit ?? 'pcs'
                  setLines(prev => [...prev, { itemId: id, value: '', unit: base }])
                }}
                placeholder={componentOptions.length ? t('production.productions.addComponent') : t('production.common.noStock')}
              />
            )}
          </div>
        </div>
        {recipe && computed.length > 0 && (
          <p className="border-b border-gray-50 dark:border-gray-800/60 px-4 py-2 text-[11px] text-gray-400 dark:text-gray-500">{t('production.productions.normHint')}</p>
        )}
        {computed.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.productions.noComponents')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.productions.component')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.stockLeft')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.productions.norm')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-52">{t('production.productions.fact')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.productions.diff')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.avgCost')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map(c => {
                  const diffTone = c.diff === null || Math.abs(c.diff) < EPS || !(c.planned && c.planned > 0)
                    ? 'text-gray-400 dark:text-gray-500'
                    : c.diff > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                  return (
                    <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                        {c.item?.name ?? '—'}
                        {recipe && c.planned === null && (
                          <span className="ml-1.5 inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('production.productions.extra')}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{smart(c.available, c.base)}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {c.planned === null ? '—' : inUnit(c.planned, c.base, c.unit)}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1">
                          <UnitQtyInput
                            className="flex-1"
                            value={c.display}
                            onChange={v => patchLine(c.itemId, { value: v })}
                            base={c.base}
                            unit={c.unit}
                            onUnitChange={(u, v) => patchLine(c.itemId, { unit: u, value: c.value === null ? null : v })}
                            invalid={c.over}
                          />
                          {c.edited ? (
                            <button
                              type="button"
                              onClick={() => patchLine(c.itemId, { value: null })}
                              aria-label={t('production.productions.resetLine')}
                              title={t('production.productions.resetLine')}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          ) : <span className="w-7 shrink-0" />}
                        </div>
                        {c.over && <p className="mt-0.5 text-right text-[11px] text-red-600 dark:text-red-400">{t('productionErrors.insufficient_stock')}</p>}
                      </td>
                      <td className={cn('px-4 py-2 text-right tabular-nums whitespace-nowrap', diffTone)}>
                        {c.diff === null ? '—' : Math.abs(c.diff) < EPS ? '0' : (
                          <>
                            {c.diff > 0 ? '+' : '−'}{inUnit(Math.abs(c.diff), c.base, c.unit)}
                            {c.planned && c.planned > 0 ? <span className="ml-1 text-[11px]">({c.diff > 0 ? '+' : '−'}{Math.abs((c.diff / c.planned) * 100).toFixed(1)}%)</span> : null}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(c.avg)}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(c.total)}</td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => setLines(prev => prev.filter(l => l.itemId !== c.itemId))}
                          aria-label={t('production.common.remove')}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className={cn(prodCardCls, 'p-6')}>
          <NoteField value={note} onChange={setNote} />
        </div>
        <TotalsBox rows={totalRows} />
      </div>

      <FormFooter onCancel={() => router.push('/ishlab-chiqarish')} onSave={save} saving={saving} disabled={!valid} />
    </div>
  )
}
