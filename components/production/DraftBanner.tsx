'use client'

// "Qoralama tiklansinmi? (hh:mm)" bar shown above a "yangi" form when
// useFormDraft found a locally saved draft.

import { FileClock } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { prodCardCls } from '@/components/production/ProdKit'
import type { DraftOffer } from '@/lib/useFormDraft'

const pad = (n: number) => String(n).padStart(2, '0')

function draftTime(at: number): string {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return localYmd(d) === localYmd() ? hm : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}`
}

export function DraftBanner({ offer, onRestore, onDiscard, className }: {
  offer: DraftOffer | null
  onRestore: () => void
  onDiscard: () => void
  className?: string
}) {
  const { t } = useLanguage()
  if (!offer) return null
  return (
    <div className={cn(prodCardCls, 'flex flex-wrap items-center gap-3 px-4 py-3 print:hidden', className)} role="status">
      <FileClock className="h-4 w-4 shrink-0 text-gray-400" />
      <p className="min-w-0 flex-1 text-sm text-gray-700 dark:text-gray-300">
        {t('prodOps.draft.offer')} <span className="tabular-nums text-gray-500 dark:text-gray-400">({draftTime(offer.savedAt)})</span>
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onDiscard}>{t('prodOps.draft.discard')}</Button>
        <Button onClick={onRestore}>{t('prodOps.draft.restore')}</Button>
      </div>
    </div>
  )
}
