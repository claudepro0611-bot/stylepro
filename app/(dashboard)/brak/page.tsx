'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Plus, Trash2, Loader2, PackageSearch,
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
import type { Product } from '@/lib/types'
import type { WarehouseType } from '@/lib/warehouses'

const ITEMS_PER_PAGE = 20
const TODAY = new Date().toISOString().slice(0, 10)

const fieldCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:ring-red-950 transition-colors'

function nowLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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

interface SizeOption { id: string; size: string; color: string; stock: number; purchasePrice: number }

function sizeLabel(s: { size: string; color: string }): string {
  return s.color ? `${s.color} / ${s.size}` : s.size
}
interface WarehouseRow { id: string; name: string; type: WarehouseType }

interface BrakRow {
  id: string
  product_id: string
  product_name: string
  category: string | null
  size: string | null
  color: string | null
  quantity: number
  sell_price: number
  total_amount: number
  date: string
  note: string | null
  entry_type: string
}

interface BrakEntry {
  id: string
  productId: string
  productName: string
  category: string
  size: string
  color: string
  quantity: number
  unitPrice: number
  totalAmount: number
  date: string
  reason: string
}

function mapBrak(row: BrakRow): BrakEntry {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    category: row.category ?? '',
    size: row.size ?? '',
    color: row.color ?? '',
    quantity: row.quantity,
    unitPrice: Number(row.sell_price ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    date: row.date,
    reason: row.note ?? '',
  }
}

const emptyForm = {
  productId: '',
  sizeRowId: '',
  datetime: '',
  quantity: '',
  reason: '',
}

