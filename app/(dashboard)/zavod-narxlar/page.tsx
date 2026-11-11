'use client'

// Narxlar (wholesale price lists of the production module). The list; the
// item x price grid editor is /zavod-narxlar/[id] ('yangi' = new). Writes go
// through prod_save_price_list only.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ListOrdered, Pencil, Search } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import {
  ActiveBadge, FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { usePriceLists, useProdCustomers, useSalesAvailable } from '@/components/production/SalesKit'

export default function ProdPriceListsPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const available = useSalesAvailable()
  const { lists, loading } = usePriceLists()
  const { customers } = useProdCustomers()
  const [search, setSearch] = useState('')

  const customerCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of customers) if (c.priceListId) m.set(c.priceListId, (m.get(c.priceListId) ?? 0) + 1)
    return m
  }, [customers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return lists
      .filter(l => !q || l.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name))
  }, [lists, search])

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('prodSales.priceLists.title')}
        subtitle={t('prodSales.priceLists.subtitle')}
        actionLabel={available ? t('prodSales.priceLists.new') : undefined}
        actionHref="/zavod-narxlar/yangi"
      />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar onReset={search ? () => setSearch('') : undefined}>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('production.common.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
          </FilterBar>

          <TableCard loading={loading || available === null} empty={filtered.length === 0} emptyText={t('prodSales.priceLists.empty')} emptyIcon={ListOrdered}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thCls}>{t('production.common.name')}</th>
                  <th className={thRightCls}>{t('prodSales.priceLists.itemsCount')}</th>
                  <th className={thRightCls}>{t('prodSales.priceLists.customersCount')}</th>
                  <th className={thCls}>{t('prodSales.priceLists.updatedAt')}</th>
                  <th className={thCls}>{t('production.common.status')}</th>
                  <th className={thRightCls}>{t('production.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(l => (
                  <tr key={l.id} onClick={() => router.push(`/zavod-narxlar/${l.id}`)} className={cn(trCls, 'cursor-pointer', !l.isActive && 'opacity-60')}>
                    <td className={tdCls}>
                      <span className="inline-flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
                        {l.name}
                        {l.isDefault && (
                          <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">{t('prodSales.priceLists.defaultBadge')}</span>
                        )}
                      </span>
                    </td>
                    <td className={cn(tdCls, 'text-right tabular-nums text-gray-700 dark:text-gray-300')}>{l.prices.size}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums text-gray-500 dark:text-gray-400')}>{customerCount.get(l.id) ?? 0}</td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(l.updatedAt)}</td>
                    <td className={tdCls}><ActiveBadge active={l.isActive} /></td>
                    <td className={tdCls}>
                      <div className="flex justify-end">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400" aria-hidden><Pencil className="h-3.5 w-3.5" /></span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </>
      )}
    </div>
  )
}
