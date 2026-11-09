'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AlertTriangle, ClipboardCheck, Eye, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { formatDateTime } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import {
  STOCK_COUNT_STATUS_LABEL_KEYS, STOCK_COUNT_STATUS_PILL, formatCountNumber, stockCountErrorKey,
  type StockCountItemRow, type StockCountRow, type StockCountStatus,
} from '@/lib/stock-counts'
import { branchStockErrorKey, eqBranch, useWarehouseScope } from '@/lib/branchStock'
import { useActiveBranchId } from '@/lib/session/useBranch'

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const thCls = 'px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap'
const pillGroup = 'flex items-center gap-0.5 rounded-lg bg-gray-100 dark:bg-gray-800 p-1'
const segCls = (active: boolean) => cn(
  'flex h-8 items-center justify-center rounded-md px-3 text-[12.5px] font-medium transition-colors',
  active
    ? 'bg-indigo-600 dark:bg-indigo-500 shadow-sm border border-indigo-600 dark:border-indigo-500 text-white'
    : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
)

type StatusFilter = 'all' | StockCountStatus
const STATUS_FILTERS: StatusFilter[] = ['all', 'draft', 'completed', 'cancelled']

interface WarehouseRow { id: string; name: string; branch_id: string | null }

// Branch errors (branch_forbidden...) first, then the stock-count codes.
function countErrorKey(message: string | undefined | null) {
  return branchStockErrorKey(message) ?? stockCountErrorKey(message)
}
type ItemAgg = Pick<StockCountItemRow, 'count_id' | 'counted_qty' | 'expected_qty' | 'purchase_price'>

interface Summary {
  counted: number
  shortQty: number
  shortSum: number
  surplusQty: number
  surplusSum: number
}

// stock_counts / stock_count_items are not in lib/database.types.ts yet, so
// those queries go through an untyped client view.
function db(): SupabaseClient {
  return createClient() as unknown as SupabaseClient
}

