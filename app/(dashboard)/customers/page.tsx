'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  UserPlus, Search, Eye, Loader2, Gift, Wallet, ShoppingBag, Percent, Pencil, Check, X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Pagination } from '@/components/ui/Pagination'
import { MiniBadge } from '@/components/ui/MiniBadge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { formatDate, formatPhone } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import type { Customer, Purchase } from '@/lib/types'

const ITEMS_PER_PAGE = 10
const STATUS_FILTERS = ['Barchasi', 'VIP', 'Regular', 'New'] as const
const LOYALTY_FILTERS = ['all', 'earn', 'redeem'] as const
const SALES_PAYMENT_FILTERS = ['Barchasi', 'Naqd', 'Karta', 'Click', 'Payme', 'Nasiya'] as const

const PILL_CLS = (active: boolean) =>
  cn(
    'px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors',
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
  )

const DATE_INPUT_CLS = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

const KARTA_KPI_CARD_CLS = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4'

function KartaKpiIconBox({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
      <Icon className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
    </div>
  )
}

interface CustomerRow {
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
}

function mapCustomer(row: CustomerRow): Customer {
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
  }
}

interface LoyaltyTxnRow {
  id: string
  created_at: string
  type: 'earn' | 'redeem'
  amount: number
  note: string | null
}

interface NasiyaTxnRow {
  id: string
  created_at: string
  type: 'given' | 'repaid'
  amount: number
  note: string | null
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

export default function CustomersPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('Barchasi')
  const [page, setPage] = useState(1)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [detailTab, setDetailTab] = useState('kontakt')
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [purchasesLoading, setPurchasesLoading] = useState(false)
  const [form, setForm] = useState({
    fullName: '', phone: '', email: '', address: '', status: 'New' as Customer['status'],
  })

  // ─── Karta tab state ──────────────────────────────────────────────────────
  const [kartaLoading, setKartaLoading] = useState(false)
  const [kartaLoadedFor, setKartaLoadedFor] = useState<string | null>(null)
  const [loyaltyBalance, setLoyaltyBalance] = useState(0)
  const [redeemRate, setRedeemRate] = useState<number | null>(null)
  const [nasiyaBalance, setNasiyaBalance] = useState(0)
  const [loyaltyHistory, setLoyaltyHistory] = useState<LoyaltyTxnRow[]>([])
  const [loyaltyFilter, setLoyaltyFilter] = useState<typeof LOYALTY_FILTERS[number]>('all')
  const [nasiyaHistory, setNasiyaHistory] = useState<NasiyaTxnRow[]>([])
  const [salesHistory, setSalesHistory] = useState<SalesHistoryRow[]>([])
  const [salesDateFrom, setSalesDateFrom] = useState('')
  const [salesDateTo, setSalesDateTo] = useState('')
  const [salesPaymentFilter, setSalesPaymentFilter] = useState<typeof SALES_PAYMENT_FILTERS[number]>('Barchasi')

  const [vipEditing, setVipEditing] = useState(false)
  const [vipEditValue, setVipEditValue] = useState('')
  const [vipSaving, setVipSaving] = useState(false)

  const [giveNasiyaOpen, setGiveNasiyaOpen] = useState(false)
  const [giveAmount, setGiveAmount] = useState('')
  const [giveNote, setGiveNote] = useState('')
  const [giving, setGiving] = useState(false)

  const [repayNasiyaOpen, setRepayNasiyaOpen] = useState(false)
  const [repayAmount, setRepayAmount] = useState('')
  const [repayNote, setRepayNote] = useState('')
  const [repaying, setRepaying] = useState(false)

