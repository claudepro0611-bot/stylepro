'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Currency = 'UZS' | 'USD'

const USD_RATE = 12800

interface CurrencyContextValue {
  currency: Currency
  setCurrency: (c: Currency) => void
  formatPrice: (amount: number) => string
  formatShortPrice: (amount: number) => string
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null)

const STORAGE_KEY = 'stylepro-currency'

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>('UZS')

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'UZS' || stored === 'USD') setCurrencyState(stored as Currency)
  }, [])

  function setCurrency(next: Currency) {
    setCurrencyState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
  }

  function formatPrice(amount: number): string {
    if (currency === 'USD') {
      return '$' + (amount / USD_RATE).toFixed(2)
    }
    return new Intl.NumberFormat('ru-RU').format(amount) + ' UZS'
  }

  function formatShortPrice(amount: number): string {
    if (currency === 'USD') {
      const usd = amount / USD_RATE
      if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'K'
      return '$' + usd.toFixed(0)
    }
    if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M'
    if (amount >= 1_000) return (amount / 1_000).toFixed(0) + 'K'
    return String(amount)
  }

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency, formatPrice, formatShortPrice }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider')
  return ctx
}
