'use client'

// Sale return view: lines (returned qty, restock, credit), lots it created
// (restocked lots, DocLots), totals, print and cancel.

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
import { useProdRefs } from '@/components/production/useProdRefs'
import { DocLotsSection } from '@/components/production/DocLots'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useSalesAvailable, useSeesMargin } from '@/components/production/SalesKit'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import { formatQty, unitKey } from '@/lib/production'
import {
  RETURN_COLS, RETURN_ITEM_COLS, SALE_ITEM_COLS,
  type ReturnItemRow, type ReturnRow, type SaleItemRow,
} from '@/lib/sales'

const linkCls = 'text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors'

export default function SaleReturnViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const available = useSalesAvailable()
  const seesMargin = useSeesMargin()
  const { itemById, warehouseById } = useProdRefs()

  const [doc, setDoc] = useState<ReturnRow | null>(null)
  const [lines, setLines] = useState<ReturnItemRow[]>([])
  const [saleLines, setSaleLines] = useState<Map<string, SaleItemRow>>(new Map())
  const [sale, setSale] = useState<{ number: number; vat_rate: number } | null>(null)
  const [customer, setCustomer] = useState<{ name: string; legal_name: string | null; inn: string | null } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [docRes, linesRes] = await Promise.all([
      supabase.from('prod_sale_returns').select(RETURN_COLS).eq('id', id).maybeSingle(),
      supabase.from('prod_sale_return_items').select(RETURN_ITEM_COLS).eq('return_id', id).order('sort_order').order('id'),
    ])
    const d = (docRes.data as ReturnRow | null) ?? null
    setDoc(d)
    setLines((linesRes.data ?? []) as ReturnItemRow[])
    if (d) {
      const [sRes, slRes, cRes] = await Promise.all([
        supabase.from('prod_sales').select('number, vat_rate').eq('id', d.sale_id).maybeSingle(),
        supabase.from('prod_sale_items').select(SALE_ITEM_COLS).eq('sale_id', d.sale_id),
        supabase.from('prod_customers').select('name, legal_name, inn').eq('id', d.customer_id).maybeSingle(),
      ])
      setSale(sRes.data ? { number: sRes.data.number, vat_rate: Number(sRes.data.vat_rate) } : null)
      setSaleLines(new Map(((slRes.data ?? []) as SaleItemRow[]).map(l => [l.id, l])))
      setCustomer(cRes.data ?? null)
    }
    setLoading(false)
  }, [id])

  useEffect(() => { if (available) load() }, [available, load])

  const { canCancel, cancel, busyId } = useCancelDoc('sale_return', load)

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-qaytarishlar" label={t('prodSales.returns.title')} />
        <NotAvailableNote />
      </div>
    )
  }
  if (loading || available === null) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-qaytarishlar" label={t('prodSales.returns.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const itemOf = (l: ReturnItemRow) => itemById.get(l.item_id ?? saleLines.get(l.sale_item_id)?.item_id ?? '')
  const vatRate = sale?.vat_rate ?? 0
  const warehouseName = warehouseById.get(doc.warehouse_id)?.name ?? '—'

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/zavod-qaytarishlar" label={t('prodSales.returns.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.returns.docTitle')} #{doc.number}</h1>
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
        <InfoField label={t('prodSales.common.customer')}>
          <Link href={`/zavod-mijozlar/${doc.customer_id}`} className={linkCls}>{customer?.name ?? '—'}</Link>
        </InfoField>
        <InfoField label={t('prodSales.returns.sale')}>
          <Link href={`/zavod-sotuv/${doc.sale_id}`} className={linkCls}>{sale ? `#${sale.number}` : '—'}</Link>
        </InfoField>
        <InfoField label={t('production.common.date')}>{formatDateTime(doc.doc_date)}</InfoField>
        <InfoField label={t('prodSales.returns.warehouse')}>
          <Link href={`/zavod-omborlar/${doc.warehouse_id}`} className={linkCls}>{warehouseName}</Link>
        </InfoField>
        <InfoField label={t('prodInventory.common.reason')}>{doc.reason || '—'}</InfoField>
        <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
        <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
        {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.sales.lines')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.returns.returnQty')}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t('prodSales.returns.restock')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.amount')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.vat')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.returns.credit')}</th>
                {seesMargin && <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.cost')}</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const item = itemOf(l)
                return (
                  <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(Number(l.qty))} {t(unitKey(saleLines.get(l.sale_item_id)?.unit || item?.unit || 'pcs'))}</td>
                    <td className="px-4 py-2">
                      <span className={cn(
                        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                        l.restock ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
                      )}>
                        {l.restock ? t('prodSales.returns.restockYes') : t('prodSales.returns.restockNo')}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300">{formatPrice(Number(l.amount))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(l.vat_amount ?? 0))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(l.total ?? l.amount))}</td>
                    {seesMargin && <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(l.cost ?? 0))}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocOverrides docId={doc.id} reloadKey={doc.status} />
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
          { label: t('prodSales.common.subtotal'), value: formatPrice(Number(doc.subtotal)) },
          { label: `${t('prodSales.common.vat')} ${vatRate}%`, value: formatPrice(Number(doc.vat_amount)) },
          ...(seesMargin ? [
            { label: t('prodSales.common.cost'), value: formatPrice(Number(doc.cost_total)) },
            { label: t('prodSales.returns.lossCost'), value: formatPrice(Number(doc.loss_cost ?? 0)), tone: Number(doc.loss_cost ?? 0) > 0 ? 'negative' as const : undefined },
          ] : []),
          { label: t('prodSales.returns.credit'), value: formatPrice(Number(doc.total)), strong: true },
        ]} />
      </div>
    </div>
    <PrintSheet
      title={t('prodSales.print.returnTitle')}
      number={doc.number}
      date={doc.doc_date}
      signatures={[t('prodSales.print.handedBack'), t('prodReports.print.acceptedBy'), t('prodReports.print.storekeeper')]}
    >
      <PrintFields rows={[
        { label: t('prodSales.print.buyer'), value: customer ? (customer.legal_name || customer.name) : '—' },
        { label: t('prodSales.common.inn'), value: customer?.inn || '—' },
        { label: t('prodSales.returns.sale'), value: sale ? `№ ${sale.number}` : '—' },
        { label: t('prodSales.returns.warehouse'), value: warehouseName },
        { label: t('prodInventory.common.reason'), value: doc.reason || '—' },
        { label: t('production.common.status'), value: doc.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted') },
      ]} />
      <PrintTable
        columns={[
          { label: t('production.common.item') }, { label: t('production.common.qty'), right: true }, { label: t('production.common.unit') },
          { label: t('prodSales.returns.restock') }, { label: t('prodSales.common.amount'), right: true }, { label: t('prodSales.common.vat'), right: true },
          { label: t('prodSales.returns.credit'), right: true },
        ]}
        rows={lines.map(l => {
          const item = itemOf(l)
          return [
            item?.name ?? '—', formatQty(Number(l.qty)), t(unitKey(saleLines.get(l.sale_item_id)?.unit || item?.unit || 'pcs')),
            l.restock ? t('prodSales.returns.restockYes') : t('prodSales.returns.restockNo'),
            formatPrice(Number(l.amount)), formatPrice(Number(l.vat_amount ?? 0)), formatPrice(Number(l.total ?? l.amount)),
          ]
        })}
        total={[t('production.common.total'), '', '', '', formatPrice(Number(doc.subtotal)), formatPrice(Number(doc.vat_amount)), formatPrice(Number(doc.total))]}
      />
      {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
    </PrintSheet>
    </>
  )
}
