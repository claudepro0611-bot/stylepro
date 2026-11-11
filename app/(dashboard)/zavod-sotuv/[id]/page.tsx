'use client'

// Sale (nakladnoy) view: lines, lots used, totals with VAT, margin
// (owner/admin), returns made against it, print (nakladnoy and an
// invoice-style form with VAT columns), cancel and "Qaytarish".

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Ban, FileText, Loader2, Printer, Undo2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BackLink, DocStatusBadge, InfoField, MoreFields, TotalsBox, prodCardCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { DocLotsSection } from '@/components/production/DocLots'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useSalesAvailable, useSeesMargin } from '@/components/production/SalesKit'
import { PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import { PROD_UNITS, formatQty, round3, sumByUnitGroup, unitKey, type ProdUnit } from '@/lib/production'
import {
  RETURN_COLS, SALE_COLS, SALE_ITEM_COLS, formatMarginPct, marginPct,
  type ReturnRow, type SaleItemRow, type SaleRow,
} from '@/lib/sales'

interface CustomerInfo { id: string; name: string; legal_name: string | null; inn: string | null; phone: string | null; address: string | null }

const toProdUnit = (u: string | null | undefined): ProdUnit => ((PROD_UNITS as readonly string[]).includes(u ?? '') ? u as ProdUnit : 'pcs')

const linkCls = 'text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors'

export default function SaleViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { groups } = useQtyFormat()
  const available = useSalesAvailable()
  const seesMargin = useSeesMargin()
  const { itemById, warehouseById } = useProdRefs()

  const [doc, setDoc] = useState<SaleRow | null>(null)
  const [lines, setLines] = useState<SaleItemRow[]>([])
  const [customer, setCustomer] = useState<CustomerInfo | null>(null)
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [returnedQty, setReturnedQty] = useState(0)
  const [loading, setLoading] = useState(true)
  const [printMode, setPrintMode] = useState<'waybill' | 'invoice'>('waybill')

  const load = useCallback(async () => {
    const supabase = createClient()
    const [docRes, linesRes, retRes] = await Promise.all([
      supabase.from('prod_sales').select(SALE_COLS).eq('id', id).maybeSingle(),
      supabase.from('prod_sale_items').select(SALE_ITEM_COLS).eq('sale_id', id).order('sort_order').order('id'),
      supabase.from('prod_sale_returns').select(RETURN_COLS).eq('sale_id', id).order('number'),
    ])
    const d = (docRes.data as SaleRow | null) ?? null
    setDoc(d)
    setLines((linesRes.data ?? []) as SaleItemRow[])
    const rets = (retRes.data ?? []) as ReturnRow[]
    setReturns(rets)
    const postedIds = rets.filter(r => r.status === 'posted').map(r => r.id)
    if (postedIds.length) {
      const { data } = await supabase.from('prod_sale_return_items').select('qty').in('return_id', postedIds)
      setReturnedQty(round3((data ?? []).reduce((s, r) => s + Number(r.qty), 0)))
    } else setReturnedQty(0)
    if (d) {
      const { data: c } = await supabase.from('prod_customers').select('id, name, legal_name, inn, phone, address').eq('id', d.customer_id).maybeSingle()
      setCustomer((c as CustomerInfo | null) ?? null)
    }
    setLoading(false)
  }, [id])

  useEffect(() => { if (available) load() }, [available, load])

  const { canCancel, cancel, busyId } = useCancelDoc('sale', load)

  function print(mode: 'waybill' | 'invoice') {
    setPrintMode(mode)
    window.setTimeout(() => window.print(), 50)
  }

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-sotuv" label={t('prodSales.sales.title')} />
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
        <BackLink href="/zavod-sotuv" label={t('prodSales.sales.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const soldQty = round3(lines.reduce((s, l) => s + Number(l.qty), 0))
  const fullyReturned = soldQty > 0 && returnedQty >= soldQty
  const totalQty = sumByUnitGroup(lines.map(l => ({ qty: Number(l.qty), unit: toProdUnit(l.unit || itemById.get(l.item_id)?.unit) })))
  const vatRate = Number(doc.vat_rate)
  const overdue = doc.status === 'posted' && !!doc.due_date && doc.due_date < localYmd()
  const warehouseName = warehouseById.get(doc.warehouse_id)?.name ?? '—'
  const buyer = customer ? (customer.legal_name || customer.name) : '—'

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/zavod-sotuv" label={t('prodSales.sales.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.sales.docTitle')} #{doc.number}</h1>
          <DocStatusBadge status={doc.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => print('waybill')} className={secondaryBtnCls}>
            <Printer className="h-3.5 w-3.5" /> {t('prodSales.sales.printWaybill')}
          </button>
          <button type="button" onClick={() => print('invoice')} className={secondaryBtnCls}>
            <FileText className="h-3.5 w-3.5" /> {t('prodSales.sales.printInvoice')}
          </button>
          {doc.status === 'posted' && !fullyReturned && (
            <Button variant="outline" onClick={() => router.push(`/zavod-sotuv/${doc.id}/qaytarish`)}>
              <Undo2 className="h-3.5 w-3.5" /> {t('prodSales.sales.returnBtn')}
            </Button>
          )}
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
          {customer?.inn && <p className="text-[12px] font-normal tabular-nums text-gray-500 dark:text-gray-400">{t('prodSales.common.inn')} {customer.inn}</p>}
        </InfoField>
        <InfoField label={t('production.common.date')}>{formatDateTime(doc.doc_date)}</InfoField>
        <InfoField label={t('production.common.warehouse')}>
          <Link href={`/zavod-omborlar/${doc.warehouse_id}`} className={linkCls}>{warehouseName}</Link>
        </InfoField>
        <InfoField label={t('prodInventory.ageing.dueDate')}>
          <span className={cn(overdue && 'text-red-600 dark:text-red-400')}>{doc.due_date ? formatDate(doc.due_date) : '—'}</span>
        </InfoField>
        {/* Secondary facts folded under "Tafsilotlar" (open for cancelled documents). */}
        <MoreFields className="col-span-2 lg:col-span-4" label={t('prodUx.details')} active={!!doc.cancelled_at}>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <InfoField label={t('prodSales.common.vehicle')}>{doc.vehicle_no || '—'}</InfoField>
            <InfoField label={t('prodSales.common.driver')}>{doc.driver || '—'}</InfoField>
            <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
            <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
            {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
          </div>
        </MoreFields>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.sales.lines')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.qty')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.priceNoVat')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.discount')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.amount')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.vat')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.totalWithVat')}</th>
                {seesMargin && <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.cost')}</th>}
                {seesMargin && <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.margin')}</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const item = itemById.get(l.item_id)
                const margin = Number(l.amount) - Number(l.cost)
                return (
                  <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(Number(l.qty))} {t(unitKey(l.unit || item?.unit || 'pcs'))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300">{formatPrice(Number(l.price))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{Number(l.discount_pct) ? `${Number(l.discount_pct)}%` : '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{formatPrice(Number(l.amount))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(l.vat_amount))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(l.total))}</td>
                    {seesMargin && <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(l.cost))}</td>}
                    {seesMargin && (
                      <td className={cn('px-4 py-2 text-right tabular-nums whitespace-nowrap', margin < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300')}>
                        {formatPrice(margin)}
                        <span className="ml-1 text-[11px] text-gray-400 dark:text-gray-500">{formatMarginPct(marginPct(margin, Number(l.amount)))}</span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocLotsSection docId={doc.id} itemById={itemById} warehouseById={warehouseById} reloadKey={doc.status} />

      {returns.length > 0 && (
        <div className={cn(prodCardCls, 'overflow-hidden')}>
          <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.returns.title')}</h2>
          <table className="w-full text-sm">
            <tbody>
              {returns.map(r => (
                <tr key={r.id} className={cn('border-b border-gray-50 dark:border-gray-800/60 last:border-0', r.status === 'cancelled' && 'opacity-60')}>
                  <td className="px-4 py-2"><Link href={`/zavod-qaytarishlar/${r.id}`} className={cn(linkCls, 'font-medium')}>#{r.number}</Link></td>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDateTime(r.doc_date)}</td>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{r.reason || ''}</td>
                  <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(r.total))}</td>
                  <td className="px-4 py-2 text-right"><DocStatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
          { label: t('prodSales.common.subtotal'), value: formatPrice(Number(doc.subtotal)) },
          { label: `${t('prodSales.common.vat')} ${vatRate}%`, value: formatPrice(Number(doc.vat_amount)) },
          ...(seesMargin ? [
            { label: t('prodSales.common.cost'), value: formatPrice(Number(doc.cost_total)) },
            {
              label: `${t('prodSales.common.margin')} (${formatMarginPct(marginPct(Number(doc.margin), Number(doc.subtotal)))})`,
              value: formatPrice(Number(doc.margin)),
              tone: Number(doc.margin) < 0 ? 'negative' as const : undefined,
            },
          ] : []),
          { label: t('prodSales.common.totalWithVat'), value: formatPrice(Number(doc.total)), strong: true },
        ]} />
      </div>
    </div>

    {printMode === 'waybill' ? (
      <PrintSheet
        title={t('prodSales.print.waybillTitle')}
        number={doc.number}
        date={doc.doc_date}
        signatures={[t('prodSales.print.released'), t('prodSales.print.received'), t('prodReports.print.driver'), t('prodReports.print.storekeeper')]}
      >
        <PrintFields rows={[
          { label: t('prodSales.print.buyer'), value: buyer },
          { label: t('production.common.warehouse'), value: warehouseName },
          { label: t('prodSales.common.inn'), value: customer?.inn || '—' },
          { label: t('prodSales.common.vehicle'), value: doc.vehicle_no || '—' },
          { label: t('prodSales.common.driver'), value: doc.driver || '—' },
          { label: t('production.suppliers.address'), value: customer?.address || '—' },
          { label: t('prodInventory.ageing.dueDate'), value: doc.due_date ? formatDate(doc.due_date) : '—' },
        ]} />
        <PrintTable
          columns={[
            { label: t('production.common.item') }, { label: t('production.common.qty'), right: true }, { label: t('production.common.unit') },
            { label: t('production.common.price'), right: true }, { label: t('prodSales.common.discount'), right: true }, { label: t('prodSales.common.totalWithVat'), right: true },
          ]}
          rows={lines.map(l => {
            const item = itemById.get(l.item_id)
            return [item?.name ?? '—', formatQty(Number(l.qty)), t(unitKey(l.unit || item?.unit || 'pcs')), formatPrice(Number(l.price)), Number(l.discount_pct) ? `${Number(l.discount_pct)}%` : '', formatPrice(Number(l.total))]
          })}
          total={[t('production.common.total'), groups(totalQty), '', '', '', formatPrice(Number(doc.total))]}
        />
        <p>{t('prodSales.common.vat')} {vatRate}%: {formatPrice(Number(doc.vat_amount))}</p>
        {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
      </PrintSheet>
    ) : (
      <PrintSheet
        title={t('prodSales.print.invoiceTitle')}
        number={doc.number}
        date={doc.doc_date}
        signatures={[t('prodSales.print.director'), t('prodSales.print.accountant'), t('prodSales.print.received')]}
      >
        <PrintFields rows={[
          { label: t('prodSales.print.buyer'), value: buyer },
          { label: t('prodSales.common.inn'), value: customer?.inn || '—' },
          { label: t('production.suppliers.address'), value: customer?.address || '—' },
          { label: t('production.suppliers.phone'), value: customer?.phone || '—' },
          { label: t('prodSales.print.waybillRef'), value: `№ ${doc.number} · ${formatDate(doc.doc_date)}` },
          { label: t('prodInventory.ageing.dueDate'), value: doc.due_date ? formatDate(doc.due_date) : '—' },
        ]} />
        <PrintTable
          columns={[
            { label: t('production.common.item') }, { label: t('production.common.unit') }, { label: t('production.common.qty'), right: true },
            { label: t('prodSales.common.priceNoVat'), right: true }, { label: t('prodSales.print.sumNoVat'), right: true },
            { label: t('prodSales.common.vatRate'), right: true }, { label: t('prodSales.common.vat'), right: true }, { label: t('prodSales.common.totalWithVat'), right: true },
          ]}
          rows={lines.map(l => {
            const item = itemById.get(l.item_id)
            const unitPrice = Number(l.qty) > 0 ? Number(l.amount) / Number(l.qty) : Number(l.price)
            return [
              item?.name ?? '—', t(unitKey(l.unit || item?.unit || 'pcs')), formatQty(Number(l.qty)), formatPrice(unitPrice), formatPrice(Number(l.amount)),
              `${vatRate}%`, formatPrice(Number(l.vat_amount)), formatPrice(Number(l.total)),
            ]
          })}
          total={[t('production.common.total'), '', '', '', formatPrice(Number(doc.subtotal)), '', formatPrice(Number(doc.vat_amount)), formatPrice(Number(doc.total))]}
        />
        {vatRate === 0 && <p>{t('prodSales.print.noVat')}</p>}
      </PrintSheet>
    )}
    </>
  )
}
