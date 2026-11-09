'use client'

// Quantity entry and display helpers for recipes and production documents.
// Every quantity is stored in the item's base unit; kg items may be typed in
// kg or g and l items in l or ml (see EntryUnit in lib/production.ts).

import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { prodFieldCls } from '@/components/production/ProdKit'
import {
  GROUP_UNIT, entryUnitKey, entryUnitsOf, formatQty4, fromBaseQty, parseDecimal, smartQty, toBaseQty, toInputString,
  type EntryUnit, type ProdUnit, type UnitGroup,
} from '@/lib/production'

/** Switching the entry unit keeps the amount: "0.25" kg -> "250" g. */
export function convertEntry(value: string, base: ProdUnit, from: EntryUnit, to: EntryUnit): string {
  const n = parseDecimal(value)
  if (n === 0 || from === to) return value
  return toInputString(fromBaseQty(toBaseQty(n, base, from), base, to))
}

/** Typed value -> base-unit quantity. */
export function entryToBase(value: string, base: ProdUnit, unit: EntryUnit): number {
  return toBaseQty(parseDecimal(value), base, unit)
}

/** Formatting of base-unit quantities: smart (0.25 kg -> 250 g) or in a given entry unit. */
export function useQtyFormat() {
  const { t } = useLanguage()
  const smart = useCallback((qty: number, base: ProdUnit) => {
    const s = smartQty(qty, base)
    return `${formatQty4(s.value)} ${t(entryUnitKey(s.unit))}`
  }, [t])
  const inUnit = useCallback((qty: number, base: ProdUnit, unit: EntryUnit) =>
    `${formatQty4(fromBaseQty(qty, base, unit))} ${t(entryUnitKey(unit))}`, [t])
  /** "1 050 kg + 2 l + 15 dona" (groups are in kg / l / pcs / m). */
  const groups = useCallback((sums: { group: UnitGroup; qty: number }[]) =>
    sums.length === 0 ? '—' : sums.map(s => smart(s.qty, GROUP_UNIT[s.group])).join(' + '), [smart])
  return { smart, inUnit, groups }
}

/** Small kg|g or l|ml toggle; renders a plain unit label for single-unit items. */
export function UnitToggle({ base, value, onChange }: { base: ProdUnit; value: EntryUnit; onChange: (u: EntryUnit) => void }) {
  const { t } = useLanguage()
  const units = entryUnitsOf(base)
  if (units.length === 1) {
    return <span className="inline-flex h-8 min-w-10 items-center justify-center px-1 text-xs text-gray-400 dark:text-gray-500">{t(entryUnitKey(units[0]))}</span>
  }
  return (
    <div className="inline-flex shrink-0 rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
      {units.map(u => (
        <button
          key={u}
          type="button"
          tabIndex={-1}
          onClick={() => onChange(u)}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            value === u
              ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
              : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
          )}
        >
          {t(entryUnitKey(u))}
        </button>
      ))}
    </div>
  )
}

/** Decimal input + unit toggle. Changing the unit converts the typed amount. */
export function UnitQtyInput({ value, onChange, base, unit, onUnitChange, invalid, className }: {
  value: string
  onChange: (value: string) => void
  base: ProdUnit
  unit: EntryUnit
  onUnitChange: (unit: EntryUnit, convertedValue: string) => void
  invalid?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <input
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={e => e.target.select()}
        placeholder="0"
        className={cn(prodFieldCls, 'h-8 min-w-0 flex-1 text-right tabular-nums', invalid && 'border-red-300 dark:border-red-800')}
      />
      <UnitToggle base={base} value={unit} onChange={u => onUnitChange(u, convertEntry(value, base, unit, u))} />
    </div>
  )
}
