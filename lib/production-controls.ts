// Production controls & anti-fraud (migration 20261110000017): control
// settings, period lock, audit log reads and the client side of the
// override mechanism. Every rule is enforced server-side; the client only
// pre-validates (date pickers, tolerance hints) and turns the RPC errors into
// human messages. Every read degrades to "not available" (defaults / null)
// while the migration is not applied.

import type { TranslationKey } from '@/lib/i18n/translations'
import type { createClient } from '@/lib/supabase/client'
import { prodErrorKey, type ProdRpcError } from '@/lib/production'
import { tashkentYmd } from '@/lib/utils/date'

type Client = ReturnType<typeof createClient>

export const CONTROL_ROLES = ['owner', 'admin', 'manager', 'staff'] as const
export type ControlRole = typeof CONTROL_ROLES[number]

export interface ControlSettings {
  productionTolerancePct: number
  separationLossMaxPct: number
  separationFatTolerancePct: number
  processingMinRecoveryPct: number
  conditionalPriceMinPct: number
  backdateDaysStaff: number
  backdateDaysAdmin: number
  futureDays: number
  labMustDiffer: boolean
  selfCancelAllowed: boolean
  /** null = no limit. */
  supplyIssueDailyLimit: number | null
  paymentOverDebtAllowed: boolean
  manualLotPickRoles: ControlRole[]
  updatedAt: string | null
}

/** The column defaults of prod_control_settings (a firm without a row behaves like this). */
export const DEFAULT_CONTROL_SETTINGS: ControlSettings = {
  productionTolerancePct: 10,
  separationLossMaxPct: 2,
  separationFatTolerancePct: 5,
  processingMinRecoveryPct: 50,
  conditionalPriceMinPct: 50,
  backdateDaysStaff: 1,
  backdateDaysAdmin: 31,
  futureDays: 1,
  labMustDiffer: false,
  selfCancelAllowed: false,
  supplyIssueDailyLimit: null,
  paymentOverDebtAllowed: false,
  manualLotPickRoles: [...CONTROL_ROLES],
  updatedAt: null,
}

interface SettingsRow {
  production_tolerance_pct?: number | null
  separation_loss_max_pct?: number | null
  separation_fat_tolerance_pct?: number | null
  processing_min_recovery_pct?: number | null
  conditional_price_min_pct?: number | null
  backdate_days_staff?: number | null
  backdate_days_admin?: number | null
  future_days?: number | null
  lab_must_differ?: boolean | null
  self_cancel_allowed?: boolean | null
  supply_issue_daily_limit?: number | null
  payment_over_debt_allowed?: boolean | null
  manual_lot_pick_roles?: string[] | null
  updated_at?: string | null
}

const num = (v: number | null | undefined, d: number) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v))

export function mapControlSettings(r: SettingsRow | null | undefined): ControlSettings {
  if (!r) return DEFAULT_CONTROL_SETTINGS
  const d = DEFAULT_CONTROL_SETTINGS
  return {
    productionTolerancePct: num(r.production_tolerance_pct, d.productionTolerancePct),
    separationLossMaxPct: num(r.separation_loss_max_pct, d.separationLossMaxPct),
    separationFatTolerancePct: num(r.separation_fat_tolerance_pct, d.separationFatTolerancePct),
    processingMinRecoveryPct: num(r.processing_min_recovery_pct, d.processingMinRecoveryPct),
    conditionalPriceMinPct: num(r.conditional_price_min_pct, d.conditionalPriceMinPct),
    backdateDaysStaff: num(r.backdate_days_staff, d.backdateDaysStaff),
    backdateDaysAdmin: num(r.backdate_days_admin, d.backdateDaysAdmin),
    futureDays: num(r.future_days, d.futureDays),
    labMustDiffer: r.lab_must_differ ?? d.labMustDiffer,
    selfCancelAllowed: r.self_cancel_allowed ?? d.selfCancelAllowed,
    supplyIssueDailyLimit: r.supply_issue_daily_limit === null || r.supply_issue_daily_limit === undefined ? null : Number(r.supply_issue_daily_limit),
    paymentOverDebtAllowed: r.payment_over_debt_allowed ?? d.paymentOverDebtAllowed,
    manualLotPickRoles: (r.manual_lot_pick_roles ?? d.manualLotPickRoles)
      .filter((x): x is ControlRole => (CONTROL_ROLES as readonly string[]).includes(x)),
    updatedAt: r.updated_at ?? null,
  }
}

