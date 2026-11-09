'use client'

import { useState } from 'react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { canCancelDocuments, prodErrorKey, type ProdDocType } from '@/lib/production'

/**
 * Cancel ("Bekor qilish") a posted document via prod_cancel_document, which
 * writes reversing movements (the ledger is append-only). Owner/admin only;
 * the RPC re-checks role, permission and stock.
 */
export function useCancelDoc(docType: ProdDocType, onDone: () => void) {
  const { t } = useLanguage()
  const { profile } = useSession()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function cancel(id: string) {
    if (!window.confirm(t('production.common.cancelConfirm'))) return
    setBusyId(id)
    const { error } = await createClient().rpc('prod_cancel_document', { p_doc_type: docType, p_id: id })
    setBusyId(null)
    if (error) { toast.error(t(prodErrorKey(error.message))); return }
    toast.success(t('production.common.cancelSuccess'))
    onDone()
  }

  return { canCancel: canCancelDocuments(profile?.role), cancel, busyId }
}
