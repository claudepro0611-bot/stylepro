'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pencil, Search, ShoppingBag } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Pagination } from '@/components/ui/Pagination'
import {
  ActiveBadge, ColumnSettings, FilterBar, ItemTypeBadge, NoteField, PageHeader, Segmented, TableCard, useHiddenColumns,
  prodFieldCls, prodLabelCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import {
  PROD_ITEM_TYPES, PROD_UNITS, itemTypeKey, parseDecimal, prodErrorKey, round3, unitKey,
  type ProdItem, type ProdItemGroup, type ProdItemType, type ProdUnit,
} from '@/lib/production'

const PAGE_SIZE = 25

export default function ProductionItemsPage() {
  const { t } = useLanguage()
  const { items, groups, groupById, loading, reload } = useProdRefs()

  const [search, setSearch] = useState('')
  const [groupId, setGroupId] = useState('')
  const [itemType, setItemType] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<ProdItem | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  const { isVisible, toggle } = useHiddenColumns('zavod-mahsulotlar')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items
      .filter(i => !groupId || i.groupId === groupId)
      .filter(i => !itemType || i.itemType === itemType)
      .filter(i => !status || (status === 'active') === i.isActive)
      .filter(i => !q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q) || i.barcode.includes(q))
  }, [items, search, groupId, itemType, status])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const columns = [
    { key: 'group', label: t('production.items.group') },
    { key: 'sku', label: t('production.items.sku') },
    { key: 'type', label: t('production.stock.type') },
    { key: 'unit', label: t('production.common.unit') },
    { key: 'status', label: t('production.common.status') },
    { key: 'created', label: t('production.common.createdAt') },
  ]

  function reset() {
    setSearch('')
    setGroupId('')
    setItemType('')
    setStatus('')
    setPage(1)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('production.items.title')}
        subtitle={t('production.items.subtitle')}
        actionLabel={t('production.items.new')}
        onAction={() => { setEditing(null); setFormOpen(true) }}
      />

      <FilterBar onReset={reset} columns={<ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} />}>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.common.searchItem')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <select value={groupId} onChange={e => { setGroupId(e.target.value); setPage(1) }} className={cn(prodFieldCls, 'w-44')}>
          <option value="">{t('production.items.allGroups')}</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select value={itemType} onChange={e => { setItemType(e.target.value); setPage(1) }} className={cn(prodFieldCls, 'w-40')}>
          <option value="">{t('production.common.allTypes')}</option>
          {PROD_ITEM_TYPES.map(type => <option key={type} value={type}>{t(itemTypeKey(type))}</option>)}
        </select>
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1) }} className={cn(prodFieldCls, 'w-36')}>
          <option value="">{t('production.common.allStatuses')}</option>
          <option value="active">{t('production.common.active')}</option>
          <option value="inactive">{t('production.common.inactive')}</option>
        </select>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.items.empty')} emptyIcon={ShoppingBag}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.name')}</th>
              {isVisible('group') && <th className={thCls}>{t('production.items.group')}</th>}
              {isVisible('sku') && <th className={thCls}>{t('production.items.sku')}</th>}
              {isVisible('type') && <th className={thCls}>{t('production.stock.type')}</th>}
              {isVisible('unit') && <th className={thCls}>{t('production.common.unit')}</th>}
              {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
              {isVisible('created') && <th className={thCls}>{t('production.common.createdAt')}</th>}
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(i => (
              <tr key={i.id} className={cn(trCls, !i.isActive && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{i.name}</td>
                {isVisible('group') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{(i.groupId && groupById.get(i.groupId)?.name) || '—'}</td>}
                {isVisible('sku') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{i.sku || '—'}</td>}
                {isVisible('type') && <td className={tdCls}><ItemTypeBadge type={i.itemType} /></td>}
                {isVisible('unit') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{t(unitKey(i.unit))}</td>}
                {isVisible('status') && <td className={tdCls}><ActiveBadge active={i.isActive} /></td>}
                {isVisible('created') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(i.createdAt)}</td>}
                <td className={tdCls}>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => { setEditing(i); setFormOpen(true) }}
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
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}

      <ItemFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        item={editing}
        groups={groups}
        onSaved={() => { setFormOpen(false); reload() }}
      />
    </div>
  )
}

interface FormState {
  name: string
  groupId: string
  sku: string
  barcode: string
  unit: ProdUnit
  weightKg: string
  itemType: ProdItemType
  minStock: string
  maxStock: string
  isActive: boolean
  description: string
}