/** p_data of prod_save_control_settings (snake_case keys, every field). */
export function controlSettingsPayload(s: ControlSettings) {
  return {
    production_tolerance_pct: s.productionTolerancePct,
    separation_loss_max_pct: s.separationLossMaxPct,
    separation_fat_tolerance_pct: s.separationFatTolerancePct,
    processing_min_recovery_pct: s.processingMinRecoveryPct,
    conditional_price_min_pct: s.conditionalPriceMinPct,
    backdate_days_staff: s.backdateDaysStaff,
    backdate_days_admin: s.backdateDaysAdmin,
    future_days: s.futureDays,
    lab_must_differ: s.labMustDiffer,
    self_cancel_allowed: s.selfCancelAllowed,
    supply_issue_daily_limit: s.supplyIssueDailyLimit,
    payment_over_debt_allowed: s.paymentOverDebtAllowed,
    manual_lot_pick_roles: s.manualLotPickRoles,
  }
}

export interface PeriodLock { lockedUntil: string | null; lockedBy: string | null; lockedAt: string | null }

export interface ControlsState {
  /** false while migration 20261110000017 is not applied (tables missing). */
  available: boolean
  settings: ControlSettings
  lock: PeriodLock
}

const EMPTY_LOCK: PeriodLock = { lockedUntil: null, lockedBy: null, lockedAt: null }

/** Settings (defaults when the row is absent) and the period lock of the caller's company. */
export async function fetchControls(supabase: Client): Promise<ControlsState> {
  try {
    const [setRes, lockRes] = await Promise.all([
      supabase.from('prod_control_settings').select('*').maybeSingle(),
      supabase.from('prod_period_locks').select('locked_until, locked_by, locked_at').maybeSingle(),
    ])
    if (setRes.error) return { available: false, settings: DEFAULT_CONTROL_SETTINGS, lock: EMPTY_LOCK }
    const l = lockRes.error ? null : lockRes.data
    return {
      available: true,
      settings: mapControlSettings(setRes.data as SettingsRow | null),
      lock: { lockedUntil: l?.locked_until ?? null, lockedBy: l?.locked_by ?? null, lockedAt: l?.locked_at ?? null },
    }
  } catch {
    return { available: false, settings: DEFAULT_CONTROL_SETTINGS, lock: EMPTY_LOCK }
  }
}

// ---------------------------------------------------------------------------
// Dates (business date = Asia/Tashkent, as prod_biz_date)

export function todayYmd(): string {
  return tashkentYmd()
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const isOwnerAdminRole = (role: string | null | undefined) => role === 'owner' || role === 'admin'

/** Backdate window (days) for the caller's role. */
export function backdateDaysFor(role: string | null | undefined, s: ControlSettings): number {
  return isOwnerAdminRole(role) ? s.backdateDaysAdmin : s.backdateDaysStaff
}

/** Last day of the month of a "YYYY-MM" value. */
export function monthEndYmd(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 0))
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Errors and rule codes

/** Overridable rule codes (DETAIL of 'needs_approval'). */
export const RULE_CODES = [
  'backdate', 'production_no_recipe', 'production_yield', 'separation_loss', 'separation_fat',
  'processing_recovery', 'conditional_price', 'lab_same_user', 'milk_threshold', 'payment_over_debt',
  'supply_issue_limit', 'receipt_zero_price', 'receipt_no_supplier', 'expired_lot', 'manual_pick',
] as const
export type RuleCode = typeof RULE_CODES[number]

/** Codes logged in prod_audit_log.rule (overridable rules). */
export function ruleLabelKey(rule: string): TranslationKey {
  return (RULE_CODES as readonly string[]).includes(rule) ? (`prodControls.ruleNames.${rule}` as TranslationKey) : 'prodControls.ruleNames.unknown'
}

const errMsg = (err: ProdRpcError) => (typeof err === 'string' ? err : err?.message) ?? ''
const errDetail = (err: ProdRpcError) => (typeof err === 'string' ? '' : err?.details) ?? ''

/** The rule code when the RPC failed with 'needs_approval', else null. */
export function needsApprovalRule(err: ProdRpcError): string | null {
  if (!err) return null
  const msg = errMsg(err)
  if (msg !== 'needs_approval' && !msg.includes('needs_approval')) return null
  return errDetail(err) || 'unknown'
}

/** Values the rule texts interpolate ({tol}, {dev}, ...). */
export type RuleVars = Record<string, string | number | null | undefined>

export function fillText(text: string, vars: RuleVars): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k]
    return v === null || v === undefined || v === '' ? m : String(v)
  })
}

const pct = (n: number) => String(Number(n.toFixed(2)))

/**
 * Human explanation of a violated rule: WHAT is wrong (with the limit from
 * the settings and, when the form knows it, the actual value). The "who may
 * approve" sentence is added by the caller (role-dependent).
 */
