'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, BarChart3, Box, Loader2, Pencil, Warehouse } from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { sortSizes } from '@/lib/sizes'
import { WAREHOUSE_TYPE_LABEL_KEYS, type WarehouseType } from '@/lib/warehouses'
import { EditWarehouseDialog, type EditableWarehouse } from '@/components/omborlar/EditWarehouseDialog'

const thCls = 'px-3 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap'

interface WarehouseRow { id: string; name: string; type: WarehouseType; created_at: string }
interface SizeRow {
  id: string; product_id: string; size: string; color: string; stock: number
  purchase_price: number | null
}
interface ProductRow { id: string; name: string; sku: string | null; min_stock: number }

interface Line {
  id: string
  name: string
  variant: string
  sku: string
  stock: number
  minStock: number
  price: number
}

function formatDmy(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

export default function WarehouseDetailPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const params = useParams<{ id: string }>()
  const id = params.id

  const [warehouse, setWarehouse] = useState<WarehouseRow | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<EditableWarehouse | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const supabase = createClient()
      const { data: whData } = await supabase
        .from('warehouses').select('id, name, type, created_at').eq('id', id).maybeSingle()
      if (cancelled) return
      if (!whData) {
        // Missing, not in this company (RLS), or a malformed id — all render as "not found".
        setWarehouse(null)
        setLoading(false)
        return
      }
      const [sizesRes, productsRes] = await Promise.all([
        fetchAllRows<SizeRow>((from, to) =>
          supabase.from('product_sizes')
            .select('id, product_id, size, color, stock, purchase_price')
            .eq('warehouse_id', id).order('id').range(from, to)),
        fetchAllRows<ProductRow>((from, to) =>
          supabase.from('products').select('id, name, sku, min_stock').order('id').range(from, to)),
      ])
      if (cancelled) return
      if (sizesRes.error || productsRes.error) toast.error(t('common.error'))

      const productMap = new Map(productsRes.data.map(p => [p.id, p]))
      const sizeRank = new Map(sortSizes(Array.from(new Set(sizesRes.data.map(s => s.size)))).map((s, i) => [s, i]))
      const mapped = sizesRes.data.map(sz => {
        const p = productMap.get(sz.product_id)
        return {
          id: sz.id,
          name: p?.name ?? '—',
          variant: [sz.color, sz.size].filter(Boolean).join(' / '),
          size: sz.size,
          sku: p?.sku ?? '',
          stock: sz.stock,
          minStock: p?.min_stock ?? 0,
          price: Number(sz.purchase_price ?? 0),
        }
      })
      mapped.sort((a, b) =>
        a.name.localeCompare(b.name)
        || (sizeRank.get(a.size) ?? 0) - (sizeRank.get(b.size) ?? 0)
        || a.variant.localeCompare(b.variant))

      setWarehouse(whData as WarehouseRow)
      setLines(mapped)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [id, t])

  const totalSum = lines.reduce((acc, l) => acc + l.stock * l.price, 0)
  const pcs = t('warehouses.detail.pcs')

  if (!loading && !warehouse) {
    return (
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm px-4 py-16 flex flex-col items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
        <Warehouse className="h-6 w-6 text-gray-300 dark:text-gray-600" />
        <p className="font-medium text-gray-900 dark:text-gray-100">{t('warehouses.notFound')}</p>
        <Link href="/omborlar" className="inline-flex items-center gap-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4" />{t('warehouses.backToList')}
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/omborlar"
            aria-label={t('warehouses.backToList')}
            title={t('warehouses.backToList')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 truncate">
            {warehouse?.name ?? t('common.loading')}
          </h1>
          {warehouse && (
            <span className="shrink-0 rounded-full bg-green-100 dark:bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
              {t('warehouses.status.active')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/kirim"
            className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <BarChart3 className="h-4 w-4 text-gray-400" />
            {t('warehouses.detail.history')}
          </Link>
          <button
            type="button"
            onClick={() => warehouse && setEditing(warehouse)}
            disabled={!warehouse}
            className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white px-4 py-2 text-sm font-medium text-white dark:text-slate-900 transition-colors disabled:opacity-50"
          >
            <Pencil className="h-4 w-4" />
            {t('warehouses.edit')}
          </button>
        </div>
      </div>

      {/* Details */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('warehouses.detail.details')}</p>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('warehouses.table.name')}</p>
            <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">{warehouse?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('inventory.warehouses.typeLabel')}</p>
            <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
              {warehouse ? t(WAREHOUSE_TYPE_LABEL_KEYS[warehouse.type] ?? 'warehouseTypes.other') : '—'}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('warehouses.createdAt')}</p>
            <p className="mt-0.5 text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100">
              {warehouse ? formatDmy(warehouse.created_at) : '—'}
            </p>
          </div>
        </div>
      </div>

      {/* SKU table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 text-gray-400" />
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('warehouses.detail.skuTitle')}</p>
          {!loading && lines.length > 0 && (
            <span className="rounded-md bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">{lines.length}</span>
          )}
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-gray-100 dark:border-gray-800">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
            </div>
          ) : lines.length === 0 ? (
            <div className="px-4 py-16 text-center text-sm text-gray-400 dark:text-gray-500">{t('warehouses.detail.empty')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className={cn(thCls, 'text-left')}>{t('warehouses.detail.table.name')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('warehouses.detail.table.sku')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('warehouses.detail.table.quantity')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('warehouses.detail.table.price')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('warehouses.detail.table.sum')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(l => {
                    const out = l.stock <= 0
                    const low = !out && l.stock <= l.minStock
                    return (
                      <tr
                        key={l.id}
                        className={cn(
                          'border-b border-gray-100 dark:border-gray-800 text-sm transition-colors',
                          out ? 'bg-red-50 dark:bg-red-500/10'
                            : low ? 'bg-amber-50 dark:bg-amber-500/10'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-800/60',
                        )}
                      >
                        <td className="px-3 py-2.5 text-gray-900 dark:text-gray-100">
                          {l.name}
                          {l.variant && <span className="text-gray-400 dark:text-gray-500"> · {l.variant}</span>}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{l.sku || '—'}</td>
                        <td className={cn(
                          'px-3 py-2.5 text-right tabular-nums whitespace-nowrap',
                          out ? 'text-red-600 dark:text-red-400'
                            : low ? 'text-amber-600 dark:text-amber-400'
                              : 'text-gray-900 dark:text-gray-100',
                        )}>
                          {l.stock} {pcs}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300">{formatPrice(l.price)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{formatPrice(l.stock * l.price)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm font-semibold text-gray-900 dark:text-gray-100">
                    <td colSpan={4} className="px-3 py-3">{t('warehouses.detail.total')}</td>
                    <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(totalSum)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      <EditWarehouseDialog
        warehouse={editing}
        onOpenChange={open => { if (!open) setEditing(null) }}
        onSaved={u => setWarehouse(prev => (prev ? { ...prev, name: u.name, type: u.type } : prev))}
      />
    </div>
  )
}
