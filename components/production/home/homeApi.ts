'use client'

// Data access of the production start pages and the daily plan (migration
// 20261110000019, "production_ux"). Everything here degrades gracefully while
// the migration is not applied: onboarding
// status and plan requirements are computed client-side, the daily plan is
// kept locally (no plan id, so the production form is opened without one).
//
// The migration-19 objects are not in lib/database.types.ts yet, so they are
// called through an untyped client view. Writes go through RPCs only.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import type { HomeChoice } from '@/lib/prefs'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { isMissingRpc } from '@/lib/production-accounting'
import { fetchCashAccounts } from '@/lib/cash'
import { fetchProdRecipes, fetchProdStock, fetchProdStockLots, round3, type ProdRecipe } from '@/lib/production'

type Client = ReturnType<typeof createClient>

/** Untyped view of the client for objects the generated types do not know yet. */
const loose = (supabase: Client) => supabase as unknown as SupabaseClient

/** Missing table / view / function (migration not applied yet). */
function isMissing(err: unknown): boolean {
  if (isMissingRpc(err)) return true
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string | null; message?: string | null }
  if (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST204') return true
  return /relation .* does not exist|could not find the table/i.test(e.message ?? '')
}

const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------------------
// Start page preference: stored by lib/prefs.ts (usePrefs, Track B's shared store).

export type DeskKind = Exclude<HomeChoice, 'auto' | 'dashboard'>

// ---------------------------------------------------------------------------
// Onboarding status (prod_onboarding_status, owner / admin)

export interface OnboardingStatus {
  warehouses: boolean
  items: number
  recipes: number
  milkSettings: boolean
  suppliers: number
  customers: number
  priceLists: number
  cashOpeningSet: boolean
  staff: number
  accountingSet: boolean
  controlsReviewed: boolean
}

function mapOnboarding(d: Record<string, unknown>): OnboardingStatus {
  return {
    warehouses: !!d.warehouses,
    items: num(d.items),
    recipes: num(d.recipes),
    milkSettings: !!d.milk_settings,
    suppliers: num(d.suppliers),
    customers: num(d.customers),
    priceLists: num(d.price_lists),
    cashOpeningSet: !!d.cash_opening_set,
    staff: num(d.staff),
    accountingSet: !!d.accounting_set,
    controlsReviewed: !!d.controls_reviewed,
  }
}

async function countOf(supabase: SupabaseClient, table: string, notOwner = false): Promise<number> {
  try {
    const base = supabase.from(table).select('*', { count: 'exact', head: true })
    const { count, error } = await (notOwner ? base.neq('role', 'owner') : base)
    return error ? 0 : count ?? 0
  } catch {
    return 0
  }
}

async function rowExists(supabase: SupabaseClient, table: string): Promise<boolean> {
  const { data, error } = await supabase.from(table).select('company_id').limit(1)
  return !error && (data?.length ?? 0) > 0
}

/** Client-side fallback: simple counts (RLS-scoped to the caller's company). */
async function computeOnboarding(): Promise<OnboardingStatus> {
  const client = createClient()
  const supabase = loose(client)
  const [warehouses, items, recipes, milk, suppliers, customers, priceLists, accounts, staff, accountingSet, controlsReviewed] = await Promise.all([
    countOf(supabase, 'prod_warehouses'),
    countOf(supabase, 'prod_items'),
    countOf(supabase, 'prod_recipes'),
    client.from('prod_milk_settings').select('milk_item_id').maybeSingle(),
    countOf(supabase, 'prod_suppliers'),
    countOf(supabase, 'prod_customers'),
    countOf(supabase, 'prod_price_lists'),
    fetchCashAccounts(client),
    countOf(supabase, 'users', true),
    rowExists(supabase, 'prod_company_accounting'),
    rowExists(supabase, 'prod_control_settings'),
  ])
  return {
    warehouses: warehouses > 0,
    items,
    recipes,
    milkSettings: !!milk.data?.milk_item_id,
    suppliers,
    customers,
    priceLists,
    cashOpeningSet: (accounts ?? []).some(a => a.moveCount > 0 || a.openingBalance !== 0),
    staff,
    accountingSet,
    controlsReviewed,
  }
}

let onboardingRpcMissing = false

