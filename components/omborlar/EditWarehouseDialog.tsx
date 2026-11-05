'use client'

import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { WAREHOUSE_TYPE_LABEL_KEYS, CREATABLE_WAREHOUSE_TYPES, type WarehouseType } from '@/lib/warehouses'

export interface EditableWarehouse { id: string; name: string; type: WarehouseType }

interface EditWarehouseDialogProps {
  warehouse: EditableWarehouse | null
  onOpenChange: (open: boolean) => void
  onSaved: (updated: EditableWarehouse) => void
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

export function EditWarehouseDialog({ warehouse, onOpenChange, onSaved }: EditWarehouseDialogProps) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [type, setType] = useState<WarehouseType>('clothing')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (warehouse) { setName(warehouse.name); setType(warehouse.type) }
  }, [warehouse])

  // Legacy types (e.g. 'footwear') aren't creatable anymore but must stay selectable for their own warehouse.
  const typeOptions = warehouse && !CREATABLE_WAREHOUSE_TYPES.includes(warehouse.type)
    ? [warehouse.type, ...CREATABLE_WAREHOUSE_TYPES]
    : CREATABLE_WAREHOUSE_TYPES

  async function save() {
    if (!warehouse || !name.trim()) return
    setSaving(true)
    const { error } = await createClient().rpc('update_warehouse', { p_id: warehouse.id, p_name: name.trim(), p_type: type })
    setSaving(false)
    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    toast.success(t('warehouses.editSuccess'))
    onSaved({ id: warehouse.id, name: name.trim(), type })
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
                      ? 'bg-slate-900 dark:bg-white shadow-sm border-slate-900 dark:border-white text-white dark:text-gray-900'
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
