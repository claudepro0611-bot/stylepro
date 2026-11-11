'use client'

// Building blocks of the "Sut qabuli" (raw milk intake) pages: settings
// hook, status badges, the big net/litre readout, the lab block (inputs,
// live threshold checks, price preview) and the cancel hook. Writes go
// through prod_record_milk_lab / prod_cancel_milk_intake only.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, Minus, Settings, X, type LucideIcon } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useSession } from '@/lib/session/SessionContext'
import { withDefaultPermissions, type PermissionKey, type Permissions } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { Segmented, prodCardCls, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { canCancelDocuments, formatQty } from '@/lib/production'
import { prodErrorText } from '@/lib/production-controls'
import {
  DEFAULT_MILK_SETTINGS, MILK_ANTIBIOTIC, antibioticKey, fetchMilkSettings, formatDensity, formatPct, milkStatusKey,
  parseDensity, parseOptional, pricingModeKey, previewAccepted, previewConditional, suggestDecision, thresholdChecks,
  type CheckState, type LabValues, type MilkAntibiotic, type MilkDecision, type MilkSettings, type ThresholdCheck,
} from '@/lib/milk'

/** Effective settings (defaults until the firm saves its own) + whether setup is complete. */
export function useMilkSettings() {
  const [settings, setSettings] = useState<MilkSettings>(DEFAULT_MILK_SETTINGS)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const s = await fetchMilkSettings(createClient())
    setSettings(s ?? DEFAULT_MILK_SETTINGS)
    setSaved(!!s)
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return { settings, saved, configured: saved && !!settings.milkItemId, loading, reload }
}

/** Owner bypasses permission checks; prod_* keys are fail-closed for everyone else. */
export function useHasPermission(key: PermissionKey): boolean {
  const { profile } = useSession()
  if (profile?.role === 'owner') return true
  return withDefaultPermissions(profile?.permissions as Partial<Permissions> | null)[key]
}

export function useIsOwnerOrAdmin(): boolean {
  const { profile } = useSession()
  return canCancelDocuments(profile?.role)
}

const pill = 'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'
const greenPill = 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400'
const amberPill = 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
const redPill = 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
const grayPill = 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'

export function MilkStatusBadge({ status }: { status: string }) {
  const { t } = useLanguage()
  const tone = status === 'accepted' ? greenPill
    : status === 'conditional' ? amberPill
      : status === 'rejected' ? redPill
        : grayPill
  return <span className={cn(pill, tone, status === 'cancelled' && 'line-through')}>{t(milkStatusKey(status))}</span>
}

export function AntibioticBadge({ value }: { value: string | null }) {
  const { t } = useLanguage()
  if (!value) return <span className="text-gray-400 dark:text-gray-500">—</span>
  const tone = value === 'negative' ? greenPill : value === 'positive' ? redPill : grayPill
  return <span className={cn(pill, tone)}>{t(antibioticKey(value))}</span>
}

export function DecisionBadge({ decision }: { decision: MilkDecision }) {
  const { t } = useLanguage()
  const tone = decision === 'accepted' ? greenPill : decision === 'conditional' ? amberPill : redPill
  return <span className={cn(pill, tone)}>{t(milkStatusKey(decision))}</span>
}

/** KPI card (same look as ReportKit KpiGrid) with an optional second line. */
export function MilkKpi({ label, value, sub, icon: Icon, tone }: {
  label: string
  value: string
  sub?: string
  icon: LucideIcon
  tone?: 'negative'
}) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
        <Icon className="h-4 w-4 text-gray-400" />
      </div>
      <p className="mt-3 text-[12.5px] text-gray-500 dark:text-gray-400">{label}</p>
      <p className={cn('mt-0.5 text-lg font-semibold tabular-nums', tone === 'negative' ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>{value}</p>
      {sub && <p className="text-[12px] tabular-nums text-gray-500 dark:text-gray-400">{sub}</p>}
    </div>
  )
}

export function MilkSetupBanner() {
  const { t } = useLanguage()
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{t('production.milk.setupTitle')}</p>
        <p className="text-[13px] text-amber-700 dark:text-amber-400">{t('production.milk.setupText')}</p>
      </div>
      <Link
        href="/sut-qabuli/sozlamalar"
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-3 text-sm font-medium text-white transition-colors"
      >
        <Settings className="h-3.5 w-3.5" /> {t('production.milk.setupAction')}
      </Link>
    </div>
  )
}

