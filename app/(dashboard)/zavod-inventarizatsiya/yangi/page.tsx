'use client'

import { Loader2 } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { BackLink } from '@/components/production/ProdKit'
import { NotAvailableNote, useInventoryDocs } from '@/components/production/InventoryKit'
import { StockCountEditor } from '@/components/production/StockCountEditor'

export default function NewStockCountPage() {
  const { t } = useLanguage()
  const available = useInventoryDocs()
  if (available === null) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!available) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-inventarizatsiya" label={t('prodInventory.counts.title')} />
        <NotAvailableNote />
      </div>
    )
  }
  return <StockCountEditor />
}
