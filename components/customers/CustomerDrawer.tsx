'use client'

// Customer card: right-side drawer with contact info, murojaat chat and the
// loyalty/VIP/nasiya "Karta" tab. Extracted from the old /customers page so
// the Mijozlar report can open it for any row.

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Loader2, Wallet, ShoppingBag, Percent, Pencil, Check, X, Send, ArrowRightLeft, type LucideIcon } from 'lucide-react'
import { toast } from '@/lib/toast'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { createClient } from '@/lib/supabase/client'
import { formatDate, formatDateTime, formatPhone } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import type { Customer } from '@/lib/types'
import { sendMurojatReply } from '@/app/(dashboard)/customers/actions'
import { useSession } from '@/lib/session/SessionContext'
import { useBranchFilter, useIsMultiBranch } from '@/lib/session/useBranch'
import { branchRpcErrorKey, useBranchColumn } from '@/components/customers/branchUi'
import { MoveCustomerBranchDialog } from '@/components/customers/MoveCustomerBranchDialog'

const KARTA_KPI_CARD_CLS = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4'

function KartaKpiIconBox({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
      <Icon className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
    </div>
  )
}

export interface CustomerRow {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  address: string | null
  status: 'VIP' | 'Regular' | 'New'
  total_purchases: number
  last_purchase_date: string | null
  complaints: string[] | null
  created_at: string
  vip_discount_percent: number | null
  vip_since: string | null
  telegram_id: number | null
  branch_id?: string | null
}

export function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone ?? '',
    email: row.email ?? '',
    address: row.address ?? '',
    status: row.status,
    totalPurchases: Number(row.total_purchases),
    lastPurchaseDate: row.last_purchase_date ?? '',
    createdAt: row.created_at.slice(0, 10),
    purchases: [],
    complaints: row.complaints ?? [],
    vipDiscountPercent: row.vip_discount_percent !== null && row.vip_discount_percent !== undefined
      ? Number(row.vip_discount_percent)
      : null,
    vipSince: row.vip_since ?? null,
    telegramId: row.telegram_id ?? null,
  }
}

// Murojaatlar tab: a real, persisted two-way chat view for the selected
// customer's murojat (mode = 'murojat') thread. Complaint ('shikoyat' mode)
// requests stay on the main /requests ("Shikoyatlar") page only.
//
// Data model (20260806000002_murojat_chat_history.sql): one `requests` row
// per ongoing murojat conversation, with the actual message-by-message
// history threaded under it in `murojat_messages` (both customer- and
// store-authored messages). We load the customer's most recent murojat
// `requests` row (regardless of status, so a resolved thread's history is
// still viewable/reply-able) via a direct company-scoped select, then fetch
// its full message history through the get_murojat_messages() RPC. Replies
// go through sendMurojatReply() (./actions.ts), which persists via
// send_murojat_reply() and then delivers over Telegram in the same action.
interface MurojatRequestRow {
  id: string
}

interface MurojatMessageRow {
  id: string
  sender: string
  message: string
  sent_at: string | null
}

interface SalesHistoryRow {
  id: string
  date: string
  itemCount: number
  listPriceTotal: number
  discount: number
  totalAmount: number
  paid: number
  balls: number
  paymentMethod: string
  isNasiya: boolean
}


