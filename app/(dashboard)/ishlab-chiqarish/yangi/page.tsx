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
  BackLink, DisabledSelect, FormFooter, NoteField, PageHeader, TotalsBox,
  prodCardCls, prodFieldCls, prodLabelCls,
} from '@/components/production/ProdKit'
import { useProdRefs, useWarehouseStock } from '@/components/production/useProdRefs'
import { formatQty, localDateTimeToIso, nowHm, parseDecimal, prodErrorKey, round2, round3, unitKey } from '@/lib/production'

interface ComponentLine { itemId: string; qty: string }

export default function NewProductionPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { items, warehouses, itemById } = useProdRefs()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [outputItemId, setOutputItemId] = useState('')
  const [outputQty, setOutputQty] = useState('')
  const [lines, setLines] = useState<ComponentLine[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const { stock, loading: stockLoading } = useWarehouseStock(warehouseId)

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

  const activeWarehouses = warehouses.filter(w => w.isActive)
  const outputItem = itemById.get(outputItemId)

  const outputOptions = useMemo(() => items
    .filter(i => i.isActive && (i.itemType === 'finished' || i.itemType === 'semi') && !lines.some(l => l.itemId === i.id))
    .map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) })), [items, lines, t])

  // Components: only what the chosen warehouse actually holds.
  const componentOptions = useMemo(() => items
    .filter(i => stock.has(i.id) && i.id !== outputItemId && !lines.some(l => l.itemId === i.id))
    .map(i => ({
      value: i.id,
      label: i.name,
      sublabel: `${t('production.common.available')}: ${formatQty(stock.get(i.id)!.qty)} ${t(unitKey(i.unit))}`,
    })), [items, stock, outputItemId, lines, t])

  const computed = lines.map(l => {
    const qty = parseDecimal(l.qty)
    const s = stock.get(l.itemId)
    const available = s?.qty ?? 0
    const avg = s?.avgCost ?? 0
    return { ...l, qtyNum: qty, available, avg, total: round2(qty * avg), over: qty > available }
  })
  const totalCost = round2(computed.reduce((sum, c) => sum + c.total, 0))
  const outQty = parseDecimal(outputQty)
  const unitCost = outQty > 0 ? round2(totalCost / outQty) : 0

  const valid = !!warehouseId && !!outputItemId && outQty > 0 && computed.length > 0
    && computed.every(c => c.qtyNum > 0 && !c.over)

  function changeWarehouse(id: string) {
    setWarehouseId(id)
    // Components belong to the old warehouse's stock.
    setLines([])
  }

  function setLineQty(itemId: string, qty: string) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, qty } : l)))
  }

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_create_production', {
      p_data: {
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        output_item_id: outputItemId,
        output_qty: round3(outQty),
        note: note.trim() || null,
        components: computed.map(c => ({ item_id: c.itemId, qty: round3(c.qtyNum) })),
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error.message))); return }
    const id = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(id ? `/ishlab-chiqarish/${id}` : '/ishlab-chiqarish')
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <BackLink href="/ishlab-chiqarish" label={t('production.productions.title')} />
      <PageHeader title={t('production.productions.newTitle')} />

      <div className={cn(prodCardCls, 'p-6 space-y-5')}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
            <select value={warehouseId} onChange={e => changeWarehouse(e.target.value)} className={prodFieldCls}>
              <option value="">{t('production.common.selectWarehouse')}</option>
              {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-4">
          <div>
            <span className={prodLabelCls}>{t('production.productions.outputItem')}</span>
            {warehouseId ? (
              <SearchSelect options={outputOptions} value={outputItemId} onChange={setOutputItemId} placeholder={t('production.common.selectItem')} />
            ) : (
              <DisabledSelect placeholder={t('production.common.chooseWarehouseFirst')} />
            )}
          </div>
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.qty')}</span>
            <div className="relative">
              <input
                inputMode="decimal"
                value={outputQty}
                onChange={e => setOutputQty(e.target.value)}
                disabled={!warehouseId}
                placeholder="0"
                className={cn(prodFieldCls, 'pr-12 tabular-nums')}
              />
              {outputItem && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{t(unitKey(outputItem.unit))}</span>}
            </div>
          </label>
        </div>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.productions.components')}</h2>
          <div className="w-full sm:w-80">
            {!warehouseId ? (
              <DisabledSelect placeholder={t('production.common.chooseWarehouseFirst')} />
            ) : stockLoading ? (
              <div className="flex h-9 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
            ) : (
              <SearchSelect
                options={componentOptions}
                value=""
                onChange={id => setLines(prev => [...prev, { itemId: id, qty: '' }])}
                placeholder={componentOptions.length ? t('production.productions.addComponent') : t('production.common.noStock')}
              />
            )}
          </div>
        </div>
        {computed.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.productions.noComponents')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.productions.component')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.stockLeft')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-40">{t('production.common.qty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.avgCost')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map(c => {
                  const item = itemById.get(c.itemId)
                  const unit = item ? t(unitKey(item.unit)) : ''
                  return (
                    <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(c.available)} {unit}</td>
                      <td className="px-4 py-2">
                        <input
                          inputMode="decimal"
                          value={c.qty}
                          onChange={e => setLineQty(c.itemId, e.target.value)}
                          placeholder="0"
                          className={cn(prodFieldCls, 'h-8 text-right tabular-nums', c.over && 'border-red-300 dark:border-red-800')}
                        />
                        {c.over && <p className="mt-0.5 text-right text-[11px] text-red-600 dark:text-red-400">{t('productionErrors.insufficient_stock')}</p>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(c.avg)}</td>
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
        <div className={cn(prodCardCls, 'p-6')}>
          <NoteField value={note} onChange={setNote} />
        </div>
        <TotalsBox rows={[
          { label: t('production.productions.totalCost'), value: formatPrice(totalCost) },
          { label: t('production.productions.unitCost'), value: outputItem ? `${formatPrice(unitCost)} / ${t(unitKey(outputItem.unit))}` : formatPrice(unitCost), strong: true },
        ]} />
      </div>

      <FormFooter onCancel={() => router.push('/ishlab-chiqarish')} onSave={save} saving={saving} disabled={!valid} />
    </div>
  )
}
