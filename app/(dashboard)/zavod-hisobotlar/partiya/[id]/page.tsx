'use client'

// Partiya kuzatuvi: one lot upstream (source document, supplier, milk intake,
// origin_lot chain, lots its source document consumed) and downstream (every
// movement of the lot -> the documents that consumed it -> the lots those
// documents produced, a few levels deep). Read-only.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowDownRight, ArrowUpLeft, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { BackLink, InfoField, prodCardCls } from '@/components/production/ProdKit'
import { LotExpiry, LotNo } from '@/components/production/LotPicker'
import { useProdRefs } from '@/components/production/useProdRefs'
import { expiryWarnDaysOf, formatQty, toLotHoldStatus, unitKey, type LotHoldStatus, type ProdItem, type ProdLot, type ProdWarehouse } from '@/lib/production'
import { LotHoldControl } from '@/components/production/InventoryKit'
import { formatPct } from '@/lib/milk'
import { docHref, docTypeKey, fetchLotTrace, lotTraceHref, type LotTrace, type TraceNode } from '@/lib/production-reports'

const linkCls = 'text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors'
const th = 'px-4 py-2.5 text-left font-medium whitespace-nowrap'
const thR = 'px-4 py-2.5 text-right font-medium whitespace-nowrap'
const td = 'px-4 py-2'
const tdR = 'px-4 py-2 text-right tabular-nums whitespace-nowrap'

function DocLabel({ docType, docId, numbers }: { docType: string | null; docId: string | null; numbers: Map<string, number> }) {
  const { t } = useLanguage()
  if (!docType) return <span className="text-gray-400 dark:text-gray-500">—</span>
  const n = docId ? numbers.get(`${docType}:${docId}`) : undefined
  const text = `${t(docTypeKey(docType))}${n !== undefined ? ` #${n}` : ''}`
  const href = docHref(docType, docId)
  return href ? <Link href={href} className={linkCls}>{text}</Link> : <span className="text-gray-700 dark:text-gray-300">{text}</span>
}

function LotLine({ lot, item, warehouse }: { lot: ProdLot; item: ProdItem | undefined; warehouse: ProdWarehouse | undefined }) {
  const { t } = useLanguage()
  const unit = item ? t(unitKey(item.unit)) : ''
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]">
      <Link href={lotTraceHref(lot.id)} className="hover:opacity-70 transition-opacity"><LotNo lot={lot} /></Link>
      <span className="text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</span>
      <span className="text-gray-500 dark:text-gray-400">{warehouse?.name ?? '—'}</span>
      <span className="tabular-nums text-gray-500 dark:text-gray-400">{t('production.lots.remaining')}: {formatQty(lot.remainingQty)} {unit}</span>
      {lot.fatPct !== null && <span className="tabular-nums text-gray-500 dark:text-gray-400">{t('production.lots.fat')} {formatPct(lot.fatPct)}</span>}
    </div>
  )
}

/** Recall line of a sale that consumed the lot: the customer who received it. */
function SaleCustomerLine({ customer }: { customer: { customerId: string; name: string } | undefined }) {
  const { t } = useLanguage()
  return (
    <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
      {t('prodSales.trace.soldTo')}:{' '}
      {customer ? <Link href={`/zavod-mijozlar/${customer.customerId}`} className={linkCls}>{customer.name || '—'}</Link> : '—'}
    </p>
  )
}