export function ruleMessage(t: (k: TranslationKey) => string, rule: string, s: ControlSettings, role: string | null | undefined, vars: RuleVars = {}): string {
  const base: RuleVars = {
    tol: pct(s.productionTolerancePct),
    lossMax: pct(s.separationLossMaxPct),
    fatTol: pct(s.separationFatTolerancePct),
    minRecovery: pct(s.processingMinRecoveryPct),
    minPrice: pct(s.conditionalPriceMinPct),
    days: backdateDaysFor(role, s),
    limit: s.supplyIssueDailyLimit ?? '',
    ...vars,
  }
  const has = (k: string) => vars[k] !== undefined && vars[k] !== null && vars[k] !== ''
  let key: TranslationKey
  switch (rule) {
    case 'production_yield': key = has('dev') ? 'prodControls.rules.production_yield_dev' : 'prodControls.rules.production_yield'; break
    case 'separation_loss': key = has('loss') ? 'prodControls.rules.separation_loss_dev' : 'prodControls.rules.separation_loss'; break
    case 'separation_fat': key = 'prodControls.rules.separation_fat'; break
    case 'supply_issue_limit': key = s.supplyIssueDailyLimit !== null ? 'prodControls.rules.supply_issue_limit' : 'prodControls.rules.supply_issue_limit_plain'; break
    default:
      key = (RULE_CODES as readonly string[]).includes(rule) ? (`prodControls.rules.${rule}` as TranslationKey) : 'prodControls.rules.unknown'
  }
  return fillText(t(key), base)
}

/**
 * prodErrorKey plus the control errors that carry a value (period_closed
 * DETAIL = lock date). Use instead of t(prodErrorKey(err)) for document
 * create / post / cancel calls.
 */
export function prodErrorText(t: (k: TranslationKey) => string, err: ProdRpcError): string {
  const msg = errMsg(err)
  if (msg === 'period_closed' || msg.includes('period_closed')) {
    const d = errDetail(err)
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? fillText(t('prodControls.errors.periodClosedUntil'), { date: formatYmdDots(d) }) : t('productionErrors.period_closed')
  }
  return t(prodErrorKey(err))
}

/** "2026-11-30" -> "30.11.2026". */
export function formatYmdDots(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const [y, m, d] = ymd.slice(0, 10).split('-')
  return d && m && y ? `${d}.${m}.${y}` : ymd
}

/** Override keys sent with the SAME payload after an owner / admin approved. */
export interface OverrideCtl { override: true; override_note: string }

export const OVERRIDE_NOTE_MIN = 5
export const OVERRIDE_NOTE_MAX = 500

// ---------------------------------------------------------------------------
// Audit log (owner / admin only via RLS; others read 0 rows)

export const AUDIT_ACTIONS = ['insert', 'update', 'delete', 'override', 'cancel', 'period_close', 'period_reopen', 'settings'] as const
export type AuditAction = typeof AUDIT_ACTIONS[number]

export function auditActionKey(a: string): TranslationKey {
  return (AUDIT_ACTIONS as readonly string[]).includes(a) ? (`prodControls.audit.actions.${a}` as TranslationKey) : 'prodControls.audit.actions.update'
}

/** Audited tables -> label key. */
export const AUDIT_ENTITIES = [
  'prod_productions', 'prod_processings', 'prod_separations', 'prod_transfers', 'prod_receipts', 'prod_writeoffs',
  'prod_stock_counts', 'prod_openings', 'prod_price_corrections', 'prod_sales', 'prod_sale_returns',
  'prod_milk_intakes', 'prod_customer_payments', 'prod_supplier_payments', 'prod_cash_orders', 'prod_cash_transfers',
  'supply_cash_moves', 'prod_items', 'prod_suppliers', 'prod_customers', 'prod_warehouses', 'prod_recipes',
  'prod_recipe_lines', 'prod_milk_settings', 'prod_price_lists', 'prod_price_list_items', 'prod_cash_accounts',
  'prod_control_settings', 'prod_period_locks',
] as const

export function auditEntityKey(entity: string): TranslationKey {
  return (AUDIT_ENTITIES as readonly string[]).includes(entity) ? (`prodControls.entities.${entity}` as TranslationKey) : 'prodControls.entities.unknown'
}

