'use client'

// New write-off: one warehouse, reason, lines with optional lot picks
// (held / blocked lots are pickable here, FEFO takes free lots first).
// Posts through prod_create_writeoff; the server re-validates and costs.

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
import { DocDateInput, useApprovalRetry, useProdErrorText } from '@/components/production/ControlKit'
import { UnitQtyInput, entryToBase, useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs, useWarehouseLots, useWarehouseStock } from '@/components/production/useProdRefs'
import { LotPicker } from '@/components/production/LotPicker'
import { NotAvailableNote, useInventoryDocs } from '@/components/production/InventoryKit'
import {
  activePicks, expiryWarnDaysOf, formatQty, lineAllocation, lineCost, localDateTimeToIso, makeLinePicks, nowHm, picksPayload,
  round2, round3, sumByUnitGroup, unitKey,
  type EntryUnit, type LinePicks,
} from '@/lib/production'
import { INVENTORY_MAX_LINES, WRITEOFF_REASONS, writeoffReasonKey, type WriteoffReason } from '@/lib/inventory'

interface Line {
  itemId: string
  value: string
  unit: EntryUnit
  picks?: LinePicks | null
}

export default function NewWriteoffPage() {
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useInventoryDocs()
  const { smart, groups } = useQtyFormat()
  const { items, warehouses, itemById } = useProdRefs()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [reason, setReason] = useState<WriteoffReason>('spoiled')
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDate(localYmd())
    setTime(nowHm())
    setWarehouseId(new URLSearchParams(window.location.search).get('warehouse') ?? '')
  }, [])

  const activeWarehouses = warehouses.filter(w => w.isActive)
  // Last used warehouse(s) of this user for this document type.
  const remember0 = useRememberedDefault('writeoff-warehouse', activeWarehouses.map(w => w.id), warehouseId, setWarehouseId)
  const sourceId = activeWarehouses.some(w => w.id === warehouseId) ? warehouseId : ''
  const { stock, loading: stockLoading } = useWarehouseStock(sourceId)
  const { lotsOf, available: lotsAvailable } = useWarehouseLots(sourceId)

  const itemOptions = useMemo(() => items
    .filter(i => stock.has(i.id) && !lines.some(l => l.itemId === i.id))
    .map(i => ({
      value: i.id,
      label: i.name,
      sublabel: `${t('production.common.available')}: ${formatQty(stock.get(i.id)!.qty)} ${t(unitKey(i.unit))}`,
    })), [items, stock, lines, t])

  const computed = lines.map(l => {
    const item = itemById.get(l.itemId)
    const base = item?.unit ?? 'pcs'
    const s = stock.get(l.itemId)
    const avail = s?.qty ?? 0
    const avg = s?.avgCost ?? 0
    const qty = round3(entryToBase(l.value, base, l.unit))
    const lots = lotsOf(l.itemId)
    const picks = activePicks(l.picks, sourceId, l.itemId, qty)
    const total = lineCost(lineAllocation(lots, picks, qty, 'any'), qty, avg)
    return { ...l, item, base, available: avail, qty, lots, picks, unitPrice: qty > 0 ? round2(total / qty) : avg, total, over: qty > avail }
  })
  const total = round2(computed.reduce((s, c) => s + c.total, 0))
  const valid = !!sourceId && computed.length > 0 && computed.length <= INVENTORY_MAX_LINES && computed.every(c => c.qty > 0 && !c.over)

  function patchLine(itemId: string, patch: Partial<Line>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...patch } : l)))
  }

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const res = await approval.run(ctl => createClient().rpc('prod_create_writeoff', {
      p_data: {
        ...ctl,
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: sourceId,
        reason,
        note: note.trim() || null,
        items: computed.map(c => ({ item_id: c.itemId, qty: c.qty, lots: picksPayload(c.picks) })),
      },
    }))
    setSaving(false)
    if (!res) return
    const { data, error } = res
    if (error) { toast.error(errorText(error)); return }
    remember0(warehouseId)
    const id = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(id ? `/zavod-hisobdan-chiqarish/${id}` : '/zavod-hisobdan-chiqarish')
  }

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-hisobdan-chiqarish" label={t('prodInventory.writeoffs.title')} />
        <NotAvailableNote />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobdan-chiqarish" label={t('prodInventory.writeoffs.title')} />
      <PageHeader title={t('prodInventory.writeoffs.newTitle')} />

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
          <span className={prodLabelCls}>{t('production.common.warehouse')}</span>
          <select data-autofocus value={sourceId} onChange={e => { setWarehouseId(e.target.value); setLines([]) }} className={prodFieldCls}>
            <option value="">{t('prodInventory.common.selectWarehouse')}</option>
            {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('prodInventory.common.reason')}</span>
          <select value={reason} onChange={e => setReason(e.target.value as WriteoffReason)} className={prodFieldCls}>
            {WRITEOFF_REASONS.map(r => <option key={r} value={r}>{t(writeoffReasonKey(r))}</option>)}
          </select>
        </label>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodInventory.common.linesTitle')}</h2>
            {lotsAvailable && <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodInventory.writeoffs.heldHint')}</p>}
          </div>
          <div className="w-full sm:w-80">
            {!sourceId ? (
              <DisabledSelect placeholder={t('prodInventory.common.chooseWarehouseFirst')} />
            ) : stockLoading ? (
              <div className="flex h-9 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
            ) : (
              <SearchSelect
                options={itemOptions}
                value=""
                onChange={id => {
                  if (lines.length >= INVENTORY_MAX_LINES) return
                  const base = itemById.get(id)?.unit ?? 'pcs'
                  setLines(prev => [...prev, { itemId: id, value: '', unit: base }])
                }}
                placeholder={itemOptions.length ? t('prodInventory.common.addItem') : t('production.common.noStock')}
              />
            )}
          </div>
        </div>
        {computed.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('prodInventory.common.noItems')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.available')}</th>
                  <th className={cn('px-4 py-2.5 text-right font-medium', lotsAvailable ? 'w-72' : 'w-56')}>{t('production.common.qty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{lotsAvailable ? t('production.lots.unitCost') : t('production.common.avgCost')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map(c => (
                  <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{c.item?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{smart(c.available, c.base)}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <UnitQtyInput
                          className="flex-1"
                          value={c.value}
                          onChange={v => patchLine(c.itemId, { value: v })}
                          base={c.base}
                          unit={c.unit}
                          onUnitChange={(u, v) => patchLine(c.itemId, { unit: u, value: v })}
                          invalid={c.over}
                        />
                        <LotPicker
                          lots={c.lots}
                          qty={c.qty}
                          unit={c.base}
                          picks={c.picks}
                          mode="any"
                          warnDays={expiryWarnDaysOf(c.item)}
                          onChange={p => patchLine(c.itemId, { picks: makeLinePicks(sourceId, c.itemId, c.qty, p) })}
                        />
                      </div>
                      {c.over && <p className="mt-0.5 text-right text-[11px] text-red-600 dark:text-red-400">{t('productionErrors.insufficient_stock')}</p>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(c.unitPrice)}</td>
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
                ))}
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
          { label: t('prodInventory.common.itemsCount'), value: String(computed.length) },
          { label: t('prodInventory.common.totalQty'), value: groups(sumByUnitGroup(computed.map(c => ({ qty: c.qty, unit: c.base })))) },
          { label: t('prodInventory.writeoffs.totalCost'), value: formatPrice(total), strong: true },
        ]} />
      </div>

      <FormFooter onCancel={() => router.push('/zavod-hisobdan-chiqarish')} onSave={save} saving={saving} disabled={!valid || available !== true} total={{ label: t('prodInventory.writeoffs.totalCost'), value: formatPrice(total) }} />
      {approval.dialog}
    </div>
  )
}
