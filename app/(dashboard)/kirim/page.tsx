'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Search, X, Download, Package,
  PackageSearch, ArrowUpDown, Printer, Trash2, Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { StatsPanel } from '@/components/ui/StatsPanel'
import { Pagination } from '@/components/ui/Pagination'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { PrintLabelsModal, type LabelRow } from '@/components/kirim/PrintLabelsModal'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { StockInEntry, Product } from '@/lib/types'
import { type SizeType, getSizesForType } from '@/lib/sizes'
import { WAREHOUSE_TYPE_LABEL_KEYS, type WarehouseType } from '@/lib/warehouses'

const ITEMS_PER_PAGE = 20
const TODAY = new Date().toISOString().slice(0, 10)

type DatePreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'
type SortKey = 'date' | 'quantity' | 'unitPrice' | 'totalAmount' | 'purchasePrice' | 'sellingPrice'

const DATE_PRESETS: { value: DatePreset; labelKey: TranslationKey }[] = [
  { value: 'today', labelKey: 'kirim.datePresets.today' },
  { value: 'yesterday', labelKey: 'kirim.datePresets.yesterday' },
  { value: 'week', labelKey: 'kirim.datePresets.week' },
  { value: 'month', labelKey: 'kirim.datePresets.month' },
  { value: 'custom', labelKey: 'kirim.datePresets.custom' },
]

const pillCls = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
    active ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
  }`

const selectCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const dateInputCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const fieldCls = 'w-full h-11 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-900/40 transition-colors'

function formatDMY(dateStr: string): string {
  const [y, m, d] = dateStr.split('-')
  return `${d}.${m}.${y}`
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function presetRange(preset: DatePreset, customFrom: string, customTo: string): [string, string] | null {
  const [ty, tm, td] = TODAY.split('-').map(Number)
  const today = new Date(Date.UTC(ty, tm - 1, td))
  switch (preset) {
    case 'today': return [TODAY, TODAY]
    case 'yesterday': {
      const d = new Date(today); d.setUTCDate(d.getUTCDate() - 1)
      const s = ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
      return [s, s]
    }
    case 'week': {
      const d = new Date(today); const dow = (d.getUTCDay() + 6) % 7
      d.setUTCDate(d.getUTCDate() - dow)
      return [ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), TODAY]
    }
    case 'month': return [ymd(ty, tm, 1), TODAY]
    case 'custom':
      if (!customFrom || !customTo) return null
      return customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom]
  }
}

function nowLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function csvCell(value: string): string { return `"${value.replace(/"/g, '""')}"` }

interface ProductRow {
  id: string
  name: string
  sku: string | null
  category: string | null
  price: number
  description: string | null
  colors: string[] | null
  min_stock: number
  image_url: string | null
  status: 'active' | 'inactive'
  warehouse_id: string | null
}

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku ?? '',
    category: row.category ?? '',
    price: Number(row.price),
    description: row.description ?? '',
    colors: row.colors ?? [],
    minStock: row.min_stock,
    imageUrl: row.image_url ?? '',
    status: row.status,
    warehouseId: row.warehouse_id ?? '',
  }
}

interface StockInRow {
  id: string; product_id: string; product_name: string; category: string | null
  size: string | null; color: string | null; quantity: number; unit_price: number
  total_amount: number; purchase_price: number; selling_price: number
  supplier: string | null; date: string; note: string | null
  product_size_id: string | null
}

interface WarehouseRow { id: string; name: string; type: WarehouseType }

function mapStockIn(row: StockInRow): StockInEntry {
  return {
    id: row.id, productId: row.product_id, productName: row.product_name,
    category: row.category ?? '', size: row.size ?? '', color: row.color ?? '',
    quantity: row.quantity, unitPrice: Number(row.unit_price),
    totalAmount: Number(row.total_amount), purchasePrice: Number(row.purchase_price ?? 0),
    sellingPrice: Number(row.selling_price ?? 0), supplier: row.supplier ?? '',
    date: row.date, note: row.note ?? '',
    productSizeId: row.product_size_id ?? undefined,
  }
}

interface ProductSizeLookupRow { id: string; product_id: string; size: string; color: string | null; barcode: string | null }

// ─── Product name multi-select filter ──────────────────────────────────────

