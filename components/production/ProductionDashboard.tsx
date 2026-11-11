'use client'

// Director dashboard of production (dairy plant) firms (business_type =
// 'production'). Replaces the retail dashboard entirely - none of the retail
// queries run.
//
// Two labelled sections so period figures and current state are never mixed:
// "Tanlangan davr" (follows the period picker, compared with the previous
// equal period) and "Hozirgi holat" (cash, debts, stock, expiring lots -
// always as of now). Every block is rendered and queried only for users with
// the module's permission (without it RLS would return no rows and the block
// would show a misleading 0); cost, gross profit and margin only for
// owner / admin (useSeesMargin). Period figures come from
// prod_report_dashboard (server-side, migration 20261110000018) when it is
// available; otherwise (and for the per-item "Ko'proq" charts) they are
// aggregated client-side from paginated reads. Net profit (prod_pnl) is
// added to the revenue card for owner / admin.
//
// Kept short on purpose: max 4 KPI cards per row, a "Tezkor amallar" row of
// permission-filtered shortcuts, 4 charts by default (the rest behind
// "Ko'proq", remembered in localStorage) and only the lists that need action.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlarmClock, AlertTriangle, Boxes, ChevronDown, CreditCard, Factory, FileBarChart, Landmark, Milk, PackagePlus, Receipt,
  ReceiptText, Wallet, type LucideIcon,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { DocStatusBadge, Segmented, prodCardCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useHasPermission } from '@/components/production/MilkKit'
import { useSalesAvailable, useSeesMargin } from '@/components/production/SalesKit'
import { useCashAccounts } from '@/components/production/CashKit'
import {
  ChartCard, ChartTooltip, DeltaPill, DonutBlock, LegendRow, ListSkeleton, Sparkline, useChartTheme,
} from '@/components/production/DashCharts'
import { formatMarginPct, marginPct } from '@/lib/sales'
import { CASH_ACCOUNT_KINDS, accountKindKey, cashSourceHref, cashSourceKey } from '@/lib/cash'
import { fetchSupplierAgeing } from '@/lib/inventory'
import {
  expiryWarnDaysOf, fetchProdStock, formatQty, itemTypeKey, lotExpiryState, rangeToIsoBounds, round2, unitKey,
  type ProdStockRow,
} from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { MILK_INTAKE_COLS, aggregateMilk, daysUntil, docHref, docTypeKey, toKg, ymdOf, type MilkIntakeLite } from '@/lib/production-reports'
import {
  DASH_PRESETS, addDaysYmd, bucketEndYmd, bucketKeys, bucketOf, granularityOf, matchPreset, pctChange, presetRange,
  previousRange, sliceColor, topSlices, type DashPreset, type Slice, type YmdRange,
} from '@/lib/production-dashboard'
import { fetchDashboardRpc, fetchPnl, type DashRpc } from '@/lib/production-accounting'

/** Set once prod_report_dashboard turned out to be missing (pre-migration). */
let dashRpcMissing = false

// ---------------------------------------------------------------------------
// Row shapes of the reads

interface SalesLine {
  doc_date: string | null; item_id: string | null; item_name: string | null
  group_id: string | null; group_name: string | null
  amount: number | null; cost: number | null; margin: number | null
}
interface OutputRow { doc_date: string; output_item_id: string; output_qty: number }
interface LotRow {
  id: string | null; lot_no: string | null; warehouse_name: string | null; item_id: string | null; item_name: string | null
  item_unit: string | null; remaining_qty: number | null; value: number | null; expiry_date: string | null; hold_status: string | null
}
interface PartyDebt { id: string; name: string; balance: number; overdue: number }
interface FeedDoc {
  key: string; typeKey: TranslationKey; number: number; dateLabel: string; createdAt: string
  party: string; figure: string; status: string; href: string | null
}

/** Lots expiring within this many days are read; each is classified with its item's warn window. */
const EXPIRY_LOOKAHEAD_DAYS = 30
const FEED_SIZE = 10
const LIST_ROWS = 8
const TOP_PRODUCTS = 10
const TOP_PARTIES = 5
/** Donut slices before "Boshqa" (max 6 in total). */
const DONUT_TOP = 5
const STACK_TOP = 5

const MONTH_KEYS: TranslationKey[] = [
  'dashboard.monthsShort.jan', 'dashboard.monthsShort.feb', 'dashboard.monthsShort.mar', 'dashboard.monthsShort.apr',
  'dashboard.monthsShort.may', 'dashboard.monthsShort.jun', 'dashboard.monthsShort.jul', 'dashboard.monthsShort.aug',
  'dashboard.monthsShort.sep', 'dashboard.monthsShort.oct', 'dashboard.monthsShort.nov', 'dashboard.monthsShort.dec',
]

const PRESET_KEYS: Record<DashPreset, TranslationKey> = {
  today: 'common.dateRange.today',
  last7: 'common.dateRange.last7',
  last30: 'common.dateRange.last30',
  thisMonth: 'common.dateRange.thisMonth',
  lastMonth: 'common.dateRange.lastMonth',
}

const EMPTY = Promise.resolve({ data: [] as never[], error: null as unknown })

const panelHeadCls = 'flex items-center justify-between gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-3'
const panelLinkCls = 'text-[13px] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'
const kpiCardCls = 'min-w-0 rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-800 dark:bg-gray-900'

const dmy = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`
const num = (v: number | null | undefined) => Number(v ?? 0)

function shortNumber(v: number): string {
  const a = Math.abs(v)
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}M` : a >= 1_000 ? `${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}K` : String(Math.round(a))
  return v < 0 ? `-${s}` : s
}

function sumDebt(list: PartyDebt[]) {
  return { balance: list.reduce((s, d) => s + d.balance, 0), overdue: list.reduce((s, d) => s + d.overdue, 0) }
}

/** Largest balances, split into the not-yet-due and the overdue part (stacked bars). */
function topDebt(list: PartyDebt[]) {
  return [...list].sort((a, b) => b.balance - a.balance).slice(0, TOP_PARTIES).map(d => ({
    name: d.name, balance: d.balance,
    notOverdue: round2(Math.max(0, d.balance - d.overdue)), overdue: round2(Math.min(d.overdue, d.balance)),
  }))
}

function SectionTitle({ children }: { children: string }) {
  return <h2 className="text-[13px] font-medium text-gray-500 dark:text-gray-400">{children}</h2>
}

interface KpiCardProps {
  label: string
  value: string
  icon: LucideIcon
  sub?: string
  href?: string
  tone?: 'negative' | 'warning'
  subTone?: 'negative' | 'warning'
  delta?: { value: number | null; title: string }
  spark?: number[]
}

function KpiCard({ label, value, icon: Icon, sub, href, tone, subTone, delta, spark }: KpiCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
          <Icon className="h-4 w-4 text-gray-400" />
        </div>
        {delta && <DeltaPill value={delta.value} title={delta.title} />}
      </div>
      <p className="mt-3 text-[12.5px] text-gray-500 dark:text-gray-400">{label}</p>
      <p className={cn(
        'mt-0.5 break-words text-lg font-semibold tabular-nums',
        tone === 'negative' ? 'text-red-600 dark:text-red-400'
          : tone === 'warning' ? 'text-amber-700 dark:text-amber-400'
            : 'text-gray-900 dark:text-gray-100',
      )}>{value}</p>
      {sub && (
        <p className={cn(
          'mt-0.5 text-[12px] tabular-nums',
          subTone === 'negative' ? 'text-red-600 dark:text-red-400'
            : subTone === 'warning' ? 'text-amber-700 dark:text-amber-400'
              : 'text-gray-500 dark:text-gray-400',
        )}>{sub}</p>
      )}
      {spark && <div className="mt-2"><Sparkline data={spark} /></div>}
    </>
  )
  return href
    ? <Link href={href} className={cn(kpiCardCls, 'block transition-all duration-200 hover:shadow-md')}>{body}</Link>
    : <div className={kpiCardCls}>{body}</div>
}

