'use client'

// Yangi sotuv (nakladnoy): customer (balance, credit limit, overdue debt),
// warehouse, date, price list (defaults from the customer), VAT rate, vehicle,
// driver and lines with auto-filled prices, discount, FIFO cost preview and
// margin (owner/admin only), lot picks ('strict': free lots only). Saves
// through prod_create_sale; the server recomputes prices, VAT, cost and the
// credit warning.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import {
  BackLink, DisabledSelect, FieldError, FormFooter, MoreFields, NoteField, PageHeader, Segmented, TotalsBox,
  prodCardCls, prodFieldCls, prodLabelCls, useRememberedDefault,
} from '@/components/production/ProdKit'
import { DocDateInput, useApprovalRetry, useProdErrorText } from '@/components/production/ControlKit'
import { UnitQtyInput, entryToBase, useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs, useWarehouseLots, useWarehouseStock } from '@/components/production/useProdRefs'
import { LotPicker } from '@/components/production/LotPicker'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import {
  CreditWarningBanner, CustomerSummary, usePriceLists, useProdCustomers, useSalesAvailable, useSeesMargin,
} from '@/components/production/SalesKit'
import {
  activePicks, expiryWarnDaysOf, formatQty, isLotFree, lineAllocation, lineCost, localDateTimeToIso, makeLinePicks, nowHm,
  picksPayload, round2, round3, toInputString, unitKey, warehousesFor,
  type EntryUnit, type LinePicks,
} from '@/lib/production'
import {
  SALE_MAX_LINES, VAT_PRESETS, creditPreview, dueDateOf, formatMarginPct, lineAmount, marginPct, parseCreditWarning,
  resolvePrice, saleTotals, vatOf,
} from '@/lib/sales'

interface Line {
  itemId: string
  value: string
  unit: EntryUnit
  /** null = auto from the price list; a string once the user typed a price. */
  price: string | null
  discount: string
  picks?: LinePicks | null
}

type VatMode = '0' | '12' | 'custom'

const numIn = (v: string) => {
  const n = Number(v.replace(',', '.').replace(/\s/g, ''))
  return Number.isFinite(n) ? n : NaN
}

