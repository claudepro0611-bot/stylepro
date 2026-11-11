// Approval requests & notifications (migration 20261110000019).
//
// A staff / manager whose document hit a control rule (needs_approval) sends
// it to the owner / admin instead of a dead end: prod_request_approval stores
// the RPC name + payload; prod_decide_approval executes it as the approver
// (with the override) or rejects it. prod_notifications() is the computed
// bell feed. Every read degrades to "not available" while the migration is
// not applied; the RPCs are not in database.types.ts yet, hence the untyped
// call helpers.

import type { createClient } from '@/lib/supabase/client'
import type { TranslationKey } from '@/lib/i18n/translations'

type Client = ReturnType<typeof createClient>
type RpcResult = { data: unknown; error: { message?: string | null; details?: string | null; code?: string | null } | null }
type UntypedRpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult>

/** supabase.rpc without the generated-type check (RPCs of migration 19). */
export function untypedRpc(supabase: Client, fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> {
  return (supabase.rpc.bind(supabase) as unknown as UntypedRpc)(fn, args)
}

/** PostgREST "function / relation does not exist" (migration not applied). */
export function isMissingError(err: RpcResult['error']): boolean {
  if (!err) return false
  const code = err.code ?? ''
  const msg = err.message ?? ''
  return code === 'PGRST202' || code === 'PGRST205' || code === '42883' || code === '42P01' || /does not exist|Could not find/i.test(msg)
}

// ---------------------------------------------------------------------------
// Request payload

const OVERRIDE_KEYS = ['override', 'override_note']

/** RPCs prod_request_approval accepts (contract: whitelist; others -> invalid_input 'rpc'). */
export const APPROVABLE_RPCS = [
  'prod_create_receipt', 'prod_create_price_correction', 'prod_create_milk_intake', 'prod_record_milk_lab',
  'prod_amend_milk_lab', 'prod_create_production', 'prod_create_separation', 'prod_create_processing',
  'prod_create_transfer', 'prod_create_writeoff', 'prod_create_opening', 'prod_post_stock_count', 'prod_create_sale',
  'prod_create_sale_return', 'prod_create_customer_payment', 'prod_create_supplier_payment', 'prod_create_cash_order',
  'prod_create_cash_transfer', 'supply_add_move',
] as const

export const isApprovableRpc = (rpc: string) => (APPROVABLE_RPCS as readonly string[]).includes(rpc)

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

function stripOverride(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(asObj(v))) if (!OVERRIDE_KEYS.includes(k)) out[k] = val
  return out
}

/**
 * The payload stored with a request, from the captured RPC args (contract):
 * the p_data object for the jsonb RPCs; `{ intake_id, lab }` for
 * prod_record_milk_lab / prod_amend_milk_lab; `{ id }` for
 * prod_post_stock_count. Override keys are removed (the server strips them too).
 */
export function requestPayload(rpc: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const a = args ?? {}
  switch (rpc) {
    case 'prod_record_milk_lab': return { intake_id: a.p_id, lab: stripOverride(a.p_data) }
    case 'prod_amend_milk_lab': return { intake_id: a.p_intake_id, lab: stripOverride(a.p_lab) }
    case 'prod_post_stock_count': return { id: a.p_id }
    default: {
      const data = stripOverride(a.p_data)
      if (data.lab && typeof data.lab === 'object') data.lab = stripOverride(data.lab)
      return data
    }
  }
}

export const APPROVAL_LABEL_MAX = 200

export async function requestApproval(supabase: Client, rpc: string, payload: Record<string, unknown>, rule: string | null, label: string) {
  return untypedRpc(supabase, 'prod_request_approval', {
    p_rpc: rpc, p_payload: payload, p_rule: rule ? rule.slice(0, 50) : null, p_label: label.slice(0, APPROVAL_LABEL_MAX),
  })
}

// ---------------------------------------------------------------------------
// Requests list

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'withdrawn'

export interface ApprovalRequest {
  id: string
  createdAt: string
  requestedBy: string | null
  requestedByName: string
  rpcName: string
  payload: Record<string, unknown>
  rule: string
  ruleDetail: Record<string, unknown> | null
  label: string
  status: ApprovalStatus
  decidedBy: string | null
  decidedByName: string
  decidedAt: string | null
  decisionNote: string
  result: unknown
  error: string
  errorDetail: string
}

interface ApprovalRow {
  id: string
  created_at: string
  requested_by?: string | null
  requested_by_name?: string | null
  rpc_name?: string | null
  payload?: unknown
  rule?: string | null
  rule_detail?: unknown
  doc_label?: string | null
  status?: string | null
  decided_by?: string | null
  decided_by_name?: string | null
  decided_at?: string | null
  decision_note?: string | null
  result?: unknown
  error?: string | null
  error_detail?: string | null
}

const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'failed', 'withdrawn']
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

