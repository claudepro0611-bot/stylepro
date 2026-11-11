'use client'

// Offline queue for milk weighing (Sut qabuli / tarozi). When
// prod_create_milk_intake fails with a NETWORK error (no response from the
// server - not a server-side rejection), the p_data payload is kept in
// localStorage under a client uuid and retried on the 'online' event and every
// 30 s. Writes still go through prod_create_milk_intake only.
//
// Idempotency: a queue item is removed only after a successful post. Before
// every (re)try we look for an existing intake with the same supplier, net kg
// and intake minute (intake_date is set by the client and sent unchanged), so a
// post whose response was lost is not repeated.
// Limitation: two genuinely identical weighings (same supplier, same net kg,
// same intake minute) are treated as one - the queued one is dropped as
// "already posted". The check reads prod_milk_intakes (RLS-scoped) and skips
// cancelled intakes. Queue items live per browser and per user; another
// device does not see them.
// Server errors during a retry (validation, needs_approval, period closed)
// mark the item as failed; it is never retried automatically again.

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useSession } from '@/lib/session/SessionContext'
import { round3 } from '@/lib/production'

const PREFIX = 'stylepro-milk-queue:'
const RETRY_MS = 30_000
const CHANGE_EVENT = 'stylepro-milk-queue-change'

export interface QueuedIntake {
  cid: string
  queuedAt: number
  /** p_data of prod_create_milk_intake (no override keys). */
  payload: Record<string, unknown>
  /** Display helpers. */
  supplierName: string
  netKg: number
  attempts: number
  /** Server error of the last retry; the item is then left for the operator. */
  failed?: { message: string; details?: string | null }
}

interface ErrLike { message?: string | null; code?: string | null; details?: string | null }

/**
 * True for errors where the request most likely never reached Postgres:
 * the browser is offline or fetch itself failed (supabase-js returns these
 * with an empty code). Server errors always carry a SQLSTATE / PGRST code.
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (!err) return false
  const e = err as ErrLike
  if (e.code) return false
  const msg = String(e.message ?? err)
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|err_network|timeout|aborted/i.test(msg)
}

function newCid(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

function readQueue(userId: string): QueuedIntake[] {
  try {
    const raw = window.localStorage.getItem(PREFIX + userId)
    const list = raw ? (JSON.parse(raw) as QueuedIntake[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeQueue(userId: string, list: QueuedIntake[]) {
  try {
    if (list.length === 0) window.localStorage.removeItem(PREFIX + userId)
    else window.localStorage.setItem(PREFIX + userId, JSON.stringify(list))
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function updateItem(userId: string, cid: string, patch: Partial<QueuedIntake> | null) {
  const list = readQueue(userId)
  writeQueue(userId, patch === null ? list.filter(i => i.cid !== cid) : list.map(i => (i.cid === cid ? { ...i, ...patch } : i)))
}

/** Net kg of a payload (truck: gross - tare). */
export function payloadNetKg(p: Record<string, unknown>): number {
  if (p.net_kg != null) return round3(Number(p.net_kg))
  return round3(Number(p.gross_kg ?? 0) - Number(p.tare_kg ?? 0))
}

/** Existing intake with the same supplier / net kg / intake minute: id, null = none, undefined = could not check. */
async function findExisting(p: Record<string, unknown>): Promise<string | null | undefined> {
  const at = new Date(String(p.intake_date ?? ''))
  if (Number.isNaN(at.getTime())) return null
  const from = new Date(Math.floor(at.getTime() / 60000) * 60000)
  const to = new Date(from.getTime() + 60000)
  try {
    const { data, error } = await createClient().from('prod_milk_intakes')
      .select('id')
      .eq('supplier_id', String(p.supplier_id))
      .eq('net_kg', payloadNetKg(p))
      .gte('intake_date', from.toISOString())
      .lt('intake_date', to.toISOString())
      .neq('status', 'cancelled')
      .limit(1)
    if (error) return undefined
    return data && data.length > 0 ? data[0].id : null
  } catch {
    return undefined
  }
}

let flushing = false

type LockManager = { request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<number>) => Promise<number> }

/** One flush at a time across tabs (Web Locks when available, else per tab). */
function flushLocked(userId: string, opts: { force?: string }): Promise<number> {
  const locks = (typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: LockManager }).locks : undefined)
  if (!locks) return flushQueue(userId, opts)
  return locks.request(`${PREFIX}${userId}`, { ifAvailable: true }, async lock => (lock ? flushQueue(userId, opts) : 0))
}

/**
 * Posts queued items one by one (oldest first). Stops at the first network
 * error. Returns the number of items that left the queue as posted.
 */
async function flushQueue(userId: string, opts: { force?: string } = {}): Promise<number> {
  if (flushing) return 0
  flushing = true
  let posted = 0
  try {
    for (const item of readQueue(userId)) {
      const forced = opts.force === item.cid
      if (item.failed && !forced) continue
      if (!forced) {
        const existing = await findExisting(item.payload)
        if (existing === undefined) break
        if (existing) {
          // Posted earlier (e.g. the response was lost): never post twice.
          updateItem(userId, item.cid, null)
          posted += 1
          continue
        }
      }
      let res: { error: ErrLike | null }
      try {
        res = await createClient().rpc('prod_create_milk_intake', { p_data: item.payload as never })
      } catch (e) {
        res = { error: { message: String(e) } }
      }
      if (res.error && isNetworkError(res.error)) {
        updateItem(userId, item.cid, { attempts: item.attempts + 1 })
        break
      }
      if (res.error) {
        updateItem(userId, item.cid, { attempts: item.attempts + 1, failed: { message: String(res.error.message ?? ''), details: res.error.details ?? null } })
        continue
      }
      updateItem(userId, item.cid, null)
      posted += 1
    }
  } finally {
    flushing = false
  }
  return posted
}

/** Queue state + actions; while mounted it retries on 'online' and every 30 s. */
export function useMilkOfflineQueue(onPosted?: (n: number) => void) {
  const { userId } = useSession()
  const [items, setItems] = useState<QueuedIntake[]>([])

  useEffect(() => {
    if (!userId) return
    const sync = () => setItems(readQueue(userId))
    sync()
    window.addEventListener(CHANGE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(CHANGE_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [userId])

  const flush = useCallback(async (force?: string) => {
    if (!userId) return
    const n = await flushLocked(userId, { force })
    if (n > 0) onPosted?.(n)
  }, [userId, onPosted])

  useEffect(() => {
    if (!userId) return
    const run = () => { void flush() }
    run()
    window.addEventListener('online', run)
    const timer = window.setInterval(run, RETRY_MS)
    return () => { window.removeEventListener('online', run); window.clearInterval(timer) }
  }, [userId, flush])

  const enqueue = useCallback((payload: Record<string, unknown>, supplierName: string) => {
    if (!userId) return false
    const item: QueuedIntake = { cid: newCid(), queuedAt: Date.now(), payload, supplierName, netKg: payloadNetKg(payload), attempts: 1 }
    writeQueue(userId, [...readQueue(userId), item])
    return true
  }, [userId])

  const discard = useCallback((cid: string) => { if (userId) updateItem(userId, cid, null) }, [userId])

  /** Operator retries a failed item (no dedupe check: the server rejected it, so it does not exist). */
  const resend = useCallback((cid: string) => {
    if (!userId) return
    updateItem(userId, cid, { failed: undefined })
    void flush(cid)
  }, [userId, flush])

  return { items, count: items.length, enqueue, flush, discard, resend }
}
