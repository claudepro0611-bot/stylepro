'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Ban, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BackLink, DocStatusBadge, InfoField, TotalsBox, prodCardCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { DocLotsSection } from '@/components/production/DocLots'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { formatQty, unitKey } from '@/lib/production'
import type { Database } from '@/lib/database.types'

type Doc = Database['public']['Tables']['prod_processings']['Row']
type Line = Database['public']['Tables']['prod_processing_outputs']['Row']

export default function ProcessingViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, warehouseById } = useProdRefs()

  const [doc, setDoc] = useState<Doc | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [docRes, linesRes] = await Promise.all([
      supabase.from('prod_processings').select('*').eq('id', id).maybeSingle(),
      supabase.from('prod_processing_outputs').select('*').eq('processing_id', id).order('id'),
    ])
    setDoc(docRes.data ?? null)
    setLines(linesRes.data ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('processing', load)

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/qayta-ishlash" label={t('production.processings.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const source = itemById.get(doc.source_item_id)
  const profit = Number(doc.profit)

  return (
    <div className="space-y-5">
      <BackLink href="/qayta-ishlash" label={t('production.processings.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.processings.docTitle')} #{doc.number}</h1>
          <DocStatusBadge status={doc.status} />
        </div>
        {canCancel && doc.status === 'posted' && (
          <Button variant="outline" onClick={() => cancel(doc.id)} loading={busyId === doc.id}>
            <Ban className="h-3.5 w-3.5" /> {t('production.common.cancelDoc')}
          </Button>
        )}
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4')}>
        <InfoField label={t('production.common.date')}>{formatDateTime(doc.doc_date)}</InfoField>
        <InfoField label={t('production.common.warehouse')}>{warehouseById.get(doc.warehouse_id)?.name ?? '—'}</InfoField>
        <InfoField label={t('production.processings.outputWarehouse')}>{warehouseById.get(doc.output_warehouse_id ?? doc.warehouse_id)?.name ?? '—'}</InfoField>
        <InfoField label={t('production.processings.sourceItem')}>{source?.name ?? '—'}</InfoField>
        <InfoField label={t('production.common.qty')}>{formatQty(Number(doc.source_qty))} {source ? t(unitKey(source.unit)) : ''}</InfoField>
        <InfoField label={t('production.processings.unitPrice')}>{formatPrice(Number(doc.source_unit_cost))}</InfoField>
        <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
        <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
        {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.processings.outputs')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.qty')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.price')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const item = itemById.get(l.item_id)
                return (
                  <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(Number(l.qty))} {item ? t(unitKey(item.unit)) : ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(l.price))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(l.total))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocLotsSection docId={doc.id} itemById={itemById} warehouseById={warehouseById} reloadKey={doc.status} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className={cn(prodCardCls, 'p-6')}>
          <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.common.note')}</p>
          <p className="mt-1 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{doc.note || '—'}</p>
        </div>
        <TotalsBox rows={[
          { label: t('production.processings.processingCost'), value: formatPrice(Number(doc.processing_cost)) },
          { label: t('production.processings.recoveryCost'), value: formatPrice(Number(doc.recovery_cost)) },
          { label: t('production.processings.profit'), value: formatPrice(profit), tone: profit < 0 ? 'negative' : profit > 0 ? 'positive' : undefined, strong: true },
        ]} />
      </div>
    </div>
  )
}
