'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2, RotateCcw, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, DisabledSelect, FormFooter, MoreFields, NoteField, PageHeader, Segmented, TotalsBox, useRememberedDefault,
  prodCardCls, prodFieldCls, prodLabelCls, type TotalRow,
} from '@/components/production/ProdKit'
import { UnitQtyInput, entryToBase, useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs, useWarehouseLots, useWarehouseStock } from '@/components/production/useProdRefs'
import { LotPicker } from '@/components/production/LotPicker'
import { useMilkSettings } from '@/components/production/MilkKit'
import { ControlHint, DocDateInput, useApprovalRetry, useControls, useProdErrorText } from '@/components/production/ControlKit'
import { Term } from '@/components/production/Term'
import { DraftBanner } from '@/components/production/DraftBanner'
import { useFormDraft } from '@/lib/useFormDraft'
import { useAccounting } from '@/components/production/AccountingKit'
import { fillText } from '@/lib/production-controls'
import {
  ALLOCATION_METHODS, acctErrorText, fetchRecipeOutputs, splitCost, type AllocationMethod, type SplitInput,
} from '@/lib/production-accounting'
import {
  CREAM_NAME_RE, activePicks, allocateFefo, fetchActiveRecipe, formatQty, fromBaseQty, lineAllocation, lineCost, localDateTimeToIso,
  makeLinePicks, nowHm, parseDecimal, picksPayload, round2, round3, round4,
  smartUnit, sumByUnitGroup, toInputString, unitKey, warehousesFor, yieldPercent, yieldWeightOf,
  type EntryUnit, type LinePicks, type ProdItem, type ProdRecipe, type ProdRpcError,
} from '@/lib/production'

/**
 * value === null: the line follows the recipe norm (rescaled whenever the
 * produced quantity changes). Typing into Fakt detaches it from the norm.
 */
interface ComponentLine {
  itemId: string
  value: string | null
  unit: EntryUnit
  /** Manually picked lots; dropped automatically when warehouse or qty change. */
  picks?: LinePicks | null
}

// Fakt is stored with 3 decimals, the norm with 4: ignore the rounding gap.
const EPS = 0.0005

/**
 * Co-product row (migration 20261110000018). qty === null: follows the
 * recipe by-product norm (perBatch per recipe batch); warehouseId '' = the
 * output warehouse. refPrice / share are used by the value / fixed methods.
 */
interface CoRow { key: string; itemId: string; qty: string | null; perBatch: number | null; warehouseId: string; refPrice: string; share: string }

let coSeq = 0
const nextCoKey = () => `co${++coSeq}`

