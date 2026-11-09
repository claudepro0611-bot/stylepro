'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { Loader2, Wallet, TrendingUp, Undo2, CreditCard, type LucideIcon } from 'lucide-react'
import { toast } from '@/lib/toast'
import { useTheme } from 'next-themes'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useBranchFilter } from '@/lib/session/useBranch'
import { BranchScopeLabel } from '@/components/reports/BranchScopeLabel'
import { ReportPeriodFilterBar } from '@/components/reports/ReportPeriodFilterBar'
import { DonutChart, type DonutSlice } from '@/components/reports/DonutChart'
import { periodRange, bucketGranularity, buildBuckets, bucketKey, bucketLabel, type Period } from '@/lib/reports/period'

// ─── KPI card (same convention as dashboard/page.tsx's KpiCard/KpiIconBox
// and customers/page.tsx's Karta tab KPI cards) ─────────────────────────────

function KpiIconBox({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
      <Icon className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
    </div>
  )
}

const KPI_CARD_CLS = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm hover:shadow-md transition-all duration-200 p-4'

interface KpiCardProps {
  title: string
  value: string
  icon: LucideIcon
  valueClassName?: string
}

function KpiCard({ title, value, icon, valueClassName }: KpiCardProps) {
  return (
    <div className={KPI_CARD_CLS}>
      <div className="flex items-start justify-between mb-3">
        <KpiIconBox icon={icon} />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{title}</p>
      <p className={`text-lg font-semibold tabular-nums whitespace-nowrap ${valueClassName ?? 'text-gray-900 dark:text-gray-100'}`}>{value}</p>
    </div>
  )
}

// ─── Row types ──────────────────────────────────────────────────────────────

interface TxnRow {
  id: string
  total_amount: number
  date: string
  status: string
}

interface TxnItemRow {
  transaction_id: string
  price: number
  list_price: number
  purchase_price: number | null
  quantity: number
}

interface ReturnRow {
  id: string
  created_at: string
  transaction_id: string
}

interface ReturnItemRow {
  return_id: string
  refund_amount: number
}

interface LoyaltyTxnRow {
  type: string
  amount: number
  created_at: string
}

interface NasiyaTxnRow {
  type: string
  amount: number
  created_at: string
}

interface StockOutBrakRow {
  quantity: number
  date: string
  product_size_id: string | null
}

interface ProductSizeRow {
  id: string
  purchase_price: number | null
}

interface ExpenseRow {
  amount: number
  date: string
}