export function CustomerDrawer({ customerId, onClose, onChanged }: { customerId: string | null; onClose: () => void; onChanged?: () => void }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const isOpen = customerId !== null
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [detailTab, setDetailTab] = useState('kontakt')
  const applyBranch = useBranchFilter()
  const { canSeeAllBranches } = useSession()
  const isMultiBranch = useIsMultiBranch()
  const { branchName } = useBranchColumn()
  const [customerBranchId, setCustomerBranchId] = useState<string | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)

  // ─── Karta tab state ──────────────────────────────────────────────────────
  const [kartaLoading, setKartaLoading] = useState(false)
  const [kartaLoadedFor, setKartaLoadedFor] = useState<string | null>(null)
  const [nasiyaBalance, setNasiyaBalance] = useState(0)
  const [salesHistory, setSalesHistory] = useState<SalesHistoryRow[]>([])

  const [vipEditing, setVipEditing] = useState(false)
  const [vipEditValue, setVipEditValue] = useState('')
  const [vipSaving, setVipSaving] = useState(false)

  // ─── Murojaatlar tab state (persisted chat thread for this customer) ─────
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [requestsLoadedFor, setRequestsLoadedFor] = useState<string | null>(null)
  const [murojatRequestId, setMurojatRequestId] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<MurojatMessageRow[]>([])
  const [replyText, setReplyText] = useState('')
  const [replySending, setReplySending] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)

  // Load the customer and reset every tab whenever a different one is opened.
  useEffect(() => {
    if (!customerId) return
    let cancelled = false
    setDetailTab('kontakt')
    setKartaLoadedFor(null)
    setKartaLoading(false)
    setNasiyaBalance(0)
    setSalesHistory([])
    setVipEditing(false)
    setRequestsLoadedFor(null)
    setRequestsLoading(false)
    setMurojatRequestId(null)
    setChatMessages([])
    setReplyText('')
    setMoveOpen(false)
    ;(async () => {
      const supabase = createClient()
      const { data } = await supabase.from('customers').select('*').eq('id', customerId).single()
      if (cancelled) return
      setSelectedCustomer(data ? mapCustomer(data as CustomerRow) : null)
      setCustomerBranchId((data as CustomerRow | null)?.branch_id ?? null)
    })()
    return () => { cancelled = true }
  }, [customerId])

  // ─── Karta tab: sales-since-VIP history (task 5) ─────────────────────────
  // Judgment call: sourced from `transactions_net` (not raw `transactions`)
  // since it already accounts for returns via net_amount, avoiding a second,
  // differently-behaved source of truth in the same dialog. "Asl narx"/
  // "Chegirma" use transaction_items.list_price and the transaction's own
  // total_amount (pre-return, authoritative from sell_cart) so the discount
  // shown reflects the sale-time discount only; "To'langan" uses net_amount
  // (post-return) for the same reason.
  const loadSalesHistory = useCallback(async (c: Customer) => {
    const supabase = createClient()

    // VIP customers: history since they became VIP; everyone else: all purchases.
    let txnQuery = applyBranch(supabase
      .from('transactions_net')
      .select('id, date, total_amount, net_amount, payment_method, transaction_items(quantity, list_price)')
      .eq('customer_id', c.id)
      .eq('status', 'completed'))
    if (c.vipSince) txnQuery = txnQuery.gte('date', c.vipSince)

    const [{ data: txnRows, error: txnError }, { data: earnRows }, { data: nasiyaGivenRows }] = await Promise.all([
      txnQuery.order('date', { ascending: false }),
      applyBranch(supabase
        .from('loyalty_transactions')
        .select('transaction_id, amount')
        .eq('customer_id', c.id)
        .eq('type', 'earn')
        .not('transaction_id', 'is', null)),
      applyBranch(supabase
        .from('nasiya_transactions')
        .select('related_transaction_id')
        .eq('customer_id', c.id)
        .eq('type', 'given')
        .not('related_transaction_id', 'is', null)),
    ])

    if (txnError) {
      toast.error(t('common.error'))
      setSalesHistory([])
      return
    }

    const ballsByTxn = new Map<string, number>()
    for (const row of (earnRows ?? []) as { transaction_id: string | null; amount: number }[]) {
      if (!row.transaction_id) continue
      ballsByTxn.set(row.transaction_id, (ballsByTxn.get(row.transaction_id) ?? 0) + Number(row.amount))
    }

    // Judgment call: `transactions.payment_method` never contains a "Nasiya"
    // value (POS only ever writes Naqd/Karta/Click/Payme, see pos/page.tsx's
    // PAYMENT_METHODS) — a nasiya sale is still recorded with one of those
    // four methods for whatever was paid up front. Whether a sale is "on
    // credit" is instead detected via nasiya_transactions.related_transaction_id
    // (set by give_nasiya when tied to a specific sale).
    const nasiyaTxnIds = new Set(
      ((nasiyaGivenRows ?? []) as { related_transaction_id: string | null }[])
        .map(r => r.related_transaction_id)
        .filter((id): id is string => !!id),
    )

    const rows: SalesHistoryRow[] = (txnRows ?? []).map(row => {
      const items = (row.transaction_items ?? []) as { quantity: number; list_price: number }[]
      const itemCount = items.reduce((s, i) => s + Number(i.quantity), 0)
      const listPriceTotal = items.reduce((s, i) => s + Number(i.list_price) * Number(i.quantity), 0)
      const totalAmount = Number(row.total_amount)
      const id = row.id ?? ''
      return {
        id,
        date: row.date ?? '',
        itemCount,
        listPriceTotal,
        discount: Math.max(0, listPriceTotal - totalAmount),
        totalAmount,
        paid: Number(row.net_amount),
        balls: ballsByTxn.get(id) ?? 0,
        paymentMethod: row.payment_method ?? '',
        isNasiya: nasiyaTxnIds.has(id),
      }
    })

    setSalesHistory(rows)
  }, [t, applyBranch])

  const loadKarta = useCallback(async (c: Customer) => {
    setKartaLoading(true)
    setKartaLoadedFor(c.id)
    const supabase = createClient()

    const { data: nasiyaBalanceData, error: nasiyaBalanceError } = await supabase.rpc(
      'get_customer_nasiya_balance', { p_customer_id: c.id },
    )

    if (nasiyaBalanceError) {
      toast.error(t('common.error'))
    }

    setNasiyaBalance(Number(nasiyaBalanceData ?? 0))

    await loadSalesHistory(c)

    setKartaLoading(false)
  }, [t, loadSalesHistory])

  useEffect(() => {
    if (detailTab !== 'karta' || !selectedCustomer) return
    if (kartaLoadedFor === selectedCustomer.id) return
    loadKarta(selectedCustomer)
  }, [detailTab, selectedCustomer, kartaLoadedFor, loadKarta])

  const loadMurojatMessages = useCallback(async (requestId: string) => {
    const supabase = createClient()
    const { data, error } = await supabase.rpc('get_murojat_messages', { p_request_id: requestId })
    if (error) {
      toast.error(t('common.error'))
      return
    }
    setChatMessages((data ?? []) as MurojatMessageRow[])
  }, [t])

  const loadMurojatThread = useCallback(async (c: Customer) => {
    setRequestsLoading(true)
    setRequestsLoadedFor(c.id)
    const supabase = createClient()

    // Most recent murojat thread for this customer, regardless of status -
    // a resolved thread's history should still be viewable (and reply-able,
    // which simply continues the same thread server-side).
    const { data: request, error } = await supabase
      .from('requests')
      .select('id')
      .eq('customer_id', c.id)
      .eq('mode', 'murojat')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      toast.error(t('common.error'))
      setMurojatRequestId(null)
      setChatMessages([])
      setRequestsLoading(false)
      return
    }

    const row = request as MurojatRequestRow | null
    setMurojatRequestId(row?.id ?? null)

    if (row?.id) {
      await loadMurojatMessages(row.id)
    } else {
      setChatMessages([])
    }
    setRequestsLoading(false)
  }, [t, loadMurojatMessages])

  useEffect(() => {
    if (detailTab !== 'murojaatlar' || !selectedCustomer) return
    if (requestsLoadedFor === selectedCustomer.id) return
    loadMurojatThread(selectedCustomer)
  }, [detailTab, selectedCustomer, requestsLoadedFor, loadMurojatThread])

  async function sendReply(customerId: string) {
    const trimmed = replyText.trim()
    if (!trimmed) return

    if (!murojatRequestId) {
      // No murojat thread exists yet for this customer (they haven't
      // messaged the bot / been classified as murojat yet) - nothing to
      // attach a reply to.
      toast.error(t('customers.detail.replyError'))
      return
    }

    setReplySending(true)

    // Optimistic bubble for immediate feedback, reconciled with the real
    // persisted row below (same UX principle as before, now backed by
    // send_murojat_reply()/murojat_messages instead of being purely local).
    const optimisticId = crypto.randomUUID()
    setChatMessages(prev => [...prev, {
      id: optimisticId,
      sender: 'store',
      message: trimmed,
      sent_at: new Date().toISOString(),
    }])
    setReplyText('')

    const result = await sendMurojatReply(murojatRequestId, customerId, trimmed)
    setReplySending(false)

    if ('error' in result) {
      // Revert the optimistic bubble on failure.
      setChatMessages(prev => prev.filter(m => m.id !== optimisticId))
      toast.error(t('customers.detail.replyError'))
      return
    }

    toast.success(t('customers.detail.replySuccess'))
    // Reconcile with the real persisted history (real id/sent_at).
    await loadMurojatMessages(murojatRequestId)
  }

  // Keep the chat scrolled to the newest message whenever the thread grows
  // (initial load, an optimistic reply, or reconciliation).
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages])

  async function refreshSelectedCustomer(id: string) {
    const supabase = createClient()
    const { data } = await supabase.from('customers').select('*').eq('id', id).single()
    if (data) {
      setSelectedCustomer(mapCustomer(data as CustomerRow))
      setCustomerBranchId((data as CustomerRow).branch_id ?? null)
    }
    onChanged?.()
  }

  async function saveVipDiscount() {
    if (!selectedCustomer) return
    const trimmed = vipEditValue.trim()
    const num = trimmed === '' ? 0 : Number(trimmed)
    if (Number.isNaN(num) || num < 0 || num > 100) {
      toast.error(t('customers.karta.requiredAmountError'))
      return
    }
    setVipSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('set_customer_vip', {
      p_customer_id: selectedCustomer.id,
      p_vip_discount_percent: num,
    })
    setVipSaving(false)

    if (error) {
      toast.error(t(branchRpcErrorKey(error.message) ?? 'common.error'))
      return
    }

    toast.success(t('customers.karta.vipUpdateSuccess'))
    setVipEditing(false)
    await refreshSelectedCustomer(selectedCustomer.id)
  }

  function initials(name: string) {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  }

  // Judgment call: when a customer has never been VIP (vip_since is NULL),
  // "Jami xarid" falls back to the all-time totalPurchases already tracked
  // on the customers row, since there is no meaningful "since" date to sum
  // from — the alternative (a dash/placeholder) seemed less useful here.
  const totalPurchaseDisplay = selectedCustomer
    ? (selectedCustomer.vipSince
        ? salesHistory.reduce((s, r) => s + r.totalAmount, 0)
        : selectedCustomer.totalPurchases)
    : 0

  return (
      <div
        className={cn(
          'fixed inset-0 z-50 transition-opacity duration-300',
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        aria-hidden={!isOpen}
      >
        {/* Dimmed backdrop — clicking it closes the panel */}
        <div
          className="absolute inset-0 bg-black/30"
          onClick={() => onClose()}
        />

        {/* Panel — slides in from the right edge */}
        <div
          className={cn(
            'absolute inset-y-0 right-0 flex h-full w-1/2 flex-col overflow-hidden border-l border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg transition-transform duration-300 ease-in-out',
            isOpen ? 'translate-x-0' : 'translate-x-full',
          )}
        >
          {selectedCustomer && (
            <>
              <button
                onClick={() => onClose()}
                className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </button>

              <div className="shrink-0 p-4 pr-12">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {initials(selectedCustomer.fullName)}
                  </div>
                  <div>
                    <p className="text-base font-medium text-gray-900 dark:text-gray-100">{selectedCustomer.fullName}</p>
                    <div className="mt-1">
                      <MiniBadge status={selectedCustomer.status} />
                    </div>
                  </div>
                  {isMultiBranch && canSeeAllBranches && (
                    <button
                      onClick={() => setMoveOpen(true)}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                      {t('branchCustomers.moveAction')}
                    </button>
                  )}
                </div>
              </div>

              <Tabs value={detailTab} onValueChange={setDetailTab} className="flex-1 min-h-0 flex flex-col px-4 pb-4">
                <TabsList className="shrink-0" variant="underline">
                  <TabsTrigger value="kontakt">{t('customers.tabs.contact')}</TabsTrigger>
                  <TabsTrigger value="murojaatlar">{t('customers.tabs.complaints')}</TabsTrigger>
                  <TabsTrigger value="karta">{t('customers.tabs.karta')}</TabsTrigger>
                </TabsList>

                <div className="flex-1 overflow-y-auto">
                  <TabsContent value="kontakt" className="mt-4 space-y-0">
                    {[
                      [t('customers.detail.phone'), formatPhone(selectedCustomer.phone)],
                      [t('customers.detail.email'), selectedCustomer.email || '—'],
                      [t('customers.detail.address'), selectedCustomer.address || '—'],
                      [t('customers.detail.registeredAt'), formatDate(selectedCustomer.createdAt)],
                      [t('customers.detail.lastPurchase'), selectedCustomer.lastPurchaseDate ? formatDate(selectedCustomer.lastPurchaseDate) : '—'],
                      [t('customers.detail.totalPurchases'), formatPrice(selectedCustomer.totalPurchases)],
                      ...(isMultiBranch ? [[t('branchCustomers.currentBranch'), branchName(customerBranchId)]] : []),
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <span className="text-sm text-gray-400 dark:text-gray-500">{label}</span>
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</span>
                      </div>
                    ))}
                  </TabsContent>

                  <TabsContent value="murojaatlar" className="mt-4">
                    {requestsLoading ? (
                      <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">
                        <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                        {t('common.loading')}
                      </p>
                    ) : chatMessages.length === 0 ? (
                      <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('customers.detail.noComplaints')}</p>
                    ) : (
                      <div
                        ref={chatScrollRef}
                        className="flex h-96 flex-col gap-3 overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 p-3"
                      >
                        {/* Full persisted thread, oldest first - real data from
                            get_murojat_messages() (murojat_messages table). */}
                        {chatMessages.map(m => (
                          <div key={m.id} className={m.sender === 'store' ? 'flex justify-end' : 'flex justify-start'}>
                            <div className="max-w-[80%]">
                              {m.sender === 'store' ? (
                                <div className="rounded-2xl rounded-br-sm bg-blue-600 dark:bg-blue-700 px-3 py-2 text-sm text-white">
                                  {m.message}
                                </div>
                              ) : (
                                <div className="rounded-2xl rounded-bl-sm border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
                                  {m.message}
                                </div>
                              )}
                              <p className={m.sender === 'store' ? 'mt-1 text-right text-[11px] text-gray-400 dark:text-gray-500' : 'mt-1 text-[11px] text-gray-400 dark:text-gray-500'}>
                                {m.sent_at ? formatDateTime(m.sent_at) : ''}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Reply input, pinned below the scrollable thread. */}
                    <div className="mt-3 flex items-center gap-1.5">
                      <input
                        type="text"
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') sendReply(selectedCustomer.id) }}
                        placeholder={t('customers.detail.replyPlaceholder')}
                        className="flex-1 h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900 transition-colors"
                      />
                      <button
                        onClick={() => sendReply(selectedCustomer.id)}
                        disabled={replySending || !replyText.trim()}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 hover:bg-slate-800 text-white transition-colors disabled:opacity-60"
                      >
                        {replySending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    </div>
                  </TabsContent>

                  <TabsContent value="karta" className="mt-4 space-y-5">
                    {kartaLoading ? (
                      <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">
                        <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                        {t('common.loading')}
                      </p>
                    ) : (
                      <>
                        {/* KPI cards */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          <div className={KARTA_KPI_CARD_CLS}>
                            <div className="flex items-start justify-between mb-3">
                              <KartaKpiIconBox icon={Wallet} />
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t('customers.karta.nasiyaBalance')}</p>
                            <p className={cn(
                              'text-lg font-semibold tabular-nums whitespace-nowrap',
                              nasiyaBalance > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100',
                            )}>
                              {formatPrice(nasiyaBalance)}
                            </p>
                          </div>

                          <div className={KARTA_KPI_CARD_CLS}>
                            <div className="flex items-start justify-between mb-3">
                              <KartaKpiIconBox icon={ShoppingBag} />
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t('customers.karta.totalPurchase')}</p>
                            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">
                              {formatPrice(totalPurchaseDisplay)}
                            </p>
                          </div>

                          <div className={KARTA_KPI_CARD_CLS}>
                            <div className="flex items-start justify-between mb-3">
                              <KartaKpiIconBox icon={Percent} />
                              {!vipEditing && (
                                <button
                                  onClick={() => {
                                    setVipEditValue(selectedCustomer.vipDiscountPercent ? String(selectedCustomer.vipDiscountPercent) : '')
                                    setVipEditing(true)
                                  }}
                                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                                >
                                  <Pencil className="h-3 w-3" />
                                  {t('customers.karta.change')}
                                </button>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t('customers.karta.vipDiscount')}</p>
                            {vipEditing ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  autoFocus
                                  value={vipEditValue}
                                  onChange={e => setVipEditValue(e.target.value)}
                                  className="w-16 h-8 rounded-lg border border-gray-200 dark:border-gray-700 px-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900 transition-colors"
                                />
                                <button
                                  onClick={saveVipDiscount}
                                  disabled={vipSaving}
                                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-60"
                                >
                                  {vipSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                </button>
                                <button
                                  onClick={() => setVipEditing(false)}
                                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">
                                {selectedCustomer.vipDiscountPercent && selectedCustomer.vipDiscountPercent > 0
                                  ? `${selectedCustomer.vipDiscountPercent}%`
                                  : t('customers.karta.vipNotSet')}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Navigation to standalone Sotuv tarixi / Qarzdorlik
                            tarixi pages — both tables + the nasiya give/repay
                            modals now live on their own routes since they
                            outgrew a tab inside this drawer. */}
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Link
                            href={`/customers/${selectedCustomer.id}/sotuv-tarixi`}
                            className="flex-1 text-center rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 text-[13px] font-medium transition-colors"
                          >
                            {t('customers.karta.salesHistory')}
                          </Link>
                          <Link
                            href={`/customers/${selectedCustomer.id}/qarzdorlik-tarixi`}
                            className="flex-1 text-center rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 text-[13px] font-medium transition-colors"
                          >
                            {t('customers.karta.nasiyaHistory')}
                          </Link>
                        </div>
                      </>
                    )}
                  </TabsContent>
                </div>
              </Tabs>

              {isMultiBranch && canSeeAllBranches && (
                <MoveCustomerBranchDialog
                  open={moveOpen}
                  onOpenChange={setMoveOpen}
                  customerId={selectedCustomer.id}
                  customerName={selectedCustomer.fullName}
                  currentBranchId={customerBranchId}
                  onMoved={() => {
                    // Karta data is branch-filtered; force a reload for the new branch.
                    setKartaLoadedFor(null)
                    setRequestsLoadedFor(null)
                    refreshSelectedCustomer(selectedCustomer.id)
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
  )
}