/** '' -> null (not entered); otherwise a non-negative number. */
const optNum = (v: string): number | null => {
  if (v.trim() === '') return null
  const n = Number(v.replace(',', '.').replace(/\s/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}
const optNumSum = (vs: string[]) => vs.reduce((s, v) => s + (optNum(v) ?? 0), 0)

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
  const { settings: milkSettings } = useMilkSettings()
  const controls = useControls()
  const approval = useApprovalRetry()
  const controlErrorText = useProdErrorText()
  // Co-products (migration 20261110000018): hidden until it is applied.
  const accounting = useAccounting()
  const coOn = accounting.available
  const errorText = (err: ProdRpcError) => (coOn ? acctErrorText(t, err) : controlErrorText(err))

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
  const [coRows, setCoRows] = useState<CoRow[]>([])
  const [allocMethod, setAllocMethod] = useState<AllocationMethod>('mass')
  const [mainRef, setMainRef] = useState('')
  const [mainShare, setMainShare] = useState('')
  const recipeReq = useRef(0)

  // A form opened from a link (?item= from the daily plan) does not offer a draft.
  const [draftUrlChecked, setDraftUrlChecked] = useState(false)
  const [draftFromLink, setDraftFromLink] = useState(false)
  useEffect(() => {
    setDraftFromLink(new URLSearchParams(window.location.search).has('item'))
    setDraftUrlChecked(true)
  }, [])

  // Local draft (useFormDraft): autosaved 2 s after a change, offered when the form opens.
  const draftState = { date, time, warehouseId, outputWarehouseChoice, outputItemId, outputQty, lines, recipe, note, coRows, allocMethod, mainRef, mainShare }
  const draft = useFormDraft('production', draftState, (d: typeof draftState) => {
    setDate(d.date); setTime(d.time); setWarehouseId(d.warehouseId); setOutputWarehouseChoice(d.outputWarehouseChoice); setOutputItemId(d.outputItemId); setOutputQty(d.outputQty); setLines(d.lines); setRecipe(d.recipe); setNote(d.note); setCoRows(d.coRows); setAllocMethod(d.allocMethod); setMainRef(d.mainRef); setMainShare(d.mainShare)
  }, { ready: draftUrlChecked && itemById.size > 0, enabled: !draftFromLink, isEmpty: d => !d.outputItemId && d.lines.length === 0 && !d.note })

  const { stock, loading: stockLoading } = useWarehouseStock(warehouseId)
  const { lotsOf, available: lotsAvailable } = useWarehouseLots(warehouseId)

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

  // Opened from the daily plan (/zavod-reja): ?plan=&item=&qty=&recipe= prefill
  // the output (its active recipe loads as usual); plan_id marks the line done.
  const [planLink, setPlanLink] = useState<{ id: string; itemId: string } | null>(null)
  const planParamsDone = useRef(false)
  useEffect(() => {
    if (planParamsDone.current || itemById.size === 0) return
    planParamsDone.current = true
    const params = new URLSearchParams(window.location.search)
    const item = params.get('item')
    if (!item || !itemById.has(item)) return
    const plan = params.get('plan')
    if (plan) setPlanLink({ id: plan, itemId: item })
    const qty = params.get('qty')
    if (qty) setOutputQty(qty)
    void changeOutput(item)
  }, [itemById]) // eslint-disable-line react-hooks/exhaustive-deps

  // Components come from a raw/production warehouse, the output goes to a
  // finished/production one (both fall back to every active warehouse).
  const rawWarehouses = useMemo(() => warehousesFor(warehouses, ['raw', 'production']), [warehouses])
  const outputWarehouses = useMemo(() => warehousesFor(warehouses, ['finished', 'production']), [warehouses])
  const defaultOutputId = warehouses.find(w => w.isActive && w.storageTypes.includes('finished'))?.id
    ?? (outputWarehouses.some(w => w.id === warehouseId) ? warehouseId : '')
  const outputWarehouseId = outputWarehouseChoice ?? defaultOutputId
  // Last used warehouses of this user for this document type.
  const rememberRaw = useRememberedDefault('production-raw-warehouse', rawWarehouses.map(w => w.id), warehouseId, setWarehouseId)
  const rememberOut = useRememberedDefault('production-output-warehouse', outputWarehouses.map(w => w.id), outputWarehouseChoice ?? '', setOutputWarehouseChoice)
  const outputItem = itemById.get(outputItemId)
  const outUnitLabel = outputItem ? t(unitKey(outputItem.unit)) : ''

  const outputOptions = useMemo(() => items
    .filter(i => i.isActive && (i.itemType === 'finished' || i.itemType === 'semi') && !lines.some(l => l.itemId === i.id) && !coRows.some(r => r.itemId === i.id))
    .map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) })), [items, lines, coRows, t])

  // Co-products: finished / semi items that are neither the main output nor a component.
  const coOptions = useMemo(() => items
    .filter(i => i.isActive && (i.itemType === 'finished' || i.itemType === 'semi') && i.id !== outputItemId
      && !lines.some(l => l.itemId === i.id) && !coRows.some(r => r.itemId === i.id))
    .map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) })), [items, outputItemId, lines, coRows, t])

  // Extra components: only what the chosen warehouse actually holds.
  const componentOptions = useMemo(() => items
    .filter(i => stock.has(i.id) && i.id !== outputItemId && !lines.some(l => l.itemId === i.id) && !coRows.some(r => r.itemId === i.id))
    .map(i => ({
      value: i.id,
      label: i.name,
      sublabel: `${t('production.common.available')}: ${formatQty(stock.get(i.id)!.qty)} ${t(unitKey(i.unit))}`,
    })), [items, stock, outputItemId, lines, coRows, t])

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
    // Exact cost from the lots (picked, else the FEFO preview); avg_cost without lots.
    const lots = lotsOf(l.itemId)
    const picks = activePicks(l.picks, warehouseId, l.itemId, fact)
    const total = lineCost(lineAllocation(lots, picks, fact), fact, avg)
    return {
      ...l, item, base, planned, display, fact, diff, available, avg, lots, picks,
      unitPrice: fact > 0 ? round2(total / fact) : avg,
      total,
      normTotal: planned === null ? 0 : lineCost(lots ? allocateFefo(lots, planned) : null, planned, avg),
      over: fact > available,
      edited: planned !== null && l.value !== null,
    }
  })
  const totalCost = round2(computed.reduce((sum, c) => sum + c.total, 0))

  // Co-products: live preview of the server's cost split (main output first).
  const coComputed = coRows.map(r => {
    const item = itemById.get(r.itemId)
    const planned = r.perBatch !== null && recipe && recipe.outputQty > 0 ? round3((r.perBatch * outQty) / recipe.outputQty) : null
    const display = r.qty ?? (planned ? toInputString(planned) : '')
    return { ...r, item, planned, display, qtyNum: round3(parseDecimal(display)) }
  })
  const hasCo = coOn && coComputed.length > 0
  const split = hasCo
    ? splitCost(totalCost, [
      { item: outputItem, qty: round3(outQty), refPrice: optNum(mainRef), sharePct: optNum(mainShare) },
      ...coComputed.map<SplitInput>(c => ({ item: c.item, qty: c.qtyNum, refPrice: optNum(c.refPrice), sharePct: optNum(c.share) })),
    ], allocMethod)
    : null
  const shareSum = round2(optNumSum([mainShare, ...coRows.map(r => r.share)]))
  const unitCost = split ? split.rows[0].unitCost : outQty > 0 ? round2(totalCost / outQty) : 0
  const normCost = round2(computed.reduce((sum, c) => sum + c.normTotal, 0))
  const factInputs = computed.map(c => ({ qty: c.fact, unit: c.base, weightKg: yieldWeightOf(c.item) }))
  const yieldPct = outputItem ? yieldPercent({ qty: outQty, unit: outputItem.unit, weightKg: outputItem.weightKg }, factInputs) : null
  // Cream made from milk belongs in a Separatsiya document (cream + skim together).
  const creamFromMilk = !!outputItem && CREAM_NAME_RE.test(outputItem.name) && computed.some(c =>
    (!!milkSettings.milkItemId && c.itemId === milkSettings.milkItemId) || /(^|\s)sut(\s|$)|молок|milk/i.test(c.item?.name ?? ''))
  // Controls (migration 20261110000017): the server's production_yield check,
  // mirrored for a live hint: every recipe line vs its scaled norm, extra
  // components, and the output vs the recipe output scaled by the inputs.
  const tolPct = controls.settings.productionTolerancePct
  const deviation = (() => {
    if (!recipe || !(recipe.outputQty > 0) || !(outQty > 0)) return null
    const factBy = new Map(computed.map(c => [c.itemId, c.fact]))
    let maxDev = 0
    let inSum = 0
    let rlSum = 0
    for (const rl of recipe.lines) {
      const plan = (rl.qty * outQty) / recipe.outputQty
      const actual = factBy.get(rl.itemId) ?? 0
      inSum += actual
      rlSum += rl.qty
      if (plan > 0) maxDev = Math.max(maxDev, Math.abs(actual - plan) / plan)
    }
    if (rlSum > 0) {
      const expected = (recipe.outputQty * inSum) / rlSum
      maxDev = expected > 0 ? Math.max(maxDev, Math.abs(outQty - expected) / expected) : Math.max(maxDev, 1)
    }
    const extra = computed.some(c => !recipe.lines.some(rl => rl.itemId === c.itemId))
    const devPct = round2(maxDev * 100)
    return { devPct, extra, bad: extra || devPct > tolPct }
  })()

  const canReset = !!recipe && (computed.some(c => c.edited) || recipe.lines.some(rl => !lines.some(l => l.itemId === rl.itemId)))

  const valid = !!warehouseId && !!outputWarehouseId && !!outputItemId && round3(outQty) > 0 && computed.length > 0
    && computed.every(c => c.fact > 0 && !c.over)
    && (!hasCo || (coComputed.every(c => c.qtyNum > 0) && !split?.error))

  async function changeOutput(id: string) {
    setOutputItemId(id)
    const req = ++recipeReq.current
    setRecipe(null)
    // Keep only what the user typed; recipe-following lines belong to the old item.
    setLines(prev => prev.filter(l => l.value !== null && l.itemId !== id))
    // Co-products prefilled from the old recipe go too.
    setCoRows(prev => prev.filter(r => r.perBatch === null && r.itemId !== id))
    if (!id) return
    setRecipeLoading(true)
    const r = await fetchActiveRecipe(createClient(), id)
    // Recipe by-products prefill the co-product rows (migration 20261110000018).
    const byProducts = r && coOn ? await fetchRecipeOutputs(createClient(), r.id) : null
    if (req !== recipeReq.current) return
    setRecipeLoading(false)
    setRecipe(r)
    if (r) {
      setLines(prev => [...recipeLines(r, itemById), ...prev.filter(l => !r.lines.some(rl => rl.itemId === l.itemId))])
    }
    if (byProducts && byProducts.length > 0) {
      setCoRows(prev => [
        ...byProducts.filter(o => o.itemId !== id).map(o => ({ key: nextCoKey(), itemId: o.itemId, qty: null, perBatch: o.qtyPerBatch, warehouseId: '', refPrice: '', share: '' })),
        ...prev.filter(p => !byProducts.some(o => o.itemId === p.itemId)),
      ])
    }
  }

  function patchCo(key: string, patch: Partial<CoRow>) {
    setCoRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  /** ref_price / share_pct of one output for the chosen method (absent = server default). */
  function methodExtra(refPrice: string, share: string) {
    if (allocMethod === 'value') { const p = optNum(refPrice); return p === null ? {} : { ref_price: round2(p) } }
    if (allocMethod === 'fixed') { const s = optNum(share); return s === null ? {} : { share_pct: round4(s) } }
    return {}
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
    const res = await approval.run(ctl => createClient().rpc('prod_create_production', {
      p_data: {
        ...ctl,
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        output_warehouse_id: outputWarehouseId,
        output_item_id: outputItemId,
        output_qty: round3(outQty),
        note: note.trim() || null,
        recipe_id: recipe?.id ?? null,
        ...(planLink && planLink.itemId === outputItemId ? { plan_id: planLink.id } : {}),
        ...(hasCo ? {
          allocation_method: allocMethod,
          outputs: [
            { item_id: outputItemId, qty: round3(outQty), output_warehouse_id: outputWarehouseId, ...methodExtra(mainRef, mainShare) },
            ...coComputed.map(c => ({
              item_id: c.itemId, qty: c.qtyNum, output_warehouse_id: c.warehouseId || outputWarehouseId, ...methodExtra(c.refPrice, c.share),
            })),
          ],
        } : {}),
        components: computed.map(c => ({
          item_id: c.itemId,
          qty: c.fact,
          planned_qty: c.planned === null ? null : round4(c.planned),
          lots: picksPayload(c.picks),
        })),
      },
    }), deviation ? { dev: deviation.devPct } : undefined)
    setSaving(false)
    if (!res) return
    const { data, error } = res
    if (error) { toast.error(errorText(error)); return }
    rememberRaw(warehouseId)
    rememberOut(outputWarehouseId)
    const id = (data as { id?: string } | null)?.id
    draft.clear()
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
    ...(split ? [{ label: `${t('prodAcct.co.mainCost')}${outputItem ? ` (${outputItem.name})` : ''}`, value: formatPrice(split.rows[0].cost) }] : []),
    { label: t('production.productions.unitCost'), value: outputItem ? `${formatPrice(unitCost)} / ${outUnitLabel}` : formatPrice(unitCost), strong: true },
  )
  const splitErrorText = split?.error === 'share_pct'
    ? fillText(t('prodAcct.co.shareSum'), { sum: shareSum })
    : split?.error === 'output_weight' ? t('prodAcct.errors.output_weight')
      : split?.error === 'ref_price' ? t('prodAcct.errors.ref_price') : ''

  return (
    <div className="space-y-5">
      <BackLink href="/ishlab-chiqarish" label={t('production.productions.title')} />
      <PageHeader title={t('production.productions.newTitle')} />
      <DraftBanner offer={draft.offer} onRestore={draft.restore} onDiscard={draft.discard} />

      <div className={cn(prodCardCls, 'p-4 sm:p-6 space-y-5')}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.date')}</span>
            <DocDateInput value={date} onChange={setDate} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.time')}</span>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.productions.rawWarehouse')}</span>
            <select data-autofocus value={warehouseId} onChange={e => changeWarehouse(e.target.value)} className={prodFieldCls}>
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

        {coOn && warehouseId && outputItemId && (
          <MoreFields active={coRows.length > 0} label={t('prodAcct.co.title')}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-0 flex-1 text-[12px] text-gray-500 dark:text-gray-400">{t('prodAcct.co.hint')}</p>
                {coRows.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-gray-500 dark:text-gray-400">{t('prodAcct.co.method')}</span>
                    <Segmented<AllocationMethod>
                      value={allocMethod}
                      onChange={setAllocMethod}
                      options={ALLOCATION_METHODS.map(m => ({ value: m, label: t(`prodAcct.co.methods.${m}`) }))}
                    />
                  </div>
                )}
              </div>
              {coRows.length > 0 && split && (
                <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                        <th className="px-3 py-2 text-left font-medium">{t('production.common.item')}</th>
                        <th className="px-3 py-2 text-right font-medium w-36">{t('production.common.qty')}</th>
                        <th className="px-3 py-2 text-left font-medium w-44">{t('production.common.warehouse')}</th>
                        {allocMethod === 'value' && <th className="px-3 py-2 text-right font-medium w-32">{t('prodAcct.co.refPrice')}</th>}
                        {allocMethod === 'fixed' && <th className="px-3 py-2 text-right font-medium w-24">{t('prodAcct.co.share')}</th>}
                        <th className="px-3 py-2 text-right font-medium">{t('prodAcct.co.shareResult')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('prodAcct.co.cost')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('prodAcct.co.unitCost')}</th>
                        <th className="px-3 py-2 w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-gray-50 dark:border-gray-800/60">
                        <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                          {outputItem?.name ?? '—'}
                          <span className="ml-1.5 inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('prodAcct.co.main')}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(round3(outQty))} {outUnitLabel}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{warehouses.find(w => w.id === outputWarehouseId)?.name ?? '—'}</td>
                        {allocMethod === 'value' && (
                          <td className="px-3 py-2">
                            <input inputMode="decimal" value={mainRef} onChange={e => setMainRef(e.target.value)} placeholder={outputItem?.salePrice != null ? String(outputItem.salePrice) : '0'} className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                          </td>
                        )}
                        {allocMethod === 'fixed' && (
                          <td className="px-3 py-2">
                            <input inputMode="decimal" value={mainShare} onChange={e => setMainShare(e.target.value)} placeholder="%" className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                          </td>
                        )}
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{split.rows[0].sharePct.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(split.rows[0].cost)}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(split.rows[0].unitCost)}</td>
                        <td />
                      </tr>
                      {coComputed.map((c, i) => {
                        const r = split.rows[i + 1]
                        const unitLabel = c.item ? t(unitKey(c.item.unit)) : ''
                        const noWeight = allocMethod === 'mass' && r?.weight === null
                        const noPrice = allocMethod === 'value' && r?.weight === null
                        return (
                          <tr key={c.key} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                            <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                              {c.item?.name ?? '—'}
                              {c.perBatch !== null && (
                                <span className="ml-1.5 inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('prodAcct.co.fromRecipe')}</span>
                              )}
                              {noWeight && <span className="mt-0.5 block text-[11px] text-red-600 dark:text-red-400">{t('prodAcct.co.noWeight')}</span>}
                              {noPrice && <span className="mt-0.5 block text-[11px] text-red-600 dark:text-red-400">{t('prodAcct.co.noPrice')}</span>}
                            </td>
                            <td className="px-3 py-2">
                              <div className="relative">
                                <input
                                  inputMode="decimal"
                                  value={c.display}
                                  onChange={e => patchCo(c.key, { qty: e.target.value })}
                                  onFocus={e => e.target.select()}
                                  placeholder="0"
                                  className={cn(prodFieldCls, 'h-8 pr-10 text-right tabular-nums', !(c.qtyNum > 0) && c.display !== '' && 'border-red-300 dark:border-red-500/50')}
                                />
                                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-gray-400">{unitLabel}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <select value={c.warehouseId} onChange={e => patchCo(c.key, { warehouseId: e.target.value })} className={cn(prodFieldCls, 'h-8')}>
                                <option value="">{warehouses.find(w => w.id === outputWarehouseId)?.name ?? t('production.productions.outputWarehouse')}</option>
                                {outputWarehouses.filter(w => w.id !== outputWarehouseId).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                              </select>
                            </td>
                            {allocMethod === 'value' && (
                              <td className="px-3 py-2">
                                <input inputMode="decimal" value={c.refPrice} onChange={e => patchCo(c.key, { refPrice: e.target.value })} placeholder={c.item?.salePrice != null ? String(c.item.salePrice) : '0'} className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                              </td>
                            )}
                            {allocMethod === 'fixed' && (
                              <td className="px-3 py-2">
                                <input inputMode="decimal" value={c.share} onChange={e => patchCo(c.key, { share: e.target.value })} placeholder="%" className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                              </td>
                            )}
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{r ? `${r.sharePct.toFixed(1)}%` : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{r ? formatPrice(r.cost) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{r ? formatPrice(r.unitCost) : '—'}</td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => setCoRows(prev => prev.filter(x => x.key !== c.key))}
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
              {splitErrorText && <ControlHint tone="error">{splitErrorText}</ControlHint>}
              <div className="w-full sm:w-80">
                <SearchSelect
                  options={coOptions}
                  value=""
                  onChange={id => setCoRows(prev => [...prev, { key: nextCoKey(), itemId: id, qty: '', perBatch: null, warehouseId: '', refPrice: '', share: '' }])}
                  placeholder={t('prodAcct.co.add')}
                />
              </div>
            </div>
          </MoreFields>
        )}

        <MoreFields active={!!note}>
          <NoteField value={note} onChange={setNote} />
        </MoreFields>
      </div>

      {creamFromMilk && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="min-w-0 flex-1 text-[13px] text-amber-800 dark:text-amber-300">{t('production.productions.creamHint')}</p>
          <Link href="/separatsiya/yangi" className="inline-flex h-9 items-center rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-3 text-sm font-medium text-white transition-colors">
            {t('production.productions.creamHintLink')}
          </Link>
        </div>
      )}

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100"><Term k="fifo">{t('production.productions.components')}</Term></h2>
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
                  <th className={cn('px-4 py-2.5 text-right font-medium', lotsAvailable ? 'w-72' : 'w-52')}>{t('production.productions.fact')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.productions.diff')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{lotsAvailable ? t('production.lots.unitCost') : t('production.common.avgCost')}</th>
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
                          <LotPicker
                            lots={c.lots}
                            qty={c.fact}
                            unit={c.base}
                            picks={c.picks}
                            onChange={p => patchLine(c.itemId, { picks: makeLinePicks(warehouseId, c.itemId, c.fact, p) })}
                          />
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
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(c.unitPrice)}</td>
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

      {controls.available && outputItemId && !recipeLoading && (
        !recipe ? (
          <ControlHint>{t('prodControls.hints.productionNoRecipe')}</ControlHint>
        ) : deviation && (
          <ControlHint tone={deviation.bad ? 'error' : 'ok'}>
            {deviation.extra && deviation.devPct <= tolPct
              ? t('prodControls.hints.productionExtra')
              : fillText(t(deviation.bad ? 'prodControls.hints.productionDevBad' : 'prodControls.hints.productionDev'), { dev: deviation.devPct, tol: tolPct })}
          </ControlHint>
        )
      )}

      <div className="lg:ml-auto lg:max-w-md">
        <TotalsBox rows={totalRows} />
      </div>

      <FormFooter
        onCancel={() => router.push('/ishlab-chiqarish')}
        onSave={save}
        saving={saving}
        disabled={!valid}
        total={{ label: t('production.productions.totalCost'), value: formatPrice(totalCost) }}
      />
      {approval.dialog}
    </div>
  )
}