export async function fetchOnboardingStatus(): Promise<OnboardingStatus> {
  if (!onboardingRpcMissing) {
    const { data, error } = await loose(createClient()).rpc('prod_onboarding_status')
    if (!error && data && typeof data === 'object') return mapOnboarding(data as Record<string, unknown>)
    if (error && isMissing(error)) onboardingRpcMissing = true
  }
  return computeOnboarding()
}

// ---------------------------------------------------------------------------
// Repeat last sale (prod_last_sale_lines)

let lastSaleMissing = false

export interface LastSaleSummary { number: number | null; lineCount: number; itemNames: string[] }

/**
 * Summary of the customer's last posted sale (what "repeat" would prefill).
 * undefined = the helper is not available (or failed): the repeat link is
 * still offered, the form decides; null = the customer has no posted sale.
 */
export async function fetchLastSale(customerId: string): Promise<LastSaleSummary | null | undefined> {
  if (lastSaleMissing) return undefined
  const { data, error } = await loose(createClient()).rpc('prod_last_sale_lines', { p_customer: customerId })
  if (error) {
    if (isMissing(error)) lastSaleMissing = true
    return undefined
  }
  if (!data) return null
  const d = data as { number?: unknown; lines?: { item_name?: unknown }[] }
  const lines = Array.isArray(d.lines) ? d.lines : Array.isArray(data) ? (data as { item_name?: unknown }[]) : []
  if (lines.length === 0) return null
  return {
    number: d.number === undefined || d.number === null ? null : num(d.number),
    lineCount: lines.length,
    itemNames: lines.map(l => String(l.item_name ?? '')).filter(Boolean),
  }
}

// ---------------------------------------------------------------------------
// Daily production plan (prod_production_plans, prod_save_plan, prod_plan_requirements)

export type PlanStatus = 'planned' | 'done' | 'skipped'

export interface PlanLine {
  /** Server id; a local key ('l…') while the plan is kept locally. */
  id: string
  itemId: string
  plannedQty: number
  recipeId: string | null
  status: PlanStatus
  productionId: string | null
  note: string
}

export interface PlanRequirement {
  itemId: string
  required: number
  available: number
  shortage: number
}

const toPlanStatus = (v: unknown): PlanStatus => (v === 'done' || v === 'skipped' ? v : 'planned')

let planMissing = false
let reqRpcMissing = false

export function isPlanServerSide(): boolean {
  return !planMissing
}

const localPlanKey = (companyId: string, date: string) => `stylepro-prod-plan:${companyId}:${date}`

function readLocalPlan(companyId: string, date: string): PlanLine[] {
  try {
    const raw = window.localStorage.getItem(localPlanKey(companyId, date))
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.map((l: Record<string, unknown>) => ({
      id: String(l.id ?? ''), itemId: String(l.itemId ?? ''), plannedQty: num(l.plannedQty),
      recipeId: l.recipeId ? String(l.recipeId) : null, status: toPlanStatus(l.status),
      productionId: l.productionId ? String(l.productionId) : null, note: String(l.note ?? ''),
    })).filter(l => l.itemId) : []
  } catch {
    return []
  }
}

/** Plan lines of one day; { server: false } while prod_production_plans does not exist. */
export async function fetchPlan(companyId: string, date: string): Promise<{ lines: PlanLine[]; server: boolean }> {
  if (!planMissing) {
    const { data, error } = await loose(createClient()).from('prod_production_plans')
      .select('id, item_id, planned_qty, recipe_id, status, production_id, note')
      .eq('plan_date', date).order('sort_order').order('created_at').order('id')
    if (!error) {
      return {
        server: true,
        lines: ((data ?? []) as Record<string, unknown>[]).map(r => ({
          id: String(r.id), itemId: String(r.item_id), plannedQty: num(r.planned_qty),
          recipeId: r.recipe_id ? String(r.recipe_id) : null, status: toPlanStatus(r.status),
          productionId: r.production_id ? String(r.production_id) : null, note: String(r.note ?? ''),
        })),
      }
    }
    if (isMissing(error)) planMissing = true
    else return { server: true, lines: [] }
  }
  return { server: false, lines: readLocalPlan(companyId, date) }
}

