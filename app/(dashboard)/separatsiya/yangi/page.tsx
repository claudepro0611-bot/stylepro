'use client'

// New separation ("Separatsiya"): milk -> cream + skim (obrat). Cream and
// skim are calculated live from the fat balance, so the cream can never be
// mistaken for the (much larger) skim amount. The server recomputes and
// validates everything in prod_create_separation.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, FormFooter, NoteField, PageHeader, Segmented, TotalsBox,
  prodCardCls, prodFieldCls, prodLabelCls, type TotalRow,
} from '@/components/production/ProdKit'
import { useProdRefs, useWarehouseLots, useWarehouseStock } from '@/components/production/useProdRefs'
import { LotPicker } from '@/components/production/LotPicker'
import { useMilkSettings } from '@/components/production/MilkKit'
import { BigFigure, FatBalance, NumField, SepSection, ValueChips, allocationHintKey } from '@/components/production/SeparationKit'
import {
  CREAM_NAME_RE, SEPARATION_CREAM_FAT_CHIPS, SEPARATION_DEFAULT_SKIM_FAT, SKIM_NAME_RE,
  activePicks, computeSeparation, fetchProdStockFat, formatQty, lineAllocation, lineCost, localDateTimeToIso, makeLinePicks,
  milkForCream, nowHm, parseDecimal, picksPayload, prodErrorKey,
  round2, round3, toInputString, toSeparationAllocation, warehousesFor,
  type LinePicks, type ProdItem, type SeparationAllocation,
} from '@/lib/production'
import { formatPct, isMilkItemCandidate, parseOptional } from '@/lib/milk'
import type { TranslationKey } from '@/lib/i18n/translations'

type Mode = 'milk' | 'cream'

const kgItem = (i: ProdItem) => i.isActive && i.unit === 'kg'

