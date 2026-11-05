'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AlertTriangle, ArrowLeft, Check, ClipboardCheck, GitCompare, Loader2, Lock, ScanBarcode,
  Search, TrendingDown, TrendingUp, type LucideIcon,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/Pagination'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { formatDateTime } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { sortSizes } from '@/lib/sizes'
import {
  STOCK_COUNT_STATUS_LABEL_KEYS, STOCK_COUNT_STATUS_PILL, formatCountNumber, stockCountErrorKey,
  type StockCountItemRow, type StockCountRow,
} from '@/lib/stock-counts'

const PAGE_SIZE = 50
const MAX_SUGGESTIONS = 20

const thCls = 'px-3 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap'
const pillGroup = 'flex items-center gap-0.5 rounded-lg bg-gray-100 dark:bg-gray-800 p-1'
const segCls = (active: boolean) => cn(
  'flex h-8 items-center justify-center rounded-md px-3 text-[12.5px] font-medium transition-colors',
  active
    ? 'bg-slate-900 dark:bg-white shadow-sm border border-slate-900 dark:border-white text-white dark:text-gray-900'
    : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
)

type RowFilter = 'all' | 'counted' | 'uncounted' | 'diff'
const ROW_FILTERS: RowFilter[] = ['all', 'counted', 'uncounted', 'diff']

interface WarehouseRow { id: string; name: string }
interface SizeRow {
  id: string; product_id: string; size: string; color: string | null; stock: number
  purchase_price: number | null; barcode: string | null; sku: string | null
}
interface ProductRow { id: string; name: string; sku: string | null; barcode: string | null }

interface Line {
  id: string
  productId: string
  name: string
  variant: string
  size: string
  sku: string
  sizeSku: string
  barcode: string
  productBarcode: string
  stock: number
  price: number
}

interface ItemState { counted: number; expected: number | null; price: number | null }

interface ViewLine extends Line {
  counted: number | null
  expected: number | null
  unitPrice: number
  diff: number | null
}

// stock_counts / stock_count_items and their RPCs are not in
// lib/database.types.ts yet, so they go through an untyped client view.
function db(): SupabaseClient {
  return createClient() as unknown as SupabaseClient
}

function toItemMap(rows: StockCountItemRow[]): Map<string, ItemState> {
  return new Map(rows.map(r => [r.product_size_id, {
    counted: r.counted_qty,
    expected: r.expected_qty,
    price: r.purchase_price === null ? null : Number(r.purchase_price),
  }]))
}

function KpiCard({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5">
      <div className="flex w-9 h-9 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
        <Icon className="h-4 w-4 text-gray-400" />
      </div>
      <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

// Uncontrolled so typing never fights with scanner-driven updates; the parent
// remounts it (via `key`) whenever the committed value changes.
function CountInput({ value, onCommit, onInvalid }: {
  value: number | null
  onCommit: (v: number | null) => void
  onInvalid: () => void
}) {
  const initial = value === null ? '' : String(value)
  return (
    <input
      type="text"
      inputMode="numeric"
      defaultValue={initial}
      onFocus={e => e.currentTarget.select()}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
        else if (e.key === 'Escape') { e.currentTarget.value = initial; e.currentTarget.blur() }
      }}
      onBlur={e => {
        const raw = e.currentTarget.value.trim()
        if (raw === initial) return
        if (raw === '') { onCommit(null); return }
        if (!/^\d+$/.test(raw)) { e.currentTarget.value = initial; onInvalid(); return }
        const n = Number(raw)
        if (n === value) return
        onCommit(n)
      }}
      placeholder="—"
      className="h-8 w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100 placeholder:text-gray-300 dark:placeholder:text-gray-600 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
    />
  )
}