/** Large net kg / litres readout for the weighing step. */
export function NetReadout({ netKg, litres, error }: { netKg: number; litres: number | null; error?: string }) {
  const { t } = useLanguage()
  return (
    <div className={cn(prodCardCls, 'p-6 flex flex-col justify-center gap-5')}>
      <div>
        <p className="text-[13px] font-medium text-gray-500 dark:text-gray-400">{t('production.milk.net')}</p>
        <p className={cn('mt-1 text-4xl font-semibold tabular-nums tracking-tight', netKg > 0 ? 'text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600')}>
          {formatQty(netKg > 0 ? netKg : 0)} <span className="text-xl font-medium text-gray-400 dark:text-gray-500">{t('production.units.kg')}</span>
        </p>
        {error && <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
      <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
        <p className="text-[13px] font-medium text-gray-500 dark:text-gray-400">{t('production.milk.litres')}</p>
        <p className={cn('mt-1 text-2xl font-semibold tabular-nums', litres ? 'text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600')}>
          {litres ? formatQty(litres) : '0'} <span className="text-base font-medium text-gray-400 dark:text-gray-500">{t('production.units.l')}</span>
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lab block

export interface LabDraft {
  fat: string
  protein: string
  snf: string
  density: string
  acidity: string
  temperature: string
  antibiotic: MilkAntibiotic
}

export const EMPTY_LAB: LabDraft = { fat: '', protein: '', snf: '', density: '', acidity: '', temperature: '', antibiotic: 'not_tested' }

export function labValues(d: LabDraft): LabValues {
  return {
    fat: parseOptional(d.fat),
    protein: parseOptional(d.protein),
    snf: parseOptional(d.snf),
    density: parseDensity(d.density),
    acidity: parseOptional(d.acidity),
    temperature: parseOptional(d.temperature),
    antibiotic: d.antibiotic,
  }
}

/** p_data for prod_record_milk_lab (and the "lab" object of prod_create_milk_intake). */
export function labPayload(d: LabDraft, decision: MilkDecision, overridePrice: number | null, note: string) {
  const v = labValues(d)
  return {
    fat_pct: v.fat,
    protein_pct: v.protein,
    snf_pct: v.snf,
    density: v.density,
    acidity: v.acidity,
    temperature: v.temperature,
    antibiotic: v.antibiotic,
    decision,
    price_per_kg_override: decision === 'conditional' ? overridePrice : null,
    decision_note: note.trim() || null,
  }
}

const CHECK_LABEL: Record<ThresholdCheck['key'], 'production.milk.fatShort' | 'production.milk.densityShort' | 'production.milk.acidityShort' | 'production.milk.temperatureShort' | 'production.milk.antibiotic'> = {
  fat: 'production.milk.fatShort',
  density: 'production.milk.densityShort',
  acidity: 'production.milk.acidityShort',
  temperature: 'production.milk.temperatureShort',
  antibiotic: 'production.milk.antibiotic',
}

function checkValue(c: ThresholdCheck, v: LabValues): string {
  if (c.key === 'fat') return formatPct(v.fat)
  if (c.key === 'density') return formatDensity(v.density)
  if (c.key === 'acidity') return v.acidity === null ? '—' : `${v.acidity} °T`
  if (c.key === 'temperature') return v.temperature === null ? '—' : `${v.temperature} °C`
  return ''
}

const CHECK_ICON: Record<CheckState, LucideIcon> = { ok: Check, fail: X, missing: Minus }

/** Red/green chips per threshold + the suggested decision. */
export function ThresholdChecks({ values, settings, showSuggestion = true }: { values: LabValues; settings: MilkSettings; showSuggestion?: boolean }) {
  const { t } = useLanguage()
  const checks = thresholdChecks(values, settings)
  const suggestion = suggestDecision(checks)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {checks.map(c => {
          const Icon = CHECK_ICON[c.state]
          return (
            <span
              key={c.key}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                c.state === 'ok' && 'border-green-200 bg-green-50 text-green-700 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-400',
                c.state === 'fail' && 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400',
                c.state === 'missing' && 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400',
              )}
            >
              <Icon className="h-3 w-3" />
              {t(CHECK_LABEL[c.key])}
              {c.key === 'antibiotic'
                ? <span className="font-normal">{values.antibiotic ? t(antibioticKey(values.antibiotic)) : t('production.milk.checkMissing')}</span>
                : c.state === 'missing'
                  ? <span className="font-normal">{t('production.milk.checkMissing')}</span>
                  : <span className="font-normal tabular-nums">{checkValue(c, values)}</span>}
              {c.limit && <span className="font-normal opacity-70 tabular-nums">({c.limit})</span>}
            </span>
          )
        })}
      </div>
      {showSuggestion && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">{t('production.milk.suggested')}:</span>
          <DecisionBadge decision={suggestion} />
        </div>
      )}
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('production.milk.thresholdsAdvisory')}</p>
    </div>
  )
}

function PreviewRow({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 text-sm', strong && 'border-t border-gray-200 dark:border-gray-700 pt-2')}>
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className={cn('tabular-nums text-gray-900 dark:text-gray-100', strong ? 'text-base font-semibold' : 'font-medium')}>{children}</span>
    </div>
  )
}

