'use client'

// New raw milk intake ("Tarozi"). Built for the plant gate: Enter walks the
// fields, Ctrl+Enter saves, net kg / litres are shown large and live. The
// lab block can be filled in right away (same transaction on the server) or
// later on /sut-qabuli/[id]. Tablet mode (prefs.tablet_mode or ?tablet=1)
// renders the full-screen touch weigh station instead. Network failures go to
// the offline queue; the form state is autosaved as a local draft.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Tablet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { BackLink, MoreFields, NoteField, PageHeader, Segmented, prodCardCls, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { SupplierFormDialog, useProdSuppliers } from '@/components/production/SupplierKit'
import {
  EMPTY_LAB, LabFields, MilkSetupBanner, NetReadout, PricePreviewBox, ThresholdChecks, labPayload, labValues,
  useHasPermission, useMilkSettings, type LabDraft,
} from '@/components/production/MilkKit'
import { ControlHint, DocDateInput, useApprovalRetry, useProdErrorText } from '@/components/production/ControlKit'
import { DraftBanner } from '@/components/production/DraftBanner'
import { OfflineQueueBar, saveIntakeOrQueue } from '@/components/production/MilkOffline'
import { TabletWeighStation } from '@/components/production/MilkTablet'
import { useTabletMode } from '@/components/production/TabletKit'
import { Term } from '@/components/production/Term'
import { useFormDraft } from '@/lib/useFormDraft'
import { useMilkOfflineQueue } from '@/lib/milk-offline'
import { fillText } from '@/lib/production-controls'
import { formatQty, localDateTimeToIso, nowHm, parseDecimal, round3, warehousesFor } from '@/lib/production'
import {
  focusNextField, isMilkItemCandidate, litresOf, numInput, parseDensity, parseOverride, suggestDecision, thresholdChecks, type MilkDecision,
} from '@/lib/milk'

type ScaleMode = 'truck' | 'net'

const bigFieldCls = cn(prodFieldCls, 'h-12 text-lg font-medium text-right tabular-nums')

export default function NewMilkIntakePage() {
  const router = useRouter()
  const tablet = useTabletMode()
  if (tablet === null) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (tablet) return <TabletWeighStation onExit={() => router.push('/sut-qabuli')} />
  return <MilkIntakeForm />
}

interface MilkDraft {
  date: string; time: string; supplierId: string; warehouseId: string; itemId: string; vehicleNo: string; driver: string
  scaleMode: ScaleMode; gross: string; tare: string; net: string; density: string; note: string
  labNow: boolean; lab: LabDraft; decision: MilkDecision | null; overridePrice: string; decisionNote: string
}

