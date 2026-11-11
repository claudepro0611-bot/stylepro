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
  BackLink, DisabledSelect, FormFooter, MoreFields, NoteField, PageHeader, TotalsBox,
  prodCardCls, prodFieldCls, prodLabelCls, useRememberedDefault,
} from '@/components/production/ProdKit'
import { ControlHint, DocDateInput, useApprovalRetry, useControls, useProdErrorText } from '@/components/production/ControlKit'
import { Term } from '@/components/production/Term'
import { DraftBanner } from '@/components/production/DraftBanner'
import { useFormDraft } from '@/lib/useFormDraft'
import { useProdRefs, useWarehouseLots, useWarehouseStock } from '@/components/production/useProdRefs'
import { SupplierFormDialog, useProdSuppliers } from '@/components/production/SupplierKit'
import { VatRateInput, defaultVatRate, useAccounting } from '@/components/production/AccountingKit'
import { formatQty, localDateTimeToIso, nowHm, parseDecimal, round2, round3, unitKey, type ProdRpcError } from '@/lib/production'
import { acctErrorText, parseVatRate, vatSplit } from '@/lib/production-accounting'

/**
 * expiry: optional "YYYY-MM-DD"; empty = the item's shelf life (server side).
 * vatRate: the line's VAT % as typed (migration 20261110000018).
 */
interface Line { itemId: string; qty: string; price: string; expiry: string; vatRate: string }

