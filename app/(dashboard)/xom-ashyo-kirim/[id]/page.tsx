'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Ban, Loader2, Milk, Tags } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BackLink, DocStatusBadge, InfoField, TotalsBox, prodCardCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { DocOverrides } from '@/components/production/ControlKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { DocLotsSection } from '@/components/production/DocLots'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { formatQty, unitKey } from '@/lib/production'
import { PriceCorrectionDialog, PriceCorrectionsSection, type CorrectableLine } from '@/components/production/InventoryKit'
import { formatYmd } from '@/components/production/LotPicker'
import { effectiveLinePrice, fetchReceiptCorrections, type PriceCorrection } from '@/lib/inventory'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import type { Database } from '@/lib/database.types'

type Doc = Database['public']['Tables']['prod_receipts']['Row']
type Line = Database['public']['Tables']['prod_receipt_items']['Row']

export default function ReceiptViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, warehouseById } = useProdRefs()

  const [doc, setDoc] = useState<Doc | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [loading, setLoading] = useState(true)
  const [liveSupplierName, setLiveSupplierName] = useState<string | null>(null)
  // Posted by Sut qabuli: cancelled only through the intake.
  const [intake, setIntake] = useState<{ id: string; number: number } | null>(null)
  // Price corrections (migration 20261110000014); null = not available.
  const [corrections, setCorrections] = useState<PriceCorrection[] | null>(null)
  const [correcting, setCorrecting] = useState<CorrectableLine | null>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [docRes, linesRes, intakeRes, corrRes] = await Promise.all([
      supabase.from('prod_receipts').select('*').eq('id', id).maybeSingle(),
      supabase.from('prod_receipt_items').select('*').eq('receipt_id', id).order('id'),
      supabase.from('prod_milk_intakes').select('id, number').eq('receipt_id', id).neq('status', 'cancelled').limit(1).maybeSingle(),
      fetchReceiptCorrections(supabase, id),
    ])
    setDoc(docRes.data ?? null)
    setCorrections(corrRes)
    setIntake(intakeRes.data ?? null)
    // Prefer the live supplier name (renames do not rewrite the snapshot).
    const sid = docRes.data?.supplier_id
    if (sid) {
      const { data: sup } = await supabase.from('prod_suppliers').select('name').eq('id', sid).maybeSingle()
      setLiveSupplierName(sup?.name ?? null)
    } else {
      setLiveSupplierName(null)
    }
    setLines(linesRes.data ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('receipt', load)

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/xom-ashyo-kirim" label={t('production.receipts.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const hasPostedCorrection = (corrections ?? []).some(c => c.status === 'posted')
  const canCorrect = corrections !== null && doc.status === 'posted'
  const corrected = (corrections ?? []).length > 0
  const dueDate = (doc as { due_date?: string | null }).due_date ?? null

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/xom-ashyo-kirim" label={t('production.receipts.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.receipts.docTitle')} #{doc.number}</h1>
          <DocStatusBadge status={doc.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <PrintButton />
        {intake && (
          <Link href={`/sut-qabuli/${intake.id}`} title={t('production.milk.receiptFromIntake')} className={secondaryBtnCls}>
            <Milk className="h-3.5 w-3.5" /> {t('production.milk.docTitle')} #{intake.number}
          </Link>
        )}
        {canCancel && doc.status === 'posted' && !intake && !hasPostedCorrection && (
          <Button variant="outline" onClick={() => cancel(doc.id)} loading={busyId === doc.id}>
            <Ban className="h-3.5 w-3.5" /> {t('production.common.cancelDoc')}
          </Button>
        )}
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4')}>
        <InfoField label={t('production.common.date')}>{formatDateTime(doc.doc_date)}</InfoField>
        <InfoField label={t('production.common.warehouse')}>{warehouseById.get(doc.warehouse_id)?.name ?? '—'}</InfoField>
        <InfoField label={t('production.suppliers.supplier')}>
          {doc.supplier_id ? (
            <Link href={`/zavod-yetkazuvchilar/${doc.supplier_id}`} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
              {liveSupplierName || doc.supplier_name || '—'}
            </Link>
          ) : (doc.supplier_name || '—')}
        </InfoField>
        <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
        <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
        {dueDate && <InfoField label={t('prodInventory.ageing.dueDate')}>{formatYmd(dueDate)}</InfoField>}
        {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
      </div>
      {hasPostedCorrection && canCancel && !intake && (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodInventory.corrections.hasCorrections')}</p>
      )}

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.receipts.items')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.qty')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.price')}</th>
                {corrected && <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.corrections.effectivePrice')}</th>}
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
                {canCorrect && <th className="px-4 py-2.5 w-10" />}
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
                    {corrected && <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(effectiveLinePrice(l.id, Number(l.price), corrections ?? []))}</td>}
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(l.total))}</td>
                    {canCorrect && (
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => setCorrecting({ id: l.id, itemId: l.item_id, qty: Number(l.qty), price: Number(l.price) })}
                          title={t('prodInventory.corrections.button')}
                          aria-label={t('prodInventory.corrections.button')}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                        >
                          <Tags className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {corrections && <PriceCorrectionsSection corrections={corrections} itemById={itemById} onChanged={load} />}

      <DocOverrides docId={doc.id} reloadKey={doc.status} />
      <DocLotsSection docId={doc.id} itemById={itemById} warehouseById={warehouseById} reloadKey={`${doc.status}:${corrections?.length ?? 0}`} />

      <PriceCorrectionDialog
        open={correcting !== null}
        onOpenChange={o => { if (!o) setCorrecting(null) }}
        receipt={{ id: doc.id, warehouseId: doc.warehouse_id }}
        line={correcting}
        corrections={corrections ?? []}
        item={correcting ? itemById.get(correcting.itemId) : undefined}
        onSaved={() => { setCorrecting(null); load() }}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {doc.note ? (
          <div className={cn(prodCardCls, 'p-6')}>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.common.note')}</p>
            <p className="mt-1 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{doc.note}</p>
          </div>
        ) : <div className="hidden lg:block" />}
        <TotalsBox rows={[{ label: t('production.common.total'), value: formatPrice(Number(doc.total)), strong: true }]} />
      </div>
    </div>
    <PrintSheet
      title={t('prodReports.print.receiptTitle')}
      number={doc.number}
      date={doc.doc_date}
      signatures={[t('prodReports.print.handedOver'), t('prodReports.print.acceptedBy')]}
    >
      <PrintFields rows={[
        { label: t('production.suppliers.supplier'), value: liveSupplierName || doc.supplier_name || '—' },
        { label: t('production.common.warehouse'), value: warehouseById.get(doc.warehouse_id)?.name ?? '—' },
        { label: t('production.common.author'), value: doc.created_by_name ?? '—' },
        { label: t('production.common.status'), value: doc.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted') },
      ]} />
      <PrintTable
        columns={[
          { label: t('production.common.item') }, { label: t('production.common.qty'), right: true }, { label: t('production.common.unit') },
          { label: t('production.common.price'), right: true }, { label: t('production.common.total'), right: true },
        ]}
        rows={lines.map(l => {
          const item = itemById.get(l.item_id)
          return [item?.name ?? '—', formatQty(Number(l.qty)), item ? t(unitKey(item.unit)) : '', formatPrice(Number(l.price)), formatPrice(Number(l.total))]
        })}
        total={[t('production.common.total'), '', '', '', formatPrice(Number(doc.total))]}
      />
      {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
    </PrintSheet>
    </>
  )
}