export function mapApproval(r: ApprovalRow): ApprovalRequest {
  return {
    id: r.id,
    createdAt: r.created_at,
    requestedBy: r.requested_by ?? null,
    requestedByName: r.requested_by_name ?? '',
    rpcName: r.rpc_name ?? '',
    payload: obj(r.payload) ?? {},
    rule: r.rule ?? 'unknown',
    ruleDetail: obj(r.rule_detail),
    label: r.doc_label ?? '',
    status: (STATUSES as string[]).includes(r.status ?? '') ? (r.status as ApprovalStatus) : 'pending',
    decidedBy: r.decided_by ?? null,
    decidedByName: r.decided_by_name ?? '',
    decidedAt: r.decided_at ?? null,
    decisionNote: r.decision_note ?? '',
    result: r.result ?? null,
    error: r.error ?? '',
    errorDetail: r.error_detail ?? '',
  }
}

type QueryRes = { data: unknown; error: RpcResult['error'] }
/** Loosely typed PostgREST builder for tables not in database.types.ts yet. */
export interface LooseQuery extends PromiseLike<QueryRes> {
  select: (cols: string) => LooseQuery
  eq: (c: string, v: unknown) => LooseQuery
  in: (c: string, v: unknown[]) => LooseQuery
  ilike: (c: string, v: string) => LooseQuery
  or: (f: string) => LooseQuery
  order: (col: string, o: { ascending: boolean }) => LooseQuery
  limit: (n: number) => LooseQuery
  maybeSingle: () => PromiseLike<QueryRes>
}

export function looseFrom(supabase: Client, table: string): LooseQuery {
  return (supabase.from.bind(supabase) as unknown as (t: string) => LooseQuery)(table)
}

/**
 * Requests visible to the caller (RLS: owner / admin all of the company, others
 * their own). null = not available (migration missing / error).
 */
export async function fetchApprovals(
  supabase: Client,
  f: { statuses?: ApprovalStatus[]; requestedBy?: string; limit?: number },
): Promise<ApprovalRequest[] | null> {
  try {
    let q = looseFrom(supabase, 'prod_approval_requests').select('*')
    if (f.requestedBy) q = q.eq('requested_by', f.requestedBy)
    if (f.statuses) q = q.in('status', f.statuses)
    const res = await q.order('created_at', { ascending: false }).limit(f.limit ?? 200)
    if (res.error) return null
    return ((res.data ?? []) as ApprovalRow[]).map(mapApproval)
  } catch {
    return null
  }
}

export async function decideApproval(supabase: Client, id: string, approve: boolean, note: string) {
  return untypedRpc(supabase, 'prod_decide_approval', { p_id: id, p_approve: approve, p_note: note })
}

export async function withdrawApproval(supabase: Client, id: string) {
  return untypedRpc(supabase, 'prod_withdraw_approval', { p_id: id })
}

export function statusPillCls(s: ApprovalStatus): string {
  switch (s) {
    case 'approved': return 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400'
    case 'rejected':
    case 'failed': return 'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400'
    case 'withdrawn': return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
    default: return 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400'
  }
}

export const statusKey = (s: ApprovalStatus): TranslationKey => `prodShell.approvals.status.${s}` as TranslationKey

// ---------------------------------------------------------------------------
// Target RPC -> document page / human name

const RPC_PAGES: Record<string, { base: string; detail: boolean; key: TranslationKey }> = {
  prod_create_production: { base: '/ishlab-chiqarish', detail: true, key: 'prodShell.rpc.production' },
  prod_create_processing: { base: '/qayta-ishlash', detail: true, key: 'prodShell.rpc.processing' },
  prod_create_separation: { base: '/separatsiya', detail: true, key: 'prodShell.rpc.separation' },
  prod_create_milk_intake: { base: '/sut-qabuli', detail: true, key: 'prodShell.rpc.milkIntake' },
  prod_record_milk_lab: { base: '/sut-qabuli', detail: true, key: 'prodShell.rpc.milkLab' },
  prod_amend_milk_lab: { base: '/sut-qabuli', detail: true, key: 'prodShell.rpc.milkLabAmend' },
  prod_create_receipt: { base: '/xom-ashyo-kirim', detail: true, key: 'prodShell.rpc.receipt' },
  prod_create_opening: { base: '/zavod-boshlangich-qoldiq', detail: true, key: 'prodShell.rpc.opening' },
  prod_create_writeoff: { base: '/zavod-hisobdan-chiqarish', detail: true, key: 'prodShell.rpc.writeoff' },
  prod_create_transfer: { base: '/zavod-kochirish', detail: true, key: 'prodShell.rpc.transfer' },
  prod_post_stock_count: { base: '/zavod-inventarizatsiya', detail: true, key: 'prodShell.rpc.stockCount' },
  prod_create_sale: { base: '/zavod-sotuv', detail: true, key: 'prodShell.rpc.sale' },
  prod_create_sale_return: { base: '/zavod-qaytarishlar', detail: true, key: 'prodShell.rpc.saleReturn' },
  prod_create_price_correction: { base: '/zavod-narx-tuzatish', detail: false, key: 'prodShell.rpc.priceCorrection' },
  prod_create_customer_payment: { base: '/zavod-mijoz-tolovlari', detail: false, key: 'prodShell.rpc.customerPayment' },
  prod_create_supplier_payment: { base: '/zavod-yetkazuvchi-tolovlar', detail: false, key: 'prodShell.rpc.supplierPayment' },
  prod_create_cash_order: { base: '/zavod-kassa-orderlar', detail: false, key: 'prodShell.rpc.cashOrder' },
  prod_create_cash_transfer: { base: '/zavod-kassa-otkazmalar', detail: false, key: 'prodShell.rpc.cashTransfer' },
  supply_add_move: { base: '/taminot/pul-berish', detail: false, key: 'prodShell.rpc.supplyMove' },
  prod_allocate_overhead: { base: '/zavod-xarajat-taqsimoti', detail: false, key: 'prodShell.rpc.overhead' },
  prod_save_cost_pool: { base: '/zavod-xarajat-taqsimoti', detail: false, key: 'prodShell.rpc.costPool' },
}