/** Live price preview (mirrors the server formulas). */
export function PricePreviewBox({ netKg, values, settings, basePrice, basePriceIsDefault, decision, overridePrice }: {
  netKg: number
  values: LabValues
  settings: MilkSettings
  basePrice: number
  basePriceIsDefault: boolean
  decision: MilkDecision
  overridePrice: number | null
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const kg = t('production.units.kg')

  if (decision === 'rejected') {
    return (
      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-4 space-y-2">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.pricePreview')}</p>
        <p className="text-sm text-red-600 dark:text-red-400">{t('production.milk.rejectedNoStock')}</p>
      </div>
    )
  }

  const p = decision === 'conditional'
    ? previewConditional(netKg, overridePrice ?? 0)
    : previewAccepted(netKg, values, settings, basePrice)
  const missingQuality = decision === 'accepted' && p.creditedKg === null && netKg > 0

  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-4 space-y-2">
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.pricePreview')}</p>
      <PreviewRow label={t('production.milk.pricingMode')}>
        {decision === 'conditional' ? t('production.milk.status.conditional') : t(pricingModeKey(settings.pricingMode))}
      </PreviewRow>
      {decision === 'accepted' && (
        <PreviewRow label={t('production.milk.basePrice')}>
          {formatPrice(basePrice)}
          {basePriceIsDefault && <span className="ml-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">({t('production.milk.defaultPriceTag')})</span>}
        </PreviewRow>
      )}
      <PreviewRow label={t('production.milk.netKg')}>{formatQty(netKg > 0 ? netKg : 0)} {kg}</PreviewRow>
      <PreviewRow label={t('production.milk.credited')}>{p.creditedKg !== null ? `${formatQty(p.creditedKg)} ${kg}` : '—'}</PreviewRow>
      <PreviewRow label={t('production.milk.pricePerKg')}>{p.pricePerKg !== null ? formatPrice(p.pricePerKg) : '—'}</PreviewRow>
      <PreviewRow label={t('production.milk.amount')} strong>{p.amount !== null ? formatPrice(p.amount) : '—'}</PreviewRow>
      {missingQuality && (
        <p className="text-[12px] text-amber-600 dark:text-amber-400">
          {settings.pricingMode === 'fat_protein' ? t('production.milk.needFatProtein') : t('production.milk.needFat')}
        </p>
      )}
      {decision === 'accepted' && !(basePrice > 0) && (
        <p className="text-[12px] text-amber-600 dark:text-amber-400">{t('production.milk.noBasePrice')}</p>
      )}
      <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('production.milk.previewHint')}</p>
    </div>
  )
}

/** Lab inputs: fat, protein, SNF, density, acidity, temperature, antibiotic. */
export function LabFields({ draft, onChange, settings }: {
  draft: LabDraft
  onChange: (patch: Partial<LabDraft>) => void
  settings: MilkSettings
}) {
  const { t } = useLanguage()
  const field = (key: Exclude<keyof LabDraft, 'antibiotic'>, label: string, placeholder: string) => (
    <label className="block">
      <span className={prodLabelCls}>{label}</span>
      <input
        data-enter
        inputMode="decimal"
        value={draft[key]}
        onChange={e => onChange({ [key]: e.target.value })}
        placeholder={placeholder}
        className={cn(prodFieldCls, 'h-11 text-base text-right tabular-nums')}
      />
    </label>
  )
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {field('fat', t('production.milk.fat'), String(settings.baseFat))}
        {field('protein', t('production.milk.protein'), String(settings.baseProtein))}
        {field('snf', t('production.milk.snf'), '8.5')}
        {field('density', t('production.milk.density'), settings.defaultDensity.toFixed(3))}
        {field('acidity', t('production.milk.acidity'), '17')}
        {field('temperature', t('production.milk.temperature'), '6')}
      </div>
      <div>
        <span className={prodLabelCls}>{t('production.milk.antibiotic')}</span>
        <Segmented
          options={MILK_ANTIBIOTIC.map(a => ({ value: a, label: t(antibioticKey(a)) }))}
          value={draft.antibiotic}
          onChange={v => onChange({ antibiotic: v })}
        />
      </div>
    </div>
  )
}

/** Cancel an intake (owner/admin; prod_cancel_milk_intake re-checks role, permission and stock). */
export function useCancelMilkIntake(onDone: () => void) {
  const { t } = useLanguage()
  const canCancel = useIsOwnerOrAdmin()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function cancel(id: string) {
    if (!window.confirm(t('production.milk.cancelConfirm'))) return
    setBusyId(id)
    const { error } = await createClient().rpc('prod_cancel_milk_intake', { p_id: id })
    setBusyId(null)
    if (error) { toast.error(prodErrorText(t, error)); return }
    toast.success(t('production.milk.cancelled'))
    onDone()
  }

  return { canCancel, cancel, busyId }
}