/** Page of the audited document / master-data row; null when there is none. */
export function auditEntityHref(entity: string, id: string | null): string | null {
  if (!id) return null
  switch (entity) {
    case 'prod_productions': return `/ishlab-chiqarish/${id}`
    case 'prod_processings': return `/qayta-ishlash/${id}`
    case 'prod_separations': return `/separatsiya/${id}`
    case 'prod_transfers': return `/zavod-kochirish/${id}`
    case 'prod_receipts': return `/xom-ashyo-kirim/${id}`
    case 'prod_writeoffs': return `/zavod-hisobdan-chiqarish/${id}`
    case 'prod_stock_counts': return `/zavod-inventarizatsiya/${id}`
    case 'prod_openings': return `/zavod-boshlangich-qoldiq/${id}`
    case 'prod_sales': return `/zavod-sotuv/${id}`
    case 'prod_sale_returns': return `/zavod-qaytarishlar/${id}`
    case 'prod_milk_intakes': return `/sut-qabuli/${id}`
    case 'prod_price_corrections': return '/zavod-narx-tuzatish'
    case 'prod_customer_payments': return '/zavod-mijoz-tolovlari'
    case 'prod_supplier_payments': return '/zavod-yetkazuvchi-tolovlar'
    case 'prod_cash_orders': return '/zavod-kassa-orderlar'
    case 'prod_cash_transfers': return '/zavod-kassa-otkazmalar'
    case 'supply_cash_moves': return '/taminot/pul-berish'
    case 'prod_items': return '/zavod-mahsulotlar'
    case 'prod_suppliers': return `/zavod-yetkazuvchilar/${id}`
    case 'prod_customers': return `/zavod-mijozlar/${id}`
    case 'prod_warehouses': return `/zavod-omborlar/${id}`
    case 'prod_recipes': return `/zavod-retseptlar/${id}`
    case 'prod_price_lists': return `/zavod-narxlar/${id}`
    case 'prod_cash_accounts': return `/zavod-kassa/${id}`
    case 'prod_control_settings': return '/zavod-nazorat'
    case 'prod_period_locks': return '/zavod-davr-yopish'
    default: return null
  }
}

export type AuditJson = Record<string, unknown> | null

export interface AuditRow {
  id: string
  at: string
  userId: string | null
  userName: string
  entity: string
  entityId: string | null
  action: string
  old: AuditJson
  new: AuditJson
  rule: string | null
  note: string
}

interface AuditDbRow {
  id: string; at: string; user_id: string | null; user_name: string | null; entity: string; entity_id: string | null
  action: string; old: unknown; new: unknown; rule: string | null; note: string | null
}

const asObj = (v: unknown): AuditJson => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

function mapAudit(r: AuditDbRow): AuditRow {
  return {
    id: r.id, at: r.at, userId: r.user_id, userName: r.user_name ?? '', entity: r.entity, entityId: r.entity_id,
    action: r.action, old: asObj(r.old), new: asObj(r.new), rule: r.rule, note: r.note ?? '',
  }
}

export interface AuditFilters {
  fromIso?: string
  toIso?: string
  userId?: string
  entity?: string
  action?: string
  rule?: string
  entityId?: string
}

export const AUDIT_PAGE = 200

/** Newest first; null when the log is not available (migration not applied). */
export async function fetchAuditLog(supabase: Client, f: AuditFilters, limit = AUDIT_PAGE): Promise<AuditRow[] | null> {
  try {
    let q = supabase.from('prod_audit_log').select('id, at, user_id, user_name, entity, entity_id, action, old, new, rule, note')
    if (f.fromIso) q = q.gte('at', f.fromIso)
    if (f.toIso) q = q.lt('at', f.toIso)
    if (f.userId) q = q.eq('user_id', f.userId)
    if (f.entity) q = q.eq('entity', f.entity)
    if (f.action) q = q.eq('action', f.action)
    if (f.rule) q = q.eq('rule', f.rule)
    if (f.entityId) q = q.eq('entity_id', f.entityId)
    const { data, error } = await q.order('at', { ascending: false }).order('id').limit(limit)
    if (error) return null
    return ((data ?? []) as AuditDbRow[]).map(mapAudit)
  } catch {
    return null
  }
}

/** Override rows of one document (shown as "Tasdiqlangan: user, reason"). */
export async function fetchDocOverrides(supabase: Client, docId: string): Promise<AuditRow[]> {
  const rows = await fetchAuditLog(supabase, { entityId: docId, action: 'override' }, 50)
  return rows ?? []
}

/** Changed keys of an audit row (union of old / new). */
export function auditDiffKeys(r: Pick<AuditRow, 'old' | 'new'>): string[] {
  const keys = new Set<string>([...Object.keys(r.old ?? {}), ...Object.keys(r.new ?? {})])
  for (const k of ['company_id', 'updated_at', 'updated_by']) keys.delete(k)
  return [...keys].sort()
}

export function auditValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}
