'use client'

// Local draft autosave for the "yangi" document forms. The form state is
// written to localStorage (per user and per form) 2 s after the last change;
// when the form opens and a draft exists, the caller shows <DraftBanner />
// ("Qoralama tiklansinmi?") with Tiklash / O'chirish. clear() after a
// successful save. Nothing is sent to the server: drafts never touch stock.
//
// While a draft is offered, autosave is paused so an untouched new form can
// not overwrite it. Drafts older than DRAFT_MAX_AGE_MS are ignored.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '@/lib/session/SessionContext'

const PREFIX = 'stylepro-draft:'
const SAVE_DELAY_MS = 2000
const DRAFT_MAX_AGE_MS = 7 * 24 * 3600 * 1000

interface StoredDraft<T> { v: 1; at: number; data: T }

export interface DraftOffer { savedAt: number }

function read<T>(key: string): StoredDraft<T> | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw) as StoredDraft<T>
    if (!d || d.v !== 1 || typeof d.at !== 'number' || Date.now() - d.at > DRAFT_MAX_AGE_MS) return null
    return d
  } catch {
    return null
  }
}

function write(key: string, data: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify({ v: 1, at: Date.now(), data })) } catch { /* quota / private mode */ }
}

function remove(key: string) {
  try { window.localStorage.removeItem(key) } catch { /* ignore */ }
}

/**
 * @param formKey  stable form id, e.g. 'sale' or `stock-count:${id}`
 * @param state    JSON-serialisable snapshot of the form
 * @param apply    puts a restored snapshot back into the form
 * @param opts.ready   wait until reference data is loaded before offering (default true)
 * @param opts.isEmpty snapshots considered empty are not stored
 * @param opts.enabled false = no offer and no autosave (e.g. a form prefilled from a link)
 */
export function useFormDraft<T>(formKey: string, state: T, apply: (s: T) => void, opts: { ready?: boolean; isEmpty?: (s: T) => boolean; enabled?: boolean } = {}) {
  const { userId } = useSession()
  const ready = opts.ready ?? true
  const key = userId && opts.enabled !== false ? `${PREFIX}${userId}:${formKey}` : null
  const [offer, setOffer] = useState<DraftOffer | null>(null)
  // 'idle' = not checked yet, 'offer' = waiting for the user, 'active' = autosaving.
  const phase = useRef<'idle' | 'offer' | 'active'>('idle')
  // Snapshot that counts as "unchanged" (no save); null = take the next one.
  const baseline = useRef<string | null>(null)
  const timer = useRef<number | null>(null)
  const pending = useRef<StoredDraft<T> | null>(null)
  const applyRef = useRef(apply)
  const emptyRef = useRef(opts.isEmpty)
  useEffect(() => { applyRef.current = apply; emptyRef.current = opts.isEmpty })

  const json = JSON.stringify(state)
  const jsonRef = useRef(json)
  useEffect(() => { jsonRef.current = json })

  // Check for a stored draft once the user and the reference data are known.
  useEffect(() => {
    if (!key || !ready || phase.current !== 'idle') return
    const d = read<T>(key)
    if (d && !(emptyRef.current?.(d.data))) {
      pending.current = d
      phase.current = 'offer'
      setOffer({ savedAt: d.at })
    } else {
      phase.current = 'active'
      baseline.current = json
    }
  }, [key, ready, json])

  // Autosave 2 s after the last change.
  useEffect(() => {
    if (!key || phase.current !== 'active') return
    if (baseline.current === null) { baseline.current = json; return }
    if (json === baseline.current) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      const snapshot = JSON.parse(json) as T
      if (emptyRef.current?.(snapshot)) remove(key)
      else write(key, snapshot)
    }, SAVE_DELAY_MS)
  }, [key, json])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const restore = useCallback(() => {
    const d = pending.current
    pending.current = null
    setOffer(null)
    phase.current = 'active'
    baseline.current = null
    if (d) applyRef.current(d.data)
  }, [])

  const discard = useCallback(() => {
    if (key) remove(key)
    pending.current = null
    setOffer(null)
    phase.current = 'active'
    baseline.current = jsonRef.current
  }, [key])

  /** After a successful save: drop the draft; a following form reset is not stored. */
  const clear = useCallback(() => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    if (key) remove(key)
    pending.current = null
    setOffer(null)
    phase.current = 'active'
    baseline.current = null
  }, [key])

  return { offer, restore, discard, clear }
}
