'use client'

import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { useIsMultiBranch, useWriteBranchId } from '@/lib/session/useBranch'
import { BranchSelect } from '@/components/filiallar/BranchSelect'
import { branchRpcErrorKey } from '@/components/customers/branchUi'
import type { Customer } from '@/lib/types'

export function AddCustomerDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated?: () => void }) {
  const { t } = useLanguage()
  const { branches, canSeeAllBranches, activeBranchId } = useSession()
  const isMultiBranch = useIsMultiBranch()
  const writeBranchId = useWriteBranchId()
  // Owner/admin on "All branches" pick the branch explicitly; everyone else
  // writes to the active (or own) branch.
  const showBranchSelect = isMultiBranch && canSeeAllBranches && activeBranchId === null
  const activeBranches = branches.filter(b => b.isActive)
  const [pickedBranchId, setPickedBranchId] = useState<string | null>(null)
  const branchId = showBranchSelect ? (pickedBranchId ?? writeBranchId) : writeBranchId
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    fullName: '', phone: '', email: '', address: '', status: 'New' as Customer['status'],
  })
  const setIsAddOpen = onOpenChange
  const isAddOpen = open
  const fetchCustomers = () => onCreated?.()

  async function addCustomer() {
    if (!form.fullName.trim() || !form.phone.trim()) {
      toast.error(t('customers.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()

    // p_branch_id is only sent in multi-branch companies so single-branch
    // installs keep working against the pre-branch create_customer signature.
    const args = {
      p_full_name: form.fullName.trim(),
      p_phone: form.phone.trim(),
      p_email: form.email.trim() || null,
      p_address: form.address.trim() || null,
      p_status: form.status,
      ...(isMultiBranch && branchId ? { p_branch_id: branchId } : {}),
    }
    const { error } = await supabase.rpc('create_customer', args as { p_full_name: string; p_phone: string; p_email: string | null; p_address: string | null; p_status?: string })

    setSaving(false)

    if (error) {
      toast.error(t(branchRpcErrorKey(error.message) ?? 'common.error'))
      return
    }

    setForm({ fullName: '', phone: '', email: '', address: '', status: 'New' })
    setPickedBranchId(null)
    setIsAddOpen(false)
    toast.success(t('customers.addSuccess'))
    fetchCustomers()
  }

  return (
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customers.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {[
              { label: t('customers.fullNameLabel'), key: 'fullName', placeholder: t('customers.fullNamePlaceholder') },
              { label: t('customers.phoneLabel'), key: 'phone', placeholder: t('customers.phonePlaceholder') },
              { label: t('customers.emailLabel'), key: 'email', placeholder: t('customers.emailPlaceholder') },
              { label: t('customers.addressLabel'), key: 'address', placeholder: t('customers.addressPlaceholder') },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
                <input
                  type="text"
                  placeholder={placeholder}
                  value={form[key as keyof typeof form] as string}
                  onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
                />
              </div>
            ))}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.statusLabel')}</label>
              <select
                value={form.status}
                onChange={e => setForm(prev => ({ ...prev, status: e.target.value as Customer['status'] }))}
                className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
              >
                <option value="New">{t('customers.statusNew')}</option>
                <option value="Regular">Regular</option>
                <option value="VIP">VIP</option>
              </select>
            </div>
            {showBranchSelect && (
              <BranchSelect value={branchId ?? ''} onChange={setPickedBranchId} options={activeBranches} allBranches={branches} />
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button onClick={addCustomer} disabled={saving} loading={saving}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  )
}
