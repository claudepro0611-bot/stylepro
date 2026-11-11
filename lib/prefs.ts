'use client'

// Per-user UI preferences (migration 20261110000019, prod_user_prefs):
// home page choice, tablet mode, sidebar favorites and hidden menu leaves.
// Read with prod_get_user_prefs() (defaults when the caller has no row), saved
// through prod_save_user_prefs(p_data jsonb) (partial: absent key = unchanged). While the migration is not
// applied (or a call fails) the prefs live in localStorage, so the UI works
// the same, just per device.
//
// Shared API for every track: const { prefs, loading, save } = usePrefs()
// save(partial) merges the partial into the current prefs (optimistic).

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useSession } from '@/lib/session/SessionContext'

export const HOME_CHOICES = ['auto', 'dashboard', 'milk', 'lab', 'stock', 'sales', 'cash'] as const
export type HomeChoice = typeof HOME_CHOICES[number]

export const FAVORITES_MAX = 12

export interface UserPrefs {
  /** null = not chosen (same as 'auto'). */
  home: HomeChoice | null
  /** Sidebar leaf hrefs, max FAVORITES_MAX. */
  favorites: string[]
  /** Sidebar leaf hrefs hidden from the menu (still reachable via Ctrl+K). */
  hiddenMenu: string[]
  tabletMode: boolean
}

export const DEFAULT_PREFS: UserPrefs = { home: null, favorites: [], hiddenMenu: [], tabletMode: false }

interface PrefsRow {
  home?: string | null
  favorites?: string[] | null
  hidden_menu?: string[] | null
  tablet_mode?: boolean | null
}

const strList = (v: unknown, max?: number): string[] => {
  if (!Array.isArray(v)) return []
  const out = Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && x.startsWith('/'))))
  return max ? out.slice(0, max) : out
}

export function mapPrefsRow(r: PrefsRow | null | undefined): UserPrefs {
  if (!r) return DEFAULT_PREFS
  return {
    home: (HOME_CHOICES as readonly string[]).includes(r.home ?? '') ? (r.home as HomeChoice) : null,
    favorites: strList(r.favorites, FAVORITES_MAX),
    hiddenMenu: strList(r.hidden_menu),
    tabletMode: r.tablet_mode === true,
  }
}

function toRow(p: UserPrefs): Required<PrefsRow> {
  return { home: p.home, favorites: p.favorites, hidden_menu: p.hiddenMenu, tablet_mode: p.tabletMode }
}

// ---------------------------------------------------------------------------
// Module store: one load per user, shared by every usePrefs() consumer.

const LS_PREFIX = 'stylepro-prefs:'

interface Store {
  userId: string
  prefs: UserPrefs
  loaded: boolean
  /** true when the DB row / RPC is usable (migration applied). */
  remote: boolean
  promise: Promise<void> | null
}

let store: Store | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

function readLocal(userId: string): UserPrefs | null {
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + userId)
    return raw ? mapPrefsRow(JSON.parse(raw) as PrefsRow) : null
  } catch {
    return null
  }
}

function writeLocal(userId: string, p: UserPrefs) {
  try {
    window.localStorage.setItem(LS_PREFIX + userId, JSON.stringify(toRow(p)))
  } catch {
    // storage unavailable: prefs just won't persist on this device
  }
}

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>

function rpcOf(): UntypedRpc {
  const supabase = createClient()
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc
}

function ensureLoaded(userId: string): Promise<void> {
  if (store && store.userId === userId && (store.loaded || store.promise)) return store.promise ?? Promise.resolve()
  const local = readLocal(userId)
  store = { userId, prefs: local ?? DEFAULT_PREFS, loaded: false, remote: false, promise: null }
  const s = store
  s.promise = (async () => {
    try {
      const { data, error } = await rpcOf()('prod_get_user_prefs')
      if (!error) {
        s.remote = true
        const row = data as (PrefsRow & { updated_at?: string | null }) | null
        // No row yet (updated_at null): keep what this device had (uploaded on the next save).
        if (row && (row.updated_at || !local)) {
          s.prefs = mapPrefsRow(row)
          writeLocal(userId, s.prefs)
        }
      }
    } catch {
      // migration not applied / offline: localStorage only
    }
    s.loaded = true
    s.promise = null
    if (store === s) emit()
  })()
  return s.promise
}

async function persist(userId: string, p: UserPrefs, remote: boolean) {
  writeLocal(userId, p)
  if (!remote) return
  try {
    await rpcOf()('prod_save_user_prefs', { p_data: toRow(p) })
  } catch {
    // kept locally; the next successful save uploads it
  }
}

/** Current prefs and a merge-save. `loading` is true until the first read finished. */
export function usePrefs() {
  const { userId } = useSession()
  const [, force] = useState(0)

  useEffect(() => {
    const l = () => force(n => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])

  useEffect(() => {
    if (userId) void ensureLoaded(userId).then(() => force(n => n + 1))
  }, [userId])

  const save = useCallback(async (partial: Partial<UserPrefs>) => {
    if (!store || !userId || store.userId !== userId) return
    const next: UserPrefs = { ...store.prefs, ...partial }
    next.favorites = strList(next.favorites, FAVORITES_MAX)
    next.hiddenMenu = strList(next.hiddenMenu)
    store.prefs = next
    emit()
    await persist(userId, next, store.remote)
  }, [userId])

  const current = store && userId && store.userId === userId ? store : null
  return {
    prefs: current?.prefs ?? DEFAULT_PREFS,
    loading: !current || !current.loaded,
    save,
  }
}