export default function NewReceiptPage() {
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const controls = useControls()
  const controlErrorText = useProdErrorText()
  const accounting = useAccounting()
  // VAT fields only once the accounting migration is applied.
  const vatOn = accounting.available
  const errorText = (err: ProdRpcError) => (vatOn ? acctErrorText(t, err) : controlErrorText(err))
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
  const [pricesIncludeVat, setPricesIncludeVat] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Local draft (useFormDraft): autosaved 2 s after a change, offered when the form opens.
  const draftState = { date, time, warehouseId, supplierId, lines, pricesIncludeVat, note }
  const draft = useFormDraft('receipt', draftState, (d: typeof draftState) => {
    setDate(d.date); setTime(d.time); setWarehouseId(d.warehouseId); setSupplierId(d.supplierId); setLines(d.lines); setPricesIncludeVat(d.pricesIncludeVat); setNote(d.note)
  }, { isEmpty: d => !d.supplierId && d.lines.length === 0 && !d.note })

  // Current stock is shown next to each line for context only.
  const { stock } = useWarehouseStock(warehouseId)
  // Lots (and so per-line expiry) only exist once the lots migration is applied.
  const { available: lotsAvailable } = useWarehouseLots(warehouseId)

  // Client clock only (avoids a server/client hydration mismatch).
  useEffect(() => { setDate(localYmd()); setTime(nowHm()) }, [])

  const activeWarehouses = warehouses.filter(w => w.isActive)
  // Last used warehouse / supplier of this user.
  const rememberWarehouse = useRememberedDefault('receipt-warehouse', activeWarehouses.map(w => w.id), warehouseId, setWarehouseId)
  const rememberSupplier = useRememberedDefault('receipt-supplier', suppliers.filter(s => s.isActive).map(s => s.id), supplierId, setSupplierId)

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
    const rate = vatOn ? parseVatRate(l.vatRate) : 0
    const split = vatSplit(q, p, rate ?? 0, pricesIncludeVat)
    return { ...l, qtyNum: q, priceNum: p, rate, rateBad: rate === null, ...split, total: split.gross }
  })
  const total = round2(computed.reduce((s, c) => s + c.total, 0))
  const totalVat = round2(computed.reduce((s, c) => s + c.vat, 0))
  const totalNet = round2(total - totalVat)
  const totalQtyLines = computed.length

  const valid = !!warehouseId && computed.length > 0 && computed.every(c => c.qtyNum > 0 && !c.rateBad)
  // Controls (migration 20261110000017): raw-item lines with price 0 or a raw
  // receipt without a supplier need owner / admin approval (warned, not blocked).
  const hasRaw = computed.some(c => itemById.get(c.itemId)?.itemType === 'raw')
  const rawZeroPrice = computed.some(c => itemById.get(c.itemId)?.itemType === 'raw' && c.qtyNum > 0 && !(c.priceNum > 0))
  const rawNoSupplier = hasRaw && !supplierId

  function setLine(itemId: string, patch: Partial<Line>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...patch } : l)))
  }

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const res = await approval.run(ctl => createClient().rpc('prod_create_receipt', {
      p_data: {
        ...ctl,
        doc_date: localDateTimeToIso(date, time),
        warehouse_id: warehouseId,
        supplier_id: supplierId || null,
        supplier_name: null,
        note: note.trim() || null,
        ...(vatOn ? { prices_include_vat: pricesIncludeVat } : {}),
        items: computed.map(c => ({
          item_id: c.itemId,
          qty: round3(c.qtyNum),
          price: round2(c.priceNum),
          ...(lotsAvailable && c.expiry ? { expiry_date: c.expiry } : {}),
          ...(vatOn ? { vat_rate: c.rate ?? 0 } : {}),
        })),
      },
    }))
    setSaving(false)
    if (!res) return
    const { data, error } = res
    if (error) { toast.error(errorText(error)); return }
    rememberWarehouse(warehouseId)
    rememberSupplier(supplierId)
    const id = (data as { id?: string } | null)?.id
    draft.clear()
    toast.success(t('production.common.saved'))
    router.push(id ? `/xom-ashyo-kirim/${id}` : '/xom-ashyo-kirim')
  }

  return (
    <div className="space-y-5">
      <BackLink href="/xom-ashyo-kirim" label={t('production.receipts.title')} />
      <PageHeader title={t('production.receipts.newTitle')} />
      <DraftBanner offer={draft.offer} onRestore={draft.restore} onDiscard={draft.discard} />

      <div className={cn(prodCardCls, 'p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4')}>
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
            <option value="">{t('production.common.selectWarehouse')}</option>
            {activeWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <div data-autofocus>
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
        <MoreFields className="sm:col-span-2 lg:col-span-4" active={!!note}>
          <NoteField value={note} onChange={setNote} />
        </MoreFields>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100"><Term k="partiya">{t('production.receipts.items')}</Term></h2>
            {vatOn && (
              <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-gray-700 dark:text-gray-300" title={t('prodAcct.vat.pricesIncludeHint')}>
                <input
                  type="checkbox"
                  checked={pricesIncludeVat}
                  onChange={e => setPricesIncludeVat(e.target.checked)}
                  className="h-3.5 w-3.5 accent-slate-900 dark:accent-gray-100"
                />
                {t('prodAcct.vat.pricesInclude')}
              </label>
            )}
          </div>
          <div className="w-full sm:w-80">
            {warehouseId ? (
              <SearchSelect
                options={itemOptions}
                value=""
                onChange={id => setLines(prev => [...prev, { itemId: id, qty: '', price: '', expiry: '', vatRate: String(defaultVatRate(accounting.settings.vatPayer)) }])}
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
                  {lotsAvailable && <th className="px-4 py-2.5 text-left font-medium w-44">{t('production.receipts.expiry')}</th>}
                  {vatOn && <th className="px-4 py-2.5 text-left font-medium w-36">{t('prodAcct.vat.rate')}</th>}
                  <th className="px-4 py-2.5 text-right font-medium">{vatOn ? t('prodAcct.vat.gross') : t('production.common.total')}</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map((c, i) => {
                  const item = itemById.get(c.itemId)
                  const unit = item ? t(unitKey(item.unit)) : ''
                  return (
                    <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{item?.name ?? '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(stock.get(c.itemId)?.qty ?? 0)} {unit}</td>
                      <td className="px-4 py-2">
                        <input autoFocus={i === computed.length - 1 && c.qty === ''} inputMode="decimal" value={c.qty} onChange={e => setLine(c.itemId, { qty: e.target.value })} placeholder="0" className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                      </td>
                      <td className="px-4 py-2">
                        <input inputMode="decimal" value={c.price} onChange={e => setLine(c.itemId, { price: e.target.value })} placeholder="0" className={cn(prodFieldCls, 'h-8 text-right tabular-nums')} />
                      </td>
                      {lotsAvailable && (
                        <td className="px-4 py-2">
                          <input
                            type="date"
                            value={c.expiry}
                            onChange={e => setLine(c.itemId, { expiry: e.target.value })}
                            min={date || undefined}
                            title={t('production.receipts.expiryHint')}
                            className={cn(prodFieldCls, 'h-8 tabular-nums')}
                          />
                          {!c.expiry && item?.shelfLifeDays != null && (
                            <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{t('production.receipts.expiryAuto')}: {item.shelfLifeDays} {t('production.receipts.days')}</p>
                          )}
                        </td>
                      )}
                      {vatOn && (
                        <td className="px-4 py-2">
                          <VatRateInput value={c.vatRate} onChange={v => setLine(c.itemId, { vatRate: v })} invalid={c.rateBad} />
                        </td>
                      )}
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                        {formatPrice(c.total)}
                        {vatOn && c.vat > 0 && (
                          <p className="text-[11px] font-normal text-gray-400 dark:text-gray-500">
                            {t('prodAcct.vat.net')} {formatPrice(c.net)} · {t('prodAcct.vat.vat')} {formatPrice(c.vat)}
                          </p>
                        )}
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

      {controls.available && (rawZeroPrice || rawNoSupplier) && (
        <div className="space-y-2">
          {rawNoSupplier && <ControlHint>{t('prodControls.hints.receiptNoSupplier')}</ControlHint>}
          {rawZeroPrice && <ControlHint>{t('prodControls.hints.receiptZeroPrice')}</ControlHint>}
        </div>
      )}

      <div className="lg:ml-auto lg:w-full lg:max-w-md">
        <TotalsBox rows={[
          { label: t('production.receipts.lines'), value: String(totalQtyLines) },
          ...(vatOn ? [
            { label: t('prodAcct.vat.totalNet'), value: formatPrice(totalNet) },
            { label: t('prodAcct.vat.totalVat'), value: formatPrice(totalVat) },
          ] : []),
          { label: vatOn ? t('prodAcct.vat.totalGross') : t('production.common.total'), value: formatPrice(total), strong: true },
        ]} />
        {vatOn && totalVat > 0 && (
          <p className="mt-1.5 px-1 text-[11px] text-gray-400 dark:text-gray-500">
            {t(accounting.settings.vatPayer ? 'prodAcct.vat.deductible' : 'prodAcct.vat.notDeductible')}
          </p>
        )}
      </div>

      <FormFooter
        onCancel={() => router.push('/xom-ashyo-kirim')}
        onSave={save}
        saving={saving}
        disabled={!valid}
        total={{ label: t('production.common.total'), value: formatPrice(total) }}
      />

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
      {approval.dialog}
    </div>
  )
}
