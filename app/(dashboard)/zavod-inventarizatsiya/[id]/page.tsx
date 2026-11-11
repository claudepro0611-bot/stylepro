'use client'

// One stock count: a draft opens the editor; a posted / cancelled count is
// read-only (system qty snapshot, differences, lots used / created) with
// cancel (prod_cancel_document('stock_count'), owner/admin) and print.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Ban, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BackLink, InfoField, TotalsBox, prodCardCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { DocLotsSection } from '@/components/production/DocLots'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { CountStatusBadge, NotAvailableNote, useInventoryDocs } from '@/components/production/InventoryKit'
import { StockCountEditor, type CountDraft } from '@/components/production/StockCountEditor'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import { formatQty, round2, unitKey } from '@/lib/production'
import type { Database } from '@/lib/database.types'

type Doc = Database['public']['Tables']['prod_stock_counts']['Row']
type Line = Database['public']['Tables']['prod_stock_count_items']['Row']

const linkCls = 'text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors'

export default function StockCountViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const available = useInventoryDocs()
  const { itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const [doc, setDoc] = useState<Doc | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [docRes, linesRes] = await Promise.all([
      supabase.from('prod_stock_counts').select('*').eq('id', id).maybeSingle(),
      supabase.from('prod_stock_count_items').select('*').eq('count_id', id).order('id'),
    ])
    setDoc(docRes.data ?? null)
    setLines(linesRes.data ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('stock_count', load)

  if (loading || available === null || refsLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-inventarizatsiya" label={t('prodInventory.counts.title')} />
        {available ? <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p> : <NotAvailableNote />}
      </div>
    )
  }

  if (doc.status === 'draft') {
    const draft: CountDraft = {
      id: doc.id,
      number: doc.number,
      docDate: doc.doc_date,
      warehouseId: doc.warehouse_id,
      note: doc.note ?? '',
      lines: lines
        .map(l => ({ itemId: l.item_id, counted: Number(l.counted_qty), unitCost: l.unit_cost === null ? null : Number(l.unit_cost) }))
        .sort((a, b) => (itemById.get(a.itemId)?.name ?? '').localeCompare(itemById.get(b.itemId)?.name ?? '')),
    }
    return <StockCountEditor key={doc.updated_at} draft={draft} />
  }

  const sorted = [...lines].sort((a, b) => (itemById.get(a.item_id)?.name ?? '').localeCompare(itemById.get(b.item_id)?.name ?? ''))
  const whName = warehouseById.get(doc.warehouse_id)?.name ?? '—'
  const shortage = Number(doc.shortage_value)
  const surplus = Number(doc.surplus_value)
  const diffCls = (n: number) => (n < 0 ? 'text-red-600 dark:text-red-400' : n > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500')
  const statusLabel = doc.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted')

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/zavod-inventarizatsiya" label={t('prodInventory.counts.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodInventory.counts.docTitle')} #{doc.number}</h1>
          <CountStatusBadge status={doc.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PrintButton />
          {canCancel && doc.status === 'posted' && (
            <Button variant="outline" onClick={() => cancel(doc.id)} loading={busyId === doc.id}>
              <Ban className="h-3.5 w-3.5" /> {t('production.common.cancelDoc')}
            </Button>
          )}
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4')}>
        <InfoField label={t('production.common.date')}>{formatDateTime(doc.doc_date)}</InfoField>
        <InfoField label={t('production.common.warehouse')}>
          <Link href={`/zavod-omborlar/${doc.warehouse_id}`} className={linkCls}>{whName}</Link>
        </InfoField>
        <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
        <InfoField label={t('prodInventory.counts.postedBy')}>{doc.posted_by_name ?? '—'}</InfoField>
        <InfoField label={t('prodInventory.counts.postedAt')}>{doc.posted_at ? formatDateTime(doc.posted_at) : '—'}</InfoField>
        {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodInventory.common.linesTitle')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.systemQty')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.countedQty')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.diffQty')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.unitCost')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.diffValue')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(l => {
                const item = itemById.get(l.item_id)
                const unit = item ? t(unitKey(item.unit)) : ''
                const diff = Number(l.diff_qty ?? 0)
                const dv = Number(l.diff_value ?? 0)
                return (
                  <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{l.system_qty === null ? '—' : `${formatQty(Number(l.system_qty))} ${unit}`}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{formatQty(Number(l.counted_qty))} {unit}</td>
                    <td className={cn('px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium', diffCls(diff))}>{diff === 0 ? '—' : `${diff > 0 ? '+' : ''}${formatQty(diff)} ${unit}`}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{l.unit_cost === null ? '—' : formatPrice(Number(l.unit_cost))}</td>
                    <td className={cn('px-4 py-2 text-right tabular-nums whitespace-nowrap', diffCls(dv))}>{dv === 0 ? '—' : formatPrice(dv)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocLotsSection docId={doc.id} itemById={itemById} warehouseById={warehouseById} reloadKey={doc.status} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {doc.note ? (
          <div className={cn(prodCardCls, 'p-6')}>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.common.note')}</p>
            <p className="mt-1 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{doc.note}</p>
          </div>
        ) : <div className="hidden lg:block" />}
        <TotalsBox rows={[
          { label: t('prodInventory.common.itemsCount'), value: String(lines.length) },
          { label: t('prodInventory.counts.shortage'), value: formatPrice(shortage), tone: shortage > 0 ? 'negative' : undefined },
          { label: t('prodInventory.counts.surplus'), value: formatPrice(surplus), tone: surplus > 0 ? 'positive' : undefined },
          { label: t('prodInventory.counts.net'), value: formatPrice(round2(surplus - shortage)), strong: true },
        ]} />
      </div>
    </div>
    <PrintSheet
      title={t('prodInventory.counts.printTitle')}
      number={doc.number}
      date={doc.doc_date}
      signatures={[t('prodInventory.print.responsible'), t('prodInventory.print.counter'), t('prodInventory.print.commission')]}
    >
      <PrintFields rows={[
        { label: t('production.common.warehouse'), value: whName },
        { label: t('production.common.status'), value: statusLabel },
        { label: t('prodInventory.counts.postedBy'), value: doc.posted_by_name ?? '—' },
        { label: t('prodInventory.counts.postedAt'), value: doc.posted_at ? formatDateTime(doc.posted_at) : '—' },
      ]} />
      <PrintTable
        columns={[
          { label: t('production.common.item') }, { label: t('production.common.unit') },
          { label: t('prodInventory.counts.systemQty'), right: true }, { label: t('prodInventory.counts.countedQty'), right: true },
          { label: t('prodInventory.counts.diffQty'), right: true }, { label: t('prodInventory.counts.diffValue'), right: true },
        ]}
        rows={sorted.map(l => {
          const item = itemById.get(l.item_id)
          return [
            item?.name ?? '—', item ? t(unitKey(item.unit)) : '', l.system_qty === null ? '' : formatQty(Number(l.system_qty)),
            formatQty(Number(l.counted_qty)), formatQty(Number(l.diff_qty ?? 0)), formatPrice(Number(l.diff_value ?? 0)),
          ]
        })}
        total={[t('production.common.total'), '', '', '', '', formatPrice(round2(surplus - shortage))]}
      />
      {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
    </PrintSheet>
    </>
  )
}
