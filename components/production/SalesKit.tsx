'use client'

// Wholesale sales (migration 20261110000015): availability hook, customer /
// price list hooks, balance cell, credit warning banner and the customer +
// customer payment dialogs. Writes go through prod_save_customer /
// prod_create_customer_payment / prod_cancel_customer_payment only.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useSession } from '@/lib/session/SessionContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { NoteField, Segmented, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { DocDateInput, useApprovalRetry } from '@/components/production/ControlKit'
import { Term } from '@/components/production/Term'
import { prodErrorText } from '@/lib/production-controls'
import { AccountSelect, useAccountChoice, useCashAccounts, useCashErrorText } from '@/components/production/CashKit'
import {
  PROD_PAYMENT_METHODS, canCancelDocuments, parseDecimal, paymentMethodKey, prodErrorKey, round2,
  type ProdPaymentMethod,
} from '@/lib/production'
import { parseIntInRange, parseMoneyOrNull } from '@/lib/inventory'
import {
  fetchCustomerAgeing, fetchPriceLists, fetchProdCustomers, overdueOf, probeSales,
  type CreditWarning, type CustomerAgeing, type PriceList, type ProdCustomer,
} from '@/lib/sales'

/** null while probing, then whether migration 20261110000015 is live. */
export function useSalesAvailable(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    probeSales(createClient()).then(v => { if (!cancelled) setOk(v) })
    return () => { cancelled = true }
  }, [])
  return ok
}

/** Owner / admin see cost, margin and may cancel (the RPCs re-check). */
export function useSeesMargin(): boolean {
  const { profile } = useSession()
  return canCancelDocuments(profile?.role)
}

export function useProdCustomers() {
  const [customers, setCustomers] = useState<ProdCustomer[]>([])
  const [ageing, setAgeing] = useState<Map<string, CustomerAgeing> | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const supabase = createClient()
    const [list, age] = await Promise.all([fetchProdCustomers(supabase), fetchCustomerAgeing(supabase)])
    setCustomers(list ?? [])
    setAgeing(age)
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return { customers, ageing, loading, reload }
}

export function usePriceLists() {
  const [lists, setLists] = useState<PriceList[]>([])
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    const l = await fetchPriceLists(createClient())
    setLists(l ?? [])
    setLoading(false)
  }, [])
  useEffect(() => { reload() }, [reload])
  return { lists, loading, reload }
}

/** Customer balance: red when the customer owes us, green "Avans" when overpaid. */
export function BalanceValue({ balance, className }: { balance: number; className?: string }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  if (balance < 0) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
        <span className="inline-flex rounded-full bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400 px-2 py-0.5 text-xs font-medium">
          {t('prodSales.common.advance')}
        </span>
        <span className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{formatPrice(-balance)}</span>
      </span>
    )
  }
  return (
    <span className={cn(
      'tabular-nums whitespace-nowrap font-medium',
      balance > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400',
      className,
    )}>
      {formatPrice(balance)}
    </span>
  )
}

/** Amber banner: the sale takes the customer over the credit limit (a warning, not a block). */
export function CreditWarningBanner({ warning, className }: { warning: CreditWarning; className?: string }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm', className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="space-y-0.5 text-amber-800 dark:text-amber-300">
        <p className="font-medium">{t('prodSales.sales.creditWarnTitle')}</p>
        <p className="tabular-nums">
          {t('prodSales.common.creditLimit')}: {formatPrice(warning.limit)} · {t('prodSales.sales.balanceBefore')}: {formatPrice(warning.balanceBefore)} · {t('prodSales.sales.balanceAfter')}: {formatPrice(warning.balanceAfter)}
        </p>
      </div>
    </div>
  )
}

/** Customer summary under a customer select: balance, credit limit, overdue. */
export function CustomerSummary({ customer, ageing }: { customer: ProdCustomer; ageing: CustomerAgeing | undefined }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const overdue = overdueOf(ageing)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-gray-500 dark:text-gray-400">
      <span className="inline-flex items-center gap-1"><Term k="debitorlik">{t('prodSales.common.balance')}</Term>: <BalanceValue balance={customer.balance} className="text-[12px]" /></span>
      <span className="tabular-nums">{t('prodSales.common.creditLimit')}: {customer.creditLimit === null ? '—' : formatPrice(customer.creditLimit)}</span>
      {overdue > 0 && <span className="tabular-nums font-medium text-red-600 dark:text-red-400">{t('prodSales.common.overdueDebt')}: {formatPrice(overdue)}</span>}
    </div>
  )
}

