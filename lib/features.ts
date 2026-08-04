'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'

// Fail closed: if the fetch (or the RLS check behind it) fails, assume every
// feature is disabled rather than granting access to paid/gated modules.
// Keep this in sync with feature_definitions — expenses and shift_system
// were added by later migrations (20260714000002, 20260713000001) after
// this list was first written. A key missing from this object, or missing
// from the company's company_features rows, must resolve to `false`.
const DEFAULT_FEATURES: Record<string, boolean> = {
  pos: false,
  warehouse: false,
  hr: false,
  marketing: false,
  reports: false,
  barcode: false,
  excel_import: false,
  expenses: false,
  shift_system: false,
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
          console.error('[useFeatures] fetch failed, denying all features:', error?.message)
          if (!cancelled) setFeatures({ ...DEFAULT_FEATURES })
          return
        }

        // Start from all-false so a feature with no row (i.e. the company
        // hasn't activated it) explicitly resolves to `false`, not undefined.
        const map: Record<string, boolean> = { ...DEFAULT_FEATURES }
        data.forEach(f => { map[f.feature_key] = f.is_active })

        if (!cancelled) setFeatures(map)
      } catch (err) {
        console.error('[useFeatures] unexpected error, denying all features:', err)
        if (!cancelled) setFeatures({ ...DEFAULT_FEATURES })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  return { features, loading }
}
