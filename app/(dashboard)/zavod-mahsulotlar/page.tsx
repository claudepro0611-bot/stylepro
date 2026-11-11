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
  prodFieldCls, prodLabelCls, secondaryBtnCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useSession } from '@/lib/session/SessionContext'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useInventoryDocs } from '@/components/production/InventoryKit'
import { parseIntInRange, parseMoneyOrNull } from '@/lib/inventory'
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
  shelfLifeDays: string
  standardCost: string
  salePrice: string
  expiryWarnDays: string
}

const emptyForm: FormState = {
  name: '', groupId: '', sku: '', barcode: '', unit: 'kg', weightKg: '', itemType: 'raw',
  minStock: '', maxStock: '', isActive: true, description: '', shelfLifeDays: '',
  standardCost: '', salePrice: '', expiryWarnDays: '',
}

const strOf = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))

const SHELF_LIFE_MAX = 3650

/** '' -> null (no shelf life); a whole number of days 1..3650; undefined = invalid. */
function parseShelfLife(v: string): number | null | undefined {
  const s = v.trim()
  if (!s) return null
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  return n >= 1 && n <= SHELF_LIFE_MAX ? n : undefined
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
  const [unitOpen, setUnitOpen] = useState(false)
  // standard_cost / sale_price / expiry_warn_days exist after migration 20261110000014.
  const masterFields = useInventoryDocs() === true

  useEffect(() => {
    if (!open) return
    setForm(item
      ? {
          name: item.name, groupId: item.groupId ?? '', sku: item.sku, barcode: item.barcode, unit: item.unit,
          weightKg: item.weightKg === null ? '' : String(item.weightKg), itemType: item.itemType,
          minStock: item.minStock === null ? '' : String(item.minStock),
          maxStock: item.maxStock === null ? '' : String(item.maxStock),
          isActive: item.isActive, description: item.description,
          shelfLifeDays: item.shelfLifeDays === null ? '' : String(item.shelfLifeDays),
          standardCost: strOf(item.standardCost), salePrice: strOf(item.salePrice), expiryWarnDays: strOf(item.expiryWarnDays),
        }
      : emptyForm)
  }, [open, item])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    if (!form.name.trim()) { toast.error(t('production.common.nameRequired')); return }
    const min = numOrNull(form.minStock)
    const max = numOrNull(form.maxStock)
    if (min !== null && max !== null && min > max) { toast.error(t('production.items.minMaxError')); return }
    const shelfLife = parseShelfLife(form.shelfLifeDays)
    if (shelfLife === undefined) { toast.error(t('production.items.shelfLifeError')); return }
    const standardCost = parseMoneyOrNull(form.standardCost)
    const salePrice = parseMoneyOrNull(form.salePrice)
    const warnDays = parseIntInRange(form.expiryWarnDays, 1, 365)
    if (masterFields && (standardCost === undefined || salePrice === undefined)) { toast.error(t('productionErrors.invalid_input')); return }
    if (masterFields && warnDays === undefined) { toast.error(t('prodInventory.items.expiryWarnError')); return }
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
        shelf_life_days: shelfLife,
        // Only sent once the columns exist (migration 20261110000014).
        ...(masterFields ? { standard_cost: standardCost ?? null, sale_price: salePrice ?? null, expiry_warn_days: warnDays ?? null } : {}),
      },
    })
    setSaving(false)
    if (error) {
      // The only invalid_input an edit can hit from this form: unit change after movements.
      const key = prodErrorKey(error)
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
            {item ? (
              // Existing item: the unit is changed only through the safe
              // conversion (stock recalculated with a factor), never inline.
              <div>
                <span className={prodLabelCls}>{t('production.common.unit')}</span>
                <div className="flex gap-2">
                  <input value={t(unitKey(item.unit))} readOnly className={cn(prodFieldCls, 'flex-1 bg-gray-50 dark:bg-gray-800/60')} />
                  <button type="button" onClick={() => setUnitOpen(true)} className={secondaryBtnCls}>
                    {t('production.items.changeUnit')}
                  </button>
                </div>
                <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.items.unitHint')}</span>
              </div>
            ) : (
              <label className="block">
                <span className={prodLabelCls}>{t('production.common.unit')}</span>
                <select value={form.unit} onChange={e => set('unit', e.target.value as ProdUnit)} className={prodFieldCls}>
                  {PROD_UNITS.map(u => <option key={u} value={u}>{t(unitKey(u))}</option>)}
                </select>
              </label>
            )}
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
            <label className="block">
              <span className={prodLabelCls}>{t('production.items.shelfLifeDays')}</span>
              <input
                inputMode="numeric"
                value={form.shelfLifeDays}
                onChange={e => set('shelfLifeDays', e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="—"
                className={cn(prodFieldCls, 'tabular-nums')}
              />
              <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.items.shelfLifeHint')}</span>
            </label>
            {masterFields && (
              <>
                <label className="block">
                  <span className={prodLabelCls}>{t('prodInventory.items.expiryWarnDays')}</span>
                  <input
                    inputMode="numeric"
                    value={form.expiryWarnDays}
                    onChange={e => set('expiryWarnDays', e.target.value.replace(/\D/g, '').slice(0, 3))}
                    placeholder="3"
                    className={cn(prodFieldCls, 'tabular-nums')}
                  />
                  <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('prodInventory.items.expiryWarnHint')}</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className={prodLabelCls}>{t('prodInventory.items.standardCost')}</span>
                    <input inputMode="decimal" value={form.standardCost} onChange={e => set('standardCost', e.target.value)} placeholder="—" className={cn(prodFieldCls, 'tabular-nums')} />
                  </label>
                  <label className="block">
                    <span className={prodLabelCls}>{t('prodInventory.items.salePrice')}</span>
                    <input inputMode="decimal" value={form.salePrice} onChange={e => set('salePrice', e.target.value)} placeholder="—" className={cn(prodFieldCls, 'tabular-nums')} />
                  </label>
                </div>
              </>
            )}
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
      {item && (
        <UnitChangeDialog
          open={unitOpen}
          onOpenChange={setUnitOpen}
          item={item}
          onChanged={newUnit => { setUnitOpen(false); set('unit', newUnit); onSaved() }}
        />
      )}
    </Dialog>
  )
}