/** Create / edit dialog. Calls prod_save_customer (full replace on update). */
export function CustomerFormDialog({ open, onOpenChange, customer, priceLists, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: ProdCustomer | null
  priceLists: PriceList[]
  onSaved: (id: string) => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [legalName, setLegalName] = useState('')
  const [inn, setInn] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [contact, setContact] = useState('')
  const [priceListId, setPriceListId] = useState('')
  const [creditLimit, setCreditLimit] = useState('')
  const [terms, setTerms] = useState('')
  const [vatPayer, setVatPayer] = useState(false)
  const [note, setNote] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(customer?.name ?? '')
    setLegalName(customer?.legalName ?? '')
    setInn(customer?.inn ?? '')
    setPhone(customer?.phone ?? '')
    setAddress(customer?.address ?? '')
    setContact(customer?.contactPerson ?? '')
    setPriceListId(customer?.priceListId ?? '')
    setCreditLimit(customer?.creditLimit != null ? String(customer.creditLimit) : '')
    setTerms(customer?.paymentTermsDays != null ? String(customer.paymentTermsDays) : '')
    setVatPayer(customer?.vatPayer ?? false)
    setNote(customer?.note ?? '')
    setIsActive(customer?.isActive ?? true)
  }, [open, customer])

  async function save() {
    if (!name.trim()) { toast.error(t('production.common.nameRequired')); return }
    const innValue = inn.replace(/\s/g, '')
    if (innValue && !/^\d{9,14}$/.test(innValue)) { toast.error(t('prodSales.customers.innError')); return }
    const termsDays = parseIntInRange(terms, 0, 365)
    if (termsDays === undefined) { toast.error(t('prodInventory.ageing.termsError')); return }
    const limit = parseMoneyOrNull(creditLimit)
    if (limit === undefined) { toast.error(t('prodSales.customers.creditLimitError')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_save_customer', {
      p_id: customer?.id ?? null,
      p_data: {
        name: name.trim(),
        legal_name: legalName.trim() || null,
        inn: innValue || null,
        phone: phone.trim() || null,
        address: address.trim() || null,
        contact_person: contact.trim() || null,
        price_list_id: priceListId || null,
        credit_limit: limit,
        payment_terms_days: termsDays,
        vat_payer: vatPayer,
        note: note.trim() || null,
        is_active: isActive,
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    onSaved(typeof data === 'string' ? data : (customer?.id ?? ''))
  }

  const activeLists = priceLists.filter(l => l.isActive || l.id === priceListId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{customer ? t('prodSales.customers.editTitle') : t('prodSales.customers.new')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.name')}</span>
            <input value={name} onChange={e => setName(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodSales.common.legalName')}</span>
            <input value={legalName} onChange={e => setLegalName(e.target.value)} placeholder={t('prodSales.customers.legalNamePlaceholder')} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodSales.common.inn')}</span>
            <input inputMode="numeric" value={inn} onChange={e => setInn(e.target.value.replace(/[^\d\s]/g, '').slice(0, 16))} placeholder="123456789" className={cn(prodFieldCls, 'tabular-nums')} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.suppliers.phone')}</span>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder={t('production.suppliers.phonePlaceholder')} className={prodFieldCls} />
          </label>
          <label className="block sm:col-span-2">
            <span className={prodLabelCls}>{t('production.suppliers.address')}</span>
            <input value={address} onChange={e => setAddress(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodSales.common.contactPerson')}</span>
            <input value={contact} onChange={e => setContact(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodSales.common.priceList')}</span>
            <select value={priceListId} onChange={e => setPriceListId(e.target.value)} className={prodFieldCls}>
              <option value="">{t('prodSales.common.defaultPriceList')}</option>
              {activeLists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodSales.common.creditLimit')}</span>
            <input inputMode="decimal" value={creditLimit} onChange={e => setCreditLimit(e.target.value)} placeholder="—" className={cn(prodFieldCls, 'tabular-nums')} />
            <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodSales.customers.creditLimitHint')}</span>
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodInventory.ageing.paymentTerms')}</span>
            <input inputMode="numeric" value={terms} onChange={e => setTerms(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="—" className={cn(prodFieldCls, 'tabular-nums')} />
            <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodSales.customers.termsHint')}</span>
          </label>
          <div className="sm:col-span-2">
            <NoteField value={note} onChange={setNote} />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">{t('prodSales.common.vatPayer')}</span>
            <Switch checked={vatPayer} onCheckedChange={setVatPayer} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">{t('production.common.active')}</span>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </label>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "To'lov qabul qilish": calls prod_create_customer_payment. Overpayment is allowed (advance). */
export function CustomerPaymentDialog({ open, onOpenChange, customers, customerId: fixedCustomerId, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customers: ProdCustomer[]
  customerId?: string
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [customerId, setCustomerId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<ProdPaymentMethod>('transfer')
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  // Cash & bank (migration 20261110000016): the receiving account, default by method.
  const { available: cashAvailable, accounts, reload: reloadAccounts } = useCashAccounts()
  const [accountId, setAccountId] = useAccountChoice(open, accounts, method)
  const errorText = useCashErrorText(accounts)
  const approval = useApprovalRetry()

  useEffect(() => { if (open && cashAvailable) reloadAccounts() }, [open, cashAvailable, reloadAccounts])

  useEffect(() => {
    if (!open) return
    setCustomerId(fixedCustomerId ?? '')
    setAmount('')
    setMethod('transfer')
    setDate(localYmd())
    setNote('')
  }, [open, fixedCustomerId])

  const customer = customers.find(c => c.id === customerId)
  const value = round2(parseDecimal(amount))
  const after = customer ? round2(customer.balance - value) : 0
  const overpay = !!customer && value > 0 && after < 0

  const options = customers.map(c => ({ value: c.id, label: c.name, sublabel: `${t('prodSales.common.balance')}: ${formatPrice(c.balance)}` }))

  async function save() {
    if (!customerId || value <= 0) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const res = await approval.run(ctl => createClient().rpc('prod_create_customer_payment', {
      p_data: {
        ...ctl,
        customer_id: customerId, amount: value, method, pay_date: date || localYmd(), note: note.trim() || null,
        ...(cashAvailable && accountId ? { account_id: accountId } : {}),
      },
    }))
    setSaving(false)
    if (!res) return
    if (res.error) { toast.error(errorText(res.error)); return }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('prodSales.payments.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <span className={prodLabelCls}>{t('prodSales.common.customer')}</span>
            <SearchSelect options={options} value={customerId} onChange={setCustomerId} placeholder={t('prodSales.common.selectCustomer')} />
            {customer && (
              <span className="mt-1 flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400">
                {t('prodSales.common.balance')}: <BalanceValue balance={customer.balance} className="text-[12px]" />
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={prodLabelCls}>{t('production.suppliers.amount')}</span>
              <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.date')}</span>
              <DocDateInput value={date} onChange={setDate} />
            </label>
          </div>
          <div>
            <span className={prodLabelCls}>{t('production.suppliers.method')}</span>
            <Segmented
              options={PROD_PAYMENT_METHODS.map(m => ({ value: m, label: t(paymentMethodKey(m)) }))}
              value={method}
              onChange={setMethod}
            />
          </div>
          {cashAvailable && <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} />}
          {customer && value > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-sm">
              <span className="text-gray-500 dark:text-gray-400">{t('prodSales.payments.afterPayment')}</span>
              <BalanceValue balance={after} />
            </div>
          )}
          {overpay && <p className="text-[12px] text-amber-600 dark:text-amber-400">{t('prodSales.payments.overpayHint')}</p>}
          <NoteField value={note} onChange={setNote} />
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving || !customerId || value <= 0} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
        {approval.dialog}
      </DialogContent>
    </Dialog>
  )
}

/** Cancel a posted customer payment (owner/admin; the RPC re-checks). */
export function useCancelCustomerPayment(onDone: () => void) {
  const { t } = useLanguage()
  const { profile } = useSession()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function cancel(id: string) {
    if (!window.confirm(t('prodSales.payments.cancelConfirm'))) return
    setBusyId(id)
    const { error } = await createClient().rpc('prod_cancel_customer_payment', { p_id: id })
    setBusyId(null)
    if (error) { toast.error(prodErrorText(t, error)); return }
    toast.success(t('prodSales.payments.cancelled'))
    onDone()
  }

  return { canCancel: canCancelDocuments(profile?.role), cancel, busyId }
}

// ---------------------------------------------------------------------------
// Repeat last sale (migration 20261110000019: prod_last_sale_lines)

export interface LastSaleLine { itemId: string; qty: number; price: number; currentPrice: number | null }
export interface LastSale { saleId: string; number: number | null; warehouseId: string | null; priceListId: string | null; lines: LastSaleLine[] }

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>

/**
 * The customer's last posted sale lines: prod_last_sale_lines, or (before
 * migration 19) a direct read of the last posted prod_sales row + its lines.
 * null = no posted sale; undefined = could not load.
 */
export async function fetchLastSale(customerId: string): Promise<LastSale | null | undefined> {
  const supabase = createClient()
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc
  const r = await rpc('prod_last_sale_lines', { p_customer: customerId })
  if (!r.error) {
    const d = r.data as {
      sale_id?: string; number?: number; warehouse_id?: string | null; price_list_id?: string | null
      lines?: { item_id: string; qty: number; price: number; current_price?: number | null }[]
    } | null
    if (!d || !d.sale_id) return null
    return {
      saleId: d.sale_id,
      number: d.number ?? null,
      warehouseId: d.warehouse_id ?? null,
      priceListId: d.price_list_id ?? null,
      lines: (d.lines ?? []).map(l => ({ itemId: l.item_id, qty: Number(l.qty), price: Number(l.price), currentPrice: l.current_price == null ? null : Number(l.current_price) })),
    }
  }
  if (/not_found|forbidden/.test(r.error.message ?? '')) return r.error.message?.includes('not_found') ? null : undefined
  // Fallback while the RPC is not deployed.
  const { data: sale, error } = await supabase.from('prod_sales')
    .select('id, number, warehouse_id, price_list_id')
    .eq('customer_id', customerId)
    .eq('status', 'posted')
    .order('doc_date', { ascending: false })
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return undefined
  if (!sale) return null
  const { data: lines, error: linesError } = await supabase.from('prod_sale_items')
    .select('item_id, qty, price')
    .eq('sale_id', sale.id)
    .order('sort_order')
  if (linesError) return undefined
  return {
    saleId: sale.id,
    number: sale.number,
    warehouseId: sale.warehouse_id,
    priceListId: sale.price_list_id,
    lines: (lines ?? []).map(l => ({ itemId: l.item_id, qty: Number(l.qty), price: Number(l.price), currentPrice: null })),
  }
}
