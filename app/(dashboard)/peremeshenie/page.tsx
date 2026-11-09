'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, ArrowRight, Loader2, Minus, Plus, Search, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { monthToDate } from '@/components/reports/ReportKit'
import { branchAwareErrorKey, eitherBranchEnd, useWarehouseScope } from '@/lib/branchStock'

const PAGE_SIZE = 20

const fieldCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

interface Warehouse { id: string; name: string; branch_id: string | null }

interface TransferItem {
  id: string
  product_name: string
  category: string | null
  size: string
  color: string
  quantity: number
  purchase_price: number
}

interface Transfer {
  id: string
  number: number
  date: string
  from_warehouse_id: string
  to_warehouse_id: string
  note: string | null
  created_by_name: string | null
  created_at: string
  stock_transfer_items: TransferItem[]
}

interface StockRow {
  id: string
  productName: string
  size: string
  color: string
  barcode: string
  stock: number
  purchasePrice: number
}

const qtyOf = (tr: Transfer) => tr.stock_transfer_items.reduce((s, i) => s + i.quantity, 0)
const valueOf = (tr: Transfer) => tr.stock_transfer_items.reduce((s, i) => s + i.quantity * Number(i.purchase_price), 0)
const variantLabel = (color: string, size: string) => [color, size].filter(Boolean).join(' / ')

