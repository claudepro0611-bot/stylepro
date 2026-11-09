'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, History } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { isPerMl } from '@/lib/sizes'
import { cn } from '@/lib/utils'

export interface PastPurchase {
  productId: string
  productSizeId: string | null
  productName: string
  size: string
  color: string
  category: string
  price: number
  quantity: number
  date: string
}

// One row per variant: its latest purchase plus how many times it was bought.
interface PastPurchaseGroup {
  key: string
  latest: PastPurchase
  timesBought: number
}

interface PastPurchasesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  customerName: string
  purchases: PastPurchase[]  // newest first
  canAdd: (p: PastPurchase) => boolean
  onAdd: (p: PastPurchase) => void
}

export function PastPurchasesDialog({ open, onOpenChange, customerName, purchases, canAdd, onAdd }: PastPurchasesDialogProps) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')

  useEffect(() => {
    if (open) { setSearch(''); setCategory('') }
  }, [open])

  const groups = useMemo(() => {
    const map = new Map<string, PastPurchaseGroup>()
    for (const p of purchases) {
      const key = p.productSizeId ? `${p.productId}|${p.size}|${p.color}` : p.productId
      const g = map.get(key)
      if (g) g.timesBought += 1
      else map.set(key, { key, latest: p, timesBought: 1 })
    }
    return [...map.values()]
  }, [purchases])

  const categories = useMemo(
    () => [...new Set(groups.map(g => g.latest.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [groups],
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return groups.filter(g =>
      (!category || g.latest.category === category) &&
      (!q || g.latest.productName.toLowerCase().includes(q)),
    )
  }, [groups, search, category])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('pos.pastPurchases.title')}
            <span className="ml-1.5 font-normal text-gray-400 dark:text-gray-500">— {customerName}</span>
          </DialogTitle>
        </DialogHeader>

        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 py-10 text-center">
            <History className="h-6 w-6 text-gray-300 dark:text-gray-600" />
            <p className="text-sm text-gray-400 dark:text-gray-500">{t('pos.pastPurchases.empty')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('pos.pastPurchases.search')}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-2 pl-9 pr-3 text-sm text-gray-900 dark:text-gray-100 outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-gray-400 dark:focus:border-gray-500"
              />
            </div>

            {categories.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {['', ...categories].map(c => (
                  <button
                    key={c || '__all'}
                    onClick={() => setCategory(c)}
                    className={cn(
                      'rounded-lg px-3 py-1 text-xs transition-colors',
                      category === c
                        ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border border-transparent bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
                    )}
                  >
                    {c || t('pos.pastPurchases.all')}
                  </button>
                ))}
              </div>
            )}

            <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
              {visible.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('pos.pastPurchases.notFound')}</p>
              ) : visible.map((g, i) => {
                const p = g.latest
                const perMl = isPerMl(p.size)
                const variant = [perMl ? null : p.size, p.color].filter(Boolean).join(' · ')
                const addable = canAdd(p)
                return (
                  <div key={g.key} className={cn('flex items-center justify-between gap-3 py-2.5', i > 0 && 'border-t border-gray-100 dark:border-gray-800')}>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-gray-900 dark:text-gray-100">
                        {p.productName}
                        {variant && <span className="text-gray-400 dark:text-gray-500"> · {variant}</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                        {p.date && formatDate(p.date)}
                        {perMl && ` · ${p.quantity} ml`}
                        {g.timesBought > 1 && ` · ${g.timesBought} ${t('pos.pastPurchases.times')}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-right text-sm font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                        {formatPrice(p.price)}
                        {perMl && <span className="font-normal text-gray-400 dark:text-gray-500"> / 1 ml</span>}
                      </span>
                      <button
                        onClick={() => onAdd(p)}
                        disabled={!addable}
                        title={addable ? t('pos.pastPurchases.add') : t('pos.pastPurchases.unavailable')}
                        aria-label={t('pos.pastPurchases.add')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
