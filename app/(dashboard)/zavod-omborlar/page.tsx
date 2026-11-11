'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Boxes, Pencil, Warehouse } from 'lucide-react'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  ActiveBadge, PageHeader, TableCard, prodFieldCls, prodLabelCls, secondaryBtnCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import {
  PROD_STORAGE_TYPES, fetchProdStock, prodErrorKey, storageTypeKey,
  type ProdStockRow, type ProdStorageType, type ProdWarehouse,
} from '@/lib/production'

export default function ProductionWarehousesPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { warehouses, loading, reload } = useProdRefs()
  const [editing, setEditing] = useState<ProdWarehouse | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [stock, setStock] = useState<ProdStockRow[]>([])

  useEffect(() => {
    let cancelled = false
    fetchProdStock(createClient(), {}).then(rows => { if (!cancelled) setStock(rows) })
    return () => { cancelled = true }
  }, [])

  // Per-warehouse summary shown in the list: distinct items in stock + value.
  const summary = useMemo(() => {
    const m = new Map<string, { items: number; value: number }>()
    for (const r of stock) {
      const s = m.get(r.warehouseId) ?? { items: 0, value: 0 }
      s.items += 1
      s.value += r.value
      m.set(r.warehouseId, s)
    }
    return m
  }, [stock])

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('production.warehouses.title')}
        subtitle={t('production.warehouses.subtitle')}
        actionLabel={t('production.warehouses.new')}
        onAction={() => { setEditing(null); setFormOpen(true) }}
      />

      <div className="flex justify-end -mt-2">
        <Link href="/zavod-qoldiq" className={secondaryBtnCls}>
          <Boxes className="h-3.5 w-3.5" /> {t('production.warehouses.allStock')}
        </Link>
      </div>

      <TableCard loading={loading} empty={warehouses.length === 0} emptyText={t('production.warehouses.empty')} emptyIcon={Warehouse}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.name')}</th>
              <th className={thCls}>{t('production.warehouses.storageTypes')}</th>
              <th className={thRightCls}>{t('production.stock.itemsCount')}</th>
              <th className={thRightCls}>{t('production.stock.value')}</th>
              <th className={thCls}>{t('production.common.status')}</th>
              <th className={thCls}>{t('production.common.createdAt')}</th>
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {warehouses.map(w => (
              <tr
                key={w.id}
                onClick={() => router.push(`/zavod-omborlar/${w.id}`)}
                className={cn(trCls, 'cursor-pointer', !w.isActive && 'opacity-60')}
              >
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{w.name}</td>
                <td className={tdCls}>
                  <div className="flex flex-wrap gap-1">
                    {w.storageTypes.map(s => (
                      <span key={s} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">{t(storageTypeKey(s))}</span>
                    ))}
                  </div>
                </td>
                <td className={cn(tdCls, 'text-right tabular-nums text-gray-900 dark:text-gray-100')}>{summary.get(w.id)?.items ?? 0}</td>
                <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(summary.get(w.id)?.value ?? 0)}</td>
                <td className={tdCls}><ActiveBadge active={w.isActive} /></td>
                <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(w.createdAt)}</td>
                <td className={tdCls}>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setEditing(w); setFormOpen(true) }}
                      aria-label={t('production.common.edit')}
                      title={t('production.common.edit')}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <WarehouseFormDialog open={formOpen} onOpenChange={setFormOpen} warehouse={editing} onSaved={() => { setFormOpen(false); reload() }} />
    </div>
  )
}

function WarehouseFormDialog({ open, onOpenChange, warehouse, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  warehouse: ProdWarehouse | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [types, setTypes] = useState<ProdStorageType[]>([])
  const [isActive, setIsActive] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(warehouse?.name ?? '')
    setTypes(warehouse?.storageTypes ?? ['raw'])
    setIsActive(warehouse?.isActive ?? true)
  }, [open, warehouse])

  function toggleType(type: ProdStorageType) {
    setTypes(prev => (prev.includes(type) ? prev.filter(x => x !== type) : [...prev, type]))
  }

  async function save() {
    if (!name.trim()) { toast.error(t('production.common.nameRequired')); return }
    if (types.length === 0) { toast.error(t('production.warehouses.typesRequired')); return }
    setSaving(true)
    const { error } = await createClient().rpc('prod_save_warehouse', {
      p_id: warehouse?.id ?? null,
      p_name: name.trim(),
      p_storage_types: PROD_STORAGE_TYPES.filter(s => types.includes(s)),
      p_is_active: isActive,
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{warehouse ? t('production.warehouses.editTitle') : t('production.warehouses.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.name')}</span>
            <input value={name} onChange={e => setName(e.target.value)} className={prodFieldCls} />
          </label>
          <div>
            <span className={prodLabelCls}>{t('production.warehouses.storageTypes')}</span>
            <div className="flex flex-wrap gap-1.5">
              {PROD_STORAGE_TYPES.map(s => {
                const on = types.includes(s)
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleType(s)}
                    aria-pressed={on}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                      on
                        ? 'bg-white dark:bg-gray-900 shadow-sm border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100'
                        : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
                    )}
                  >
                    {t(storageTypeKey(s))}
                  </button>
                )
              })}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">{t('production.common.active')}</span>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </label>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