const emptyForm: FormState = {
  name: '', groupId: '', sku: '', barcode: '', unit: 'kg', weightKg: '', itemType: 'raw',
  minStock: '', maxStock: '', isActive: true, description: '',
}

const numOrNull = (v: string) => (v.trim() === '' ? null : round3(parseDecimal(v)))

function ItemFormDialog({ open, onOpenChange, item, groups, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: ProdItem | null
  groups: ProdItemGroup[]
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(item
      ? {
          name: item.name, groupId: item.groupId ?? '', sku: item.sku, barcode: item.barcode, unit: item.unit,
          weightKg: item.weightKg === null ? '' : String(item.weightKg), itemType: item.itemType,
          minStock: item.minStock === null ? '' : String(item.minStock),
          maxStock: item.maxStock === null ? '' : String(item.maxStock),
          isActive: item.isActive, description: item.description,
        }
      : emptyForm)
  }, [open, item])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    if (!form.name.trim()) { toast.error(t('production.common.nameRequired')); return }
    const min = numOrNull(form.minStock)
    const max = numOrNull(form.maxStock)
    if (min !== null && max !== null && min > max) { toast.error(t('production.items.minMaxError')); return }
    setSaving(true)
    // prod_save_item replaces every field on update: always send the full set.
    const { error } = await createClient().rpc('prod_save_item', {
      p_id: item?.id ?? null,
      p_data: {
        name: form.name.trim(),
        group_id: form.groupId || null,
        sku: form.sku.trim() || null,
        barcode: form.barcode.trim() || null,
        unit: form.unit,
        weight_kg: numOrNull(form.weightKg),
        item_type: form.itemType,
        min_stock: min,
        max_stock: max,
        is_active: form.isActive,
        description: form.description.trim() || null,
      },
    })
    setSaving(false)
    if (error) {
      // The only invalid_input an edit can hit from this form: unit change after movements.
      const key = prodErrorKey(error.message)
      toast.error(t(item && key === 'productionErrors.invalid_input' && item.unit !== form.unit ? 'production.items.unitLocked' : key))
      return
    }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item ? t('production.items.editTitle') : t('production.items.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.name')}</span>
            <input value={form.name} onChange={e => set('name', e.target.value)} className={prodFieldCls} />
          </label>
          <div>
            <span className={prodLabelCls}>{t('production.stock.type')}</span>
            <Segmented
              options={PROD_ITEM_TYPES.map(type => ({ value: type, label: t(itemTypeKey(type)) }))}
              value={form.itemType}
              onChange={v => set('itemType', v)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className={prodLabelCls}>{t('production.items.group')}</span>
              <select value={form.groupId} onChange={e => set('groupId', e.target.value)} className={prodFieldCls}>
                <option value="">{t('production.items.noGroup')}</option>
                {groups.filter(g => g.isActive || g.id === form.groupId).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.unit')}</span>
              <select value={form.unit} onChange={e => set('unit', e.target.value as ProdUnit)} className={prodFieldCls}>
                {PROD_UNITS.map(u => <option key={u} value={u}>{t(unitKey(u))}</option>)}
              </select>
              {item && <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.items.unitHint')}</span>}
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.items.sku')}</span>
              <input value={form.sku} onChange={e => set('sku', e.target.value)} className={prodFieldCls} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.items.barcode')}</span>
              <input value={form.barcode} onChange={e => set('barcode', e.target.value)} className={prodFieldCls} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.items.weightKg')}</span>
              <input inputMode="decimal" value={form.weightKg} onChange={e => set('weightKg', e.target.value)} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={prodLabelCls}>{t('production.items.minStock')}</span>
                <input inputMode="decimal" value={form.minStock} onChange={e => set('minStock', e.target.value)} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
              </label>
              <label className="block">
                <span className={prodLabelCls}>{t('production.items.maxStock')}</span>
                <input inputMode="decimal" value={form.maxStock} onChange={e => set('maxStock', e.target.value)} placeholder="0" className={cn(prodFieldCls, 'tabular-nums')} />
              </label>
            </div>
          </div>
          <NoteField value={form.description} onChange={v => set('description', v)} label={t('production.items.description')} />
          <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">{t('production.common.active')}</span>
            <Switch checked={form.isActive} onCheckedChange={v => set('isActive', v)} />
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
