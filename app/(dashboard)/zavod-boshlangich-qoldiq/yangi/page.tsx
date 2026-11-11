'use client'

// New opening balance: one warehouse, lines (item, qty, unit cost, fat,
// protein, expiry, supplier); every line becomes a lot. Posts through
// prod_create_opening only.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, DisabledSelect, FormFooter, NoteField, PageHeader, TotalsBox, prodCardCls, prodFieldCls, prodLabelCls,
} from '@/components/production/ProdKit'
import { UnitQtyInput, entryToBase, useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useProdSuppliers } from '@/components/production/SupplierKit'
import { NotAvailableNote, useInventoryDocs } from '@/components/production/InventoryKit'
import {
  localDateTimeToIso, nowHm, prodErrorKey, round2, round3, sumByUnitGroup,
  type EntryUnit,
} from '@/lib/production'
import { INVENTORY_MAX_LINES, parseMoneyOrNull } from '@/lib/inventory'

interface Line {
  key: string
  itemId: string
  value: string
  unit: EntryUnit
  cost: string
  fat: string
  protein: string
  expiry: string
  supplierId: string
}

let seq = 0
const nextKey = () => `o${++seq}`

/** '' -> null; 0..100 (3 decimals); undefined = invalid. */
function parsePct(v: string): number | null | undefined {
  const s = v.replace(',', '.').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? round3(n) : undefined
}

