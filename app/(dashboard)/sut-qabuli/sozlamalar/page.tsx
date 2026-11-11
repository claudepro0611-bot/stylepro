'use client'

// Sut qabuli settings: raw milk item, default warehouse, base fat/protein,
// pricing mode, default price and density, acceptance thresholds. Everyone
// with prod_milk can view; only owner/admin can save (prod_save_milk_settings
// re-checks).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { BackLink, FormFooter, PageHeader, Segmented, prodCardCls, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useIsOwnerOrAdmin, useMilkSettings } from '@/components/production/MilkKit'
import { formatQty, prodErrorKey, warehousesFor } from '@/lib/production'
import {
  MILK_PRICING_MODES, isMilkItemCandidate, numInput, parseDensity, parseOptional, pricingModeKey, previewAccepted,
  type MilkPricingMode, type MilkSettings,
} from '@/lib/milk'

type NumKey = 'baseFat' | 'baseProtein' | 'defaultPricePerKg' | 'defaultDensity' | 'minFat' | 'minDensity' | 'maxAcidity' | 'maxTemperature'

export default function MilkSettingsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { items, warehouses, loading: refsLoading } = useProdRefs()
  const { settings, loading, reload } = useMilkSettings()
  const canEdit = useIsOwnerOrAdmin()

  const [milkItemId, setMilkItemId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [mode, setMode] = useState<MilkPricingMode>('fat')
  const [nums, setNums] = useState<Record<NumKey, string>>({
    baseFat: '', baseProtein: '', defaultPricePerKg: '', defaultDensity: '', minFat: '', minDensity: '', maxAcidity: '', maxTemperature: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (loading) return
    setMilkItemId(settings.milkItemId ?? '')
    setWarehouseId(settings.defaultWarehouseId ?? '')
    setMode(settings.pricingMode)
    setNums({
      baseFat: numInput(settings.baseFat),
      baseProtein: numInput(settings.baseProtein),
      defaultPricePerKg: numInput(settings.defaultPricePerKg),
      defaultDensity: settings.defaultDensity.toFixed(3),
      minFat: numInput(settings.minFat),
      minDensity: settings.minDensity.toFixed(3),
      maxAcidity: numInput(settings.maxAcidity),
      maxTemperature: numInput(settings.maxTemperature),
    })
  }, [loading, settings])

  const milkItems = items.filter(isMilkItemCandidate)
  const rawWarehouses = warehousesFor(warehouses, ['raw'])

  const parsed = {
    baseFat: parseOptional(nums.baseFat),
    baseProtein: parseOptional(nums.baseProtein),
    defaultPricePerKg: parseOptional(nums.defaultPricePerKg),
    defaultDensity: parseDensity(nums.defaultDensity),
    minFat: parseOptional(nums.minFat),
    minDensity: parseDensity(nums.minDensity),
    maxAcidity: parseOptional(nums.maxAcidity),
    maxTemperature: parseOptional(nums.maxTemperature),
  }
  const valid = Object.values(parsed).every(v => v !== null) && (parsed.baseFat ?? 0) > 0 && (parsed.baseProtein ?? 0) > 0

  // Worked example with the values on screen: 100 kg, 3.8% fat, 3.2% protein.
  const draft: MilkSettings = {
    ...settings,
    pricingMode: mode,
    baseFat: parsed.baseFat || settings.baseFat,
    baseProtein: parsed.baseProtein || settings.baseProtein,
  }
  const exampleValues = { fat: 3.8, protein: 3.2, snf: null, density: null, acidity: null, temperature: null, antibiotic: null }
  const example = previewAccepted(100, exampleValues, draft, parsed.defaultPricePerKg ?? 0, mode)
  const kg = t('production.units.kg')
  const exampleInput = mode === 'flat'
    ? `100 ${kg}`
    : mode === 'fat'
      ? `100 ${kg}, 3.8% ${t('production.milk.fatShort').toLowerCase()}`
      : `100 ${kg}, 3.8% / 3.2%`

  function setNum(key: NumKey, value: string) {
    setNums(prev => ({ ...prev, [key]: value }))
  }

  async function save() {
    if (!canEdit || !valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const { error } = await createClient().rpc('prod_save_milk_settings', {
      p_data: {
        milk_item_id: milkItemId || null,
        default_warehouse_id: warehouseId || null,
        base_fat: parsed.baseFat,
        base_protein: parsed.baseProtein,
        pricing_mode: mode,
        default_price_per_kg: parsed.defaultPricePerKg,
        default_density: parsed.defaultDensity,
        min_fat: parsed.minFat,
        min_density: parsed.minDensity,
        max_acidity: parsed.maxAcidity,
        max_temperature: parsed.maxTemperature,
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    await reload()
  }

  if (loading || refsLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }

  const numField = (key: NumKey, label: string, hint?: string) => (
    <label className="block">
      <span className={prodLabelCls}>{label}</span>
      <input
        inputMode="decimal"
        value={nums[key]}
        disabled={!canEdit}
        onChange={e => setNum(key, e.target.value)}
        className={cn(prodFieldCls, 'text-right tabular-nums', parsed[key] === null && nums[key] !== '' && 'border-red-300 dark:border-red-500/50')}
      />
      {hint && <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>}
    </label>
  )

  return (
    <div className="space-y-5">
      <BackLink href="/sut-qabuli" label={t('production.milk.title')} />
      <PageHeader title={t('production.milk.settingsTitle')} subtitle={t('production.milk.settingsSubtitle')} />

      {!canEdit && (
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
          {t('production.milk.settingsReadOnly')}
        </div>
      )}

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4')}>
        <label className="block sm:col-span-2">
          <span className={prodLabelCls}>{t('production.milk.item')}</span>
          <select value={milkItemId} disabled={!canEdit} onChange={e => setMilkItemId(e.target.value)} className={prodFieldCls}>
            <option value="">{t('production.milk.notSelected')}</option>
            {milkItems.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">
            {milkItems.length === 0 ? t('production.milk.noRawItems') : t('production.milk.itemHint')}
          </span>
        </label>
        <label className="block sm:col-span-2">
          <span className={prodLabelCls}>{t('production.milk.defaultWarehouse')}</span>
          <select value={warehouseId} disabled={!canEdit} onChange={e => setWarehouseId(e.target.value)} className={prodFieldCls}>
            <option value="">{t('production.milk.notSelected')}</option>
            {rawWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        {numField('defaultPricePerKg', t('production.milk.defaultPrice'), t('production.milk.defaultPriceHint'))}
        {numField('defaultDensity', t('production.milk.defaultDensity'), t('production.milk.densityHint'))}
      </div>

      <div className={cn(prodCardCls, 'p-6 space-y-5')}>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.pricingMode')}</h2>
        <Segmented
          options={MILK_PRICING_MODES.map(m => ({ value: m, label: t(pricingModeKey(m)) }))}
          value={mode}
          onChange={v => { if (canEdit) setMode(v) }}
        />
        <p className="text-sm text-gray-600 dark:text-gray-400">{t(`production.milk.modeHints.${mode}` as const)}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {numField('baseFat', t('production.milk.baseFat'))}
          {numField('baseProtein', t('production.milk.baseProtein'))}
        </div>
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm">
          <span className="text-gray-500 dark:text-gray-400">{t('production.milk.example')}: </span>
          <span className="tabular-nums text-gray-900 dark:text-gray-100">
            {exampleInput} → <span className="font-semibold">{example.creditedKg !== null ? formatQty(example.creditedKg) : '—'}</span> {t('production.milk.credited').toLowerCase()}
            {(parsed.defaultPricePerKg ?? 0) > 0 && example.amount !== null && (
              <span className="text-gray-500 dark:text-gray-400"> · {formatPrice(example.amount)}</span>
            )}
          </span>
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-6 space-y-5')}>
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.thresholds')}</h2>
          <p className="mt-0.5 text-[12px] text-gray-400 dark:text-gray-500">{t('production.milk.thresholdsAdvisory')}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {numField('minFat', t('production.milk.minFat'))}
          {numField('minDensity', t('production.milk.minDensity'))}
          {numField('maxAcidity', t('production.milk.maxAcidity'))}
          {numField('maxTemperature', t('production.milk.maxTemperature'))}
        </div>
        <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('production.milk.antibioticRule')}</p>
      </div>

      {canEdit && <FormFooter onCancel={() => router.push('/sut-qabuli')} onSave={save} saving={saving} disabled={!valid} />}
    </div>
  )
}
