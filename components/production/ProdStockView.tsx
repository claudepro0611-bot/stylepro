'use client'

// Stock table of the production module. Used by:
//   - /zavod-omborlar/[id] — one warehouse (fixedWarehouseId), opened by
//     clicking a warehouse in the list (the main way to see stock);
//   - /zavod-qoldiq       — all warehouses at once (warehouse filter + column).

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, Package, Search, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { Pagination } from '@/components/ui/Pagination'
import { KpiGrid } from '@/components/reports/ReportKit'
import {
  ColumnSettings, FilterBar, ItemTypeBadge, TableCard, useHiddenColumns,
  prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { PROD_ITEM_TYPES, fetchProdStock, formatQty, itemTypeKey, unitKey, type ProdStockRow } from '@/lib/production'

const PAGE_SIZE = 50

export function ProdStockView({ fixedWarehouseId }: { fixedWarehouseId?: string }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { warehouses, itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const [rows, setRows] = useState<ProdStockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [warehouseFilter, setWarehouseFilter] = useState('')
  const [itemType, setItemType] = useState('')
  const [search, setSearch] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [page, setPage] = useState(1)

  const warehouseId = fixedWarehouseId ?? warehouseFilter
  const showWarehouse = !fixedWarehouseId

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchProdStock(createClient(), { warehouseId: warehouseId || undefined }).then(data => {
      if (cancelled) return
      setRows(data)
      setPage(1)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [warehouseId])

  const { isVisible, toggle } = useHiddenColumns(fixedWarehouseId ? 'zavod-ombor-qoldiq' : 'zavod-qoldiq')

  const enriched = useMemo(() => rows.map(r => {
    const item = itemById.get(r.itemId)
    const low = item?.minStock != null && r.qty < item.minStock
    return { ...r, item, low }
  }), [rows, itemById])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return enriched
      .filter(r => !itemType || r.item?.itemType === itemType)
      .filter(r => !onlyLow || r.low)
      .filter(r => !q || (r.item?.name ?? '').toLowerCase().includes(q) || (r.item?.sku ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.item?.name ?? '').localeCompare(b.item?.name ?? ''))
  }, [enriched, itemType, onlyLow, search])

  const totals = useMemo(() => ({
    value: filtered.reduce((s, r) => s + r.value, 0),
    items: new Set(filtered.map(r => r.itemId)).size,
    low: filtered.filter(r => r.low).length,
  }), [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const columns = [
    { key: 'type', label: t('production.stock.type') },
    ...(showWarehouse ? [{ key: 'warehouse', label: t('production.common.warehouse') }] : []),
    { key: 'avgCost', label: t('production.common.avgCost') },
    { key: 'value', label: t('production.stock.value') },
  ]

  function reset() {
    setWarehouseFilter('')
    setItemType('')
    setSearch('')
    setOnlyLow(false)
  }

  return (
    <>
      <KpiGrid items={[
        { label: t('production.stock.totalValue'), value: formatPrice(totals.value), icon: Wallet },
        { label: t('production.stock.itemsCount'), value: String(totals.items), icon: Package },
        { label: t('production.stock.lowCount'), value: String(totals.low), icon: AlertTriangle, tone: totals.low > 0 ? 'negative' : undefined },
      ]} />

      <FilterBar onReset={reset} columns={<ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} />}>
        {showWarehouse && (
          <select value={warehouseFilter} onChange={e => setWarehouseFilter(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
            <option value="">{t('production.common.allWarehouses')}</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <select value={itemType} onChange={e => { setItemType(e.target.value); setPage(1) }} className={cn(prodFieldCls, 'w-44')}>
          <option value="">{t('production.common.allTypes')}</option>
          {PROD_ITEM_TYPES.map(type => <option key={type} value={type}>{t(itemTypeKey(type))}</option>)}
        </select>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.common.searchItem')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={onlyLow} onChange={e => { setOnlyLow(e.target.checked); setPage(1) }} className="h-4 w-4 rounded border-gray-300 dark:border-gray-600" />
          {t('production.stock.onlyLow')}
        </label>
      </FilterBar>

      <TableCard loading={loading || refsLoading} empty={filtered.length === 0} emptyText={t('production.stock.empty')} emptyIcon={Boxes}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.item')}</th>
              {isVisible('type') && <th className={thCls}>{t('production.stock.type')}</th>}
              {showWarehouse && isVisible('warehouse') && <th className={thCls}>{t('production.common.warehouse')}</th>}
              <th className={thRightCls}>{t('production.common.stockLeft')}</th>
              {isVisible('avgCost') && <th className={thRightCls}>{t('production.common.avgCost')}</th>}
              {isVisible('value') && <th className={thRightCls}>{t('production.stock.value')}</th>}
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => (
              <tr key={`${r.warehouseId}:${r.itemId}`} className={trCls}>
                <td className={tdCls}>
                  <p className="font-medium text-gray-900 dark:text-gray-100">{r.item?.name ?? '—'}</p>
                  {r.item?.sku && <p className="text-xs text-gray-400 dark:text-gray-500">{r.item.sku}</p>}
                </td>
                {isVisible('type') && <td className={tdCls}>{r.item && <ItemTypeBadge type={r.item.itemType} />}</td>}
                {showWarehouse && isVisible('warehouse') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(r.warehouseId)?.name ?? '—'}</td>}
                <td className={cn(tdCls, 'text-right whitespace-nowrap')}>
                  <span className={cn('tabular-nums font-medium', r.qty < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>
                    {formatQty(r.qty)} {r.item ? t(unitKey(r.item.unit)) : ''}
                  </span>
                  {r.low && (
                    <span className="ml-2 inline-flex rounded-full bg-amber-100 dark:bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                      {t('production.stock.low')}
                    </span>
                  )}
                </td>
                {isVisible('avgCost') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(r.avgCost)}</td>}
                {isVisible('value') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(r.value)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}
    </>
  )
}
