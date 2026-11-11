'use client'

// Cash & bank (migration 20261110000016): availability / accounts hooks,
// account selector for payment dialogs, account / cash order / transfer
// dialogs, cancel hook and the PKO / RKO print form. Writes go through
// prod_save_cash_account / prod_create_cash_order /
// prod_create_cash_transfer / prod_cancel_cash_doc only.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CreditCard, Landmark, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useSession } from '@/lib/session/SessionContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { NoteField, Segmented, prodFieldCls, prodLabelCls } from '@/components/production/ProdKit'
import { PrintFields, PrintSheet } from '@/components/production/PrintKit'
import {
  PROD_PAYMENT_METHODS, canCancelDocuments, localDateTimeToIso, nowHm, parseDecimal, paymentMethodKey, prodErrorKey, round2,
  type ProdPaymentMethod, type ProdRpcError,
} from '@/lib/production'
import {
  CASH_ACCOUNT_KINDS, accountKindKey, defaultAccountFor, fetchCashAccounts, needsOpeningBalance, probeCash,
  type CashAccount, type CashAccountKind, type CashOrderRow,
} from '@/lib/cash'

const hintLinkCls = 'font-medium underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100'

/**
 * Error text of a money RPC. insufficient_funds carries the account id in
 * DETAIL: name the account and its current balance.
 */
export function useCashErrorText(accounts: CashAccount[]) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  return (error: ProdRpcError) => {
    const key = prodErrorKey(error)
    if (key !== 'prodCash.errors.insufficient_funds' || !error || typeof error === 'string') return t(key)
    const a = accounts.find(x => x.id === error.details)
    return a ? `${t(key)}: ${a.name} · ${t('prodCash.common.balance')} ${formatPrice(a.balance)}` : t(key)
  }
}

/** null while probing, then whether migration 20261110000016 is live. */
export function useCashAvailable(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    probeCash(createClient()).then(v => { if (!cancelled) setOk(v) })
    return () => { cancelled = true }
  }, [])
  return ok
}

/** Accounts with balances. `available` is null while probing. */
export function useCashAccounts() {
  const available = useCashAvailable()
  const [accounts, setAccounts] = useState<CashAccount[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const list = await fetchCashAccounts(createClient())
    setAccounts(list ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    if (available === false) setLoading(false)
    if (available) reload()
  }, [available, reload])

  return { available, accounts, loading, reload }
}

export function useExpenseCategories(enabled = true) {
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    if (!enabled) return
    let active = true
    createClient().from('expense_categories').select('id, name').order('name').then(({ data }) => { if (active) setCategories(data ?? []) })
    return () => { active = false }
  }, [enabled])
  return categories
}

/** Monochrome icon of an account kind (kassa / bank / karta). */
export function AccountKindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === 'bank') return <Landmark className={className} />
  if (kind === 'card') return <CreditCard className={className} />
  return <Wallet className={className} />
}

/** Account name for list cells; muted dash when the document has no account (pre-migration). */
export function AccountName({ accounts, id }: { accounts: CashAccount[]; id: string | null | undefined }) {
  const a = id ? accounts.find(x => x.id === id) : undefined
  if (!a) return <span className="text-gray-400 dark:text-gray-500">—</span>
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-gray-700 dark:text-gray-300">
      <AccountKindIcon kind={a.kind} className="h-3.5 w-3.5 shrink-0 text-gray-400" /> {a.name}
    </span>
  )
}

/**
 * Account selector of a money dialog. Preselects the default account of the
 * payment method whenever the dialog opens or the method changes.
 */
export function useAccountChoice(open: boolean, accounts: CashAccount[], method: ProdPaymentMethod) {
  const [accountId, setAccountId] = useState('')
  useEffect(() => {
    if (!open) return
    setAccountId(defaultAccountFor(accounts, method)?.id ?? '')
  }, [open, method, accounts])
  return [accountId, setAccountId] as const
}

