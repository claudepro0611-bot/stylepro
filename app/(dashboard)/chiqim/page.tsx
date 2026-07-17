'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Minus, Search, X, Download,
  PackageSearch, ArrowUpDown, Pencil, Trash2, AlertTriangle, Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { StatsPanel } from '@/components/ui/StatsPanel'
import { Pagination } from '@/components/ui/Pagination'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { formatDateTime } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { StockOutEntry, Product, Customer } from '@/lib/types'
import type { WarehouseType } from '@/lib/warehouses'

const ITEMS_PER_PAGE = 20
const TODAY = new Date().toISOString().slice(0, 10)
const PAYMENT_METHODS = ['Naqd', 'Karta', 'Click', 'Payme']

const PAYMENT_DOTS: Record<string, string> = {
  Naqd: 'bg-green-500', Karta: 'bg-blue-500', Click: 'bg-yellow-500', Payme: 'bg-purple-500',
}

type DatePreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'
type SortKey = 'date' | 'quantity' | 'sellPrice' | 'totalAmount'

const DATE_PRESETS: { value: DatePreset; labelKey: TranslationKey }[] = [
  { value: 'today', labelKey: 'chiqim.datePresets.today' },
  { value: 'yesterday', labelKey: 'chiqim.datePresets.yesterday' },
  { value: 'week', labelKey: 'chiqim.datePresets.week' },
  { value: 'month', labelKey: 'chiqim.datePresets.month' },
  { value: 'custom', labelKey: 'chiqim.datePresets.custom' },
]

