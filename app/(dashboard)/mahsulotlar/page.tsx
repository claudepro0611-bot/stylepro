'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import {
  Plus, Grid, List, Edit2, Tag, Loader2, ImagePlus, X, ScanBarcode,
  Download, Filter, RotateCcw, Settings2, Eye, EyeOff, Pencil, Trash2, ArrowUpDown, AlertTriangle,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Pagination } from '@/components/ui/Pagination'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { localYmd } from '@/lib/utils/date'
import type { SizeType } from '@/lib/sizes'
import type { TranslationKey } from '@/lib/i18n/translations'
import { ImportModal } from '@/components/mahsulotlar/ImportModal'
import { BarcodeModal } from '@/components/mahsulotlar/BarcodeModal'
import { CompanionSection } from '@/components/mahsulotlar/CompanionSection'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId, fetchAllRows } from '@/lib/supabase/helpers'
import { generateUniqueBarcode } from '@/lib/barcode'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { Product, ProductGroup } from '@/lib/types'
import { WAREHOUSE_TYPE_LABEL_KEYS, type WarehouseType } from '@/lib/warehouses'

const ITEMS_PER_PAGE = 12
const COLORS_LIST = ['Qora', 'Oq', "Ko'k", 'Qizil', 'Yashil', 'Sariq', 'Kulrang', 'Jigarrang', 'Bej']

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
  barcode: string | null
  status: 'active' | 'inactive'
  warehouse_id: string | null
  created_at: string
}

interface WarehouseRow { id: string; name: string; type: WarehouseType }

interface ProductListItem extends Product { createdAt: string }

function mapProduct(row: ProductRow): ProductListItem {
  return {
    createdAt: row.created_at,
    id: row.id,
    name: row.name,
    sku: row.sku ?? '',
    category: row.category ?? '',
    price: Number(row.price),
    description: row.description ?? '',
    colors: row.colors ?? [],
    minStock: row.min_stock,
    imageUrl: row.image_url ?? '',
    barcode: row.barcode ?? '',
    status: row.status,
    warehouseId: row.warehouse_id ?? '',
  }
}

interface ProductGroupRow {
  id: string; name: string; description: string | null; status: 'active' | 'inactive'; size_type: string | null
}
function mapProductGroup(row: ProductGroupRow): ProductGroup {
  return { id: row.id, name: row.name, description: row.description ?? '', productsCount: 0, status: row.status, sizeType: (row.size_type as SizeType) ?? 'clothing' }
}

type Unit = 'piece' | 'ml'
type SortKey = 'name' | 'sku' | 'createdAt'

interface ListFilters {
  name: string
  sku: string
  unit: 'all' | Unit
  status: 'all' | Product['status']
  group: string // '' = all groups
}
const emptyFilters: ListFilters = { name: '', sku: '', unit: 'all', status: 'all', group: '' }

// Toggleable table columns. Name and Actions are always shown.
const COLUMNS = [
  { id: 'group', label: 'products.list.group' },
  { id: 'sku', label: 'products.list.sku' },
  { id: 'variants', label: 'products.list.variants' },
  { id: 'unit', label: 'products.list.unit' },
  { id: 'minStock', label: 'products.list.minStock' },
  { id: 'stock', label: 'products.list.stock' },
  { id: 'price', label: 'products.list.price' },
  { id: 'status', label: 'products.list.status' },
  { id: 'createdAt', label: 'products.list.createdAt' },
] as const satisfies readonly { id: string; label: TranslationKey }[]
type ColumnId = (typeof COLUMNS)[number]['id']

function formatDmy(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

function csvCell(value: string): string { return `"${value.replace(/"/g, '""')}"` }

const thCls = 'px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap'
const iconBtnCls = 'flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors'
const outlineBtnCls = 'flex h-9 items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-[13px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors'
const activeBtnCls = 'flex h-9 items-center gap-2 rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm px-3 text-[13px] font-medium text-gray-900 dark:text-gray-100 transition-colors'

function SortHeader({ label, active, dir, onClick }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void }) {
  return (
    <th onClick={onClick} className={`${thCls} text-left cursor-pointer select-none hover:text-gray-900 dark:hover:text-gray-100`}>
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown className={`h-3 w-3 ${active ? 'text-gray-700 dark:text-gray-300' : 'text-gray-300 dark:text-gray-600'} ${active && dir === 'asc' ? 'rotate-180' : ''} transition-transform`} />
      </span>
    </th>
  )
}

