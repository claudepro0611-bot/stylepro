'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Plus, Grid, List, Edit2, Tag, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Pagination } from '@/components/ui/Pagination'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ImportModal } from '@/components/mahsulotlar/ImportModal'
import { BarcodeModal } from '@/components/mahsulotlar/BarcodeModal'
import { createClient } from '@/lib/supabase/client'
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
  status: 'active' | 'inactive'
  warehouse_id: string | null
}

interface WarehouseRow { id: string; name: string; type: WarehouseType }

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

interface ProductGroupRow {
  id: string; name: string; description: string | null; status: 'active' | 'inactive'
}
function mapProductGroup(row: ProductGroupRow): ProductGroup {
  return { id: row.id, name: row.name, description: row.description ?? '', productsCount: 0, status: row.status, sizeType: 'clothing' }
}

const emptyAddForm = {
  name: '', skuPrefix: '', category: '', price: '', colors: [] as string[], description: '', warehouseId: '',
}
const emptyEditForm = {
  name: '', sku: '', category: '', price: '', minStock: '',
  colors: [] as string[], description: '', status: 'active' as Product['status'], warehouseId: '',
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

export default function MahsulotlarPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [products, setProducts] = useState<Product[]>([])
  const [groups, setGroups] = useState<ProductGroup[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [category, setCategory] = useState('Barchasi')
  const [page, setPage] = useState(1)

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [addForm, setAddForm] = useState(emptyAddForm)

  const [editProduct, setEditProduct] = useState<Product | null>(null)
  const [editForm, setEditForm] = useState(emptyEditForm)

  const [isImportOpen, setIsImportOpen] = useState(false)
  const [barcodeProduct, setBarcodeProduct] = useState<Product | null>(null)

  const fetchProducts = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('products').select('*').order('name')
    if (error) toast.error(t('common.error'))
    else setProducts((data as ProductRow[]).map(mapProduct))
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
  const categories = useMemo(() => ['Barchasi', ...activeGroups.map(g => g.name)], [activeGroups])

  const filtered = useMemo(() => (
    category === 'Barchasi' ? products : products.filter(p => p.category === category)
  ), [products, category])

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE)
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  function openAdd() {
    const defaultCat = activeGroups[0]?.name ?? "Ko'ylak"
    setAddForm({ ...emptyAddForm, category: defaultCat, warehouseId: warehouses[0]?.id ?? '' })
    setIsAddOpen(true)
  }

  async function saveAdd() {
    if (!addForm.name.trim() || !addForm.price || !addForm.warehouseId) {
      toast.error(t('products.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const sku = addForm.skuPrefix.trim() || addForm.name.trim().slice(0, 3).toUpperCase()

    const { error } = await supabase.rpc('create_product', {
      p_data: {
        name: addForm.name.trim(),
        sku,
        category: addForm.category,
        price: Number(addForm.price),
        min_stock: 5,
        colors: addForm.colors,
        description: addForm.description.trim(),
        status: 'active',
        warehouse_id: addForm.warehouseId,
      },
    })

    setSaving(false)
    if (error) { toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error')); return }
    toast.success(t('products.toasts.addSuccess'))
    setIsAddOpen(false)
    fetchProducts()
  }

  function openEdit(p: Product, e: React.MouseEvent) {
    e.stopPropagation()
    setEditProduct(p)
    setEditForm({
      name: p.name, sku: p.sku, category: p.category,
      price: String(p.price), minStock: String(p.minStock),
      colors: [...p.colors], description: p.description, status: p.status,
      warehouseId: p.warehouseId || warehouses[0]?.id || '',
    })
  }

  async function saveEdit() {
    if (!editProduct) return
    if (!editForm.warehouseId) {
      toast.error(t('products.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('update_product', {
      p_id: editProduct.id,
      p_data: {
        name: editForm.name.trim(),
        sku: editForm.sku.trim(),
        category: editForm.category,
        price: Number(editForm.price),
        min_stock: Number(editForm.minStock || 5),
        colors: editForm.colors,
        description: editForm.description.trim(),
        status: editForm.status,
        warehouse_id: editForm.warehouseId,
      },
    })
    setSaving(false)
    if (error) { toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error')); return }
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('products.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{filtered.length} {t('products.countSuffix')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
            <button onClick={() => setView('grid')} className={`flex h-9 w-9 items-center justify-center transition-colors ${view === 'grid' ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'}`}><Grid className="h-4 w-4" /></button>
            <button onClick={() => setView('list')} className={`flex h-9 w-9 items-center justify-center transition-colors ${view === 'list' ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'}`}><List className="h-4 w-4" /></button>
          </div>
          <button
            onClick={() => setIsImportOpen(true)}
            className="border border-gray-200 hover:bg-gray-50 text-gray-700 rounded-lg px-4 py-2 text-[13px] font-medium dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 transition-colors"
          >
            Excel import
          </button>
          <button onClick={openAdd} className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors">
            <Plus className="h-3.5 w-3.5" />
            {t('products.addNew')}
          </button>
        </div>
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-1.5">
        {categories.map(cat => (
          <button key={cat} onClick={() => { setCategory(cat); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${category === cat ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
            {cat === 'Barchasi' ? t('products.filterAll') : cat}
          </button>
        ))}
      </div>

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
                <div className="flex h-36 items-center justify-center bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-800">
                  <Tag className="h-8 w-8 text-gray-300 dark:text-gray-600" />
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
                      🏷️ Shtrix-kod
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm">
            <Pagination currentPage={page} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
          </div>
        </>
      ) : (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('products.table.product')}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('products.table.sku')}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('products.table.category')}</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('products.table.price')}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('products.table.status')}</th>
                  <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('products.table.action')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((p, i) => (
                  <tr key={p.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</p>
                      {p.colors.length > 0 && <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{p.colors.join(', ')}</p>}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-gray-400 dark:text-gray-500">{p.sku}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{p.category}</td>
                    <td className="px-4 py-3 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(p.price)}</td>
                    <td className="px-4 py-3"><MiniBadge status={p.status} /></td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={e => openEdit(p, e)} className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                          <Edit2 className="h-3 w-3" />{t('products.edit')}
                        </button>
                        <button onClick={e => openBarcode(p, e)} className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                          🏷️ Shtrix-kod
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination currentPage={page} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
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
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('products.modal.colors')}</label>
              <div className="flex flex-wrap gap-1.5">
                {COLORS_LIST.map(c => (
                  <button key={c} type="button" onClick={() => setAddForm(f => ({ ...f, colors: toggleColor(f.colors, c) }))}
                    className={`px-3 py-1 rounded-md text-[13px] font-medium border transition-colors ${addForm.colors.includes(c) ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">{t('products.modal.colorsHint')}</p>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveAdd} disabled={saving || !addForm.warehouseId}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
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
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('products.modal.colors')}</label>
              <div className="flex flex-wrap gap-1.5">
                {COLORS_LIST.map(c => (
                  <button key={c} type="button" onClick={() => setEditForm(f => ({ ...f, colors: toggleColor(f.colors, c) }))}
                    className={`px-3 py-1 rounded-md text-[13px] font-medium border transition-colors ${editForm.colors.includes(c) ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">{t('products.modal.colorsHint')}</p>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setEditProduct(null)}>{t('common.cancel')}</Button>
            <Button onClick={saveEdit} disabled={saving || !editForm.warehouseId}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('products.modal.update')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportModal open={isImportOpen} onOpenChange={setIsImportOpen} onImported={fetchProducts} />

      <BarcodeModal product={barcodeProduct} open={!!barcodeProduct} onOpenChange={open => { if (!open) setBarcodeProduct(null) }} />
    </div>
  )
}
