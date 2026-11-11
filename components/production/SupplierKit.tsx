'use client'

// Production suppliers (yetkazib beruvchilar): shared hook, balance cell and
// dialogs. Writes go through prod_save_supplier /
// prod_create_supplier_payment / prod_cancel_supplier_payment only.

import { useCallback, useEffect, useState } from 'react'
import { Ban, Loader2 } from 'lucide-react'
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
import { AccountSelect, useAccountChoice, useCashAccounts, useCashErrorText } from '@/components/production/CashKit'
import { DocDateInput, useApprovalRetry } from '@/components/production/ControlKit'
import { isOwnerAdminRole, prodErrorText } from '@/lib/production-controls'
import {
  PROD_PAYMENT_METHODS, canCancelDocuments, fetchProdSuppliers, parseDecimal, paymentMethodKey, prodErrorKey, round2,
  type ProdPaymentMethod, type ProdSupplier,
} from '@/lib/production'
import { parseIntInRange, probeInventoryDocs } from '@/lib/inventory'

export function useProdSuppliers() {
  const [suppliers, setSuppliers] = useState<ProdSupplier[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const list = await fetchProdSuppliers(createClient())
    setSuppliers(list)
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return { suppliers, loading, reload }
}

/** Debt: red when we owe, green "Avans" when the supplier was overpaid. */
export function DebtValue({ debt, className }: { debt: number; className?: string }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  if (debt < 0) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
        <span className="inline-flex rounded-full bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400 px-2 py-0.5 text-xs font-medium">
          {t('production.suppliers.advance')}
        </span>
        <span className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">{formatPrice(-debt)}</span>
      </span>
    )
  }
  return (
    <span className={cn(
      'tabular-nums whitespace-nowrap font-medium',
      debt > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400',
      className,
    )}>
      {formatPrice(debt)}
    </span>
  )
}

/** Payment method is categorical: monochrome pill. */
export function PaymentMethodBadge({ method }: { method: string }) {
  const { t } = useLanguage()
  return (
    <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-gray-700 dark:text-gray-300">
      {t(paymentMethodKey(method))}
    </span>
  )
}