export default function BrakPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [entries, setEntries] = useState<BrakEntry[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [page, setPage] = useState(1)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [productSizes, setProductSizes] = useState<SizeOption[]>([])
  const [productPurchasePrice, setProductPurchasePrice] = useState(0)
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [activeWarehouseId, setActiveWarehouseId] = useLocalStorage<string>('stylepro-active-warehouse-id', '')

  const fetchEntries = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('stock_out_entries')
      .select('*')
      .eq('entry_type', 'brak')
      .order('date', { ascending: false })
    if (error) {
      toast.error(t('common.error'))
    } else {
      setEntries((data as BrakRow[]).map(mapBrak))
    }
    setLoading(false)
  }, [t])

  const fetchProducts = useCallback(async () => {
    const supabase = createClient()
    const [{ data, error }, { data: whData, error: whErr }] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase.from('warehouses').select('id, name, type'),
    ])
    if (error || whErr) {
      toast.error(t('common.error'))
      return
    }
    setProducts((data as ProductRow[]).map(mapProduct))
    setWarehouses((whData ?? []) as WarehouseRow[])
  }, [t])

  useEffect(() => {
    fetchEntries()
    fetchProducts()
  }, [fetchEntries, fetchProducts])

  useEffect(() => {
    if (!activeWarehouseId && warehouses.length > 0) setActiveWarehouseId(warehouses[0].id)
  }, [warehouses, activeWarehouseId, setActiveWarehouseId])

  const activeWarehouse = useMemo(() => warehouses.find(w => w.id === activeWarehouseId) ?? warehouses[0], [warehouses, activeWarehouseId])
  // Which products are eligible for a warehouse is not determined by
  // matching product category to warehouse type — the actual stock lookup
  // below (onProductSelect) already scopes strictly by
  // product_sizes.warehouse_id, which is the only real source of truth.
  const warehouseProducts = useMemo(() => {
    if (!activeWarehouse) return []
    return products.filter(p => !p.warehouseId || p.warehouseId === activeWarehouse.id)
  }, [products, activeWarehouse])

  async function onProductSelect(productId: string) {
    setForm(p => ({ ...p, productId, sizeRowId: '' }))
    setProductSizes([])
    setProductPurchasePrice(0)
    if (!productId || !activeWarehouse) return
    const supabase = createClient()
    const { data } = await supabase
      .from('product_sizes')
      .select('id, size, color, stock, purchase_price')
      .eq('product_id', productId)
      .eq('warehouse_id', activeWarehouse.id)
      .gt('stock', 0)
      .order('size')
    const rows = (data ?? []) as { id: string; size: string; color: string; stock: number; purchase_price: number }[]
    setProductSizes(rows.map(r => ({ id: r.id, size: r.size, color: r.color ?? '', stock: r.stock, purchasePrice: Number(r.purchase_price) })))
  }

  function onSizeSelect(sizeRowId: string) {
    setForm(p => ({ ...p, sizeRowId }))
    const row = productSizes.find(s => s.id === sizeRowId)
    setProductPurchasePrice(row?.purchasePrice ?? 0)
  }

  async function addEntry() {
    const qty = Number(form.quantity)
    if (!form.productId || !form.sizeRowId || !qty || qty <= 0) {
      toast.error(t('brak.toasts.requiredError'))
      return
    }
    if (!productPurchasePrice || productPurchasePrice <= 0) {
      toast.error('Narx kiritilishi shart')
      return
    }
    const product = warehouseProducts.find(p => p.id === form.productId)
    const sizeRow = productSizes.find(s => s.id === form.sizeRowId)
    if (!product || !sizeRow) return
    const quantity = qty
    const unitPrice = productPurchasePrice
    if (quantity > sizeRow.stock) {
      toast.error(`${t('common.error')} — mavjud: ${sizeRow.stock}`)
      return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('stock_out', {
      p_entries: [{
        product_size_id: sizeRow.id,
        product_id: product.id,
        product_name: product.name,
        category: product.category,
        size: sizeRow.size,
        quantity,
        sell_price: unitPrice,
        customer_id: null,
        customer_name: '',
        payment_method: '',
        date: form.datetime ? `${form.datetime}:00` : new Date().toISOString(),
        note: form.reason.trim(),
      }],
      p_entry_type: 'brak',
    })
    setSaving(false)
    if (error) {
      if (error.message.includes('Insufficient stock')) {
        toast.error(`${t('common.error')} — mavjud: ${sizeRow.stock}`)
      } else if (error.message.includes('forbidden')) {
        toast.error(t('common.forbidden'))
      } else {
        toast.error(t('common.error'))
      }
      return
    }
    setForm(emptyForm)
    setProductSizes([])
    setProductPurchasePrice(0)
    setIsAddOpen(false)
    toast.success(t('brak.toasts.addSuccess'))
    fetchEntries()
  }

  async function deleteEntry(id: string) {
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_stock_out_entry', { p_id: id })
    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    toast.success(t('brak.toasts.deleteSuccess'))
    fetchEntries()
  }

  const totalPages = Math.ceil(entries.length / ITEMS_PER_PAGE)
  const paginated = entries.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  const todayEntries = useMemo(() => entries.filter(e => e.date.slice(0, 10) === TODAY), [entries])
  const todayQty = todayEntries.reduce((s, e) => s + e.quantity, 0)
  const todaySum = todayEntries.reduce((s, e) => s + e.totalAmount, 0)
  const monthEntries = useMemo(() => entries.filter(e => e.date.slice(0, 7) === TODAY.slice(0, 7)), [entries])
  const monthQty = monthEntries.reduce((s, e) => s + e.quantity, 0)
  const monthSum = monthEntries.reduce((s, e) => s + e.totalAmount, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('brak.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('brak.subtitle')}</p>
        </div>
        <Tabs value={activeWarehouseId} onValueChange={setActiveWarehouseId}>
          <TabsList>
            {warehouses.map(w => (
              <TabsTrigger key={w.id} value={w.id}>{w.name}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <button
          onClick={() => { setForm({ ...emptyForm, datetime: nowLocal() }); setProductSizes([]); setProductPurchasePrice(0); setIsAddOpen(true) }}
          className="flex items-center gap-2 rounded-lg bg-red-500 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-red-600 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('brak.addEntry')}
        </button>
      </div>

      <StatsPanel storageKey="brak-stats-open" title={t('brak.stats.statsPanel')}>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-4">
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('brak.stats.todayQty')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{todayQty} {t('brak.unitsSuffix')}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('brak.stats.todaySum')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(todaySum)}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('brak.stats.monthQty')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{monthQty} {t('brak.unitsSuffix')}</p>
          </div>
          <div>
            <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('brak.stats.monthSum')}</p>
            <p className="text-[22px] font-medium text-gray-900 dark:text-gray-100 tabular-nums mt-1">{formatPrice(monthSum)}</p>
          </div>
        </div>
      </StatsPanel>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900">
              <PackageSearch className="h-6 w-6 text-red-300 dark:text-red-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('brak.empty')}</p>
              <p className="text-[12px] text-gray-400 dark:text-gray-500 mt-0.5">{t('brak.emptySubtitle')}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-gray-800/50">
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">№</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.date')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.productName')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.category')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.size')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.color')}</th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.quantity')}</th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.total')}</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.reason')}</th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('brak.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((e, i) => (
                    <tr key={e.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}>
                      <td className="px-4 py-3 text-[12px] text-gray-400 dark:text-gray-500">{(page - 1) * ITEMS_PER_PAGE + i + 1}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDateTime(e.date)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{e.productName}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.category}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.size}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{e.color}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center rounded-md bg-red-50 dark:bg-red-950/40 px-2 py-1 text-[12px] font-semibold text-red-600 dark:text-red-400">
                          {e.quantity} {t('brak.unitsSuffix')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-semibold text-red-600 dark:text-red-400 tabular-nums whitespace-nowrap">{formatPrice(e.totalAmount)}</td>
                      <td className="px-4 py-3 text-sm text-gray-400 dark:text-gray-500">{e.reason || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
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
            <Pagination currentPage={page} totalPages={totalPages} totalItems={entries.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
          </>
        )}
      </div>

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('brak.addEntry')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2 max-h-[70vh] overflow-y-auto pr-1">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('brak.modal.selectProduct')}</label>
              <SearchSelect
                options={warehouseProducts.map(p => ({ value: p.id, label: p.name, sublabel: p.warehouseId ? p.sku : `${p.sku} — ${t('products.noWarehouse')}` }))}
                value={form.productId}
                onChange={onProductSelect}
                placeholder={t('brak.modal.selectProductPlaceholder')}
                focusRingClassName="focus:border-red-400 focus:ring-red-100"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('brak.modal.dateTime')}</label>
              <input
                type="datetime-local"
                value={form.datetime}
                onChange={e => setForm(p => ({ ...p, datetime: e.target.value }))}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('brak.modal.quantity')}</label>
              <input
                type="number"
                min="1"
                placeholder={t('brak.modal.quantityPlaceholder')}
                value={form.quantity}
                onChange={e => setForm(p => ({ ...p, quantity: e.target.value }))}
                className={fieldCls}
              />
            </div>
            {productSizes.length > 0 && (
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('brak.modal.size')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {productSizes.map(s => (
                    <button key={s.id} type="button" onClick={() => onSizeSelect(s.id)}
                      className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition-colors ${form.sizeRowId === s.id ? 'border-red-500 bg-red-500 text-white' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}>
                      <span>{sizeLabel(s)}</span>
                      <span className={`text-[11px] ${form.sizeRowId === s.id ? 'text-red-100' : 'text-gray-400 dark:text-gray-500'}`}>({s.stock} ta)</span>
                    </button>
                  ))}
                </div>
                {form.sizeRowId && (!productPurchasePrice || productPurchasePrice <= 0) && (
                  <p className="text-xs text-red-500 mt-1">Narx kiritilishi shart</p>
                )}
              </div>
            )}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('brak.modal.reason')}</label>
              <textarea
                rows={2}
                placeholder={t('brak.modal.reasonPlaceholder')}
                value={form.reason}
                onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:ring-red-950 resize-none transition-colors"
              />
            </div>
            {productPurchasePrice > 0 && form.quantity && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-100 dark:border-red-900 px-3 py-2">
                <p className="text-[12px] text-red-600 dark:text-red-400 font-medium">
                  Zarar: {formatPrice(productPurchasePrice * parseInt(form.quantity || '0'))}
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={addEntry}
              disabled={saving || !productPurchasePrice || productPurchasePrice <= 0}
              className={`bg-red-500 text-white hover:bg-red-600 ${!productPurchasePrice ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
