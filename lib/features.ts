'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'

// Fail open: if the fetch (or the RLS check behind it) fails, assume every
// feature is enabled rather than locking companies out of paid modules.
// Keep this in sync with feature_definitions — expenses and shift_system
// were added by later migrations (20260714000002, 20260713000001) after
// this list was first written, and were never backfilled here. Because
// consumers key their redirect guards off `!features.<key>`, a key missing
// from this object reads as "disabled" (undefined is falsy) instead of
// "unknown, assume enabled" — that gap is what caused xarajatlar to
// bounce every user to /dashboard even though the company's real
// company_features row has it active.
const DEFAULT_FEATURES: Record<string, boolean> = {
  pos: true,
  warehouse: true,
  hr: true,
  marketing: true,
  reports: true,
  barcode: true,
  excel_import: true,
  expenses: true,
  shift_system: true,
}

export function useFeatures() {
  const [features, setFeatures] = useState<Record<string, boolean>>(DEFAULT_FEATURES)
  // Starts true, not false: a fetch is always about to run on mount, and
  // consumers gate redirects on `!loading && !features.X`. Starting this
  // false made that check pass with defaults still in place for the one
  // render before load() actually flips it — see load()'s early return
  // below for xarajatlar's specific failure mode this caused.
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const supabase = createClient()
        const companyId = await getCompanyId(supabase)
        if (!companyId) return

        if (!cancelled) setLoading(true)
        const { data, error } = await supabase
          .from('company_features')
          .select('feature_key, is_active')
          .eq('company_id', companyId)

        if (error || !data) {
          console.error('[useFeatures] fetch failed, keeping defaults:', error?.message)
          return
        }

        // Built strictly from real rows here (not from DEFAULT_FEATURES) —
        // a feature with no row means the company hasn't activated it.
        const map: Record<string, boolean> = {}
        data.forEach(f => { map[f.feature_key] = f.is_active })

        if (!cancelled) setFeatures(map)
      } catch (err) {
        console.error('[useFeatures] unexpected error, keeping defaults:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  return { features, loading }
}
