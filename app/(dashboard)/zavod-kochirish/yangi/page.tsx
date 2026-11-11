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
import { DocDateInput, useApprovalRetry, useProdErrorText } from '@/components/production/ControlKit'
import { DraftBanner } from '@/components/production/DraftBanner'
import { useFormDraft } from '@/lib/useFormDraft'
import { UnitQtyInput, entryToBase, useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs, useWarehouseLots, useWarehouseStock } from '@/components/production/useProdRefs'
import { LotPicker } from '@/components/production/LotPicker'
import {
  activePicks, formatQty, lineAllocation, lineCost, localDateTimeToIso, makeLinePicks, nowHm, picksPayload,
  round2, round3, sumByUnitGroup, unitKey,
  type EntryUnit, type LinePicks,
} from '@/lib/production'

// prod_create_transfer accepts 1..500 lines.
const MAX_LINES = 500

interface Line {
  itemId: string
  value: string
  unit: EntryUnit
  /** Manually picked lots; dropped automatically when warehouse or qty change. */
  picks?: LinePicks | null
}

export default function NewTransferPage() {
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { smart, groups } = useQtyFormat()
  const { items, warehouses, itemById } = useProdRefs()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Local draft (useFormDraft): autosaved 2 s after a change, offered when the form opens.
  const draftState = { date, time, fromId, toId, lines, note }
  const draft = useFormDraft('transfer', draftState, (d: typeof draftState) => {
    setDate(d.date); setTime(d.time); setFromId(d.fromId); setToId(d.toId); setLines(d.lines); setNote(d.note)
  }, { isEmpty: d => d.lines.length === 0 && !d.note })

  // Client clock and ?from=<warehouseId> (from the warehouse page) only on the client.
  useEffect(() => {
    setDate(localYmd())
    setTime(nowHm())
    setFromId(new URLSearchParams(window.location.search).get('from') ?? '')
  }, [])

  const activeWarehouses = warehouses.filter(w => w.isActive)
  // Last used warehouse(s) of this user for this document type.
  const remember0 = useRememberedDefault('transfer-from-warehouse', activeWarehouses.map(w => w.id), fromId, setFromId)
  const remember1 = useRememberedDefault('transfer-to-warehouse', activeWarehouses.map(w => w.id), toId, setToId)
  // A ?from id that is not an active warehouse is ignored.
  const sourceId = activeWarehouses.some(w => w.id === fromId) ? fromId : ''
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
    const available = s?.qty ?? 0
    const avg = s?.avgCost ?? 0
    const qty = round3(entryToBase(l.value, base, l.unit))
    // Destination lots keep the source lots' costs: exact cost from the lots, avg_cost without lots.
    const lots = lotsOf(l.itemId)
    const picks = activePicks(l.picks, sourceId, l.itemId, qty)
    const total = lineCost(lineAllocation(lots, picks, qty, 'pick'), qty, avg)
    return { ...l, item, base, available, avg, qty, lots, picks, unitPrice: qty > 0 ? round2(total / qty) : avg, total, over: qty > available }
  })
  const total = round2(computed.reduce((s, c) => s + c.total, 0))
  const same = !!sourceId && sourceId === toId

  const valid = !!sourceId && !!toId && !same && computed.length > 0 && computed.length <= MAX_LINES
    && computed.every(c => c.qty > 0 && !c.over)

  function changeFrom(id: string) {
    setFromId(id)
    // Lines and their stock belong to the old source warehouse.
    setLines([])
  }

  function patchLine(itemId: string, patch: Partial<Line>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...patch } : l)))
  }

  async function save() {
    if (!valid) { toast.error(t(same ? 'production.transfers.sameWarehouse' : 'productionErrors.invalid_input')); return }
    setSaving(true)
    const res = await approval.run(ctl => createClient().rpc('prod_create_transfer', {
      p_data: {
        ...ctl,
        doc_date: localDateTimeToIso(date, time),
        from_warehouse_id: sourceId,
        to_warehouse_id: toId,
        note: note.trim() || null,
        items: computed.map(c => ({ item_id: c.itemId, qty: c.qty, lots: picksPayload(c.picks) })),
      },
    }))
    setSaving(false)
    if (!res) return
    const { data, error } = res
    if (error) { toast.error(errorText(error)); return }
    remember0(fromId)
    remember1(toId)
    const id = (data as { id?: string } | null)?.id
    draft.clear()
    toast.success(t('production.common.saved'))
    router.push(id ? `/zavod-kochirish/${id}` : '/zavod-kochirish')
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-kochirish" label={t('production.transfers.title')} />
      <PageHeader title={t('production.transfers.newTitle')} />
      <DraftBanner offer={draft.offer} onRestore={draft.restore} onDiscard={draft.discard} />

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
          <span className={prodLabelCls}>{t('production.transfers.from')}</span>
          <select data-autofocus value={sourceId} onChange={e => changeFrom(e.target.value)} className={prodFieldCls}>
            <option value="">{t('production.transfers.selectFrom')}</option>
            {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('production.transfers.to')}</span>
          <select
            value={toId}
            onChange={e => setToId(e.target.value)}
            className={cn(prodFieldCls, same && 'border-red-300 dark:border-red-800')}
          >
            <option value="">{t('production.transfers.selectTo')}</option>
            {activeWarehouses.map(w => <option key={w.id} value={w.id} disabled={w.id === sourceId}>{w.name}</option>)}
          </select>
          {same && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{t('production.transfers.sameWarehouse')}</p>}
        </label>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.transfers.items')}</h2>
          <div className="w-full sm:w-80">
            {!sourceId ? (
              <DisabledSelect placeholder={t('production.transfers.chooseFromFirst')} />
            ) : stockLoading ? (
              <div className="flex h-9 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
            ) : (
              <SearchSelect
                options={itemOptions}
                value=""
                onChange={id => {
                  if (lines.length >= MAX_LINES) return
                  const base = itemById.get(id)?.unit ?? 'pcs'
                  setLines(prev => [...prev, { itemId: id, value: '', unit: base }])
                }}
                placeholder={itemOptions.length ? t('production.transfers.addItem') : t('production.common.noStock')}
              />
            )}
          </div>
        </div>
        {computed.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.transfers.noItems')}</div>
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
                          mode="pick"
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
          { label: t('production.transfers.itemsCount'), value: String(computed.length) },
          { label: t('production.transfers.totalQty'), value: groups(sumByUnitGroup(computed.map(c => ({ qty: c.qty, unit: c.base })))) },
          { label: t('production.common.total'), value: formatPrice(total), strong: true },
        ]} />
      </div>

      <FormFooter onCancel={() => router.push('/zavod-kochirish')} onSave={save} saving={saving} disabled={!valid} total={{ label: t('production.common.total'), value: formatPrice(total) }} />
      {approval.dialog}
    </div>
  )
}