/** Saves the day's plan (prod_save_plan replaces the day's non-done lines); locally before the migration. */
export async function savePlan(companyId: string, date: string, lines: PlanLine[]): Promise<{ error: unknown | null }> {
  if (!planMissing) {
    const { error } = await loose(createClient()).rpc('prod_save_plan', {
      p_date: date,
      // Done lines are kept by the server and may not be sent (DETAIL 'plan_done').
      p_lines: lines.filter(l => l.status !== 'done').map(l => ({
        ...(l.id && !l.id.startsWith('l') ? { id: l.id } : {}),
        item_id: l.itemId,
        planned_qty: round3(l.plannedQty),
        recipe_id: l.recipeId,
        status: l.status,
        note: l.note.trim() || null,
      })),
    })
    if (!error) return { error: null }
    if (!isMissing(error)) return { error }
    planMissing = true
  }
  try { window.localStorage.setItem(localPlanKey(companyId, date), JSON.stringify(lines)) } catch {}
  return { error: null }
}

function mapRequirements(data: unknown): PlanRequirement[] | null {
  const obj = data as Record<string, unknown> | null
  const rows = Array.isArray(data) ? data
    : Array.isArray(obj?.materials) ? obj?.materials
      : Array.isArray(obj?.rows) ? obj?.rows
        : Array.isArray(obj?.requirements) ? obj?.requirements : null
  if (!Array.isArray(rows)) return null
  return (rows as Record<string, unknown>[]).filter(r => r.item_id).map(r => {
    const required = num(r.required_qty ?? r.required ?? r.qty)
    const available = num(r.available_qty ?? r.available ?? r.free_qty)
    const shortage = r.shortage !== undefined || r.shortage_qty !== undefined
      ? num(r.shortage_qty ?? r.shortage)
      : Math.max(0, round3(required - available))
    return { itemId: String(r.item_id), required: round3(required), available: round3(available), shortage: round3(shortage) }
  })
}

/** Free (not held, not expired on `date`) stock per item over all warehouses; plain stock when lots are not available. */
async function fetchFreeStock(supabase: Client, date: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const lots = await fetchProdStockLots(supabase)
  if (lots) {
    for (const l of lots) {
      if (l.remainingQty > 0 && l.holdStatus === 'free' && !(l.expiryDate && l.expiryDate < date)) out.set(l.itemId, (out.get(l.itemId) ?? 0) + l.remainingQty)
    }
    return out
  }
  for (const r of await fetchProdStock(supabase, { positiveOnly: true })) out.set(r.itemId, (out.get(r.itemId) ?? 0) + r.qty)
  return out
}

/** Client-side requirements: recipe lines scaled to the planned qty, summed per material, vs free stock. */
export function computeRequirements(lines: PlanLine[], recipeById: Map<string, ProdRecipe>, free: Map<string, number>): PlanRequirement[] {
  const need = new Map<string, number>()
  for (const l of lines) {
    if (l.status !== 'planned') continue
    const r = l.recipeId ? recipeById.get(l.recipeId) : undefined
    if (!r || r.outputQty <= 0) continue
    const k = l.plannedQty / r.outputQty
    for (const c of r.lines) need.set(c.itemId, (need.get(c.itemId) ?? 0) + c.qty * k)
  }
  return [...need.entries()].map(([itemId, q]) => {
    const required = round3(q)
    const available = round3(free.get(itemId) ?? 0)
    return { itemId, required, available, shortage: Math.max(0, round3(required - available)) }
  })
}

/** Requirements of a saved server plan (prod_plan_requirements); null = compute client-side. */
export async function fetchRequirementsRpc(date: string): Promise<PlanRequirement[] | null> {
  if (reqRpcMissing || planMissing) return null
  const { data, error } = await loose(createClient()).rpc('prod_plan_requirements', { p_date: date })
  if (error) {
    if (isMissing(error)) reqRpcMissing = true
    return null
  }
  return mapRequirements(data)
}

export async function fetchPlanRefs(date: string): Promise<{ recipes: ProdRecipe[]; free: Map<string, number> }> {
  const supabase = createClient()
  const [recipes, free] = await Promise.all([fetchProdRecipes(supabase, { activeOnly: true }), fetchFreeStock(supabase, date)])
  return { recipes, free }
}

// ---------------------------------------------------------------------------
// Small shared reads of the desks

/** id -> name of every production supplier (milk farmers). */
export async function fetchSupplierNames(): Promise<Map<string, string>> {
  const supabase = createClient()
  const { data } = await fetchAllRows<{ id: string; name: string }>((from, to) =>
    supabase.from('prod_suppliers').select('id, name').order('id').range(from, to))
  return new Map(data.map(s => [s.id, s.name]))
}
