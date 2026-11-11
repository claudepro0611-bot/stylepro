'use client'

// Shared poll of prod_notifications() (migration 20261110000019): one request
// per minute for the whole shell (bell + sidebar badge), only while the tab is
// visible, plus a refresh when the window regains focus. `available` stays
// false while the RPC does not exist, so callers hide their UI.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useSession } from '@/lib/session/SessionContext'
import { useFeatures } from '@/lib/features'
import { fetchNotifications, type ProdNotification } from '@/lib/approvals'

const POLL_MS = 60_000

interface NotifState { available: boolean; items: ProdNotification[]; loadedAt: number }

let state: NotifState = { available: false, items: [], loadedAt: 0 }
let ownerKey: string | null = null
let inflight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let subscribers = 0
const listeners = new Set<() => void>()

function emit() { listeners.forEach(l => l()) }

function load(): Promise<void> {
  if (inflight) return inflight
  const key = ownerKey
  inflight = (async () => {
    const items = await fetchNotifications(createClient())
    if (key !== ownerKey) return
    state = items === null ? { available: false, items: [], loadedAt: Date.now() } : { available: true, items, loadedAt: Date.now() }
    emit()
  })().finally(() => { inflight = null })
  return inflight
}

function onVisible() {
  if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 5_000) void load()
}

function start() {
  if (timer) return
  timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, POLL_MS)
  window.addEventListener('focus', onVisible)
  document.addEventListener('visibilitychange', onVisible)
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
  window.removeEventListener('focus', onVisible)
  document.removeEventListener('visibilitychange', onVisible)
}

/** Re-reads the feed now (after deciding / sending a request). */
export function refreshProdNotifications() {
  if (ownerKey) void load()
}

/** Whether the shell should show production notifications for this firm. */
export function useProductionEnabled(): boolean {
  const { company, isSuperAdmin } = useSession()
  const { features } = useFeatures()
  if (isSuperAdmin || !company) return false
  return company.businessType === 'production' || !!features.production
}

export function useProdNotifications(): NotifState & { refresh: () => void } {
  const { userId } = useSession()
  const enabled = useProductionEnabled()
  const [, force] = useState(0)

  useEffect(() => {
    if (!enabled || !userId) return
    const l = () => force(n => n + 1)
    listeners.add(l)
    subscribers += 1
    if (ownerKey !== userId) {
      ownerKey = userId
      state = { available: false, items: [], loadedAt: 0 }
      void load()
    } else if (Date.now() - state.loadedAt > POLL_MS) {
      void load()
    }
    start()
    return () => {
      listeners.delete(l)
      subscribers -= 1
      if (subscribers <= 0) stop()
    }
  }, [enabled, userId])

  const current = enabled && userId && ownerKey === userId ? state : { available: false, items: [], loadedAt: 0 }
  return { ...current, refresh: refreshProdNotifications }
}