export default function PeremesheniePage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<Transfer | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const { scope: scopeWarehouses, groupByBranch, labelAlways, activeBranchId } = useWarehouseScope()
  // A transfer can cross branches, so names always carry the branch when
  // the company is multi-branch.
  const whName = useMemo(() => new Map(warehouses.map(w => [w.id, labelAlways(w)])), [warehouses, labelAlways])
  // Source = the active branch's warehouses; destination = every company
  // warehouse (grouped by branch when multi-branch).
  const sourceWarehouses = useMemo(() => groupByBranch(scopeWarehouses(warehouses)), [warehouses, scopeWarehouses, groupByBranch])
  const destWarehouses = useMemo(() => groupByBranch(warehouses, true), [warehouses, groupByBranch])

  useEffect(() => {
    createClient().from('warehouses').select('id, name, branch_id').order('created_at').then(({ data }) => setWarehouses((data ?? []) as Warehouse[]))
  }, [])

  const loadTransfers = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    let q = eitherBranchEnd(supabase.from('stock_transfers')
      .select('id, number, date, from_warehouse_id, to_warehouse_id, note, created_by_name, created_at, stock_transfer_items(id, product_name, category, size, color, quantity, purchase_price)'), activeBranchId)
      .order('number', { ascending: false })
    if (range) q = q.gte('date', range.from).lte('date', range.to)
    const { data, error } = await q
    if (error) toast.error(t('common.error'))
    setTransfers((data ?? []) as unknown as Transfer[])
    setPage(1)
    setLoading(false)
  }, [range, t, activeBranchId])

  useEffect(() => { loadTransfers() }, [loadTransfers])

  const totalPages = Math.max(1, Math.ceil(transfers.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = transfers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('transfers.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('transfers.subtitle')}</p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <Plus className="h-4 w-4" /> {t('transfers.newTransfer')}
        </button>
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} />
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
        ) : transfers.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
            <ArrowLeftRight className="h-6 w-6" />
            {t('transfers.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3 text-left font-medium">{t('transfers.number')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('transfers.date')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('transfers.route')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('transfers.items')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('transfers.qty')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('transfers.value')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('transfers.author')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('transfers.note')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(tr => (
                  <tr key={tr.id} onClick={() => setDetail(tr)} className="cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100">#{tr.number}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(tr.date)}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-gray-900 dark:text-gray-100">
                        {whName.get(tr.from_warehouse_id) ?? '—'}
                        <ArrowRight className="h-3.5 w-3.5 text-gray-400" />
                        {whName.get(tr.to_warehouse_id) ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{tr.stock_transfer_items.length}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{qtyOf(tr)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(valueOf(tr))}</td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{tr.created_by_name ?? '—'}</td>
                    <td className="px-4 py-2.5 max-w-[220px] truncate text-gray-500 dark:text-gray-400">{tr.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {transfers.length > 0 && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={transfers.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}

      <TransferDetailDialog transfer={detail} whName={whName} onClose={() => setDetail(null)} />

      <CreateTransferDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        sourceWarehouses={sourceWarehouses}
        warehouses={destWarehouses}
        warehouseLabel={labelAlways}
        onCreated={() => { setCreateOpen(false); loadTransfers() }}
      />
    </div>
  )
}

function TransferDetailDialog({ transfer, whName, onClose }: { transfer: Transfer | null; whName: Map<string, string>; onClose: () => void }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  return (
    <Dialog open={transfer !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('transfers.details')} #{transfer?.number}</DialogTitle>
        </DialogHeader>
        {transfer && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
                {whName.get(transfer.from_warehouse_id) ?? '—'}
                <ArrowRight className="h-3.5 w-3.5 text-gray-400" />
                {whName.get(transfer.to_warehouse_id) ?? '—'}
              </span>
              <span className="text-gray-500 dark:text-gray-400">{formatDateTime(transfer.created_at)}</span>
              {transfer.created_by_name && <span className="text-gray-500 dark:text-gray-400">{transfer.created_by_name}</span>}
            </div>
            {transfer.note && <p className="text-sm text-gray-600 dark:text-gray-400">{transfer.note}</p>}
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2 text-left font-medium">{t('transfers.product')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('transfers.qty')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('transfers.value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {transfer.stock_transfer_items.map(i => (
                    <tr key={i.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-3 py-2">
                        <p className="text-gray-900 dark:text-gray-100">{i.product_name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{variantLabel(i.color, i.size)}</p>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{i.quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatPrice(i.quantity * Number(i.purchase_price))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    <td className="px-3 py-2">{t('reportsKit.total')}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{qtyOf(transfer)}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatPrice(valueOf(transfer))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CreateTransferDialog({
  open, onOpenChange, sourceWarehouses, warehouses, warehouseLabel, onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Warehouses the user may send from (active branch). */
  sourceWarehouses: Warehouse[]
  /** Every company warehouse (destination). */
  warehouses: Warehouse[]
  warehouseLabel: (w: Warehouse) => string
  onCreated: () => void
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [date, setDate] = useState(localYmd())
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<StockRow[]>([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [selected, setSelected] = useState<Map<string, number>>(new Map())
  const [submitting, setSubmitting] = useState(false)

  // Reset whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    const from = sourceWarehouses[0]?.id ?? ''
    setFromId(from)
    setToId(warehouses.find(w => w.id !== from)?.id ?? '')
    setDate(localYmd())
    setNote('')
    setSearch('')
    setSelected(new Map())
  }, [open, warehouses, sourceWarehouses])

  // Stock of the source warehouse.
  useEffect(() => {
    if (!open || !fromId) { setRows([]); return }
    let cancelled = false
    ;(async () => {
      setLoadingRows(true)
      const supabase = createClient()
      const [sizesRes, productsRes] = await Promise.all([
        fetchAllRows<{ id: string; product_id: string; size: string; color: string; barcode: string | null; stock: number; purchase_price: number | null }>((from, to) =>
          supabase.from('product_sizes').select('id, product_id, size, color, barcode, stock, purchase_price')
            .eq('warehouse_id', fromId).gt('stock', 0).order('id').range(from, to)),
        fetchAllRows<{ id: string; name: string }>((from, to) =>
          supabase.from('products').select('id, name').order('id').range(from, to)),
      ])
      if (cancelled) return
      const names = new Map(productsRes.data.map(p => [p.id, p.name]))
      setRows(sizesRes.data
        .map(s => ({
          id: s.id,
          productName: names.get(s.product_id) ?? '—',
          size: s.size,
          color: s.color ?? '',
          barcode: s.barcode ?? '',
          stock: Number(s.stock),
          purchasePrice: Number(s.purchase_price ?? 0),
        }))
        .sort((a, b) => a.productName.localeCompare(b.productName) || a.size.localeCompare(b.size)))
      setSelected(new Map())
      setLoadingRows(false)
    })()
    return () => { cancelled = true }
  }, [open, fromId])

  const rowById = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? rows.filter(r => r.productName.toLowerCase().includes(q) || r.size.toLowerCase().includes(q) || r.color.toLowerCase().includes(q) || r.barcode.includes(q))
      : rows
    return list.slice(0, 100)
  }, [rows, search])

  const selectedList = useMemo(
    () => Array.from(selected.entries()).map(([id, qty]) => ({ row: rowById.get(id)!, qty })).filter(x => x.row),
    [selected, rowById],
  )
  const totalQty = selectedList.reduce((s, x) => s + x.qty, 0)
  const totalValue = selectedList.reduce((s, x) => s + x.qty * x.row.purchasePrice, 0)

  function setQty(id: string, qty: number) {
    const row = rowById.get(id)
    if (!row) return
    setSelected(prev => {
      const next = new Map(prev)
      if (qty <= 0) next.delete(id)
      else next.set(id, Math.min(qty, row.stock))
      return next
    })
  }

  async function submit() {
    if (!fromId || !toId || fromId === toId) { toast.error(t('transfers.sameWarehouse')); return }
    if (selectedList.length === 0) { toast.error(t('transfers.noItems')); return }
    setSubmitting(true)
    const { error } = await createClient().rpc('create_stock_transfer', {
      p_from_warehouse_id: fromId,
      p_to_warehouse_id: toId,
      p_items: selectedList.map(x => ({ product_size_id: x.row.id, quantity: x.qty })),
      p_note: note.trim() || null,
      p_date: date,
    })
    setSubmitting(false)
    if (error) {
      if (error.message.includes('Insufficient stock')) toast.error(t('transfers.insufficient'))
      else toast.error(t(branchAwareErrorKey(error.message)))
      return
    }
    toast.success(t('transfers.success'))
    onCreated()
  }

  const tooFewWarehouses = warehouses.length < 2 || sourceWarehouses.length === 0
  // Swapping only makes sense when the destination is also a valid source.
  const canSwap = sourceWarehouses.some(w => w.id === toId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('transfers.newTransfer')}</DialogTitle>
        </DialogHeader>

        {tooFewWarehouses ? (
          <p className="py-6 text-sm text-gray-500 dark:text-gray-400">{t('transfers.needTwoWarehouses')}</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] items-end gap-3">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('transfers.from')}</span>
                <select value={fromId} onChange={e => setFromId(e.target.value)} className={fieldCls}>
                  {sourceWarehouses.map(w => <option key={w.id} value={w.id}>{warehouseLabel(w)}</option>)}
                </select>
              </label>
              <button
                type="button"
                onClick={() => { if (canSwap) { setFromId(toId); setToId(fromId) } }}
                disabled={!canSwap}
                className="hidden sm:flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors disabled:opacity-40 disabled:hover:text-gray-400"
                aria-label="swap"
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('transfers.to')}</span>
                <select value={toId} onChange={e => setToId(e.target.value)} className={cn(fieldCls, fromId === toId && 'border-red-300 dark:border-red-800')}>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{warehouseLabel(w)}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('transfers.date')}</span>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} className={fieldCls} />
              </label>
            </div>
            {fromId === toId && <p className="text-xs text-red-600 dark:text-red-400">{t('transfers.sameWarehouse')}</p>}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Source stock */}
              <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
                <div className="relative border-b border-gray-100 dark:border-gray-800 p-2">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('transfers.searchProduct')} className={cn(fieldCls, 'pl-8')} />
                </div>
                <div className="h-[320px] overflow-y-auto">
                  {loadingRows ? (
                    <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
                  ) : filtered.length === 0 ? (
                    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-400 dark:text-gray-500">{t('transfers.noStock')}</div>
                  ) : filtered.map(r => {
                    const inCart = selected.get(r.id) ?? 0
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
                          <p className="text-xs text-gray-400 dark:text-gray-500">{variantLabel(r.color, r.size)}</p>
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

              {/* Selected */}
              <div className="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden flex flex-col">
                <div className="border-b border-gray-100 dark:border-gray-800 px-3 py-2.5 text-[13px] font-medium text-gray-700 dark:text-gray-300">
                  {t('transfers.selected')} {selectedList.length > 0 && <span className="text-gray-400">({selectedList.length})</span>}
                </div>
                <div className="h-[280px] overflow-y-auto">
                  {selectedList.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('transfers.addHint')}</div>
                  ) : selectedList.map(({ row, qty }) => (
                    <div key={row.id} className="flex items-center justify-between gap-2 border-b border-gray-50 dark:border-gray-800/60 px-3 py-2 last:border-0">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-gray-900 dark:text-gray-100">{row.productName}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{variantLabel(row.color, row.size)} · {t('transfers.available')}: {row.stock}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => setQty(row.id, qty - 1)} className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"><Minus className="h-3.5 w-3.5" /></button>
                        <input
                          type="number"
                          min={1}
                          max={row.stock}
                          value={qty}
                          onChange={e => setQty(row.id, Math.floor(Number(e.target.value) || 0))}
                          className="h-7 w-14 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-center text-sm tabular-nums text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500"
                        />
                        <button type="button" onClick={() => setQty(row.id, qty + 1)} disabled={qty >= row.stock} className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-40 transition-colors"><Plus className="h-3.5 w-3.5" /></button>
                        <button type="button" onClick={() => setQty(row.id, 0)} aria-label={t('transfers.remove')} className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                  <span>{t('reportsKit.total')}: {totalQty}</span>
                  <span className="tabular-nums">{formatPrice(totalValue)}</span>
                </div>
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('transfers.note')}</span>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder={t('transfers.notePlaceholder')} className={fieldCls} />
            </label>
          </div>
        )}

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('transfers.cancel')}</Button>
          {!tooFewWarehouses && (
            <Button onClick={submit} disabled={submitting || selectedList.length === 0 || fromId === toId} loading={submitting}>
              {t('transfers.submit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