function ProductMultiSelect({
  names, selected, onChange,
}: { names: string[]; selected: string[]; onChange: (names: string[]) => void }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = names.filter(n => n.toLowerCase().includes(search.toLowerCase()))

  function toggle(name: string) {
    onChange(selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name])
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition-colors ${selected.length ? 'bg-white dark:bg-gray-900 shadow-sm border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
        {t('kirim.productFilter')}
        {selected.length > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 px-1 text-[11px] font-semibold">{selected.length}</span>}
      </button>
      {open && (
        <div className="absolute z-30 mt-1.5 w-72 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 shadow-lg">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
              placeholder={t('kirim.productSearchPlaceholder')}
              className="h-8 w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-8 pr-2 text-[13px] text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors" />
          </div>
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-gray-400">{t('kirim.notFound')}</p>
            ) : filtered.map(name => (
              <label key={name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
                <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600" />
                <span className="truncate">{name}</span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])}
              className="mt-2 w-full rounded-md py-1.5 text-center text-[12px] text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
              {t('kirim.clearSelection')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Name-based product search dropdown ────────────────────────────────────

function ProductNameSearch({
  products, value, onChange, placeholder, noWarehouseLabel,
}: {
  products: { id: string; name: string; category: string; warehouseId: string }[]
  value: string
  onChange: (productId: string) => void
  placeholder: string
  noWarehouseLabel: string
}) {
  const [search, setSearch] = useState('')

  useEffect(() => {
    const selected = products.find(p => p.id === value)
    setSearch(selected?.name ?? '')
  }, [value, products])

  const q = search.trim().toLowerCase()
  const filtered = q ? products.filter(p => p.name.toLowerCase().includes(q)) : products

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-gray-200 focus:border-gray-400 dark:focus:border-gray-500 px-4 py-2.5 pl-10 text-sm outline-none"
        />
      </div>
      {filtered.length > 0 && (
        <div className="mt-2 rounded-lg border border-gray-200 bg-white shadow-sm overflow-y-auto max-h-52">
          {filtered.map(p => (
            <div
              key={p.id}
              onClick={() => { onChange(p.id); setSearch(p.name) }}
              className={cn(
                'flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors border-b border-gray-100 last:border-b-0',
                p.id === value && 'bg-gray-50 border-l-2 border-gray-900',
              )}
            >
              <div className="flex items-center min-w-0">
                <Package className="w-4 h-4 text-gray-400 shrink-0 mr-2" />
                <span className="text-sm font-medium text-gray-800 truncate">{p.name}</span>
                {!p.warehouseId && (
                  <span className="ml-2 shrink-0 text-[11px] text-amber-600 italic">({noWarehouseLabel})</span>
                )}
              </div>
              <span className="shrink-0 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{p.category}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sortable column header ─────────────────────────────────────────────────

function SortHeader({ label, active, dir, align = 'left', onClick }: { label: string; active: boolean; dir: 'asc' | 'desc'; align?: 'left' | 'right'; onClick: () => void }) {
  return (
    <th onClick={onClick} className={`px-4 py-3 text-${align} text-[11px] font-medium uppercase tracking-wide cursor-pointer select-none transition-colors ${active ? 'text-gray-600 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}>
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}
        <ArrowUpDown className={`h-3 w-3 ${active ? 'text-gray-700 dark:text-gray-300' : 'text-gray-300 dark:text-gray-600'} ${active && dir === 'asc' ? 'rotate-180' : ''} transition-transform`} />
      </span>
    </th>
  )
}

// ───────────────────────────────────────────────────────────────────────────

const emptyForm = {
  warehouseId: '',
  productId: '',
  datetime: '',
  supplier: '',
  note: '',
  purchasePrice: '',
  markupPercent: '',
}

interface MatrixColumn { id: string; size: string }

export default function KirimPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [entries, setEntries] = useState<StockInEntry[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [categoryToSizeType, setCategoryToSizeType] = useState<Map<string, SizeType>>(new Map())
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [sizeLookup, setSizeLookup] = useState<ProductSizeLookupRow[]>([])

  const fetchEntries = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('stock_in_entries').select('*').order('date', { ascending: false })
    if (error) toast.error(t('common.error'))
    else setEntries((data as StockInRow[]).map(mapStockIn))
    setLoading(false)
  }, [t])

  // Backs the per-row "print labels" action: resolves a stock_in_entries
  // row to its product_sizes row (for the barcode) via product_size_id
  // first, falling back to a product_id+size+color match for legacy
  // entries saved before that column existed.
  const fetchSizeLookup = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase.from('product_sizes').select('id, product_id, size, color, barcode')
    setSizeLookup((data ?? []) as ProductSizeLookupRow[])
  }, [])

  const fetchProducts = useCallback(async () => {
    const supabase = createClient()
    const [{ data: prodData, error: prodErr }, { data: groupData, error: groupErr }, { data: whData, error: whErr }] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase.from('product_groups').select('name, size_type'),
      supabase.from('warehouses').select('id, name, type'),
    ])
    if (prodErr || whErr) { toast.error(t('common.error')); return }
    if (groupErr) console.error('[Sizes] product_groups fetch error (size_type column missing? Run migration):', groupErr.message)
    setProducts((prodData as ProductRow[]).map(mapProduct))
    const map = new Map<string, SizeType>()
    for (const g of (groupData ?? []) as { name: string; size_type: string | null }[]) {
      map.set(g.name, (g.size_type as SizeType) ?? 'clothing')
    }
    setCategoryToSizeType(map)
    setWarehouses((whData ?? []) as WarehouseRow[])
  }, [t])

  useEffect(() => { fetchEntries(); fetchProducts(); fetchSizeLookup() }, [fetchEntries, fetchProducts, fetchSizeLookup])

  // Filters
  const [datePreset, setDatePreset] = useState<DatePreset | null>(null)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [selectedNames, setSelectedNames] = useState<string[]>([])
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [supplierFilter, setSupplierFilter] = useState('all')
  const [search, setSearch] = useState('')

  // Table
  const [page, setPage] = useState(1)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Add modal
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [addStep, setAddStep] = useState<'form' | 'done'>('form')
  const [form, setForm] = useState(emptyForm)
  const [columns, setColumns] = useState<MatrixColumn[]>([])
  const [cellQty, setCellQty] = useState<Record<string, string>>({})
  const colIdRef = useRef(0)
  const [savedLabels, setSavedLabels] = useState<LabelRow[]>([])
  const [printLabelsOpen, setPrintLabelsOpen] = useState(false)

  function resetMatrix() {
    colIdRef.current = 1
    setColumns([{ id: 'col-1', size: '' }])
    setCellQty({})
  }

  function closeAddModal() {
    setIsAddOpen(false)
    setAddStep('form')
    setForm(emptyForm)
    resetMatrix()
    setSavedLabels([])
  }

  function addColumn() {
    const id = `col-${++colIdRef.current}`
    setColumns(prev => [...prev, { id, size: '' }])
  }

  function removeColumn(id: string) {
    setColumns(prev => prev.filter(c => c.id !== id))
    setCellQty(prev => {
      const next = { ...prev }
      for (const key of Object.keys(next)) if (key.endsWith(`::${id}`)) delete next[key]
      return next
    })
  }

  function setColumnSize(id: string, size: string) {
    setColumns(prev => prev.map(c => (c.id === id ? { ...c, size } : c)))
  }

  function cellKey(color: string, colId: string): string {
    return `${color}::${colId}`
  }

  function setCell(color: string, colId: string, value: string) {
    setCellQty(prev => ({ ...prev, [cellKey(color, colId)]: value }))
  }

  const activeWarehouse = useMemo(() => warehouses.find(w => w.id === form.warehouseId), [warehouses, form.warehouseId])
  // products.warehouse_id (set on the product itself, mahsulotlar/page.tsx)
  // is the source of truth for which warehouse a product belongs to —
  // matching product category to warehouse type was the old, broken
  // approach (see the warehouses migration for that incident writeup).
  // Legacy products with no warehouse assigned show up under every
  // warehouse (flagged with a muted badge in ProductNameSearch) rather
  // than being hidden, so they can still be stocked in and then fixed.
  const warehouseProducts = useMemo(() => {
    if (!activeWarehouse) return []
    return products.filter(p => !p.warehouseId || p.warehouseId === activeWarehouse.id)
  }, [products, activeWarehouse])
  const uniqueNames = useMemo(() => Array.from(new Set(products.map(p => p.name))).sort(), [products])
  const categoryOptions = useMemo(() => Array.from(new Set(products.map(p => p.category))).sort(), [products])
  const supplierOptions = useMemo(() => Array.from(new Set(entries.map(e => e.supplier).filter(Boolean))).sort(), [entries])

  const dateRange = useMemo(() => (datePreset ? presetRange(datePreset, customFrom, customTo) : null), [datePreset, customFrom, customTo])

  const filtered = useMemo(() => {
    let list = entries
    if (dateRange) { const [from, to] = dateRange; list = list.filter(e => { const d = e.date.slice(0, 10); return d >= from && d <= to }) }
    if (selectedNames.length) list = list.filter(e => selectedNames.includes(e.productName))
    if (categoryFilter !== 'all') list = list.filter(e => e.category === categoryFilter)
    if (supplierFilter !== 'all') list = list.filter(e => e.supplier === supplierFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(e => e.productName.toLowerCase().includes(q) || e.supplier.toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
    }
    return list
  }, [entries, dateRange, selectedNames, categoryFilter, supplierFilter, search])

  const sorted = useMemo(() => {
    const list = [...filtered]
    list.sort((a, b) => {
      const cmp = sortKey === 'date' ? a.date.localeCompare(b.date) : a[sortKey] - b[sortKey]
      return sortDir === 'asc' ? cmp : -cmp
    })
    return list
  }, [filtered, sortKey, sortDir])

  const totalPages = Math.ceil(sorted.length / ITEMS_PER_PAGE)
  const paginated = sorted.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  const todayEntries = entries.filter(e => e.date.slice(0, 10) === TODAY)
  const todayQty = todayEntries.reduce((s, e) => s + e.quantity, 0)
  const todaySum = todayEntries.reduce((s, e) => s + e.totalAmount, 0)
  const monthEntries = entries.filter(e => e.date.slice(0, 7) === TODAY.slice(0, 7))
  const monthQty = monthEntries.reduce((s, e) => s + e.quantity, 0)
  const monthSum = monthEntries.reduce((s, e) => s + e.totalAmount, 0)

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  function dateChipLabel(): string {
    if (datePreset === 'custom') {
      if (customFrom && customTo) return `${formatDMY(customFrom)} – ${formatDMY(customTo)}`
      return t('kirim.datePresets.custom')
    }
    const preset = DATE_PRESETS.find(d => d.value === datePreset)
    return preset ? t(preset.labelKey) : ''
  }

  function clearAllFilters() {
    setDatePreset(null); setCustomFrom(''); setCustomTo('')
    setSelectedNames([]); setCategoryFilter('all'); setSupplierFilter('all')
    setSearch(''); setPage(1)
  }

  const chips: { key: string; label: string; onRemove: () => void }[] = []
  if (datePreset) chips.push({ key: 'date', label: `📅 ${dateChipLabel()}`, onRemove: () => { setDatePreset(null); setCustomFrom(''); setCustomTo('') } })
  selectedNames.forEach(name => chips.push({ key: `prod-${name}`, label: name, onRemove: () => setSelectedNames(prev => prev.filter(x => x !== name)) }))
  if (categoryFilter !== 'all') chips.push({ key: 'cat', label: categoryFilter, onRemove: () => setCategoryFilter('all') })
  if (supplierFilter !== 'all') chips.push({ key: 'sup', label: supplierFilter, onRemove: () => setSupplierFilter('all') })
  if (search.trim()) chips.push({ key: 'search', label: `"${search.trim()}"`, onRemove: () => setSearch('') })

  const selectedProduct = warehouseProducts.find(p => p.id === form.productId)
  const colorRows = selectedProduct?.colors.length ? selectedProduct.colors : ['']
  const activeSizeType = selectedProduct ? (categoryToSizeType.get(selectedProduct.category) ?? 'clothing') : 'clothing'
  const activeSizes = getSizesForType(activeSizeType)

  function openAdd() {
    setForm({ ...emptyForm, datetime: nowLocal(), warehouseId: warehouses[0]?.id ?? '' })
    resetMatrix()
    setAddStep('form')
    setSavedLabels([])
    setIsAddOpen(true)
  }

  async function addEntry() {
    if (!form.warehouseId) {
      toast.error('Ombor tanlanishi shart')
      return
    }
    if (!form.purchasePrice || Number(form.purchasePrice) <= 0) {
      toast.error('Olish narxi kiritilishi shart')
      return
    }
    const product = warehouseProducts.find(p => p.id === form.productId)
    if (!product || !activeWarehouse) return

    const purchasePrice = Number(form.purchasePrice) || 0
    const markupPercent = Number(form.markupPercent) || 0
    const sellingPrice = Math.round(purchasePrice * (1 + markupPercent / 100))

    // Matrix cells: empty and 0 are both treated as "skip". Columns with no
    // size picked are skipped too.
    const entries = []
    for (const color of colorRows) {
      for (const col of columns) {
        if (!col.size) continue
        const qty = Number(cellQty[cellKey(color, col.id)] || 0)
        if (qty <= 0) continue
        entries.push({
          product_id: product.id,
          product_name: product.name,
          category: product.category,
          size: col.size,
          color,
          quantity: qty,
          purchase_price: purchasePrice,
          selling_price: sellingPrice,
          warehouse_id: activeWarehouse.id,
          supplier: form.supplier.trim(),
          date: form.datetime ? `${form.datetime}:00` : new Date().toISOString(),
          note: form.note.trim(),
        })
      }
    }

    if (!form.productId || entries.length === 0) {
      toast.error(t('kirim.toasts.requiredError'))
      return
    }

    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('stock_in', { p_entries: entries })

    setSaving(false)
    if (error) { toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error')); return }
    toast.success(`${t('kirim.toasts.addSuccess')} (${entries.length})`)

    // stock_in returns void — the barcode it auto-generated isn't known
    // client-side, so re-read the rows we just saved to build the label
    // list (matched back to `entries` by size+color).
    const { data: sizeRows } = await supabase
      .from('product_sizes')
      .select('size, color, barcode, selling_price')
      .eq('product_id', product.id)
    const labels: LabelRow[] = entries.map(e => {
      const row = (sizeRows ?? []).find(r => r.size === e.size && r.color === e.color)
      return {
        productName: product.name,
        color: e.color,
        size: e.size,
        sellingPrice: row?.selling_price ?? sellingPrice,
        barcode: row?.barcode ?? '',
        quantity: e.quantity,
      }
    })
    setSavedLabels(labels)
    setAddStep('done')
    fetchEntries()
    // The rows just inserted by stock_in may include product_sizes that
    // didn't exist before this save (new size/color combo, or a barcode
    // the RPC just auto-generated) — sizeLookup was only ever populated
    // once on mount, so it must be refreshed or the print-labels button
    // for these brand-new entries stays disabled until a full page reload.
    fetchSizeLookup()
  }

  async function deleteEntry(id: string) {
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_stock_in_entry', { p_id: id })
    if (error) { toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error')); return }
    toast.success(t('kirim.toasts.deleteSuccess'))
    fetchEntries()
  }

  function resolveProductSize(e: StockInEntry): ProductSizeLookupRow | undefined {
    if (e.productSizeId) {
      const byId = sizeLookup.find(r => r.id === e.productSizeId)
      if (byId) return byId
    }
    return sizeLookup.find(r => r.product_id === e.productId && r.size === e.size && (r.color ?? '') === e.color)
  }

  function printLabelsForEntry(e: StockInEntry) {
    const match = resolveProductSize(e)
    if (!match || !match.barcode) return
    setSavedLabels([{
      productName: e.productName,
      color: e.color,
      size: e.size,
      sellingPrice: e.sellingPrice,
      barcode: match.barcode,
      quantity: e.quantity,
    }])
    setPrintLabelsOpen(true)
  }

  function exportCSV() {
    const headers = [
      t('kirim.csvHeaders.number'), t('kirim.csvHeaders.date'), t('kirim.csvHeaders.product'),
      t('kirim.csvHeaders.category'), t('kirim.csvHeaders.size'), t('kirim.csvHeaders.color'),
      t('kirim.csvHeaders.quantity'), t('kirim.csvHeaders.price'), t('kirim.csvHeaders.total'),
      t('kirim.csvHeaders.supplier'), t('kirim.csvHeaders.note'),
    ]
    const rows = sorted.map((e, i) => [
      String(i + 1), formatDateTime(e.date), e.productName, e.category, e.size, e.color,
      String(e.quantity), String(e.unitPrice), String(e.totalAmount), e.supplier, e.note,
    ])
    const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `kirim_${TODAY}.csv`; link.click()
    URL.revokeObjectURL(url)
    toast.success(t('kirim.toasts.csvSuccess'))
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('kirim.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('kirim.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <Download className="h-3.5 w-3.5" />{t('kirim.csv')}
          </button>
          <button onClick={openAdd} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-emerald-600 transition-colors">
            <Plus className="h-3.5 w-3.5" />{t('kirim.addEntry')}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <StatsPanel storageKey="kirim-stats-open" title={t('kirim.stats.statsPanel')}>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-4">
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('kirim.stats.todayQty')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{todayQty} {t('kirim.unitsSuffix')}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('kirim.stats.todaySum')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(todaySum)}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('kirim.stats.monthQty')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{monthQty} {t('kirim.unitsSuffix')}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('kirim.stats.monthSum')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(monthSum)}</p>
          </div>
        </div>
      </StatsPanel>

      {/* Filters */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 space-y-3 transition-colors duration-200">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-gray-400 dark:text-gray-500 mr-1 shrink-0">{t('kirim.dateLabel')}</span>
          {DATE_PRESETS.map(dp => (
            <button key={dp.value} onClick={() => { setDatePreset(datePreset === dp.value ? null : dp.value); setPage(1) }} className={pillCls(datePreset === dp.value)}>
              {t(dp.labelKey)}
            </button>
          ))}
          {datePreset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 ml-1">
              <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('kirim.from')}</span>
              <input type="date" value={customFrom} onChange={e => { setCustomFrom(e.target.value); setPage(1) }} className={dateInputCls} />
              <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('kirim.to')}</span>
              <input type="date" value={customTo} onChange={e => { setCustomTo(e.target.value); setPage(1) }} className={dateInputCls} />
            </div>
          )}
        </div>
        <div className="h-px bg-gray-100 dark:bg-gray-800" />
        <div className="flex flex-wrap items-center gap-2">
          <ProductMultiSelect names={uniqueNames} selected={selectedNames} onChange={names => { setSelectedNames(names); setPage(1) }} />
          <select value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); setPage(1) }} className={selectCls}>
            <option value="all">{t('kirim.allCategories')}</option>
            {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={supplierFilter} onChange={e => { setSupplierFilter(e.target.value); setPage(1) }} className={selectCls}>
            <option value="all">{t('kirim.allSuppliers')}</option>
            {supplierOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <input type="text" placeholder={t('header.searchPlaceholder')} value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-4 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors" />
          </div>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {chips.map(c => (
              <span key={c.key} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-800 pl-3 pr-1.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                {c.label}
                <button onClick={c.onRemove} className="flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button onClick={clearAllFilters} className="ml-1 text-[12px] font-medium text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline underline-offset-2 transition-colors">
              {t('common.clearFilters')}
            </button>
          </div>
        )}
      </div>

      <p className="text-[13px] text-gray-400 dark:text-gray-500">{sorted.length} {t('kirim.resultsCount')}</p>

      {/* Table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
              <PackageSearch className="h-6 w-6 text-gray-300 dark:text-gray-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('kirim.emptyTitle')}</p>
              <p className="text-[12px] text-gray-400 dark:text-gray-500 mt-0.5">{t('kirim.emptySubtitle')}</p>
            </div>
            <button onClick={clearAllFilters} className="mt-1 rounded-lg border border-gray-200 dark:border-gray-700 px-3.5 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              {t('common.clearFilters')}
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-gray-800/50">
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">№</th>
                    <SortHeader label={t('kirim.table.date')} active={sortKey === 'date'} dir={sortDir} onClick={() => toggleSort('date')} />
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.productName')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.category')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.size')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.color')}</th>
                    <SortHeader label={t('kirim.table.quantity')} active={sortKey === 'quantity'} dir={sortDir} align="right" onClick={() => toggleSort('quantity')} />
                    <SortHeader label={t('kirim.table.purchasePrice')} active={sortKey === 'purchasePrice'} dir={sortDir} align="right" onClick={() => toggleSort('purchasePrice')} />
                    <SortHeader label={t('kirim.table.sellingPrice')} active={sortKey === 'sellingPrice'} dir={sortDir} align="right" onClick={() => toggleSort('sellingPrice')} />
                    <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.profit')}</th>
                    <SortHeader label={t('kirim.table.total')} active={sortKey === 'totalAmount'} dir={sortDir} align="right" onClick={() => toggleSort('totalAmount')} />
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.supplier')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.note')}</th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('kirim.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((e, i) => {
                  const sizeMatch = resolveProductSize(e)
                  // A match with no barcode (legacy product_sizes rows
                  // created before the barcode-autogen migration and never
                  // restocked since) is just as unprintable as no match.
                  const canPrintLabel = !!sizeMatch?.barcode
                  return (
                    <tr key={e.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}>
                      <td className="px-4 py-3 text-[12px] text-gray-400 dark:text-gray-500">{(page - 1) * ITEMS_PER_PAGE + i + 1}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDateTime(e.date)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{e.productName}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.category}</td>
                      <td className="px-4 py-3"><span className="inline-block rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] font-semibold text-gray-600 dark:text-gray-300">{e.size}</span></td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.color}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">
                          <Plus className="h-3 w-3" />{e.quantity} {t('kirim.unitsSuffix')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap">{formatPrice(e.purchasePrice)}</td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap">{formatPrice(e.sellingPrice)}</td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-emerald-600 dark:text-emerald-400 tabular-nums whitespace-nowrap">{formatPrice((e.sellingPrice - e.purchasePrice) * e.quantity)}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{formatPrice(e.totalAmount)}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.supplier}</td>
                      <td className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">{e.note || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => printLabelsForEntry(e)}
                            disabled={!canPrintLabel}
                            title={!canPrintLabel ? t('kirim.printLabels.noBarcode') : undefined}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                          >
                            <Printer className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => deleteEntry(e.id)} className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                </tbody>
              </table>
            </div>
            <Pagination currentPage={page} totalPages={totalPages} totalItems={sorted.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
          </>
        )}
      </div>

      {/* Add Modal */}
      <Dialog open={isAddOpen} onOpenChange={open => (open ? setIsAddOpen(true) : closeAddModal())}>
        <DialogContent className="sm:max-w-2xl overflow-hidden flex flex-col" style={{ height: '640px' }}>
          <DialogHeader className="shrink-0"><DialogTitle>{t('kirim.addEntry')}</DialogTitle></DialogHeader>
          {addStep === 'done' ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('kirim.toasts.addSuccess')}</p>
              <p className="text-[13px] text-gray-400 dark:text-gray-500">{savedLabels.length} {t('kirim.unitsSuffix')}</p>
              <button
                onClick={() => setPrintLabelsOpen(true)}
                className="mt-2 flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2 text-[13px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                {t('kirim.printLabels.button')}
              </button>
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto pr-1 space-y-4">
            {/* Warehouse selector */}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">
                Ombor tanlash <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                {warehouses.map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setForm(prev => ({ ...prev, warehouseId: w.id, productId: '' }))}
                    className={cn(
                      'rounded-lg px-4 py-2 transition-colors',
                      form.warehouseId === w.id
                        ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border border-gray-200 text-gray-600 hover:bg-gray-50',
                    )}
                  >
                    {w.name}
                    <span className="ml-1.5 text-[11px] opacity-60">({t(WAREHOUSE_TYPE_LABEL_KEYS[w.type])})</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Product selector */}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kirim.modal.selectProduct')}</label>
              <ProductNameSearch
                products={warehouseProducts}
                value={form.productId}
                onChange={productId => { setForm(prev => ({ ...prev, productId })); resetMatrix() }}
                placeholder={t('kirim.modal.selectProductPlaceholder')}
                noWarehouseLabel={t('products.noWarehouse')}
              />
            </div>

            {/* Shared pricing */}
            {form.productId && (
              <div className="animate-in fade-in slide-in-from-top-2 duration-200 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Olish narxi <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text" inputMode="numeric" placeholder="0"
                      value={form.purchasePrice ? new Intl.NumberFormat('ru-RU').format(Number(form.purchasePrice)) : ''}
                      onChange={e => setForm(p => ({ ...p, purchasePrice: e.target.value.replace(/\D/g, '') }))}
                      className={!form.purchasePrice ? `${fieldCls} border-red-300 focus:border-red-500` : fieldCls}
                    />
                    {!form.purchasePrice && (
                      <p className="text-xs text-red-500 mt-1">Olish narxini kiriting</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">Ustama foizi (%)</label>
                    <input
                      type="number" min="0" step="0.1" placeholder="0"
                      value={form.markupPercent ?? ''}
                      onChange={e => setForm(p => ({ ...p, markupPercent: e.target.value }))}
                      className={fieldCls}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-4 py-3">
                  <span className="text-[13px] font-medium text-emerald-700 dark:text-emerald-300">Sotuv narxi</span>
                  <span className="text-[15px] font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums">
                    {formatPrice(Math.round(Number(form.purchasePrice || 0) * (1 + Number(form.markupPercent || 0) / 100)))}
                  </span>
                </div>
              </div>
            )}

            {/* Color x size matrix */}
            {form.productId && (
              <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[13px] font-medium text-gray-700 dark:text-gray-300">
                    {t('kirim.matrix.color')} / {t('kirim.table.size')}
                  </label>
                  <button type="button"
                    onClick={addColumn}
                    className="flex items-center gap-1 text-[12px] font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors">
                    <Plus className="h-3.5 w-3.5" /> {t('kirim.matrix.addSize')}
                  </button>
                </div>
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-800/50">
                        <th className="w-32 px-2 py-2 text-left text-[11px] font-medium text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700">
                          {t('kirim.matrix.color')}
                        </th>
                        {columns.map(col => (
                          <th key={col.id} className="px-2 py-2 border-b border-gray-200 dark:border-gray-700">
                            <div className="flex items-center gap-1">
                              <select value={col.size}
                                onChange={e => setColumnSize(col.id, e.target.value)}
                                className="h-9 w-24 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-1.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-emerald-400">
                                <option value="">—</option>
                                {activeSizes.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                              {columns.length > 1 && (
                                <button type="button" onClick={() => removeColumn(col.id)}
                                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-300 hover:text-red-400 transition-colors">
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {colorRows.map(color => (
                        <tr key={color || '__default__'} className="border-b border-gray-100 dark:border-gray-800 last:border-b-0">
                          <td className="px-2 py-2 text-sm text-gray-700 dark:text-gray-300">
                            {color || t('kirim.matrix.defaultColor')}
                          </td>
                          {columns.map(col => (
                            <td key={col.id} className="px-2 py-2">
                              <input
                                type="number" min="0" placeholder="0"
                                disabled={!col.size}
                                aria-label={t('kirim.matrix.qty')}
                                value={cellQty[cellKey(color, col.id)] ?? ''}
                                onChange={e => setCell(color, col.id, e.target.value)}
                                className="h-9 w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed"
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Common fields */}
            {form.productId && (
              <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kirim.modal.dateTime')}</label>
                  <input type="datetime-local" value={form.datetime} onChange={e => setForm(p => ({ ...p, datetime: e.target.value }))} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kirim.modal.supplier')}</label>
                  <input type="text" placeholder={t('kirim.modal.supplierPlaceholder')} value={form.supplier}
                    onChange={e => setForm(p => ({ ...p, supplier: e.target.value }))} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kirim.modal.note')}</label>
                  <textarea rows={2} placeholder={t('kirim.modal.notePlaceholder')} value={form.note}
                    onChange={e => setForm(p => ({ ...p, note: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-950 resize-none transition-colors" />
                </div>
              </div>
            )}
          </div>
          )}
          <DialogFooter className="shrink-0">
            {addStep === 'done' ? (
              <Button onClick={closeAddModal}>{t('common.close')}</Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeAddModal}>{t('common.cancel')}</Button>
                <Button
                  onClick={addEntry}
                  disabled={saving || !form.purchasePrice || Number(form.purchasePrice) <= 0}
                  className={`bg-emerald-500 text-white hover:bg-emerald-600 ${!form.purchasePrice ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PrintLabelsModal labels={savedLabels} open={printLabelsOpen} onOpenChange={setPrintLabelsOpen} />
    </div>
  )
}
