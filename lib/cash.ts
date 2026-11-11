// Cash & bank accounts of the production module (migration
// 20261110000016_production_cash.sql): accounts (kassa / bank / karta),
// the append-only movement ledger, manual cash orders (PKO / RKO) and
// transfers between accounts. Reads go to the RLS-scoped tables / views
// (the account list is readable by every company user); every write goes
// through the SECURITY DEFINER RPCs (prod_save_cash_account,
// prod_create_cash_order, prod_create_cash_transfer, prod_cancel_cash_doc).
// Customer / supplier payments and supply cash moves take an optional
// `account_id` in their existing RPCs.
// Every read degrades gracefully while the migration is not applied
// (probeCash() = false -> pages show the "available after update" note).

import type { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { localYmd } from '@/lib/utils/date'
import { round2, type ProdPaymentMethod } from '@/lib/production'
import type { TranslationKey } from '@/lib/i18n/translations'

type Client = ReturnType<typeof createClient>

let probe: Promise<boolean> | null = null

/**
 * Whether migration 20261110000016 is live (prod_cash_accounts is readable).
 * Cached per page load; a failed probe is retried on the next call.
 */
export function probeCash(supabase: Client): Promise<boolean> {
  if (!probe) {
    probe = Promise.resolve(supabase.from('prod_cash_accounts').select('id').limit(1))
      .then(({ error }) => !error)
      .catch(() => false)
      .then(ok => {
        if (!ok) probe = null
        return ok
      })
  }
  return probe
}

export const CASH_ACCOUNT_KINDS = ['cash', 'bank', 'card'] as const
export type CashAccountKind = typeof CASH_ACCOUNT_KINDS[number]

/** 'opening' is reserved by the migration and never written. */
export const CASH_SOURCE_TYPES = [
  'customer_payment', 'supplier_payment', 'supply_issue', 'supply_return', 'cash_order', 'cash_transfer',
] as const
export type CashSourceType = typeof CASH_SOURCE_TYPES[number]

export function accountKindKey(kind: string): TranslationKey {
  if (kind === 'bank') return 'prodCash.kinds.bank'
  if (kind === 'card') return 'prodCash.kinds.card'
  return 'prodCash.kinds.cash'
}

export function cashSourceKey(source: string): TranslationKey {
  return (CASH_SOURCE_TYPES as readonly string[]).includes(source)
    ? `prodCash.sources.${source}` as TranslationKey
    : 'prodCash.sources.cash_order'
}

/** List page of a movement's source document (none of them has a detail page). */
export function cashSourceHref(source: string): string | null {
  switch (source) {
    case 'customer_payment': return '/zavod-mijoz-tolovlari'
    case 'supplier_payment': return '/zavod-yetkazuvchi-tolovlar'
    case 'supply_issue':
    case 'supply_return': return '/taminot/pul-berish'
    case 'cash_order': return '/zavod-kassa-orderlar'
    case 'cash_transfer': return '/zavod-kassa-otkazmalar'
    default: return null
  }
}

export interface CashAccount {
  id: string
  name: string
  kind: CashAccountKind
  currency: string
  bankName: string
  accountNo: string
  mfo: string
  note: string
  openingBalance: number
  openingDate: string | null
  /** Payment methods this account is the default for. */
  defaultFor: ProdPaymentMethod[]
  isActive: boolean
  /** By original direction, net of cancelled documents. */
  totalIn: number
  totalOut: number
  /** opening_balance + every movement. */
  balance: number
  lastMoveAt: string | null
  /** 0 = opening balance still editable. */
  moveCount: number
}

/** Seeded / new account whose real opening balance was never entered (contract: prompt the owner). */
export const needsOpeningBalance = (a: Pick<CashAccount, 'moveCount' | 'openingBalance'>) => a.moveCount === 0 && a.openingBalance === 0

function toKind(v: unknown): CashAccountKind {
  return (CASH_ACCOUNT_KINDS as readonly string[]).includes(String(v)) ? (v as CashAccountKind) : 'cash'
}

function toMethods(v: unknown): ProdPaymentMethod[] {
  return Array.isArray(v) ? v.filter((m): m is ProdPaymentMethod => m === 'cash' || m === 'card' || m === 'transfer') : []
}

/** Accounts with balances (prod_cash_balances), oldest first; null when the view is not available. */
export async function fetchCashAccounts(supabase: Client): Promise<CashAccount[] | null> {
  const { data, error } = await supabase.from('prod_cash_balances').select('*').order('name')
  if (error) return null
  return (data ?? []).filter(b => b.account_id).map(b => ({
    id: b.account_id as string,
    name: b.name ?? '',
    kind: toKind(b.kind),
    currency: b.currency || 'UZS',
    bankName: b.bank_name ?? '',
    accountNo: b.account_no ?? '',
    mfo: b.mfo ?? '',
    note: b.note ?? '',
    openingBalance: Number(b.opening_balance ?? 0),
    openingDate: b.opening_date,
    defaultFor: toMethods(b.is_default_for),
    isActive: b.is_active ?? true,
    totalIn: Number(b.total_in ?? 0),
    totalOut: Number(b.total_out ?? 0),
    balance: Number(b.balance ?? 0),
    lastMoveAt: b.last_move_at,
    moveCount: Number(b.move_count ?? 0),
  }))
}

/** The active default account for a payment method ('cash' for supply cash moves and cash orders). */
export function defaultAccountFor(accounts: CashAccount[], method: ProdPaymentMethod): CashAccount | undefined {
  return accounts.find(a => a.isActive && a.defaultFor.includes(method))
}

export interface CashMovement {
  id: string
  accountId: string
  accountName: string
  moveDate: string
  /** Positive = in, negative = out. */
  amount: number
  sourceType: string
  sourceId: string | null
  /** NULL for supply moves (they have no number). */
  sourceNumber: number | null
  /** 'posted' | 'cancelled' of the source document. */
  sourceStatus: string
  orderDirection: string | null
  peerAccountName: string
  counterpartyName: string
  categoryId: string | null
  categoryName: string
  note: string
  isReversal: boolean
  createdByName: string
  /** Server-side: opening_balance + cumulative sum per account (valid under any date filter). */
  runningBalance: number
}

type MovementViewRow = {
  id: string | null; account_id: string | null; account_name: string | null; move_date: string | null; amount: number | null
  source_type: string | null; source_id: string | null; source_number: number | null; source_status: string | null
  order_direction: string | null; peer_account_name: string | null; counterparty_name: string | null
  category_id: string | null; category_name: string | null; note: string | null; is_reversal: boolean | null
  created_by_name: string | null; running_balance: number | null
}

const MOVEMENT_COLS = 'id, account_id, account_name, move_date, amount, source_type, source_id, source_number, source_status, order_direction, peer_account_name, counterparty_name, category_id, category_name, note, is_reversal, created_by_name, running_balance'

function mapMovement(r: MovementViewRow): CashMovement {
  return {
    id: r.id ?? '',
    accountId: r.account_id ?? '',
    accountName: r.account_name ?? '',
    moveDate: r.move_date ?? '',
    amount: Number(r.amount ?? 0),
    sourceType: r.source_type ?? '',
    sourceId: r.source_id,
    sourceNumber: r.source_number === null ? null : Number(r.source_number),
    sourceStatus: r.source_status ?? 'posted',
    orderDirection: r.order_direction,
    peerAccountName: r.peer_account_name ?? '',
    counterpartyName: r.counterparty_name ?? '',
    categoryId: r.category_id,
    categoryName: r.category_name ?? '',
    note: r.note ?? '',
    isReversal: r.is_reversal === true,
    createdByName: r.created_by_name ?? '',
    runningBalance: Number(r.running_balance ?? 0),
  }
}

/** Ledger lines (prod_cash_movements_v), oldest first, optionally one account and [fromIso, toIso). */
export async function fetchCashMovements(supabase: Client, opts: { accountId?: string; fromIso?: string; toIso?: string } = {}): Promise<{ data: CashMovement[]; error: unknown }> {
  const { data, error } = await fetchAllRows<MovementViewRow>((from, to) => {
    let q = supabase.from('prod_cash_movements_v').select(MOVEMENT_COLS)
    if (opts.accountId) q = q.eq('account_id', opts.accountId)
    if (opts.fromIso) q = q.gte('move_date', opts.fromIso)
    if (opts.toIso) q = q.lt('move_date', opts.toIso)
    return q.order('move_date').order('created_at').order('id').range(from, to)
  })
  return { data: data.map(mapMovement), error }
}

/**
 * Balance of an account just before `beforeIso`: the running_balance of the
 * last earlier line, or the opening balance when there is none.
 */
export async function fetchBalanceBefore(supabase: Client, account: Pick<CashAccount, 'id' | 'openingBalance'>, beforeIso: string): Promise<number> {
  const { data } = await supabase.from('prod_cash_movements_v').select('running_balance')
    .eq('account_id', account.id).lt('move_date', beforeIso)
    .order('move_date', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle()
  return data?.running_balance !== null && data?.running_balance !== undefined ? Number(data.running_balance) : account.openingBalance
}

export interface CashAccountPeriod { opening: number; totalIn: number; totalOut: number; closing: number }

/**
 * In / out of an account's lines within a period, by ORIGINAL direction and
 * net of reversals (same rule as prod_cash_balances.total_in / total_out), so
 * a cancelled payment does not inflate both columns. closing = opening + in - out.
 */
export function accountPeriod(opening: number, periodMovements: CashMovement[]): CashAccountPeriod {
  let totalIn = 0
  let totalOut = 0
  for (const m of periodMovements) {
    if (m.isReversal) {
      // +X reverses an outflow, -X reverses an inflow.
      if (m.amount > 0) totalOut -= m.amount
      else totalIn += m.amount
    } else if (m.amount > 0) totalIn += m.amount
    else totalOut -= m.amount
  }
  totalIn = round2(totalIn)
  totalOut = round2(totalOut)
  return { opening: round2(opening), totalIn, totalOut, closing: round2(opening + totalIn - totalOut) }
}

/** Today's in / out per account (local day; reversals counted on their own side). */
export async function fetchTodayTotals(supabase: Client): Promise<Map<string, { in: number; out: number }>> {
  const start = new Date(`${localYmd()}T00:00:00`)
  const { data } = await fetchAllRows<{ account_id: string; amount: number }>((from, to) =>
    supabase.from('prod_cash_movements').select('account_id, amount').gte('move_date', start.toISOString())
      .order('id').range(from, to))
  const out = new Map<string, { in: number; out: number }>()
  for (const r of data) {
    const cur = out.get(r.account_id) ?? { in: 0, out: 0 }
    const a = Number(r.amount)
    if (a > 0) cur.in = round2(cur.in + a)
    else cur.out = round2(cur.out - a)
    out.set(r.account_id, cur)
  }
  return out
}

export interface CashOrderRow {
  id: string
  number: number
  /** 'in' | 'out' */
  direction: string
  /** timestamptz */
  doc_date: string
  account_id: string
  amount: number
  category_id: string | null
  counterparty_name: string | null
  purpose: string | null
  note: string | null
  status: string
  created_by_name: string | null
  created_at: string
}

export interface CashTransferRow {
  id: string
  number: number
  /** timestamptz */
  doc_date: string
  from_account_id: string
  to_account_id: string
  amount: number
  note: string | null
  status: string
  created_by_name: string | null
  created_at: string
}
