'use client'

// Stock table of the production module. Used by:
//   - /zavod-omborlar/[id] — one warehouse (fixedWarehouseId), opened by
//     clicking a warehouse in the list (the main way to see stock);
//   - /zavod-qoldiq       — all warehouses at once (warehouse filter + column).

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Boxes, ChevronDown, ChevronRight, Package, Search, Wallet } from 'lucide-react'
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
import { LotExpiry, LotNo } from '@/components/production/LotPicker'
import { LotHoldControl, useInventoryDocs } from '@/components/production/InventoryKit'
import {
  PROD_ITEM_TYPES, expiryWarnDaysOf, fetchProdStock, fetchProdStockFat, fetchProdStockLots, formatQty, itemTypeKey, unitKey,
  type ProdLot, type ProdStockRow,
} from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { formatDate } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { ExportButton } from '@/components/production/ReportKit'
import { downloadXlsx, lotTraceHref, x2, x3 } from '@/lib/production-reports'

const PAGE_SIZE = 50

export function ProdStockView({ fixedWarehouseId }: { fixedWarehouseId?: string }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { warehouses, itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const [rows, setRows] = useState<ProdStockRow[]>([])
  // Average fat % of milk stock (Sut qabuli); only rows that track fat.
  const [fatByKey, setFatByKey] = useState<Map<string, number>>(new Map())
  // Lots per "warehouseId:itemId" (FEFO order); empty while lots are not available.
  const [lotsByKey, setLotsByKey] = useState<Map<string, ProdLot[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [warehouseFilter, setWarehouseFilter] = useState('')
  const [itemType, setItemType] = useState('')
  const [search, setSearch] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [page, setPage] = useState(1)
  // Bumped after a lot hold change to re-read the lots (keeps rows expanded).
  const [lotTick, setLotTick] = useState(0)
  const holdAvailable = useInventoryDocs() === true

  const warehouseId = fixedWarehouseId ?? warehouseFilter
  const showWarehouse = !fixedWarehouseId

  useEffect(() => {
    if (lotTick === 0) return
    let cancelled = false
    fetchProdStockLots(createClient(), warehouseId || undefined).then(lots => {
      if (cancelled) return
      const byKey = new Map<string, ProdLot[]>()
      for (const l of lots ?? []) {
        const k = `${l.warehouseId}:${l.itemId}`
        const arr = byKey.get(k)
        if (arr) arr.push(l)
        else byKey.set(k, [l])
      }
      setLotsByKey(byKey)
    })
    return () => { cancelled = true }
  }, [lotTick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    Promise.all([
      fetchProdStock(supabase, { warehouseId: warehouseId || undefined }),
      fetchProdStockFat(supabase, warehouseId || undefined),
      fetchProdStockLots(supabase, warehouseId || undefined),
    ]).then(([data, fat, lots]) => {
      if (cancelled) return
      setRows(data)
      setFatByKey(fat)
      const byKey = new Map<string, ProdLot[]>()
      for (const l of lots ?? []) {
        const k = `${l.warehouseId}:${l.itemId}`
        const arr = byKey.get(k)
        if (arr) arr.push(l)
        else byKey.set(k, [l])
      }
      setLotsByKey(byKey)
      setExpanded(new Set())
      setPage(1)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [warehouseId])

  const { isVisible, toggle } = useHiddenColumns(fixedWarehouseId ? 'zavod-ombor-qoldiq' : 'zavod-qoldiq')

  const enriched = useMemo(() => rows.map(r => {
    const item = itemById.get(r.itemId)
    const low = item?.minStock != null && r.qty < item.minStock
    return { ...r, item, low, fat: fatByKey.get(`${r.warehouseId}:${r.itemId}`) ?? null }
  }), [rows, itemById, fatByKey])
  const hasFat = useMemo(() => enriched.some(r => r.fat !== null), [enriched])

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
    ...(hasFat ? [{ key: 'fat', label: t('production.stock.fat') }] : []),
    { key: 'avgCost', label: t('production.common.avgCost') },
    { key: 'value', label: t('production.stock.value') },
  ]

  const colCount = 2 + (isVisible('type') ? 1 : 0) + (showWarehouse && isVisible('warehouse') ? 1 : 0)
    + (hasFat && isVisible('fat') ? 1 : 0) + (isVisible('avgCost') ? 1 : 0) + (isVisible('value') ? 1 : 0)
  const today = localYmd()

  function toggleRow(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function exportXlsx() {
    downloadXlsx(fixedWarehouseId ? `ombor_${(warehouseById.get(fixedWarehouseId)?.name ?? '').replace(/\s+/g, '_')}` : 'zavod_qoldiq', [
      t('production.common.item'), 'SKU', t('production.stock.type'), t('production.common.warehouse'), t('production.common.stockLeft'),
      t('production.common.unit'), t('production.stock.fat'), `${t('production.common.avgCost')} (UZS)`, `${t('production.stock.value')} (UZS)`,
    ], filtered.map(r => [
      r.item?.name ?? '', r.item?.sku ?? '', r.item ? t(itemTypeKey(r.item.itemType)) : '', warehouseById.get(r.warehouseId)?.name ?? '',
      x3(r.qty), r.item ? t(unitKey(r.item.unit)) : '', r.fat === null ? '' : x3(r.fat), x2(r.avgCost), x2(r.value),
    ]), t('production.stock.title'))
  }

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

      <FilterBar onReset={reset} columns={<><ExportButton onClick={exportXlsx} disabled={filtered.length === 0} /><ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} /></>}>
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
              {hasFat && isVisible('fat') && <th className={thRightCls}>{t('production.stock.fat')}</th>}
              {isVisible('avgCost') && <th className={thRightCls}>{t('production.common.avgCost')}</th>}
              {isVisible('value') && <th className={thRightCls}>{t('production.stock.value')}</th>}
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => {
              const key = `${r.warehouseId}:${r.itemId}`
              const lots = lotsByKey.get(key)
              const open = !!lots && expanded.has(key)
              const unitLabel = r.item ? t(unitKey(r.item.unit)) : ''
              return (
              <Fragment key={key}>
              <tr className={cn(trCls, lots && 'cursor-pointer')} onClick={lots ? () => toggleRow(key) : undefined}>
                <td className={tdCls}>
                  <div className="flex items-start gap-1.5">
                    {lots ? (
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={t('production.lots.showLots')}
                        title={t('production.lots.showLots')}
                        onClick={e => { e.stopPropagation(); toggleRow(key) }}
                        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                      >
                        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    ) : lotsByKey.size > 0 ? <span className="w-4 shrink-0" /> : null}
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{r.item?.name ?? '—'}</p>
                      {r.item?.sku && <p className="text-xs text-gray-400 dark:text-gray-500">{r.item.sku}</p>}
                      {lots && <p className="text-xs text-gray-400 dark:text-gray-500">{lots.length} {t('production.lots.lotsShort')}</p>}
                    </div>
                  </div>
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
                {hasFat && isVisible('fat') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300')}>{r.fat !== null ? formatPct(r.fat) : ''}</td>}
                {isVisible('avgCost') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(r.avgCost)}</td>}
                {isVisible('value') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(r.value)}</td>}
              </tr>
              {open && lots && (
                <tr className="border-b border-gray-50 dark:border-gray-800/60 bg-gray-50 dark:bg-gray-800/40">
                  <td colSpan={colCount} className="px-4 py-3">
                    <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('production.lots.lotNo')}</th>
                            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('production.lots.received')}</th>
                            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('production.lots.supplier')}</th>
                            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('production.lots.remaining')}</th>
                            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('production.lots.unitCost')}</th>
                            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('production.stock.value')}</th>
                            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('production.lots.fat')}</th>
                            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('production.lots.expiry')}</th>
                            {holdAvailable && <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('prodInventory.hold.status')}</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {lots.map(l => (
                            <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                              <td className="px-3 py-2"><Link href={lotTraceHref(l.id)} className="hover:opacity-70 transition-opacity"><LotNo lot={l} /></Link></td>
                              <td className="px-3 py-2 whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(l.receivedAt)}</td>
                              <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{l.supplierName || '—'}</td>
                              <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap', l.remainingQty < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>{formatQty(l.remainingQty)} {unitLabel}</td>
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(l.unitCost)}</td>
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300">{formatPrice(l.value)}</td>
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{l.fatPct === null ? '—' : formatPct(l.fatPct)}</td>
                              <td className="px-3 py-2"><LotExpiry date={l.expiryDate} today={today} warnDays={expiryWarnDaysOf(r.item)} /></td>
                              {holdAvailable && (
                                <td className="px-3 py-2">
                                  <LotHoldControl compact lot={l} onSaved={() => setLotTick(n => n + 1)} />
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
              )
            })}
          </tbody>
        </table>
      </TableCard>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}
    </>
  )
}
