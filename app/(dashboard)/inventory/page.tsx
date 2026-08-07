'use client'

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AlertTriangle, ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Pagination } from '@/components/ui/Pagination'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import type { Product } from '@/lib/types'
import { sortSizes } from '@/lib/sizes'
import { WAREHOUSE_TYPE_LABEL_KEYS, CREATABLE_WAREHOUSE_TYPES, type WarehouseType } from '@/lib/warehouses'

const ITEMS_PER_PAGE = 20

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

interface ProductRow {
  id: string; name: string; sku: string | null; category: string | null
  price: number; colors: string[] | null; min_stock: number; status: 'active' | 'inactive'
}

interface ProductSizeRow {
  id: string; product_id: string; size: string; color: string; stock: number
  purchase_price: number; selling_price: number; warehouse_id: string | null
}

interface WarehouseRow { id: string; name: string; type: WarehouseType }

function mapProduct(r: ProductRow): Product {
  return {
    id: r.id, name: r.name, sku: r.sku ?? '', category: r.category ?? '',
    price: Number(r.price), description: '', colors: r.colors ?? [],
    minStock: r.min_stock, imageUrl: '', status: r.status,
    // Not fetched here — inventory groups by product_sizes.warehouse_id
    // (per-variant, already correct), not products.warehouse_id.
    warehouseId: '',
  }
}

interface Variant {
  color: string
  size: string
  stock: number
}

interface NameGroup {
  productId: string
  name: string
  sku: string
  category: string
  variants: Variant[]
  total: number
  outOfStock: number
  minStock: number
}

function VariantChip({ variant }: { variant: Variant }) {
  const { color, size, stock } = variant
  const style: CSSProperties = stock === 0
    ? { border: '1.5px solid #ef4444' }
    : stock <= 3
      ? { border: '1.5px solid #f59e0b' }
      : { border: '0.5px solid var(--border)' }
  return (
    <span
      style={style}
      className="inline-flex items-center rounded-lg bg-gray-50 dark:bg-gray-800 px-2 py-1 text-xs text-gray-700 dark:text-gray-300"
    >
      {`${color}·${size} ${stock}`}
    </span>
  )
}