function DownstreamTree({ node, trace, itemById, warehouseById }: {
  node: TraceNode
  trace: LotTrace
  itemById: Map<string, ProdItem>
  warehouseById: Map<string, ProdWarehouse>
}) {
  const { t } = useLanguage()
  if (node.children.length === 0) {
    return node.truncated ? <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodReports.trace.depthLimit')}</p> : null
  }
  return (
    <ul className="space-y-3">
      {node.children.map(c => (
        <li key={`${c.docType}:${c.docId}`} className="border-l border-gray-200 dark:border-gray-700 pl-4">
          <p className="text-[13px] font-medium"><DocLabel docType={c.docType} docId={c.docId} numbers={trace.docNumbers} /></p>
          {c.docType === 'sale' ? (
            <SaleCustomerLine customer={trace.saleCustomers.get(c.docId)} />
          ) : c.nodes.length === 0 ? (
            <p className="mt-1 text-[12px] text-gray-400 dark:text-gray-500">{t('prodReports.trace.noProduced')}</p>
          ) : (
            <div className="mt-1.5 space-y-2">
              {c.nodes.map(n => (
                <div key={n.lot.id} className="space-y-2">
                  <LotLine lot={n.lot} item={itemById.get(n.lot.itemId)} warehouse={warehouseById.get(n.lot.warehouseId)} />
                  <div className="pl-2"><DownstreamTree node={n} trace={trace} itemById={itemById} warehouseById={warehouseById} /></div>
                </div>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

export default function LotTracePage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, warehouseById } = useProdRefs()
  const [trace, setTrace] = useState<LotTrace | null>(null)
  const [loading, setLoading] = useState(true)
  // Hold columns exist after migration 20261110000014; null = not available.
  const [hold, setHold] = useState<{ status: LotHoldStatus; reason: string; at: string | null } | null>(null)
  const [holdTick, setHoldTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    createClient().from('prod_lot_stock').select('hold_status, hold_reason, hold_at').eq('id', id).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        setHold(error || !data ? null : { status: toLotHoldStatus(data.hold_status), reason: data.hold_reason ?? '', at: data.hold_at ?? null })
      })
    return () => { cancelled = true }
  }, [id, holdTick])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchLotTrace(createClient(), id).then(tr => {
      if (cancelled) return
      setTrace(tr)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!trace) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const lot = trace.root.lot
  const item = itemById.get(lot.itemId)
  const unit = item ? t(unitKey(item.unit)) : ''
  const today = localYmd()
  const supplierId = lot.supplierId ?? trace.chain.find(l => l.supplierId)?.supplierId ?? null
  const supplierName = lot.supplierName || trace.chain.find(l => l.supplierName)?.supplierName || ''
  const earliest = trace.chain.length ? trace.chain[trace.chain.length - 1] : lot

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodReports.trace.title')} {lot.lotNo}</h1>
        {lot.isOpening && <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">{t('production.lots.opening')}</span>}
        {hold && (
          <LotHoldControl
            lot={{ id: lot.id, lotNo: lot.lotNo, holdStatus: hold.status, holdReason: hold.reason, holdAt: hold.at }}
            onSaved={() => setHoldTick(n => n + 1)}
          />
        )}
      </div>
      {hold && hold.status !== 'free' && hold.reason && (
        <p className="text-[13px] text-amber-700 dark:text-amber-400">{t('prodInventory.hold.reason')}: {hold.reason}</p>
      )}

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4')}>
        <InfoField label={t('production.common.item')}>{item?.name ?? '—'}</InfoField>
        <InfoField label={t('production.common.warehouse')}>
          <Link href={`/zavod-omborlar/${lot.warehouseId}`} className={linkCls}>{warehouseById.get(lot.warehouseId)?.name ?? '—'}</Link>
        </InfoField>
        <InfoField label={t('production.lots.received')}>{lot.receivedAt ? formatDate(lot.receivedAt) : '—'}</InfoField>
        <InfoField label={t('production.lots.expiry')}><LotExpiry date={lot.expiryDate} today={today} warnDays={expiryWarnDaysOf(item)} /></InfoField>
        <InfoField label={t('production.lots.supplier')}>
          {supplierId ? <Link href={`/zavod-yetkazuvchilar/${supplierId}`} className={linkCls}>{supplierName || '—'}</Link> : (supplierName || '—')}
        </InfoField>
        <InfoField label={t('production.lots.unitCost')}>{formatPrice(lot.unitCost)}{unit ? ` / ${unit}` : ''}</InfoField>
        <InfoField label={`${t('production.lots.fat')} / ${t('prodReports.trace.protein')}`}>{formatPct(lot.fatPct)} / {formatPct(lot.proteinPct)}</InfoField>
        <InfoField label={t('production.lots.remaining')}>{formatQty(lot.remainingQty)} {unit} · {formatPrice(lot.value)}</InfoField>
        <InfoField label={t('prodReports.trace.source')}><DocLabel docType={lot.sourceDocType} docId={lot.sourceDocId} numbers={trace.docNumbers} /></InfoField>
        {trace.intake && (
          <InfoField label={t('production.milk.docTitle')}>
            <Link href={`/sut-qabuli/${trace.intake.id}`} className={linkCls}>#{trace.intake.number}</Link>
          </InfoField>
        )}
      </div>

      <div className={cn(prodCardCls, 'p-6 space-y-4')}>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <ArrowUpLeft className="h-4 w-4 text-gray-400" /> {t('prodReports.trace.upstream')}
        </h2>
        {trace.chain.length === 0 && trace.inputs.length === 0 ? (
          <p className="text-[13px] text-gray-500 dark:text-gray-400">
            {lot.isOpening ? t('prodReports.trace.openingHint') : lot.sourceDocType === 'receipt' ? t('prodReports.trace.fromSupplier') : t('prodReports.trace.noUpstream')}
          </p>
        ) : (
          <>
            {trace.chain.length > 0 && (
              <div className="space-y-2">
                <p className="text-[12px] font-medium text-gray-500 dark:text-gray-400">{t('prodReports.trace.originChain')}</p>
                {trace.chain.map(l => (
                  <div key={l.id} className="flex flex-wrap items-center gap-3 border-l border-gray-200 dark:border-gray-700 pl-4">
                    <LotLine lot={l} item={itemById.get(l.itemId)} warehouse={warehouseById.get(l.warehouseId)} />
                    <span className="text-[13px]"><DocLabel docType={l.sourceDocType} docId={l.sourceDocId} numbers={trace.docNumbers} /></span>
                  </div>
                ))}
              </div>
            )}
            {trace.inputs.length > 0 && (
              <div className="space-y-1">
                <p className="text-[12px] font-medium text-gray-500 dark:text-gray-400">
                  {t('prodReports.trace.inputsOf')} <DocLabel docType={earliest.sourceDocType} docId={earliest.sourceDocId} numbers={trace.docNumbers} />
                </p>
                <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                        <th className={th}>{t('production.lots.lotNo')}</th>
                        <th className={th}>{t('production.common.item')}</th>
                        <th className={th}>{t('production.lots.supplier')}</th>
                        <th className={thR}>{t('production.common.qty')}</th>
                        <th className={thR}>{t('production.lots.unitCost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trace.inputs.map((i, idx) => {
                        const it = itemById.get(i.itemId)
                        return (
                          <tr key={`${i.lotId}-${idx}`} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                            <td className={td}>
                              <Link href={lotTraceHref(i.lotId)} className="hover:opacity-70 transition-opacity">
                                <LotNo lot={{ lotNo: i.lot?.lotNo ?? '', isOpening: i.lot?.isOpening ?? false }} />
                              </Link>
                            </td>
                            <td className={cn(td, 'text-gray-900 dark:text-gray-100')}>{it?.name ?? '—'}</td>
                            <td className={cn(td, 'text-gray-500 dark:text-gray-400')}>{i.lot?.supplierName || '—'}</td>
                            <td className={tdR}>{formatQty(i.qty)} {it ? t(unitKey(it.unit)) : ''}</td>
                            <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{formatPrice(i.unitCost)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodReports.trace.movements')}</h2>
        {trace.root.movements.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-gray-400 dark:text-gray-500">{t('prodReports.trace.noMovements')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={th}>{t('production.common.date')}</th>
                  <th className={th}>{t('prodReports.trace.document')}</th>
                  <th className={th}>{t('production.common.warehouse')}</th>
                  <th className={thR}>{t('production.common.qty')}</th>
                  <th className={thR}>{t('production.lots.unitCost')}</th>
                  <th className={thR}>{t('production.common.total')}</th>
                </tr>
              </thead>
              <tbody>
                {trace.root.movements.map(m => (
                  <tr key={m.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className={cn(td, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(m.createdAt)}</td>
                    <td className={td}>
                      <DocLabel docType={m.docType} docId={m.docId} numbers={trace.docNumbers} />
                      {m.isReversal && <span className="ml-1.5 inline-flex rounded-full bg-red-100 dark:bg-red-500/10 px-2 py-0.5 text-[11px] text-red-700 dark:text-red-400">{t('prodReports.trace.reversal')}</span>}
                    </td>
                    <td className={cn(td, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(m.warehouseId)?.name ?? '—'}</td>
                    <td className={cn(tdR, m.qty < 0 ? 'text-gray-900 dark:text-gray-100' : 'text-emerald-600 dark:text-emerald-400')}>{m.qty > 0 ? '+' : '−'}{formatQty(Math.abs(m.qty))} {unit}</td>
                    <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{formatPrice(m.unitCost)}</td>
                    <td className={cn(tdR, 'font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Math.abs(m.qty) * m.unitCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={cn(prodCardCls, 'p-6 space-y-4')}>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <ArrowDownRight className="h-4 w-4 text-gray-400" /> {t('prodReports.trace.downstream')}
        </h2>
        {trace.root.children.length === 0 ? (
          <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('prodReports.trace.noDownstream')}</p>
        ) : (
          <DownstreamTree node={trace.root} trace={trace} itemById={itemById} warehouseById={warehouseById} />
        )}
      </div>
    </div>
  )
}
