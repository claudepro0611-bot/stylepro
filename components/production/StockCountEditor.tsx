'use client'

// Inventarizatsiya editor (/zavod-inventarizatsiya/yangi and a draft's
// /zavod-inventarizatsiya/[id]). "Load current stock" fills the lines with
// the warehouse's current qty; the user types the counted qty and sees the
// difference live. Writes: prod_save_stock_count (draft, lines replaced),
// prod_post_stock_count, prod_delete_stock_count_draft. System qty is
// re-read by the server at posting, so the preview is indicative.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardList, Download, Loader2, Search, Trash2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, NoteField, PageHeader, TotalsBox, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls,
} from '@/components/production/ProdKit'
import { CountStatusBadge } from '@/components/production/InventoryKit'
import { DocDateInput, useApprovalRetry, useProdErrorText } from '@/components/production/ControlKit'
import { Term } from '@/components/production/Term'
import { DraftBanner } from '@/components/production/DraftBanner'
import { useFormDraft } from '@/lib/useFormDraft'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import {
  fetchProdStock, formatQty, localDateTimeToIso, nowHm, prodErrorKey, round2, round3, toInputString, unitKey,
  type ProdStockRow,
} from '@/lib/production'
import { STOCK_COUNT_MAX_LINES, parseMoneyOrNull, parseQtyOrNull } from '@/lib/inventory'

export interface CountDraft {
  id: string
  number: number
  docDate: string
  warehouseId: string
  note: string
  lines: { itemId: string; counted: number; unitCost: number | null }[]
}

interface Line { itemId: string; counted: string; unitCost: string }

const pad = (n: number) => String(n).padStart(2, '0')

