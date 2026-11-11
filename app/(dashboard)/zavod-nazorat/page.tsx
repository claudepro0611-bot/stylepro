'use client'

// "Nazorat sozlamalari": the production anti-fraud limits (prod_control_settings,
// migration 20261110000017). Owner only: proxy.ts redirects everyone else and
// prod_save_control_settings re-checks. Every change lands in the audit log.

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { FormFooter, PageHeader, Segmented, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { invalidateControls, useControls, useRole } from '@/components/production/ControlKit'
import { invalidateAccounting, useAccounting } from '@/components/production/AccountingKit'
import {
  CONTROL_ROLES, DEFAULT_CONTROL_SETTINGS, controlSettingsPayload, fillText, mapControlSettings,
  type ControlRole, type ControlSettings,
} from '@/lib/production-controls'
import { OVERHEAD_METHODS, overheadMethodKey, type OverheadMethod } from '@/lib/production-accounting'
import { prodErrorKey } from '@/lib/production'
import type { TranslationKey } from '@/lib/i18n/translations'

type NumKey = 'productionTolerancePct' | 'separationLossMaxPct' | 'separationFatTolerancePct' | 'processingMinRecoveryPct'
  | 'conditionalPriceMinPct' | 'backdateDaysStaff' | 'backdateDaysAdmin' | 'futureDays' | 'supplyIssueDailyLimit'
type BoolKey = 'labMustDiffer' | 'selfCancelAllowed' | 'paymentOverDebtAllowed'

const PCT_KEYS: NumKey[] = ['productionTolerancePct', 'separationLossMaxPct', 'separationFatTolerancePct', 'processingMinRecoveryPct', 'conditionalPriceMinPct']
const DAY_KEYS: NumKey[] = ['backdateDaysStaff', 'backdateDaysAdmin', 'futureDays']

/** prod_save_control_settings DETAIL (snake_case column) -> form key. */
const DETAIL_TO_KEY: Record<string, NumKey | BoolKey | 'manualLotPickRoles'> = {
  production_tolerance_pct: 'productionTolerancePct',
  separation_loss_max_pct: 'separationLossMaxPct',
  separation_fat_tolerance_pct: 'separationFatTolerancePct',
  processing_min_recovery_pct: 'processingMinRecoveryPct',
  conditional_price_min_pct: 'conditionalPriceMinPct',
  backdate_days_staff: 'backdateDaysStaff',
  backdate_days_admin: 'backdateDaysAdmin',
  future_days: 'futureDays',
  supply_issue_daily_limit: 'supplyIssueDailyLimit',
  lab_must_differ: 'labMustDiffer',
  self_cancel_allowed: 'selfCancelAllowed',
  payment_over_debt_allowed: 'paymentOverDebtAllowed',
  manual_lot_pick_roles: 'manualLotPickRoles',
}

const toText = (s: ControlSettings): Record<NumKey, string> => ({
  productionTolerancePct: String(s.productionTolerancePct),
  separationLossMaxPct: String(s.separationLossMaxPct),
  separationFatTolerancePct: String(s.separationFatTolerancePct),
  processingMinRecoveryPct: String(s.processingMinRecoveryPct),
  conditionalPriceMinPct: String(s.conditionalPriceMinPct),
  backdateDaysStaff: String(s.backdateDaysStaff),
  backdateDaysAdmin: String(s.backdateDaysAdmin),
  futureDays: String(s.futureDays),
  supplyIssueDailyLimit: s.supplyIssueDailyLimit === null ? '' : String(s.supplyIssueDailyLimit),
})

const numOf = (v: string) => {
  const n = Number(v.replace(',', '.').replace(/\s/g, ''))
  return v.trim() === '' || !Number.isFinite(n) ? null : n
}

/** Parsed value of one field, or undefined when invalid (null = empty limit). */
function parseField(key: NumKey, v: string): number | null | undefined {
  const n = numOf(v)
  if (key === 'supplyIssueDailyLimit') {
    if (v.trim() === '') return null
    return n !== null && n > 0 ? Math.round(n * 100) / 100 : undefined
  }
  if (n === null) return undefined
  if (PCT_KEYS.includes(key)) return n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : undefined
  if (!Number.isInteger(n)) return undefined
  if (key === 'futureDays') return n >= 0 && n <= 365 ? n : undefined
  return n >= 0 && n <= 3650 ? n : undefined
}

export default function ControlSettingsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const role = useRole()
  const controls = useControls()
  const [text, setText] = useState<Record<NumKey, string>>(toText(DEFAULT_CONTROL_SETTINGS))
  const [bools, setBools] = useState<Record<BoolKey, boolean>>({ labMustDiffer: false, selfCancelAllowed: false, paymentOverDebtAllowed: false })
  const [roles, setRoles] = useState<ControlRole[]>([...CONTROL_ROLES])
  const [saving, setSaving] = useState(false)
  const [badKey, setBadKey] = useState<string | null>(null)
  const isOwner = role === 'owner'
  // Accounting settings (migration 20261110000018): saved with the same button.
  const accounting = useAccounting()
  const [vatPayer, setVatPayer] = useState(false)
  const [overheadMethod, setOverheadMethod] = useState<OverheadMethod>('per_kg')
  const acctDirty = accounting.available
    && (vatPayer !== accounting.settings.vatPayer || overheadMethod !== accounting.settings.overheadMethod)

  useEffect(() => {
    if (accounting.loading) return
    setVatPayer(accounting.settings.vatPayer)
    setOverheadMethod(accounting.settings.overheadMethod)
  }, [accounting.loading, accounting.settings])

  function apply(s: ControlSettings) {
    setText(toText(s))
    setBools({ labMustDiffer: s.labMustDiffer, selfCancelAllowed: s.selfCancelAllowed, paymentOverDebtAllowed: s.paymentOverDebtAllowed })
    setRoles(s.manualLotPickRoles)
  }

  useEffect(() => {
    if (!controls.loading) apply(controls.settings)
  }, [controls.loading, controls.settings])

  const parsed = Object.fromEntries((Object.keys(text) as NumKey[]).map(k => [k, parseField(k, text[k])])) as Record<NumKey, number | null | undefined>
  const staffOverAdmin = typeof parsed.backdateDaysStaff === 'number' && typeof parsed.backdateDaysAdmin === 'number'
    && parsed.backdateDaysStaff > parsed.backdateDaysAdmin
  const valid = Object.values(parsed).every(v => v !== undefined) && !staffOverAdmin

  async function save() {
    if (!isOwner || !valid) { toast.error(t('productionErrors.invalid_input')); return }
    const next: ControlSettings = {
      ...controls.settings,
      productionTolerancePct: parsed.productionTolerancePct as number,
      separationLossMaxPct: parsed.separationLossMaxPct as number,
      separationFatTolerancePct: parsed.separationFatTolerancePct as number,
      processingMinRecoveryPct: parsed.processingMinRecoveryPct as number,
      conditionalPriceMinPct: parsed.conditionalPriceMinPct as number,
      backdateDaysStaff: parsed.backdateDaysStaff as number,
      backdateDaysAdmin: parsed.backdateDaysAdmin as number,
      futureDays: parsed.futureDays as number,
      supplyIssueDailyLimit: parsed.supplyIssueDailyLimit ?? null,
      ...bools,
      manualLotPickRoles: CONTROL_ROLES.filter(r => roles.includes(r)),
    }
    setSaving(true)
    setBadKey(null)
    const { data, error } = await createClient().rpc('prod_save_control_settings', { p_data: controlSettingsPayload(next) })
    if (error) {
      setSaving(false)
      const k = DETAIL_TO_KEY[error.details ?? '']
      if (k) { setBadKey(k); toast.error(`${t('prodControls.settings.invalidRange')}: ${t(`prodControls.settings.${k}` as TranslationKey)}`); return }
      toast.error(t(prodErrorKey(error)))
      return
    }
    invalidateControls()
    const fresh = data && typeof data === 'object' ? mapControlSettings(data as Parameters<typeof mapControlSettings>[0]) : null
    if (fresh) apply(fresh)
    await controls.reload()
    if (acctDirty) {
      const { error: acctError } = await createClient().rpc('prod_save_accounting_settings', {
        p_data: { vat_payer: vatPayer, overhead_method: overheadMethod },
      })
      if (acctError) { setSaving(false); toast.error(t(prodErrorKey(acctError))); return }
      invalidateAccounting()
      await accounting.reload()
    }
    setSaving(false)
    toast.success(t('prodControls.settings.saved'))
  }

  if (controls.loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!isOwner || !controls.available) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('prodControls.settings.title')} />
        <div className={cn(prodCardCls, 'flex items-center gap-3 p-6 text-sm text-gray-500 dark:text-gray-400')}>
          <ShieldAlert className="h-4 w-4 shrink-0 text-gray-400" />
          {!isOwner ? t('prodControls.ownerOnly') : t('prodControls.notAvailable')}
        </div>
      </div>
    )
  }

  const d = DEFAULT_CONTROL_SETTINGS
  const defaultLabel = (key: NumKey): string => {
    if (key === 'supplyIssueDailyLimit') return d.supplyIssueDailyLimit === null ? t('prodControls.settings.none') : formatPrice(d.supplyIssueDailyLimit)
    return String(d[key])
  }

  const numField = (key: NumKey, suffix?: string) => {
    const invalid = parsed[key] === undefined || badKey === key || (staffOverAdmin && (key === 'backdateDaysStaff' || key === 'backdateDaysAdmin'))
    return (
      <label key={key} className="block">
        <span className={prodLabelCls}>{t(`prodControls.settings.${key}` as TranslationKey)}</span>
        <div className="relative">
          <input
            inputMode="decimal"
            value={text[key]}
            onChange={e => { setText(prev => ({ ...prev, [key]: e.target.value })); setBadKey(null) }}
            placeholder={key === 'supplyIssueDailyLimit' ? t('prodControls.settings.none') : undefined}
            className={cn(prodFieldCls, 'text-right tabular-nums', suffix && 'pr-10', invalid && 'border-red-300 dark:border-red-500/50')}
          />
          {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{suffix}</span>}
        </div>
        <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">
          {t(`prodControls.settings.${key}Hint` as TranslationKey)} {fillText(t('prodControls.settings.defaultValue'), { value: defaultLabel(key) })}
        </span>
      </label>
    )
  }

  const boolField = (key: BoolKey) => (
    <label key={key} className="flex items-start justify-between gap-4 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t(`prodControls.settings.${key}` as TranslationKey)}</span>
        <span className="mt-0.5 block text-[11px] text-gray-400 dark:text-gray-500">
          {t(`prodControls.settings.${key}Hint` as TranslationKey)} {fillText(t('prodControls.settings.defaultValue'), { value: t(d[key] ? 'prodControls.settings.on' : 'prodControls.settings.off') })}
        </span>
      </span>
      <Switch checked={bools[key]} onCheckedChange={v => setBools(prev => ({ ...prev, [key]: v }))} />
    </label>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={t('prodControls.settings.title')} subtitle={t('prodControls.settings.subtitle')} />
        <button type="button" onClick={() => apply(DEFAULT_CONTROL_SETTINGS)} className={secondaryBtnCls}>
          <RotateCcw className="h-3.5 w-3.5" /> {t('prodControls.settings.resetDefaults')}
        </button>
      </div>

      <Section title={t('prodControls.settings.sectionTolerance')}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {PCT_KEYS.map(k => numField(k, '%'))}
        </div>
      </Section>

      <Section title={t('prodControls.settings.sectionDates')}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {DAY_KEYS.map(k => numField(k))}
        </div>
        {staffOverAdmin && <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">{t('prodControls.settings.staffOverAdmin')}</p>}
      </Section>

      <Section title={t('prodControls.settings.sectionRights')}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {boolField('labMustDiffer')}
          {boolField('selfCancelAllowed')}
        </div>
        <div className="mt-4">
          <span className={prodLabelCls}>{t('prodControls.settings.manualLotPickRoles')}</span>
          <div className="flex flex-wrap gap-2">
            {CONTROL_ROLES.map(r => (
              <label key={r} className={cn(
                'inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                roles.includes(r)
                  ? 'bg-white dark:bg-gray-900 shadow-sm border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100'
                  : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400',
              )}>
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={e => setRoles(prev => (e.target.checked ? [...prev, r] : prev.filter(x => x !== r)))}
                  className="h-3.5 w-3.5 accent-slate-900 dark:accent-gray-100"
                />
                {t(`prodControls.roles.${r}` as TranslationKey)}
              </label>
            ))}
          </div>
          <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">
            {t('prodControls.settings.manualLotPickRolesHint')} {fillText(t('prodControls.settings.defaultValue'), { value: CONTROL_ROLES.map(r => t(`prodControls.roles.${r}` as TranslationKey)).join(', ') })}
          </span>
        </div>
      </Section>

      <Section title={t('prodControls.settings.sectionMoney')}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {boolField('paymentOverDebtAllowed')}
          {numField('supplyIssueDailyLimit')}
        </div>
      </Section>

      {accounting.available && (
        <Section title={t('prodAcct.settings.title')}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <label className="flex items-start justify-between gap-4 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t('prodAcct.settings.vatPayer')}</span>
                <span className="mt-0.5 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodAcct.settings.vatPayerHint')}</span>
              </span>
              <Switch checked={vatPayer} onCheckedChange={setVatPayer} />
            </label>
            <div>
              <span className={prodLabelCls}>{t('prodAcct.settings.overheadMethod')}</span>
              <Segmented<OverheadMethod>
                value={overheadMethod}
                onChange={setOverheadMethod}
                options={OVERHEAD_METHODS.map(m => ({ value: m, label: t(overheadMethodKey(m)) }))}
              />
              <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodAcct.settings.overheadMethodHint')}</span>
            </div>
          </div>
        </Section>
      )}

      {controls.settings.updatedAt && (
        <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodControls.settings.updatedAt')}: {formatDateTime(controls.settings.updatedAt)}</p>
      )}

      <FormFooter onCancel={() => router.back()} onSave={save} saving={saving} disabled={!valid} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn(prodCardCls, 'p-4 sm:p-6')}>
      <h2 className="mb-4 text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {children}
    </div>
  )
}
