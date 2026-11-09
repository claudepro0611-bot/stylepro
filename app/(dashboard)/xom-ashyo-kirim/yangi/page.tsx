'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useSession } from '@/lib/session/SessionContext'
import { withDefaultPermissions, type Permissions } from '@/lib/permissions'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, DisabledSelect, FormFooter, NoteField, PageHeader, TotalsBox,
  prodCardCls, prodFieldCls, prodLabelCls,
} from '@/components/production/ProdKit'
import { useProdRefs, useWarehouseStock } from '@/components/production/useProdRefs'
import { SupplierFormDialog, useProdSuppliers } from '@/components/production/SupplierKit'
import { formatQty, localDateTimeToIso, nowHm, parseDecimal, prodErrorKey, round2, round3, unitKey } from '@/lib/production'

interface Line { itemId: string; qty: string; price: string }

export default function NewReceiptPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { items, warehouses, itemById } = useProdRefs()
  const { suppliers, reload: reloadSuppliers } = useProdSuppliers()
  const { profile } = useSession()
  // Quick-create needs the prod_suppliers permission (the RPC re-checks).
  const canCreateSupplier = profile?.role === 'owner'
    || withDefaultPermissions(profile?.permissions as Partial<Permissions> | null).prod_suppliers

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [supplierFormOpen, setSupplierFormOpen] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Current stock is shown next to each line for context only.
  const { stock } = useWarehouseStock(warehouseId)

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

  const activeWarehouses = warehouses.filter(w => w.isActive)

  const supplierOptions = useMemo(() => [
    { value: '', label: t('production.suppliers.noSupplier') },
    ...suppliers
      .filter(s => s.isActive)
      .map(s => ({ value: s.id, label: s.name, sublabel: `${t('production.suppliers.debt')}: ${formatPrice(s.debt)}` })),
  ], [suppliers, t, formatPrice])

  const itemOptions = useMemo(() => items
    .filter(i => i.isActive && !lines.some(l => l.itemId === i.id))
    // Raw materials and packaging first: that is what usually arrives.
    .sort((a, b) => Number(b.itemType === 'raw' || b.itemType === 'packaging') - Number(a.itemType === 'raw' || a.itemType === 'packaging'))
    .map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) })), [items, lines, t])

  const computed = lines.map(l => {
    const q = parseDecimal(l.qty)
    const p = parseDecimal(l.price)
    return { ...l, qtyNum: q, priceNum: p, total: round2(q * p) }
  })
  const total = round2(computed.reduce((s, c) => s + c.total, 0))
  const totalQtyLines = computed.length

  const valid = !!warehouseId && computed.length > 0 && computed.every(c => c.qtyNum > 0)

  function setLine(itemId: string, patch: Partial<Line>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...patch } : l)))
  }

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_create_receipt', {
      p_data: {
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        supplier_id: supplierId || null,
        supplier_name: null,
        note: note.trim() || null,
        items: computed.map(c => ({ item_id: c.itemId, qty: round3(c.qtyNum), price: round2(c.priceNum) })),
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error.message))); return }
    const id = (data as { id?: string } | null)?.id
    toast.success(t('production.common.saved'))
    router.push(id ? `/xom-ashyo-kirim/${id}` : '/xom-ashyo-kirim')
  }

  return (
    <div className="space-y-5 max-w-5xl">
      <BackLink href="/xom-ashyo-kirim" label={t('production.receipts.title')} />
      <PageHeader title={t('production.receipts.newTitle')} />

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4')}>
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
            <option value="">{t('production.common.selectWarehouse')}</option>
            {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <div>
          <span className={prodLabelCls}>{t('production.suppliers.supplier')}</span>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchSelect options={supplierOptions} value={supplierId} onChange={setSupplierId} placeholder={t('production.suppliers.selectSupplier')} />
            </div>
            {canCreateSupplier && (
              <button
                type="button"
                onClick={() => setSupplierFormOpen(true)}
                title={t('production.suppliers.new')}
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" /> {t('production.suppliers.quickNew')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.receipts.items')}</h2>
          <div className="w-full sm:w-80">
            {warehouseId ? (
              <SearchSelect
                options={itemOptions}
                value=""
                onChange={id => setLines(prev => [...prev, { itemId: id, qty: '', price: '' }])}
                placeholder={t('production.receipts.addItem')}
              />
            ) : (
              <DisabledSelect placeholder={t('production.common.chooseWarehouseFirst')} />
            )}
          </div>
        </div>
        {computed.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.receipts.noItems')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.stockLeft')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-40">{t('production.common.qty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-44">{t('production.common.price')}</th>
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
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(stock.get(c.itemId)?.qty ?? 0)} {unit}</td>
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
        <div className={cn(prodCardCls, 'p-6')}>
          <NoteField value={note} onChange={setNote} />
        </div>
        <TotalsBox rows={[
          { label: t('production.receipts.lines'), value: String(totalQtyLines) },
          { label: t('production.common.total'), value: formatPrice(total), strong: true },
        ]} />
      </div>

      <FormFooter onCancel={() => router.push('/xom-ashyo-kirim')} onSave={save} saving={saving} disabled={!valid} />

      <SupplierFormDialog
        open={supplierFormOpen}
        onOpenChange={setSupplierFormOpen}
        supplier={null}
        onSaved={async newId => {
          setSupplierFormOpen(false)
          await reloadSuppliers()
          if (newId) setSupplierId(newId)
        }}
      />
    </div>
  )
}