export function AccountSelect({ accounts, value, onChange, label, outflow, exclude }: {
  accounts: CashAccount[]
  value: string
  onChange: (id: string) => void
  label?: string
  /** Amount about to leave the account: warns when it exceeds the balance (the RPC re-checks). */
  outflow?: number
  exclude?: string
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const options = accounts.filter(a => (a.isActive || a.id === value) && a.id !== exclude)
  const selected = accounts.find(a => a.id === value)
  const short = !!selected && !!outflow && outflow > selected.balance
  // Seeded accounts start at 0: an outflow would be refused until the real opening balance is entered.
  const unset = !!selected && outflow !== undefined && needsOpeningBalance(selected)
  const settingsLink = <Link href="/zavod-kassa" className={hintLinkCls}>{t('prodCash.common.openSettings')}</Link>
  return (
    <div>
      <label className="block">
        <span className={prodLabelCls}>{label ?? t('prodCash.common.account')}</span>
        {options.length > 0 && (
          <select value={value} onChange={e => onChange(e.target.value)} className={cn(prodFieldCls, short && 'border-red-300 dark:border-red-800')}>
            <option value="">{t('prodCash.common.selectAccount')}</option>
            {options.map(a => <option key={a.id} value={a.id}>{a.name} · {formatPrice(a.balance)}</option>)}
          </select>
        )}
      </label>
      {options.length === 0 && (
        <p className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
          {t('prodCash.common.noAccounts')} {settingsLink}
        </p>
      )}
      {selected && !unset && (
        <span className={cn('mt-1 block text-[12px]', short ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400')}>
          {short ? t('prodCash.common.insufficientHint') : `${t('prodCash.common.balance')}: ${formatPrice(selected.balance)}`}
        </span>
      )}
      {unset && (
        <p className="mt-1.5 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
          {t('prodCash.common.openingUnset')} {settingsLink}
        </p>
      )}
      {!selected && options.length > 0 && (
        <span className="mt-1 block text-[12px] text-amber-600 dark:text-amber-400">{t('prodCash.common.noDefault')} {settingsLink}</span>
      )}
    </div>
  )
}

/** Create / edit an account (prod_save_cash_account). */
export function CashAccountDialog({ open, onOpenChange, account, accounts, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: CashAccount | null
  /** All accounts: shows which one loses a default method to this one. */
  accounts: CashAccount[]
  onSaved: (id: string) => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<CashAccountKind>('cash')
  const [bankName, setBankName] = useState('')
  const [accountNo, setAccountNo] = useState('')
  const [mfo, setMfo] = useState('')
  const [opening, setOpening] = useState('')
  const [openingDate, setOpeningDate] = useState('')
  const [defaultFor, setDefaultFor] = useState<ProdPaymentMethod[]>([])
  const [isActive, setIsActive] = useState(true)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  // opening_balance may change only while the account has no movements (move_count = 0).
  const locked = !!account && account.moveCount > 0
  // The RPC moves a default method silently: say where it comes from.
  const takenFrom = accounts.filter(a => a.id !== account?.id && a.isActive && a.defaultFor.some(m => defaultFor.includes(m)))

  useEffect(() => {
    if (!open) return
    setName(account?.name ?? '')
    setKind(account?.kind ?? 'cash')
    setBankName(account?.bankName ?? '')
    setAccountNo(account?.accountNo ?? '')
    setMfo(account?.mfo ?? '')
    setOpening(account ? String(account.openingBalance) : '')
    setOpeningDate(account?.openingDate?.slice(0, 10) ?? localYmd())
    setDefaultFor(account?.defaultFor ?? [])
    setIsActive(account?.isActive ?? true)
    setNote(account?.note ?? '')
  }, [open, account])

  function toggleDefault(m: ProdPaymentMethod) {
    setDefaultFor(prev => (prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]))
  }

  async function save() {
    if (!name.trim()) { toast.error(t('production.common.nameRequired')); return }
    const openingValue = opening.trim() ? Number(opening.replace(',', '.').replace(/\s/g, '')) : 0
    if (!Number.isFinite(openingValue) || openingValue < 0) { toast.error(t('productionErrors.invalid_input')); return }
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_save_cash_account', {
      p_id: account?.id ?? null,
      p_data: {
        name: name.trim(),
        kind,
        currency: 'UZS',
        bank_name: kind === 'cash' ? null : (bankName.trim() || null),
        account_no: kind === 'cash' ? null : (accountNo.trim() || null),
        mfo: kind === 'bank' ? (mfo.trim() || null) : null,
        is_default_for: defaultFor.length ? defaultFor : null,
        is_active: isActive,
        note: note.trim() || null,
        // Omitted once the account has movements (the RPC refuses a change then).
        ...(locked ? {} : { opening_balance: round2(openingValue), opening_date: openingDate || null }),
      },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    onSaved(typeof data === 'string' ? data : (account?.id ?? ''))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{account ? t('prodCash.accounts.editTitle') : t('prodCash.accounts.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.name')}</span>
            <input value={name} onChange={e => setName(e.target.value)} className={prodFieldCls} />
          </label>
          <div>
            <span className={prodLabelCls}>{t('prodCash.common.type')}</span>
            <Segmented
              options={CASH_ACCOUNT_KINDS.map(k => ({ value: k, label: t(accountKindKey(k)) }))}
              value={kind}
              onChange={setKind}
            />
          </div>
          {kind !== 'cash' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className={prodLabelCls}>{t('prodCash.accounts.bankName')}</span>
                <input value={bankName} onChange={e => setBankName(e.target.value)} className={prodFieldCls} />
              </label>
              <label className="block">
                <span className={prodLabelCls}>{t('prodCash.accounts.accountNo')}</span>
                <input inputMode="numeric" value={accountNo} onChange={e => setAccountNo(e.target.value.replace(/[^\d\s]/g, '').slice(0, 40))} className={cn(prodFieldCls, 'tabular-nums')} />
              </label>
              {kind === 'bank' && (
                <label className="block">
                  <span className={prodLabelCls}>{t('prodCash.accounts.mfo')}</span>
                  <input inputMode="numeric" value={mfo} onChange={e => setMfo(e.target.value.replace(/\D/g, '').slice(0, 20))} placeholder="00000" className={cn(prodFieldCls, 'tabular-nums')} />
                </label>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={prodLabelCls}>{t('prodCash.accounts.openingBalance')}</span>
              <input inputMode="decimal" value={opening} disabled={locked} onChange={e => setOpening(e.target.value)} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('prodCash.accounts.openingDate')}</span>
              <input type="date" value={openingDate} disabled={locked} onChange={e => setOpeningDate(e.target.value)} className={prodFieldCls} />
            </label>
          </div>
          {locked && <p className="-mt-2 text-[12px] text-gray-500 dark:text-gray-400">{t('prodCash.accounts.openingLocked')}</p>}
          <div>
            <span className={prodLabelCls}>{t('prodCash.accounts.defaultFor')}</span>
            <div className="flex flex-wrap gap-2">
              {PROD_PAYMENT_METHODS.map(m => {
                const on = defaultFor.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleDefault(m)}
                    aria-pressed={on}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border',
                      on
                        ? 'bg-white dark:bg-gray-900 shadow-sm border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
                    )}
                  >
                    {t(paymentMethodKey(m))}
                  </button>
                )
              })}
            </div>
            <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodCash.accounts.defaultForHint')}</span>
            {takenFrom.length > 0 && (
              <span className="mt-1 block text-[12px] text-amber-600 dark:text-amber-400">
                {t('prodCash.accounts.defaultMovesFrom')}: {takenFrom.map(a => a.name).join(', ')}
              </span>
            )}
          </div>
          <NoteField value={note} onChange={setNote} />
          <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
            <span>
              <span className="block text-sm text-gray-700 dark:text-gray-300">{t('production.common.active')}</span>
              {account && <span className="block text-[11px] text-gray-400 dark:text-gray-500">{t('prodCash.accounts.deactivateHint')}</span>}
            </span>
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

/** Manual cash-in / cash-out order (prod_create_cash_order). */
export function CashOrderDialog({ open, onOpenChange, accounts, categories, initialDirection = 'in', accountId: fixedAccountId, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: CashAccount[]
  categories: { id: string; name: string }[]
  initialDirection?: 'in' | 'out'
  accountId?: string
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [counterparty, setCounterparty] = useState('')
  const [purpose, setPurpose] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setDirection(initialDirection)
    setAccountId(fixedAccountId ?? defaultAccountFor(accounts, 'cash')?.id ?? '')
    setAmount('')
    setDate(localYmd())
    setCategoryId('')
    setCounterparty('')
    setPurpose('')
    setNote('')
    // accounts deliberately omitted: a background reload must not reset the form.
  }, [open, initialDirection, fixedAccountId]) // eslint-disable-line react-hooks/exhaustive-deps

  const value = round2(parseDecimal(amount))
  const account = accounts.find(a => a.id === accountId)
  const short = direction === 'out' && !!account && value > account.balance
  const errorText = useCashErrorText(accounts)

  async function save() {
    if (!accountId || value <= 0) { toast.error(t('productionErrors.invalid_input')); return }
    if (short) { toast.error(t('prodCash.errors.insufficient_funds')); return }
    setSaving(true)
    const { error } = await createClient().rpc('prod_create_cash_order', {
      p_data: {
        direction,
        account_id: accountId,
        amount: value,
        // doc_date is timestamptz: the chosen local day at the current time.
        doc_date: localDateTimeToIso(date || localYmd(), nowHm()),
        category_id: direction === 'out' ? (categoryId || null) : null,
        counterparty_name: counterparty.trim() || null,
        purpose: purpose.trim() || null,
        note: note.trim() || null,
      },
    })
    setSaving(false)
    if (error) { toast.error(errorText(error)); return }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{direction === 'in' ? t('prodCash.orders.pko') : t('prodCash.orders.rko')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Segmented
            options={[
              { value: 'in' as const, label: t('prodCash.common.in') },
              { value: 'out' as const, label: t('prodCash.common.out') },
            ]}
            value={direction}
            onChange={setDirection}
          />
          <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} outflow={direction === 'out' ? value : undefined} />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={prodLabelCls}>{t('prodCash.common.amount')}</span>
              <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.date')}</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className={prodFieldCls} />
            </label>
          </div>
          {direction === 'out' && (
            <label className="block">
              <span className={prodLabelCls}>{t('prodCash.common.category')}</span>
              <select value={categoryId} onChange={e => setCategoryId(e.target.value)} className={prodFieldCls}>
                <option value="">{t('prodCash.common.noCategory')}</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className={prodLabelCls}>{direction === 'in' ? t('prodCash.orders.receivedFrom') : t('prodCash.orders.issuedTo')}</span>
            <input value={counterparty} onChange={e => setCounterparty(e.target.value)} maxLength={200} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('prodCash.common.purpose')}</span>
            <input value={purpose} onChange={e => setPurpose(e.target.value)} maxLength={200} className={prodFieldCls} />
          </label>
          <NoteField value={note} onChange={setNote} />
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving || !accountId || value <= 0 || short} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Transfer between two accounts (prod_create_cash_transfer). */
export function CashTransferDialog({ open, onOpenChange, accounts, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: CashAccount[]
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setFromId(defaultAccountFor(accounts, 'cash')?.id ?? '')
    setToId('')
    setAmount('')
    setDate(localYmd())
    setNote('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const value = round2(parseDecimal(amount))
  const from = accounts.find(a => a.id === fromId)
  const short = !!from && value > from.balance
  const same = !!fromId && fromId === toId
  const errorText = useCashErrorText(accounts)

  async function save() {
    if (!fromId || !toId || value <= 0) { toast.error(t('productionErrors.invalid_input')); return }
    if (same) { toast.error(t('prodCash.transfers.sameAccount')); return }
    if (short) { toast.error(t('prodCash.errors.insufficient_funds')); return }
    setSaving(true)
    const { error } = await createClient().rpc('prod_create_cash_transfer', {
      p_data: { from_account_id: fromId, to_account_id: toId, amount: value, doc_date: localDateTimeToIso(date || localYmd(), nowHm()), note: note.trim() || null },
    })
    setSaving(false)
    if (error) { toast.error(errorText(error)); return }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('prodCash.transfers.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <AccountSelect accounts={accounts} value={fromId} onChange={setFromId} label={t('prodCash.transfers.from')} outflow={value} />
          <AccountSelect accounts={accounts} value={toId} onChange={setToId} label={t('prodCash.transfers.to')} exclude={fromId} />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={prodLabelCls}>{t('prodCash.common.amount')}</span>
              <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.date')}</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className={prodFieldCls} />
            </label>
          </div>
          {same && <p className="text-[12px] text-red-600 dark:text-red-400">{t('prodCash.transfers.sameAccount')}</p>}
          <NoteField value={note} onChange={setNote} />
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving || !fromId || !toId || same || value <= 0 || short} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Cancel a posted cash order / transfer (owner/admin; the RPC re-checks). */
export function useCancelCashDoc(type: 'cash_order' | 'cash_transfer', onDone: () => void) {
  const { t } = useLanguage()
  const { profile } = useSession()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function cancel(id: string) {
    if (!window.confirm(t(type === 'cash_order' ? 'prodCash.orders.cancelConfirm' : 'prodCash.transfers.cancelConfirm'))) return
    setBusyId(id)
    const { error } = await createClient().rpc('prod_cancel_cash_doc', { p_type: type, p_id: id })
    setBusyId(null)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t(type === 'cash_order' ? 'prodCash.orders.cancelled' : 'prodCash.transfers.cancelled'))
    onDone()
  }

  return { canCancel: canCancelDocuments(profile?.role), cancel, busyId }
}

/** Paper form of a cash order (PKO for 'in', RKO for 'out'). */
export function CashOrderPrint({ order, accountName, categoryName }: { order: CashOrderRow; accountName: string; categoryName: string }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const isIn = order.direction === 'in'
  return (
    <PrintSheet
      title={isIn ? t('prodCash.orders.pko') : t('prodCash.orders.rko')}
      number={order.number}
      signatures={isIn
        ? [t('prodCash.orders.signAccountant'), t('prodCash.orders.signCashier'), t('prodCash.orders.signPayer')]
        : [t('prodCash.orders.signDirector'), t('prodCash.orders.signAccountant'), t('prodCash.orders.signCashier'), t('prodCash.orders.signRecipient')]}
    >
      <PrintFields rows={[
        { label: t('production.common.date'), value: formatDateTime(order.doc_date) },
        { label: t('prodCash.common.account'), value: accountName },
        { label: isIn ? t('prodCash.orders.receivedFrom') : t('prodCash.orders.issuedTo'), value: order.counterparty_name || '—' },
        { label: t('prodCash.common.amount'), value: formatPrice(Number(order.amount)) },
        { label: t('prodCash.common.purpose'), value: order.purpose || '—' },
        ...(isIn ? [] : [{ label: t('prodCash.common.category'), value: categoryName || t('prodCash.common.noCategory') }]),
        ...(order.note ? [{ label: t('production.common.note'), value: order.note }] : []),
        ...(order.status === 'cancelled' ? [{ label: t('production.common.status'), value: t('production.common.statusCancelled') }] : []),
      ]} />
    </PrintSheet>
  )
}