export default function NewSalePage() {
  const { t } = useLanguage()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { smart } = useQtyFormat()
  const available = useSalesAvailable()
  const seesMargin = useSeesMargin()
  const { items, warehouses, itemById } = useProdRefs()
  const { customers, ageing, loading: customersLoading } = useProdCustomers()
  const { lists } = usePriceLists()

  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [priceListId, setPriceListId] = useState('')
  const [vatMode, setVatMode] = useState<VatMode>('0')
  const [vatCustom, setVatCustom] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [driver, setDriver] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // Client clock and ?customer=<id> (from the customer card) only on the client.
  useEffect(() => {
    setDate(localYmd())
    setTime(nowHm())
    const c = new URLSearchParams(window.location.search).get('customer')
    if (c) setCustomerId(c)
  }, [])

  const customer = customers.find(c => c.id === customerId)
  // A new customer resets the list to "automatic" (= the customer's list, else
  // the default list, as prod_create_sale resolves it) and VAT to 12% for VAT payers.
  useEffect(() => {
    if (!customer) return
    setPriceListId('')
    setVatMode(customer.vatPayer ? '12' : '0')
  }, [customer])

  const saleWarehouses = warehousesFor(warehouses, ['finished'])
  const sourceId = saleWarehouses.some(w => w.id === warehouseId) ? warehouseId : ''
  // Last used warehouse of this user (a single option is chosen automatically).
  // The customer is deliberately NOT remembered: a pre-filled customer makes it
  // easy to post a sale to the wrong buyer.
  const rememberWarehouse = useRememberedDefault('sale-warehouse', saleWarehouses.map(w => w.id), warehouseId, setWarehouseId)
  const { stock, loading: stockLoading } = useWarehouseStock(sourceId)
  const { lotsOf, available: lotsAvailable } = useWarehouseLots(sourceId)

  const vatRate = vatMode === 'custom' ? numIn(vatCustom) : Number(vatMode)
  const vatOk = Number.isFinite(vatRate) && vatRate >= 0 && vatRate <= 100

  const priceOf = (itemId: string) => resolvePrice(itemId, {
    lists, saleListId: priceListId || null, customerListId: customer?.priceListId ?? null, item: itemById.get(itemId),
  })

  /** Free stock (held / blocked lots cannot be sold, 'strict'); prod_stock qty without lots. */
  const freeQty = (itemId: string) => {
    const lots = lotsOf(itemId)
    if (!lots) return stock.get(itemId)?.qty ?? 0
    return round3(lots.filter(isLotFree).reduce((s, l) => s + l.remainingQty, 0))
  }

  const customerListId = customer?.priceListId ?? null
  // Not wrapped in useMemo: the React Compiler memoizes this component.
  const itemOptions = items
    .filter(i => stock.has(i.id) && !lines.some(l => l.itemId === i.id))
    .map(i => {
      const p = resolvePrice(i.id, { lists, saleListId: priceListId || null, customerListId, item: i })
      return {
        value: i.id,
        label: i.name,
        sublabel: `${t('production.common.available')}: ${formatQty(stock.get(i.id)!.qty)} ${t(unitKey(i.unit))}${p !== null ? ` · ${formatPrice(p)}` : ''}`,
      }
    })

  const computed = lines.map(l => {
    const item = itemById.get(l.itemId)
    const base = item?.unit ?? 'pcs'
    const s = stock.get(l.itemId)
    const avg = s?.avgCost ?? 0
    const free = freeQty(l.itemId)
    const qty = round3(entryToBase(l.value, base, l.unit))
    const auto = priceOf(l.itemId)
    const priceNum = l.price === null ? auto : numIn(l.price)
    const priceValid = priceNum !== null && Number.isFinite(priceNum) && priceNum >= 0
    const price = priceValid ? round2(priceNum as number) : 0
    const discNum = l.discount.trim() ? numIn(l.discount) : 0
    const discValid = Number.isFinite(discNum) && discNum >= 0 && discNum <= 100
    const discount = discValid ? discNum : 0
    const amount = lineAmount(qty, price, discount)
    const lots = lotsOf(l.itemId)
    const picks = activePicks(l.picks, sourceId, l.itemId, qty)
    const cost = lineCost(lineAllocation(lots, picks, qty, 'strict'), qty, avg)
    return {
      ...l, item, base, free, qty, auto, unitPrice: price, priceValid, discount, discValid, amount, lots, picks, cost,
      margin: round2(amount - cost), vat: vatOk ? vatOf(amount, vatRate) : 0, over: qty > free,
    }
  })
  const totals = saleTotals(computed, vatOk ? vatRate : 0)
  const warning = creditPreview(customer, totals.total)
  const due = dueDateOf(date, customer?.paymentTermsDays ?? null)

  const valid = !!customer && !!sourceId && vatOk && computed.length > 0 && computed.length <= SALE_MAX_LINES
    && computed.every(c => c.qty > 0 && !c.over && c.priceValid && c.discValid)

  function changeWarehouse(id: string) {
    setWarehouseId(id)
    // Lines and their stock belong to the old warehouse.
    setLines([])
  }

  function patchLine(itemId: string, patch: Partial<Line>) {
    setLines(prev => prev.map(l => (l.itemId === itemId ? { ...l, ...patch } : l)))
  }

  async function save() {
    if (!valid) {
      const noPrice = computed.some(c => !c.priceValid)
      toast.error(t(noPrice ? 'prodSales.sales.noPriceError' : 'productionErrors.invalid_input'))
      return
    }
    setSaving(true)
    const rpcRes = await approval.run(ctl => createClient().rpc('prod_create_sale', {
      p_data: {
        ...ctl,
        doc_date: localDateTimeToIso(date, time),
        customer_id: customerId,
        warehouse_id: sourceId,
        price_list_id: priceListId || null,
        vat_rate: vatRate,
        vehicle_no: vehicle.trim() || null,
        driver: driver.trim() || null,
        note: note.trim() || null,
        items: computed.map(c => ({
          item_id: c.itemId,
          qty: c.qty,
          // Omitted = the server resolves it from the price lists (price_source);
          // a typed price is sent as a manual (negotiated) price.
          ...(c.price !== null ? { price: c.unitPrice } : {}),
          discount_pct: c.discount,
          lots: picksPayload(c.picks),
        })),
      },
    }))
    setSaving(false)
    if (!rpcRes) return
    const { data, error } = rpcRes
    if (error) { toast.error(errorText(error)); return }
    rememberWarehouse(sourceId)
    const res = data as { id?: string; credit_warning?: unknown } | null
    const cw = parseCreditWarning(res?.credit_warning)
    if (cw) toast.warning(t('prodSales.sales.creditWarnPosted'), { description: `${t('prodSales.common.creditLimit')}: ${formatPrice(cw.limit)} · ${t('prodSales.sales.balanceAfter')}: ${formatPrice(cw.balanceAfter)}` })
    else toast.success(t('production.common.saved'))
    router.push(res?.id ? `/zavod-sotuv/${res.id}` : '/zavod-sotuv')
  }

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-sotuv" label={t('prodSales.sales.title')} />
        <NotAvailableNote />
      </div>
    )
  }

  const customerOptions = customers
    .filter(c => c.isActive || c.id === customerId)
    .map(c => ({ value: c.id, label: c.name, sublabel: [c.legalName, c.inn].filter(Boolean).join(' · ') || undefined }))
  const activeLists = lists.filter(l => l.isActive || l.id === priceListId)
  const autoListName = (customer?.priceListId && lists.find(l => l.id === customer.priceListId && l.isActive)?.name)
    || lists.find(l => l.isDefault && l.isActive)?.name

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-sotuv" label={t('prodSales.sales.title')} />
      <PageHeader title={t('prodSales.sales.newTitle')} />

      <div className={cn(prodCardCls, 'p-4 sm:p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4')}>
        <div className="md:col-span-2" data-autofocus>
          <span className={prodLabelCls}>{t('prodSales.common.customer')}</span>
          {customersLoading ? (
            <div className="flex h-9 items-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
          ) : (
            <SearchSelect options={customerOptions} value={customerId} onChange={setCustomerId} placeholder={t('prodSales.common.selectCustomer')} />
          )}
          {customer && <CustomerSummary customer={customer} ageing={ageing?.get(customer.id)} />}
          {!customer && lines.length > 0 && <FieldError>{t('prodUx.required')}</FieldError>}
        </div>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.date')}</span>
          <DocDateInput value={date} onChange={setDate} />
          {due && <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodInventory.ageing.dueDate')}: {formatDate(due)}</span>}
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.time')}</span>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} className={prodFieldCls} />
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.warehouse')}</span>
          <select value={sourceId} onChange={e => changeWarehouse(e.target.value)} className={prodFieldCls}>
            <option value="">{t('production.common.selectWarehouse')}</option>
            {saleWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={prodLabelCls}>{t('prodSales.common.priceList')}</span>
          <select value={priceListId} onChange={e => setPriceListId(e.target.value)} className={prodFieldCls}>
            <option value="">{autoListName ? `${t('prodSales.sales.autoList')}: ${autoListName}` : t('prodSales.common.defaultPriceList')}</option>
            {activeLists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <div>
          <span className={prodLabelCls}>{t('prodSales.common.vatRate')}</span>
          <div className="flex items-center gap-2">
            <Segmented
              options={[
                ...VAT_PRESETS.map(v => ({ value: String(v) as VatMode, label: `${v}%` })),
                { value: 'custom' as const, label: t('prodSales.sales.vatCustom') },
              ]}
              value={vatMode}
              onChange={setVatMode}
            />
            {vatMode === 'custom' && (
              <input
                inputMode="decimal"
                value={vatCustom}
                onChange={e => setVatCustom(e.target.value.replace(/[^\d.,]/g, '').slice(0, 6))}
                placeholder="%"
                className={cn(prodFieldCls, 'w-20 tabular-nums', !vatOk && 'border-red-300 dark:border-red-800')}
              />
            )}
          </div>
        </div>
        <MoreFields className="md:col-span-2 lg:col-span-4" active={!!vehicle || !!driver || !!note}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block">
              <span className={prodLabelCls}>{t('prodSales.common.vehicle')}</span>
              <input value={vehicle} onChange={e => setVehicle(e.target.value.slice(0, 30))} placeholder="01 A 123 BC" className={prodFieldCls} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('prodSales.common.driver')}</span>
              <input value={driver} onChange={e => setDriver(e.target.value.slice(0, 100))} className={prodFieldCls} />
            </label>
            <div className="md:col-span-2"><NoteField value={note} onChange={setNote} /></div>
          </div>
        </MoreFields>
      </div>

      {warning && <CreditWarningBanner warning={warning} />}

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.sales.lines')}</h2>
          <div className="w-full sm:w-96">
            {!sourceId ? (
              <DisabledSelect placeholder={t('production.common.chooseWarehouseFirst')} />
            ) : stockLoading ? (
              <div className="flex h-9 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
            ) : (
              <SearchSelect
                options={itemOptions}
                value=""
                onChange={id => {
                  if (lines.length >= SALE_MAX_LINES) return
                  const base = itemById.get(id)?.unit ?? 'pcs'
                  setLines(prev => [...prev, { itemId: id, value: '', unit: base, price: null, discount: '' }])
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
                  <th className="px-4 py-2.5 text-right font-medium w-40">{t('prodSales.common.priceNoVat')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-24">{t('prodSales.common.discount')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.amount')}</th>
                  {seesMargin && <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.sales.fifoCost')}</th>}
                  {seesMargin && <th className="px-4 py-2.5 text-right font-medium">{t('prodSales.common.margin')}</th>}
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map(c => (
                  <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 align-top">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">{c.item?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{smart(c.free, c.base)}</td>
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
                          mode="strict"
                          warnDays={expiryWarnDaysOf(c.item)}
                          onChange={p => patchLine(c.itemId, { picks: makeLinePicks(sourceId, c.itemId, c.qty, p) })}
                        />
                      </div>
                      {c.over && <p className="mt-0.5 text-right text-[11px] text-red-600 dark:text-red-400">{t('productionErrors.insufficient_stock')}</p>}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1">
                        <input
                          inputMode="decimal"
                          value={c.price === null ? (c.auto === null ? '' : toInputString(c.auto) || '0') : c.price}
                          onChange={e => patchLine(c.itemId, { price: e.target.value })}
                          placeholder="—"
                          className={cn(prodFieldCls, 'text-right tabular-nums', !c.priceValid && 'border-red-300 dark:border-red-800')}
                        />
                        {c.price !== null && c.auto !== null && (
                          <button
                            type="button"
                            onClick={() => patchLine(c.itemId, { price: null })}
                            aria-label={t('prodSales.sales.resetPrice')}
                            title={`${t('prodSales.sales.resetPrice')}: ${formatPrice(c.auto)}`}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {c.price === null && c.auto === null && <p className="mt-0.5 text-right text-[11px] text-red-600 dark:text-red-400">{t('prodSales.sales.noPrice')}</p>}
                      {c.item && <p className="mt-0.5 text-right text-[11px] text-gray-400 dark:text-gray-500">/ {t(unitKey(c.base))}</p>}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        inputMode="decimal"
                        value={c.discount}
                        onChange={e => patchLine(c.itemId, { discount: e.target.value.replace(/[^\d.,]/g, '').slice(0, 6) })}
                        placeholder="0"
                        className={cn(prodFieldCls, 'text-right tabular-nums', !c.discValid && 'border-red-300 dark:border-red-800')}
                      />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(c.amount)}</td>
                    {seesMargin && <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(c.cost)}</td>}
                    {seesMargin && (
                      <td className={cn('px-4 py-2 text-right tabular-nums whitespace-nowrap', c.margin < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300')}>
                        {formatPrice(c.margin)}
                        <p className="text-[11px] text-gray-400 dark:text-gray-500">{formatMarginPct(marginPct(c.margin, c.amount))}</p>
                      </td>
                    )}
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
        {lotsAvailable && computed.length > 0 && (
          <p className="border-t border-gray-100 dark:border-gray-800 px-4 py-2 text-[12px] text-gray-400 dark:text-gray-500">{t('prodInventory.hold.fefoHint')}</p>
        )}
      </div>

      <div className="lg:ml-auto lg:max-w-md">
        <TotalsBox rows={[
          { label: t('prodInventory.common.itemsCount'), value: String(computed.length) },
          { label: t('prodSales.common.subtotal'), value: formatPrice(totals.subtotal) },
          { label: `${t('prodSales.common.vat')} ${vatOk ? `${vatRate}%` : ''}`, value: formatPrice(totals.vat) },
          ...(seesMargin ? [
            { label: t('prodSales.sales.fifoCost'), value: formatPrice(totals.cost) },
            {
              label: `${t('prodSales.common.margin')} (${formatMarginPct(marginPct(totals.margin, totals.subtotal))})`,
              value: formatPrice(totals.margin),
              tone: totals.margin < 0 ? 'negative' as const : undefined,
            },
          ] : []),
          { label: t('prodSales.common.totalWithVat'), value: formatPrice(totals.total), strong: true },
        ]} />
      </div>

      <FormFooter
        onCancel={() => router.push('/zavod-sotuv')}
        onSave={save}
        saving={saving}
        disabled={!valid}
        total={{ label: t('prodSales.common.totalWithVat'), value: formatPrice(totals.total) }}
      />
      {approval.dialog}
    </div>
  )
}