export default function StockCountDetailPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const params = useParams<{ id: string }>()
  const id = params.id

  const [count, setCount] = useState<StockCountRow | null>(null)
  const [warehouse, setWarehouse] = useState<WarehouseRow | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [items, setItems] = useState<Map<string, ItemState>>(new Map())
  const [pending, setPending] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  const [filter, setFilter] = useState<RowFilter>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const [scan, setScan] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [scanActive, setScanActive] = useState(-1)
  const [variantPick, setVariantPick] = useState<Line[] | null>(null)
  const [lastScanned, setLastScanned] = useState<{ id: string; tick: number } | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scanRef = useRef<HTMLInputElement>(null)

  const [completeOpen, setCompleteOpen] = useState(false)
  const [zeroUncounted, setZeroUncounted] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  // Every item mutation runs through one serial queue, so rapid scanner
  // input hits the DB in order and each RPC result can be written straight
  // into local state without racing an earlier/later response.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const enqueue = useCallback((job: () => Promise<void>) => {
    queue.current = queue.current.then(job).catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const supabase = db()
      const { data: countData } = await supabase
        .from('stock_counts')
        .select('id, number, warehouse_id, status, note, created_at, completed_at, zero_uncounted')
        .eq('id', id).maybeSingle()
      if (cancelled) return
      const c = countData as StockCountRow | null
      const { data: whData } = c
        ? await supabase.from('warehouses').select('id, name').eq('id', c.warehouse_id).maybeSingle()
        : { data: null }
      if (cancelled) return
      if (!c || !whData) {
        // Missing, other company (RLS), malformed id, or warehouse gone — all "not found".
        setCount(null)
        setWarehouse(null)
        setLoading(false)
        return
      }
      const [sizesRes, productsRes, itemsRes] = await Promise.all([
        fetchAllRows<SizeRow>((from, to) =>
          supabase.from('product_sizes')
            .select('id, product_id, size, color, stock, purchase_price, barcode, sku')
            .eq('warehouse_id', c.warehouse_id).order('id').range(from, to)),
        fetchAllRows<ProductRow>((from, to) =>
          supabase.from('products').select('id, name, sku, barcode').order('id').range(from, to)),
        fetchAllRows<StockCountItemRow>((from, to) =>
          supabase.from('stock_count_items')
            .select('id, count_id, product_size_id, counted_qty, expected_qty, purchase_price')
            .eq('count_id', c.id).order('id').range(from, to)),
      ])
      if (cancelled) return
      if (sizesRes.error || productsRes.error || itemsRes.error) toast.error(t('common.error'))

      const productMap = new Map(productsRes.data.map(p => [p.id, p]))
      const mapped: Line[] = sizesRes.data.map(sz => {
        const p = productMap.get(sz.product_id)
        return {
          id: sz.id,
          productId: sz.product_id,
          name: p?.name ?? '—',
          variant: [sz.color, sz.size].filter(Boolean).join(' / '),
          size: sz.size,
          sku: p?.sku ?? '',
          sizeSku: sz.sku ?? '',
          barcode: sz.barcode ?? '',
          productBarcode: p?.barcode ?? '',
          stock: sz.stock,
          price: Number(sz.purchase_price ?? 0),
        }
      })
      // Items whose variant is no longer in this warehouse still belong to the
      // count's history — keep them visible as bare rows.
      const known = new Set(mapped.map(l => l.id))
      for (const it of itemsRes.data) {
        if (known.has(it.product_size_id)) continue
        mapped.push({
          id: it.product_size_id, productId: '', name: '—', variant: '', size: '', sku: '', sizeSku: '',
          barcode: '', productBarcode: '', stock: 0, price: Number(it.purchase_price ?? 0),
        })
      }
      const sizeRank = new Map(sortSizes(Array.from(new Set(mapped.map(l => l.size)))).map((s, i) => [s, i]))
      mapped.sort((a, b) =>
        a.name.localeCompare(b.name)
        || (sizeRank.get(a.size) ?? 0) - (sizeRank.get(b.size) ?? 0)
        || a.variant.localeCompare(b.variant))

      setCount(c)
      setWarehouse(whData as WarehouseRow)
      setLines(mapped)
      setItems(toItemMap(itemsRes.data))
      setPending(new Map())
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [id, t, reloadKey])

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  const isDraft = count?.status === 'draft'
  const pcs = t('stockCount.pcs')

  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  const handleItemError = useCallback((message: string | undefined) => {
    toast.error(t(stockCountErrorKey(message)))
    // Closed or removed by someone else — re-read so the page goes read-only / not found.
    if (message?.includes('Count is not open') || message?.includes('Count not found')) reload()
  }, [t, reload])

  const reloadItems = useCallback(async () => {
    const supabase = db()
    const { data, error } = await fetchAllRows<StockCountItemRow>((from, to) =>
      supabase.from('stock_count_items')
        .select('id, count_id, product_size_id, counted_qty, expected_qty, purchase_price')
        .eq('count_id', id).order('id').range(from, to))
    if (!error) setItems(toItemMap(data))
  }, [id])

  // ─── Mutations ─────────────────────────────────────────────────────────────
  const increment = useCallback((line: Line) => {
    if (!count) return
    const countId = count.id
    setPending(prev => new Map(prev).set(line.id, (prev.get(line.id) ?? 0) + 1))
    setLastScanned(prev => ({ id: line.id, tick: (prev?.tick ?? 0) + 1 }))
    setFlashId(line.id)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashId(null), 1500)

    enqueue(async () => {
      const { data, error } = await db().rpc('increment_stock_count_item', {
        p_count_id: countId, p_product_size_id: line.id, p_delta: 1,
      })
      setPending(prev => {
        const next = new Map(prev)
        const n = (next.get(line.id) ?? 1) - 1
        if (n > 0) next.set(line.id, n)
        else next.delete(line.id)
        return next
      })
      if (error) { handleItemError(error.message); return }
      setItems(prev => {
        const next = new Map(prev)
        const cur = next.get(line.id)
        next.set(line.id, { counted: Number(data), expected: cur?.expected ?? null, price: cur?.price ?? null })
        return next
      })
    })
  }, [count, enqueue, handleItemError])

  const setQty = useCallback((line: Line, value: number | null) => {
    if (!count) return
    const countId = count.id
    setItems(prev => {
      const next = new Map(prev)
      if (value === null) next.delete(line.id)
      else next.set(line.id, { counted: value, expected: prev.get(line.id)?.expected ?? null, price: prev.get(line.id)?.price ?? null })
      return next
    })
    enqueue(async () => {
      const { error } = await db().rpc('set_stock_count_item', {
        p_count_id: countId, p_product_size_id: line.id, p_counted_qty: value,
      })
      if (error) {
        handleItemError(error.message)
        await reloadItems()
      }
    })
  }, [count, enqueue, handleItemError, reloadItems])

  async function executeComplete() {
    if (!count) return
    setCompleting(true)
    await queue.current // let in-flight scans land first
    const { error } = await db().rpc('complete_stock_count', {
      p_count_id: count.id, p_zero_uncounted: zeroUncounted,
    })
    setCompleting(false)
    if (error) { handleItemError(error.message); return }
    setCompleteOpen(false)
    toast.success(t('stockCount.detail.completeSuccess'))
    reload()
  }

  async function executeCancel() {
    if (!count) return
    setCancelling(true)
    await queue.current
    const { error } = await db().rpc('cancel_stock_count', { p_count_id: count.id })
    setCancelling(false)
    if (error) { handleItemError(error.message); return }
    setCancelOpen(false)
    toast.success(t('stockCount.detail.cancelSuccess'))
    reload()
  }

  // ─── Derived view ──────────────────────────────────────────────────────────
  const viewLines: ViewLine[] = useMemo(() => lines.map(l => {
    const it = items.get(l.id)
    const p = pending.get(l.id) ?? 0
    const counted = it ? it.counted + p : (p > 0 ? p : null)
    const expected = isDraft ? l.stock : (it?.expected ?? null)
    const unitPrice = isDraft ? l.price : (it?.price ?? l.price)
    const diff = counted !== null && expected !== null ? counted - expected : null
    return { ...l, counted, expected, unitPrice, diff }
  }), [lines, items, pending, isDraft])

  const summarize = useCallback((zeroMissing: boolean) => {
    let counted = 0, shortQty = 0, shortSum = 0, surplusQty = 0, surplusSum = 0, diffRows = 0
    for (const l of viewLines) {
      let diff = l.diff
      if (l.counted !== null) counted += 1
      else if (zeroMissing && l.expected !== null) diff = -l.expected
      if (diff === null || diff === 0) continue
      diffRows += 1
      if (diff < 0) { shortQty += -diff; shortSum += -diff * l.unitPrice }
      else { surplusQty += diff; surplusSum += diff * l.unitPrice }
    }
    return { counted, shortQty, shortSum, surplusQty, surplusSum, diffRows }
  }, [viewLines])

  const kpi = useMemo(() => summarize(false), [summarize])
  const completeSummary = useMemo(() => summarize(zeroUncounted), [summarize, zeroUncounted])
  const total = lines.length
  const progress = total > 0 ? Math.round((kpi.counted / total) * 100) : 0

  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase()
    return viewLines.filter(l => {
      if (filter === 'counted' && l.counted === null) return false
      if (filter === 'uncounted' && l.counted !== null) return false
      if (filter === 'diff' && (l.diff === null || l.diff === 0)) return false
      if (!q) return true
      return l.name.toLowerCase().includes(q)
        || l.sku.toLowerCase().includes(q)
        || l.sizeSku.toLowerCase().includes(q)
        || l.barcode.toLowerCase().includes(q)
        || l.variant.toLowerCase().includes(q)
    })
  }, [viewLines, filter, search])

  const totalPages = Math.max(1, Math.ceil(filteredLines.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paginated = filteredLines.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  // ─── Scanner / quick search ────────────────────────────────────────────────
  const index = useMemo(() => {
    const byBarcode = new Map<string, Line>()
    const bySizeSku = new Map<string, Line>()
    const byProductCode = new Map<string, Line[]>()
    for (const l of lines) {
      if (!l.productId) continue
      if (l.barcode) { const k = l.barcode.toLowerCase(); if (!byBarcode.has(k)) byBarcode.set(k, l) }
      if (l.sizeSku) { const k = l.sizeSku.toLowerCase(); if (!bySizeSku.has(k)) bySizeSku.set(k, l) }
      for (const code of [l.sku, l.productBarcode]) {
        if (!code) continue
        const k = code.toLowerCase()
        const arr = byProductCode.get(k)
        if (arr) { if (!arr.includes(l)) arr.push(l) } else byProductCode.set(k, [l])
      }
    }
    return { byBarcode, bySizeSku, byProductCode }
  }, [lines])

  const suggestions = useMemo(() => {
    const q = scan.trim().toLowerCase()
    if (q.length < 2) return []
    const out: Line[] = []
    for (const l of lines) {
      if (!l.productId) continue
      if (
        l.name.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q)
        || l.barcode.toLowerCase().includes(q) || l.sizeSku.toLowerCase().includes(q)
      ) {
        out.push(l)
        if (out.length >= MAX_SUGGESTIONS) break
      }
    }
    return out
  }, [scan, lines])

  const dropdown = variantPick ?? suggestions

  function pickLine(line: Line) {
    increment(line)
    setScan('')
    setVariantPick(null)
    setScanActive(-1)
    scanRef.current?.focus()
  }

  function onScanEnter(raw: string) {
    const code = raw.trim().toLowerCase()
    if (!code) return
    if (scanActive >= 0 && dropdown[scanActive]) { pickLine(dropdown[scanActive]); return }

    const exact = index.byBarcode.get(code) ?? index.bySizeSku.get(code)
    if (exact) { pickLine(exact); return }

    const variants = index.byProductCode.get(code)
    if (variants && variants.length === 1) { pickLine(variants[0]); return }

    // Clear the text either way so a scanner's next code starts fresh.
    setScan('')
    setScanActive(-1)
    if (variants && variants.length > 1) { setVariantPick(variants); setScanOpen(true); return }
    if (suggestions.length === 1) { pickLine(suggestions[0]); return }
    if (suggestions.length > 1) { setVariantPick(suggestions); setScanOpen(true); return }
    setVariantPick(null)
    toast.error(t('stockCount.detail.scanNotFound'), { description: raw.trim() })
  }

  const lastLine = lastScanned ? viewLines.find(l => l.id === lastScanned.id) ?? null : null

  // ─── Render ────────────────────────────────────────────────────────────────
  if (!loading && (!count || !warehouse)) {
    return (
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm px-4 py-16 flex flex-col items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
        <ClipboardCheck className="h-6 w-6 text-gray-300 dark:text-gray-600" />
        <p className="font-medium text-gray-900 dark:text-gray-100">{t('stockCount.notFound')}</p>
        <Link href="/inventarizatsiya" className="inline-flex items-center gap-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4" />{t('stockCount.backToList')}
        </Link>
      </div>
    )
  }

  function diffCls(diff: number | null) {
    if (diff === null) return 'text-gray-300 dark:text-gray-600'
    if (diff < 0) return 'text-red-600 dark:text-red-400'
    if (diff > 0) return 'text-emerald-600 dark:text-emerald-400'
    return 'text-gray-400 dark:text-gray-500'
  }
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
  const signedPrice = (n: number) => (n > 0 ? `+${formatPrice(n)}` : n < 0 ? `-${formatPrice(-n)}` : formatPrice(0))

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Link
            href="/inventarizatsiya"
            aria-label={t('stockCount.backToList')}
            title={t('stockCount.backToList')}
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 font-mono">
                {count ? formatCountNumber(count.number) : t('common.loading')}
              </h1>
              {count && (
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STOCK_COUNT_STATUS_PILL[count.status])}>
                  {t(STOCK_COUNT_STATUS_LABEL_KEYS[count.status])}
                </span>
              )}
            </div>
            {count && warehouse && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-700 dark:text-gray-300">{warehouse.name}</span>
                <span className="tabular-nums">{t('stockCount.detail.createdAt')}: {formatDateTime(count.created_at)}</span>
                {count.completed_at && (
                  <span className="tabular-nums">{t('stockCount.detail.completedAt')}: {formatDateTime(count.completed_at)}</span>
                )}
              </div>
            )}
            {count?.note && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                <span className="text-gray-400 dark:text-gray-500">{t('stockCount.detail.note')}:</span> {count.note}
              </p>
            )}
          </div>
        </div>
        {isDraft && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {t('stockCount.detail.cancelCount')}
            </button>
            <button
              type="button"
              onClick={() => { setZeroUncounted(false); setCompleteOpen(true) }}
              className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 px-4 py-2 text-sm font-medium transition-colors"
            >
              <Check className="h-4 w-4" />
              {t('stockCount.detail.complete')}
            </button>
          </div>
        )}
      </div>

      {count && !isDraft && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2 text-sm text-gray-600 dark:text-gray-400">
          <Lock className="h-4 w-4 shrink-0 text-gray-400" />
          {count.status === 'completed' ? t('stockCount.detail.readOnlyCompleted') : t('stockCount.detail.readOnlyCancelled')}
          {count.status === 'completed' && count.zero_uncounted && (
            <span className="text-gray-400 dark:text-gray-500">· {t('stockCount.detail.zeroUncountedApplied')}</span>
          )}
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard icon={ClipboardCheck} label={t('stockCount.detail.kpi.counted')}>
          <p className="text-[22px] font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {kpi.counted} <span className="text-sm font-normal text-gray-400 dark:text-gray-500">/ {total}</span>
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            <div className="h-full rounded-full bg-gray-900 dark:bg-gray-100 transition-all duration-200" style={{ width: `${progress}%` }} />
          </div>
        </KpiCard>
        <KpiCard icon={TrendingDown} label={t('stockCount.detail.kpi.shortage')}>
          <p className="text-[22px] font-semibold tabular-nums text-red-600 dark:text-red-400">
            {kpi.shortQty > 0 ? `-${kpi.shortQty}` : 0} <span className="text-sm font-normal">{pcs}</span>
          </p>
          <p className="mt-0.5 text-sm tabular-nums text-red-600 dark:text-red-400">{kpi.shortSum > 0 ? `-${formatPrice(kpi.shortSum)}` : formatPrice(0)}</p>
        </KpiCard>
        <KpiCard icon={TrendingUp} label={t('stockCount.detail.kpi.surplus')}>
          <p className="text-[22px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {kpi.surplusQty > 0 ? `+${kpi.surplusQty}` : 0} <span className="text-sm font-normal">{pcs}</span>
          </p>
          <p className="mt-0.5 text-sm tabular-nums text-emerald-600 dark:text-emerald-400">{kpi.surplusSum > 0 ? `+${formatPrice(kpi.surplusSum)}` : formatPrice(0)}</p>
        </KpiCard>
        <KpiCard icon={GitCompare} label={t('stockCount.detail.kpi.diffRows')}>
          <p className="text-[22px] font-semibold tabular-nums text-gray-900 dark:text-gray-100">{kpi.diffRows}</p>
          <p className="mt-0.5 text-sm text-gray-400 dark:text-gray-500">{kpi.diffRows} {t('stockCount.detail.kpi.diffRowsSub')}</p>
        </KpiCard>
      </div>

      {/* Scanner */}
      {isDraft && (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 space-y-3">
          <div className="relative">
            <ScanBarcode className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
            <input
              ref={scanRef}
              autoFocus
              value={scan}
              onChange={e => { setScan(e.target.value); setVariantPick(null); setScanActive(-1); setScanOpen(true) }}
              onFocus={() => setScanOpen(true)}
              onBlur={() => setScanOpen(false)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); onScanEnter(e.currentTarget.value) }
                else if (e.key === 'ArrowDown') { e.preventDefault(); setScanOpen(true); setScanActive(i => Math.min(i + 1, dropdown.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setScanActive(i => Math.max(i - 1, 0)) }
                else if (e.key === 'Escape') { setScan(''); setVariantPick(null); setScanActive(-1) }
              }}
              placeholder={t('stockCount.detail.scanPlaceholder')}
              autoComplete="off"
              className="h-12 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-11 pr-36 text-base text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
            />
            <span className="pointer-events-none absolute right-3.5 top-1/2 hidden -translate-y-1/2 text-xs text-gray-400 dark:text-gray-500 sm:block">
              {t('stockCount.detail.scanHint')}
            </span>
            {scanOpen && dropdown.length > 0 && (
              <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 p-1 shadow-md">
                {variantPick && (
                  <p className="px-2 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500">{t('stockCount.detail.pickVariant')}</p>
                )}
                {dropdown.map((l, i) => {
                  const v = viewLines.find(x => x.id === l.id)
                  return (
                    <div
                      key={l.id}
                      role="option"
                      aria-selected={i === scanActive}
                      onMouseDown={e => e.preventDefault()}
                      onMouseEnter={() => setScanActive(i)}
                      onClick={() => pickLine(l)}
                      className={cn(
                        'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors',
                        i === scanActive ? 'bg-gray-50 dark:bg-gray-800' : '',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {l.name}
                          {l.variant && <span className="font-normal text-gray-400 dark:text-gray-500"> · {l.variant}</span>}
                        </p>
                        <p className="font-mono text-[11px] text-gray-500 dark:text-gray-400">{[l.sku, l.barcode].filter(Boolean).join(' · ') || '—'}</p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums text-gray-500 dark:text-gray-400">{v?.counted ?? '—'} / {l.stock}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {lastLine && (
            <div
              key={lastScanned?.tick}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors duration-200',
                flashId === lastLine.id
                  ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-500/10'
                  : 'border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50',
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Check className={cn('h-4 w-4 shrink-0', flashId === lastLine.id ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400')} />
                <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{t('stockCount.detail.lastScanned')}:</span>
                <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {lastLine.name}
                  {lastLine.variant && <span className="font-normal text-gray-400 dark:text-gray-500"> · {lastLine.variant}</span>}
                </span>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {lastLine.counted ?? 0} <span className="font-normal text-gray-400 dark:text-gray-500">/ {lastLine.expected ?? '—'}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Lines table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 p-4">
          <div className={pillGroup}>
            {ROW_FILTERS.map(f => (
              <button key={f} type="button" onClick={() => { setFilter(f); setPage(1) }} className={segCls(filter === f)}>
                {t(`stockCount.detail.filters.${f}`)}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              placeholder={t('stockCount.detail.searchPlaceholder')}
              className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
          </div>
        ) : lines.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-gray-400 dark:text-gray-500">{t('stockCount.detail.emptyWarehouse')}</div>
        ) : filteredLines.length === 0 ? (
          <div className="px-4 py-16 text-center text-sm text-gray-400 dark:text-gray-500">{t('stockCount.detail.noResults')}</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className={cn(thCls, 'text-left')}>{t('stockCount.detail.table.name')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('stockCount.detail.table.sku')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('stockCount.detail.table.barcode')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('stockCount.detail.table.expected')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('stockCount.detail.table.counted')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('stockCount.detail.table.diff')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('stockCount.detail.table.diffSum')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map(l => {
                    const uncounted = l.counted === null
                    const dim = isDraft && uncounted
                    return (
                      <tr
                        key={l.id}
                        className={cn(
                          'border-b border-gray-100 dark:border-gray-800 last:border-b-0 text-sm transition-colors duration-200',
                          flashId === l.id ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/60',
                        )}
                      >
                        <td className={cn('px-3 py-2.5', dim ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100')}>
                          {l.name}
                          {l.variant && <span className="text-gray-400 dark:text-gray-500"> · {l.variant}</span>}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{l.sku || '—'}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{l.barcode || '—'}</td>
                        <td className={cn('px-3 py-2.5 text-right tabular-nums whitespace-nowrap', dim ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300')}>
                          {l.expected ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {isDraft ? (
                            <div className="flex justify-end">
                              <CountInput
                                key={`${l.id}:${l.counted ?? ''}`}
                                value={l.counted}
                                onCommit={v => setQty(l, v)}
                                onInvalid={() => toast.error(t('stockCount.errors.invalidQuantity'))}
                              />
                            </div>
                          ) : (
                            <span className={cn('tabular-nums', uncounted ? 'text-gray-300 dark:text-gray-600' : 'font-medium text-gray-900 dark:text-gray-100')}>
                              {l.counted ?? '—'}
                            </span>
                          )}
                        </td>
                        <td className={cn('px-3 py-2.5 text-right tabular-nums whitespace-nowrap font-medium', diffCls(l.diff))}>
                          {l.diff === null ? '—' : signed(l.diff)}
                        </td>
                        <td className={cn('px-3 py-2.5 text-right tabular-nums whitespace-nowrap', diffCls(l.diff))}>
                          {l.diff === null ? '—' : signedPrice(l.diff * l.unitPrice)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filteredLines.length}
              itemsPerPage={PAGE_SIZE}
              onPageChange={setPage}
            />
          </>
        )}
      </div>

      {/* Complete dialog */}
      <Dialog open={completeOpen} onOpenChange={open => { if (!completing) setCompleteOpen(open) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('stockCount.detail.completeTitle')}</DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-4">
            <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-100 dark:border-gray-800 text-sm">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-gray-500 dark:text-gray-400">{t('stockCount.detail.summaryCounted')}</span>
                <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{completeSummary.counted} / {total}</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-gray-500 dark:text-gray-400">{t('stockCount.detail.kpi.shortage')}</span>
                <span className="font-medium tabular-nums text-red-600 dark:text-red-400">
                  {completeSummary.shortQty > 0 ? `-${completeSummary.shortQty}` : 0} {pcs} · {completeSummary.shortSum > 0 ? `-${formatPrice(completeSummary.shortSum)}` : formatPrice(0)}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-gray-500 dark:text-gray-400">{t('stockCount.detail.kpi.surplus')}</span>
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                  {completeSummary.surplusQty > 0 ? `+${completeSummary.surplusQty}` : 0} {pcs} · {completeSummary.surplusSum > 0 ? `+${formatPrice(completeSummary.surplusSum)}` : formatPrice(0)}
                </span>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={zeroUncounted}
                onChange={e => setZeroUncounted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600"
              />
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t('stockCount.detail.zeroUncounted')}</span>
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{t('stockCount.detail.zeroUncountedHint')}</span>
              </span>
            </label>

            <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {t('stockCount.detail.completeWarning')}
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setCompleteOpen(false)} disabled={completing}>{t('common.cancel')}</Button>
            <Button onClick={executeComplete} disabled={completing} loading={completing}>{t('stockCount.detail.complete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onOpenChange={open => { if (!cancelling) setCancelOpen(open) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              {t('stockCount.detail.cancelTitle')}
            </DialogTitle>
          </DialogHeader>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('stockCount.detail.cancelConfirm')}</p>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>{t('common.close')}</Button>
            <Button variant="destructive" onClick={executeCancel} disabled={cancelling} loading={cancelling}>{t('stockCount.detail.cancelCount')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