/** Amallar cell for a payment row: cancel (posted only, owner/admin). */
export function PaymentCancelButton({ show, busy, onClick }: { show: boolean; busy: boolean; onClick: () => void }) {
  const { t } = useLanguage()
  if (!show) return null
  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label={t('production.suppliers.cancelPayment')}
        title={t('production.suppliers.cancelPayment')}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 transition-colors"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

/** Cancel a posted supplier payment (owner/admin; the RPC re-checks). */
export function useCancelSupplierPayment(onDone: () => void) {
  const { t } = useLanguage()
  const { profile } = useSession()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function cancel(id: string) {
    if (!window.confirm(t('production.suppliers.cancelPaymentConfirm'))) return
    setBusyId(id)
    const { error } = await createClient().rpc('prod_cancel_supplier_payment', { p_id: id })
    setBusyId(null)
    if (error) { toast.error(prodErrorText(t, error)); return }
    toast.success(t('production.suppliers.paymentCancelled'))
    onDone()
  }

  return { canCancel: canCancelDocuments(profile?.role), cancel, busyId }
}

/** Create / edit dialog. Calls prod_save_supplier (full replace on update). */
export function SupplierFormDialog({ open, onOpenChange, supplier, initialName, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  supplier: ProdSupplier | null
  /** Prefill for quick-create from another form. */
  initialName?: string
  onSaved: (id: string) => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [milkPrice, setMilkPrice] = useState('')
  const [note, setNote] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [terms, setTerms] = useState('')
  // payment_terms_days exists after migration 20261110000014.
  const [termsAvailable, setTermsAvailable] = useState(false)
  // Only owner / admin may set or change the milk price (migration 20261110000017:
  // forbidden 'supplier_price_change'); others keep the saved value.
  const canEditMilkPrice = isOwnerAdminRole(useSession().profile?.role)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    probeInventoryDocs(createClient()).then(ok => { if (!cancelled) setTermsAvailable(ok) })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    setTerms(supplier?.paymentTermsDays != null ? String(supplier.paymentTermsDays) : '')
    setName(supplier?.name ?? initialName ?? '')
    setPhone(supplier?.phone ?? '')
    setAddress(supplier?.address ?? '')
    setMilkPrice(supplier?.milkPricePerKg != null ? String(supplier.milkPricePerKg) : '')
    setNote(supplier?.note ?? '')
    setIsActive(supplier?.isActive ?? true)
  }, [open, supplier, initialName])

  async function save() {
    if (!name.trim()) { toast.error(t('production.common.nameRequired')); return }
    const termsDays = parseIntInRange(terms, 0, 365)
    if (termsAvailable && termsDays === undefined) { toast.error(t('prodInventory.ageing.termsError')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_save_supplier', {
      p_id: supplier?.id ?? null,
      p_data: {
        name: name.trim(),
        phone: phone.trim() || null,
        address: address.trim() || null,
        // Empty = use the default price from Sut qabuli settings.
        milk_price_per_kg: milkPrice.trim() ? round2(parseDecimal(milkPrice)) : null,
        note: note.trim() || null,
        is_active: isActive,
        ...(termsAvailable ? { payment_terms_days: termsDays ?? null } : {}),
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    onSaved(typeof data === 'string' ? data : (supplier?.id ?? ''))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{supplier ? t('production.suppliers.editTitle') : t('production.suppliers.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.suppliers.name')}</span>
            <input value={name} onChange={e => setName(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.suppliers.phone')}</span>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder={t('production.suppliers.phonePlaceholder')} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.suppliers.address')}</span>
            <input value={address} onChange={e => setAddress(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.suppliers.milkPrice')}</span>
            <input inputMode="decimal" value={milkPrice} onChange={e => setMilkPrice(e.target.value)} disabled={!canEditMilkPrice} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
            <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.suppliers.milkPriceHint')}</span>
          </label>
          {termsAvailable && (
            <label className="block">
              <span className={prodLabelCls}>{t('prodInventory.ageing.paymentTerms')}</span>
              <input inputMode="numeric" value={terms} onChange={e => setTerms(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="—" className={cn(prodFieldCls, 'tabular-nums')} />
              <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodInventory.ageing.paymentTermsHint')}</span>
            </label>
          )}
          <NoteField value={note} onChange={setNote} />
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

/** "To'lov qilish": calls prod_create_supplier_payment. Overpayment is allowed (advance). */
export function SupplierPaymentDialog({ open, onOpenChange, suppliers, supplierId: fixedSupplierId, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suppliers: ProdSupplier[]
  /** When set, the supplier is preselected (detail page). */
  supplierId?: string
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [supplierId, setSupplierId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<ProdPaymentMethod>('cash')
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  // Cash & bank (migration 20261110000016): the paying account, default by method.
  const { available: cashAvailable, accounts, reload: reloadAccounts } = useCashAccounts()
  const [accountId, setAccountId] = useAccountChoice(open, accounts, method)
  const errorText = useCashErrorText(accounts)
  const approval = useApprovalRetry()

  useEffect(() => { if (open && cashAvailable) reloadAccounts() }, [open, cashAvailable, reloadAccounts])

  useEffect(() => {
    if (!open) return
    setSupplierId(fixedSupplierId ?? '')
    setAmount('')
    setMethod('cash')
    setDate(localYmd())
    setNote('')
  }, [open, fixedSupplierId])

  const supplier = suppliers.find(s => s.id === supplierId)
  const value = round2(parseDecimal(amount))
  const after = supplier ? round2(supplier.debt - value) : 0
  const overpay = !!supplier && value > 0 && after < 0

  // Payments to inactive suppliers are allowed (settling old debt).
  const options = suppliers
    .map(s => ({ value: s.id, label: s.name, sublabel: `${t('production.suppliers.debt')}: ${formatPrice(s.debt)}` }))

  async function save() {
    if (!supplierId || value <= 0) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const res = await approval.run(ctl => createClient().rpc('prod_create_supplier_payment', {
      p_data: {
        ...ctl,
        supplier_id: supplierId,
        amount: value,
        method,
        pay_date: date || localYmd(),
        note: note.trim() || null,
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
          <DialogTitle>{t('production.suppliers.pay')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <span className={prodLabelCls}>{t('production.suppliers.supplier')}</span>
            <SearchSelect options={options} value={supplierId} onChange={setSupplierId} placeholder={t('production.suppliers.selectSupplier')} />
            {supplier && (
              <span className="mt-1 flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400">
                {t('production.suppliers.currentDebt')}: <DebtValue debt={supplier.debt} className="text-[12px]" />
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
          {cashAvailable && <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} outflow={value} />}
          {supplier && value > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-sm">
              <span className="text-gray-500 dark:text-gray-400">{t('production.suppliers.afterPayment')}</span>
              <DebtValue debt={after} />
            </div>
          )}
          {overpay && <p className="text-[12px] text-amber-600 dark:text-amber-400">{t('production.suppliers.overpayHint')}</p>}
          <NoteField value={note} onChange={setNote} />
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving || !supplierId || value <= 0} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
        {approval.dialog}
      </DialogContent>
    </Dialog>
  )
}
