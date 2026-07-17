'use client'

import { useEffect, useState } from 'react'
import { Minus, Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'

export interface ReturnableItem {
  id: string // transaction_items.id
  productName: string
  quantity: number
  returnedQuantity: number
  returnable: boolean // false when product_size_id is unrecorded (legacy sale)
}

interface ReturnModalProps {
  transactionId: string | null
  items: ReturnableItem[]
  onOpenChange: (open: boolean) => void
  onReturned: () => void
}

export function ReturnModal({ transactionId, items, onOpenChange, onReturned }: ReturnModalProps) {
  const { t } = useLanguage()
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (transactionId) {
      setQuantities({})
      setReason('')
    }
  }, [transactionId])

  function setQty(itemId: string, next: number, max: number) {
    setQuantities(prev => ({ ...prev, [itemId]: Math.max(0, Math.min(max, next)) }))
  }

  async function handleSubmit() {
    if (!transactionId) return
    const lines = items
      .map(item => ({ transaction_item_id: item.id, quantity: quantities[item.id] ?? 0 }))
      .filter(l => l.quantity > 0)

    if (lines.length === 0) {
      toast.error(t('arxiv.returnModal.noneSelected'))
      return
    }
    if (!reason.trim()) {
      toast.error(t('arxiv.returnModal.reasonRequired'))
      return
    }

    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('return_items', {
      p_transaction_id: transactionId,
      p_items: lines,
      p_reason: reason.trim(),
    })
    setSaving(false)

    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }

    toast.success(t('arxiv.returnModal.success'))
    onOpenChange(false)
    onReturned()
  }

  return (
    <Dialog open={!!transactionId} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('arxiv.returnModal.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 mt-2 max-h-[50vh] overflow-y-auto pr-1">
          {items.map(item => {
            const remaining = item.quantity - item.returnedQuantity
            const qty = quantities[item.id] ?? 0
            const canReturn = item.returnable && remaining > 0
            return (
              <div
                key={item.id}
                title={!item.returnable ? t('arxiv.returnModal.legacyLineNotice') : undefined}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5',
                  !item.returnable && 'opacity-50',
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{item.productName}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    {!item.returnable
                      ? t('arxiv.returnModal.legacyLineNotice')
                      : remaining > 0
                        ? `${t('arxiv.returnModal.remaining')}: ${remaining}`
                        : t('arxiv.returnModal.cannotReturn')}
                  </p>
                </div>
                {canReturn && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setQty(item.id, qty - 1, remaining)}
                      className="flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="w-5 text-center text-sm text-gray-900 dark:text-gray-100 tabular-nums">{qty}</span>
                    <button
                      type="button"
                      onClick={() => setQty(item.id, qty + 1, remaining)}
                      className="flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-3">
          <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('arxiv.returnModal.reasonLabel')}
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            placeholder={t('arxiv.returnModal.reasonPlaceholder')}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
          />
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('arxiv.returnModal.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
