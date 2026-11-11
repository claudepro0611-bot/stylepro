'use client'

// New raw milk intake ("Tarozi"). Built for the plant gate: Enter walks the
// fields, Ctrl+Enter saves, net kg / litres are shown large and live. The
// lab block can be filled in right away (same transaction on the server) or
// later on /sut-qabuli/[id].

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { BackLink, NoteField, PageHeader, Segmented, prodCardCls, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { SupplierFormDialog, useProdSuppliers } from '@/components/production/SupplierKit'
import {
  EMPTY_LAB, LabFields, MilkSetupBanner, NetReadout, PricePreviewBox, ThresholdChecks, labPayload, labValues,
  useHasPermission, useMilkSettings, type LabDraft,
} from '@/components/production/MilkKit'
import { localDateTimeToIso, nowHm, parseDecimal, prodErrorKey, round3, warehousesFor } from '@/lib/production'
import {
  focusNextField, isMilkItemCandidate, litresOf, numInput, parseDensity, parseOverride, suggestDecision, thresholdChecks, type MilkDecision,
} from '@/lib/milk'

type ScaleMode = 'truck' | 'net'

const bigFieldCls = cn(prodFieldCls, 'h-12 text-lg font-medium text-right tabular-nums')

export default function NewMilkIntakePage() {
  const { t } = useLanguage()
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

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

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
  const effectiveDecision: MilkDecision = decision ?? suggestion
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
    const { data, error } = await createClient().rpc('prod_create_milk_intake', {
      p_data: {
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
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    const res = data as { id?: string; number?: number } | null
    toast.success(res?.number ? `${t('production.common.saved')}: #${res.number}` : t('production.common.saved'))
    if (andNew) {
      resetForNext()
      return
    }
    router.push(res?.id ? `/sut-qabuli/${res.id}` : '/sut-qabuli')
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
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
        <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('production.milk.keyboardHint')}</p>
      </div>

      {!settingsLoading && !configured && <MilkSetupBanner />}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5 items-stretch">
        <div className={cn(prodCardCls, 'p-6 space-y-5')}>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.weighing')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.date')}</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className={prodFieldCls} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.time')}</span>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
            </label>
            <div className="sm:col-span-2">
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
            <label className="block">
              <span className={prodLabelCls}>{t('production.milk.driver')}</span>
              <input data-enter value={driver} onChange={e => setDriver(e.target.value)} className={cn(prodFieldCls, 'h-12')} />
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
                    <p className={prodLabelCls}>{t('production.milk.decision')}</p>
                    <Segmented
                      options={[
                        { value: 'accepted' as MilkDecision, label: t('production.milk.accept') },
                        { value: 'conditional' as MilkDecision, label: t('production.milk.conditionalAccept') },
                        { value: 'rejected' as MilkDecision, label: t('production.milk.reject') },
                      ]}
                      value={effectiveDecision}
                      onChange={setDecision}
                    />
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

      <div className={cn(prodCardCls, 'p-6')}>
        <NoteField value={note} onChange={setNote} />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
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
    </div>
  )
}
