'use client'

// Client side of the accounting core (migration 20261110000018): the
// accounting settings hook (shared cache, like useControls), the per-line
// VAT rate input and the "not available yet" note. The server enforces and
// recomputes everything; these only preview.

import { useCallback, useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { cn } from '@/lib/utils'
import { prodCardCls, prodFieldCls } from '@/components/production/ProdKit'
import { DEFAULT_ACCOUNTING, STANDARD_VAT_RATE, fetchAccounting, type AccountingState } from '@/lib/production-accounting'

const CACHE_MS = 60_000
let cache: { key: string; at: number; promise: Promise<AccountingState> } | null = null

function loadAccounting(key: string, force = false): Promise<AccountingState> {
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.promise
  const promise = fetchAccounting(createClient())
  cache = { key, at: Date.now(), promise }
  return promise
}

/** Drops the cached accounting settings (after saving them). */
export function invalidateAccounting() {
  cache = null
}

const INITIAL: AccountingState = { available: false, settings: DEFAULT_ACCOUNTING }

/**
 * Accounting settings (defaults while the row is absent). `available` is
 * false while migration 20261110000018 is not applied: callers then hide
 * every VAT / co-product / overhead control and send the old payloads.
 */
export function useAccounting() {
  const { userId } = useSession()
  const [state, setState] = useState<AccountingState | null>(null)
  const key = userId ?? 'anon'

  useEffect(() => {
    let alive = true
    loadAccounting(key).then(s => { if (alive) setState(s) })
    return () => { alive = false }
  }, [key])

  const reload = useCallback(async () => {
    const s = await loadAccounting(key, true)
    setState(s)
    return s
  }, [key])

  return { ...(state ?? INITIAL), loading: state === null, reload }
}

/** Default line VAT rate: 12 for a VAT payer, else 0. */
export const defaultVatRate = (vatPayer: boolean) => (vatPayer ? STANDARD_VAT_RATE : 0)

/**
 * VAT rate of a line: 0 / 12 / custom. `value` is the rate as typed; a
 * custom rate shows a small number input next to the select.
 */
export function VatRateInput({ value, onChange, invalid, className }: {
  value: string
  onChange: (v: string) => void
  invalid?: boolean
  className?: string
}) {
  const { t } = useLanguage()
  const preset = value === '0' || value === String(STANDARD_VAT_RATE)
  const [custom, setCustom] = useState(!preset)
  const mode = custom ? 'custom' : value
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <select
        value={mode}
        onChange={e => {
          const v = e.target.value
          if (v === 'custom') { setCustom(true); return }
          setCustom(false)
          onChange(v)
        }}
        aria-label={t('prodAcct.vat.rate')}
        className={cn(prodFieldCls, 'h-8 w-[4.5rem] px-2', invalid && !custom && 'border-red-300 dark:border-red-500/50')}
      >
        <option value="0">0%</option>
        <option value={String(STANDARD_VAT_RATE)}>{STANDARD_VAT_RATE}%</option>
        <option value="custom">{t('prodAcct.vat.rateCustom')}</option>
      </select>
      {custom && (
        <input
          inputMode="decimal"
          value={value}
          onChange={e => onChange(e.target.value)}
          aria-label={t('prodAcct.vat.rate')}
          placeholder="%"
          className={cn(prodFieldCls, 'h-8 w-14 px-2 text-right tabular-nums', invalid && 'border-red-300 dark:border-red-500/50')}
        />
      )}
    </div>
  )
}

/** Card shown by the accounting pages while migration 20261110000018 is not applied (or the caller lacks the role). */
export function AcctNote({ text }: { text: string }) {
  return (
    <div className={cn(prodCardCls, 'flex items-center gap-3 p-6 text-sm text-gray-500 dark:text-gray-400')}>
      <Info className="h-4 w-4 shrink-0 text-gray-400" />
      {text}
    </div>
  )
}