export default function NewOpeningPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useInventoryDocs()
  const { groups } = useQtyFormat()
  const { items, warehouses, itemById } = useProdRefs()
  const { suppliers } = useProdSuppliers()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDate(localYmd())
    setTime(nowHm())
  }, [])

  const activeWarehouses = warehouses.filter(w => w.isActive)
  const itemOptions = useMemo(() => items.filter(i => i.isActive).map(i => ({ value: i.id, label: i.name, sublabel: i.sku || undefined })), [items])

  const computed = lines.map(l => {
    const item = itemById.get(l.itemId)
    const base = item?.unit ?? 'pcs'
    const qty = round3(entryToBase(l.value, base, l.unit))
    const cost = parseMoneyOrNull(l.cost)
    const fat = parsePct(l.fat)
    const protein = parsePct(l.protein)
    const total = qty > 0 && cost != null ? round2(qty * cost) : 0
    const ok = qty > 0 && cost != null && fat !== undefined && protein !== undefined
    return { ...l, item, base, qty, costNum: cost, fatNum: fat, proteinNum: protein, total, ok }
  })
  const total = round2(computed.reduce((s, c) => s + c.total, 0))
  const valid = !!warehouseId && computed.length > 0 && computed.length <= INVENTORY_MAX_LINES && computed.every(c => c.ok)

  function patch(key: string, p: Partial<Line>) {
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...p } : l)))
  }

  async function save() {
    if (!valid) { toast.error(t('prodInventory.openings.qtyCostError')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_create_opening', {
      p_data: {
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        note: note.trim() || null,
        items: computed.map(c => ({
          item_id: c.itemId,
          qty: c.qty,
          unit_cost: c.costNum,
          fat_pct: c.fatNum,
          protein_pct: c.proteinNum,
          expiry_date: c.expiry || null,
          supplier_id: c.supplierId || null,
        })),
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    const id = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(id ? `/zavod-boshlangich-qoldiq/${id}` : '/zavod-boshlangich-qoldiq')
  }

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-boshlangich-qoldiq" label={t('prodInventory.openings.title')} />
        <NotAvailableNote />
      </div>
    )
  }

  const smallField = cn(prodFieldCls, 'h-8 text-right tabular-nums')

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-boshlangich-qoldiq" label={t('prodInventory.openings.title')} />
      <PageHeader title={t('prodInventory.openings.newTitle')} subtitle={t('prodInventory.openings.lotHint')} />

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-1 md:grid-cols-3 gap-4')}>
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
          <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={prodFieldCls}>
            <option value="">{t('prodInventory.common.selectWarehouse')}</option>
            {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodInventory.common.linesTitle')}</h2>
          <div className="w-full sm:w-80">
            {!warehouseId ? (
              <DisabledSelect placeholder={t('prodInventory.common.chooseWarehouseFirst')} />
            ) : (
              <SearchSelect
                options={itemOptions}
                value=""
                onChange={id => {
                  if (lines.length >= INVENTORY_MAX_LINES) return
                  const base = itemById.get(id)?.unit ?? 'pcs'
                  setLines(prev => [...prev, { key: nextKey(), itemId: id, value: '', unit: base, cost: '', fat: '', protein: '', expiry: '', supplierId: '' }])
                }}
                placeholder={t('prodInventory.common.addItem')}
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
                  <th className="px-3 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-3 py-2.5 text-right font-medium w-48">{t('production.common.qty')}</th>
                  <th className="px-3 py-2.5 text-right font-medium w-32">{t('production.lots.unitCost')}</th>
                  <th className="px-3 py-2.5 text-right font-medium w-24">{t('prodInventory.openings.fat')}</th>
                  <th className="px-3 py-2.5 text-right font-medium w-24">{t('prodInventory.openings.protein')}</th>
                  <th className="px-3 py-2.5 text-left font-medium w-40" title={t('prodInventory.openings.expiryHint')}>{t('prodInventory.openings.expiry')}</th>
                  <th className="px-3 py-2.5 text-left font-medium w-44">{t('prodInventory.openings.supplier')}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t('production.common.total')}</th>
                  <th className="px-3 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map(c => (
                  <tr key={c.key} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{c.item?.name ?? '—'}</td>
                    <td className="px-3 py-2">
                      <UnitQtyInput
                        value={c.value}
                        onChange={v => patch(c.key, { value: v })}
                        base={c.base}
                        unit={c.unit}
                        onUnitChange={(u, v) => patch(c.key, { unit: u, value: v })}
                        invalid={c.value.trim() !== '' && !(c.qty > 0)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input inputMode="decimal" value={c.cost} onChange={e => patch(c.key, { cost: e.target.value })} placeholder="0" className={cn(smallField, c.costNum === undefined && 'border-red-300 dark:border-red-800')} />
                    </td>
                    <td className="px-3 py-2">
                      <input inputMode="decimal" value={c.fat} onChange={e => patch(c.key, { fat: e.target.value })} placeholder="—" className={cn(smallField, c.fatNum === undefined && 'border-red-300 dark:border-red-800')} />
                    </td>
                    <td className="px-3 py-2">
                      <input inputMode="decimal" value={c.protein} onChange={e => patch(c.key, { protein: e.target.value })} placeholder="—" className={cn(smallField, c.proteinNum === undefined && 'border-red-300 dark:border-red-800')} />
                    </td>
                    <td className="px-3 py-2">
                      <input type="date" value={c.expiry} onChange={e => patch(c.key, { expiry: e.target.value })} title={t('prodInventory.openings.expiryHint')} className={cn(prodFieldCls, 'h-8')} />
                    </td>
                    <td className="px-3 py-2">
                      <select value={c.supplierId} onChange={e => patch(c.key, { supplierId: e.target.value })} className={cn(prodFieldCls, 'h-8')}>
                        <option value="">{t('prodInventory.openings.noSupplier')}</option>
                        {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(c.total)}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setLines(prev => prev.filter(l => l.key !== c.key))}
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
        <div className={cn(prodCardCls, 'p-6')}>
          <NoteField value={note} onChange={setNote} />
        </div>
        <TotalsBox rows={[
          { label: t('prodInventory.common.itemsCount'), value: String(computed.length) },
          { label: t('prodInventory.common.totalQty'), value: groups(sumByUnitGroup(computed.map(c => ({ qty: c.qty, unit: c.base })))) },
          { label: t('production.common.total'), value: formatPrice(total), strong: true },
        ]} />
      </div>

      <FormFooter onCancel={() => router.push('/zavod-boshlangich-qoldiq')} onSave={save} saving={saving} disabled={!valid || available !== true} />
    </div>
  )
}
