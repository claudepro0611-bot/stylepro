'use client'

import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { WAREHOUSE_TYPE_LABEL_KEYS, CREATABLE_WAREHOUSE_TYPES, type WarehouseType } from '@/lib/warehouses'
import { BranchSelect, type BranchSelectOption } from '@/components/filiallar/BranchSelect'
import { branchErrorKey } from '@/lib/branches'
import { useSession } from '@/lib/session/SessionContext'

export interface EditableWarehouse { id: string; name: string; type: WarehouseType; branch_id?: string | null }

interface EditWarehouseDialogProps {
  warehouse: EditableWarehouse | null
  onOpenChange: (open: boolean) => void
  onSaved: (updated: EditableWarehouse) => void
  /** Company branches; pass [] for single-branch companies to hide the field. */
  branches?: BranchSelectOption[]
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

export function EditWarehouseDialog({ warehouse, onOpenChange, onSaved, branches = [] }: EditWarehouseDialogProps) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [type, setType] = useState<WarehouseType>('clothing')
  const [branchId, setBranchId] = useState('')
  const [saving, setSaving] = useState(false)
  const { canSeeAllBranches } = useSession()

  useEffect(() => {
    if (warehouse) { setName(warehouse.name); setType(warehouse.type); setBranchId(warehouse.branch_id ?? '') }
  }, [warehouse])

  // Legacy types (e.g. 'footwear') aren't creatable anymore but must stay selectable for their own warehouse.
  const typeOptions = warehouse && !CREATABLE_WAREHOUSE_TYPES.includes(warehouse.type)
    ? [warehouse.type, ...CREATABLE_WAREHOUSE_TYPES]
    : CREATABLE_WAREHOUSE_TYPES

  async function save() {
    if (!warehouse || !name.trim()) return
    setSaving(true)
    // Only send p_branch_id when it actually changes: the move is refused
    // server-side for a warehouse that holds stock (warehouse_not_empty).
    const branchChanged = branches.length > 1 && !!branchId && branchId !== (warehouse.branch_id ?? '')
    const { error } = await createClient().rpc('update_warehouse', {
      p_id: warehouse.id, p_name: name.trim(), p_type: type,
      ...(branchChanged ? { p_branch_id: branchId } : {}),
    })
    setSaving(false)
    if (error) {
      const key = branchErrorKey(error.message, error.code)
      toast.error(key ? t(key) : error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    toast.success(t('warehouses.editSuccess'))
    onSaved({ id: warehouse.id, name: name.trim(), type, branch_id: branchChanged ? branchId : warehouse.branch_id })
    onOpenChange(false)
  }

  return (
    <Dialog open={!!warehouse} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('warehouses.editTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('inventory.warehouses.nameLabel')}</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save() }}
              className={inputCls}
              placeholder={t('inventory.warehouses.namePlaceholder')}
            />
          </div>
          {branches.length > 1 && (
            // Moving is owner/admin only and only for an empty warehouse
            // (update_warehouse raises warehouse_not_empty otherwise).
            <BranchSelect
              value={branchId}
              onChange={setBranchId}
              options={branches.filter(b => b.isActive)}
              allBranches={branches}
              disabled={!canSeeAllBranches}
            />
          )}
          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('inventory.warehouses.typeLabel')}</label>
            <div className="flex gap-2 flex-wrap">
              {typeOptions.map(opt => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setType(opt)}
                  className={cn(
                    'flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors',
                    type === opt
                      ? 'bg-indigo-600 dark:bg-indigo-500 shadow-sm border-indigo-600 dark:border-indigo-500 text-white'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
                  )}
                >
                  {t(WAREHOUSE_TYPE_LABEL_KEYS[opt] ?? 'warehouseTypes.other')}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={save} disabled={saving || !name.trim()} loading={saving}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