function MilkIntakeForm() {
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { items, warehouses } = useProdRefs()
  const { suppliers, reload: reloadSuppliers } = useProdSuppliers()
  const { settings, configured, loading: settingsLoading } = useMilkSettings()
  const canCreateSupplier = useHasPermission('prod_suppliers')
  const canLab = useHasPermission('prod_lab')

  const rootRef = useRef<HTMLDivElement>(null)
  const vehicleRef = useRef<HTMLInputElement>(null)

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [supplierFormOpen, setSupplierFormOpen] = useState(false)
  const [warehouseId, setWarehouseId] = useState('')
  const [itemId, setItemId] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [driver, setDriver] = useState('')
  const [scaleMode, setScaleMode] = useState<ScaleMode>('truck')
  const [gross, setGross] = useState('')
  const [tare, setTare] = useState('')
  const [net, setNet] = useState('')
  const [density, setDensity] = useState('')
  const [note, setNote] = useState('')
  const [labNow, setLabNow] = useState(false)
  const [lab, setLab] = useState<LabDraft>(EMPTY_LAB)
  const [decision, setDecision] = useState<MilkDecision | null>(null)
  const [overridePrice, setOverridePrice] = useState('')
  const [decisionNote, setDecisionNote] = useState('')
  const [saving, setSaving] = useState(false)

  const onPosted = useCallback((n: number) => toast.success(fillText(t('prodOps.offline.synced'), { n })), [t])
  const queue = useMilkOfflineQueue(onPosted)
  const draftState: MilkDraft = {
    date, time, supplierId, warehouseId, itemId, vehicleNo, driver, scaleMode, gross, tare, net, density, note,
    labNow, lab, decision, overridePrice, decisionNote,
  }
  const draft = useFormDraft<MilkDraft>('milk-intake', draftState, d => {
    setDate(d.date); setTime(d.time); setSupplierId(d.supplierId); setWarehouseId(d.warehouseId); setItemId(d.itemId)
    setVehicleNo(d.vehicleNo); setDriver(d.driver); setScaleMode(d.scaleMode); setGross(d.gross); setTare(d.tare); setNet(d.net)
    setDensity(d.density); setNote(d.note); setLabNow(d.labNow); setLab({ ...EMPTY_LAB, ...d.lab }); setDecision(d.decision)
    setOverridePrice(d.overridePrice); setDecisionNote(d.decisionNote)
  }, {
    ready: !settingsLoading,
    isEmpty: d => !d.supplierId && !d.gross && !d.tare && !d.net && !d.vehicleNo && !d.driver && !d.note,
  })

  // Client clock only (avoids a server/client hydration mismatch); the
  // supplier picker gets focus first (date / time default to now).
  useEffect(() => {
    setDate(localYmd())
    setTime(nowHm())
    const timer = window.setTimeout(() => rootRef.current?.querySelector<HTMLElement>('[data-autofocus] button')?.focus(), 50)
    return () => window.clearTimeout(timer)
  }, [])

  // Defaults from settings once they load (the user may change them).
  const [defaultsApplied, setDefaultsApplied] = useState(false)
  useEffect(() => {
    if (settingsLoading || defaultsApplied) return
    setWarehouseId(w => w || settings.defaultWarehouseId || '')
    setItemId(i => i || settings.milkItemId || '')
    setDensity(d => d || settings.defaultDensity.toFixed(3))
    setDefaultsApplied(true)
  }, [settingsLoading, defaultsApplied, settings])

  const rawWarehouses = warehousesFor(warehouses, ['raw'])
  const rawItems = items.filter(isMilkItemCandidate)

  const supplier = suppliers.find(s => s.id === supplierId)
  const basePrice = supplier?.milkPricePerKg ?? settings.defaultPricePerKg
  const basePriceIsDefault = supplier?.milkPricePerKg == null

  const supplierOptions = useMemo(() => suppliers
    .filter(s => s.isActive)
    .map(s => ({
      value: s.id,
      label: s.name,
      sublabel: s.milkPricePerKg != null ? `${formatPrice(s.milkPricePerKg)} / ${t('production.units.kg')}` : undefined,
    })), [suppliers, formatPrice, t])

  const grossNum = parseDecimal(gross)
  const tareNum = parseDecimal(tare)
  const tareExceeds = scaleMode === 'truck' && tareNum > 0 && tareNum > grossNum
  const netKg = scaleMode === 'truck' ? (tareExceeds ? 0 : round3(grossNum - tareNum)) : round3(parseDecimal(net))
  const densityNum = parseDensity(density)
  const litres = litresOf(netKg, densityNum)

  const values = labValues(lab)
  const suggestion = suggestDecision(thresholdChecks(values, settings))
  // Antibiotic positive can never be accepted (server: forbidden 'antibiotic').
  const antibioticPositive = lab.antibiotic === 'positive'
  const chosenDecision: MilkDecision = decision ?? suggestion
  const effectiveDecision: MilkDecision = antibioticPositive && chosenDecision === 'accepted' ? 'rejected' : chosenDecision
  const overrideNum = parseOverride(overridePrice)

  const weighingValid = !!supplierId && !!warehouseId && !!itemId && netKg > 0 && !tareExceeds
  const labValid = !labNow
    || (effectiveDecision === 'accepted')
    || (effectiveDecision === 'conditional' && overrideNum !== null)
    || (effectiveDecision === 'rejected' && !!decisionNote.trim())
  const valid = weighingValid && labValid

  function resetForNext() {
    setSupplierId('')
    setVehicleNo('')
    setDriver('')
    setGross('')
    setTare('')
    setNet('')
    setDensity(settings.defaultDensity.toFixed(3))
    setNote('')
    setLab(EMPTY_LAB)
    setDecision(null)
    setOverridePrice('')
    setDecisionNote('')
    setTime(nowHm())
  }

  async function save(andNew = false) {
    if (saving) return
    if (!valid) {
      if (labNow && effectiveDecision === 'conditional' && overrideNum === null) toast.error(t('production.milk.priceRequired'))
      else if (labNow && effectiveDecision === 'rejected' && !decisionNote.trim()) toast.error(t('production.milk.reasonRequired'))
      else toast.error(t('productionErrors.invalid_input'))
      return
    }
    setSaving(true)
    const weights = scaleMode === 'truck'
      ? { gross_kg: round3(grossNum), tare_kg: round3(tareNum) }
      : { net_kg: netKg }
    const payload = {
      intake_date: localDateTimeToIso(date, time),
      supplier_id: supplierId,
      warehouse_id: warehouseId,
      item_id: itemId,
      vehicle_no: vehicleNo.trim() || null,
      driver: driver.trim() || null,
      ...weights,
      density: densityNum,
      note: note.trim() || null,
      ...(labNow && canLab ? { lab: labPayload(lab, effectiveDecision, overrideNum, decisionNote) } : {}),
    }
    // Network failure: kept in the offline queue (lib/milk-offline.ts); the form is ready for the next truck.
    const res = await saveIntakeOrQueue(approval, queue, payload, supplier?.name ?? '')
    setSaving(false)
    if (res.kind === 'cancelled') return
    if (res.kind === 'error') { toast.error(errorText(res.error)); return }
    draft.clear()
    if (res.kind === 'queued') {
      toast.warning(t('prodOps.offline.savedOffline'))
      resetForNext()
      return
    }
    toast.success(res.number ? `${t('production.common.saved')}: #${res.number}` : t('production.common.saved'))
    if (andNew) {
      resetForNext()
      return
    }
    router.push(res.id ? `/sut-qabuli/${res.id}` : '/sut-qabuli')
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      save()
      return
    }
    if (e.key !== 'Enter') return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      save()
      return
    }
    if (e.target instanceof HTMLTextAreaElement) return
    if (focusNextField(rootRef.current, e.target)) e.preventDefault()
  }

  return (
    <div ref={rootRef} className="space-y-5" onKeyDown={onKeyDown}>
      <BackLink href="/sut-qabuli" label={t('production.milk.title')} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader title={t('production.milk.newTitle')} />
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('production.milk.keyboardHint')}</p>
          <button
            type="button"
            onClick={() => router.push('/sut-qabuli/yangi?tablet=1')}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <Tablet className="h-3.5 w-3.5" /> {t('prodOps.tablet.enter')}
          </button>
        </div>
      </div>

      <DraftBanner offer={draft.offer} onRestore={draft.restore} onDiscard={draft.discard} />
      <OfflineQueueBar queue={queue} />
      {!settingsLoading && !configured && <MilkSetupBanner />}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5 items-stretch">
        <div className={cn(prodCardCls, 'p-6 space-y-5')}>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.weighing')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.date')}</span>
              <DocDateInput value={date} onChange={setDate} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.time')}</span>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
            </label>
            <div className="sm:col-span-2" data-autofocus>
              <span className={prodLabelCls}>{t('production.milk.supplier')}</span>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SearchSelect
                    options={supplierOptions}
                    value={supplierId}
                    onChange={id => { setSupplierId(id); setTimeout(() => vehicleRef.current?.focus(), 0) }}
                    placeholder={t('production.suppliers.selectSupplier')}
                  />
                </div>
                {canCreateSupplier && (
                  <button
                    type="button"
                    onClick={() => setSupplierFormOpen(true)}
                    title={t('production.suppliers.new')}
                    className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" /> {t('production.suppliers.quickNew')}
                  </button>
                )}
              </div>
              {supplier && (
                <span className="mt-1 block text-[12px] text-gray-500 dark:text-gray-400">
                  {t('production.milk.supplierPrice')}: <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">{formatPrice(basePrice)}</span> / {t('production.units.kg')}
                  {basePriceIsDefault && <span className="ml-1 text-gray-400 dark:text-gray-500">({t('production.milk.defaultPriceTag')})</span>}
                </span>
              )}
            </div>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.warehouse')}</span>
              <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={prodFieldCls}>
                <option value="">{t('production.common.selectWarehouse')}</option>
                {rawWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.milk.item')}</span>
              <select value={itemId} onChange={e => setItemId(e.target.value)} className={prodFieldCls}>
                <option value="">{t('production.milk.selectItem')}</option>
                {rawItems.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4 items-end">
            <label className="block">
              <span className={prodLabelCls}>{t('production.milk.vehicleNo')}</span>
              <input ref={vehicleRef} data-enter value={vehicleNo} onChange={e => setVehicleNo(e.target.value.toUpperCase())} placeholder="01 A 123 BC" className={cn(prodFieldCls, 'h-12 uppercase')} />
            </label>
            <div className="sm:col-span-2 lg:col-span-1">
              <span className={prodLabelCls}>{t('production.milk.weighing')}</span>
              <Segmented
                className="h-12 items-center"
                options={[
                  { value: 'truck' as ScaleMode, label: t('production.milk.scaleTruck') },
                  { value: 'net' as ScaleMode, label: t('production.milk.scaleNet') },
                ]}
                value={scaleMode}
                onChange={setScaleMode}
              />
            </div>
            {scaleMode === 'truck' ? (
              <>
                <label className="block">
                  <span className={prodLabelCls}>{t('production.milk.gross')}</span>
                  <input data-enter inputMode="decimal" value={gross} onChange={e => setGross(e.target.value)} placeholder="0" className={bigFieldCls} />
                </label>
                <label className="block">
                  <span className={prodLabelCls}>{t('production.milk.tare')}</span>
                  <input data-enter inputMode="decimal" value={tare} onChange={e => setTare(e.target.value)} placeholder="0" className={cn(bigFieldCls, tareExceeds && 'border-red-300 dark:border-red-500/50')} />
                </label>
              </>
            ) : (
              <label className="block lg:col-span-2">
                <span className={prodLabelCls}>{t('production.milk.netKg')}</span>
                <input data-enter inputMode="decimal" value={net} onChange={e => setNet(e.target.value)} placeholder="0" className={bigFieldCls} />
              </label>
            )}
            <label className="block">
              <span className={prodLabelCls}>{t('production.milk.density')}</span>
              <input data-enter inputMode="decimal" value={density} onChange={e => setDensity(e.target.value)} placeholder={settings.defaultDensity.toFixed(3)} className={bigFieldCls} />
              <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.milk.densityHint')}</span>
            </label>
          </div>

          <MoreFields active={!!driver || !!note}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <label className="block">
                <span className={prodLabelCls}>{t('production.milk.driver')}</span>
                <input data-enter value={driver} onChange={e => setDriver(e.target.value)} className={prodFieldCls} />
              </label>
              <div className="sm:col-span-2"><NoteField value={note} onChange={setNote} /></div>
            </div>
          </MoreFields>
        </div>

        <NetReadout netKg={netKg} litres={litres} error={tareExceeds ? t('production.milk.tareExceeds') : undefined} />
      </div>

      {canLab && (
        <div className={cn(prodCardCls, 'p-6 space-y-5')}>
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.labNow')}</span>
            <Switch checked={labNow} onCheckedChange={v => { setLabNow(v); if (v) setLab(l => (l.density ? l : { ...l, density: density })) }} />
          </label>
          {labNow && (
            <>
              <LabFields draft={lab} onChange={patch => setLab(l => ({ ...l, ...patch }))} settings={settings} />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
                <div className="space-y-4">
                  <div>
                    <p className={prodLabelCls}>{t('production.milk.checks')}</p>
                    <ThresholdChecks values={values} settings={settings} />
                  </div>
                  <div>
                    <p className={prodLabelCls}><Term k="shartliQabul">{t('production.milk.decision')}</Term></p>
                    <Segmented
                      options={[
                        { value: 'accepted' as MilkDecision, label: t('production.milk.accept'), disabled: antibioticPositive, title: antibioticPositive ? t('prodControls.hints.antibioticAccept') : undefined },
                        { value: 'conditional' as MilkDecision, label: t('production.milk.conditionalAccept') },
                        { value: 'rejected' as MilkDecision, label: t('production.milk.reject') },
                      ]}
                      value={effectiveDecision}
                      onChange={setDecision}
                    />
                    {antibioticPositive && <ControlHint className="mt-2">{t('prodControls.hints.antibioticAccept')}</ControlHint>}
                  </div>
                  {effectiveDecision === 'conditional' && (
                    <label className="block max-w-xs">
                      <span className={prodLabelCls}>{t('production.milk.conditionalPrice')}</span>
                      <input data-enter inputMode="decimal" value={overridePrice} onChange={e => setOverridePrice(e.target.value)} placeholder={numInput(basePrice) || '0'} className={cn(prodFieldCls, 'h-11 text-right tabular-nums')} />
                    </label>
                  )}
                  <NoteField
                    value={decisionNote}
                    onChange={setDecisionNote}
                    label={effectiveDecision === 'rejected' ? t('production.milk.rejectReason') : t('production.milk.decisionNote')}
                  />
                </div>
                <PricePreviewBox
                  netKg={netKg}
                  values={values}
                  settings={settings}
                  basePrice={basePrice}
                  basePriceIsDefault={basePriceIsDefault}
                  decision={effectiveDecision}
                  overridePrice={overrideNum}
                />
              </div>
            </>
          )}
        </div>
      )}

      <div className="sticky bottom-0 z-20 -mx-6 -mb-5 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-gray-100 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 px-6 py-3 backdrop-blur">
        <div className="mr-auto text-sm">
          <span className="text-gray-500 dark:text-gray-400">{t('production.milk.netKg')}: </span>
          <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatQty(netKg)} {t('production.units.kg')}</span>
        </div>
        <span className="hidden text-[12px] text-gray-400 dark:text-gray-500 lg:inline">{t('prodUx.saveHint')}</span>
        <Button variant="outline" onClick={() => router.push('/sut-qabuli')}>{t('production.common.cancel')}</Button>
        <Button variant="outline" onClick={() => save(true)} disabled={saving || !valid}>{t('production.milk.saveAndNew')}</Button>
        <Button onClick={() => save()} disabled={saving || !valid} loading={saving}>{t('production.common.save')}</Button>
      </div>

      <SupplierFormDialog
        open={supplierFormOpen}
        onOpenChange={setSupplierFormOpen}
        supplier={null}
        onSaved={async newId => {
          setSupplierFormOpen(false)
          await reloadSuppliers()
          if (newId) setSupplierId(newId)
        }}
      />
      {approval.dialog}
    </div>
  )
}