function shiftDay(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export default function MoliyaReportPage() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [period, setPeriod] = useState<Period>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(true)

  const [transactions, setTransactions] = useState<TxnRow[]>([])
  const [txnItems, setTxnItems] = useState<TxnItemRow[]>([])
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [returnItems, setReturnItems] = useState<ReturnItemRow[]>([])
  const [loyaltyTxns, setLoyaltyTxns] = useState<LoyaltyTxnRow[]>([])
  const [redeemRate, setRedeemRate] = useState(0)
  const [brakEntries, setBrakEntries] = useState<StockOutBrakRow[]>([])
  const [productSizes, setProductSizes] = useState<ProductSizeRow[]>([])
  const [expenses, setExpenses] = useState<ExpenseRow[]>([])
  const [nasiyaTxns, setNasiyaTxns] = useState<NasiyaTxnRow[]>([])
  const applyBranch = useBranchFilter()

  const [from, to] = useMemo(() => periodRange(period, customFrom, customTo), [period, customFrom, customTo])

  // Loads only what the selected period needs, filtered and paged in the DB.
  // Previously every table was downloaded in full on each visit (whole
  // history, and silently cut at PostgREST's 1000-row cap, so totals went
  // wrong once a store passed 1000 sales). The in-memory math below is
  // unchanged — it still applies inRange() exactly as before.
  const fetchAll = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>
    // timestamptz columns: widen by a day on each side (timezone slack);
    // inRange() below does the exact per-day cut.
    const tsFrom = shiftDay(from, -1)
    const tsTo = shiftDay(to, 2)

    const [
      txnRes, itemRes, returnsRes, loyaltyRes, loyaltyConfigRes,
      brakRes, sizesRes, expensesRes, nasiyaRes,
    ] = await Promise.all([
      // Every branch-carrying table is narrowed to the Header branch (no-op on
      // "All branches"). transaction_items carries its sale's branch_id.
      fetchAllRows<TxnRow>((a, b) => applyBranch(supabase.from('transactions').select('id, total_amount, date, status')
        .eq('status', 'completed').gte('date', from).lte('date', to)).order('id').range(a, b) as unknown as Page<TxnRow>),
      fetchAllRows<TxnItemRow>((a, b) => applyBranch(supabase.from('transaction_items')
        .select('transaction_id, price, list_price, purchase_price, quantity, transactions!inner(date, status)')
        .eq('transactions.status', 'completed').gte('transactions.date', from).lte('transactions.date', to))
        .order('id').range(a, b) as unknown as Page<TxnItemRow>),
      fetchAllRows<ReturnRow & { return_items: { refund_amount: number }[] | null }>((a, b) => applyBranch(supabase.from('returns')
        .select('id, created_at, transaction_id, return_items(refund_amount)')
        .gte('created_at', tsFrom).lt('created_at', tsTo)).order('id').range(a, b) as unknown as Page<ReturnRow & { return_items: { refund_amount: number }[] | null }>),
      fetchAllRows<LoyaltyTxnRow>((a, b) => applyBranch(supabase.from('loyalty_transactions').select('type, amount, created_at')
        .eq('type', 'redeem').gte('created_at', tsFrom).lt('created_at', tsTo)).order('id').range(a, b) as unknown as Page<LoyaltyTxnRow>),
      supabase.from('loyalty_config').select('redeem_rate').maybeSingle(),
      fetchAllRows<StockOutBrakRow>((a, b) => applyBranch(supabase.from('stock_out_entries').select('quantity, date, product_size_id')
        .eq('entry_type', 'brak').gte('date', from).lte('date', to)).order('id').range(a, b) as unknown as Page<StockOutBrakRow>),
      // Lookup only (variant id -> purchase price for the brak rows above,
      // which are already branch-narrowed), so not branch-filtered.
      fetchAllRows<ProductSizeRow>((a, b) => supabase.from('product_sizes').select('id, purchase_price')
        .order('id').range(a, b) as unknown as Page<ProductSizeRow>),
      fetchAllRows<ExpenseRow>((a, b) => applyBranch(supabase.from('expenses').select('amount, date')
        .gte('date', from).lte('date', to)).order('id').range(a, b) as unknown as Page<ExpenseRow>),
      // All-time on purpose: the outstanding-debt card sums every given/repaid
      // row (per branch when one is active).
      fetchAllRows<NasiyaTxnRow>((a, b) => applyBranch(supabase.from('nasiya_transactions').select('type, amount, created_at'))
        .order('id').range(a, b) as unknown as Page<NasiyaTxnRow>),
    ])

    if (txnRes.error || itemRes.error || returnsRes.error) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }

    const returnRows = returnsRes.data
    // Returns in the period may belong to sales made before it; the revenue
    // math needs to know whether those sales are still 'completed'.
    const txns = [...txnRes.data]
    const known = new Set(txns.map(x => x.id))
    const missing = [...new Set(returnRows.map(r => r.transaction_id).filter(id => id && !known.has(id)))]
    for (let i = 0; i < missing.length; i += 150) {
      const { data } = await supabase.from('transactions').select('id, total_amount, date, status')
        .eq('status', 'completed').in('id', missing.slice(i, i + 150))
      txns.push(...((data ?? []) as TxnRow[]))
    }

    setTransactions(txns)
    setTxnItems(itemRes.data)
    setReturns(returnRows.map(r => ({ id: r.id, created_at: r.created_at, transaction_id: r.transaction_id })))
    setReturnItems(returnRows.flatMap(r => (r.return_items ?? []).map(ri => ({ return_id: r.id, refund_amount: ri.refund_amount }) as ReturnItemRow)))
    setLoyaltyTxns(loyaltyRes.data)
    setRedeemRate(loyaltyConfigRes.data?.redeem_rate != null ? Number(loyaltyConfigRes.data.redeem_rate) : 0)
    setBrakEntries(brakRes.data)
    setProductSizes(sizesRes.data)
    setExpenses(expensesRes.data)
    setNasiyaTxns(nasiyaRes.data)
    setLoading(false)
  }, [t, from, to, applyBranch])

  useEffect(() => { fetchAll() }, [fetchAll])
  const inRange = useCallback((d: string) => { const day = d.slice(0, 10); return day >= from && day <= to }, [from, to])

  // ─── Section 1: P&L ───────────────────────────────────────────────────────

  const filteredTxns = useMemo(() => transactions.filter(t => inRange(t.date)), [transactions, inRange])

  const txnIdSet = useMemo(() => new Set(filteredTxns.map(t => t.id)), [filteredTxns])
  const filteredItems = useMemo(() => txnItems.filter(i => txnIdSet.has(i.transaction_id)), [txnItems, txnIdSet])

  // Fallback for legacy rows: transaction_items written before the
  // sell_cart rewrite have list_price = 0/null (list_price wasn't captured
  // yet), which made grossRevenue < netRevenue and produced negative
  // "discounts" for those periods. COALESCE to `price` (the actual charged
  // amount) whenever list_price is missing/zero, so legacy rows behave as
  // "no discount" instead of "100% discount".
  const effectiveListPrice = useCallback((item: TxnItemRow) =>
    item.list_price && Number(item.list_price) > 0 ? Number(item.list_price) : Number(item.price),
    [],
  )

  // Yalpi daromad (gross revenue) must be the TRUE pre-discount catalog
  // total, i.e. SUM(list_price * quantity) over this period's line items —
  // NOT SUM(transactions.total_amount). total_amount is built by sell_cart
  // as SUM(v_unit_price * v_quantity) per line, where v_unit_price is
  // ALREADY the post-discount price (v_list_price * (1 - effective_discount
  // / 100)) — so total_amount is a post-discount charged total, not a gross
  // figure. Deriving grossRevenue from total_amount and then also
  // subtracting `discounts` below would double-count the discount and
  // understate netRevenue/netProfit by exactly the discount amount every
  // period. Sanity check: grossRevenue - discounts should equal
  // SUM(transactions.total_amount) for the same period, since both compute
  // the same post-discount charged total two different ways (modulo the
  // legacy list_price fallback above).
  const grossRevenue = useMemo(() =>
    filteredItems.reduce((s, i) => s + effectiveListPrice(i) * Number(i.quantity), 0),
    [filteredItems, effectiveListPrice],
  )

  // Deviation from the literal spec text ("SUM(list_price - price)"): both
  // columns are per-unit prices (see sell_cart), so the per-line discount
  // amount is multiplied by quantity here — otherwise a line with
  // quantity > 1 would undercount the actual so'm discount given. Flagged
  // explicitly in the handoff report.
  const discounts = useMemo(() =>
    filteredItems.reduce((s, i) => s + (effectiveListPrice(i) - Number(i.price)) * Number(i.quantity), 0),
    [filteredItems, effectiveListPrice],
  )
  const cogs = useMemo(() =>
    filteredItems.reduce((s, i) => s + Number(i.purchase_price ?? 0) * Number(i.quantity), 0),
    [filteredItems],
  )

  // A fully-returned sale is flipped to status='cancelled' by
  // process_return, so it's already gone from `transactions` (completed
  // only). Subtracting its refunds as well would count the same money
  // twice — only refunds on still-completed (partially returned) sales
  // reduce revenue here.
  const completedTxnIds = useMemo(() => new Set(transactions.map(t => t.id)), [transactions])
  const filteredReturns = useMemo(() =>
    returns.filter(r => inRange(r.created_at) && completedTxnIds.has(r.transaction_id)),
    [returns, inRange, completedTxnIds],
  )
  const returnIdSet = useMemo(() => new Set(filteredReturns.map(r => r.id)), [filteredReturns])
  // Every refund paid out in the period (full + partial) — shown on the KPI
  // card only; revenue math uses returnsAmount above.
  const allReturnsAmount = useMemo(() => {
    const ids = new Set(returns.filter(r => inRange(r.created_at)).map(r => r.id))
    return returnItems.filter(ri => ids.has(ri.return_id)).reduce((s, ri) => s + Number(ri.refund_amount), 0)
  }, [returns, returnItems, inRange])
  const returnsAmount = useMemo(() =>
    returnItems.filter(ri => returnIdSet.has(ri.return_id)).reduce((s, ri) => s + Number(ri.refund_amount), 0),
    [returnItems, returnIdSet],
  )

  // Cashback: known approximation — the ledger stores ball counts, not the
  // so'm value applied at redemption time, so this uses the company's
  // CURRENT redeem_rate rather than a historical one. Labeled as an
  // estimate in the UI (see cashbackEstimateNote below).
  const filteredCashbackBalls = useMemo(() =>
    loyaltyTxns.filter(l => inRange(l.created_at)).reduce((s, l) => s + Number(l.amount), 0),
    [loyaltyTxns, inRange],
  )
  const cashbackAmount = useMemo(() => filteredCashbackBalls * redeemRate, [filteredCashbackBalls, redeemRate])

  // Sof daromad = Yalpi daromad − Chegirmalar − Cashback ishlatildi − Qaytarishlar
  const netRevenue = useMemo(() => grossRevenue - discounts - cashbackAmount - returnsAmount,
    [grossRevenue, discounts, cashbackAmount, returnsAmount])

  const purchasePriceBySize = useMemo(() => {
    const m = new Map<string, number>()
    productSizes.forEach(ps => m.set(ps.id, Number(ps.purchase_price ?? 0)))
    return m
  }, [productSizes])

  const filteredBrak = useMemo(() => brakEntries.filter(e => inRange(e.date)), [brakEntries, inRange])
  const brakLoss = useMemo(() =>
    filteredBrak.reduce((s, e) => s + Number(e.quantity) * (purchasePriceBySize.get(e.product_size_id ?? '') ?? 0), 0),
    [filteredBrak, purchasePriceBySize],
  )

  const filteredExpenses = useMemo(() => expenses.filter(e => inRange(e.date)), [expenses, inRange])
  const opex = useMemo(() => filteredExpenses.reduce((s, e) => s + Number(e.amount), 0), [filteredExpenses])

  // Sof foyda = Sof daromad − Tovar tannarxi − Brak zarari − Operatsion xarajatlar
  const netProfit = useMemo(() => netRevenue - cogs - brakLoss - opex, [netRevenue, cogs, brakLoss, opex])
  const margin = useMemo(() => grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : 0, [netProfit, grossRevenue])

  // ─── Chart A: Daromad / Sof foyda trend, bucketed per day or week ─────────
  // Bucketing rule (shared with inventar's chart, see lib/reports/period.ts):
  // daily buckets when the selected range is ≤31 days, weekly buckets for
  // longer ranges (year / long custom range) so the chart doesn't render
  // hundreds of daily points.
  const granularity = useMemo(() => bucketGranularity(from, to), [from, to])
  const buckets = useMemo(() => buildBuckets(from, to, granularity), [from, to, granularity])

  const txnDateById = useMemo(() => {
    const m = new Map<string, string>()
    filteredTxns.forEach(t => m.set(t.id, t.date))
    return m
  }, [filteredTxns])
  const returnDateById = useMemo(() => {
    const m = new Map<string, string>()
    filteredReturns.forEach(r => m.set(r.id, r.created_at))
    return m
  }, [filteredReturns])

  const trendData = useMemo(() => {
    interface Bucket { gross: number; discounts: number; cashback: number; returns: number; cogs: number; brak: number; opex: number }
    const map = new Map<string, Bucket>()
    buckets.forEach(b => map.set(b, { gross: 0, discounts: 0, cashback: 0, returns: 0, cogs: 0, brak: 0, opex: 0 }))

    filteredItems.forEach(i => {
      const date = txnDateById.get(i.transaction_id)
      if (!date) return
      const entry = map.get(bucketKey(date, from, granularity))
      if (!entry) return
      entry.gross += effectiveListPrice(i) * Number(i.quantity)
      entry.discounts += (effectiveListPrice(i) - Number(i.price)) * Number(i.quantity)
      entry.cogs += Number(i.purchase_price ?? 0) * Number(i.quantity)
    })

    loyaltyTxns.filter(l => inRange(l.created_at)).forEach(l => {
      const entry = map.get(bucketKey(l.created_at, from, granularity))
      if (!entry) return
      entry.cashback += Number(l.amount) * redeemRate
    })

    returnItems.forEach(ri => {
      const rdate = returnDateById.get(ri.return_id)
      if (!rdate) return
      const entry = map.get(bucketKey(rdate, from, granularity))
      if (!entry) return
      entry.returns += Number(ri.refund_amount)
    })

    filteredBrak.forEach(e => {
      const entry = map.get(bucketKey(e.date, from, granularity))
      if (!entry) return
      entry.brak += Number(e.quantity) * (purchasePriceBySize.get(e.product_size_id ?? '') ?? 0)
    })

    filteredExpenses.forEach(e => {
      const entry = map.get(bucketKey(e.date, from, granularity))
      if (!entry) return
      entry.opex += Number(e.amount)
    })

    return buckets.map(b => {
      const e = map.get(b)!
      const netRev = e.gross - e.discounts - e.cashback - e.returns
      const netProf = netRev - e.cogs - e.brak - e.opex
      return { label: bucketLabel(b), daromad: netRev, sofFoyda: netProf }
    })
  }, [buckets, filteredItems, txnDateById, loyaltyTxns, inRange, redeemRate, returnItems, returnDateById, filteredBrak, purchasePriceBySize, filteredExpenses, from, granularity, effectiveListPrice])

  // ─── Chart B: expense breakdown pie (period totals, already computed above) ─
  // 5th slice color (returnsAmount) is a slate/gray tone — only 4 semantic
  // colors (blue/emerald/amber/red) were specified for the 5 expense slices.
  const expenseData = useMemo<DonutSlice[]>(() => ([
    { key: 'cogs', name: t('reports.moliya.pnl.cogs'), value: cogs, color: '#5E6BB5' },
    { key: 'discounts', name: t('reports.moliya.pnl.discounts'), value: discounts, color: '#f59e0b' },
    { key: 'brakLoss', name: t('reports.moliya.pnl.brakLoss'), value: brakLoss, color: '#ef4444' },
    { key: 'opex', name: t('reports.moliya.pnl.opex'), value: opex, color: '#059669' },
    { key: 'returns', name: t('reports.moliya.pnl.returns'), value: returnsAmount, color: '#64748b' },
  ].filter(s => s.value > 0)), [t, cogs, discounts, brakLoss, opex, returnsAmount])

  const axisColor = isDark ? '#A1A1AA' : '#5F86A1'
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : '#D3E6EE'
  const tooltipStyle = {
    contentStyle: { background: isDark ? '#1B1B1F' : '#fff', border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.08)' : '#D3E6EE'), borderRadius: 8, fontSize: 12 },
    labelStyle: { color: isDark ? '#FAFAFA' : '#12324A' },
  }

  // ─── Section 2: Nasiya / qarzdorlik ───────────────────────────────────────

  const nasiyaGivenPeriod = useMemo(() =>
    nasiyaTxns.filter(n => n.type === 'given' && inRange(n.created_at)).reduce((s, n) => s + Number(n.amount), 0),
    [nasiyaTxns, inRange],
  )
  const nasiyaRepaidPeriod = useMemo(() =>
    nasiyaTxns.filter(n => n.type === 'repaid' && inRange(n.created_at)).reduce((s, n) => s + Number(n.amount), 0),
    [nasiyaTxns, inRange],
  )
  // Current-state total, NOT period-filtered — sum across ALL of the
  // company's nasiya_transactions (RLS already company-scopes every row),
  // equivalent to summing get_customer_nasiya_balance() over every customer.
  const nasiyaCurrentBalance = useMemo(() => {
    const given = nasiyaTxns.filter(n => n.type === 'given').reduce((s, n) => s + Number(n.amount), 0)
    const repaid = nasiyaTxns.filter(n => n.type === 'repaid').reduce((s, n) => s + Number(n.amount), 0)
    return given - repaid
  }, [nasiyaTxns])

  const pnlRowCls = 'flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-b-0'
  const pnlLabelCls = 'text-sm text-gray-600 dark:text-gray-400'
  const pnlValueCls = 'text-sm font-medium text-gray-900 dark:text-gray-100 tabular-nums'
  const pnlTotalRowCls = 'flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800/50 border-t-2 border-gray-200 dark:border-gray-700'

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('reports.moliya.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('reports.moliya.subtitle')}</p>
        <BranchScopeLabel className="mt-1" />
      </div>

      <ReportPeriodFilterBar
        period={period}
        onPeriodChange={setPeriod}
        customFrom={customFrom}
        onCustomFromChange={setCustomFrom}
        customTo={customTo}
        onCustomToChange={setCustomTo}
      />

      {/* KPI cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard title={t('reports.moliya.kpi.netRevenue')} value={formatPrice(netRevenue)} icon={Wallet} />
        <KpiCard
          title={t('reports.moliya.kpi.netProfit')}
          value={formatPrice(netProfit)}
          icon={TrendingUp}
          valueClassName={netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}
        />
        <KpiCard title={t('reports.moliya.kpi.returns')} value={formatPrice(allReturnsAmount)} icon={Undo2} />
        <KpiCard
          title={t('reports.moliya.kpi.nasiyaBalance')}
          value={formatPrice(nasiyaCurrentBalance)}
          icon={CreditCard}
          valueClassName={nasiyaCurrentBalance > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.moliya.charts.trendTitle')}</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="label" tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => formatShortPrice(Number(v))} width={55} />
                <Tooltip {...tooltipStyle} formatter={(v) => formatPrice(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="daromad" name={t('reports.moliya.charts.daromad')} stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="sofFoyda" name={t('reports.moliya.charts.sofFoyda')} stroke="#059669" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.moliya.charts.expenseTitle')}</p>
          </div>
          <div className="p-4">
            <DonutChart
              data={expenseData}
              formatValue={formatPrice}
              isDark={isDark}
              centerLabel={t('reports.table.total')}
              height={280}
            />
          </div>
        </div>
      </div>

      {/* Section 1: P&L */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.moliya.pnl.title')}</p>
        </div>

        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.pnl.grossRevenue')}</span>
          <span className={pnlValueCls}>{formatPrice(grossRevenue)}</span>
        </div>
        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.pnl.discounts')}</span>
          <span className={pnlValueCls}>−{formatPrice(discounts)}</span>
        </div>
        <div className={pnlRowCls}>
          <div>
            <span className={pnlLabelCls}>{t('reports.moliya.pnl.cashback')}</span>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('reports.moliya.pnl.cashbackEstimateNote')}</p>
          </div>
          <span className={pnlValueCls}>−{formatPrice(cashbackAmount)}</span>
        </div>
        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.pnl.returns')}</span>
          <span className={pnlValueCls}>−{formatPrice(returnsAmount)}</span>
        </div>
        <div className={pnlTotalRowCls}>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('reports.moliya.pnl.netRevenue')}</span>
          <span className={`text-sm font-bold tabular-nums ${netRevenue >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatPrice(netRevenue)}
          </span>
        </div>

        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.pnl.cogs')}</span>
          <span className={pnlValueCls}>−{formatPrice(cogs)}</span>
        </div>
        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.pnl.brakLoss')}</span>
          <span className={pnlValueCls}>−{formatPrice(brakLoss)}</span>
        </div>
        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.pnl.opex')}</span>
          <span className={pnlValueCls}>−{formatPrice(opex)}</span>
        </div>
        <div className={pnlTotalRowCls}>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('reports.moliya.pnl.netProfit')}</span>
          <div className="text-right">
            <p className={`text-sm font-bold tabular-nums ${netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
              {formatPrice(netProfit)}
            </p>
            <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('reports.moliya.pnl.margin')}: {margin.toFixed(1)}%</p>
          </div>
        </div>
      </div>

      {/* Section 2: Nasiya / qarzdorlik */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('reports.moliya.nasiya.title')}</p>
        </div>
        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.nasiya.given')}</span>
          <span className={pnlValueCls}>{formatPrice(nasiyaGivenPeriod)}</span>
        </div>
        <div className={pnlRowCls}>
          <span className={pnlLabelCls}>{t('reports.moliya.nasiya.repaid')}</span>
          <span className={pnlValueCls}>{formatPrice(nasiyaRepaidPeriod)}</span>
        </div>
        <div className={pnlTotalRowCls}>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('reports.moliya.nasiya.currentBalance')}</span>
          <span className={`text-sm font-bold tabular-nums ${nasiyaCurrentBalance > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>
            {formatPrice(nasiyaCurrentBalance)}
          </span>
        </div>
      </div>
    </div>
  )
}