export default function NewSeparationPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { items, warehouses } = useProdRefs()
  const { settings, loading: settingsLoading } = useMilkSettings()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  // null: not picked yet, so the defaults below apply.
  const [warehouseChoice, setWarehouseChoice] = useState<string | null>(null)
  const [outputWarehouseChoice, setOutputWarehouseChoice] = useState<string | null>(null)
  const [milkItemChoice, setMilkItemChoice] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('milk')
  const [milkQtyText, setMilkQtyText] = useState('')
  const [creamTargetText, setCreamTargetText] = useState('')
  // null: follow the stock average fat of the chosen milk.
  const [milkFatText, setMilkFatText] = useState<string | null>(null)
  const [creamItemStored, setCreamItemStored] = useLocalStorage('stylepro-separation:cream-item', '')
  const [skimItemStored, setSkimItemStored] = useLocalStorage('stylepro-separation:skim-item', '')
  const [creamFatText, setCreamFatText] = useLocalStorage('stylepro-separation:cream-fat', '')
  const [skimFatText, setSkimFatText] = useState(String(SEPARATION_DEFAULT_SKIM_FAT))
  const [lossText, setLossText] = useState('0')
  // null: follow the calculated amount.
  const [creamActualText, setCreamActualText] = useState<string | null>(null)
  const [skimActualText, setSkimActualText] = useState<string | null>(null)
  const [methodStored, setMethodStored] = useLocalStorage<string>('stylepro-separation:method', 'skim_price')
  const [skimPriceText, setSkimPriceText] = useLocalStorage('stylepro-separation:skim-price', '')
  const [creamRefText, setCreamRefText] = useLocalStorage('stylepro-separation:cream-ref-price', '')
  const [skimRefText, setSkimRefText] = useLocalStorage('stylepro-separation:skim-ref-price', '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [fatByKey, setFatByKey] = useState<Map<string, number>>(new Map())
  // Manually picked milk lots; dropped automatically when warehouse/item/qty change.
  const [milkPicks, setMilkPicks] = useState<LinePicks | null>(null)

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

  const rawWarehouses = useMemo(() => warehousesFor(warehouses, ['raw', 'production']), [warehouses])
  const outputWarehouses = useMemo(() => warehousesFor(warehouses, ['finished', 'production']), [warehouses])
  const defaultWarehouseId = settings.defaultWarehouseId && rawWarehouses.some(w => w.id === settings.defaultWarehouseId)
    ? settings.defaultWarehouseId
    : rawWarehouses.length === 1 ? rawWarehouses[0].id : ''
  const warehouseId = warehouseChoice ?? (settingsLoading ? '' : defaultWarehouseId)
  const defaultOutputId = warehouses.find(w => w.isActive && w.storageTypes.includes('finished'))?.id
    ?? (outputWarehouses.some(w => w.id === warehouseId) ? warehouseId : '')
  const outputWarehouseId = outputWarehouseChoice ?? defaultOutputId

  const { stock } = useWarehouseStock(warehouseId)
  const { lotsOf } = useWarehouseLots(warehouseId)

  useEffect(() => {
    if (!warehouseId) return
    let cancelled = false
    fetchProdStockFat(createClient(), warehouseId).then(m => { if (!cancelled) setFatByKey(m) })
    return () => { cancelled = true }
  }, [warehouseId])

  // Items: milk is a raw kg item; cream finished/semi; skim semi/raw (all kg).
  const milkCandidates = useMemo(() => items.filter(isMilkItemCandidate), [items])
  const milkItemId = milkItemChoice
    ?? (settings.milkItemId && milkCandidates.some(i => i.id === settings.milkItemId) ? settings.milkItemId : '')
  const milkStock = stock.get(milkItemId)
  const available = milkStock?.qty ?? 0
  const avgCost = milkStock?.avgCost ?? 0
  const stockFat = warehouseId && milkItemId ? fatByKey.get(`${warehouseId}:${milkItemId}`) ?? null : null
  const milkLots = warehouseId && milkItemId ? lotsOf(milkItemId) : null
  // "From milk" mode: the milk quantity does not depend on the fat, so the
  // default fat is that of the lots actually taken (picked or FEFO), which is
  // what the server uses. "From cream" derives the quantity from the fat, so
  // it keeps the stock average to avoid a circular dependency.
  const typedMilkQty = round3(parseDecimal(milkQtyText))
  const fatAlloc = mode === 'milk' && typedMilkQty > 0
    ? lineAllocation(milkLots, activePicks(milkPicks, warehouseId, milkItemId, typedMilkQty), typedMilkQty)
    : null
  const autoFat = fatAlloc && fatAlloc.qty > 0 && fatAlloc.fatPct !== null ? fatAlloc.fatPct : stockFat

  const creamCandidates = useMemo(() => items.filter(i => kgItem(i) && (i.itemType === 'finished' || i.itemType === 'semi')), [items])
  const skimCandidates = useMemo(() => items.filter(i => kgItem(i) && (i.itemType === 'semi' || i.itemType === 'raw')), [items])
  const creamItemId = creamCandidates.some(i => i.id === creamItemStored && i.id !== milkItemId)
    ? creamItemStored
    : creamCandidates.find(i => CREAM_NAME_RE.test(i.name) && i.id !== milkItemId)?.id ?? ''
  const skimItemId = skimCandidates.some(i => i.id === skimItemStored && i.id !== milkItemId && i.id !== creamItemId)
    ? skimItemStored
    : skimCandidates.find(i => SKIM_NAME_RE.test(i.name) && i.id !== milkItemId && i.id !== creamItemId)?.id ?? ''
  const hasSkimLikeItem = items.some(i => i.isActive && SKIM_NAME_RE.test(i.name))

  const milkOptions = useMemo(() => milkCandidates.map(i => {
    const s = stock.get(i.id)
    return { value: i.id, label: i.name, sublabel: s ? `${formatQty(s.qty)} ${t('production.units.kg')}` : undefined }
  }), [milkCandidates, stock, t])
  const creamOptions = useMemo(() => creamCandidates
    .filter(i => i.id !== milkItemId && i.id !== skimItemId)
    .map(i => ({ value: i.id, label: i.name })), [creamCandidates, milkItemId, skimItemId])
  const skimOptions = useMemo(() => skimCandidates
    .filter(i => i.id !== milkItemId && i.id !== creamItemId)
    .map(i => ({ value: i.id, label: i.name })), [skimCandidates, milkItemId, creamItemId])

  // Numbers
  const milkFatValue = milkFatText === null ? (autoFat === null ? null : round3(autoFat)) : parseOptional(milkFatText)
  const milkFatDisplay = milkFatText ?? (autoFat === null ? '' : String(round3(autoFat)))
  const m = milkFatValue ?? 0
  const c = parseOptional(creamFatText) ?? 0
  const s = parseOptional(skimFatText) ?? 0
  const lossPct = parseOptional(lossText) ?? 0
  const creamTarget = parseDecimal(creamTargetText)
  const milkQty = mode === 'milk' ? round3(parseDecimal(milkQtyText)) : milkForCream(creamTarget, m, c, s, lossPct)
  // Exact milk cost from the lots (picked, else the FEFO preview); avg_cost without lots.
  const milkPicked = activePicks(milkPicks, warehouseId, milkItemId, milkQty)
  const milkAlloc = lineAllocation(milkLots, milkPicked, milkQty)
  const milkCost = lineCost(milkAlloc, milkQty, avgCost)
  const milkUnitCost = milkQty > 0 ? round2(milkCost / milkQty) : avgCost
  const method = toSeparationAllocation(methodStored)
  const priceOrNull = (v: string) => { const n = parseOptional(v); return n === null ? null : round2(n) }

  const r = computeSeparation({
    milkQty,
    milkFat: m,
    creamFat: c,
    skimFat: s,
    lossPct,
    creamActual: creamActualText === null ? null : parseOptional(creamActualText) ?? 0,
    skimActual: skimActualText === null ? null : parseOptional(skimActualText) ?? 0,
    milkCost,
    method,
    skimPrice: priceOrNull(skimPriceText),
    creamRefPrice: priceOrNull(creamRefText),
    skimRefPrice: priceOrNull(skimRefText),
  })
  const calcReady = r.fatsOk && milkQty > 0

  // Every reason the document cannot be saved yet, in reading order.
  const issues: TranslationKey[] = []
  if (!warehouseId || !outputWarehouseId) issues.push('production.separation.issues.warehouses_missing')
  if (!milkItemId || !creamItemId || !skimItemId) issues.push('production.separation.issues.items_missing')
  else if (new Set([milkItemId, creamItemId, skimItemId]).size < 3) issues.push('production.separation.issues.items_same')
  for (const code of r.issues) issues.push(`production.separation.issues.${code}` as TranslationKey)
  const overStock = !!warehouseId && !!milkItemId && milkQty > available
  if (overStock) issues.push('production.separation.issues.stock')
  const valid = issues.length === 0
  const touched = milkQty > 0 || creamTarget > 0

  const kg = t('production.units.kg')
  const fatOrderError = r.issues.includes('fat_order') ? t('production.separation.issues.fat_order') : undefined

  function changeWarehouse(id: string) {
    setWarehouseChoice(id)
    setMilkFatText(null)
  }

  function changeMilkItem(id: string) {
    setMilkItemChoice(id)
    setMilkFatText(null)
  }

  const diffLabel = (actual: number, calc: number) => {
    const d = round3(actual - calc)
    if (!(calc > 0) || Math.abs(d) < 0.0005) return null
    return `${t('production.separation.vsCalc')}: ${d > 0 ? '+' : '−'}${formatQty(Math.abs(d))} ${kg} (${d > 0 ? '+' : '−'}${Math.abs((d / calc) * 100).toFixed(1)}%)`
  }

  async function save() {
    if (!valid) { toast.error(t(issues[0] ?? 'productionErrors.invalid_input')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_create_separation', {
      p_data: {
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        output_warehouse_id: outputWarehouseId,
        milk_item_id: milkItemId,
        cream_item_id: creamItemId,
        skim_item_id: skimItemId,
        milk_qty: milkQty,
        milk_lots: picksPayload(milkPicked),
        milk_fat: round3(m),
        cream_fat: round3(c),
        skim_fat: round3(s),
        loss_pct: round3(lossPct),
        cream_qty: r.cream,
        skim_qty: r.skim,
        allocation_method: method,
        skim_price: method === 'skim_price' ? priceOrNull(skimPriceText) : null,
        cream_ref_price: method === 'value' ? priceOrNull(creamRefText) : null,
        skim_ref_price: method === 'value' ? priceOrNull(skimRefText) : null,
        note: note.trim() || null,
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    const id = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(id ? `/separatsiya/${id}` : '/separatsiya')
  }

  const costRows: TotalRow[] = [
    { label: `${t('production.separation.milkCost')}${milkQty > 0 ? ` (${formatQty(milkQty)} ${kg} × ${formatPrice(milkUnitCost)})` : ''}`, value: formatPrice(milkCost) },
    { label: t('production.separation.creamTotal'), value: formatPrice(r.creamTotal) },
    { label: t('production.separation.skimTotal'), value: formatPrice(r.skimTotal), tone: r.issues.includes('skim_over_cost') ? 'negative' : undefined },
    { label: t('production.separation.creamUnitCost'), value: `${formatPrice(r.creamUnitCost)} / ${kg}`, strong: true },
    { label: t('production.separation.skimUnitCost'), value: `${formatPrice(r.skimUnitCost)} / ${kg}` },
  ]

  return (
    <div className="space-y-5">
      <BackLink href="/separatsiya" label={t('production.separation.title')} />
      <PageHeader title={t('production.separation.newTitle')} subtitle={t('production.separation.newSubtitle')} />

      <div className={cn(prodCardCls, 'p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4')}>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.date')}</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className={prodFieldCls} />
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.time')}</span>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('production.separation.rawWarehouse')}</span>
          <select value={warehouseId} onChange={e => changeWarehouse(e.target.value)} className={prodFieldCls}>
            <option value="">{t('production.separation.chooseRawWarehouse')}</option>
            {rawWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('production.separation.outputWarehouse')}</span>
          <select value={outputWarehouseId} onChange={e => setOutputWarehouseChoice(e.target.value)} className={prodFieldCls}>
            <option value="">{t('production.separation.chooseOutputWarehouse')}</option>
            {outputWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5 items-start">
        <div className="xl:col-span-3 space-y-5">
          <SepSection title={t('production.separation.milkBlock')} hint={t('production.separation.milkBlockHint')}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <span className={prodLabelCls}>{t('production.separation.milkItem')}</span>
                <SearchSelect options={milkOptions} value={milkItemId} onChange={changeMilkItem} placeholder={t('production.common.selectItem')} />
                {milkItemId && warehouseId && (
                  <p className="mt-1.5 text-[12px] tabular-nums text-gray-500 dark:text-gray-400">
                    {t('production.common.available')}: <span className="font-medium text-gray-900 dark:text-gray-100">{formatQty(available)} {kg}</span>
                    {' · '}
                    {stockFat === null ? t('production.separation.noFatData') : `${t('production.separation.fatLower')} ${formatPct(stockFat)}%`}
                  </p>
                )}
              </div>
              <div>
                <span className={prodLabelCls}>&nbsp;</span>
                <Segmented
                  options={[
                    { value: 'milk', label: t('production.separation.modeFromMilk') },
                    { value: 'cream', label: t('production.separation.modeFromCream') },
                  ]}
                  value={mode}
                  onChange={v => { setMode(v); setCreamActualText(null); setSkimActualText(null) }}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {mode === 'milk' ? (
                <NumField
                  big
                  label={t('production.separation.milkQty')}
                  value={milkQtyText}
                  onChange={setMilkQtyText}
                  suffix={kg}
                  error={overStock ? `${t('production.separation.issues.stock')} (${t('production.common.available')}: ${formatQty(available)} ${kg})` : undefined}
                />
              ) : (
                <div className="space-y-3">
                  <NumField big label={t('production.separation.creamTarget')} value={creamTargetText} onChange={setCreamTargetText} suffix={kg} />
                  <NumField
                    label={t('production.separation.milkNeeded')}
                    value={milkQty > 0 ? toInputString(milkQty) : ''}
                    readOnly
                    suffix={kg}
                    error={overStock ? `${t('production.separation.issues.stock')} (${t('production.common.available')}: ${formatQty(available)} ${kg})` : undefined}
                  />
                </div>
              )}
              <NumField
                big
                label={t('production.separation.milkFat')}
                value={milkFatDisplay}
                onChange={setMilkFatText}
                suffix="%"
                hint={
                  milkFatText !== null && autoFat !== null ? (
                    <button type="button" onClick={() => setMilkFatText(null)} className="inline-flex items-center gap-1 font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                      <RotateCcw className="h-3 w-3" /> {t('production.separation.fatLower')} {formatPct(autoFat)}%
                    </button>
                  ) : fatAlloc && autoFat !== null && autoFat !== stockFat ? t('production.lots.fatFromLots') : t('production.separation.milkFatHint')
                }
                error={milkItemId && warehouseId && milkFatValue === null ? t('production.separation.milkFatRequired') : undefined}
              />
            </div>
            {milkLots && milkQty > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-gray-500 dark:text-gray-400">
                <LotPicker
                  lots={milkLots}
                  qty={milkQty}
                  unit="kg"
                  picks={milkPicked}
                  onChange={p => setMilkPicks(makeLinePicks(warehouseId, milkItemId, milkQty, p))}
                />
                {milkAlloc && milkAlloc.takes.length > 0 && (
                  <span className="tabular-nums">
                    {milkAlloc.takes.map(x => `${x.lot.lotNo}: ${formatQty(x.qty)} ${kg} × ${formatPrice(x.lot.unitCost)}`).join(' · ')}
                  </span>
                )}
              </div>
            )}
          </SepSection>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <SepSection title={t('production.separation.creamBlock')} hint={t('production.separation.creamBlockHint')}>
              <div>
                <span className={prodLabelCls}>{t('production.separation.creamItem')}</span>
                <SearchSelect options={creamOptions} value={creamItemId} onChange={setCreamItemStored} placeholder={t('production.common.selectItem')} />
                <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{t('production.separation.kgOnlyHint')}</p>
              </div>
              <NumField
                label={t('production.separation.creamFat')}
                value={creamFatText}
                onChange={setCreamFatText}
                suffix="%"
                hint={t('production.separation.creamFatHint')}
                error={fatOrderError && c <= m ? fatOrderError : r.issues.includes('cream_fat_max') ? t('production.separation.issues.cream_fat_max') : undefined}
              />
              <ValueChips values={SEPARATION_CREAM_FAT_CHIPS} value={c || null} onPick={v => setCreamFatText(String(v))} suffix="%" />
            </SepSection>

            <SepSection title={t('production.separation.skimBlock')} hint={t('production.separation.skimBlockHint')}>
              <div>
                <span className={prodLabelCls}>{t('production.separation.skimItem')}</span>
                <SearchSelect options={skimOptions} value={skimItemId} onChange={setSkimItemStored} placeholder={t('production.common.selectItem')} />
                {!hasSkimLikeItem && items.length > 0 ? (
                  <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px] text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {t('production.separation.noSkimItem')}
                    <Link href="/zavod-mahsulotlar" className="font-medium text-gray-700 dark:text-gray-300 underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                      {t('production.separation.createItem')}
                    </Link>
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{t('production.separation.kgOnlyHint')}</p>
                )}
              </div>
              <NumField
                label={t('production.separation.skimFat')}
                value={skimFatText}
                onChange={setSkimFatText}
                suffix="%"
                hint={t('production.separation.skimFatHint')}
                error={fatOrderError && s >= m && m > 0 ? fatOrderError : undefined}
              />
              <NumField
                label={t('production.separation.lossPct')}
                value={lossText}
                onChange={setLossText}
                suffix="%"
                hint={t('production.separation.lossHint')}
                error={r.issues.includes('loss_range') ? t('production.separation.issues.loss_range') : undefined}
              />
            </SepSection>
          </div>

          <SepSection title={t('production.separation.costBlock')} hint={t('production.separation.costHint')}>
            <Segmented<SeparationAllocation>
              options={[
                { value: 'skim_price', label: t('production.separation.methodSkimPrice') },
                { value: 'value', label: t('production.separation.methodValue') },
                { value: 'fat', label: t('production.separation.methodFat') },
              ]}
              value={method}
              onChange={setMethodStored}
            />
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t(allocationHintKey(method))}</p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
              <div className="space-y-4">
                {method === 'skim_price' && (
                  <NumField
                    label={t('production.separation.skimPrice')}
                    value={skimPriceText}
                    onChange={setSkimPriceText}
                    error={r.issues.includes('skim_over_cost') ? t('production.separation.issues.skim_over_cost') : undefined}
                  />
                )}
                {method === 'value' && (
                  <>
                    <NumField label={t('production.separation.creamRefPrice')} value={creamRefText} onChange={setCreamRefText} />
                    <NumField label={t('production.separation.skimRefPrice')} value={skimRefText} onChange={setSkimRefText} />
                  </>
                )}
                {method === 'fat' && (
                  <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('production.separation.methodFatHint')}</p>
                )}
              </div>
              <TotalsBox rows={costRows} />
            </div>
          </SepSection>

          <div className={cn(prodCardCls, 'p-5')}>
            <NoteField value={note} onChange={setNote} />
          </div>
        </div>

        <div className="xl:col-span-2 space-y-5 xl:sticky xl:top-5">
          <div className={cn(prodCardCls, 'p-5 space-y-5')}>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.separation.result')}</h2>
              <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">{t('production.separation.resultHint')}</p>
            </div>
            {calcReady ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <BigFigure
                    label={`${t('production.separation.creamLabel')} ≈`}
                    qty={r.cream}
                    unit={kg}
                    sub={`${formatPct(r.creamSharePct)}% ${t('production.separation.ofMilk')} · ${t('production.separation.fatLower')} ${formatPct(c)}%`}
                  />
                  <BigFigure
                    label={`${t('production.separation.skimLabel')} ≈`}
                    qty={r.skim}
                    unit={kg}
                    sub={`${milkQty > 0 ? formatPct((r.skim / milkQty) * 100) : '0'}% ${t('production.separation.ofMilk')} · ${t('production.separation.fatLower')} ${formatPct(s)}%`}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4 border-t border-gray-100 dark:border-gray-800 pt-4">
                  <BigFigure muted label={t('production.separation.milkQty')} qty={milkQty} unit={kg} sub={`${t('production.separation.fatLower')} ${formatPct(m)}%`} />
                  <BigFigure muted label={t('production.separation.lossLabel')} qty={Math.max(r.lossActual, 0)} unit={kg} sub={milkQty > 0 ? `${formatPct((Math.max(r.lossActual, 0) / milkQty) * 100)}%` : undefined} />
                </div>
                <FatBalance r={r} />
              </>
            ) : (
              <p className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {fatOrderError ?? t('production.separation.fillToSee')}
              </p>
            )}
          </div>

          {calcReady && (
            <SepSection title={t('production.separation.actualTitle')} hint={t('production.separation.actualHint')}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {([
                  { key: 'cream', label: t('production.separation.actualCream'), text: creamActualText, set: setCreamActualText, calc: r.creamCalc, actual: r.cream },
                  { key: 'skim', label: t('production.separation.actualSkim'), text: skimActualText, set: setSkimActualText, calc: r.skimCalc, actual: r.skim },
                ] as const).map(f => (
                  <NumField
                    key={f.key}
                    label={f.label}
                    value={f.text ?? toInputString(f.calc)}
                    onChange={v => f.set(v)}
                    suffix={kg}
                    hint={
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span>{t('production.separation.calcLower')}: {formatQty(f.calc)} {kg}</span>
                        {diffLabel(f.actual, f.calc) && <span className="text-amber-700 dark:text-amber-400">{diffLabel(f.actual, f.calc)}</span>}
                        {f.text !== null && (
                          <button type="button" onClick={() => f.set(null)} className="inline-flex items-center gap-1 font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                            <RotateCcw className="h-3 w-3" /> {t('production.separation.resetToCalc')}
                          </button>
                        )}
                      </span>
                    }
                  />
                ))}
              </div>
            </SepSection>
          )}

          {touched && issues.length > 0 && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
              <ul className="space-y-1 text-[13px] text-amber-800 dark:text-amber-300">
                {[...new Set(issues)].map(k => (
                  <li key={k} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t(k)}</li>
                ))}
              </ul>
            </div>
          )}

          <FormFooter onCancel={() => router.push('/separatsiya')} onSave={save} saving={saving} disabled={!valid} />
        </div>
      </div>
    </div>
  )
}