/** Suggested factor for common unit pairs (1 old unit = factor new units). */
function defaultFactor(from: ProdUnit, to: ProdUnit): number {
  const pairs: Record<string, number> = {
    'l>kg': 1.03, 'kg>l': 0.971, 'kg>g': 1000, 'g>kg': 0.001, 'l>g': 1030, 'g>l': 0.000971,
  }
  return pairs[`${from}>${to}`] ?? 1
}

function UnitChangeDialog({ open, onOpenChange, item, onChanged }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: ProdItem
  onChanged: (newUnit: ProdUnit) => void
}) {
  const { t } = useLanguage()
  const role = useSession().profile?.role
  const canChange = role === 'owner' || role === 'admin'
  const others = PROD_UNITS.filter(u => u !== item.unit)
  const [newUnit, setNewUnit] = useState<ProdUnit>(others[0])
  const [factor, setFactor] = useState('1')
  const [note, setNote] = useState('')
  const [stockQty, setStockQty] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    const first = (item.unit === 'l' ? 'kg' : others[0]) as ProdUnit
    setNewUnit(first)
    setFactor(String(defaultFactor(item.unit, first)))
    setNote('')
    setStockQty(null)
    createClient().from('prod_stock').select('qty').eq('item_id', item.id).then(({ data }) => {
      setStockQty((data ?? []).reduce((s, r) => s + Number(r.qty ?? 0), 0))
    })
  }, [open, item]) // eslint-disable-line react-hooks/exhaustive-deps

  const f = parseDecimal(factor)
  const valid = canChange && f > 0

  async function submit() {
    if (!valid) return
    setSaving(true)
    const { error } = await createClient().rpc('prod_change_item_unit', {
      p_item_id: item.id, p_new_unit: newUnit, p_factor: f, p_note: note.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.items.unitChanged'))
    onChanged(newUnit)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('production.items.changeUnitTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.name}</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={prodLabelCls}>{t('production.items.currentUnit')}</span>
              <input value={t(unitKey(item.unit))} readOnly className={cn(prodFieldCls, 'bg-gray-50 dark:bg-gray-800/60')} />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.items.newUnit')}</span>
              <select
                value={newUnit}
                onChange={e => { const u = e.target.value as ProdUnit; setNewUnit(u); setFactor(String(defaultFactor(item.unit, u))) }}
                className={prodFieldCls}
              >
                {others.map(u => <option key={u} value={u}>{t(unitKey(u))}</option>)}
              </select>
            </label>
          </div>
          <label className="block">
            <span className={prodLabelCls}>{t('production.items.factor')}</span>
            <input inputMode="decimal" value={factor} onChange={e => setFactor(e.target.value)} className={cn(prodFieldCls, 'tabular-nums')} />
            <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.items.factorHint')}</span>
          </label>
          {stockQty !== null && stockQty !== 0 && (
            <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">{t('production.items.stockNow')}</span>
                <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">{round3(stockQty)} {t(unitKey(item.unit))}</span>
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-gray-500 dark:text-gray-400">{t('production.items.stockAfter')}</span>
                <span className="tabular-nums font-semibold text-gray-900 dark:text-gray-100">{f > 0 ? round3(stockQty * f) : '—'} {t(unitKey(newUnit))}</span>
              </div>
            </div>
          )}
          <p className="text-[12px] text-amber-700 dark:text-amber-400">{t('production.items.changeUnitWarn')}</p>
          <NoteField value={note} onChange={setNote} label={t('production.common.note')} />
          {!canChange && <p className="text-[12px] text-red-600 dark:text-red-400">{t('production.items.ownerOnly')}</p>}
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={submit} disabled={!valid || saving} loading={saving}>{t('production.items.changeUnitConfirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