const pillCls = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
    active ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
  }`

const selectCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const dateInputCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const fieldCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:ring-red-950 transition-colors'

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
  id: string; name: string; sku: string | null; category: string | null
  price: number; description: string | null; colors: string[] | null
  min_stock: number; image_url: string | null; status: 'active' | 'inactive'
  warehouse_id: string | null
}

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id, name: row.name, sku: row.sku ?? '', category: row.category ?? '',
    price: Number(row.price), description: row.description ?? '', colors: row.colors ?? [],
    minStock: row.min_stock, imageUrl: row.image_url ?? '', status: row.status,
    warehouseId: row.warehouse_id ?? '',
  }
}

interface SizeOption { id: string; size: string; color: string; stock: number }

function sizeLabel(s: { size: string; color: string }): string {
  return s.color ? `${s.color} / ${s.size}` : s.size
}
interface WarehouseRow { id: string; name: string; type: WarehouseType }

interface CustomerRow { id: string; full_name: string; phone: string | null }
function mapCustomerLite(row: CustomerRow): Pick<Customer, 'id' | 'fullName' | 'phone'> {
  return { id: row.id, fullName: row.full_name, phone: row.phone ?? '' }
}

interface StockOutRow {
  id: string; product_id: string; product_name: string; category: string | null
  size: string | null; color: string | null; quantity: number; sell_price: number
  total_amount: number; customer_id: string | null; customer_name: string | null
  payment_method: string | null; date: string; note: string | null
}

function mapStockOut(row: StockOutRow): StockOutEntry {
  return {
    id: row.id, productId: row.product_id, productName: row.product_name,
    category: row.category ?? '', size: row.size ?? '', color: row.color ?? '',
    quantity: row.quantity, sellPrice: Number(row.sell_price),
    totalAmount: Number(row.total_amount), customerId: row.customer_id ?? '',
    customerName: row.customer_name ?? '', paymentMethod: row.payment_method ?? '',
    date: row.date, note: row.note ?? '',
  }
}

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
        {t('chiqim.productFilter')}
        {selected.length > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 px-1 text-[11px] font-semibold">{selected.length}</span>}
      </button>
      {open && (
        <div className="absolute z-30 mt-1.5 w-72 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 shadow-lg">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
              placeholder={t('chiqim.productSearchPlaceholder')}
              className="h-8 w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-8 pr-2 text-[13px] text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors" />
          </div>
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-gray-400 dark:text-gray-500">{t('chiqim.notFound')}</p>
            ) : filtered.map(name => (
              <label key={name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
                <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600" />
                <span className="truncate">{name}</span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])}
              className="mt-2 w-full rounded-md py-1.5 text-center text-[12px] text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
              {t('chiqim.clearSelection')}
            </button>
          )}
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
  productId: '', sizeRowId: '', datetime: '', quantity: '', price: '',
  customerId: '', paymentMethod: 'Naqd', note: '',
}

export default function ChiqimPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [entries, setEntries] = useState<StockOutEntry[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [customers, setCustomers] = useState<Pick<Customer, 'id' | 'fullName' | 'phone'>[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [productSizes, setProductSizes] = useState<SizeOption[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [activeWarehouseId, setActiveWarehouseId] = useLocalStorage<string>('stylepro-active-warehouse-id', '')

  const fetchEntries = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('stock_out_entries').select('*').order('date', { ascending: false })
    if (error) toast.error(t('common.error'))
    else setEntries((data as StockOutRow[]).map(mapStockOut))
    setLoading(false)
  }, [t])

  const fetchProducts = useCallback(async () => {
    const supabase = createClient()
    const [{ data, error }, { data: whData, error: whErr }] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase.from('warehouses').select('id, name, type'),
    ])
    if (error || whErr) { toast.error(t('common.error')); return }
    setProducts((data as ProductRow[]).map(mapProduct))
    setWarehouses((whData ?? []) as WarehouseRow[])
  }, [t])

  const fetchCustomers = useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase.from('customers').select('id, full_name, phone')
    if (error) toast.error(t('common.error'))
    else setCustomers((data as CustomerRow[]).map(mapCustomerLite))
  }, [t])

  useEffect(() => { fetchEntries(); fetchProducts(); fetchCustomers() }, [fetchEntries, fetchProducts, fetchCustomers])

  useEffect(() => {
    if (!activeWarehouseId && warehouses.length > 0) setActiveWarehouseId(warehouses[0].id)
  }, [warehouses, activeWarehouseId, setActiveWarehouseId])

  // Filters
  const [datePreset, setDatePreset] = useState<DatePreset | null>(null)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [selectedNames, setSelectedNames] = useState<string[]>([])
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [customerFilter, setCustomerFilter] = useState('all')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [search, setSearch] = useState('')

  // Table
  const [page, setPage] = useState(1)
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Add modal
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)

  const activeWarehouse = useMemo(() => warehouses.find(w => w.id === activeWarehouseId) ?? warehouses[0], [warehouses, activeWarehouseId])
  // Which products are eligible for a warehouse is not determined by
  // matching product category to warehouse type — the actual stock lookup
  // below (onProductChange) already scopes strictly by
  // product_sizes.warehouse_id, which is the only real source of truth.
  const warehouseProducts = useMemo(() => {
    if (!activeWarehouse) return []
    return products.filter(p => !p.warehouseId || p.warehouseId === activeWarehouse.id)
  }, [products, activeWarehouse])
  const uniqueNames = useMemo(() => Array.from(new Set(products.map(p => p.name))).sort(), [products])
  const categoryOptions = useMemo(() => Array.from(new Set(products.map(p => p.category))).sort(), [products])
  const customerOptions = useMemo(() => Array.from(new Set(entries.map(e => e.customerName).filter(Boolean))).sort(), [entries])

  const dateRange = useMemo(() => (datePreset ? presetRange(datePreset, customFrom, customTo) : null), [datePreset, customFrom, customTo])

  const filtered = useMemo(() => {
    let list = entries
    if (dateRange) { const [from, to] = dateRange; list = list.filter(e => { const d = e.date.slice(0, 10); return d >= from && d <= to }) }
    if (selectedNames.length) list = list.filter(e => selectedNames.includes(e.productName))
    if (categoryFilter !== 'all') list = list.filter(e => e.category === categoryFilter)
    if (customerFilter !== 'all') list = list.filter(e => e.customerName === customerFilter)
    if (paymentFilter !== 'all') list = list.filter(e => e.paymentMethod === paymentFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(e => e.productName.toLowerCase().includes(q) || e.customerName.toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
    }
    return list
  }, [entries, dateRange, selectedNames, categoryFilter, customerFilter, paymentFilter, search])

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
      return t('chiqim.datePresets.custom')
    }
    const preset = DATE_PRESETS.find(d => d.value === datePreset)
    return preset ? t(preset.labelKey) : ''
  }

  function clearAllFilters() {
    setDatePreset(null); setCustomFrom(''); setCustomTo('')
    setSelectedNames([]); setCategoryFilter('all'); setCustomerFilter('all')
    setPaymentFilter('all'); setSearch(''); setPage(1)
  }

  const chips: { key: string; label: string; onRemove: () => void }[] = []
  if (datePreset) chips.push({ key: 'date', label: `📅 ${dateChipLabel()}`, onRemove: () => { setDatePreset(null); setCustomFrom(''); setCustomTo('') } })
  selectedNames.forEach(name => chips.push({ key: `prod-${name}`, label: name, onRemove: () => setSelectedNames(prev => prev.filter(x => x !== name)) }))
  if (categoryFilter !== 'all') chips.push({ key: 'cat', label: categoryFilter, onRemove: () => setCategoryFilter('all') })
  if (customerFilter !== 'all') chips.push({ key: 'cust', label: customerFilter, onRemove: () => setCustomerFilter('all') })
  if (paymentFilter !== 'all') chips.push({ key: 'pay', label: paymentFilter, onRemove: () => setPaymentFilter('all') })
  if (search.trim()) chips.push({ key: 'search', label: `"${search.trim()}"`, onRemove: () => setSearch('') })

  const selectedSizeRow = productSizes.find(s => s.id === form.sizeRowId)
  const requestedQty = parseInt(form.quantity) || 0
  const exceedsStock = !!selectedSizeRow && requestedQty > selectedSizeRow.stock

  async function onProductChange(id: string) {
    const p = warehouseProducts.find(x => x.id === id)
    setForm(prev => ({ ...prev, productId: id, sizeRowId: '', price: p ? String(p.price) : prev.price, quantity: '' }))
    setProductSizes([])
    if (!id || !activeWarehouse) return
    const supabase = createClient()
    const { data } = await supabase.from('product_sizes').select('id, size, color, stock')
      .eq('product_id', id).eq('warehouse_id', activeWarehouse.id).gt('stock', 0).order('size')
    setProductSizes((data ?? []) as SizeOption[])
  }

  function openAdd() { setForm({ ...emptyForm, datetime: nowLocal() }); setProductSizes([]); setIsAddOpen(true) }

  async function addEntry() {
    if (!form.productId || !form.sizeRowId || !form.quantity || !form.price || !form.customerId) {
      toast.error(t('chiqim.toasts.requiredError'))
      return
    }
    if (!form.price || Number(form.price) <= 0) {
      toast.error('Narx kiritilishi shart')
      return
    }
    const product = warehouseProducts.find(p => p.id === form.productId)
    const sizeRow = productSizes.find(s => s.id === form.sizeRowId)
    const customer = customers.find(c => c.id === form.customerId)
    if (!product || !sizeRow || !customer) return
    const quantity = parseInt(form.quantity)
    if (quantity > sizeRow.stock) {
      toast.error(`${t('chiqim.toasts.stockError')} ${t('chiqim.modal.currentStockLabel')} ${sizeRow.stock} ${t('chiqim.unitsSuffix')}`)
      return
    }
    const sellPrice = parseInt(form.price)
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('stock_out', {
      p_entries: [{
        product_size_id: sizeRow.id,
        product_id: product.id, product_name: product.name, category: product.category,
        size: sizeRow.size,
        quantity, sell_price: sellPrice,
        customer_id: customer.id, customer_name: customer.fullName,
        payment_method: form.paymentMethod,
        date: form.datetime ? `${form.datetime}:00` : new Date().toISOString(),
        note: form.note.trim(),
      }],
      p_entry_type: 'manual',
    })
    setSaving(false)
    if (error) {
      if (error.message.includes('Insufficient stock')) {
        toast.error(`${t('chiqim.toasts.stockError')} ${t('chiqim.modal.currentStockLabel')} ${sizeRow.stock} ${t('chiqim.unitsSuffix')}`)
      } else if (error.message.includes('forbidden')) {
        toast.error(t('common.forbidden'))
      } else {
        toast.error(t('common.error'))
      }
      return
    }
    setForm(emptyForm)
    setProductSizes([])
    setIsAddOpen(false)
    toast.success(t('chiqim.toasts.addSuccess'))
    fetchEntries()
  }

  async function deleteEntry(id: string) {
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_stock_out_entry', { p_id: id })
    if (error) { toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error')); return }
    toast.success(t('chiqim.toasts.deleteSuccess'))
    fetchEntries()
  }

  function exportCSV() {
    const headers = [
      t('chiqim.csvHeaders.number'), t('chiqim.csvHeaders.date'), t('chiqim.csvHeaders.product'), t('chiqim.csvHeaders.category'),
      t('chiqim.csvHeaders.size'), t('chiqim.csvHeaders.color'), t('chiqim.csvHeaders.quantity'), t('chiqim.csvHeaders.price'),
      t('chiqim.csvHeaders.total'), t('chiqim.csvHeaders.customer'), t('chiqim.csvHeaders.paymentMethod'), t('chiqim.csvHeaders.note'),
    ]
    const rows = sorted.map((e, i) => [
      String(i + 1), formatDateTime(e.date), e.productName, e.category, e.size, e.color,
      String(e.quantity), String(e.sellPrice), String(e.totalAmount), e.customerName, e.paymentMethod, e.note,
    ])
    const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `chiqim_${TODAY}.csv`; link.click()
    URL.revokeObjectURL(url)
    toast.success(t('chiqim.toasts.csvSuccess'))
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('chiqim.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('chiqim.subtitle')}</p>
        </div>
        <Tabs value={activeWarehouseId} onValueChange={setActiveWarehouseId}>
          <TabsList>
            {warehouses.map(w => (
              <TabsTrigger key={w.id} value={w.id}>{w.name}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <Download className="h-3.5 w-3.5" />{t('chiqim.csv')}
          </button>
          <button onClick={openAdd} className="flex items-center gap-2 rounded-lg bg-red-500 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-red-600 transition-colors">
            <Plus className="h-3.5 w-3.5" />{t('chiqim.addEntry')}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <StatsPanel storageKey="chiqim-stats-open" title={t('chiqim.stats.statsPanel')}>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-4">
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('chiqim.stats.todayQty')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{todayQty} {t('chiqim.unitsSuffix')}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('chiqim.stats.todaySum')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(todaySum)}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('chiqim.stats.monthQty')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{monthQty} {t('chiqim.unitsSuffix')}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('chiqim.stats.monthSum')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(monthSum)}</p>
          </div>
        </div>
      </StatsPanel>

      {/* Filters */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 space-y-3 transition-colors duration-200">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-gray-400 dark:text-gray-500 mr-1 shrink-0">{t('chiqim.dateLabel')}</span>
          {DATE_PRESETS.map(dp => (
            <button key={dp.value} onClick={() => { setDatePreset(datePreset === dp.value ? null : dp.value); setPage(1) }} className={pillCls(datePreset === dp.value)}>
              {t(dp.labelKey)}
            </button>
          ))}
          {datePreset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 ml-1">
              <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('chiqim.from')}</span>
              <input type="date" value={customFrom} onChange={e => { setCustomFrom(e.target.value); setPage(1) }} className={dateInputCls} />
              <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('chiqim.to')}</span>
              <input type="date" value={customTo} onChange={e => { setCustomTo(e.target.value); setPage(1) }} className={dateInputCls} />
            </div>
          )}
        </div>
        <div className="h-px bg-gray-100 dark:bg-gray-800" />
        <div className="flex flex-wrap items-center gap-2">
          <ProductMultiSelect names={uniqueNames} selected={selectedNames} onChange={names => { setSelectedNames(names); setPage(1) }} />
          <select value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); setPage(1) }} className={selectCls}>
            <option value="all">{t('chiqim.allCategories')}</option>
            {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={customerFilter} onChange={e => { setCustomerFilter(e.target.value); setPage(1) }} className={selectCls}>
            <option value="all">{t('chiqim.allCustomers')}</option>
            {customerOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={paymentFilter} onChange={e => { setPaymentFilter(e.target.value); setPage(1) }} className={selectCls}>
            <option value="all">{t('chiqim.allPaymentMethods')}</option>
            {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
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

      <p className="text-[13px] text-gray-400 dark:text-gray-500">{sorted.length} {t('chiqim.resultsCount')}</p>

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
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('chiqim.emptyTitle')}</p>
              <p className="text-[12px] text-gray-400 dark:text-gray-500 mt-0.5">{t('chiqim.emptySubtitle')}</p>
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
                    <SortHeader label={t('chiqim.table.date')} active={sortKey === 'date'} dir={sortDir} onClick={() => toggleSort('date')} />
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.productName')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.category')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.size')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.color')}</th>
                    <SortHeader label={t('chiqim.table.quantity')} active={sortKey === 'quantity'} dir={sortDir} align="right" onClick={() => toggleSort('quantity')} />
                    <SortHeader label={t('chiqim.table.price')} active={sortKey === 'sellPrice'} dir={sortDir} align="right" onClick={() => toggleSort('sellPrice')} />
                    <SortHeader label={t('chiqim.table.total')} active={sortKey === 'totalAmount'} dir={sortDir} align="right" onClick={() => toggleSort('totalAmount')} />
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.customer')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.paymentMethod')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.note')}</th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('chiqim.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((e, i) => (
                    <tr key={e.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}>
                      <td className="px-4 py-3 text-[12px] text-gray-400 dark:text-gray-500">{(page - 1) * ITEMS_PER_PAGE + i + 1}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDateTime(e.date)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{e.productName}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.category}</td>
                      <td className="px-4 py-3"><span className="inline-block rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] font-semibold text-gray-600 dark:text-gray-300">{e.size}</span></td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.color}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center gap-1 rounded-md bg-red-50 dark:bg-red-950/40 px-2 py-1 text-[12px] font-semibold text-red-700 dark:text-red-400">
                          <Minus className="h-3 w-3" />{e.quantity} {t('chiqim.unitsSuffix')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap">{formatPrice(e.sellPrice)}</td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900 dark:text-gray-100 tabular-nums whitespace-nowrap">{formatPrice(e.totalAmount)}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.customerName}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${PAYMENT_DOTS[e.paymentMethod] ?? 'bg-gray-400'}`} />
                          {e.paymentMethod}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">{e.note || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => deleteEntry(e.id)} className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination currentPage={page} totalPages={totalPages} totalItems={sorted.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
          </>
        )}
      </div>

      {/* Add Modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('chiqim.addEntry')}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2 max-h-[70vh] overflow-y-auto pr-1">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('chiqim.modal.selectProduct')}</label>
              <SearchSelect
                options={warehouseProducts.map(p => ({
                  value: p.id,
                  label: p.name,
                  sublabel: p.warehouseId ? p.category : `${p.category} — ${t('products.noWarehouse')}`,
                }))}
                value={form.productId}
                onChange={onProductChange}
                placeholder={t('chiqim.modal.selectProductPlaceholder')}
                focusRingClassName="focus:border-red-400 focus:ring-red-100"
              />
            </div>
            {productSizes.length > 0 && (
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">O&apos;lcham *</label>
                <div className="flex flex-wrap gap-1.5">
                  {productSizes.map(s => (
                    <button key={s.id} type="button" onClick={() => setForm(p => ({ ...p, sizeRowId: s.id }))}
                      className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition-colors ${form.sizeRowId === s.id ? 'border-red-500 bg-red-500 text-white' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}>
                      <span>{sizeLabel(s)}</span>
                      <span className={`text-[11px] ${form.sizeRowId === s.id ? 'text-red-100' : 'text-gray-400 dark:text-gray-500'}`}>({s.stock} ta)</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {selectedSizeRow && (
              <div className="flex items-center gap-2 rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/60 px-3 py-2">
                <span className="inline-block rounded bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 text-[11px] font-semibold text-gray-700 dark:text-gray-300">{sizeLabel(selectedSizeRow)}</span>
                <span className="text-[13px] text-gray-600 dark:text-gray-400">{t('chiqim.modal.currentStockLabel')} <strong>{selectedSizeRow.stock}</strong> {t('chiqim.unitsSuffix')}</span>
              </div>
            )}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('chiqim.modal.dateTime')}</label>
              <input type="datetime-local" value={form.datetime} onChange={e => setForm(p => ({ ...p, datetime: e.target.value }))} className={fieldCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('chiqim.modal.quantity')}</label>
                <input type="number" min="1" placeholder={t('chiqim.modal.quantityPlaceholder')} value={form.quantity}
                  onChange={e => setForm(p => ({ ...p, quantity: e.target.value }))}
                  className={`${fieldCls} ${exceedsStock ? 'border-red-400 ring-2 ring-red-100 dark:ring-red-950' : ''}`} />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('chiqim.modal.price')}</label>
                <input type="text" inputMode="numeric" placeholder={t('chiqim.modal.pricePlaceholder')}
                  value={form.price ? new Intl.NumberFormat('ru-RU').format(Number(form.price)) : ''}
                  onChange={e => setForm(p => ({ ...p, price: e.target.value.replace(/\D/g, '') }))}
                  className={!form.price ? `${fieldCls} border-red-300 focus:border-red-500` : fieldCls} />
                {!form.price && (
                  <p className="text-xs text-red-500 mt-1">Narxni kiriting</p>
                )}
              </div>
            </div>
            {exceedsStock && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900 px-3 py-2.5">
                <AlertTriangle className="h-4 w-4 text-red-500 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-[12px] text-red-600 dark:text-red-400 leading-relaxed">
                  {t('chiqim.modal.stockExceedWarning')} ({selectedSizeRow?.stock} {t('chiqim.unitsSuffix')}). {t('chiqim.modal.reduceQuantityHint')}
                </p>
              </div>
            )}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('chiqim.modal.selectCustomer')}</label>
              <SearchSelect
                options={customers.map(c => ({ value: c.id, label: c.fullName, sublabel: c.phone }))}
                value={form.customerId}
                onChange={v => setForm(p => ({ ...p, customerId: v }))}
                placeholder={t('chiqim.modal.selectCustomerPlaceholder')}
                focusRingClassName="focus:border-red-400 focus:ring-red-100"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('chiqim.modal.paymentMethod')}</label>
              <select value={form.paymentMethod} onChange={e => setForm(p => ({ ...p, paymentMethod: e.target.value }))} className={`${fieldCls} bg-white dark:bg-gray-900`}>
                {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('chiqim.modal.note')}</label>
              <textarea rows={2} placeholder={t('chiqim.modal.notePlaceholder')} value={form.note}
                onChange={e => setForm(p => ({ ...p, note: e.target.value }))}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:ring-red-950 resize-none transition-colors" />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={addEntry}
              disabled={exceedsStock || saving || !form.price || Number(form.price) <= 0}
              className={`bg-red-500 text-white hover:bg-red-600 ${!form.price ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
