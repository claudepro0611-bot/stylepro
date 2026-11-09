'use client'

import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { branchErrorKey } from '@/lib/branches'

export interface EditableBranch { id: string; name: string; address: string | null; phone: string | null }

interface BranchFormDialogProps {
  open: boolean
  /** null = create mode */
  branch: EditableBranch | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const labelCls = 'block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1'

export function BranchFormDialog({ open, branch, onOpenChange, onSaved }: BranchFormDialogProps) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(branch?.name ?? '')
    setAddress(branch?.address ?? '')
    setPhone(branch?.phone ?? '')
  }, [open, branch])

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error(t('branches.errors.branchNameRequired'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const p_address = address.trim() || null
    const p_phone = phone.trim() || null
    const { error } = branch
      ? await supabase.rpc('update_branch', { p_id: branch.id, p_name: trimmed, p_address, p_phone })
      : await supabase.rpc('create_branch', { p_name: trimmed, p_address, p_phone })
    setSaving(false)
    if (error) {
      toast.error(t(branchErrorKey(error.message, error.code) ?? 'common.error'))
      return
    }
    toast.success(t(branch ? 'branches.toasts.updated' : 'branches.toasts.created'))
    onOpenChange(false)
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t(branch ? 'branches.form.editTitle' : 'branches.form.createTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div>
            <label className={labelCls}>{t('branches.form.name')}</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save() }}
              className={inputCls}
              placeholder={t('branches.form.namePlaceholder')}
            />
          </div>
          <div>
            <label className={labelCls}>{t('branches.form.address')}</label>
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              className={inputCls}
              placeholder={t('branches.form.addressPlaceholder')}
            />
          </div>
          <div>
            <label className={labelCls}>{t('branches.form.phone')}</label>
            <input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className={inputCls}
              placeholder={t('branches.form.phonePlaceholder')}
            />
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
