'use client'

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { BranchSelect } from '@/components/filiallar/BranchSelect'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { branchRpcErrorKey } from '@/components/customers/branchUi'

interface MoveCustomerBranchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  customerId: string
  customerName: string
  currentBranchId: string | null
  onMoved: () => void
}

/**
 * Confirm dialog for move_customer_branch (owner/admin only). The RPC moves
 * the customer together with its nasiya, cashback and requests; the server
 * re-checks role and branch.
 */
export function MoveCustomerBranchDialog({ open, onOpenChange, customerId, customerName, currentBranchId, onMoved }: MoveCustomerBranchDialogProps) {
  const { t } = useLanguage()
  const { branches } = useSession()
  const options = branches.filter(b => b.isActive && b.id !== currentBranchId)
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)
  // Keep the selection valid without an effect: fall back to the first option.
  const value = options.some(o => o.id === target) ? target : (options[0]?.id ?? '')

  async function submit() {
    if (!value) return
    if (value === currentBranchId) {
      toast.error(t('branchCustomers.sameBranch'))
      return
    }
    setSaving(true)
    // move_customer_branch is not in lib/database.types.ts yet.
    const supabase = createClient() as unknown as SupabaseClient
    const { error } = await supabase.rpc('move_customer_branch', { p_customer_id: customerId, p_branch_id: value })
    setSaving(false)
    if (error) {
      toast.error(t(branchRpcErrorKey(error.message) ?? 'common.error'))
      return
    }
    toast.success(t('branchCustomers.moveSuccess'))
    onOpenChange(false)
    onMoved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('branchCustomers.moveTitle')}</DialogTitle>
        </DialogHeader>
        <div className="mt-2 space-y-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{customerName}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('branchCustomers.moveDescription')}</p>
          {options.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('branchCustomers.noOtherBranch')}</p>
          ) : (
            <BranchSelect value={value} onChange={setTarget} options={options} />
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={submit} disabled={saving || !value} loading={saving}>{t('branchCustomers.moveSubmit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
