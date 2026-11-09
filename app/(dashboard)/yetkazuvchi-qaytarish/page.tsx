'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Minus, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SearchSelect } from '@/components/ui/SearchSelect'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { ReportHeader, monthToDate } from '@/components/reports/ReportKit'
import { supplierFieldCls } from '@/components/suppliers/SupplierDialogs'
import { fetchSuppliers, returnValue, supplierErrorKey, type Supplier } from '@/lib/suppliers'
import { branchStockErrorKey, eqBranch, useWarehouseScope } from '@/lib/branchStock'

interface ReturnItem { id: string; product_name: string; size: string; color: string; quantity: number; price: number }
interface ReturnRow {
  id: string
  number: number
  date: string
  supplier_id: string
  warehouse_id: string
  note: string | null
  created_by_name: string | null
  supplier_return_items: ReturnItem[]
}
interface Warehouse { id: string; name: string; branch_id: string | null }

// Branch errors (branch_forbidden...) first, then the supplier codes.
const returnErrorKey = (message: string | undefined | null) => branchStockErrorKey(message) ?? supplierErrorKey(message ?? '')
interface StockRow { id: string; productName: string; size: string; color: string; barcode: string; stock: number; purchasePrice: number }

const variantLabel = (color: string, size: string) => [color, size].filter(Boolean).join(' / ')
const labelCls = 'mb-1 block text-[13px] font-medium text-gray-700 dark:text-gray-300'

export default function SupplierReturnsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [loading, setLoading] = useState(true)
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const { scope: scopeWarehouses, groupByBranch, label: warehouseLabel, labelAlways, activeBranchId } = useWarehouseScope()
  const branchWarehouses = useMemo(() => groupByBranch(scopeWarehouses(warehouses)), [warehouses, scopeWarehouses, groupByBranch])

  useEffect(() => {
    const supabase = createClient()
    fetchSuppliers(supabase).then(setSuppliers)
    supabase.from('warehouses').select('id, name, branch_id').order('created_at').then(({ data }) => setWarehouses((data ?? []) as Warehouse[]))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    let q = eqBranch(createClient().from('supplier_returns')
      .select('id, number, date, supplier_id, warehouse_id, note, created_by_name, supplier_return_items(id, product_name, size, color, quantity, price)'), activeBranchId)
      .order('number', { ascending: false })
    if (range) q = q.gte('date', range.from).lte('date', range.to)
    const { data } = await q
    setReturns((data ?? []) as unknown as ReturnRow[])
    setLoading(false)
  }, [range, activeBranchId])
  useEffect(() => { load() }, [load])

  const supplierName = useMemo(() => new Map(suppliers.map(s => [s.id, s.name])), [suppliers])
  const whName = useMemo(() => new Map(warehouses.map(w => [w.id, labelAlways(w)])), [warehouses, labelAlways])
  const total = useMemo(() => returns.reduce((s, r) => s + returnValue(r.supplier_return_items), 0), [returns])

  async function cancelReturn(r: ReturnRow) {
    if (!window.confirm(t('suppliersPage.returnDeleteConfirm'))) return
    const { error } = await createClient().rpc('delete_supplier_return', { p_id: r.id })
    if (error) { toast.error(t(returnErrorKey(error.message))); return }
    toast.success(t('suppliersPage.returnDeleted'))
    load()
  }

  return (
    <div className="space-y-6">
      <ReportHeader title={t('suppliersPage.returnsTitle')} subtitle={t('suppliersPage.returnsSubtitle')} range={range} onRangeChange={setRange} exportLabel={t('reportsKit.export')}>
        <button
          onClick={() => setCreateOpen(true)}
          className="sm:ml-auto flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <Plus className="h-4 w-4" /> {t('suppliersPage.newReturn')}
        </button>
      </ReportHeader>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
        ) : returns.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
            <RotateCcw className="h-6 w-6" />
            {t('suppliersPage.noReturnsList')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3 text-left font-medium">{t('transfers.number')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.date')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.supplier')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.warehouse')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.product')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.qty')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.sum')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {returns.map(r => (
                  <tr key={r.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 align-top">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100">#{r.number}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(r.date)}</td>
                    <td className="px-4 py-2.5">
                      <Link href={`/yetkazuvchilar/${r.supplier_id}`} className="text-gray-900 dark:text-gray-100 hover:underline">{supplierName.get(r.supplier_id) ?? '—'}</Link>
                      {r.note && <p className="text-xs text-gray-400 dark:text-gray-500">{r.note}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{whName.get(r.warehouse_id) ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      {r.supplier_return_items.map(i => (
                        <p key={i.id} className="text-gray-900 dark:text-gray-100">
                          {i.product_name} <span className="text-xs text-gray-400 dark:text-gray-500">{variantLabel(i.color, i.size)} × {i.quantity}</span>
                        </p>
                      ))}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.supplier_return_items.reduce((s, i) => s + i.quantity, 0)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(returnValue(r.supplier_return_items))}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => cancelReturn(r)} aria-label={t('suppliersPage.delete')} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                  <td className="px-4 py-3" colSpan={6}>{t('reportsKit.total')}</td>
                  <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <CreateReturnDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        suppliers={suppliers.filter(s => s.isActive)}
        warehouses={branchWarehouses}
        warehouseLabel={warehouseLabel}
        onCreated={() => { setCreateOpen(false); load() }}
      />
    </div>
  )
}