  const fetchCustomers = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      toast.error(t('common.error'))
      setCustomers([])
    } else {
      setCustomers((data ?? []).map(row => mapCustomer(row as CustomerRow)))
    }
    setLoading(false)
  }, [t])

  useEffect(() => { fetchCustomers() }, [fetchCustomers])

  const filtered = useMemo(() => {
    let list = customers
    if (filter !== 'Barchasi') list = list.filter(c => c.status === filter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c => c.fullName.toLowerCase().includes(q) || c.phone.includes(q))
    }
    return list
  }, [customers, filter, search])

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE)
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  async function openDetail(c: Customer) {
    setSelectedCustomer(c)
    setDetailTab('kontakt')
    setIsDetailOpen(true)
    setPurchases([])
    setPurchasesLoading(true)

    // Reset Karta tab state for the newly opened customer — lazily (re)loaded
    // the first time the "karta" tab is actually selected, see the effect below.
    setKartaLoadedFor(null)
    setKartaLoading(false)
    setLoyaltyBalance(0)
    setRedeemRate(null)
    setNasiyaBalance(0)
    setLoyaltyHistory([])
    setLoyaltyFilter('all')
    setNasiyaHistory([])
    setSalesHistory([])
    setSalesDateFrom('')
    setSalesDateTo('')
    setSalesPaymentFilter('Barchasi')
    setVipEditing(false)

    const supabase = createClient()
    const { data, error } = await supabase
      .from('transactions_net')
      .select('id, date, net_amount, payment_method, transaction_items(product_name)')
      .eq('customer_id', c.id)
      .eq('status', 'completed')
      .order('date', { ascending: false })

    if (error) {
      toast.error(t('common.error'))
    } else {
      setPurchases((data ?? []).map(txn => ({
        id: txn.id ?? '',
        date: txn.date ?? '',
        amount: Number(txn.net_amount),
        items: (txn.transaction_items ?? []).map((i: { product_name: string | null }) => i.product_name ?? ''),
        paymentMethod: txn.payment_method ?? '',
      })))
    }
    setPurchasesLoading(false)
  }

  // ─── Karta tab: sales-since-VIP history (task 5) ─────────────────────────
  // Judgment call: sourced from `transactions_net` (not raw `transactions`),
  // matching the existing "xaridlar" tab's precedent above — it already
  // accounts for returns via net_amount, so this stays consistent instead of
  // introducing a second, differently-behaved source of truth in the same
  // dialog. "Asl narx"/"Chegirma" use transaction_items.list_price and the
  // transaction's own total_amount (pre-return, authoritative from
  // sell_cart) so the discount shown reflects the sale-time discount only;
  // "To'langan" uses net_amount (post-return) for consistency with the
  // purchases tab.
  const loadSalesHistory = useCallback(async (c: Customer) => {
    if (!c.vipSince) {
      setSalesHistory([])
      return
    }
    const supabase = createClient()

    const [{ data: txnRows, error: txnError }, { data: earnRows }, { data: nasiyaGivenRows }] = await Promise.all([
      supabase
        .from('transactions_net')
        .select('id, date, total_amount, net_amount, payment_method, transaction_items(quantity, list_price)')
        .eq('customer_id', c.id)
        .eq('status', 'completed')
        .gte('date', c.vipSince)
        .order('date', { ascending: false }),
      supabase
        .from('loyalty_transactions')
        .select('transaction_id, amount')
        .eq('customer_id', c.id)
        .eq('type', 'earn')
        .not('transaction_id', 'is', null),
      supabase
        .from('nasiya_transactions')
        .select('related_transaction_id')
        .eq('customer_id', c.id)
        .eq('type', 'given')
        .not('related_transaction_id', 'is', null),
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
  }, [t])

  const loadKarta = useCallback(async (c: Customer) => {
    setKartaLoading(true)
    setKartaLoadedFor(c.id)
    const supabase = createClient()

    const [
      { data: loyaltyBalanceData, error: loyaltyBalanceError },
      { data: nasiyaBalanceData, error: nasiyaBalanceError },
      { data: configData },
      { data: loyaltyRows, error: loyaltyRowsError },
      { data: nasiyaRows, error: nasiyaRowsError },
    ] = await Promise.all([
      supabase.rpc('get_customer_loyalty_balance', { p_customer_id: c.id }),
      supabase.rpc('get_customer_nasiya_balance', { p_customer_id: c.id }),
      supabase.from('loyalty_config').select('redeem_rate').maybeSingle(),
      supabase.from('loyalty_transactions').select('*').eq('customer_id', c.id).order('created_at', { ascending: false }),
      supabase.from('nasiya_transactions').select('*').eq('customer_id', c.id).order('created_at', { ascending: false }),
    ])

    if (loyaltyBalanceError || nasiyaBalanceError || loyaltyRowsError || nasiyaRowsError) {
      toast.error(t('common.error'))
    }

    setLoyaltyBalance(Number(loyaltyBalanceData ?? 0))
    setNasiyaBalance(Number(nasiyaBalanceData ?? 0))
    setRedeemRate(configData?.redeem_rate != null ? Number(configData.redeem_rate) : null)
    setLoyaltyHistory((loyaltyRows ?? []) as LoyaltyTxnRow[])
    setNasiyaHistory((nasiyaRows ?? []) as NasiyaTxnRow[])

    await loadSalesHistory(c)

    setKartaLoading(false)
  }, [t, loadSalesHistory])

  useEffect(() => {
    if (detailTab !== 'karta' || !selectedCustomer) return
    if (kartaLoadedFor === selectedCustomer.id) return
    loadKarta(selectedCustomer)
  }, [detailTab, selectedCustomer, kartaLoadedFor, loadKarta])

  async function refreshSelectedCustomer(id: string) {
    const supabase = createClient()
    const { data } = await supabase.from('customers').select('*').eq('id', id).single()
    if (data) setSelectedCustomer(mapCustomer(data as CustomerRow))
    fetchCustomers()
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
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }

    toast.success(t('customers.karta.vipUpdateSuccess'))
    setVipEditing(false)
    await refreshSelectedCustomer(selectedCustomer.id)
  }

  async function reloadNasiya(customerId: string) {
    const supabase = createClient()
    const [{ data: balanceData }, { data: rows }] = await Promise.all([
      supabase.rpc('get_customer_nasiya_balance', { p_customer_id: customerId }),
      supabase.from('nasiya_transactions').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }),
    ])
    setNasiyaBalance(Number(balanceData ?? 0))
    setNasiyaHistory((rows ?? []) as NasiyaTxnRow[])
  }

  async function submitGiveNasiya() {
    if (!selectedCustomer) return
    const amt = Number(giveAmount)
    if (!giveAmount.trim() || Number.isNaN(amt) || amt <= 0) {
      toast.error(t('customers.karta.requiredAmountError'))
      return
    }
    setGiving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('give_nasiya', {
      p_customer_id: selectedCustomer.id,
      p_amount: amt,
      p_related_transaction_id: null,
      p_note: giveNote.trim() || null,
    })
    setGiving(false)

    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }

    toast.success(t('customers.karta.giveSuccess'))
    setGiveNasiyaOpen(false)
    setGiveAmount('')
    setGiveNote('')
    await reloadNasiya(selectedCustomer.id)
  }

  async function submitRepayNasiya() {
    if (!selectedCustomer) return
    const amt = Number(repayAmount)
    if (!repayAmount.trim() || Number.isNaN(amt) || amt <= 0) {
      toast.error(t('customers.karta.requiredAmountError'))
      return
    }
    setRepaying(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('repay_nasiya', {
      p_customer_id: selectedCustomer.id,
      p_amount: amt,
      p_note: repayNote.trim() || null,
    })
    setRepaying(false)

    if (error) {
      // repay_nasiya hard-rejects an over-repayment with a message containing
      // this exact substring — surfaced as a specific toast rather than the
      // generic error, same pattern as pos/page.tsx's handleSell branches.
      if (error.message.includes('exceeds outstanding nasiya balance')) {
        toast.error(t('customers.karta.repayExceedsError'))
      } else if (error.message.includes('forbidden')) {
        toast.error(t('common.forbidden'))
      } else {
        toast.error(t('common.error'))
      }
      return
    }

    toast.success(t('customers.karta.repaySuccess'))
    setRepayNasiyaOpen(false)
    setRepayAmount('')
    setRepayNote('')
    await reloadNasiya(selectedCustomer.id)
  }

  async function addCustomer() {
    if (!form.fullName.trim() || !form.phone.trim()) {
      toast.error(t('customers.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()

    const { error } = await supabase.rpc('create_customer', {
      p_full_name: form.fullName.trim(),
      p_phone: form.phone.trim(),
      p_email: form.email.trim() || null,
      p_address: form.address.trim() || null,
      p_status: form.status,
    })

    setSaving(false)

    if (error) {
      toast.error(t('common.error'))
      return
    }

    setForm({ fullName: '', phone: '', email: '', address: '', status: 'New' })
    setIsAddOpen(false)
    toast.success(t('customers.addSuccess'))
    fetchCustomers()
  }

  function initials(name: string) {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  }

  const filteredLoyaltyHistory = useMemo(() => {
    if (loyaltyFilter === 'all') return loyaltyHistory
    return loyaltyHistory.filter(r => r.type === loyaltyFilter)
  }, [loyaltyHistory, loyaltyFilter])

  const filteredSalesHistory = useMemo(() => {
    let list = salesHistory
    if (salesDateFrom) list = list.filter(r => r.date >= salesDateFrom)
    if (salesDateTo) list = list.filter(r => r.date <= salesDateTo)
    if (salesPaymentFilter !== 'Barchasi') {
      list = salesPaymentFilter === 'Nasiya'
        ? list.filter(r => r.isNasiya)
        : list.filter(r => r.paymentMethod === salesPaymentFilter && !r.isNasiya)
    }
    return list
  }, [salesHistory, salesDateFrom, salesDateTo, salesPaymentFilter])

  const salesTotals = useMemo(() => filteredSalesHistory.reduce((acc, r) => ({
    itemCount: acc.itemCount + r.itemCount,
    listPriceTotal: acc.listPriceTotal + r.listPriceTotal,
    discount: acc.discount + r.discount,
    paid: acc.paid + r.paid,
    balls: acc.balls + r.balls,
  }), { itemCount: 0, listPriceTotal: 0, discount: 0, paid: 0, balls: 0 }), [filteredSalesHistory])

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
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('customers.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{customers.length} {t('customers.countSuffix')}</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <UserPlus className="h-3.5 w-3.5" />
          {t('customers.addNew')}
        </button>
      </div>

      {/* Search + filter row */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder={t('customers.searchPlaceholder')}
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-4 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
          />
        </div>
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1) }}
              className={`px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                filter === f
                  ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {f === 'Barchasi' ? t('customers.filterAll') : f === 'New' ? t('customers.filterNew') : f}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.customer')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.phone')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.totalPurchases')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.lastPurchase')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.status')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.action')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('customers.notFound')}
                  </td>
                </tr>
              ) : paginated.map((c, i) => (
                <tr
                  key={c.id}
                  onClick={() => openDetail(c)}
                  className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                >
                  <td className="w-10 px-4 py-3" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
                        {initials(c.fullName)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.fullName}</p>
                        {c.email && <p className="text-[11px] text-gray-400 dark:text-gray-500">{c.email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{formatPhone(c.phone)}</td>
                  <td className="px-4 py-3 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">
                    {formatPrice(c.totalPurchases)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {c.lastPurchaseDate ? formatDate(c.lastPurchaseDate) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <MiniBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={e => { e.stopPropagation(); openDetail(c) }}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Eye className="h-3 w-3" />
                      {t('customers.view')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={filtered.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setPage}
        />
      </div>

      {/* Customer Detail Modal */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        {/* Judgment call: widened from sm:max-w-lg to sm:max-w-3xl to fit the
            Karta tab's 4-card KPI row + 3 tables — matches the widest
            existing precedent in this codebase (components/mahsulotlar/ImportModal.tsx),
            and reuses FeatureModal's max-h-[85vh] overflow-hidden flex flex-col
            pattern so a tall Karta tab scrolls internally instead of
            overflowing the viewport. The other 3 tabs are short enough that
            this has no visible effect on them. */}
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          {selectedCustomer && (
            <>
              <DialogHeader className="shrink-0">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {initials(selectedCustomer.fullName)}
                  </div>
                  <div>
                    <DialogTitle className="text-base">{selectedCustomer.fullName}</DialogTitle>
                    <div className="mt-1">
                      <MiniBadge status={selectedCustomer.status} />
                    </div>
                  </div>
                </div>
              </DialogHeader>

              <Tabs value={detailTab} onValueChange={setDetailTab} className="flex-1 min-h-0 flex flex-col">
                <TabsList className="shrink-0">
                  <TabsTrigger value="kontakt">{t('customers.tabs.contact')}</TabsTrigger>
                  <TabsTrigger value="xaridlar">{t('customers.tabs.purchases')}</TabsTrigger>
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
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <span className="text-sm text-gray-400 dark:text-gray-500">{label}</span>
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</span>
                      </div>
                    ))}
                  </TabsContent>

                  <TabsContent value="xaridlar" className="mt-4">
                    {purchasesLoading ? (
                      <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">
                        <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                        {t('common.loading')}
                      </p>
                    ) : purchases.length === 0 ? (
                      <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('customers.detail.noPurchases')}</p>
                    ) : (
                      <div className="space-y-1.5 max-h-64 overflow-y-auto">
                        {purchases.slice(0, 20).map(p => (
                          <div key={p.id} className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2.5">
                            <div>
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.items[0] ?? '—'}</p>
                              <p className="text-[11px] text-gray-400 dark:text-gray-500">{formatDate(p.date)} · {p.paymentMethod}</p>
                            </div>
                            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(p.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="murojaatlar" className="mt-4">
                    {selectedCustomer.complaints.length === 0 ? (
                      <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('customers.detail.noComplaints')}</p>
                    ) : (
                      <div className="space-y-1.5 max-h-64 overflow-y-auto">
                        {selectedCustomer.complaints.map((c, idx) => (
                          <div key={idx} className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-700 dark:text-gray-300">
                            {c}
                          </div>
                        ))}
                      </div>
                    )}
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
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className={KARTA_KPI_CARD_CLS}>
                            <div className="flex items-start justify-between mb-3">
                              <KartaKpiIconBox icon={Gift} />
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t('customers.karta.ballBalance')}</p>
                            <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{loyaltyBalance}</p>
                            {redeemRate != null && (
                              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{formatPrice(loyaltyBalance * redeemRate)}</p>
                            )}
                          </div>

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
                                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 hover:bg-slate-800 text-white transition-colors disabled:opacity-60"
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

                        {/* Ball tarixi */}
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{t('customers.karta.loyaltyHistory')}</p>
                          <div className="flex gap-1.5 mb-3">
                            {LOYALTY_FILTERS.map(f => (
                              <button key={f} onClick={() => setLoyaltyFilter(f)} className={PILL_CLS(loyaltyFilter === f)}>
                                {f === 'all' ? t('customers.karta.filterAll') : f === 'earn' ? t('customers.karta.filterEarn') : t('customers.karta.filterRedeem')}
                              </button>
                            ))}
                          </div>
                          <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
                            <div className="max-h-56 overflow-y-auto">
                              <table className="w-full">
                                <thead className="bg-gray-50 dark:bg-gray-800/50 sticky top-0">
                                  <tr className="border-b border-gray-100 dark:border-gray-800">
                                    <th className="px-3 py-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.date')}</th>
                                    <th className="px-3 py-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.reason')}</th>
                                    <th className="px-3 py-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.ball')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {filteredLoyaltyHistory.length === 0 ? (
                                    <tr>
                                      <td colSpan={3} className="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                                        {t('customers.karta.noLoyaltyHistory')}
                                      </td>
                                    </tr>
                                  ) : filteredLoyaltyHistory.map(r => (
                                    <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                                      <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">{formatDate(r.created_at)}</td>
                                      <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">{r.note || '—'}</td>
                                      <td className={cn(
                                        'px-3 py-2 text-sm text-right font-medium tabular-nums',
                                        r.type === 'earn' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
                                      )}>
                                        {r.type === 'earn' ? '+' : '−'}{Number(r.amount)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>

                        {/* Nasiya tarixi */}
                        <div>
                          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('customers.karta.nasiyaHistory')}</p>
                              <span className={cn(
                                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                                nasiyaBalance > 0
                                  ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
                              )}>
                                {formatPrice(nasiyaBalance)}
                              </span>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => setGiveNasiyaOpen(true)}
                                className="rounded-lg bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 text-[13px] font-medium transition-colors"
                              >
                                {t('customers.karta.giveNasiya')}
                              </button>
                              <button
                                onClick={() => setRepayNasiyaOpen(true)}
                                className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[13px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                              >
                                {t('customers.karta.acceptPayment')}
                              </button>
                            </div>
                          </div>
                          <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
                            <div className="max-h-56 overflow-y-auto">
                              <table className="w-full">
                                <thead className="bg-gray-50 dark:bg-gray-800/50 sticky top-0">
                                  <tr className="border-b border-gray-100 dark:border-gray-800">
                                    <th className="px-3 py-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.date')}</th>
                                    <th className="px-3 py-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.type')}</th>
                                    <th className="px-3 py-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.amount')}</th>
                                    <th className="px-3 py-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.note')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {nasiyaHistory.length === 0 ? (
                                    <tr>
                                      <td colSpan={4} className="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                                        {t('customers.karta.noNasiyaHistory')}
                                      </td>
                                    </tr>
                                  ) : nasiyaHistory.map(r => (
                                    <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                                      <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">{formatDate(r.created_at)}</td>
                                      <td className="px-3 py-2">
                                        <span className={cn(
                                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                                          r.type === 'given'
                                            ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                                            : 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
                                        )}>
                                          {r.type === 'given' ? t('customers.karta.given') : t('customers.karta.repaid')}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">
                                        {formatPrice(Number(r.amount))}
                                      </td>
                                      <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">{r.note || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>

                        {/* Sotiv tarixi */}
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{t('customers.karta.salesHistory')}</p>
                          {!selectedCustomer.vipSince ? (
                            <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('customers.karta.notVipYet')}</p>
                          ) : (
                            <>
                              <div className="flex flex-wrap items-center gap-2 mb-3">
                                <input type="date" value={salesDateFrom} onChange={e => setSalesDateFrom(e.target.value)} className={DATE_INPUT_CLS} />
                                <span className="text-[12px] text-gray-400">—</span>
                                <input type="date" value={salesDateTo} onChange={e => setSalesDateTo(e.target.value)} className={DATE_INPUT_CLS} />
                                <div className="flex flex-wrap gap-1.5 sm:ml-auto">
                                  {SALES_PAYMENT_FILTERS.map(f => (
                                    <button key={f} onClick={() => setSalesPaymentFilter(f)} className={PILL_CLS(salesPaymentFilter === f)}>
                                      {f === 'Barchasi' ? t('customers.karta.paymentFilterAll') : f}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
                                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                                  <table className="w-full">
                                    <thead className="bg-gray-50 dark:bg-gray-800/50 sticky top-0">
                                      <tr className="border-b border-gray-100 dark:border-gray-800">
                                        <th className="px-3 py-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.date')}</th>
                                        <th className="px-3 py-2 text-center text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.productsCount')}</th>
                                        <th className="px-3 py-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.listPrice')}</th>
                                        <th className="px-3 py-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.discount')}</th>
                                        <th className="px-3 py-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.paid')}</th>
                                        <th className="px-3 py-2 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.ball')}</th>
                                        <th className="px-3 py-2 text-left text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.paymentType')}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {filteredSalesHistory.length === 0 ? (
                                        <tr>
                                          <td colSpan={7} className="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                                            {t('customers.karta.noSalesHistory')}
                                          </td>
                                        </tr>
                                      ) : filteredSalesHistory.map(r => (
                                        <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                                          <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(r.date)}</td>
                                          <td className="px-3 py-2 text-sm text-center text-gray-700 dark:text-gray-300">{r.itemCount}</td>
                                          <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-400 dark:text-gray-500 line-through whitespace-nowrap">
                                            {formatPrice(r.listPriceTotal)}
                                          </td>
                                          <td className="px-3 py-2 text-sm text-right tabular-nums text-red-600 dark:text-red-400 whitespace-nowrap">
                                            {r.discount > 0 ? `-${formatPrice(r.discount)}` : '—'}
                                          </td>
                                          <td className="px-3 py-2 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">
                                            {formatPrice(r.paid)}
                                          </td>
                                          <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-700 dark:text-gray-300">
                                            {r.balls > 0 ? `+${r.balls}` : '—'}
                                          </td>
                                          <td className="px-3 py-2">
                                            {r.isNasiya ? (
                                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400">
                                                {t('customers.karta.nasiyaType')}
                                              </span>
                                            ) : (
                                              <span className="text-sm text-gray-500 dark:text-gray-400">{r.paymentMethod}</span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    {filteredSalesHistory.length > 0 && (
                                      <tfoot>
                                        <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold">
                                          <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{t('customers.karta.totalRow')}</td>
                                          <td className="px-3 py-2 text-sm text-center text-gray-900 dark:text-gray-100">{salesTotals.itemCount}</td>
                                          <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatPrice(salesTotals.listPriceTotal)}</td>
                                          <td className="px-3 py-2 text-sm text-right tabular-nums text-red-600 dark:text-red-400 whitespace-nowrap">{formatPrice(salesTotals.discount)}</td>
                                          <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatPrice(salesTotals.paid)}</td>
                                          <td className="px-3 py-2 text-sm text-right tabular-nums text-gray-900 dark:text-gray-100">{salesTotals.balls}</td>
                                          <td className="px-3 py-2" />
                                        </tr>
                                      </tfoot>
                                    )}
                                  </table>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </TabsContent>
                </div>
              </Tabs>

              <DialogFooter showCloseButton />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Customer Modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customers.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {[
              { label: t('customers.fullNameLabel'), key: 'fullName', placeholder: t('customers.fullNamePlaceholder') },
              { label: t('customers.phoneLabel'), key: 'phone', placeholder: t('customers.phonePlaceholder') },
              { label: t('customers.emailLabel'), key: 'email', placeholder: t('customers.emailPlaceholder') },
              { label: t('customers.addressLabel'), key: 'address', placeholder: t('customers.addressPlaceholder') },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
                <input
                  type="text"
                  placeholder={placeholder}
                  value={form[key as keyof typeof form] as string}
                  onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
                />
              </div>
            ))}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.statusLabel')}</label>
              <select
                value={form.status}
                onChange={e => setForm(prev => ({ ...prev, status: e.target.value as Customer['status'] }))}
                className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
              >
                <option value="New">{t('customers.statusNew')}</option>
                <option value="Regular">Regular</option>
                <option value="VIP">VIP</option>
              </select>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button onClick={addCustomer} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Give Nasiya Modal */}
      <Dialog open={giveNasiyaOpen} onOpenChange={setGiveNasiyaOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customers.karta.giveNasiya')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.amountLabel')}</label>
              <input
                type="number"
                min={0}
                placeholder={t('customers.karta.amountPlaceholder')}
                value={giveAmount}
                onChange={e => setGiveAmount(e.target.value)}
                className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.noteLabel')}</label>
              <textarea
                value={giveNote}
                onChange={e => setGiveNote(e.target.value)}
                rows={2}
                placeholder={t('customers.karta.notePlaceholder')}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setGiveNasiyaOpen(false)}>{t('customers.karta.cancel')}</Button>
            <Button onClick={submitGiveNasiya} disabled={giving}>
              {giving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('customers.karta.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Accept Payment (repay nasiya) Modal */}
      <Dialog open={repayNasiyaOpen} onOpenChange={setRepayNasiyaOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customers.karta.acceptPayment')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400">
              {t('customers.karta.nasiyaBalance')}: <span className="font-semibold text-gray-800 dark:text-gray-200">{formatPrice(nasiyaBalance)}</span>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.amountLabel')}</label>
              <input
                type="number"
                min={0}
                placeholder={t('customers.karta.amountPlaceholder')}
                value={repayAmount}
                onChange={e => setRepayAmount(e.target.value)}
                className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.noteLabel')}</label>
              <textarea
                value={repayNote}
                onChange={e => setRepayNote(e.target.value)}
                rows={2}
                placeholder={t('customers.karta.notePlaceholder')}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setRepayNasiyaOpen(false)}>{t('customers.karta.cancel')}</Button>
            <Button onClick={submitRepayNasiya} disabled={repaying}>
              {repaying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('customers.karta.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