function ProductAccordionRow({ group }: { group: NameGroup }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="px-5 py-4">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{group.name}</p>
          {group.sku && (
            <span className="shrink-0 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 text-xs font-medium">
              {group.sku}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {group.outOfStock > 0 && (
            <span className="rounded-full bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400 px-2 py-0.5 text-xs font-medium">
              {group.outOfStock} ta tugagan
            </span>
          )}
          <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{group.total}</span>
          <ChevronDown className={cn('h-4 w-4 text-gray-400 dark:text-gray-500 transition-transform duration-200', open ? 'rotate-180' : 'rotate-0')} />
        </div>
      </button>
      <div className={cn('overflow-hidden transition-all duration-200 ease-in-out', open ? 'mt-3 max-h-[2000px] opacity-100' : 'max-h-0 opacity-0')}>
        <div className="flex flex-wrap gap-[5px]">
          {group.variants.map(v => (
            <VariantChip key={`${v.color}-${v.size}`} variant={v} />
          ))}
        </div>
      </div>
    </div>
  )
}

export default function InventoryPage() {
  const { t } = useLanguage()
  const [products, setProducts] = useState<Product[]>([])
  const [sizeRows, setSizeRows] = useState<ProductSizeRow[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [warehouseLimit, setWarehouseLimit] = useState(2)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [activeWarehouseId, setActiveWarehouseId] = useLocalStorage<string>('stylepro-active-warehouse-id', '')

  const [isAddWarehouseOpen, setIsAddWarehouseOpen] = useState(false)
  const [newWarehouseName, setNewWarehouseName] = useState('')
  const [newWarehouseType, setNewWarehouseType] = useState<WarehouseType>('clothing')
  const [savingWarehouse, setSavingWarehouse] = useState(false)
  const [deleteWarehouseTarget, setDeleteWarehouseTarget] = useState<WarehouseRow | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [
      { data: prodData, error: prodErr },
      { data: sizeData, error: sizeErr },
      { data: whData, error: whErr },
      { data: companyData },
    ] = await Promise.all([
      supabase.from('products').select('id, name, sku, category, price, colors, min_stock, status').order('name'),
      supabase.from('product_sizes').select('id, product_id, size, color, stock, purchase_price, selling_price, warehouse_id'),
      supabase.from('warehouses').select('id, name, type'),
      supabase.from('companies').select('warehouse_limit').single(),
    ])
    if (prodErr || sizeErr || whErr) toast.error(t('common.error'))
    else {
      setProducts((prodData as ProductRow[]).map(mapProduct))
      setSizeRows(sizeData as ProductSizeRow[])
      setWarehouses(whData as WarehouseRow[])
      setWarehouseLimit((companyData as { warehouse_limit: number } | null)?.warehouse_limit ?? 2)
    }
    setLoading(false)
  }, [t])

  useEffect(() => { fetchData() }, [fetchData])

  useEffect(() => {
    if (!activeWarehouseId && warehouses.length > 0) setActiveWarehouseId(warehouses[0].id)
  }, [warehouses, activeWarehouseId, setActiveWarehouseId])

  const activeWarehouse = useMemo(() => warehouses.find(w => w.id === activeWarehouseId) ?? warehouses[0], [warehouses, activeWarehouseId])
  const activeSizeRows = useMemo(
    () => activeWarehouse ? sizeRows.filter(sz => sz.warehouse_id === activeWarehouse.id) : [],
    [sizeRows, activeWarehouse],
  )

  // Row existence, not stock quantity, is what actually blocks deletion
  // (product_sizes.warehouse_id has no ON DELETE clause, so the FK itself
  // rejects a delete if any row references it — even one at stock 0).
  const warehouseRefCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const sz of sizeRows) {
      if (!sz.warehouse_id) continue
      map.set(sz.warehouse_id, (map.get(sz.warehouse_id) ?? 0) + 1)
    }
    return map
  }, [sizeRows])

  const groups = useMemo<NameGroup[]>(() => {
    const productMap = new Map(products.map(p => [p.id, p]))
    const map = new Map<string, NameGroup>()
    for (const sz of activeSizeRows) {
      const p = productMap.get(sz.product_id)
      if (!p) continue
      if (!map.has(p.id)) {
        map.set(p.id, { productId: p.id, name: p.name, sku: p.sku, category: p.category, variants: [], total: 0, outOfStock: 0, minStock: p.minStock })
      }
      const g = map.get(p.id)!
      g.variants.push({ color: sz.color, size: sz.size, stock: sz.stock })
      g.total += sz.stock
      if (sz.stock === 0) g.outOfStock += 1
    }
    for (const g of map.values()) {
      const sizeOrder = new Map(sortSizes(Array.from(new Set(g.variants.map(v => v.size)))).map((s, i) => [s, i]))
      g.variants.sort((a, b) => {
        const diff = (sizeOrder.get(a.size) ?? 0) - (sizeOrder.get(b.size) ?? 0)
        return diff !== 0 ? diff : a.color.localeCompare(b.color)
      })
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [products, activeSizeRows])

  const totalPages = Math.ceil(groups.length / ITEMS_PER_PAGE)
  const paginated = groups.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  async function createWarehouse() {
    if (!newWarehouseName.trim() || warehouses.length >= warehouseLimit) return
    setSavingWarehouse(true)
    const supabase = createClient()
    const { data, error } = await supabase.rpc('create_warehouse', {
      p_name: newWarehouseName.trim(),
      p_type: newWarehouseType,
    })
    setSavingWarehouse(false)
    if (error || !data) {
      toast.error(error?.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    const created: WarehouseRow = { id: data as string, name: newWarehouseName.trim(), type: newWarehouseType }
    setWarehouses(prev => [...prev, created])
    setActiveWarehouseId(created.id)
    setIsAddWarehouseOpen(false)
    setNewWarehouseName('')
    setNewWarehouseType('clothing')
    toast.success(t('inventory.warehouses.addSuccess'))
  }

  async function executeDeleteWarehouse() {
    if (!deleteWarehouseTarget) return
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_warehouse', { p_id: deleteWarehouseTarget.id })
    if (error) {
      if (error.message.includes('forbidden')) toast.error(t('common.forbidden'))
      else if (error.message.includes('linked product size')) toast.error(t('inventory.warehouses.deleteBlockedTooltip'))
      else toast.error(t('common.error'))
      return
    }
    const deletedId = deleteWarehouseTarget.id
    setWarehouses(prev => prev.filter(w => w.id !== deletedId))
    if (activeWarehouseId === deletedId) setActiveWarehouseId('')
    setDeleteWarehouseTarget(null)
    toast.success(t('inventory.warehouses.deleteSuccess'))
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('inventory.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('inventory.subtitle')}</p>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('inventory.warehouses.title')}</h2>
            <span className="text-sm bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded-full">
              {warehouses.length}/{warehouseLimit}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsAddWarehouseOpen(true)}
            disabled={warehouses.length >= warehouseLimit}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              warehouses.length >= warehouseLimit
                ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white',
            )}
          >
            <Plus className="h-4 w-4" />
            {t('inventory.warehouses.addNew')}
          </button>
        </div>

        {warehouses.length >= warehouseLimit && (
          <div className="mb-4 flex items-center gap-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-400 px-4 py-2 rounded-lg text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t('inventory.warehouses.limitReached')}
          </div>
        )}

        <div className="flex gap-2 mb-6 flex-wrap">
          {warehouses.map(w => {
            const refCount = warehouseRefCount.get(w.id) ?? 0
            const isActive = activeWarehouse?.id === w.id
            return (
              <div key={w.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { setActiveWarehouseId(w.id); setPage(1) }}
                  className={cn(
                    'rounded-lg px-4 py-2 font-medium transition-colors',
                    isActive
                      ? 'bg-blue-600 text-white border border-blue-600'
                      : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
                  )}
                >
                  {w.name}
                  <span className="ml-1.5 text-[11px] opacity-60">({t(WAREHOUSE_TYPE_LABEL_KEYS[w.type])})</span>
                </button>
                {refCount === 0 ? (
                  <button
                    type="button"
                    onClick={() => setDeleteWarehouseTarget(w)}
                    aria-label={t('inventory.warehouses.deleteTitle')}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span
                    title={t('inventory.warehouses.deleteBlockedTooltip')}
                    className="flex h-8 items-center gap-1 rounded-lg px-2 text-[11px] text-gray-300 dark:text-gray-600 cursor-not-allowed"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('inventory.tableTitle')}</p>
        </div>
        {loading ? (
          <div className="px-4 py-12 text-center text-sm text-gray-400">
            <Loader2 className="inline h-4 w-4 animate-spin mr-2" />{t('common.loading')}
          </div>
        ) : paginated.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-400">{t('common.notFound')}</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {paginated.map(g => (
              <ProductAccordionRow key={g.productId} group={g} />
            ))}
          </div>
        )}
        <Pagination currentPage={page} totalPages={totalPages} totalItems={groups.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
      </div>

      <Dialog open={isAddWarehouseOpen} onOpenChange={setIsAddWarehouseOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('inventory.warehouses.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('inventory.warehouses.nameLabel')}</label>
              <input
                value={newWarehouseName}
                onChange={e => setNewWarehouseName(e.target.value)}
                className={inputCls}
                placeholder={t('inventory.warehouses.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('inventory.warehouses.typeLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {CREATABLE_WAREHOUSE_TYPES.map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setNewWarehouseType(type)}
                    className={cn(
                      'flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors',
                      newWarehouseType === type
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
                    )}
                  >
                    {t(WAREHOUSE_TYPE_LABEL_KEYS[type])}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddWarehouseOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={createWarehouse} disabled={savingWarehouse || !newWarehouseName.trim()} loading={savingWarehouse}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteWarehouseTarget} onOpenChange={open => { if (!open) setDeleteWarehouseTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('inventory.warehouses.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-2">
            <p className="font-medium text-gray-900 dark:text-gray-100">{deleteWarehouseTarget?.name}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('inventory.warehouses.deleteConfirm')}</p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteWarehouseTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDeleteWarehouse}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
