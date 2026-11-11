'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pencil, Search, Tag } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  ActiveBadge, FilterBar, PageHeader, TableCard, prodFieldCls, prodLabelCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { prodErrorKey, type ProdItemGroup } from '@/lib/production'

export default function ProductionGroupsPage() {
  const { t } = useLanguage()
  const { items, groups, loading, reload } = useProdRefs()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<ProdItemGroup | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  const countByGroup = useMemo(() => {
    const m = new Map<string, number>()
    items.forEach(i => { if (i.groupId) m.set(i.groupId, (m.get(i.groupId) ?? 0) + 1) })
    return m
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return groups.filter(g => !q || g.name.toLowerCase().includes(q))
  }, [groups, search])

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('production.groups.title')}
        subtitle={t('production.groups.subtitle')}
        actionLabel={t('production.groups.new')}
        onAction={() => { setEditing(null); setFormOpen(true) }}
      />

      <FilterBar onReset={search ? () => setSearch('') : undefined}>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('production.common.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.groups.empty')} emptyIcon={Tag}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.name')}</th>
              <th className={thRightCls}>{t('production.groups.itemsCount')}</th>
              <th className={thCls}>{t('production.common.status')}</th>
              <th className={thCls}>{t('production.common.createdAt')}</th>
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(g => (
              <tr key={g.id} className={cn(trCls, !g.isActive && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{g.name}</td>
                <td className={cn(tdCls, 'text-right tabular-nums')}>{countByGroup.get(g.id) ?? 0}</td>
                <td className={tdCls}><ActiveBadge active={g.isActive} /></td>
                <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(g.createdAt)}</td>
                <td className={tdCls}>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => { setEditing(g); setFormOpen(true) }}
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

      <GroupFormDialog open={formOpen} onOpenChange={setFormOpen} group={editing} onSaved={() => { setFormOpen(false); reload() }} />
    </div>
  )
}

function GroupFormDialog({ open, onOpenChange, group, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: ProdItemGroup | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(group?.name ?? '')
    setIsActive(group?.isActive ?? true)
  }, [open, group])

  async function save() {
    if (!name.trim()) { toast.error(t('production.common.nameRequired')); return }
    setSaving(true)
    const { error } = await createClient().rpc('prod_save_item_group', { p_id: group?.id ?? null, p_name: name.trim(), p_is_active: isActive })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{group ? t('production.groups.editTitle') : t('production.groups.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.common.name')}</span>
            <input value={name} onChange={e => setName(e.target.value)} className={prodFieldCls} />
          </label>
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
