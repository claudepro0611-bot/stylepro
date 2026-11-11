'use client'

// "Partiyalar" section of a document view page: lots the document consumed
// (its outflow movements joined to prod_lots) and lots it created
// (prod_lots.source_doc_id). Renders nothing while the lots migration is not
// applied, when the read fails, or when the document touched no lots
// (legacy documents).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { prodCardCls } from '@/components/production/ProdKit'
import { LotExpiry, LotNo } from '@/components/production/LotPicker'
import { expiryWarnDaysOf, fetchDocLots, formatQty, round2, unitKey, type DocLots, type ProdItem, type ProdWarehouse } from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { lotTraceHref } from '@/lib/production-reports'

const th = 'px-4 py-2.5 text-left font-medium whitespace-nowrap'
const thR = 'px-4 py-2.5 text-right font-medium whitespace-nowrap'
const td = 'px-4 py-2'
const tdR = 'px-4 py-2 text-right tabular-nums whitespace-nowrap'

export function DocLotsSection({ docId, itemById, warehouseById, reloadKey }: {
  docId: string
  itemById: Map<string, ProdItem>
  warehouseById: Map<string, ProdWarehouse>
  /** Changing it reloads (e.g. the document status after a cancel). */
  reloadKey?: string
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [data, setData] = useState<DocLots | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDocLots(createClient(), docId).then(d => { if (!cancelled) setData(d) })
    return () => { cancelled = true }
  }, [docId, reloadKey])

  if (!data || (data.consumed.length === 0 && data.produced.length === 0)) return null

  const today = localYmd()
  const unitOf = (itemId: string) => {
    const item = itemById.get(itemId)
    return item ? t(unitKey(item.unit)) : ''
  }
  const consumedTotal = round2(data.consumed.reduce((s, l) => s + l.total, 0))
  const showFat = data.produced.some(l => l.fatPct !== null)
  const showProducedWarehouse = new Set(data.produced.map(l => l.warehouseId)).size > 1

  return (
    <div className={cn(prodCardCls, 'overflow-hidden')}>
      <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.lots.title')}</h2>

      {data.consumed.length > 0 && (
        <div className="overflow-x-auto">
          <p className="px-4 pt-3 pb-1 text-[12px] font-medium text-gray-500 dark:text-gray-400">{t('production.lots.consumedTitle')}</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={th}>{t('production.common.item')}</th>
                <th className={th}>{t('production.lots.lotNo')}</th>
                <th className={th}>{t('production.lots.supplier')}</th>
                <th className={thR}>{t('production.common.qty')}</th>
                <th className={thR}>{t('production.lots.unitCost')}</th>
                <th className={thR}>{t('production.common.total')}</th>
              </tr>
            </thead>
            <tbody>
              {data.consumed.map((l, i) => (
                <tr key={`${l.lotId}:${i}`} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                  <td className={cn(td, 'text-gray-900 dark:text-gray-100')}>{itemById.get(l.itemId)?.name ?? '—'}</td>
                  <td className={td}><Link href={lotTraceHref(l.lotId)} className="font-medium tabular-nums text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">{l.lotNo || '—'}</Link></td>
                  <td className={cn(td, 'text-gray-700 dark:text-gray-300')}>{l.supplierName || '—'}</td>
                  <td className={tdR}>{formatQty(l.qty)} {unitOf(l.itemId)}</td>
                  <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{formatPrice(l.unitCost)}</td>
                  <td className={cn(tdR, 'font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(l.total)}</td>
                </tr>
              ))}
              {data.consumed.length > 1 && (
                <tr className="border-t border-gray-100 dark:border-gray-800">
                  <td className={cn(td, 'text-gray-500 dark:text-gray-400')} colSpan={5}>{t('production.common.total')}</td>
                  <td className={cn(tdR, 'font-semibold text-gray-900 dark:text-gray-100')}>{formatPrice(consumedTotal)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data.produced.length > 0 && (
        <div className={cn('overflow-x-auto', data.consumed.length > 0 && 'border-t border-gray-100 dark:border-gray-800')}>
          <p className="px-4 pt-3 pb-1 text-[12px] font-medium text-gray-500 dark:text-gray-400">{t('production.lots.producedTitle')}</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={th}>{t('production.common.item')}</th>
                <th className={th}>{t('production.lots.lotNo')}</th>
                {showProducedWarehouse && <th className={th}>{t('production.common.warehouse')}</th>}
                <th className={th}>{t('production.lots.supplier')}</th>
                <th className={thR}>{t('production.common.qty')}</th>
                <th className={thR}>{t('production.lots.remaining')}</th>
                <th className={thR}>{t('production.lots.unitCost')}</th>
                {showFat && <th className={thR}>{t('production.lots.fat')}</th>}
                <th className={th}>{t('production.lots.expiry')}</th>
              </tr>
            </thead>
            <tbody>
              {data.produced.map(l => (
                <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                  <td className={cn(td, 'text-gray-900 dark:text-gray-100')}>{itemById.get(l.itemId)?.name ?? '—'}</td>
                  <td className={td}><Link href={lotTraceHref(l.id)} className="hover:opacity-70 transition-opacity"><LotNo lot={l} /></Link></td>
                  {showProducedWarehouse && <td className={cn(td, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(l.warehouseId)?.name ?? '—'}</td>}
                  <td className={cn(td, 'text-gray-700 dark:text-gray-300')}>{l.supplierName || '—'}</td>
                  <td className={tdR}>{formatQty(l.receivedQty)} {unitOf(l.itemId)}</td>
                  <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{formatQty(l.remainingQty)} {unitOf(l.itemId)}</td>
                  <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{formatPrice(l.unitCost)}</td>
                  {showFat && <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{l.fatPct === null ? '—' : formatPct(l.fatPct)}</td>}
                  <td className={td}><LotExpiry date={l.expiryDate} today={today} warnDays={expiryWarnDaysOf(itemById.get(l.itemId))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
