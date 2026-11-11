// Raw milk intake ("Sut qabuli") for production firms: types, defaults,
// threshold checks and the client-side price preview. Reads go straight to
// the RLS-scoped tables; every write goes through prod_save_milk_settings /
// prod_create_milk_intake / prod_record_milk_lab / prod_cancel_milk_intake.
// The server recomputes everything (net, litres, credited kg, amount); the
// numbers here are only a live preview that mirrors the same formulas.

import type { Database } from '@/lib/database.types'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { createClient } from '@/lib/supabase/client'
import { round2, round3 } from '@/lib/production'

type Client = ReturnType<typeof createClient>

export const MILK_PRICING_MODES = ['flat', 'fat', 'fat_protein'] as const
export type MilkPricingMode = typeof MILK_PRICING_MODES[number]

export const MILK_STATUSES = ['weighed', 'accepted', 'conditional', 'rejected', 'cancelled'] as const
export type MilkStatus = typeof MILK_STATUSES[number]

export const MILK_ANTIBIOTIC = ['negative', 'positive', 'not_tested'] as const
export type MilkAntibiotic = typeof MILK_ANTIBIOTIC[number]

export type MilkDecision = 'accepted' | 'conditional' | 'rejected'

export interface MilkSettings {
  milkItemId: string | null
  defaultWarehouseId: string | null
  baseFat: number
  baseProtein: number
  pricingMode: MilkPricingMode
  defaultPricePerKg: number
  defaultDensity: number
  minFat: number
  minDensity: number
  maxAcidity: number
  maxTemperature: number
}

/** Same defaults as the prod_milk_settings column defaults. */
export const DEFAULT_MILK_SETTINGS: MilkSettings = {
  milkItemId: null,
  defaultWarehouseId: null,
  baseFat: 3.4,
  baseProtein: 3.0,
  pricingMode: 'fat',
  defaultPricePerKg: 0,
  defaultDensity: 1.03,
  minFat: 2.8,
  minDensity: 1.027,
  maxAcidity: 19,
  maxTemperature: 10,
}

export type MilkIntakeRow = Database['public']['Tables']['prod_milk_intakes']['Row']

export function toPricingMode(v: unknown): MilkPricingMode {
  return (MILK_PRICING_MODES as readonly unknown[]).includes(v) ? (v as MilkPricingMode) : 'fat'
}

export function toMilkStatus(v: unknown): MilkStatus {
  return (MILK_STATUSES as readonly unknown[]).includes(v) ? (v as MilkStatus) : 'weighed'
}

export function pricingModeKey(mode: string): TranslationKey {
  return `production.milk.modes.${toPricingMode(mode)}` as TranslationKey
}

export function milkStatusKey(status: string): TranslationKey {
  return `production.milk.status.${toMilkStatus(status)}` as TranslationKey
}

export function antibioticKey(v: string): TranslationKey {
  return (MILK_ANTIBIOTIC as readonly string[]).includes(v)
    ? (`production.milk.antibioticValues.${v}` as TranslationKey)
    : 'production.milk.antibioticValues.not_tested'
}

/**
 * The settings row, or null when the firm never saved settings (callers fall
 * back to DEFAULT_MILK_SETTINGS and show the setup banner).
 */
export async function fetchMilkSettings(supabase: Client): Promise<MilkSettings | null> {
  const { data } = await supabase.from('prod_milk_settings').select('*').maybeSingle()
  if (!data) return null
  const num = (v: number | null | undefined, d: number) => (v === null || v === undefined ? d : Number(v))
  const D = DEFAULT_MILK_SETTINGS
  return {
    milkItemId: data.milk_item_id,
    defaultWarehouseId: data.default_warehouse_id,
    baseFat: num(data.base_fat, D.baseFat),
    baseProtein: num(data.base_protein, D.baseProtein),
    pricingMode: toPricingMode(data.pricing_mode),
    defaultPricePerKg: num(data.default_price_per_kg, D.defaultPricePerKg),
    defaultDensity: num(data.default_density, D.defaultDensity),
    minFat: num(data.min_fat, D.minFat),
    minDensity: num(data.min_density, D.minDensity),
    maxAcidity: num(data.max_acidity, D.maxAcidity),
    maxTemperature: num(data.max_temperature, D.maxTemperature),
  }
}