export default function InventarizatsiyaPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()

  const [counts, setCounts] = useState<StockCountRow[]>([])
  const [items, setItems] = useState<ItemAgg[]>([])
  const [allWarehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [loading, setLoading] = useState(true)
  const activeBranchId = useActiveBranchId()
  const { scope: scopeWarehouses, groupByBranch, label: warehouseLabel } = useWarehouseScope()
  // Pickers: only the active branch's warehouses (owner on "All": all).
  const warehouses = useMemo(() => groupByBranch(scopeWarehouses(allWarehouses)), [allWarehouses, scopeWarehouses, groupByBranch])
  const [filter, setFilter] = useState<StatusFilter>('all')

  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newWarehouseId, setNewWarehouseId] = useState('')
  const [newNote, setNewNote] = useState('')
  const [creating, setCreating] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<StockCountRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = db()
    const [countsRes, itemsRes, whRes] = await Promise.all([
      fetchAllRows<StockCountRow>((from, to) =>
        eqBranch(supabase.from('stock_counts')
          .select('id, number, warehouse_id, status, note, created_at, completed_at, zero_uncounted'), activeBranchId)
          .order('id').range(from, to)),
      fetchAllRows<ItemAgg>((from, to) =>
        supabase.from('stock_count_items')
          .select('count_id, counted_qty, expected_qty, purchase_price')
          .order('id').range(from, to)),
      supabase.from('warehouses').select('id, name, branch_id').order('created_at'),
    ])
    if (countsRes.error || itemsRes.error || whRes.error) toast.error(t('common.error'))
    else {
      setCounts([...countsRes.data].sort((a, b) => b.number - a.number))
      setItems(itemsRes.data)
      setWarehouses((whRes.data ?? []) as WarehouseRow[])
    }
    setLoading(false)
  }, [t, activeBranchId])

  useEffect(() => { load() }, [load])

  const warehouseName = useMemo(() => new Map(allWarehouses.map(w => [w.id, warehouseLabel(w)])), [allWarehouses, warehouseLabel])

  const summaries = useMemo(() => {
    const map = new Map<string, Summary>()
    for (const it of items) {
      let s = map.get(it.count_id)
      if (!s) { s = { counted: 0, shortQty: 0, shortSum: 0, surplusQty: 0, surplusSum: 0 }; map.set(it.count_id, s) }
      s.counted += 1
      if (it.expected_qty === null) continue
      const diff = it.counted_qty - it.expected_qty
      const price = Number(it.purchase_price ?? 0)
      if (diff < 0) { s.shortQty += -diff; s.shortSum += -diff * price }
      else if (diff > 0) { s.surplusQty += diff; s.surplusSum += diff * price }
    }
    return map
  }, [items])

  const filtered = useMemo(
    () => (filter === 'all' ? counts : counts.filter(c => c.status === filter)),
    [counts, filter],
  )

  // Only one draft per warehouse is allowed — surface it before the RPC fails.
  const existingDraft = newWarehouseId
    ? counts.find(c => c.warehouse_id === newWarehouseId && c.status === 'draft') ?? null
    : null

  function openCreate() {
    setNewWarehouseId(warehouses[0]?.id ?? '')
    setNewNote('')
    setIsCreateOpen(true)
  }

  async function createCount() {
    if (!newWarehouseId || existingDraft) return
    setCreating(true)
    const { data, error } = await db().rpc('create_stock_count', {
      p_warehouse_id: newWarehouseId,
      p_note: newNote.trim() || null,
    })
    setCreating(false)
    if (error || !data) {
      toast.error(t(countErrorKey(error?.message)))
      // Another user may have opened a draft meanwhile — refresh so the
      // dialog can offer to jump to it.
      if (error?.message.includes('Open count exists')) await load()
      return
    }
    setIsCreateOpen(false)
    toast.success(t('stockCount.createSuccess'))
    router.push(`/inventarizatsiya/${data as string}`)
  }

  async function executeDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const { error } = await db().rpc('delete_stock_count', { p_count_id: deleteTarget.id })
    setDeleting(false)
    if (error) {
      toast.error(t(countErrorKey(error.message)))
      return
    }
    const id = deleteTarget.id
    setCounts(prev => prev.filter(c => c.id !== id))
    setItems(prev => prev.filter(i => i.count_id !== id))
    setDeleteTarget(null)
    toast.success(t('stockCount.deleteSuccess'))
  }

  const pcs = t('stockCount.pcs')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('stockCount.title')}</h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('stockCount.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={loading || warehouses.length === 0}
          title={!loading && warehouses.length === 0 ? t('stockCount.noWarehouses') : undefined}
          className={cn(
            'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
            loading || warehouses.length === 0
              ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              : 'bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900',
          )}
        >
          <Plus className="h-4 w-4" />
          {t('stockCount.newCount')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className={pillGroup}>
          {STATUS_FILTERS.map(f => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={segCls(filter === f)}>
              {t(`stockCount.filters.${f}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
            <ClipboardCheck className="h-6 w-6 text-gray-300 dark:text-gray-600" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('stockCount.empty')}</p>
            {counts.length === 0 && (
              <p className="text-xs text-gray-400 dark:text-gray-500">{t('stockCount.emptySubtitle')}</p>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className={cn(thCls, 'text-left')}>{t('stockCount.table.number')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('stockCount.table.warehouse')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('stockCount.table.status')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('stockCount.table.counted')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('stockCount.table.shortage')}</th>
                    <th className={cn(thCls, 'text-right')}>{t('stockCount.table.surplus')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('stockCount.table.createdAt')}</th>
                    <th className={cn(thCls, 'text-center')}>{t('stockCount.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(c => {
                    const s = summaries.get(c.id)
                    const completed = c.status === 'completed'
                    const canDelete = c.status !== 'completed'
                    return (
                      <tr
                        key={c.id}
                        onClick={() => router.push(`/inventarizatsiya/${c.id}`)}
                        className="cursor-pointer border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono text-sm font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatCountNumber(c.number)}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                          {warehouseName.get(c.warehouse_id) ?? '—'}
                          {c.note && <p className="max-w-xs truncate text-xs text-gray-400 dark:text-gray-500">{c.note}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', STOCK_COUNT_STATUS_PILL[c.status])}>
                            {t(STOCK_COUNT_STATUS_LABEL_KEYS[c.status])}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-700 dark:text-gray-300">{s?.counted ?? 0}</td>
                        <td className="px-4 py-3 text-right text-sm tabular-nums whitespace-nowrap">
                          {completed && s && s.shortQty > 0 ? (
                            <div className="text-red-600 dark:text-red-400">
                              <p>-{s.shortQty} {pcs}</p>
                              <p className="text-xs">-{formatPrice(s.shortSum)}</p>
                            </div>
                          ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right text-sm tabular-nums whitespace-nowrap">
                          {completed && s && s.surplusQty > 0 ? (
                            <div className="text-emerald-600 dark:text-emerald-400">
                              <p>+{s.surplusQty} {pcs}</p>
                              <p className="text-xs">+{formatPrice(s.surplusSum)}</p>
                            </div>
                          ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-3 text-sm tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDateTime(c.created_at)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); router.push(`/inventarizatsiya/${c.id}`) }}
                              title={t('stockCount.view')}
                              aria-label={t('stockCount.view')}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            {canDelete && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setDeleteTarget(c) }}
                                title={t('stockCount.deleteTitle')}
                                aria-label={t('stockCount.deleteTitle')}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
              {filtered.length} / {counts.length} {t('stockCount.shownSuffix')}
            </div>
          </>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('stockCount.createTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('stockCount.warehouseLabel')}</label>
              <div className="flex flex-wrap gap-2">
                {warehouses.map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setNewWarehouseId(w.id)}
                    className={cn(
                      'h-9 min-w-[7rem] flex-1 rounded-lg border px-3 text-[13px] font-medium transition-colors',
                      newWarehouseId === w.id
                        ? 'bg-indigo-600 dark:bg-indigo-500 shadow-sm border-indigo-600 dark:border-indigo-500 text-white'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
                    )}
                  >
                    {warehouseLabel(w)}
                  </button>
                ))}
              </div>
            </div>
            {existingDraft && (
              <div className="space-y-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-500/10 px-3 py-2.5">
                <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('stockCount.openExists')}
                </p>
                <button
                  type="button"
                  onClick={() => { setIsCreateOpen(false); router.push(`/inventarizatsiya/${existingDraft.id}`) }}
                  className="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 underline-offset-4 hover:underline transition-colors"
                >
                  {t('stockCount.goToOpen')} — {formatCountNumber(existingDraft.number)}
                </button>
              </div>
            )}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('stockCount.noteLabel')}</label>
              <textarea
                rows={2}
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                placeholder={t('stockCount.notePlaceholder')}
                className={cn(inputCls, 'h-auto py-2 resize-none')}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={createCount}
              disabled={creating || !newWarehouseId || !!existingDraft}
              loading={creating}
            >
              {t('stockCount.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('stockCount.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-2">
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {deleteTarget && `${formatCountNumber(deleteTarget.number)} · ${warehouseName.get(deleteTarget.warehouse_id) ?? '—'}`}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('stockCount.deleteConfirm')}</p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDelete} disabled={deleting} loading={deleting}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
