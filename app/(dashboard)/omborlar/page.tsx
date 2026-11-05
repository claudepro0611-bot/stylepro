'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Eye, Loader2, Pencil, Plus, Trash2, Warehouse } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { WAREHOUSE_TYPE_LABEL_KEYS, CREATABLE_WAREHOUSE_TYPES, type WarehouseType } from '@/lib/warehouses'
import { EditWarehouseDialog, type EditableWarehouse } from '@/components/omborlar/EditWarehouseDialog'

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const thCls = 'px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400'

interface WarehouseRow { id: string; name: string; type: WarehouseType; created_at: string }
interface SizeRow { warehouse_id: string }

function formatDmy(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

export default function OmborlarPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [sizeRows, setSizeRows] = useState<SizeRow[]>([])
  const [warehouseLimit, setWarehouseLimit] = useState(2)
  const [loading, setLoading] = useState(true)

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<WarehouseType>('clothing')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<WarehouseRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState<EditableWarehouse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [
      { data: whData, error: whErr },
      { data: sizeData, error: sizeErr },
      { data: companyData },
    ] = await Promise.all([
      supabase.from('warehouses').select('id, name, type, created_at').order('created_at'),
      fetchAllRows<SizeRow>((from, to) =>
        supabase.from('product_sizes').select('warehouse_id').order('id').range(from, to)),
      supabase.from('companies').select('warehouse_limit').single(),
    ])
    if (whErr || sizeErr) toast.error(t('common.error'))
    else {
      setWarehouses(whData as WarehouseRow[])
      setSizeRows(sizeData)
      setWarehouseLimit((companyData as { warehouse_limit: number } | null)?.warehouse_limit ?? 2)
    }
    setLoading(false)
  }, [t])

  useEffect(() => { load() }, [load])

  // Row existence (not stock quantity) blocks deletion — same rule as the
  // inventory page: product_sizes.warehouse_id has no ON DELETE clause.
  const refCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const sz of sizeRows) {
      if (sz.warehouse_id) map.set(sz.warehouse_id, (map.get(sz.warehouse_id) ?? 0) + 1)
    }
    return map
  }, [sizeRows])

  const limitReached = warehouses.length >= warehouseLimit

  function openAdd() {
    setNewName('')
    setNewType('clothing')
    setIsAddOpen(true)
  }

  async function createWarehouse() {
    if (!newName.trim() || limitReached) return
    setSaving(true)
    const supabase = createClient()
    const { data, error } = await supabase.rpc('create_warehouse', {
      p_name: newName.trim(),
      p_type: newType,
    })
    setSaving(false)
    if (error || !data) {
      toast.error(error?.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    setIsAddOpen(false)
    toast.success(t('inventory.warehouses.addSuccess'))
    load()
  }

  async function executeDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_warehouse', { p_id: deleteTarget.id })
    setDeleting(false)
    if (error) {
      if (error.message.includes('forbidden')) toast.error(t('common.forbidden'))
      else if (error.message.includes('linked product size')) toast.error(t('inventory.warehouses.deleteBlockedTooltip'))
      else toast.error(t('common.error'))
      return
    }
    const deletedId = deleteTarget.id
    setWarehouses(prev => prev.filter(w => w.id !== deletedId))
    setDeleteTarget(null)
    toast.success(t('inventory.warehouses.deleteSuccess'))
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('warehouses.title')}</h1>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={openAdd}
          disabled={loading || limitReached}
          className={cn(
            'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
            loading || limitReached
              ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              : 'bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900',
          )}
        >
          <Plus className="h-4 w-4" />
          {t('warehouses.addNew')}
        </button>
        <span className="rounded-lg bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-xs font-medium tabular-nums text-gray-600 dark:text-gray-400">
          {warehouses.length}/{warehouseLimit}
        </span>
      </div>

      {!loading && limitReached && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('inventory.warehouses.limitReached')}
        </div>
      )}

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
          </div>
        ) : warehouses.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-sm text-gray-400 dark:text-gray-500">
            <Warehouse className="h-6 w-6 text-gray-300 dark:text-gray-600" />
            {t('warehouses.empty')}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className={cn(thCls, 'text-left')}>{t('warehouses.table.name')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('warehouses.table.status')}</th>
                    <th className={cn(thCls, 'text-left')}>{t('warehouses.table.createdAt')}</th>
                    <th className={cn(thCls, 'text-center')}>{t('warehouses.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouses.map(w => {
                    const canDelete = (refCount.get(w.id) ?? 0) === 0
                    return (
                      <tr
                        key={w.id}
                        onClick={() => router.push(`/omborlar/${w.id}`)}
                        className="cursor-pointer border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex w-9 h-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
                              <Warehouse className="h-4 w-4 text-gray-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{w.name}</p>
                              <p className="text-xs text-gray-400 dark:text-gray-500">{t(WAREHOUSE_TYPE_LABEL_KEYS[w.type] ?? 'warehouseTypes.other')}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full bg-green-100 dark:bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                            {t('warehouses.status.active')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm tabular-nums text-gray-500 dark:text-gray-400">{formatDmy(w.created_at)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); router.push(`/omborlar/${w.id}`) }}
                              title={t('warehouses.view')}
                              aria-label={t('warehouses.view')}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); setEditing(w) }}
                              title={t('warehouses.edit')}
                              aria-label={t('warehouses.edit')}
                              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); if (canDelete) setDeleteTarget(w) }}
                              disabled={!canDelete}
                              title={canDelete ? t('inventory.warehouses.deleteTitle') : t('inventory.warehouses.deleteBlockedTooltip')}
                              aria-label={t('inventory.warehouses.deleteTitle')}
                              className={cn(
                                'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                                canDelete
                                  ? 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
                                  : 'text-gray-300 dark:text-gray-600 cursor-not-allowed',
                              )}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
              {warehouses.length} / {warehouses.length} {t('warehouses.shownSuffix')}
            </div>
          </>
        )}
      </div>

      <EditWarehouseDialog
        warehouse={editing}
        onOpenChange={open => { if (!open) setEditing(null) }}
        onSaved={u => setWarehouses(prev => prev.map(w => (w.id === u.id ? { ...w, name: u.name, type: u.type } : w)))}
      />

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('inventory.warehouses.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('inventory.warehouses.nameLabel')}</label>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
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
                    onClick={() => setNewType(type)}
                    className={cn(
                      'flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors',
                      newType === type
                        ? 'bg-white dark:bg-gray-900 shadow-sm border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
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
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={createWarehouse} disabled={saving || !newName.trim()} loading={saving}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('inventory.warehouses.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-2">
            <p className="font-medium text-gray-900 dark:text-gray-100">{deleteTarget?.name}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('inventory.warehouses.deleteConfirm')}</p>
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
