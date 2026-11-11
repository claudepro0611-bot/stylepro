'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, DisabledSelect, FormFooter, MoreFields, NoteField, PageHeader, TotalsBox, useRememberedDefault,
  prodCardCls, prodFieldCls, prodLabelCls,
} from '@/components/production/ProdKit'
import { useProdRefs, useWarehouseLots, useWarehouseStock } from '@/components/production/useProdRefs'
import { LotPicker } from '@/components/production/LotPicker'
import {
  activePicks, formatQty, lineAllocation, lineCost, localDateTimeToIso, makeLinePicks, nowHm, parseDecimal, picksPayload,
  prodErrorKey, round2, round3, unitKey,
  type LinePicks,
} from '@/lib/production'

interface OutputLine { itemId: string; qty: string; price: string }

export default function NewProcessingPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { items, warehouses, itemById } = useProdRefs()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  // null: not picked yet, outputs go to the source warehouse.
  const [outputWarehouseChoice, setOutputWarehouseChoice] = useState<string | null>(null)
  const [sourceItemId, setSourceItemId] = useState('')
  const [sourceQty, setSourceQty] = useState('')
  const [lines, setLines] = useState<OutputLine[]>([])
  // Manually picked source lots; dropped automatically when warehouse/item/qty change.
  const [sourcePicks, setSourcePicks] = useState<LinePicks | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const { stock, loading: stockLoading } = useWarehouseStock(warehouseId)
  const { lotsOf, available: lotsAvailable } = useWarehouseLots(warehouseId)

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

  const activeWarehouses = warehouses.filter(w => w.isActive)
  // Last used warehouse(s) of this user for this document type.
  const remember0 = useRememberedDefault('processing-warehouse', activeWarehouses.map(w => w.id), warehouseId, setWarehouseId)
  const outputWarehouseId = outputWarehouseChoice ?? warehouseId
  const source = itemById.get(sourceItemId)
  const sourceStock = stock.get(sourceItemId)
  const sourceUnit = source ? t(unitKey(source.unit)) : ''

  const sourceOptions = useMemo(() => items
    .filter(i => stock.has(i.id))
    .map(i => ({
      value: i.id,
      label: i.name,
      sublabel: `${t('production.common.available')}: ${formatQty(stock.get(i.id)!.qty)} ${t(unitKey(i.unit))}`,
    })), [items, stock, t])

  const outputOptions = useMemo(() => items
    .filter(i => i.isActive && i.id !== sourceItemId && !lines.some(l => l.itemId === i.id))
    .map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) })), [items, sourceItemId, lines, t])

  const qty = parseDecimal(sourceQty)
  const available = sourceStock?.qty ?? 0
  const avg = sourceStock?.avgCost ?? 0
  const over = qty > available
  // Exact cost from the source lots (picked, else the FEFO preview); avg_cost without lots.
  const sourceLots = sourceItemId ? lotsOf(sourceItemId) : null
  const picks = activePicks(sourcePicks, warehouseId, sourceItemId, qty)
  const processingCost = lineCost(lineAllocation(sourceLots, picks, round3(qty)), round3(qty), avg)
  const unitPrice = round3(qty) > 0 ? round2(processingCost / round3(qty)) : avg

  const computed = lines.map(l => {
    const q = parseDecimal(l.qty)
    const p = parseDecimal(l.price)
    return { ...l, qtyNum: q, priceNum: p, total: round2(q * p) }
  })
  const recoveryCost = round2(computed.reduce((s, c) => s + c.total, 0))
  const profit = round2(recoveryCost - processingCost)

  const valid = !!warehouseId && !!outputWarehouseId && !!sourceItemId && qty > 0 && !over && computed.length > 0
    && computed.every(c => c.qtyNum > 0)

  function changeWarehouse(id: string) {
    setWarehouseId(id)
    setSourceItemId('')
    setSourceQty('')
  }

  function changeSource(id: string) {
    setSourceItemId(id)
    setLines(prev => prev.filter(l => l.itemId !== id))
  }

  function setLine(itemId: string, patch: Partial<OutputLine>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...patch } : l)))
  }

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_create_processing', {
      p_data: {
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        output_warehouse_id: outputWarehouseId,
        source_item_id: sourceItemId,
        source_qty: round3(qty),
        source_lots: picksPayload(picks),
        note: note.trim() || null,
        outputs: computed.map(c => ({ item_id: c.itemId, qty: round3(c.qtyNum), price: round2(c.priceNum) })),
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    remember0(warehouseId)
    const id = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(id ? `/qayta-ishlash/${id}` : '/qayta-ishlash')
  }

  return (
    <div className="space-y-5">
      <BackLink href="/qayta-ishlash" label={t('production.processings.title')} />
      <PageHeader title={t('production.processings.newTitle')} />

      <div className={cn(prodCardCls, 'p-6 space-y-5')}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.date')}</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.time')}</span>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.warehouse')}</span>
            <select data-autofocus value={warehouseId} onChange={e => changeWarehouse(e.target.value)} className={prodFieldCls}>
              <option value="">{t('production.common.selectWarehouse')}</option>
              {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.processings.outputWarehouse')}</span>
            <select value={outputWarehouseId} onChange={e => setOutputWarehouseChoice(e.target.value || null)} className={prodFieldCls}>
              <option value="">{t('production.common.selectWarehouse')}</option>
              {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-3">
            <span className={prodLabelCls}>{t('production.processings.sourceItem')}</span>
            {!warehouseId ? (
              <DisabledSelect placeholder={t('production.common.chooseWarehouseFirst')} />
            ) : stockLoading ? (
              <div className="flex h-9 items-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
            ) : (
              <SearchSelect
                options={sourceOptions}
                value={sourceItemId}
                onChange={changeSource}
                placeholder={sourceOptions.length ? t('production.common.selectItem') : t('production.common.noStock')}
              />
            )}
            {sourceStock && (
              <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">
                {t('production.common.available')}: <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">{formatQty(available)} {sourceUnit}</span>
              </p>
            )}
          </div>
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.qty')}</span>
            <div className="relative">
              <input
                inputMode="decimal"
                value={sourceQty}
                onChange={e => setSourceQty(e.target.value)}
                disabled={!sourceItemId}
                placeholder="0"
                className={cn(prodFieldCls, 'pr-12 tabular-nums', over && 'border-red-300 dark:border-red-800')}
              />
              {source && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{sourceUnit}</span>}
            </div>
            {over && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{t('productionErrors.insufficient_stock')}</p>}
            {source && lotsAvailable && (
              <div className="mt-1.5 flex justify-end">
                <LotPicker
                  lots={sourceLots}
                  qty={round3(qty)}
                  unit={source.unit}
                  picks={picks}
                  onChange={p => setSourcePicks(makeLinePicks(warehouseId, sourceItemId, qty, p))}
                />
              </div>
            )}
          </label>
        </div>

        {/* Mahsulot qiymati: current average cost of the processed item */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="mb-3 text-[13px] font-semibold text-gray-900 dark:text-gray-100">{t('production.processings.sourceValue')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="block">
              <span className={prodLabelCls}>{t('production.processings.unitPrice')}</span>
              <input readOnly disabled value={formatPrice(unitPrice)} className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.qty')}</span>
              <input readOnly disabled value={`${formatQty(qty)} ${sourceUnit}`} className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.total')}</span>
              <input readOnly disabled value={formatPrice(processingCost)} className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
          </div>
        </div>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.processings.outputs')}</h2>
          <div className="w-full sm:w-80">
            {sourceItemId ? (
              <SearchSelect
                options={outputOptions}
                value=""
                onChange={id => setLines(prev => [...prev, { itemId: id, qty: '', price: '' }])}
                placeholder={t('production.processings.addOutput')}
              />
            ) : (
              <DisabledSelect placeholder={t('production.processings.chooseSourceFirst')} />
            )}
          </div>
        </div>
        {computed.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.processings.noOutputs')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-40">{t('production.common.qty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-44">{t('production.common.price')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map(c => {
                  const item = itemById.get(c.itemId)
                  return (
                    <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                        {item?.name ?? '—'}
                        {item && <span className="ml-1.5 text-xs text-gray-400">{t(unitKey(item.unit))}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <input inputMode="decimal" value={c.qty} onChange={e => setLine(c.itemId, { qty: e.target.value })} placeholder="0" className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                      </td>
                      <td className="px-4 py-2">
                        <input inputMode="decimal" value={c.price} onChange={e => setLine(c.itemId, { price: e.target.value })} placeholder="0" className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(c.total)}</td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => setLines(prev => prev.filter(l => l.itemId !== c.itemId))}
                          aria-label={t('production.common.remove')}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className={cn(prodCardCls, 'p-4')}>
          <MoreFields active={!!note}><NoteField value={note} onChange={setNote} /></MoreFields>
        </div>
        <TotalsBox rows={[
          { label: t('production.processings.processingCost'), value: formatPrice(processingCost) },
          { label: t('production.processings.recoveryCost'), value: formatPrice(recoveryCost) },
          { label: t('production.processings.profit'), value: formatPrice(profit), tone: profit < 0 ? 'negative' : profit > 0 ? 'positive' : undefined, strong: true },
        ]} />
      </div>

      <FormFooter onCancel={() => router.push('/qayta-ishlash')} onSave={save} saving={saving} disabled={!valid} />
    </div>
  )
}
