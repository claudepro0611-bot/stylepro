'use client'

// Qaytarish (return against one sale): per sale line the sold and already
// returned quantity, the quantity to return and whether it goes back to
// stock (restock: new lots with the original lots' cost; otherwise no stock
// movement, the value is a loss). The stock goes to the return warehouse of
// the document (default: the sale's warehouse). Saves through
// prod_create_sale_return; the server re-validates quantities and amounts.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import {
  BackLink, FormFooter, NoteField, PageHeader, TotalsBox, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls,
} from '@/components/production/ProdKit'
import { DocDateInput, useApprovalRetry, useProdErrorText } from '@/components/production/ControlKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useSalesAvailable, useSeesMargin } from '@/components/production/SalesKit'
import {
  formatQty, localDateTimeToIso, nowHm, parseDecimal, round2, round3, toInputString, unitKey, warehousesFor,
} from '@/lib/production'
import {
  SALE_COLS, SALE_ITEM_COLS, fetchReturnedBySaleItem, returnLineAmounts,
  type SaleItemRow, type SaleRow,
} from '@/lib/sales'

interface LineState { value: string; restock: boolean }

export default function NewSaleReturnPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useSalesAvailable()
  const seesMargin = useSeesMargin()
  const { warehouses, itemById } = useProdRefs()

  const [sale, setSale] = useState<SaleRow | null>(null)
  const [saleLines, setSaleLines] = useState<SaleItemRow[]>([])
  const [returned, setReturned] = useState<Map<string, number>>(new Map())
  const [customerName, setCustomerName] = useState('')
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [state, setState] = useState<Record<string, LineState>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDate(localYmd())
    setTime(nowHm())
  }, [])

  useEffect(() => {
    if (!available) return
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const [sRes, lRes, ret] = await Promise.all([
        supabase.from('prod_sales').select(SALE_COLS).eq('id', id).maybeSingle(),
        supabase.from('prod_sale_items').select(SALE_ITEM_COLS).eq('sale_id', id).order('sort_order').order('id'),
        fetchReturnedBySaleItem(supabase, id),
      ])
      if (cancelled) return
      const s = (sRes.data as SaleRow | null) ?? null
      setSale(s)
      setSaleLines((lRes.data ?? []) as SaleItemRow[])
      setReturned(ret)
      if (s) {
        setWarehouseId(s.warehouse_id)
        const { data: c } = await supabase.from('prod_customers').select('name').eq('id', s.customer_id).maybeSingle()
        if (!cancelled) setCustomerName(c?.name ?? '')
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, available])

  const vatRate = Number(sale?.vat_rate ?? 0)

  const computed = useMemo(() => saleLines.map(l => {
    const item = itemById.get(l.item_id)
    const sold = Number(l.qty)
    const already = returned.get(l.id) ?? 0
    const left = Math.max(0, round3(sold - already))
    const st = state[l.id] ?? { value: '', restock: true }
    const qty = round3(parseDecimal(st.value))
    const a = returnLineAmounts(l, qty, vatRate)
    return { line: l, item, sold, already, left, qty, restock: st.restock, value: st.value, ...a, over: qty > left }
  }), [saleLines, itemById, returned, state, vatRate])

  const picked = computed.filter(c => c.qty > 0)
  const totals = {
    amount: round2(picked.reduce((s, c) => s + c.amount, 0)),
    vat: round2(picked.reduce((s, c) => s + c.vat, 0)),
    total: round2(picked.reduce((s, c) => s + c.total, 0)),
    restockCost: round2(picked.filter(c => c.restock).reduce((s, c) => s + c.cost, 0)),
    lossCost: round2(picked.filter(c => !c.restock).reduce((s, c) => s + c.cost, 0)),
  }
  const nothingLeft = computed.length > 0 && computed.every(c => c.left <= 0)
  const valid = !!sale && sale.status === 'posted' && !!warehouseId && picked.length > 0 && computed.every(c => !c.over)

  function patch(lineId: string, p: Partial<LineState>) {
    setState(prev => ({ ...prev, [lineId]: { ...(prev[lineId] ?? { value: '', restock: true }), ...p } }))
  }

  function returnAll() {
    setState(prev => {
      const next = { ...prev }
      for (const c of computed) next[c.line.id] = { value: c.left > 0 ? toInputString(c.left) : '', restock: prev[c.line.id]?.restock ?? true }
      return next
    })
  }

  async function save() {
    if (!valid || !sale) { toast.error(t(computed.some(c => c.over) ? 'prodSales.returns.overError' : 'productionErrors.invalid_input')); return }
    setSaving(true)
    const res = await approval.run(ctl => createClient().rpc('prod_create_sale_return', {
      p_data: {
        ...ctl,
        doc_date: localDateTimeToIso(date, time),
        sale_id: sale.id,
        warehouse_id: warehouseId,
        reason: reason.trim() || null,
        note: note.trim() || null,
        items: picked.map(c => ({ sale_item_id: c.line.id, qty: c.qty, restock: c.restock })),
      },
    }))
    setSaving(false)
    if (!res) return
    const { data, error } = res
    if (error) { toast.error(errorText(error)); return }
    const rid = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(rid ? `/zavod-qaytarishlar/${rid}` : `/zavod-sotuv/${sale.id}`)
  }

  const back = <BackLink href={`/zavod-sotuv/${id}`} label={sale ? `${t('prodSales.sales.docTitle')} #${sale.number}` : t('prodSales.sales.title')} />

  if (available === false) return <div className="space-y-5">{back}<NotAvailableNote /></div>
  if (loading || available === null) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!sale) {
    return <div className="space-y-5">{back}<p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p></div>
  }
  if (sale.status !== 'posted') {
    return <div className="space-y-5">{back}<p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.already_cancelled')}</p></div>
  }

  const targetWarehouses = warehousesFor(warehouses, ['return', 'finished'])
  const allTargets = targetWarehouses.some(w => w.id === sale.warehouse_id) ? targetWarehouses : [...targetWarehouses, ...warehouses.filter(w => w.id === sale.warehouse_id)]

  return (
    <div className="space-y-5">
      {back}
      <PageHeader title={t('prodSales.returns.newTitle')} subtitle={`${t('prodSales.sales.docTitle')} #${sale.number} · ${customerName}`} />

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4')}>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.date')}</span>
          <DocDateInput value={date} onChange={setDate} />
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.time')}</span>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('prodSales.returns.warehouse')}</span>
          <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={prodFieldCls}>
            {allTargets.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodSales.returns.warehouseHint')}</span>
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('prodInventory.common.reason')}</span>
          <input value={reason} onChange={e => setReason(e.target.value.slice(0, 200))} placeholder={t('prodSales.returns.reasonPlaceholder')} className={prodFieldCls} />
        </label>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.sales.lines')}</h2>
          {!nothingLeft && <button type="button" onClick={returnAll} className={secondaryBtnCls}>{t('prodSales.returns.returnAll')}</button>}
        </div>
        {nothingLeft ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('prodSales.returns.nothingToReturn')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.returns.sold')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.returns.alreadyReturned')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-44">{t('prodSales.returns.returnQty')}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t('prodSales.returns.restock')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.returns.credit')}</th>
                  {seesMargin && <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.cost')}</th>}
                </tr>
              </thead>
              <tbody>
                {computed.map(c => {
                  const unit = t(unitKey(c.line.unit || c.item?.unit || 'pcs'))
                  return (
                    <tr key={c.line.id} className={cn('border-b border-gray-50 dark:border-gray-800/60 last:border-0 align-top', c.left <= 0 && 'opacity-50')}>
                      <td className="px-4 py-2">
                        <p className="text-gray-900 dark:text-gray-100">{c.item?.name ?? '—'}</p>
                        <p className="text-[12px] tabular-nums text-gray-400 dark:text-gray-500">{formatPrice(Number(c.line.price))}{Number(c.line.discount_pct) ? ` · −${Number(c.line.discount_pct)}%` : ''}</p>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300">{formatQty(c.sold)} {unit}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{c.already ? `${formatQty(c.already)} ${unit}` : '—'}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            inputMode="decimal"
                            value={c.value}
                            disabled={c.left <= 0}
                            onChange={e => patch(c.line.id, { value: e.target.value })}
                            placeholder="0"
                            className={cn(prodFieldCls, 'text-right tabular-nums', c.over && 'border-red-300 dark:border-red-800')}
                          />
                          <span className="text-[12px] text-gray-400 dark:text-gray-500">{unit}</span>
                        </div>
                        {c.over && <p className="mt-0.5 text-right text-[11px] text-red-600 dark:text-red-400">{t('prodSales.returns.overError')}</p>}
                      </td>
                      <td className="px-4 py-2">
                        <label className="flex items-center gap-2 pt-1.5">
                          <Switch checked={c.restock} onCheckedChange={v => patch(c.line.id, { restock: v })} disabled={c.left <= 0} />
                          <span className="text-[12px] text-gray-500 dark:text-gray-400">{c.restock ? t('prodSales.returns.restockYes') : t('prodSales.returns.restockNo')}</span>
                        </label>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{c.qty > 0 ? formatPrice(c.total) : '—'}</td>
                      {seesMargin && <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{c.qty > 0 ? formatPrice(c.cost) : '—'}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-gray-100 dark:border-gray-800 px-4 py-2 text-[12px] text-gray-400 dark:text-gray-500">{t('prodSales.returns.restockHint')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className={cn(prodCardCls, 'p-6')}>
          <NoteField value={note} onChange={setNote} />
        </div>
        <TotalsBox rows={[
          { label: t('prodInventory.common.itemsCount'), value: String(picked.length) },
          { label: t('prodSales.common.subtotal'), value: formatPrice(totals.amount) },
          { label: `${t('prodSales.common.vat')} ${vatRate}%`, value: formatPrice(totals.vat) },
          ...(seesMargin ? [
            { label: t('prodSales.returns.restockCost'), value: formatPrice(totals.restockCost) },
            { label: t('prodSales.returns.lossCost'), value: formatPrice(totals.lossCost), tone: totals.lossCost > 0 ? 'negative' as const : undefined },
          ] : []),
          { label: t('prodSales.returns.credit'), value: formatPrice(totals.total), strong: true },
        ]} />
      </div>

      <FormFooter onCancel={() => router.push(`/zavod-sotuv/${sale.id}`)} onSave={save} saving={saving} disabled={!valid} />
      {approval.dialog}
    </div>
  )
}
