'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { localYmd } from '@/lib/utils/date'

export type Currency = 'UZS' | 'USD'

// Used when the company has no exchange_rates row yet, the read fails, or
// nobody is signed in (this provider also wraps the login page).
export const DEFAULT_USD_RATE = 12800

interface CurrencyContextValue {
  currency: Currency
  setCurrency: (c: Currency) => void
  formatPrice: (amount: number) => string
  formatShortPrice: (amount: number) => string
  usdRate: number
  usdRateDate: string | null
  refreshRate: () => Promise<void>
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null)

const STORAGE_KEY = 'stylepro-currency'

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>('UZS')
  const [usdRate, setUsdRate] = useState(DEFAULT_USD_RATE)
  const [usdRateDate, setUsdRateDate] = useState<string | null>(null)
  // Drops results of an older in-flight read when a newer one was started
  // (e.g. mount read racing a SIGNED_IN re-read).
  const requestIdRef = useRef(0)

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'UZS' || stored === 'USD') setCurrencyState(stored as Currency)
  }, [])

  const refreshRate = useCallback(async () => {
    const requestId = ++requestIdRef.current
    let rate = DEFAULT_USD_RATE
    let rateDate: string | null = null
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        // RLS scopes exchange_rates to the caller's company.
        const { data, error } = await supabase
          .from('exchange_rates')
          .select('rate, rate_date')
          .eq('currency', 'USD')
          .lte('rate_date', localYmd())
          .order('rate_date', { ascending: false })
          .limit(1)
          .maybeSingle()
        const value = Number(data?.rate)
        if (!error && data && Number.isFinite(value) && value > 0) {
          rate = value
          rateDate = data.rate_date
        }
      }
    } catch {
      // fall back to DEFAULT_USD_RATE
    }
    if (requestId !== requestIdRef.current) return
    setUsdRate(rate)
    setUsdRateDate(rateDate)
  }, [])

  useEffect(() => {
    refreshRate()
    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      // Deferred: awaiting other supabase calls inside this callback can
      // deadlock the auth client.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') setTimeout(() => { refreshRate() }, 0)
    })
    return () => subscription.unsubscribe()
  }, [refreshRate])

  function setCurrency(next: Currency) {
    setCurrencyState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
  }

  function formatPrice(amount: number): string {
    if (currency === 'USD') {
      return '$' + (amount / usdRate).toFixed(2)
    }
    return new Intl.NumberFormat('ru-RU').format(amount) + ' UZS'
  }

  function formatShortPrice(amount: number): string {
    if (currency === 'USD') {
      const usd = amount / usdRate
      if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K'
      return '$' + usd.toFixed(0)
    }
    if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M'
    if (amount >= 1_000) return (amount / 1_000).toFixed(0) + 'K'
    return String(amount)
  }

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, formatPrice, formatShortPrice, usdRate, usdRateDate, refreshRate }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider')
  return ctx
}
