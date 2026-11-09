'use client'

import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { SUPPLIER_PAYMENT_METHODS, supplierErrorKey, type Supplier, type SupplierPaymentMethod } from '@/lib/suppliers'

export const supplierFieldCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const labelCls = 'mb-1 block text-[13px] font-medium text-gray-700 dark:text-gray-300'

const emptyForm = { name: '', phone: '', companyName: '', inn: '', address: '', note: '', openingBalance: '', isActive: true }

/** Create (supplier = null) or edit a supplier. onSaved receives the id. */
export function SupplierFormDialog({
  open, onOpenChange, supplier, initialName, onSaved, onDeleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  supplier: Supplier | null
  initialName?: string
  onSaved: (id: string, name: string) => void
  onDeleted?: () => void
}) {
  const { t } = useLanguage()
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(supplier
      ? {
          name: supplier.name, phone: supplier.phone, companyName: supplier.companyName, inn: supplier.inn,
          address: supplier.address, note: supplier.note,
          openingBalance: supplier.openingBalance ? String(supplier.openingBalance) : '', isActive: supplier.isActive,
        }
      : { ...emptyForm, name: initialName ?? '' })
  }, [open, supplier, initialName])

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function save() {
    if (!form.name.trim()) { toast.error(t('suppliersPage.nameRequired')); return }
    const payload = {
      name: form.name.trim(), phone: form.phone, company_name: form.companyName, inn: form.inn,
      address: form.address, note: form.note, opening_balance: form.openingBalance || '0', is_active: form.isActive,
    }
    setSaving(true)
    const supabase = createClient()
    let id = supplier?.id ?? ''
    let errorMsg: string | null = null
    if (supplier) {
      const { error } = await supabase.rpc('update_supplier', { p_id: supplier.id, p_data: payload })
      errorMsg = error?.message ?? null
    } else {
      const { data, error } = await supabase.rpc('create_supplier', { p_data: payload })
      errorMsg = error?.message ?? null
      id = (data as string | null) ?? ''
    }
    setSaving(false)
    if (errorMsg) { toast.error(t(supplierErrorKey(errorMsg))); return }
    toast.success(t('suppliersPage.saved'))
    onSaved(id, form.name.trim())
  }

  async function remove() {
    if (!supplier || !window.confirm(t('suppliersPage.deleteConfirm'))) return
    setSaving(true)
    const { error } = await createClient().rpc('delete_supplier', { p_id: supplier.id })
    setSaving(false)
    if (error) { toast.error(t(supplierErrorKey(error.message))); return }
    toast.success(t('suppliersPage.deleted'))
    onDeleted?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{supplier ? t('suppliersPage.edit') : t('suppliersPage.add')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block sm:col-span-2">
            <span className={labelCls}>{t('suppliersPage.name')} *</span>
            <input autoFocus value={form.name} onChange={set('name')} className={supplierFieldCls} />
          </label>
          <label className="block">
            <span className={labelCls}>{t('suppliersPage.phone')}</span>
            <input value={form.phone} onChange={set('phone')} placeholder="+998" className={supplierFieldCls} />
          </label>
          <label className="block">
            <span className={labelCls}>{t('suppliersPage.companyName')}</span>
            <input value={form.companyName} onChange={set('companyName')} className={supplierFieldCls} />
          </label>
          <label className="block">
            <span className={labelCls}>{t('suppliersPage.inn')}</span>
            <input value={form.inn} onChange={set('inn')} inputMode="numeric" className={supplierFieldCls} />
          </label>
          <label className="block">
            <span className={labelCls}>{t('suppliersPage.openingBalance')}</span>
            <input value={form.openingBalance} onChange={set('openingBalance')} inputMode="decimal" type="number" placeholder="0" className={supplierFieldCls} />
          </label>
          <p className="sm:col-span-2 -mt-1 text-xs text-gray-400 dark:text-gray-500">{t('suppliersPage.openingBalanceHint')}</p>
          <label className="block sm:col-span-2">
            <span className={labelCls}>{t('suppliersPage.address')}</span>
            <input value={form.address} onChange={set('address')} className={supplierFieldCls} />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelCls}>{t('suppliersPage.note')}</span>
            <textarea value={form.note} onChange={set('note')} rows={2} className={cn(supplierFieldCls, 'h-auto py-2')} />
          </label>
          {supplier && (
            <div className="sm:col-span-2 flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2">
              <span className="text-sm text-gray-700 dark:text-gray-300">{form.isActive ? t('suppliersPage.active') : t('suppliersPage.inactive')}</span>
              <Switch checked={form.isActive} onCheckedChange={checked => setForm(f => ({ ...f, isActive: checked }))} />
            </div>
          )}
        </div>
        <DialogFooter className="mt-2 sm:justify-between">
          {supplier && onDeleted ? (
            <button type="button" onClick={remove} disabled={saving} className="text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50 transition-colors">
              {t('suppliersPage.delete')}
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>{t('suppliersPage.cancel')}</Button>
            <Button onClick={save} disabled={saving} loading={saving}>{t('suppliersPage.save')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SupplierPaymentDialog({
  open, onOpenChange, supplierId: fixedSupplierId, supplierName: fixedName, balance: fixedBalance, onSaved, choices,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  supplierId: string | null
  supplierName: string
  balance: number
  onSaved: () => void
  /** When given and no supplier is fixed, the dialog shows a supplier picker. */
  choices?: { id: string; name: string; phone: string; balance: number }[]
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [pickedId, setPickedId] = useState('')
  const picked = choices?.find(c => c.id === pickedId)
  const supplierId = fixedSupplierId ?? (pickedId || null)
  const supplierName = fixedSupplierId ? fixedName : picked?.name ?? ''
  const balance = fixedSupplierId ? fixedBalance : picked?.balance ?? 0
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<SupplierPaymentMethod>('cash')
  const [date, setDate] = useState(localYmd())
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setPickedId('')
    setAmount('')
    setMethod('cash')
    setDate(localYmd())
    setNote('')
  }, [open])

  const methodLabel: Record<SupplierPaymentMethod, string> = {
    cash: t('suppliersPage.cash'), card: t('suppliersPage.card'), transfer: t('suppliersPage.transfer'),
  }

  async function save() {
    const value = Number(amount)
    if (!supplierId) { toast.error(t('suppliersPage.selectSupplierFirst')); return }
    if (!value || value <= 0) { toast.error(t('suppliersPage.invalidAmount')); return }
    setSaving(true)
    const { error } = await createClient().rpc('create_supplier_payment', {
      p_supplier_id: supplierId, p_amount: value, p_payment_method: method, p_date: date, p_note: note.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(t(supplierErrorKey(error.message))); return }
    toast.success(t('suppliersPage.paymentSaved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('suppliersPage.payTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!fixedSupplierId && choices && (
            <div>
              <span className={labelCls}>{t('suppliersPage.supplier')} *</span>
              <SearchSelect
                options={choices.map(c => ({ value: c.id, label: c.name, sublabel: c.phone || undefined }))}
                value={pickedId}
                onChange={setPickedId}
                placeholder={t('suppliersPage.select')}
              />
            </div>
          )}
          {supplierId && <div className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5 text-sm">
            <span className="font-medium text-gray-900 dark:text-gray-100">{supplierName}</span>
            <span className={cn('tabular-nums', balance > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>
              {t('suppliersPage.balance')}: {formatPrice(Math.max(0, balance))}
            </span>
          </div>}
          <label className="block">
            <span className={labelCls}>{t('suppliersPage.amount')} *</span>
            <input autoFocus type="number" inputMode="decimal" min={0} value={amount} onChange={e => setAmount(e.target.value)} className={supplierFieldCls} />
            {balance > 0 && (
              <button type="button" onClick={() => setAmount(String(balance))} className="mt-1 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                {t('suppliersPage.payAll')} ({formatPrice(balance)})
              </button>
            )}
          </label>
          <div>
            <span className={labelCls}>{t('suppliersPage.method')}</span>
            <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
              {SUPPLIER_PAYMENT_METHODS.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    method === m
                      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                      : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
                  )}
                >
                  {methodLabel[m]}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className={labelCls}>{t('suppliersPage.date')}</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={supplierFieldCls} />
          </label>
          <label className="block">
            <span className={labelCls}>{t('suppliersPage.note')}</span>
            <input value={note} onChange={e => setNote(e.target.value)} className={supplierFieldCls} />
          </label>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('suppliersPage.cancel')}</Button>
          <Button onClick={save} disabled={saving} loading={saving}>{t('suppliersPage.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Supplier balance from OUR side: balance = what we owe, shown as
 *  −X red (we owe) or +X green (prepaid, the supplier owes us). */
export function BalanceBadge({ balance }: { balance: number }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  if (Math.abs(balance) < 0.5) {
    return <span className="rounded-full px-2 py-0.5 text-xs bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400">{t('suppliersPage.settled')}</span>
  }
  if (balance < 0) {
    return <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">+{formatPrice(-balance)}</span>
  }
  return <span className="font-semibold tabular-nums text-red-600 dark:text-red-400">−{formatPrice(balance)}</span>
}
