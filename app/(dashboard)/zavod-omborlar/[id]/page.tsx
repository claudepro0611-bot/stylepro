'use client'

// Inside one production warehouse: its stock (qoldiq) — opened by clicking a
// warehouse in /zavod-omborlar.

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeftRight, Loader2 } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { ActiveBadge, BackLink, secondaryBtnCls } from '@/components/production/ProdKit'
import { ProdStockView } from '@/components/production/ProdStockView'
import { useProdRefs } from '@/components/production/useProdRefs'
import { storageTypeKey } from '@/lib/production'

export default function ProductionWarehouseStockPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { warehouseById, loading } = useProdRefs()
  const warehouse = warehouseById.get(id)

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!warehouse) return <BackLink href="/zavod-omborlar" label={t('production.warehouses.title')} />

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-omborlar" label={t('production.warehouses.title')} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{warehouse.name}</h1>
        <ActiveBadge active={warehouse.isActive} />
        <div className="flex flex-wrap gap-1">
          {warehouse.storageTypes.map(s => (
            <span key={s} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">{t(storageTypeKey(s))}</span>
          ))}
        </div>
        {warehouse.isActive && (
          <Link href={`/zavod-kochirish/yangi?from=${warehouse.id}`} className={`${secondaryBtnCls} ml-auto`}>
            <ArrowLeftRight className="h-3.5 w-3.5" /> {t('production.warehouses.transfer')}
          </Link>
        )}
      </div>
      <ProdStockView fixedWarehouseId={warehouse.id} />
    </div>
  )
}