/** "" -> null; "3,8" -> 3.8. Allows 0 (acidity/temperature may legitimately be low). */
export function parseOptional(value: string): number | null {
  const s = value.replace(',', '.').replace(/\s/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Density in g/cm3. Labs often write lactodensimeter degrees ("28" = 1.028),
 * so values between 20 and 40 are converted.
 */
export function parseDensity(value: string): number | null {
  const n = parseOptional(value)
  if (n === null || n === 0) return null
  if (n >= 20 && n <= 40) return Math.round((1 + n / 1000) * 10000) / 10000
  return n
}

/** Litres from net kg and density; null when density is unknown. */
export function litresOf(netKg: number, density: number | null): number | null {
  return density && density > 0 && netKg > 0 ? round3(netKg / density) : null
}

export interface LabValues {
  fat: number | null
  protein: number | null
  snf: number | null
  density: number | null
  acidity: number | null
  temperature: number | null
  antibiotic: MilkAntibiotic | null
}

export type CheckState = 'ok' | 'fail' | 'missing'

export interface ThresholdCheck {
  key: 'fat' | 'density' | 'acidity' | 'temperature' | 'antibiotic'
  state: CheckState
  /** Human readable limit, e.g. ">= 2.8". */
  limit: string
}

/** Live checks of lab values against the settings thresholds (advisory only). */
export function thresholdChecks(v: LabValues, s: MilkSettings): ThresholdCheck[] {
  const cmp = (val: number | null, ok: (x: number) => boolean): CheckState => (val === null ? 'missing' : ok(val) ? 'ok' : 'fail')
  return [
    { key: 'fat', state: cmp(v.fat, x => x >= s.minFat), limit: `≥ ${s.minFat}` },
    { key: 'density', state: cmp(v.density, x => x >= s.minDensity), limit: `≥ ${s.minDensity.toFixed(3)}` },
    { key: 'acidity', state: cmp(v.acidity, x => x <= s.maxAcidity), limit: `≤ ${s.maxAcidity}` },
    { key: 'temperature', state: cmp(v.temperature, x => x <= s.maxTemperature), limit: `≤ ${s.maxTemperature}` },
    {
      key: 'antibiotic',
      state: v.antibiotic === null || v.antibiotic === 'not_tested' ? 'missing' : v.antibiotic === 'positive' ? 'fail' : 'ok',
      limit: '',
    },
  ]
}

/**
 * Suggested decision: antibiotic positive or acidity over the limit (unsafe /
 * spoiled) -> reject; any other failed threshold -> conditional (reduced
 * price); otherwise accept. The lab makes the final call.
 */
export function suggestDecision(checks: ThresholdCheck[]): MilkDecision {
  const failed = new Set(checks.filter(c => c.state === 'fail').map(c => c.key))
  if (failed.has('antibiotic') || failed.has('acidity')) return 'rejected'
  if (failed.size > 0) return 'conditional'
  return 'accepted'
}

export interface PricePreview {
  /** Null when the mode needs fat/protein that are not entered yet. */
  creditedKg: number | null
  pricePerKg: number | null
  amount: number | null
}

/** Mirrors prod_record_milk_lab pricing for 'accepted'. */
export function previewAccepted(netKg: number, v: LabValues, s: MilkSettings, basePrice: number, mode: MilkPricingMode = s.pricingMode): PricePreview {
  if (!(netKg > 0)) return { creditedKg: null, pricePerKg: null, amount: null }
  let credited: number | null = null
  if (mode === 'flat') credited = netKg
  else if (mode === 'fat') credited = v.fat !== null && s.baseFat > 0 ? (netKg * v.fat) / s.baseFat : null
  else credited = v.fat !== null && v.protein !== null && s.baseFat > 0 && s.baseProtein > 0
    ? (netKg * (v.fat / s.baseFat + v.protein / s.baseProtein)) / 2
    : null
  if (credited === null) return { creditedKg: null, pricePerKg: null, amount: null }
  // Server order: credited_kg rounded to 3 first, amount from the rounded value.
  const creditedKg = round3(credited)
  const amount = round2(creditedKg * basePrice)
  return { creditedKg, amount, pricePerKg: round2(amount / netKg) }
}

/** Mirrors prod_record_milk_lab pricing for 'conditional' (price per physical kg). */
export function previewConditional(netKg: number, price: number): PricePreview {
  if (!(netKg > 0)) return { creditedKg: null, pricePerKg: null, amount: null }
  return { creditedKg: round3(netKg), pricePerKg: round2(price), amount: round2(netKg * price) }
}

/** Raw milk item must be an active 'raw' item measured in kg (the RPCs reject others). */
export function isMilkItemCandidate(item: { isActive: boolean; itemType: string; unit: string }): boolean {
  return item.isActive && item.itemType === 'raw' && item.unit === 'kg'
}

/** Conditional price override: required, may be 0. Null when empty/invalid. */
export function parseOverride(value: string): number | null {
  const n = parseOptional(value)
  return n === null ? null : round2(n)
}

/** Accepted milk that entered stock (accepted or conditional). */
export function isStockStatus(status: string): boolean {
  return status === 'accepted' || status === 'conditional'
}

const pctFormatter = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 2 })

export function formatPct(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : pctFormatter.format(Number(n))
}

export function formatDensity(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : Number(n).toFixed(3)
}

/** Number -> <input> text without thousands separators ("" for null). */
export function numInput(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(Number(n)) ? '' : String(Number(n))
}

/**
 * Enter moves focus to the next [data-enter] field inside `root`; returns
 * true when it handled the key. Lets the gate operator type a whole weighing
 * without the mouse.
 */
export function focusNextField(root: HTMLElement | null, current: EventTarget | null): boolean {
  if (!root || !(current instanceof HTMLElement)) return false
  const fields = Array.from(root.querySelectorAll<HTMLElement>('[data-enter]'))
    .filter(el => !(el as HTMLInputElement).disabled && el.offsetParent !== null)
  const idx = fields.indexOf(current)
  if (idx < 0) return false
  const next = fields[idx + 1]
  if (next) {
    next.focus()
    if (next instanceof HTMLInputElement) next.select()
  }
  return true
}