const emptyAddForm = {
  name: '', skuPrefix: '', barcode: '', category: '', price: '', colors: [] as string[], description: '', warehouseId: '',
}
const emptyEditForm = {
  name: '', sku: '', barcode: '', category: '', price: '', minStock: '',
  colors: [] as string[], description: '', status: 'active' as Product['status'], warehouseId: '',
}

const MAX_IMAGE_SIZE = 2 * 1024 * 1024

/** Generate an EAN-13 candidate and re-roll while it collides with an
 *  existing products.barcode or product_sizes.barcode (same dupe-check
 *  pattern as BarcodeModal). */
async function generateUniqueProductBarcode(
  supabase: ReturnType<typeof createClient>,
  companyId: string,
): Promise<string> {
  let candidate = generateUniqueBarcode()
  for (let i = 0; i < 5; i++) {
    const [{ data: productDupe }, { data: sizeDupe }] = await Promise.all([
      supabase.from('products').select('id').eq('company_id', companyId).eq('barcode', candidate).maybeSingle(),
      supabase.from('product_sizes').select('id').eq('company_id', companyId).eq('barcode', candidate).maybeSingle(),
    ])
    if (!productDupe && !sizeDupe) return candidate
    candidate = generateUniqueBarcode()
  }
  return candidate
}

/** Upload a product image to the public `product-images` bucket and return
 *  its public URL, or null on failure. */