export function rpcNameKey(rpc: string): TranslationKey {
  return RPC_PAGES[rpc]?.key ?? 'prodShell.rpc.unknown'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function resultId(result: unknown): string | null {
  if (typeof result === 'string' && UUID_RE.test(result)) return result
  const o = obj(result)
  if (!o) return null
  for (const k of ['id', 'doc_id', 'sale_id', 'production_id', 'intake_id']) {
    const v = o[k]
    if (typeof v === 'string' && UUID_RE.test(v)) return v
  }
  return null
}

/** Page of the document an approved request created / changed; null when unknown. */
export function approvalResultHref(r: Pick<ApprovalRequest, 'rpcName' | 'payload' | 'result'>): string | null {
  const page = RPC_PAGES[r.rpcName]
  if (!page) return null
  if (!page.detail) return page.base
  // Lab / stock count act on an existing document: its id is in the payload.
  const payloadId = [r.payload.intake_id, r.payload.id].find(v => typeof v === 'string' && UUID_RE.test(v)) as string | undefined
  const id = resultId(r.result) ?? payloadId ?? null
  return id ? `${page.base}/${id}` : page.base
}

/** Short "key: value" lines of a payload (top-level scalars + line counts) for the queue. */
export function payloadSummary(payload: Record<string, unknown>, max = 6): string[] {
  const src = obj(payload.lab) ?? payload
  const out: string[] = []
  for (const [k, v] of Object.entries(src)) {
    if (out.length >= max) break
    if (OVERRIDE_KEYS.includes(k)) continue
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v)) { out.push(`${k}: ${v.length}`); continue }
    if (typeof v === 'object') continue
    const s = String(v)
    if (UUID_RE.test(s)) continue
    out.push(`${k}: ${s.length > 60 ? s.slice(0, 57) + '...' : s}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Notifications

export type NotifSeverity = 'info' | 'warn' | 'danger'

export interface ProdNotification {
  kind: string
  severity: NotifSeverity
  count: number
  titleKey: string
  href: string | null
  sample: string[]
}

interface NotifRow {
  kind?: unknown
  severity?: unknown
  count?: unknown
  title_key?: unknown
  href?: unknown
  sample?: unknown
}

/** The contract links the queue as /zavod-tasdiqlash; the page lives at /zavod-tasdiqlar. */
function fixHref(href: string): string {
  return href.replace(/^\/zavod-tasdiqlash(?=$|[/?#])/, '/zavod-tasdiqlar')
}

export function mapNotifications(data: unknown): ProdNotification[] {
  const list = Array.isArray(data) ? (data as NotifRow[]) : []
  return list
    .map(r => ({
      kind: typeof r.kind === 'string' ? r.kind : 'unknown',
      severity: (r.severity === 'danger' || r.severity === 'warn' ? r.severity : 'info') as NotifSeverity,
      count: Number(r.count) || 0,
      titleKey: typeof r.title_key === 'string' ? r.title_key : '',
      href: typeof r.href === 'string' && r.href.startsWith('/') ? fixHref(r.href) : null,
      sample: Array.isArray(r.sample) ? r.sample.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
    }))
    .filter(n => n.count > 0)
}

export const NOTIF_KINDS = [
  'pending_lab', 'expiring_lots', 'expired_lots', 'overdue_customers', 'overdue_suppliers', 'low_stock',
  'pending_approvals', 'my_requests', 'stock_count_drafts',
] as const

/** Title of a notification: our own key per kind, else the server's title_key if it resolves, else the kind. */
export function notifTitle(t: (k: TranslationKey) => string, n: ProdNotification): string {
  if ((NOTIF_KINDS as readonly string[]).includes(n.kind)) return t(`prodShell.notif.kinds.${n.kind}` as TranslationKey)
  if (n.titleKey) {
    const s = t(n.titleKey as TranslationKey)
    if (s !== n.titleKey) return s
  }
  return t('prodShell.notif.kinds.unknown')
}

/** null = not available (migration missing). */
export async function fetchNotifications(supabase: Client): Promise<ProdNotification[] | null> {
  try {
    const { data, error } = await untypedRpc(supabase, 'prod_notifications')
    if (error) return null
    return mapNotifications(data)
  } catch {
    return null
  }
}
