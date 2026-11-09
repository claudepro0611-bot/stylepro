'use client'

// Stock of ALL production warehouses at once. The main entry point is the
// warehouse list (/zavod-omborlar → click a warehouse); this page is the
// "Umumiy qoldiq" view linked from there and from the dashboard.

import { useLanguage } from '@/lib/i18n/LanguageContext'
import { BackLink, PageHeader } from '@/components/production/ProdKit'
import { ProdStockView } from '@/components/production/ProdStockView'

export default function ProductionStockPage() {
  const { t } = useLanguage()
  return (
    <div className="space-y-5">
      <BackLink href="/zavod-omborlar" label={t('production.warehouses.title')} />
      <PageHeader title={t('production.warehouses.allStock')} subtitle={t('production.stock.subtitle')} />
      <ProdStockView />
    </div>
  )
}