function KpiSkeletonRow({ count, cls }: { count: number; cls: string }) {
  return (
    <div className={cls}>
      {Array.from({ length: count }, (_, i) => <div key={i} className="h-[150px] animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800" />)}
    </div>
  )
}

export function ProductionDashboard() {
  const { t } = useLanguage()
  const { formatPrice, formatShortPrice } = useCurrency()
  const theme = useChartTheme()
  const { items, itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const canProduction = useHasPermission('prod_production')
  const canMilk = useHasPermission('prod_milk')
  const canStock = useHasPermission('prod_stock')
  const canSuppliers = useHasPermission('prod_suppliers')
  const canSales = useHasPermission('prod_sales')
  const canCash = useHasPermission('prod_cash')
  const canReceipts = useHasPermission('prod_receipts')
  const canSupply = useHasPermission('prod_supply')
  const canCustomerPayments = useHasPermission('prod_customer_payments')

  // Wholesale sales (migration 20261110000015) and cash (20261110000016) are probed first.
  const salesAvailable = useSalesAvailable()
  const seesMargin = useSeesMargin()
  const showSales = !!salesAvailable && canSales
  const salesPending = canSales && salesAvailable === null
  const { available: cashAvailable, accounts, loading: cashLoading } = useCashAccounts()
  const showCash = !!cashAvailable && canCash

  // ---- period ----------------------------------------------------------------
  const [range, setRange] = useState<YmdRange>(() => presetRange('thisMonth'))
  const preset = matchPreset(range)
  const prev = useMemo(() => previousRange(range), [range])
  const gran = useMemo(() => granularityOf(range), [range])
  const buckets = useMemo(() => bucketKeys(range, gran), [range, gran])
  const dots = buckets.length <= 2 ? { r: 3 } : false

  const bucketLabel = (key: string) => {
    if (gran === 'month') return `${t(MONTH_KEYS[Number(key.slice(5, 7)) - 1])} ${key.slice(2, 4)}`
    return `${key.slice(8, 10)}.${key.slice(5, 7)}`
  }
  const bucketTitle = (key: string) => (gran === 'month' ? `${t(MONTH_KEYS[Number(key.slice(5, 7)) - 1])} ${key.slice(0, 4)}` : dmy(key))
  const shortMoney = (v: number) => (v < 0 ? `-${formatShortPrice(-v)}` : formatShortPrice(v))
  const kg = t('production.units.kg')
  const kgText = (v: number) => `${formatQty(v)} ${kg}`
  const noData = t('prodDash.empty')
  const noDataNow = t('prodDash.emptyNow')
  const [showMore, setShowMore] = useLocalStorage<boolean>('stylepro-prod-dash-more', false)

  // Server-side period aggregation: undefined = deciding, null = client fallback.
  const [dash, setDash] = useState<DashRpc | null | undefined>(undefined)
  const dashReady = dash !== undefined
  const rpcOn = !!dash

  useEffect(() => {
    if (salesPending) return
    if (dashRpcMissing) { setDash(null); return }
    let active = true
    setDash(undefined)
    fetchDashboardRpc(createClient(), range.from, range.to, gran).then(res => {
      if (!active) return
      if (res.status === 'missing') dashRpcMissing = true
      setDash(res.status === 'ok' ? res.data : null)
    })
    return () => { active = false }
  }, [range.from, range.to, gran, salesPending])

  // Net profit of the period (prod_pnl, owner / admin); null when not available.
  const [netProfit, setNetProfit] = useState<number | null>(null)
  useEffect(() => {
    if (!seesMargin || !canStock) { setNetProfit(null); return }
    let active = true
    fetchPnl(createClient(), range.from, range.to, 'total').then(res => {
      if (active) setNetProfit(res.status === 'ok' ? res.data.total.operating_profit : null)
    })
    return () => { active = false }
  }, [range.from, range.to, seesMargin, canStock])

  // Current and previous period are read in one pass ([prev.from, range.to]) and split by local day.
  const [salesRows, setSalesRows] = useState<SalesLine[]>([])
  const [intakes, setIntakes] = useState<MilkIntakeLite[]>([])
  const [outputs, setOutputs] = useState<OutputRow[]>([])
  const [periodLoading, setPeriodLoading] = useState(true)

  useEffect(() => {
    if (salesPending || !dashReady) return
    let active = true
    setPeriodLoading(true)
    const supabase = createClient()
    const { fromIso, toIso } = rangeToIsoBounds({ from: prev.from, to: range.to })
    Promise.all([
      // With the RPC the raw sales lines only feed the per-item "Ko'proq" chart.
      showSales && (!rpcOn || showMore)
        ? fetchAllRows<SalesLine>((from, to) => supabase.from('prod_sales_lines_v')
          .select('doc_date, item_id, item_name, group_id, group_name, amount, cost, margin')
          .gte('doc_date', fromIso).lt('doc_date', toIso)
          .order('doc_date').order('sale_item_id').order('row_kind').order('return_id').range(from, to))
        : EMPTY,
      canMilk && !rpcOn
        ? fetchAllRows<MilkIntakeLite>((from, to) => supabase.from('prod_milk_intakes').select(MILK_INTAKE_COLS)
          .neq('status', 'cancelled').gte('intake_date', fromIso).lt('intake_date', toIso)
          .order('intake_date').order('id').range(from, to))
        : EMPTY,
      canProduction
        ? fetchAllRows<OutputRow>((from, to) => supabase.from('prod_productions').select('doc_date, output_item_id, output_qty')
          .eq('status', 'posted').gte('doc_date', fromIso).lt('doc_date', toIso)
          .order('doc_date').order('id').range(from, to))
        : EMPTY,
    ]).then(([s, m, p]) => {
      if (!active) return
      setSalesRows(s.data as SalesLine[])
      setIntakes(m.data as MilkIntakeLite[])
      setOutputs(p.data as OutputRow[])
      setPeriodLoading(false)
    })
    return () => { active = false }
  }, [prev.from, range.to, showSales, salesPending, canMilk, canProduction, dashReady, rpcOn, showMore])

  // Cash period reads: ledger lines from the period start up to now (to roll the
  // current balance back day by day), cash-order outflows and supply expenses.
  const showOutflows = showCash || canSupply
  const [cashMoves, setCashMoves] = useState<{ move_date: string; amount: number }[]>([])
  const [outflowRows, setOutflowRows] = useState<{ category_id: string | null; amount: number }[]>([])
  const [categoryNames, setCategoryNames] = useState<Map<string, string>>(new Map())
  const [cashPeriodLoading, setCashPeriodLoading] = useState(true)

  useEffect(() => {
    if (canCash && cashAvailable === null) return
    if (!dashReady) return
    // The RPC already returns the cash balance series and the outflows.
    if (!showOutflows || rpcOn) { setCashPeriodLoading(false); return }
    let active = true
    setCashPeriodLoading(true)
    const supabase = createClient()
    const { fromIso, toIso } = rangeToIsoBounds(range)
    Promise.all([
      showCash
        ? fetchAllRows<{ move_date: string; amount: number }>((from, to) => supabase.from('prod_cash_movements')
          .select('move_date, amount').gte('move_date', fromIso).order('move_date').order('id').range(from, to))
        : EMPTY,
      showCash
        ? fetchAllRows<{ category_id: string | null; amount: number }>((from, to) => supabase.from('prod_cash_orders')
          .select('category_id, amount').eq('direction', 'out').eq('status', 'posted')
          .gte('doc_date', fromIso).lt('doc_date', toIso).order('doc_date').order('id').range(from, to))
        : EMPTY,
      canSupply
        ? (async () => {
          // Posted moves only (status: migration 20261110000017); retried without
          // the filter while the column does not exist yet.
          const read = (postedOnly: boolean) => fetchAllRows<{ expense_category_id: string | null; amount: number }>((from, to) => {
            let q = supabase.from('supply_cash_moves')
              .select('expense_category_id, amount').eq('kind', 'expense')
              .gte('move_date', range.from).lte('move_date', range.to)
            if (postedOnly) q = q.eq('status', 'posted')
            return q.order('move_date').order('id').range(from, to)
          })
          const res = await read(true)
          return res.error ? read(false) : res
        })()
        : EMPTY,
      supabase.from('expense_categories').select('id, name'),
    ]).then(([mv, co, sx, cats]) => {
      if (!active) return
      setCashMoves(mv.data as { move_date: string; amount: number }[])
      setOutflowRows([
        ...(co.data as { category_id: string | null; amount: number }[]),
        ...(sx.data as { expense_category_id: string | null; amount: number }[]).map(r => ({ category_id: r.expense_category_id, amount: r.amount })),
      ])
      setCategoryNames(new Map((cats.data ?? []).map(c => [c.id, c.name])))
      setCashPeriodLoading(false)
    })
    return () => { active = false }
  }, [range, showCash, canCash, cashAvailable, canSupply, showOutflows, dashReady, rpcOn])

  // ---- current state ---------------------------------------------------------
  const [stock, setStock] = useState<ProdStockRow[]>([])
  const [lots, setLots] = useState<LotRow[]>([])
  const [debtors, setDebtors] = useState<PartyDebt[]>([])
  const [creditors, setCreditors] = useState<PartyDebt[]>([])
  const [supplierNames, setSupplierNames] = useState<Map<string, string>>(new Map())
  const [nowLoading, setNowLoading] = useState(true)
  const today = localYmd()

  useEffect(() => {
    if (salesPending) return
    let active = true
    setNowLoading(true)
    const supabase = createClient()
    Promise.all([
      canStock ? fetchProdStock(supabase) : Promise.resolve([] as ProdStockRow[]),
      canStock
        ? fetchAllRows<LotRow>((from, to) => supabase.from('prod_lot_stock')
          .select('id, lot_no, warehouse_name, item_id, item_name, item_unit, remaining_qty, value, expiry_date, hold_status')
          .gt('remaining_qty', 0).not('expiry_date', 'is', null).lte('expiry_date', addDaysYmd(localYmd(), EXPIRY_LOOKAHEAD_DAYS))
          .order('expiry_date').order('id').range(from, to))
        : EMPTY,
      canSuppliers ? fetchSupplierAgeing(supabase) : Promise.resolve(null),
      canSuppliers
        ? fetchAllRows<{ id: string; name: string }>((from, to) => supabase.from('prod_suppliers').select('id, name').order('id').range(from, to))
        : EMPTY,
      // Ageing per supplier needs migration 14; without it the plain balances are used (no overdue split).
      canSuppliers
        ? fetchAllRows<{ supplier_id: string | null; debt: number | null }>((from, to) => supabase.from('prod_supplier_balances')
          .select('supplier_id, debt').gt('debt', 0).order('supplier_id').range(from, to))
        : EMPTY,
      showSales
        ? fetchAllRows<{ customer_id: string | null; name: string | null; balance: number | null; overdue_1_15: number | null; overdue_16_30: number | null; overdue_31_plus: number | null }>((from, to) =>
          supabase.from('prod_customer_ageing').select('customer_id, name, balance, overdue_1_15, overdue_16_30, overdue_31_plus')
            .gt('balance', 0).order('customer_id').range(from, to))
        : EMPTY,
    ]).then(([stockRows, lotRes, supAge, supRes, supBal, custRes]) => {
      if (!active) return
      setStock(stockRows)
      setLots(lotRes.data as LotRow[])
      const names = new Map((supRes.data as { id: string; name: string }[]).map(s => [s.id, s.name]))
      setSupplierNames(names)
      setCreditors(supAge
        ? [...supAge.entries()].filter(([, a]) => a.balance > 0).map(([id, a]) => ({
          id, name: names.get(id) ?? '—', balance: a.balance, overdue: round2(a.d1_15 + a.d16_30 + a.d31),
        }))
        : (supBal.data as { supplier_id: string | null; debt: number | null }[]).filter(r => r.supplier_id).map(r => ({
          id: r.supplier_id as string, name: names.get(r.supplier_id as string) ?? '—', balance: num(r.debt), overdue: 0,
        })))
      setDebtors((custRes.data as { customer_id: string | null; name: string | null; balance: number | null; overdue_1_15: number | null; overdue_16_30: number | null; overdue_31_plus: number | null }[])
        .filter(r => r.customer_id).map(r => ({
          id: r.customer_id as string, name: r.name ?? '—', balance: num(r.balance),
          overdue: round2(num(r.overdue_1_15) + num(r.overdue_16_30) + num(r.overdue_31_plus)),
        })))
      setNowLoading(false)
    })
    return () => { active = false }
  }, [canStock, canSuppliers, showSales, salesPending])

  // ---- recent documents feed -----------------------------------------------
  const [feedRaw, setFeedRaw] = useState<{
    sales: { id: string; number: number; doc_date: string; customer_name: string; total: number; status: string; created_at: string }[]
    receipts: { id: string; number: number; doc_date: string; supplier_name: string | null; total: number; status: string; created_at: string }[]
    productions: { id: string; number: number; doc_date: string; output_item_id: string; output_qty: number; status: string; created_at: string }[]
    separations: { id: string; number: number; doc_date: string; milk_item_id: string; milk_qty: number; status: string; created_at: string }[]
    custPays: { id: string; number: number; pay_date: string; customer_id: string; amount: number; status: string; created_at: string }[]
    supPays: { id: string; number: number; pay_date: string; supplier_id: string; amount: number; status: string; created_at: string }[]
  } | null>(null)
  const showCustPays = canCustomerPayments && !!salesAvailable
  const showFeed = showSales || canReceipts || canProduction || showCustPays || canSuppliers

  useEffect(() => {
    if (salesPending) return
    if (!showFeed) { setFeedRaw(null); return }
    let active = true
    const supabase = createClient()
    const latest = <T,>(on: boolean, q: () => PromiseLike<{ data: T[] | null }>) =>
      on ? Promise.resolve(q()).then(r => r.data ?? []) : Promise.resolve([] as T[])
    Promise.all([
      latest(showSales, () => supabase.from('prod_sales').select('id, number, doc_date, customer_name, total, status, created_at').order('created_at', { ascending: false }).limit(FEED_SIZE)),
      latest(canReceipts, () => supabase.from('prod_receipts').select('id, number, doc_date, supplier_name, total, status, created_at').order('created_at', { ascending: false }).limit(FEED_SIZE)),
      latest(canProduction, () => supabase.from('prod_productions').select('id, number, doc_date, output_item_id, output_qty, status, created_at').order('created_at', { ascending: false }).limit(FEED_SIZE)),
      latest(canProduction, () => supabase.from('prod_separations').select('id, number, doc_date, milk_item_id, milk_qty, status, created_at').order('created_at', { ascending: false }).limit(FEED_SIZE)),
      latest(showCustPays, () => supabase.from('prod_customer_payments').select('id, number, pay_date, customer_id, amount, status, created_at').order('created_at', { ascending: false }).limit(FEED_SIZE)),
      latest(canSuppliers, () => supabase.from('prod_supplier_payments').select('id, number, pay_date, supplier_id, amount, status, created_at').order('created_at', { ascending: false }).limit(FEED_SIZE)),
    ]).then(([sales, receipts, productions, separations, custPays, supPays]) => {
      if (active) setFeedRaw({ sales, receipts, productions, separations, custPays, supPays })
    })
    return () => { active = false }
  }, [showFeed, showSales, salesPending, canReceipts, canProduction, showCustPays, canSuppliers])

  // ---- derived: sales ------------------------------------------------------
  const sales = useMemo(() => {
    const cur = { revenue: 0, cost: 0, margin: 0 }
    const prv = { revenue: 0, margin: 0 }
    const byBucket = new Map<string, { revenue: number; cost: number; profit: number }>()
    const byGroup = new Map<string, Slice>()
    const byItem = new Map<string, { name: string; revenue: number; margin: number }>()
    for (const r of salesRows) {
      if (!r.doc_date) continue
      const amount = num(r.amount)
      const margin = num(r.margin)
      if (ymdOf(r.doc_date) < range.from) { prv.revenue += amount; prv.margin += margin; continue }
      const cost = num(r.cost)
      cur.revenue += amount; cur.cost += cost; cur.margin += margin
      const b = bucketOf(ymdOf(r.doc_date), gran)
      const x = byBucket.get(b) ?? { revenue: 0, cost: 0, profit: 0 }
      x.revenue += amount; x.cost += cost; x.profit += margin
      byBucket.set(b, x)
      const gk = r.group_id ?? '__none'
      const g = byGroup.get(gk) ?? { key: gk, name: r.group_name || t('prodDash.charts.noGroup'), value: 0 }
      g.value += amount
      byGroup.set(gk, g)
      const ik = r.item_id ?? r.item_name ?? '—'
      const it = byItem.get(ik) ?? { name: r.item_name ?? '—', revenue: 0, margin: 0 }
      it.revenue += amount; it.margin += margin
      byItem.set(ik, it)
    }
    // Server-side figures replace the client sums (top products stay client-side).
    if (dash) {
      const t0 = dash.totals
      const p0 = dash.prevTotals
      cur.revenue = num(t0.revenue); cur.cost = num(t0.cogs); cur.margin = num(t0.margin)
      prv.revenue = num(p0.revenue); prv.margin = num(p0.margin)
      byBucket.clear()
      for (const s of dash.series) {
        if (s.revenue === null && s.cogs === null) continue
        if (!num(s.revenue) && !num(s.cogs)) continue
        byBucket.set(bucketOf(s.period, gran), { revenue: num(s.revenue), cost: num(s.cogs), profit: num(s.margin) })
      }
      byGroup.clear()
      for (const g of dash.salesByGroup ?? []) {
        const gk = g.groupId ?? '__none'
        byGroup.set(gk, { key: gk, name: g.groupName || t('prodDash.charts.noGroup'), value: g.revenue })
      }
    }
    const series = buckets.map(key => {
      const x = byBucket.get(key)
      return seesMargin
        ? { key, revenue: round2(x?.revenue ?? 0), cost: round2(x?.cost ?? 0), profit: round2(x?.profit ?? 0) }
        : { key, revenue: round2(x?.revenue ?? 0) }
    })
    const top = [...byItem.entries()]
      .map(([key, v]) => {
        const p = marginPct(v.margin, v.revenue)
        return { key, name: v.name, revenue: round2(v.revenue), margin: round2(v.margin), marginLabel: formatMarginPct(p) }
      })
      .filter(v => v.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, TOP_PRODUCTS)
    return {
      cur, prv, series, top, hasCur: byBucket.size > 0,
      groups: topSlices([...byGroup.values()], DONUT_TOP, t('prodDash.charts.other')),
    }
  }, [salesRows, dash, range.from, gran, buckets, seesMargin, t])

  // ---- derived: milk -------------------------------------------------------
  const milk = useMemo(() => {
    if (dash) {
      const bySeries = new Map(dash.series.map(s => [bucketOf(s.period, gran), s]))
      return {
        cur: { receivedKg: num(dash.totals.milkKg), fat: dash.totals.avgFat },
        prv: { receivedKg: num(dash.prevTotals.milkKg), fat: dash.prevTotals.avgFat },
        series: buckets.map(key => {
          const s = bySeries.get(key)
          return { key, kg: round2(num(s?.milkKg)), fat: s?.avgFat === null || s?.avgFat === undefined ? null : round2(s.avgFat) }
        }),
        hasCur: num(dash.totals.milkKg) > 0,
      }
    }
    const isCur = (iso: string) => ymdOf(iso) >= range.from
    const curRows = intakes.filter(r => isCur(r.intake_date))
    const prvRows = intakes.filter(r => !isCur(r.intake_date))
    const cur = aggregateMilk(curRows, () => 'all')[0] ?? null
    const prv = aggregateMilk(prvRows, () => 'all')[0] ?? null
    const byBucket = new Map(aggregateMilk(curRows, r => bucketOf(ymdOf(r.intake_date), gran)).map(a => [a.key, a]))
    const series = buckets.map(key => {
      const a = byBucket.get(key)
      return { key, kg: round2(a?.receivedKg ?? 0), fat: a?.fat === null || a?.fat === undefined ? null : round2(a.fat) }
    })
    return { cur, prv, series, hasCur: curRows.some(r => r.status === 'accepted' || r.status === 'conditional') }
  }, [intakes, dash, range.from, gran, buckets])

  // ---- derived: production output (kg; items without a kg conversion are counted apart) ----
  const output = useMemo(() => {
    let curKg = 0
    let prvKg = 0
    let curDocs = 0
    let unconverted = 0
    const byItem = new Map<string, number>()
    const byBucketItem = new Map<string, Map<string, number>>()
    for (const p of outputs) {
      const item = itemById.get(p.output_item_id)
      const q = toKg(num(p.output_qty), item)
      const cur = ymdOf(p.doc_date) >= range.from
      if (cur) curDocs++
      if (q === null) { if (cur) unconverted++; continue }
      if (!cur) { prvKg += q; continue }
      curKg += q
      byItem.set(p.output_item_id, (byItem.get(p.output_item_id) ?? 0) + q)
      const b = bucketOf(ymdOf(p.doc_date), gran)
      const m = byBucketItem.get(b) ?? new Map<string, number>()
      m.set(p.output_item_id, (m.get(p.output_item_id) ?? 0) + q)
      byBucketItem.set(b, m)
    }
    const topIds = [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, STACK_TOP).map(([id]) => id)
    const hasOther = byItem.size > topIds.length
    const keys = [...topIds, ...(hasOther ? ['__other'] : [])]
    const series = buckets.map(key => {
      const m = byBucketItem.get(key)
      const row: Record<string, number | string> = { key }
      let other = 0
      m?.forEach((v, id) => { if (topIds.includes(id)) row[id] = round2(v); else other += v })
      if (hasOther) row.__other = round2(other)
      return row
    })
    let total = series.map(r => keys.reduce((s, k) => s + Number(r[k] ?? 0), 0))
    // Server-side kg include co-products (prod_production_outputs).
    if (dash && dash.totals.outputKg !== null) {
      curKg = num(dash.totals.outputKg)
      prvKg = num(dash.prevTotals.outputKg)
      const bySeries = new Map(dash.series.map(s => [bucketOf(s.period, gran), num(s.outputKg)]))
      total = buckets.map(key => round2(bySeries.get(key) ?? 0))
    }
    return { curKg, prvKg, curDocs, unconverted, keys, series, total, hasCur: byItem.size > 0 }
  }, [outputs, dash, itemById, range.from, gran, buckets])

  const outputName = (key: string) => (key === '__other' ? t('prodDash.charts.other') : itemById.get(key)?.name ?? '—')

  // ---- derived: cash -------------------------------------------------------
  const cashTotal = useMemo(() => accounts.reduce((s, a) => s + a.balance, 0), [accounts])
  const activeAccounts = useMemo(() => accounts.filter(a => a.isActive), [accounts])
  const cashByKind = useMemo(() => CASH_ACCOUNT_KINDS
    .map(kind => {
      const list = activeAccounts.filter(a => a.kind === kind)
      return { kind, total: list.reduce((s, a) => s + a.balance, 0), n: list.length }
    })
    .filter(k => k.n > 0), [activeAccounts])

  // Balance at each bucket end = today's balance minus everything that moved after it.
  const cashSeries = useMemo(() => {
    if (dash) {
      const bySeries = new Map(dash.series.map(s => [bucketOf(s.period, gran), s.cashBalance]))
      return buckets.map(key => ({ key, end: bucketEndYmd(key, gran, range.to), balance: round2(num(bySeries.get(key))) }))
    }
    const endMs = new Date(rangeToIsoBounds(range).toIso).getTime()
    let after = 0
    const net = new Map<string, number>()
    for (const m of cashMoves) {
      const amount = num(m.amount)
      if (new Date(m.move_date).getTime() >= endMs) { after += amount; continue }
      const b = bucketOf(ymdOf(m.move_date), gran)
      net.set(b, (net.get(b) ?? 0) + amount)
    }
    let bal = cashTotal - after
    const out: { key: string; end: string; balance: number }[] = new Array(buckets.length)
    for (let i = buckets.length - 1; i >= 0; i--) {
      out[i] = { key: buckets[i], end: bucketEndYmd(buckets[i], gran, range.to), balance: round2(bal) }
      bal -= net.get(buckets[i]) ?? 0
    }
    return out
  }, [cashMoves, dash, cashTotal, range, gran, buckets])

  const outflowSlices = useMemo(() => {
    const m = new Map<string, Slice>()
    const rows = dash
      ? (dash.outflows ?? []).map(o => ({ category_id: o.categoryId, amount: o.amount, name: o.categoryName }))
      : outflowRows.map(r => ({ ...r, name: r.category_id ? categoryNames.get(r.category_id) ?? null : null }))
    for (const r of rows) {
      const k = r.category_id ?? '__none'
      const s = m.get(k) ?? { key: k, name: r.name || t('prodDash.charts.noCategory'), value: 0 }
      s.value += num(r.amount)
      m.set(k, s)
    }
    return topSlices([...m.values()].map(s => ({ ...s, value: round2(s.value) })), DONUT_TOP, t('prodDash.charts.other'))
  }, [outflowRows, dash, categoryNames, t])

  // ---- derived: stock, lots, debts -------------------------------------------
  const [stockView, setStockView] = useState<'warehouse' | 'type'>('warehouse')
  const stockValue = useMemo(() => stock.reduce((s, r) => s + r.value, 0), [stock])
  const stockSlices = useMemo(() => {
    const m = new Map<string, Slice>()
    for (const r of stock) {
      if (r.value <= 0) continue
      const type = itemById.get(r.itemId)?.itemType ?? 'raw'
      const key = stockView === 'warehouse' ? r.warehouseId : type
      const name = stockView === 'warehouse' ? warehouseById.get(r.warehouseId)?.name ?? '—' : t(itemTypeKey(type))
      const s = m.get(key) ?? { key, name, value: 0 }
      s.value += r.value
      m.set(key, s)
    }
    return topSlices([...m.values()].map(s => ({ ...s, value: round2(s.value) })), DONUT_TOP, t('prodDash.charts.other'))
  }, [stock, stockView, itemById, warehouseById, t])

  const riskLots = useMemo(() => lots
    .map(l => ({ ...l, state: lotExpiryState(l.expiry_date, today, expiryWarnDaysOf(l.item_id ? itemById.get(l.item_id) : null)) }))
    .filter(l => l.state === 'expired' || l.state === 'soon'), [lots, today, itemById])
  const riskValue = useMemo(() => riskLots.reduce((s, l) => s + num(l.value), 0), [riskLots])
  const expiredCount = riskLots.filter(l => l.state === 'expired').length

  const lowStock = useMemo(() => {
    if (!canStock) return []
    const qtyByItem = new Map<string, number>()
    stock.forEach(r => qtyByItem.set(r.itemId, (qtyByItem.get(r.itemId) ?? 0) + r.qty))
    return items
      .filter(i => i.isActive && i.minStock != null && (qtyByItem.get(i.id) ?? 0) < i.minStock)
      .map(i => ({ item: i, qty: qtyByItem.get(i.id) ?? 0 }))
      .sort((a, b) => a.qty / (a.item.minStock || 1) - b.qty / (b.item.minStock || 1))
  }, [items, stock, canStock])

  const receivables = useMemo(() => sumDebt(debtors), [debtors])
  const payables = useMemo(() => sumDebt(creditors), [creditors])
  const topDebtors = useMemo(() => topDebt(debtors), [debtors])
  const topCreditors = useMemo(() => topDebt(creditors), [creditors])
  const customerNames = useMemo(() => new Map(debtors.map(d => [d.id, d.name])), [debtors])

  const feed = useMemo<FeedDoc[]>(() => {
    if (!feedRaw) return []
    const time = (iso: string) => formatDateTime(iso)
    const out: FeedDoc[] = [
      ...feedRaw.sales.map(d => ({
        key: `sale:${d.id}`, typeKey: docTypeKey('sale'), number: d.number, dateLabel: time(d.doc_date), createdAt: d.created_at,
        party: d.customer_name, figure: formatPrice(num(d.total)), status: d.status, href: docHref('sale', d.id),
      })),
      ...feedRaw.receipts.map(d => ({
        key: `receipt:${d.id}`, typeKey: docTypeKey('receipt'), number: d.number, dateLabel: time(d.doc_date), createdAt: d.created_at,
        party: d.supplier_name ?? '', figure: formatPrice(num(d.total)), status: d.status, href: docHref('receipt', d.id),
      })),
      ...feedRaw.productions.map(d => {
        const item = itemById.get(d.output_item_id)
        return {
          key: `production:${d.id}`, typeKey: docTypeKey('production'), number: d.number, dateLabel: time(d.doc_date), createdAt: d.created_at,
          party: item?.name ?? '', figure: `${formatQty(num(d.output_qty))} ${item ? t(unitKey(item.unit)) : ''}`.trim(), status: d.status, href: docHref('production', d.id),
        }
      }),
      ...feedRaw.separations.map(d => {
        const item = itemById.get(d.milk_item_id)
        return {
          key: `separation:${d.id}`, typeKey: docTypeKey('separation'), number: d.number, dateLabel: time(d.doc_date), createdAt: d.created_at,
          party: item?.name ?? '', figure: `${formatQty(num(d.milk_qty))} ${item ? t(unitKey(item.unit)) : ''}`.trim(), status: d.status, href: docHref('separation', d.id),
        }
      }),
      ...feedRaw.custPays.map(d => ({
        key: `cp:${d.id}`, typeKey: cashSourceKey('customer_payment'), number: d.number, dateLabel: dmy(d.pay_date), createdAt: d.created_at,
        party: customerNames.get(d.customer_id) ?? '', figure: formatPrice(num(d.amount)), status: d.status, href: cashSourceHref('customer_payment'),
      })),
      ...feedRaw.supPays.map(d => ({
        key: `sp:${d.id}`, typeKey: cashSourceKey('supplier_payment'), number: d.number, dateLabel: dmy(d.pay_date), createdAt: d.created_at,
        party: supplierNames.get(d.supplier_id) ?? '', figure: formatPrice(num(d.amount)), status: d.status, href: cashSourceHref('supplier_payment'),
      })),
    ]
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, FEED_SIZE)
  }, [feedRaw, itemById, customerNames, supplierNames, formatPrice, t])

  // ---- KPI cards -------------------------------------------------------------
  const prevTitle = `${t('prodDash.vsPrev')}: ${dmy(prev.from)} – ${dmy(prev.to)}`
  const periodBusy = periodLoading || refsLoading || salesPending || !dashReady

  const periodKpis: KpiCardProps[] = [
    ...(showSales ? [{
      label: t('prodDash.kpi.revenue'), value: formatPrice(sales.cur.revenue), icon: Receipt, href: '/zavod-hisobotlar/sotuv',
      // Gross profit and margin (owner / admin) as a sub-line instead of a card of their own.
      sub: seesMargin
        ? `${t('prodDash.kpi.grossProfit')}: ${formatPrice(sales.cur.margin)} · ${formatMarginPct(marginPct(sales.cur.margin, sales.cur.revenue))}`
          + (netProfit !== null ? ` · ${t('prodAcct.dash.netProfit')}: ${formatPrice(netProfit)}` : '')
        : undefined,
      subTone: seesMargin && (sales.cur.margin < 0 || (netProfit !== null && netProfit < 0)) ? 'negative' as const : undefined,
      delta: { value: pctChange(sales.cur.revenue, sales.prv.revenue), title: `${prevTitle} · ${formatPrice(sales.prv.revenue)}` },
      spark: sales.series.map(s => s.revenue),
    }] : []),
    ...(canMilk ? [{
      label: t('prodDash.kpi.milk'), value: kgText(milk.cur?.receivedKg ?? 0), icon: Milk, href: '/zavod-hisobotlar/sut',
      sub: `${t('prodDash.kpi.avgFat')}: ${formatPct(milk.cur?.fat)}`,
      delta: { value: pctChange(milk.cur?.receivedKg ?? 0, milk.prv?.receivedKg ?? 0), title: `${prevTitle} · ${kgText(milk.prv?.receivedKg ?? 0)}` },
      spark: milk.series.map(s => s.kg),
    }] : []),
    ...(canProduction ? [{
      label: t('prodDash.kpi.output'), value: kgText(output.curKg), icon: Factory, href: '/ishlab-chiqarish',
      sub: output.unconverted > 0
        ? `${output.curDocs} ${t('prodDash.kpi.docs')} · ${output.unconverted} ${t('prodDash.kpi.notKg')}`
        : `${output.curDocs} ${t('prodDash.kpi.docs')}`,
      delta: { value: pctChange(output.curKg, output.prvKg), title: `${prevTitle} · ${kgText(output.prvKg)}` },
      spark: output.total,
    }] : []),
  ]

  const nowKpis: KpiCardProps[] = [
    ...(showCash ? [{
      label: t('prodDash.kpi.cashTotal'), value: formatPrice(cashTotal), icon: Landmark, href: '/zavod-kassa',
      tone: cashTotal < 0 ? 'negative' as const : undefined,
      sub: cashByKind.length > 1 ? cashByKind.map(k => `${t(accountKindKey(k.kind))}: ${formatShortPrice(k.total)}`).join(' · ') : undefined,
    }] : []),
    ...(showSales ? [{
      label: t('prodDash.kpi.receivables'), value: formatPrice(receivables.balance), icon: AlarmClock, href: '/zavod-hisobotlar/debitorlik',
      sub: `${t('prodDash.kpi.overdue')}: ${formatPrice(receivables.overdue)}`,
      tone: receivables.overdue > 0 ? 'negative' as const : undefined,
    }] : []),
    ...(canSuppliers ? [{
      label: t('prodDash.kpi.payables'), value: formatPrice(payables.balance), icon: Wallet, href: '/zavod-yetkazuvchilar',
      sub: `${t('prodDash.kpi.overdue')}: ${formatPrice(payables.overdue)}`,
      tone: payables.overdue > 0 ? 'negative' as const : undefined,
    }] : []),
    ...(canStock ? [{
      label: t('prodDash.kpi.stockValue'), value: formatPrice(stockValue), icon: Boxes, href: '/zavod-qoldiq',
      // Expiring / expired lots as a sub-line (the list below has the details).
      sub: riskLots.length > 0
        ? `${t('prodUx.expiringShort')}: ${formatPrice(riskValue)} (${expiredCount} ${t('prodDash.kpi.expired')} · ${riskLots.length - expiredCount} ${t('prodDash.kpi.soon')})`
        : undefined,
      subTone: expiredCount > 0 ? 'negative' as const : riskLots.length > 0 ? 'warning' as const : undefined,
    }] : []),
  ]
  const nowBusy = nowLoading || refsLoading || salesPending || (showCash && cashLoading) || (canCash && cashAvailable === null)

  const nothing = !canProduction && !canMilk && !canStock && !canSuppliers && !showSales && !showCash && !canSupply && !salesPending
  const kpiRowCls = (n: number) => cn(
    'grid grid-cols-1 gap-4 min-[420px]:grid-cols-2',
    n === 3 ? 'lg:grid-cols-3' : n <= 2 ? '' : 'lg:grid-cols-4',
  )

  // Shortcuts to the daily documents, only those the user may create.
  const quickActions: { href: string; label: string; icon: LucideIcon }[] = [
    ...(canMilk ? [{ href: '/sut-qabuli/yangi', label: t('prodUx.qMilk'), icon: Milk }] : []),
    ...(canProduction ? [{ href: '/ishlab-chiqarish/yangi', label: t('prodUx.qProduction'), icon: Factory }] : []),
    ...(showSales ? [{ href: '/zavod-sotuv/yangi', label: t('prodUx.qSale'), icon: Receipt }] : []),
    ...(showCustPays ? [{ href: '/zavod-mijoz-tolovlari?new=1', label: t('prodUx.qPayment'), icon: CreditCard }] : []),
    ...(canReceipts ? [{ href: '/xom-ashyo-kirim/yangi', label: t('prodUx.qReceipt'), icon: PackagePlus }] : []),
    ...(showCash ? [{ href: '/zavod-kassa-orderlar?new=1', label: t('prodUx.qCashOrder'), icon: ReceiptText }] : []),
  ]
  const hasMoreCharts = showSales || salesPending || canStock || canProduction || showOutflows || canSuppliers

  const axis = { tick: theme.axisTick, axisLine: false, tickLine: false } as const
  const xBuckets = { dataKey: 'key', tickFormatter: bucketLabel, interval: 'preserveStartEnd' as const, minTickGap: 18, ...axis }
  const tooltipCursor = { stroke: theme.cursor, strokeWidth: 1 }
  const truncate = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const seriesColor = (key: string) => sliceColor(key, output.keys.indexOf(key))

  const debtChart = (data: ReturnType<typeof topDebt>) => (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid {...theme.grid} horizontal={false} vertical />
        <XAxis type="number" tickFormatter={shortMoney} {...axis} />
        <YAxis type="category" dataKey="name" width={112} tickFormatter={(v: string) => truncate(v, 16)} {...axis} />
        <Tooltip
          cursor={{ fill: theme.cursor }}
          content={<ChartTooltip
            names={{ notOverdue: t('prodDash.charts.notOverdue'), overdue: t('prodDash.charts.overdue') }}
            format={v => formatPrice(v)}
            extra={d => [{ label: t('prodDash.charts.total'), value: formatPrice(Number(d.balance ?? 0)) }]}
          />}
        />
        <Bar dataKey="notOverdue" stackId="d" fill={theme.primary} maxBarSize={20} />
        <Bar dataKey="overdue" stackId="d" fill={theme.danger} radius={[0, 4, 4, 0]} maxBarSize={20} />
      </BarChart>
    </ResponsiveContainer>
  )
  const debtLegend = (
    <LegendRow items={[
      { label: t('prodDash.charts.notOverdue'), color: theme.primary },
      { label: t('prodDash.charts.overdue'), color: theme.danger },
    ]} />
  )

  return (
    <div className="min-w-0 space-y-5">
      {/* 1. Header: title, period presets, comparison period */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.dashboard.title')}</h1>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Segmented<DashPreset | 'custom'>
            value={preset ?? 'custom'}
            onChange={v => { if (v !== 'custom') setRange(presetRange(v)) }}
            options={[
              ...DASH_PRESETS.map(p => ({ value: p, label: t(PRESET_KEYS[p]) })),
              ...(preset ? [] : [{ value: 'custom' as const, label: t('prodDash.custom') }]),
            ]}
          />
          <DateRangeFilter value={range} onChange={v => setRange(v ?? presetRange('thisMonth'))} />
          {canStock && <Link href="/zavod-hisobotlar" className={secondaryBtnCls}><FileBarChart className="h-3.5 w-3.5" /> {t('prodReports.nav')}</Link>}
        </div>
      </div>
      <p className="-mt-3 text-[12px] text-gray-400 dark:text-gray-500">{prevTitle}</p>

      {quickActions.length > 0 && (
        <nav aria-label={t('prodUx.quickTitle')} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {quickActions.map(a => (
            <Link key={a.href} href={a.href} className={cn(secondaryBtnCls, 'justify-center bg-white dark:bg-gray-900')}>
              <a.icon className="h-4 w-4 text-gray-400" /> {a.label}
            </Link>
          ))}
        </nav>
      )}

      {nothing && (
        <div className={cn(prodCardCls, 'p-6 text-sm text-gray-500 dark:text-gray-400')}>{t('prodCash.dashboard.noAccess')}</div>
      )}

      {/* 2. KPI row: selected period */}
      {(canSales || canMilk || canProduction) && (periodBusy || periodKpis.length > 0) && !nothing && (
        <section className="space-y-2">
          <SectionTitle>{t('prodCash.dashboard.periodTitle')}</SectionTitle>
          {periodBusy
            ? <KpiSkeletonRow count={4} cls={kpiRowCls(4)} />
            : <div className={kpiRowCls(periodKpis.length)}>{periodKpis.map(k => <KpiCard key={k.label} {...k} />)}</div>}
        </section>
      )}

      {/* 3. KPI row: current state */}
      {(canCash || canSales || canSuppliers || canStock) && (nowBusy || nowKpis.length > 0) && !nothing && (
        <section className="space-y-2">
          <SectionTitle>{t('prodCash.dashboard.nowTitle')}</SectionTitle>
          {nowBusy
            ? <KpiSkeletonRow count={4} cls={kpiRowCls(4)} />
            : <div className={kpiRowCls(nowKpis.length)}>{nowKpis.map(k => <KpiCard key={k.label} {...k} />)}</div>}
        </section>
      )}

      {/* 4. Charts: the four essentials, the rest behind "Ko'proq" */}
      <div className="grid grid-flow-row-dense grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {/* a. Revenue vs cost vs profit */}
        {(showSales || salesPending) && (
          <ChartCard
            className="md:col-span-2"
            title={seesMargin ? t('prodDash.charts.revenueCost') : t('prodDash.charts.revenueTitle')}
            action={<LegendRow items={[
              { label: t('prodDash.kpi.revenue'), color: theme.primary },
              ...(seesMargin ? [
                { label: t('prodDash.charts.cost'), color: theme.soft, dashed: true },
                { label: t('prodDash.charts.profit'), color: theme.accent },
              ] : []),
            ]} />}
            loading={periodBusy} empty={!sales.hasCur} emptyText={noData}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sales.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid {...theme.grid} />
                <XAxis {...xBuckets} />
                <YAxis tickFormatter={shortMoney} width={56} {...axis} />
                <Tooltip cursor={tooltipCursor} content={<ChartTooltip
                  labelOf={bucketTitle}
                  names={{ revenue: t('prodDash.kpi.revenue'), cost: t('prodDash.charts.cost'), profit: t('prodDash.charts.profit') }}
                  format={v => formatPrice(v)}
                />} />
                <Line type="monotone" dataKey="revenue" stroke={theme.primary} strokeWidth={2} dot={dots} activeDot={{ r: 4, stroke: theme.dotStroke, strokeWidth: 2 }} />
                {seesMargin && <Line type="monotone" dataKey="cost" stroke={theme.soft} strokeWidth={1.5} strokeDasharray="5 4" dot={dots} />}
                {seesMargin && <Line type="monotone" dataKey="profit" stroke={theme.accent} strokeWidth={2} dot={dots} />}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* c. Sales by product group */}
        {(showSales || salesPending) && (
          <ChartCard title={t('prodDash.charts.salesByGroup')} loading={periodBusy} empty={sales.groups.length === 0} emptyText={noData} height={300} autoHeight>
            <DonutBlock slices={sales.groups} format={formatPrice} centerLabel={t('prodDash.charts.total')} />
          </ChartCard>
        )}

        {/* b. Milk intake kg + average fat % (right axis) */}
        {canMilk && (
          <ChartCard
            className="md:col-span-2"
            title={t('prodDash.charts.milkTitle')}
            href="/zavod-hisobotlar/sut" linkLabel={t('production.dashboard.viewAll')}
            action={<LegendRow items={[
              { label: t('prodDash.charts.milkKg'), color: theme.primary },
              { label: t('prodDash.charts.fatPct'), color: theme.accent },
            ]} />}
            loading={periodBusy} empty={!milk.hasCur} emptyText={noData}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={milk.series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid {...theme.grid} />
                <XAxis {...xBuckets} />
                <YAxis yAxisId="kg" tickFormatter={shortNumber} width={52} {...axis}
                  label={{ value: kg, angle: -90, position: 'insideLeft', fill: theme.axisTick.fill, fontSize: 11, offset: 10 }} />
                <YAxis yAxisId="fat" orientation="right" width={44} domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(1)} {...axis}
                  label={{ value: t('prodDash.charts.fatPct'), angle: 90, position: 'insideRight', fill: theme.axisTick.fill, fontSize: 11, offset: 4 }} />
                <Tooltip cursor={tooltipCursor} content={<ChartTooltip
                  labelOf={bucketTitle}
                  names={{ kg: t('prodDash.charts.milkKg'), fat: t('prodDash.charts.fatPct') }}
                  format={(v, key) => (key === 'fat' ? formatPct(v) : kgText(v))}
                />} />
                <Area yAxisId="kg" type="monotone" dataKey="kg" stroke={theme.primary} strokeWidth={2} fill={theme.primary} fillOpacity={0.08} dot={dots} />
                <Line yAxisId="fat" type="monotone" dataKey="fat" stroke={theme.accent} strokeWidth={2} dot={dots} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* g. Cash balance per day */}
        {showCash && (
          <ChartCard
            title={t('prodDash.charts.cashBalance')}
            href="/zavod-kassa" linkLabel={t('production.dashboard.viewAll')}
            loading={cashPeriodLoading || cashLoading} empty={accounts.length === 0} emptyText={noData}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cashSeries} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid {...theme.grid} />
                <XAxis {...xBuckets} />
                <YAxis tickFormatter={shortMoney} width={56} {...axis} />
                <Tooltip cursor={tooltipCursor} content={<ChartTooltip
                  labelOf={k => (gran === 'month' ? `${bucketTitle(k)} · ${dmy(bucketEndYmd(k, gran, range.to))}` : bucketTitle(k))}
                  names={{ balance: t('prodDash.charts.balance') }}
                  format={v => formatPrice(v)}
                />} />
                <Line type="monotone" dataKey="balance" stroke={theme.primary} strokeWidth={2} dot={dots} activeDot={{ r: 4, stroke: theme.dotStroke, strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {hasMoreCharts && (
        <div className="flex justify-center">
          <button type="button" onClick={() => setShowMore(v => !v)} aria-expanded={showMore} className={secondaryBtnCls}>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', showMore && 'rotate-180')} />
            {showMore ? t('prodUx.showLess') : t('prodUx.showMore')}
          </button>
        </div>
      )}

      {hasMoreCharts && showMore && (
        <div className="grid grid-flow-row-dense grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {/* d. Stock value by warehouse / item type */}
        {canStock && (
          <ChartCard
            title={t('prodDash.charts.stockTitle')}
            action={<Segmented<'warehouse' | 'type'> value={stockView} onChange={setStockView} options={[
              { value: 'warehouse', label: t('prodDash.charts.byWarehouse') },
              { value: 'type', label: t('prodDash.charts.byType') },
            ]} />}
            loading={nowLoading || refsLoading} empty={stockSlices.length === 0} emptyText={noDataNow} height={300} autoHeight
          >
            <DonutBlock slices={stockSlices} format={formatPrice} centerLabel={t('prodDash.charts.total')} />
          </ChartCard>
        )}

        {/* h. Daily output by top 5 products (kg) */}
        {canProduction && (
          <ChartCard
            className="md:col-span-2"
            title={t('prodDash.charts.outputByDay')}
            subtitle={output.unconverted > 0 ? `${output.unconverted} ${t('prodDash.kpi.notKg')}` : undefined}
            href="/ishlab-chiqarish" linkLabel={t('production.dashboard.viewAll')}
            loading={periodBusy} empty={!output.hasCur} emptyText={noData}
            footer={<div className="mt-3"><LegendRow items={output.keys.map(k => ({ label: outputName(k), color: seriesColor(k) }))} /></div>}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={output.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid {...theme.grid} />
                <XAxis {...xBuckets} />
                <YAxis tickFormatter={shortNumber} width={52} {...axis} />
                <Tooltip cursor={{ fill: theme.cursor }} content={<ChartTooltip
                  labelOf={bucketTitle}
                  names={Object.fromEntries(output.keys.map(k => [k, outputName(k)]))}
                  format={v => kgText(v)}
                />} />
                {output.keys.map((k, i) => (
                  <Bar key={k} dataKey={k} stackId="o" fill={seriesColor(k)} maxBarSize={28}
                    radius={i === output.keys.length - 1 ? [4, 4, 0, 0] : undefined} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* e. Top 10 products by revenue */}
        {(showSales || salesPending) && (
          <ChartCard
            title={t('prodDash.charts.topProducts')}
            subtitle={seesMargin ? t('prodDash.charts.topProductsHint') : undefined}
            loading={periodBusy} empty={sales.top.length === 0} emptyText={noData}
            height={Math.max(160, sales.top.length * 30 + 24)}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sales.top} layout="vertical" margin={{ top: 0, right: seesMargin ? 48 : 8, bottom: 0, left: 0 }} barCategoryGap="24%">
                <CartesianGrid {...theme.grid} horizontal={false} vertical />
                <XAxis type="number" tickFormatter={shortMoney} {...axis} />
                <YAxis type="category" dataKey="name" width={112} tickFormatter={(v: string) => truncate(v, 16)} {...axis} />
                <Tooltip cursor={{ fill: theme.cursor }} content={<ChartTooltip
                  names={{ revenue: t('prodDash.kpi.revenue') }}
                  format={v => formatPrice(v)}
                  extra={seesMargin ? d => [{
                    label: t('prodDash.charts.profit'),
                    value: `${formatPrice(Number(d.margin ?? 0))} · ${String(d.marginLabel ?? '')}`,
                    tone: Number(d.margin ?? 0) < 0 ? 'negative' : undefined,
                  }] : undefined}
                />} />
                <Bar dataKey="revenue" fill={theme.primary} radius={[0, 4, 4, 0]} maxBarSize={18}>
                  {seesMargin && <LabelList dataKey="marginLabel" position="right" fill={theme.axisTick.fill} fontSize={11} />}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {showOutflows && (
          <ChartCard
            title={t('prodDash.charts.outflows')}
            subtitle={t(showCash && canSupply ? 'prodDash.charts.outflowsHint' : showCash ? 'prodDash.charts.outflowsHintCash' : 'prodDash.charts.outflowsHintSupply')}
            loading={cashPeriodLoading} empty={outflowSlices.length === 0} emptyText={noData} height={300} autoHeight
          >
            <DonutBlock slices={outflowSlices} format={formatPrice} centerLabel={t('prodDash.charts.total')} />
          </ChartCard>
        )}

        {/* f. Top debtors / creditors, overdue part stacked */}
        {(showSales || salesPending) && (
          <ChartCard
            title={t('prodDash.charts.topDebtors')}
            href="/zavod-hisobotlar/debitorlik" linkLabel={t('production.dashboard.viewAll')}
            loading={nowLoading || salesPending} empty={topDebtors.length === 0} emptyText={noDataNow}
            height={Math.max(140, topDebtors.length * 36 + 24)}
            footer={<div className="mt-3">{debtLegend}</div>}
          >
            {debtChart(topDebtors)}
          </ChartCard>
        )}
        {canSuppliers && (
          <ChartCard
            title={t('prodDash.charts.topCreditors')}
            href="/zavod-yetkazuvchilar" linkLabel={t('production.dashboard.viewAll')}
            loading={nowLoading} empty={topCreditors.length === 0} emptyText={noDataNow}
            height={Math.max(140, topCreditors.length * 36 + 24)}
            footer={<div className="mt-3">{debtLegend}</div>}
          >
            {debtChart(topCreditors)}
          </ChartCard>
        )}
        </div>
      )}

      {/* 5. Lists */}
      <div className={cn('grid grid-cols-1 items-start gap-5 md:grid-cols-2', lowStock.length > 0 && 'xl:grid-cols-3')}>
        {canStock && (
          <div className={cn(prodCardCls, 'min-w-0 overflow-hidden')}>
            <div className={panelHeadCls}>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodDash.lists.expiringLots')}</h2>
              <Link href="/zavod-hisobotlar/muddat" className={panelLinkCls}>{t('production.dashboard.viewAll')}</Link>
            </div>
            {nowLoading || refsLoading ? <ListSkeleton /> : riskLots.length === 0 ? (
              <div className="flex h-32 items-center justify-center px-4 text-center text-sm text-gray-400 dark:text-gray-500">{t('prodDash.lists.noExpiring')}</div>
            ) : (
              <ul className="divide-y divide-gray-50 dark:divide-gray-800/60">
                {riskLots.slice(0, LIST_ROWS).map(l => {
                  const days = l.expiry_date ? daysUntil(l.expiry_date, today) : 0
                  const expired = l.state === 'expired'
                  return (
                    <li key={l.id ?? `${l.item_id}:${l.lot_no}`} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate text-gray-900 dark:text-gray-100">{l.item_name ?? '—'}</p>
                        <p className="truncate text-xs text-gray-400 dark:text-gray-500">
                          {[l.warehouse_name, l.lot_no ? `${t('production.lots.lotNo')} ${l.lot_no}` : null].filter(Boolean).join(' · ')}
                          {' · '}{formatQty(num(l.remaining_qty))} {l.item_unit ? t(unitKey(l.item_unit)) : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                          expired ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
                        )}>
                          {expired ? `${Math.abs(days)} ${t('prodDash.lists.daysOver')}` : days === 0 ? t('prodDash.lists.today') : `${days} ${t('prodDash.lists.daysLeft')}`}
                        </span>
                        <p className="mt-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">{formatPrice(num(l.value))}</p>
                        {(l.hold_status === 'hold' || l.hold_status === 'blocked') && (
                          <span className="mt-0.5 inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                            {t(l.hold_status === 'hold' ? 'prodInventory.hold.hold' : 'prodInventory.hold.blocked')}
                          </span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        {canStock && !nowLoading && !refsLoading && lowStock.length > 0 && (
          <div className={cn(prodCardCls, 'min-w-0 overflow-hidden')}>
            <div className={panelHeadCls}>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.dashboard.lowStock')}</h2>
              <Link href="/zavod-qoldiq" className={panelLinkCls}>{t('production.dashboard.viewAll')}</Link>
            </div>
            {(
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800 dark:text-gray-400">
                      <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                      <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{t('production.common.stockLeft')}</th>
                      <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{t('production.items.minStock')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowStock.slice(0, LIST_ROWS).map(({ item, qty }) => (
                      <tr key={item.id} className="border-b border-gray-50 last:border-0 dark:border-gray-800/60">
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-2 text-gray-900 dark:text-gray-100">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /> {item.name}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums whitespace-nowrap text-amber-700 dark:text-amber-400">{formatQty(qty)} {t(unitKey(item.unit))}</td>
                        <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(item.minStock ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {showFeed && (
          <div className={cn(prodCardCls, 'min-w-0 overflow-hidden', lowStock.length > 0 && 'md:col-span-2 xl:col-span-1')}>
            <div className={panelHeadCls}>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodDash.lists.recentDocs')}</h2>
            </div>
            {!feedRaw || refsLoading ? <ListSkeleton /> : feed.length === 0 ? (
              <div className="flex h-32 items-center justify-center px-4 text-center text-sm text-gray-400 dark:text-gray-500">{t('prodDash.lists.noDocs')}</div>
            ) : (
              <ul className="divide-y divide-gray-50 dark:divide-gray-800/60">
                {feed.map(d => {
                  const body = (
                    <>
                      <div className="min-w-0">
                        <p className="truncate text-gray-900 dark:text-gray-100">{t(d.typeKey)} #{d.number}{d.party ? ` · ${d.party}` : ''}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{d.dateLabel}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="font-medium tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{d.figure}</span>
                        {d.status === 'cancelled' && <DocStatusBadge status={d.status} />}
                      </div>
                    </>
                  )
                  return (
                    <li key={d.key}>
                      {d.href ? (
                        <Link href={d.href} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40">{body}</Link>
                      ) : (
                        <div className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">{body}</div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
