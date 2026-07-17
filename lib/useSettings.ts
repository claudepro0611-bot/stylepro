'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'

export interface CompanySettings {
  product: {
    unit_types: string[]
    block_size: number
  }
}

const DEFAULT_SETTINGS: CompanySettings = {
  product: { unit_types: ['dona'], block_size: 1 },
}

export function useSettings() {
  const [settings, setSettings] = useState<CompanySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    async function load() {
      try {
        // Super admin has no company of their own — company_settings has
        // no row for them, and .single() would error querying it.
        const companyId = await getCompanyId(supabase)
        if (!companyId) return

        const { data, error } = await supabase
          .from('company_settings')
          .select('settings')
          .single()

        if (!error && data?.settings) {
          if (!cancelled) setSettings(data.settings as unknown as CompanySettings)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  return { settings, loading }
}
