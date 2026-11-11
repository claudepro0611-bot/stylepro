'use client'

// Building blocks of the "Separatsiya" pages (milk -> cream + skim): form
// sections, decimal fields with a suffix, the big live result figures and
// the fat-balance check. Writes go through prod_create_separation only.

import type { ReactNode } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { prodCardCls, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { formatQty, type SeparationAllocation, type SeparationResult } from '@/lib/production'
import type { TranslationKey } from '@/lib/i18n/translations'

export function allocationKey(method: string): TranslationKey {
  if (method === 'value') return 'production.separation.methodValue'
  if (method === 'fat') return 'production.separation.methodFat'
  return 'production.separation.methodSkimPrice'
}

export function allocationHintKey(method: SeparationAllocation): TranslationKey {
  if (method === 'value') return 'production.separation.methodValueHint'
  if (method === 'fat') return 'production.separation.methodFatHint'
  return 'production.separation.methodSkimPriceHint'
}

/** Form section card with a numbered title and a plain-language hint. */
export function SepSection({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn(prodCardCls, 'p-5 space-y-4', className)}>
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {hint && <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

/** Decimal input with a unit suffix ("kg", "%", "so'm"). */
export function NumField({ label, value, onChange, suffix, hint, error, disabled, readOnly, big }: {
  label: string
  value: string
  onChange?: (v: string) => void
  suffix?: string
  hint?: ReactNode
  error?: string
  disabled?: boolean
  readOnly?: boolean
  big?: boolean
}) {
  return (
    <label className="block">
      <span className={prodLabelCls}>{label}</span>
      <div className="relative">
        <input
          inputMode="decimal"
          value={value}
          onChange={e => onChange?.(e.target.value)}
          onFocus={e => e.target.select()}
          disabled={disabled}
          readOnly={readOnly}
          placeholder="0"
          className={cn(
            prodFieldCls,
            'text-right tabular-nums',
            suffix && 'pr-12',
            big && 'h-11 text-base font-medium',
            readOnly && 'bg-gray-50 dark:bg-gray-800/60',
            error && 'border-red-300 dark:border-red-800',
          )}
        />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{suffix}</span>}
      </div>
      {error ? (
        <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{hint}</span>
      ) : null}
    </label>
  )
}

/** Quick value chips (cream fat 10 / 20 / 30 / 33 / 35). */
export function ValueChips({ values, value, onPick, suffix }: { values: readonly number[]; value: number | null; onPick: (v: number) => void; suffix?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map(v => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          className={cn(
            'rounded-lg px-2.5 py-1 text-xs font-medium tabular-nums transition-colors',
            value === v
              ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
              : 'border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
          )}
        >
          {v}{suffix}
        </button>
      ))}
    </div>
  )
}

/** One big live figure of the result card. */
export function BigFigure({ label, qty, unit, sub, muted }: { label: string; qty: number; unit: string; sub?: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <p className={cn(
        'mt-1 font-semibold tabular-nums tracking-tight',
        muted ? 'text-2xl' : 'text-4xl',
        qty > 0 ? 'text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600',
      )}>
        {formatQty(qty > 0 ? qty : 0)} <span className={cn('font-medium text-gray-400 dark:text-gray-500', muted ? 'text-base' : 'text-xl')}>{unit}</span>
      </p>
      {sub && <p className="mt-0.5 text-[12px] tabular-nums text-gray-500 dark:text-gray-400">{sub}</p>}
    </div>
  )
}

const pill = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'

export function BalanceBadge({ state }: { state: SeparationResult['balance'] }) {
  const { t } = useLanguage()
  if (state === 'ok') {
    return <span className={cn(pill, 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400')}><Check className="h-3 w-3" /> {t('production.separation.balanceOk')}</span>
  }
  if (state === 'warn') {
    return <span className={cn(pill, 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400')}><AlertTriangle className="h-3 w-3" /> {t('production.separation.fatDiff')}</span>
  }
  return <span className={cn(pill, 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400')}><X className="h-3 w-3" /> {t('production.separation.fatDiff')}</span>
}

/** Fat balance: milk fat kg vs cream + skim (+ loss) fat kg, with a status line. */
export function FatBalance({ r }: { r: Pick<SeparationResult, 'milkFatKg' | 'outputsFatKg' | 'lossFatKg' | 'fatDiffKg' | 'balance'> }) {
  const { t } = useLanguage()
  const kg = t('production.units.kg')
  const rows: { label: string; value: number; strong?: boolean }[] = [
    { label: t('production.separation.fatInMilk'), value: r.milkFatKg },
    { label: t('production.separation.fatInOutputs'), value: r.outputsFatKg },
    { label: t('production.separation.fatInLoss'), value: r.lossFatKg },
    { label: t('production.separation.fatDiff'), value: r.fatDiffKg, strong: true },
  ]
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.separation.fatBalance')}</span>
        <BalanceBadge state={r.balance} />
      </div>
      {rows.map(row => (
        <div key={row.label} className={cn('flex items-center justify-between gap-4 text-sm', row.strong && 'border-t border-gray-200 dark:border-gray-700 pt-2')}>
          <span className="text-gray-500 dark:text-gray-400">{row.label}</span>
          <span className={cn(
            'tabular-nums',
            row.strong ? 'font-semibold' : 'font-medium',
            row.strong && r.balance === 'impossible' ? 'text-red-600 dark:text-red-400'
              : row.strong && r.balance === 'warn' ? 'text-amber-600 dark:text-amber-400'
                : 'text-gray-900 dark:text-gray-100',
          )}>
            {row.strong && row.value > 0 ? '+' : ''}{formatQty(row.value)} {kg}
          </span>
        </div>
      ))}
      {r.balance !== 'ok' && (
        <p className={cn('text-[12px]', r.balance === 'impossible' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400')}>
          {r.balance === 'impossible' ? t('production.separation.balanceImpossible') : t('production.separation.balanceWarn')}
        </p>
      )}
    </div>
  )
}