export function StockCountEditor({ draft }: { draft?: CountDraft }) {
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { items, warehouses, itemById, warehouseById } = useProdRefs()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState(draft?.warehouseId ?? '')
  const [note, setNote] = useState(draft?.note ?? '')
  const [lines, setLines] = useState<Line[]>(() => (draft?.lines ?? []).map(l => ({
    itemId: l.itemId, counted: l.counted === 0 ? '0' : toInputString(l.counted), unitCost: l.unitCost === null ? '' : String(l.unitCost),
  })))
  const [stock, setStock] = useState<Map<string, ProdStockRow>>(new Map())
  const [stockLoading, setStockLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [onlyDiff, setOnlyDiff] = useState(false)
  const [busy, setBusy] = useState<'save' | 'post' | 'delete' | null>(null)

  // Local draft (useFormDraft) on top of the server draft: unsaved edits survive a reload.
  const draftState = { date, time, warehouseId, note, lines }
  const localDraft = useFormDraft(`stock-count:${draft?.id ?? 'new'}`, draftState, (d: typeof draftState) => {
    setDate(d.date); setTime(d.time); setWarehouseId(d.warehouseId); setNote(d.note); setLines(d.lines)
  }, { ready: date !== '', isEmpty: d => !draft && d.lines.length === 0 && !d.note })

  useEffect(() => {
    if (draft) {
      const d = new Date(draft.docDate)
      setDate(localYmd(d))
      setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
    } else {
      setDate(localYmd())
      setTime(nowHm())
      setWarehouseId(new URLSearchParams(window.location.search).get('warehouse') ?? '')
    }
  }, [draft])

  // Current stock (non-zero rows, negatives included) of the chosen warehouse.
  useEffect(() => {
    if (!warehouseId) { setStock(new Map()); return }
    let cancelled = false
    setStockLoading(true)
    fetchProdStock(createClient(), { warehouseId }).then(rows => {
      if (cancelled) return
      setStock(new Map(rows.map(r => [r.itemId, r])))
      setStockLoading(false)
    })
    return () => { cancelled = true }
  }, [warehouseId])

  const activeWarehouses = warehouses.filter(w => w.isActive || w.id === warehouseId)

  const computed = lines.map(l => {
    const item = itemById.get(l.itemId)
    const s = stock.get(l.itemId)
    const system = s?.qty ?? 0
    const avg = s && s.qty > 0 ? s.avgCost : 0
    const countedQty = parseQtyOrNull(l.counted)
    const costNum = parseMoneyOrNull(l.unitCost)
    const diff = countedQty == null ? null : round3(countedQty - system)
    const unitCost = diff !== null && diff > 0 && costNum != null ? costNum : avg
    const value = diff === null ? 0 : round2(diff * unitCost)
    return { ...l, item, system, avg, countedQty, costNum, diff, value, invalid: countedQty === undefined || costNum === undefined }
  })

  const shortage = round2(computed.reduce((s, c) => s + (c.value < 0 ? -c.value : 0), 0))
  const surplus = round2(computed.reduce((s, c) => s + (c.value > 0 ? c.value : 0), 0))
  const uncounted = computed.filter(c => c.countedQty === null).length
  const canSave = !!warehouseId && computed.length > 0 && computed.length <= STOCK_COUNT_MAX_LINES
    && uncounted === 0 && computed.every(c => !c.invalid)

  const q = search.trim().toLowerCase()
  const visible = computed.filter(c => (!q || (c.item?.name ?? '').toLowerCase().includes(q) || (c.item?.sku ?? '').toLowerCase().includes(q))
    && (!onlyDiff || (c.diff !== null && c.diff !== 0)))

  const itemOptions = useMemo(() => items
    .filter(i => i.isActive && !lines.some(l => l.itemId === i.id))
    .map(i => ({
      value: i.id,
      label: i.name,
      sublabel: `${t('prodInventory.counts.systemQty')}: ${formatQty(stock.get(i.id)?.qty ?? 0)} ${t(unitKey(i.unit))}`,
    })), [items, lines, stock, t])

  function loadStock() {
    if (lines.length > 0 && !window.confirm(t('prodInventory.counts.loadStockConfirm'))) return
    const rows = [...stock.values()]
      .filter(r => itemById.has(r.itemId))
      .sort((a, b) => (itemById.get(a.itemId)?.name ?? '').localeCompare(itemById.get(b.itemId)?.name ?? ''))
    if (rows.length === 0) { toast.error(t('prodInventory.counts.stockEmpty')); return }
    setLines(rows.slice(0, STOCK_COUNT_MAX_LINES).map(r => ({ itemId: r.itemId, counted: '', unitCost: '' })))
  }

  function fillSystem() {
    setLines(prev => prev.map(l => {
      if (l.counted.trim() !== '') return l
      const q = Math.max(0, stock.get(l.itemId)?.qty ?? 0)
      return { ...l, counted: q > 0 ? String(round3(q)) : '0' }
    }))
  }

  function patch(itemId: string, p: Partial<Line>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...p } : l)))
  }

  async function persist(): Promise<string | null> {
    if (!canSave) { toast.error(t(uncounted > 0 ? 'prodInventory.counts.uncountedError' : 'productionErrors.invalid_input')); return null }
    const { data, error } = await createClient().rpc('prod_save_stock_count', {
      p_id: draft?.id ?? null,
      p_data: {
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        note: note.trim() || null,
        items: computed.map(c => ({ item_id: c.itemId, counted_qty: c.countedQty as number, unit_cost: c.costNum ?? null })),
      },
    })
    if (error) { toast.error(t(prodErrorKey(error))); return null }
    localDraft.clear()
    return typeof data === 'string' ? data : draft?.id ?? null
  }

  async function saveDraft() {
    setBusy('save')
    const id = await persist()
    setBusy(null)
    if (!id) return
    toast.success(t('prodInventory.counts.draftSaved'))
    if (!draft) router.replace(`/zavod-inventarizatsiya/${id}`)
  }

  async function post() {
    if (!canSave) { toast.error(t(uncounted > 0 ? 'prodInventory.counts.uncountedError' : 'productionErrors.invalid_input')); return }
    if (!window.confirm(t('prodInventory.counts.postConfirm'))) return
    setBusy('post')
    const id = await persist()
    if (!id) { setBusy(null); return }
    // Override keys go in p_ctl (migration 20261110000017); the plain { p_id } call keeps working before it.
    const res = await approval.run(ctl => ctl
      ? createClient().rpc('prod_post_stock_count', { p_id: id, p_ctl: { ...ctl } })
      : createClient().rpc('prod_post_stock_count', { p_id: id }))
    setBusy(null)
    if (!res || res.error) {
      if (res?.error) toast.error(errorText(res.error))
      if (!draft) router.replace(`/zavod-inventarizatsiya/${id}`)
      return
    }
    toast.success(t('prodInventory.counts.posted'))
    if (draft) window.location.reload()
    else router.replace(`/zavod-inventarizatsiya/${id}`)
  }

  async function deleteDraft() {
    if (!draft || !window.confirm(t('prodInventory.counts.deleteConfirm'))) return
    setBusy('delete')
    const { error } = await createClient().rpc('prod_delete_stock_count_draft', { p_id: draft.id })
    setBusy(null)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('prodInventory.counts.deleted'))
    router.push('/zavod-inventarizatsiya')
  }

  const whName = warehouseById.get(warehouseId)?.name ?? '—'

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/zavod-inventarizatsiya" label={t('prodInventory.counts.title')} />
      <DraftBanner offer={localDraft.offer} onRestore={localDraft.restore} onDiscard={localDraft.discard} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PageHeader title={draft ? `${t('prodInventory.counts.docTitle')} #${draft.number}` : t('prodInventory.counts.newTitle')} />
          <Term k="inventarizatsiya" bare />
          {draft && <CountStatusBadge status="draft" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lines.length > 0 && <PrintButton label={t('prodInventory.counts.printSheet')} />}
          {draft && (
            <Button variant="outline" onClick={deleteDraft} loading={busy === 'delete'} disabled={!!busy} className="text-red-600 dark:text-red-400">
              <Trash2 className="h-3.5 w-3.5" /> {t('prodInventory.counts.deleteDraft')}
            </Button>
          )}
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-1 md:grid-cols-3 gap-4')}>
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
          <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={prodFieldCls}>
            <option value="">{t('prodInventory.common.selectWarehouse')}</option>
            {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="mr-auto text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('prodInventory.common.linesTitle')}
            {computed.length > 0 && <span className="ml-1.5 font-normal text-gray-400">{computed.length}</span>}
          </h2>
          <button type="button" onClick={loadStock} disabled={!warehouseId || stockLoading} className={cn(secondaryBtnCls, 'disabled:opacity-50')}>
            {stockLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {t('prodInventory.counts.loadStock')}
          </button>
          {uncounted > 0 && (
            <button type="button" onClick={fillSystem} className={secondaryBtnCls}>{t('prodInventory.counts.fillSystem')}</button>
          )}
          <div className="w-full sm:w-72">
            {warehouseId ? (
              <SearchSelect
                options={itemOptions}
                value=""
                onChange={id => { if (lines.length < STOCK_COUNT_MAX_LINES) setLines(prev => [...prev, { itemId: id, counted: '', unitCost: '' }]) }}
                placeholder={t('prodInventory.common.addItem')}
              />
            ) : (
              <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodInventory.common.chooseWarehouseFirst')}</p>
            )}
          </div>
        </div>
        {computed.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-2.5">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('production.common.searchItem')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
              <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" />
              {t('prodInventory.counts.onlyDiff')}
            </label>
            <span className="ml-auto text-[12px] text-gray-400 dark:text-gray-500">{t('prodInventory.counts.liveHint')}</span>
          </div>
        )}
        {computed.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
            <ClipboardList className="h-6 w-6" />
            {t('prodInventory.common.noItems')}
          </div>
        ) : (
          <div className="max-h-[65vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-gray-900">
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.systemQty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-40">{t('prodInventory.counts.countedQty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.diffQty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-36" title={t('prodInventory.counts.costHint')}>{t('prodInventory.counts.unitCost')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.counts.diffValue')}</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {visible.map(c => {
                  const unit = c.item ? t(unitKey(c.item.unit)) : ''
                  return (
                    <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                        {c.item?.name ?? '—'}
                        {c.item?.sku && <span className="ml-1.5 text-xs text-gray-400">{c.item.sku}</span>}
                      </td>
                      <td className={cn('px-4 py-2 text-right tabular-nums whitespace-nowrap', c.system < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>{formatQty(c.system)} {unit}</td>
                      <td className="px-4 py-2">
                        <input
                          inputMode="decimal"
                          value={c.counted}
                          onChange={e => patch(c.itemId, { counted: e.target.value })}
                          onFocus={e => e.target.select()}
                          placeholder="—"
                          className={cn(prodFieldCls, 'h-8 text-right tabular-nums', c.countedQty === undefined && 'border-red-300 dark:border-red-800')}
                        />
                      </td>
                      <td className={cn(
                        'px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium',
                        c.diff === null || c.diff === 0 ? 'text-gray-400 dark:text-gray-500' : c.diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
                      )}>
                        {c.diff === null ? '—' : `${c.diff > 0 ? '+' : ''}${formatQty(c.diff)} ${unit}`}
                      </td>
                      <td className="px-4 py-2">
                        <input
                          inputMode="decimal"
                          value={c.unitCost}
                          onChange={e => patch(c.itemId, { unitCost: e.target.value })}
                          placeholder={c.avg > 0 ? String(round2(c.avg)) : '0'}
                          title={t('prodInventory.counts.costHint')}
                          className={cn(prodFieldCls, 'h-8 text-right tabular-nums', c.costNum === undefined && 'border-red-300 dark:border-red-800')}
                        />
                      </td>
                      <td className={cn('px-4 py-2 text-right tabular-nums whitespace-nowrap', c.value < 0 ? 'text-red-600 dark:text-red-400' : c.value > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500')}>
                        {c.diff === null || c.value === 0 ? '—' : formatPrice(c.value)}
                      </td>
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
          { label: t('prodInventory.common.itemsCount'), value: String(computed.length) },
          { label: t('prodInventory.counts.shortage'), value: formatPrice(shortage), tone: shortage > 0 ? 'negative' : undefined },
          { label: t('prodInventory.counts.surplus'), value: formatPrice(surplus), tone: surplus > 0 ? 'positive' : undefined },
          { label: t('prodInventory.counts.net'), value: formatPrice(round2(surplus - shortage)), strong: true },
        ]} />
      </div>

      {uncounted > 0 && computed.length > 0 && (
        <p className="text-right text-[12px] text-amber-700 dark:text-amber-400">{t('prodInventory.counts.uncountedError')} ({uncounted})</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push('/zavod-inventarizatsiya')}>{t('production.common.cancel')}</Button>
        <Button variant="outline" onClick={saveDraft} loading={busy === 'save'} disabled={!!busy || !canSave}>{t('prodInventory.counts.saveDraft')}</Button>
        <Button onClick={post} loading={busy === 'post'} disabled={!!busy || !canSave}>{t('prodInventory.counts.post')}</Button>
      </div>
      {approval.dialog}
    </div>
    <PrintSheet
      title={t('prodInventory.counts.printTitle')}
      number={draft?.number}
      date={date ? localDateTimeToIso(date, time) : undefined}
      signatures={[t('prodInventory.print.responsible'), t('prodInventory.print.counter'), t('prodInventory.print.commission')]}
    >
      <PrintFields rows={[
        { label: t('production.common.warehouse'), value: whName },
        { label: t('production.common.status'), value: t('prodInventory.common.statusDraft') },
      ]} />
      <PrintTable
        columns={[
          { label: t('production.common.item') }, { label: t('production.common.unit') },
          { label: t('prodInventory.counts.systemQty'), right: true }, { label: t('prodInventory.counts.countedQty'), right: true },
          { label: t('prodInventory.counts.diffQty'), right: true },
        ]}
        // Counted / difference are left empty: the sheet is for counting on paper.
        rows={computed.map(c => [c.item?.name ?? '—', c.item ? t(unitKey(c.item.unit)) : '', formatQty(c.system), '', ''])}
      />
      {note && <p>{t('production.common.note')}: {note}</p>}
    </PrintSheet>
    </>
  )
}