async function uploadProductImage(
  supabase: ReturnType<typeof createClient>,
  file: File,
): Promise<string | null> {
  const companyId = await getCompanyId(supabase)
  if (!companyId) return null
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const path = `${companyId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('product-images').upload(path, file)
  if (error) return null
  return supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

export default function MahsulotlarPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [products, setProducts] = useState<ProductListItem[]>([])
  const [skuCounts, setSkuCounts] = useState<Map<string, number>>(new Map())
  const [stockTotals, setStockTotals] = useState<Map<string, number>>(new Map())
  const [groups, setGroups] = useState<ProductGroup[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>('list')
  const [page, setPage] = useState(1)

  const [filtersOpen, setFiltersOpen] = useState(true)
  const [draftFilters, setDraftFilters] = useState<ListFilters>(emptyFilters)
  const [filters, setFilters] = useState<ListFilters>(emptyFilters)
  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [hiddenColumns, setHiddenColumns] = useLocalStorage<ColumnId[]>('stylepro-products-hidden-columns', [])
  const [showImages, setShowImages] = useLocalStorage<boolean>('stylepro-products-show-images', true)

  const [deleteTarget, setDeleteTarget] = useState<ProductListItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [addForm, setAddForm] = useState(emptyAddForm)

  const [editProduct, setEditProduct] = useState<Product | null>(null)
  const [editForm, setEditForm] = useState(emptyEditForm)

  const [isImportOpen, setIsImportOpen] = useState(false)
  const [barcodeProduct, setBarcodeProduct] = useState<Product | null>(null)

  const [barcodeGenBusy, setBarcodeGenBusy] = useState(false)
  const [addImageFile, setAddImageFile] = useState<File | null>(null)
  const [addImagePreview, setAddImagePreview] = useState('')
  const [editImageFile, setEditImageFile] = useState<File | null>(null)
  const [editImagePreview, setEditImagePreview] = useState('')

  const fetchProducts = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data, error }, { data: sizeData, error: sizeErr }] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      fetchAllRows<{ product_id: string; stock: number | null }>((from, to) =>
        supabase.from('product_sizes').select('product_id, stock').order('id').range(from, to)),
    ])
    if (error) toast.error(t('common.error'))
    else setProducts((data as ProductRow[]).map(mapProduct))
    if (!sizeErr) {
      const counts = new Map<string, number>()
      const totals = new Map<string, number>()
      for (const r of sizeData) {
        counts.set(r.product_id, (counts.get(r.product_id) ?? 0) + 1)
        totals.set(r.product_id, (totals.get(r.product_id) ?? 0) + Number(r.stock ?? 0))
      }
      setSkuCounts(counts)
      setStockTotals(totals)
    }
    setLoading(false)
  }, [t])

  const fetchGroups = useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase.from('product_groups').select('*').order('name')
    if (error) toast.error(t('common.error'))
    else setGroups((data as ProductGroupRow[]).map(mapProductGroup))
  }, [t])

  const fetchWarehouses = useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase.from('warehouses').select('id, name, type')
    if (error) toast.error(t('common.error'))
    else setWarehouses(data as WarehouseRow[])
  }, [t])

  useEffect(() => { fetchProducts(); fetchGroups(); fetchWarehouses() }, [fetchProducts, fetchGroups, fetchWarehouses])

  const activeGroups = useMemo(() => groups.filter(g => g.status === 'active'), [groups])

  // Group filter options: every known group plus any legacy category string
  // that no longer has a product_groups row.
  const groupOptions = useMemo(() => {
    const names = new Set<string>(groups.map(g => g.name))
    for (const p of products) if (p.category) names.add(p.category)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [groups, products])

  // "Unit" is not stored on products: volume-sized groups are sold in ml,
  // everything else by the piece.
  const groupSizeType = useMemo(() => new Map(groups.map(g => [g.name, g.sizeType])), [groups])
  const unitOf = useCallback((p: Product): Unit => (groupSizeType.get(p.category) === 'volume' ? 'ml' : 'piece'), [groupSizeType])
  const unitLabel = (u: Unit) => t(u === 'ml' ? 'products.list.unitMl' : 'products.list.unitPiece')

  const filtered = useMemo(() => {
    const name = filters.name.trim().toLowerCase()
    const sku = filters.sku.trim().toLowerCase()
    const rows = products.filter(p =>
      (!name || p.name.toLowerCase().includes(name)) &&
      (!sku || p.sku.toLowerCase().includes(sku)) &&
      (filters.unit === 'all' || unitOf(p) === filters.unit) &&
      (filters.status === 'all' || p.status === filters.status) &&
      (!filters.group || p.category === filters.group))
    return rows.sort((a, b) => {
      const cmp = sortKey === 'createdAt'
        ? a.createdAt.localeCompare(b.createdAt)
        : a[sortKey].localeCompare(b[sortKey])
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [products, filters, sortKey, sortDir, unitOf])

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE)
  // Clamp so a delete on the last page never leaves an empty page selected.
  const currentPage = Math.min(page, Math.max(1, totalPages))
  const paginated = filtered.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE)

  const isVisible = (id: ColumnId) => !hiddenColumns.includes(id)

  function applyFilters(e?: React.FormEvent) {
    e?.preventDefault()
    setFilters(draftFilters)
    setPage(1)
  }

  function resetFilters() {
    setDraftFilters(emptyFilters)
    setFilters(emptyFilters)
    setPage(1)
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'createdAt' ? 'desc' : 'asc') }
    setPage(1)
  }

  function toggleColumn(id: ColumnId) {
    setHiddenColumns(prev => (prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]))
  }

  function statusLabel(s: Product['status']) {
    return t(s === 'active' ? 'status.active' : 'status.inactive')
  }

  function exportCsv() {
    if (filtered.length === 0) { toast.error(t('products.list.exportEmpty')); return }
    const headers = [
      t('products.list.name'), t('products.list.group'), t('products.list.sku'), t('products.list.barcode'),
      t('products.list.unit'), t('products.list.minStock'), t('products.list.stock'), t('products.list.price'),
      t('products.list.status'), t('products.list.createdAt'),
    ]
    const rows = filtered.map(p => [
      p.name, p.category, p.sku, p.barcode ?? '', unitLabel(unitOf(p)), String(p.minStock),
      String(stockTotals.get(p.id) ?? 0), String(p.price), statusLabel(p.status), formatDmy(p.createdAt),
    ])
    const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `mahsulotlar-${localYmd()}.csv`
    link.click()
    URL.revokeObjectURL(url)
    toast.success(t('products.list.exportSuccess'))
  }

  async function executeDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_product', { p_id: deleteTarget.id })
    setDeleting(false)
    if (error) {
      if (error.message.includes('forbidden')) toast.error(t('common.forbidden'))
      else if (error.message.includes('Product not found')) toast.error(t('products.list.deleteNotFound'))
      else toast.error(t('products.list.deleteError'))
      return
    }
    toast.success(t('products.list.deleteSuccess'))
    setDeleteTarget(null)
    fetchProducts()
  }

  function rpcErrorMessage(error: { code?: string; message: string }) {
    if (error.message.includes('forbidden')) return t('common.forbidden')
    if (error.code === '23505' && error.message.includes('barcode')) return t('products.toasts.barcodeDuplicate')
    return t('common.error')
  }

  function openAdd() {
    const defaultCat = activeGroups[0]?.name ?? "Ko'ylak"
    setAddForm({ ...emptyAddForm, category: defaultCat, warehouseId: warehouses[0]?.id ?? '' })
    setAddImageFile(null)
    setAddImagePreview('')
    setIsAddOpen(true)
  }

  async function autoBarcode(apply: (code: string) => void) {
    setBarcodeGenBusy(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setBarcodeGenBusy(false); toast.error(t('common.error')); return }
    apply(await generateUniqueProductBarcode(supabase, companyId))
    setBarcodeGenBusy(false)
  }

  function handleImageSelect(
    e: React.ChangeEvent<HTMLInputElement>,
    setFile: (file: File | null) => void,
    setPreview: React.Dispatch<React.SetStateAction<string>>,
  ) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_IMAGE_SIZE) { toast.error(t('products.toasts.imageTooLarge')); return }
    setFile(file)
    setPreview(prev => {
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return URL.createObjectURL(file)
    })
  }

  function removeImage(
    setFile: (file: File | null) => void,
    setPreview: React.Dispatch<React.SetStateAction<string>>,
  ) {
    setFile(null)
    setPreview(prev => {
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return ''
    })
  }

  async function saveAdd() {
    if (!addForm.name.trim() || !addForm.price || !addForm.warehouseId) {
      toast.error(t('products.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const sku = addForm.skuPrefix.trim() || addForm.name.trim().slice(0, 3).toUpperCase()

    let imageUrl: string | null = null
    if (addImageFile) {
      imageUrl = await uploadProductImage(supabase, addImageFile)
      if (!imageUrl) { setSaving(false); toast.error(t('common.error')); return }
    }

    const { error } = await supabase.rpc('create_product', {
      p_data: {
        name: addForm.name.trim(),
        sku,
        barcode: addForm.barcode.trim() || null,
        category: addForm.category,
        price: Number(addForm.price),
        min_stock: 5,
        colors: addForm.colors,
        description: addForm.description.trim(),
        status: 'active',
        warehouse_id: addForm.warehouseId,
        image_url: imageUrl,
      },
    })

    setSaving(false)
    if (error) { toast.error(rpcErrorMessage(error)); return }
    toast.success(t('products.toasts.addSuccess'))
    setIsAddOpen(false)
    fetchProducts()
  }

  function openEdit(p: Product, e: React.MouseEvent) {
    e.stopPropagation()
    setEditProduct(p)
    setEditForm({
      name: p.name, sku: p.sku, barcode: p.barcode ?? '', category: p.category,
      price: String(p.price), minStock: String(p.minStock),
      colors: [...p.colors], description: p.description, status: p.status,
      warehouseId: p.warehouseId || warehouses[0]?.id || '',
    })
    setEditImageFile(null)
    setEditImagePreview(p.imageUrl)
  }

  async function saveEdit() {
    if (!editProduct) return
    if (!editForm.warehouseId) {
      toast.error(t('products.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()

    // Keep the existing image unless a new file was chosen (replace) or the
    // preview was cleared (remove).
    let imageUrl: string | null = editProduct.imageUrl || null
    if (editImageFile) {
      imageUrl = await uploadProductImage(supabase, editImageFile)
      if (!imageUrl) { setSaving(false); toast.error(t('common.error')); return }
    } else if (!editImagePreview) {
      imageUrl = null
    }

    const { error } = await supabase.rpc('update_product', {
      p_id: editProduct.id,
      p_data: {
        name: editForm.name.trim(),
        sku: editForm.sku.trim(),
        barcode: editForm.barcode.trim() || null,
        category: editForm.category,
        price: Number(editForm.price),
        min_stock: Number(editForm.minStock || 5),
        colors: editForm.colors,
        description: editForm.description.trim(),
        status: editForm.status,
        warehouse_id: editForm.warehouseId,
        image_url: imageUrl,
      },
    })
    setSaving(false)
    if (error) { toast.error(rpcErrorMessage(error)); return }
    toast.success(t('products.toasts.updateSuccess'))
    setEditProduct(null)
    fetchProducts()
  }

  function toggleColor(colors: string[], c: string) {
    return colors.includes(c) ? colors.filter(x => x !== c) : [...colors, c]
  }

  function openBarcode(p: Product, e: React.MouseEvent) {
    e.stopPropagation()
    setBarcodeProduct(p)
  }

  const selectCls = `${inputCls} pr-8`
  const labelCls = 'block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1'

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t('products.title')}
          <span className="ml-2 text-base font-normal tabular-nums text-gray-400 dark:text-gray-500">{products.length}</span>
        </h1>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={openAdd} className="flex h-9 items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white px-3.5 text-[13px] font-medium text-white dark:text-slate-900 transition-colors">
              <Plus className="h-3.5 w-3.5" />
              {t('products.addNew')}
            </button>
            <button onClick={exportCsv} className="flex h-9 items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 px-3.5 text-[13px] font-medium text-white dark:text-white transition-colors">
              <Download className="h-3.5 w-3.5" />
              {t('common.export')}
            </button>
            <button onClick={() => setIsImportOpen(true)} className={outlineBtnCls}>
              Excel import
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setFiltersOpen(o => !o)} className={filtersOpen ? activeBtnCls : outlineBtnCls} aria-pressed={filtersOpen}>
              <Filter className="h-3.5 w-3.5" />
              {t('products.list.filter')}
            </button>
            <button onClick={resetFilters} className={outlineBtnCls}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t('products.list.clear')}
            </button>
            <Popover>
              <PopoverTrigger render={<button type="button" className={outlineBtnCls} />}>
                <Settings2 className="h-3.5 w-3.5" />
                {t('products.list.settings')}
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-2 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700">
                <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">{t('products.list.columns')}</p>
                <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-400 dark:text-gray-500">
                  <input type="checkbox" checked disabled className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600" />
                  {t('products.list.name')}
                </label>
                {COLUMNS.map(c => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
                    <input type="checkbox" checked={isVisible(c.id)} onChange={() => toggleColumn(c.id)} className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600" />
                    {t(c.label)}
                  </label>
                ))}
                <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-400 dark:text-gray-500">
                  <input type="checkbox" checked disabled className="h-3.5 w-3.5 rounded border-gray-300 dark:border-gray-600" />
                  {t('products.list.actions')}
                </label>
              </PopoverContent>
            </Popover>
            <button onClick={() => setShowImages(v => !v)} className={iconBtnCls} title={t('products.list.toggleImages')} aria-label={t('products.list.toggleImages')} aria-pressed={showImages}>
              {showImages ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
            <div className="flex items-center gap-0.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-0.5">
              <button onClick={() => setView('list')} title={t('products.list.viewList')} aria-label={t('products.list.viewList')}
                className={`flex h-7 w-8 items-center justify-center rounded-md border transition-colors ${view === 'list' ? 'bg-slate-900 dark:bg-white shadow-sm border-slate-900 dark:border-white text-white dark:text-gray-900' : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}>
                <List className="h-4 w-4" />
              </button>
              <button onClick={() => setView('grid')} title={t('products.list.viewGrid')} aria-label={t('products.list.viewGrid')}
                className={`flex h-7 w-8 items-center justify-center rounded-md border transition-colors ${view === 'grid' ? 'bg-slate-900 dark:bg-white shadow-sm border-slate-900 dark:border-white text-white dark:text-gray-900' : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}>
                <Grid className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {filtersOpen && (
        <form onSubmit={applyFilters} className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className={labelCls}>{t('products.list.name')}</label>
              <input value={draftFilters.name} onChange={e => setDraftFilters(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder={t('products.list.namePlaceholder')} />
            </div>
            <div>
              <label className={labelCls}>{t('products.list.sku')}</label>
              <input value={draftFilters.sku} onChange={e => setDraftFilters(f => ({ ...f, sku: e.target.value }))} className={inputCls} placeholder={t('products.list.skuPlaceholder')} />
            </div>
            <div>
              <label className={labelCls}>{t('products.list.unit')}</label>
              <select value={draftFilters.unit} onChange={e => setDraftFilters(f => ({ ...f, unit: e.target.value as ListFilters['unit'] }))} className={selectCls}>
                <option value="all">{t('products.list.allUnits')}</option>
                <option value="piece">{t('products.list.unitPiece')}</option>
                <option value="ml">{t('products.list.unitMl')}</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('products.list.status')}</label>
              <select value={draftFilters.status} onChange={e => setDraftFilters(f => ({ ...f, status: e.target.value as ListFilters['status'] }))} className={selectCls}>
                <option value="all">{t('products.list.allStatuses')}</option>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('products.list.group')}</label>
              <select value={draftFilters.group} onChange={e => setDraftFilters(f => ({ ...f, group: e.target.value }))} className={selectCls}>
                <option value="">{t('products.list.allGroups')}</option>
                {groupOptions.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 border-t border-gray-100 dark:border-gray-800 pt-4">
            <button type="submit" className="flex h-9 items-center rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white px-4 text-[13px] font-medium text-white dark:text-slate-900 transition-colors">
              {t('products.list.apply')}
            </button>
            <button type="button" onClick={resetFilters} className="h-9 rounded-lg px-3 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
              {t('products.list.clear')}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
          {t('common.notFound')}
        </div>
      ) : view === 'grid' ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            {paginated.map(p => (
              <div key={p.id} className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm transition-all">
                <div className="flex h-36 items-center justify-center bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-800 overflow-hidden">
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.imageUrl} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <Tag className="h-8 w-8 text-gray-300 dark:text-gray-600" />
                  )}
                </div>
                <div className="p-3">
                  <p className="text-[11px] font-mono text-gray-400 dark:text-gray-500 mb-0.5">{p.sku}</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-tight">{p.name}</p>
                  <p className="text-[13px] font-semibold text-gray-900 dark:text-gray-100 mt-1 tabular-nums">{formatPrice(p.price)}</p>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {p.colors.map(c => (
                      <span key={c} className="text-[10px] font-medium px-1.5 py-0.5 rounded border text-gray-500 bg-gray-50 border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">{c}</span>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <button onClick={e => openEdit(p, e)} className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                      <Edit2 className="h-3 w-3" />{t('products.edit')}
                    </button>
                    <button onClick={e => openBarcode(p, e)} className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                      <ScanBarcode className="h-3.5 w-3.5" /> Shtrix-kod
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
            {totalPages > 1 ? (
              <Pagination currentPage={currentPage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
            ) : (
              <p className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500">{filtered.length} {t('products.countSuffix')}</p>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max">
              <thead className="bg-table-header-bg dark:bg-gray-800/50">
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <SortHeader label={t('products.list.name')} active={sortKey === 'name'} dir={sortDir} onClick={() => toggleSort('name')} />
                  {isVisible('group') && <th className={`${thCls} text-left`}>{t('products.list.group')}</th>}
                  {isVisible('sku') && <SortHeader label={t('products.list.sku')} active={sortKey === 'sku'} dir={sortDir} onClick={() => toggleSort('sku')} />}
                  {isVisible('variants') && <th className={`${thCls} text-center`}>{t('products.list.variants')}</th>}
                  {isVisible('unit') && <th className={`${thCls} text-left`}>{t('products.list.unit')}</th>}
                  {isVisible('minStock') && <th className={`${thCls} text-right`}>{t('products.list.minStock')}</th>}
                  {isVisible('stock') && <th className={`${thCls} text-right`}>{t('products.list.stock')}</th>}
                  {isVisible('price') && <th className={`${thCls} text-right`}>{t('products.list.price')}</th>}
                  {isVisible('status') && <th className={`${thCls} text-left`}>{t('products.list.status')}</th>}
                  {isVisible('createdAt') && <SortHeader label={t('products.list.createdAt')} active={sortKey === 'createdAt'} dir={sortDir} onClick={() => toggleSort('createdAt')} />}
                  <th className={`${thCls} text-center`}>{t('products.list.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(p => {
                  const stock = stockTotals.get(p.id) ?? 0
                  const stockCls = stock <= 0
                    ? 'text-red-600 dark:text-red-400'
                    : stock <= p.minStock
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-gray-900 dark:text-gray-100'
                  const note = p.description.split('\n')[0].trim()
                  return (
                    <tr key={p.id} className="border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {showImages && (
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-800">
                              {p.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={p.imageUrl} alt={p.name} className="h-full w-full object-cover" />
                              ) : (
                                <Tag className="h-4 w-4 text-gray-400 dark:text-gray-500" />
                              )}
                            </div>
                          )}
                          <div className="min-w-0 max-w-72">
                            <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{p.name}</p>
                            {note && <p className="truncate text-xs text-gray-400 dark:text-gray-500 mt-0.5">{note}</p>}
                          </div>
                        </div>
                      </td>
                      {isVisible('group') && <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{p.category || '—'}</td>}
                      {isVisible('sku') && <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{p.sku}</td>}
                      {isVisible('variants') && (
                        <td className="px-4 py-3 text-center">
                          <span className="rounded-md bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs tabular-nums text-gray-600 dark:text-gray-400">
                            {skuCounts.get(p.id) ?? 0}
                          </span>
                        </td>
                      )}
                      {isVisible('unit') && <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{unitLabel(unitOf(p))}</td>}
                      {isVisible('minStock') && <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-500 dark:text-gray-400">{p.minStock}</td>}
                      {isVisible('stock') && <td className={`px-4 py-3 text-sm text-right font-medium tabular-nums ${stockCls}`}>{stock}</td>}
                      {isVisible('price') && <td className="px-4 py-3 text-sm text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatPrice(p.price)}</td>}
                      {isVisible('status') && <td className="px-4 py-3"><MiniBadge status={p.status} /></td>}
                      {isVisible('createdAt') && <td className="px-4 py-3 text-sm tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDmy(p.createdAt)}</td>}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button onClick={e => openBarcode(p, e)} title={t('products.list.view')} aria-label={t('products.list.view')}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={e => openEdit(p, e)} title={t('products.edit')} aria-label={t('products.edit')}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => setDeleteTarget(p)} title={t('common.delete')} aria-label={t('common.delete')}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-300 transition-colors">
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
          {totalPages > 1 ? (
            <Pagination currentPage={currentPage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
          ) : (
            <p className="px-4 py-3 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-500">{filtered.length} {t('products.countSuffix')}</p>
          )}
        </div>
      )}

      {/* Add modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('products.modal.addTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2 max-h-[65vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.name')} *</label>
                <input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="Finka" />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">SKU prefix</label>
                <input value={addForm.skuPrefix} onChange={e => setAddForm(f => ({ ...f, skuPrefix: e.target.value }))} className={inputCls} placeholder="FIN (auto)" />
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.barcode')}</label>
              <div className="flex gap-2">
                <input value={addForm.barcode} onChange={e => setAddForm(f => ({ ...f, barcode: e.target.value }))} className={inputCls} inputMode="numeric" placeholder="4780000000000" />
                <button type="button" disabled={barcodeGenBusy} onClick={() => autoBarcode(code => setAddForm(f => ({ ...f, barcode: code })))}
                  className="h-9 shrink-0 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-2.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
                  {t('products.modal.barcodeAuto')}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.category')}</label>
                <select value={addForm.category} onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))} className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 outline-none focus:border-gray-400 dark:focus:border-gray-500">
                  {activeGroups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.price')} *</label>
                <input type="number" value={addForm.price} onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))} className={inputCls} placeholder="0" />
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.warehouse')}</label>
              <select value={addForm.warehouseId} onChange={e => setAddForm(f => ({ ...f, warehouseId: e.target.value }))} className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 outline-none focus:border-gray-400 dark:focus:border-gray-500">
                <option value="">—</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({t(WAREHOUSE_TYPE_LABEL_KEYS[w.type])})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Tavsif</label>
              <textarea rows={2} value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Mahsulot haqida qisqacha..."
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.image')}</label>
              {addImagePreview ? (
                <div className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={addImagePreview} alt="" className="h-24 w-24 rounded-lg object-cover border border-gray-200 dark:border-gray-700" />
                  <button type="button" title={t('products.modal.imageRemove')} onClick={() => removeImage(setAddImageFile, setAddImagePreview)}
                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shadow-sm transition-colors">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <label className="flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
                  <ImagePlus className="h-5 w-5 text-gray-400" />
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('products.modal.imageHint')}</span>
                  <input type="file" accept="image/*" className="hidden" onChange={e => handleImageSelect(e, setAddImageFile, setAddImagePreview)} />
                </label>
              )}
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('products.modal.colors')}</label>
              <div className="flex flex-wrap gap-1.5">
                {COLORS_LIST.map(c => (
                  <button key={c} type="button" onClick={() => setAddForm(f => ({ ...f, colors: toggleColor(f.colors, c) }))}
                    className={`px-3 py-1 rounded-md text-[13px] font-medium border transition-colors ${addForm.colors.includes(c) ? 'bg-slate-900 hover:bg-slate-800 text-white border-slate-900 dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 dark:border-slate-100' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">{t('products.modal.colorsHint')}</p>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveAdd} disabled={saving || !addForm.warehouseId} loading={saving}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit modal */}
      <Dialog open={!!editProduct} onOpenChange={open => { if (!open) setEditProduct(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('products.modal.editTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2 max-h-[60vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.name')}</label>
                <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.sku')}</label>
                <input value={editForm.sku} onChange={e => setEditForm(f => ({ ...f, sku: e.target.value }))} className={inputCls} />
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.barcode')}</label>
              <div className="flex gap-2">
                <input value={editForm.barcode} onChange={e => setEditForm(f => ({ ...f, barcode: e.target.value }))} className={inputCls} inputMode="numeric" placeholder="4780000000000" />
                <button type="button" disabled={barcodeGenBusy} onClick={() => autoBarcode(code => setEditForm(f => ({ ...f, barcode: code })))}
                  className="h-9 shrink-0 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-2.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
                  {t('products.modal.barcodeAuto')}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.category')}</label>
                <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500">
                  {activeGroups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.price')}</label>
                <input type="number" value={editForm.price} onChange={e => setEditForm(f => ({ ...f, price: e.target.value }))} className={inputCls} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.minStock')}</label>
                <input type="number" value={editForm.minStock} onChange={e => setEditForm(f => ({ ...f, minStock: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.table.status')}</label>
                <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value as Product['status'] }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500">
                  <option value="active">Faol</option>
                  <option value="inactive">Nofaol</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.warehouse')}</label>
              <select value={editForm.warehouseId} onChange={e => setEditForm(f => ({ ...f, warehouseId: e.target.value }))} className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 outline-none focus:border-gray-400 dark:focus:border-gray-500">
                <option value="">—</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name} ({t(WAREHOUSE_TYPE_LABEL_KEYS[w.type])})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Tavsif</label>
              <textarea rows={2} value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors" />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('products.modal.image')}</label>
              {editImagePreview ? (
                <div className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={editImagePreview} alt="" className="h-24 w-24 rounded-lg object-cover border border-gray-200 dark:border-gray-700" />
                  <button type="button" title={t('products.modal.imageRemove')} onClick={() => removeImage(setEditImageFile, setEditImagePreview)}
                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shadow-sm transition-colors">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <label className="flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
                  <ImagePlus className="h-5 w-5 text-gray-400" />
                  <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('products.modal.imageHint')}</span>
                  <input type="file" accept="image/*" className="hidden" onChange={e => handleImageSelect(e, setEditImageFile, setEditImagePreview)} />
                </label>
              )}
            </div>
            {editProduct && <CompanionSection productId={editProduct.id} />}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('products.modal.colors')}</label>
              <div className="flex flex-wrap gap-1.5">
                {COLORS_LIST.map(c => (
                  <button key={c} type="button" onClick={() => setEditForm(f => ({ ...f, colors: toggleColor(f.colors, c) }))}
                    className={`px-3 py-1 rounded-md text-[13px] font-medium border transition-colors ${editForm.colors.includes(c) ? 'bg-slate-900 hover:bg-slate-800 text-white border-slate-900 dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 dark:border-slate-100' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">{t('products.modal.colorsHint')}</p>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setEditProduct(null)}>{t('common.cancel')}</Button>
            <Button onClick={saveEdit} disabled={saving || !editForm.warehouseId} loading={saving}>
              {t('products.modal.update')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportModal open={isImportOpen} onOpenChange={setIsImportOpen} onImported={fetchProducts} />

      <BarcodeModal product={barcodeProduct} open={!!barcodeProduct} onOpenChange={open => { if (!open) setBarcodeProduct(null) }} />

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500 dark:text-red-400" />
              {t('products.list.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          {deleteTarget && (
            <div className="mt-2 space-y-3">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{deleteTarget.name}</p>
              <p className="text-sm text-gray-600 dark:text-gray-400">{t('products.list.deleteConfirm')}</p>
              {(stockTotals.get(deleteTarget.id) ?? 0) > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900 px-3 py-2.5">
                  <AlertTriangle className="h-4 w-4 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-[12px] text-amber-700 dark:text-amber-400">
                    {t('products.list.deleteStockWarning')}: {stockTotals.get(deleteTarget.id)} {unitLabel(unitOf(deleteTarget))}
                  </p>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDelete} disabled={deleting} loading={deleting}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
