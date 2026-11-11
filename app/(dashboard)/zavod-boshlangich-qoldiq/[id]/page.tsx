'use client'

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
import { BackLink, DocStatusBadge, InfoField, TotalsBox, prodCardCls } from '@/components/production/ProdKit'
import { DocOverrides } from '@/components/production/ControlKit'
import { useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useProdSuppliers } from '@/components/production/SupplierKit'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { LotExpiry, formatYmd } from '@/components/production/LotPicker'
import { NotAvailableNote, useInventoryDocs } from '@/components/production/InventoryKit'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import { expiryWarnDaysOf, formatQty, sumByUnitGroup, unitKey } from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { lotTraceHref } from '@/lib/production-reports'
import type { Database } from '@/lib/database.types'

type Doc = Database['public']['Tables']['prod_openings']['Row']
type Line = Database['public']['Tables']['prod_opening_items']['Row']

const linkCls = 'text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors'

export default function OpeningViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { groups } = useQtyFormat()
  const available = useInventoryDocs()
  const { itemById, warehouseById } = useProdRefs()
  const { suppliers } = useProdSuppliers()

  const [doc, setDoc] = useState<Doc | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [lotNos, setLotNos] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [docRes, linesRes] = await Promise.all([
      supabase.from('prod_openings').select('*').eq('id', id).maybeSingle(),
      supabase.from('prod_opening_items').select('*').eq('opening_id', id).order('sort_order'),
    ])
    const ls = linesRes.data ?? []
    const lotIds = ls.map(l => l.lot_id)
    const { data: lots } = lotIds.length
      ? await supabase.from('prod_lots').select('id, lot_no').in('id', lotIds)
      : { data: [] as { id: string; lot_no: string }[] }
    setDoc(docRes.data ?? null)
    setLines(ls)
    setLotNos(new Map((lots ?? []).map(l => [l.id, l.lot_no])))
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('opening_balance', load)

  if (loading || available === null) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-boshlangich-qoldiq" label={t('prodInventory.openings.title')} />
        {available ? <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p> : <NotAvailableNote />}
      </div>
    )
  }

  const supplierName = (sid: string | null) => (sid ? suppliers.find(s => s.id === sid)?.name ?? '—' : '—')
  const totalQty = sumByUnitGroup(lines.map(l => ({ qty: Number(l.qty), unit: itemById.get(l.item_id)?.unit ?? 'pcs' })))
  const whName = warehouseById.get(doc.warehouse_id)?.name ?? '—'

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/zavod-boshlangich-qoldiq" label={t('prodInventory.openings.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodInventory.openings.docTitle')} #{doc.number}</h1>
          <DocStatusBadge status={doc.status} />
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
        <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
        {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodInventory.common.linesTitle')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t('production.lots.lotNo')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.qty')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.lots.unitCost')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.openings.fat')}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t('prodInventory.openings.expiry')}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t('prodInventory.openings.supplier')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const item = itemById.get(l.item_id)
                return (
                  <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                    <td className="px-4 py-2"><Link href={lotTraceHref(l.lot_id)} className={cn(linkCls, 'tabular-nums font-medium')}>{lotNos.get(l.lot_id) ?? '—'}</Link></td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(Number(l.qty))} {item ? t(unitKey(item.unit)) : ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(l.unit_cost))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{l.fat_pct === null ? '—' : formatPct(Number(l.fat_pct))}</td>
                    <td className="px-4 py-2"><LotExpiry date={l.expiry_date} warnDays={expiryWarnDaysOf(item)} /></td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{supplierName(l.supplier_id)}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(l.total))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocOverrides docId={doc.id} reloadKey={doc.status} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {doc.note ? (
          <div className={cn(prodCardCls, 'p-6')}>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.common.note')}</p>
            <p className="mt-1 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{doc.note}</p>
          </div>
        ) : <div className="hidden lg:block" />}
        <TotalsBox rows={[
          { label: t('prodInventory.common.itemsCount'), value: String(lines.length) },
          { label: t('prodInventory.common.totalQty'), value: groups(totalQty) },
          { label: t('production.common.total'), value: formatPrice(Number(doc.total)), strong: true },
        ]} />
      </div>
    </div>
    <PrintSheet
      title={t('prodInventory.openings.printTitle')}
      number={doc.number}
      date={doc.doc_date}
      signatures={[t('prodInventory.print.responsible'), t('prodInventory.print.approved')]}
    >
      <PrintFields rows={[
        { label: t('production.common.warehouse'), value: whName },
        { label: t('production.common.author'), value: doc.created_by_name ?? '—' },
      ]} />
      <PrintTable
        columns={[
          { label: t('production.common.item') }, { label: t('production.lots.lotNo') }, { label: t('production.common.qty'), right: true },
          { label: t('production.common.unit') }, { label: t('production.lots.unitCost'), right: true }, { label: t('prodInventory.openings.expiry') },
          { label: t('production.common.total'), right: true },
        ]}
        rows={lines.map(l => {
          const item = itemById.get(l.item_id)
          return [item?.name ?? '—', lotNos.get(l.lot_id) ?? '', formatQty(Number(l.qty)), item ? t(unitKey(item.unit)) : '', formatPrice(Number(l.unit_cost)), formatYmd(l.expiry_date), formatPrice(Number(l.total))]
        })}
        total={[t('production.common.total'), '', groups(totalQty), '', '', '', formatPrice(Number(doc.total))]}
      />
      {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
    </PrintSheet>
    </>
  )
}