function CreateReturnDialog({
  open, onOpenChange, suppliers, warehouses, warehouseLabel, onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suppliers: Supplier[]
  warehouses: Warehouse[]
  warehouseLabel: (w: Warehouse) => string
  onCreated: () => void
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [supplierId, setSupplierId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [date, setDate] = useState(localYmd())
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<StockRow[]>([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [selected, setSelected] = useState<Map<string, { qty: number; price: number }>>(new Map())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setSupplierId('')
    setWarehouseId(warehouses[0]?.id ?? '')
    setDate(localYmd())
    setNote('')
    setSearch('')
    setSelected(new Map())
  }, [open, warehouses])

  useEffect(() => {
    if (!open || !warehouseId) { setRows([]); return }
    let cancelled = false
    ;(async () => {
      setLoadingRows(true)
      const supabase = createClient()
      const [sizesRes, productsRes] = await Promise.all([
        fetchAllRows<{ id: string; product_id: string; size: string; color: string; barcode: string | null; stock: number; purchase_price: number | null }>((from, to) =>
          supabase.from('product_sizes').select('id, product_id, size, color, barcode, stock, purchase_price')
            .eq('warehouse_id', warehouseId).gt('stock', 0).order('id').range(from, to)),
        fetchAllRows<{ id: string; name: string }>((from, to) => supabase.from('products').select('id, name').order('id').range(from, to)),
      ])
      if (cancelled) return
      const names = new Map(productsRes.data.map(p => [p.id, p.name]))
      setRows(sizesRes.data.map(s => ({
        id: s.id, productName: names.get(s.product_id) ?? '—', size: s.size, color: s.color ?? '',
        barcode: s.barcode ?? '', stock: Number(s.stock), purchasePrice: Number(s.purchase_price ?? 0),
      })).sort((a, b) => a.productName.localeCompare(b.productName) || a.size.localeCompare(b.size)))
      setSelected(new Map())
      setLoadingRows(false)
    })()
    return () => { cancelled = true }
  }, [open, warehouseId])

  const rowById = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (q ? rows.filter(r => r.productName.toLowerCase().includes(q) || r.size.toLowerCase().includes(q) || r.color.toLowerCase().includes(q) || r.barcode.includes(q)) : rows).slice(0, 100)
  }, [rows, search])

  const selectedList = useMemo(
    () => Array.from(selected.entries()).map(([id, v]) => ({ row: rowById.get(id)!, ...v })).filter(x => x.row),
    [selected, rowById],
  )
  const totalValue = selectedList.reduce((s, x) => s + x.qty * x.price, 0)

  function setQty(id: string, qty: number) {
    const row = rowById.get(id)
    if (!row) return
    setSelected(prev => {
      const next = new Map(prev)
      if (qty <= 0) next.delete(id)
      else next.set(id, { qty: Math.min(qty, row.stock), price: prev.get(id)?.price ?? row.purchasePrice })
      return next
    })
  }
  function setPrice(id: string, price: number) {
    setSelected(prev => {
      const cur = prev.get(id)
      if (!cur) return prev
      const next = new Map(prev)
      next.set(id, { ...cur, price: Math.max(0, price) })
      return next
    })
  }

  async function submit() {
    if (!supplierId) { toast.error(t('suppliersPage.selectSupplierFirst')); return }
    if (selectedList.length === 0) { toast.error(t('transfers.noItems')); return }
    setSubmitting(true)
    const { error } = await createClient().rpc('create_supplier_return', {
      p_supplier_id: supplierId,
      p_warehouse_id: warehouseId,
      p_items: selectedList.map(x => ({ product_size_id: x.row.id, quantity: x.qty, price: x.price })),
      p_note: note.trim() || null,
      p_date: date,
    })
    setSubmitting(false)
    if (error) {
      if (error.message.includes('Insufficient stock')) toast.error(t('transfers.insufficient'))
      else toast.error(t(returnErrorKey(error.message)))
      return
    }
    toast.success(t('suppliersPage.returnSaved'))
    onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('suppliersPage.newReturn')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <span className={labelCls}>{t('suppliersPage.supplier')} *</span>
              <SearchSelect
                options={suppliers.map(s => ({ value: s.id, label: s.name, sublabel: s.phone || undefined }))}
                value={supplierId}
                onChange={setSupplierId}
                placeholder={t('suppliersPage.select')}
              />
            </div>
            <label className="block">
              <span className={labelCls}>{t('suppliersPage.warehouse')}</span>
              <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={supplierFieldCls}>
                {warehouses.map(w => <option key={w.id} value={w.id}>{warehouseLabel(w)}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls}>{t('suppliersPage.date')}</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className={supplierFieldCls} />
            </label>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
              <div className="relative border-b border-gray-100 dark:border-gray-800 p-2">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('transfers.searchProduct')} className={cn(supplierFieldCls, 'pl-8')} />
              </div>
              <div className="h-[320px] overflow-y-auto">
                {loadingRows ? (
                  <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
                ) : filtered.length === 0 ? (
                  <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-400 dark:text-gray-500">{t('transfers.noStock')}</div>
                ) : filtered.map(r => {
                  const inCart = selected.get(r.id)?.qty ?? 0
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setQty(r.id, inCart + 1)}
                      disabled={inCart >= r.stock}
                      className="flex w-full items-center justify-between gap-3 border-b border-gray-50 dark:border-gray-800/60 px-3 py-2 text-left last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 disabled:opacity-50 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-gray-900 dark:text-gray-100">{r.productName}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{variantLabel(r.color, r.size)} · {formatPrice(r.purchasePrice)}</p>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                        {inCart > 0 && <span className="mr-1 font-medium text-gray-900 dark:text-gray-100">{inCart} /</span>}
                        {r.stock}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden flex flex-col">
              <div className="border-b border-gray-100 dark:border-gray-800 px-3 py-2.5 text-[13px] font-medium text-gray-700 dark:text-gray-300">
                {t('transfers.selected')} {selectedList.length > 0 && <span className="text-gray-400">({selectedList.length})</span>}
              </div>
              <div className="h-[280px] overflow-y-auto">
                {selectedList.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('transfers.addHint')}</div>
                ) : selectedList.map(({ row, qty, price }) => (
                  <div key={row.id} className="border-b border-gray-50 dark:border-gray-800/60 px-3 py-2 last:border-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-gray-900 dark:text-gray-100">{row.productName}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{variantLabel(row.color, row.size)} · {t('transfers.available')}: {row.stock}</p>
                      </div>
                      <button type="button" onClick={() => setQty(row.id, 0)} aria-label={t('transfers.remove')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"><X className="h-3.5 w-3.5" /></button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <button type="button" onClick={() => setQty(row.id, qty - 1)} className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"><Minus className="h-3.5 w-3.5" /></button>
                      <input type="number" min={1} max={row.stock} value={qty} onChange={e => setQty(row.id, Math.floor(Number(e.target.value) || 0))}
                        className="h-7 w-14 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-center text-sm tabular-nums text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500" />
                      <button type="button" onClick={() => setQty(row.id, qty + 1)} disabled={qty >= row.stock} className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-40 transition-colors"><Plus className="h-3.5 w-3.5" /></button>
                      <span className="ml-2 text-xs text-gray-400">×</span>
                      <input type="number" min={0} value={price} onChange={e => setPrice(row.id, Number(e.target.value) || 0)} title={t('suppliersPage.returnPriceHint')}
                        className="h-7 w-28 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500" />
                      <span className="ml-auto text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(qty * price)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <span>{t('reportsKit.total')}: {selectedList.reduce((s, x) => s + x.qty, 0)}</span>
                <span className="tabular-nums">{formatPrice(totalValue)}</span>
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500">{t('suppliersPage.returnPriceHint')}</p>

          <label className="block">
            <span className={labelCls}>{t('suppliersPage.note')}</span>
            <input value={note} onChange={e => setNote(e.target.value)} className={supplierFieldCls} />
          </label>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('suppliersPage.cancel')}</Button>
          <Button onClick={submit} disabled={submitting || selectedList.length === 0 || !supplierId} loading={submitting}>{t('suppliersPage.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
