'use client'

// Oborot: per item (or item x warehouse) opening, inflow, outflow and closing
// quantity + value over a period, with the in/out split by document type on
// expand. Ledger = lot-bearing prod_stock_movements + opening lots (see
// lib/production-reports.ts). Value = qty x unit_cost of each movement.
// Server-side aggregation (prod_report_turnover, migration 20261110000018)
// when available; the client paging below is the fallback before it.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { ArrowDownCircle, ArrowUpCircle, Boxes, Search, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { ReportHeader, monthToDate } from '@/components/reports/ReportKit'
import { BackLink, Segmented, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls } from '@/components/production/ProdKit'
import { ExpandChevron, FilterSelect, ProdKpiGrid, QtyValueCell } from '@/components/production/ReportKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { formatQty, rangeToIsoBounds, unitKey } from '@/lib/production'
import { localYmd } from '@/lib/utils/date'
import {
  LEDGER_DOC_TYPES, aggregateTurnover, docTypeKey, downloadXlsx, fetchLedgerEvents, x2, x3, type LedgerEvent, type TurnoverRow,
} from '@/lib/production-reports'
import { fetchTurnoverRpc, mergeTurnoverByItem } from '@/lib/production-accounting'

/** Set once the RPC turned out to be missing (pre-migration): skip it afterwards. */
let turnoverRpcMissing = false

const PAGE_SIZE = 50
type GroupBy = 'item' | 'warehouse'

const docOrder = (d: string) => {
  const i = (LEDGER_DOC_TYPES as readonly string[]).indexOf(d)
  return i < 0 ? 99 : i
}

export default function TurnoverReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { items, warehouses, groups, itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [warehouseId, setWarehouseId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [itemId, setItemId] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('item')
  const [search, setSearch] = useState('')
  const [events, setEvents] = useState<LedgerEvent[]>([])
  // Per (warehouse, item) rows of prod_report_turnover; null = client fallback.
  const [rpcRows, setRpcRows] = useState<TurnoverRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)

  const bounds = useMemo(() => {
    if (range) return rangeToIsoBounds(range)
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() + 1)
    return { fromIso: null, toIso: end.toISOString() }
  }, [range])

  const itemIds = useMemo(() => {
    if (itemId) return [itemId]
    if (groupId) return items.filter(i => i.groupId === groupId).map(i => i.id)
    return null
  }, [itemId, groupId, items])

  useEffect(() => {
    if (refsLoading) return
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    const done = () => { setExpanded(new Set()); setPage(1); setLoading(false) }
    ;(async () => {
      if (!turnoverRpcMissing) {
        const res = await fetchTurnoverRpc(supabase, {
          from: range?.from ?? null, to: range?.to ?? localYmd(), warehouseId: warehouseId || undefined, groupId: groupId || undefined,
        })
        if (cancelled) return
        if (res.status === 'ok') { setRpcRows(res.data); setEvents([]); done(); return }
        if (res.status === 'missing') turnoverRpcMissing = true
      }
      const ev = await fetchLedgerEvents(supabase, { toIso: bounds.toIso, warehouseId: warehouseId || undefined, itemIds })
      if (cancelled) return
      if (ev === null) toast.error(t('productionErrors.unknown'))
      setRpcRows(null)
      setEvents(ev ?? [])
      done()
    })()
    return () => { cancelled = true }
  }, [range, bounds, warehouseId, groupId, itemIds, refsLoading, t])

  const rows = useMemo(() => {
    const agg = rpcRows
      ? (groupBy === 'warehouse' ? rpcRows : mergeTurnoverByItem(rpcRows)).filter(r => !itemId || r.itemId === itemId)
      : aggregateTurnover(events, {
        fromMs: bounds.fromIso ? new Date(bounds.fromIso).getTime() : null,
        toMs: new Date(bounds.toIso).getTime(),
        byWarehouse: groupBy === 'warehouse',
      })
    const q = search.trim().toLowerCase()
    return agg
      .map(r => ({ ...r, item: itemById.get(r.itemId), warehouseName: r.warehouseId ? warehouseById.get(r.warehouseId)?.name ?? '' : '' }))
      .filter(r => !q || (r.item?.name ?? '').toLowerCase().includes(q) || (r.item?.sku ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.item?.name ?? '').localeCompare(b.item?.name ?? '') || a.warehouseName.localeCompare(b.warehouseName))
  }, [rpcRows, itemId, events, bounds, groupBy, search, itemById, warehouseById])

  const totals = useMemo(() => rows.reduce((s, r) => ({
    opening: s.opening + r.opening.value,
    inflow: s.inflow + r.inflow.value,
    outflow: s.outflow + r.outflow.value,
    closing: s.closing + r.closing.value,
  }), { opening: 0, inflow: 0, outflow: 0, closing: 0 }), [rows])

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const byWarehouse = groupBy === 'warehouse'
  const colCount = byWarehouse ? 6 : 5

  const itemOptions = useMemo(() => [
    { value: '', label: t('prodReports.common.allItems') },
    ...items.filter(i => !groupId || i.groupId === groupId).map(i => ({ value: i.id, label: i.name, sublabel: i.sku || undefined })),
  ], [items, groupId, t])

  function toggleRow(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function exportXlsx() {
    const headers = [
      t('production.common.item'), ...(byWarehouse ? [t('production.common.warehouse')] : []), t('production.common.unit'),
      `${t('prodReports.turnover.opening')} (${t('production.common.qty')})`, `${t('prodReports.turnover.opening')} (UZS)`,
      `${t('prodReports.turnover.inflow')} (${t('production.common.qty')})`, `${t('prodReports.turnover.inflow')} (UZS)`,
      `${t('prodReports.turnover.outflow')} (${t('production.common.qty')})`, `${t('prodReports.turnover.outflow')} (UZS)`,
      `${t('prodReports.turnover.closing')} (${t('production.common.qty')})`, `${t('prodReports.turnover.closing')} (UZS)`,
    ]
    downloadXlsx('oborot', headers, rows.map(r => [
      r.item?.name ?? '', ...(byWarehouse ? [r.warehouseName] : []), r.item ? t(unitKey(r.item.unit)) : '',
      x3(r.opening.qty), x2(r.opening.value), x3(r.inflow.qty), x2(r.inflow.value),
      x3(r.outflow.qty), x2(r.outflow.value), x3(r.closing.qty), x2(r.closing.value),
    ]), t('prodReports.turnover.title'))
  }

  function reset() {
    setRange(monthToDate())
    setWarehouseId('')
    setGroupId('')
    setItemId('')
    setSearch('')
  }

  const busy = loading || refsLoading

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodReports.turnover.title')}
        subtitle={t('prodReports.turnover.subtitle')}
        range={range}
        onRangeChange={r => setRange(r)}
        onExport={rows.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
        <FilterSelect value={warehouseId} onChange={setWarehouseId}>
          <option value="">{t('production.common.allWarehouses')}</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </FilterSelect>
        <FilterSelect value={groupId} onChange={v => { setGroupId(v); setItemId('') }} className="w-44">
          <option value="">{t('prodReports.common.allGroups')}</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </FilterSelect>
        <div className="w-56"><SearchSelect options={itemOptions} value={itemId} onChange={setItemId} placeholder={t('prodReports.common.allItems')} /></div>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.common.searchItem')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <Segmented
          className="ml-auto"
          options={[
            { value: 'item' as const, label: t('prodReports.common.byItem') },
            { value: 'warehouse' as const, label: t('prodReports.common.byItemWarehouse') },
          ]}
          value={groupBy}
          onChange={v => { setGroupBy(v); setExpanded(new Set()); setPage(1) }}
        />
        <button type="button" onClick={reset} className="text-[13px] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">{t('production.common.reset')}</button>
      </ReportHeader>

      <ProdKpiGrid items={[
        { label: t('prodReports.turnover.opening'), value: formatPrice(totals.opening), icon: Wallet },
        { label: t('prodReports.turnover.inflow'), value: formatPrice(totals.inflow), icon: ArrowDownCircle },
        { label: t('prodReports.turnover.outflow'), value: formatPrice(totals.outflow), icon: ArrowUpCircle },
        { label: t('prodReports.turnover.closing'), value: formatPrice(totals.closing), icon: Boxes },
      ]} />

      <TableCard loading={busy} empty={rows.length === 0} emptyText={t('prodReports.common.empty')} emptyIcon={Boxes}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.item')}</th>
              {byWarehouse && <th className={thCls}>{t('production.common.warehouse')}</th>}
              <th className={thRightCls}>{t('prodReports.turnover.opening')}</th>
              <th className={thRightCls}>{t('prodReports.turnover.inflow')}</th>
              <th className={thRightCls}>{t('prodReports.turnover.outflow')}</th>
              <th className={thRightCls}>{t('prodReports.turnover.closing')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => {
              const unit = r.item ? t(unitKey(r.item.unit)) : ''
              const q = (n: number) => `${formatQty(n)} ${unit}`
              const open = expanded.has(r.key)
              const docTypes = [...r.byDocType.keys()].sort((a, b) => docOrder(a) - docOrder(b))
              return (
                <Fragment key={r.key}>
                  <tr className={cn(trCls, 'cursor-pointer')} onClick={() => toggleRow(r.key)}>
                    <td className={tdCls}>
                      <div className="flex items-start gap-1.5">
                        <span className="mt-0.5"><ExpandChevron open={open} onClick={() => toggleRow(r.key)} label={t('prodReports.turnover.byDocType')} /></span>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 dark:text-gray-100">{r.item?.name ?? '—'}</p>
                          {r.item?.sku && <p className="text-xs text-gray-400 dark:text-gray-500">{r.item.sku}</p>}
                        </div>
                      </div>
                    </td>
                    {byWarehouse && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.warehouseName || '—'}</td>}
                    <td className={tdCls}><QtyValueCell qty={q(r.opening.qty)} value={formatPrice(r.opening.value)} muted /></td>
                    <td className={tdCls}><QtyValueCell qty={q(r.inflow.qty)} value={formatPrice(r.inflow.value)} /></td>
                    <td className={tdCls}><QtyValueCell qty={q(r.outflow.qty)} value={formatPrice(r.outflow.value)} /></td>
                    <td className={tdCls}><QtyValueCell qty={<span className={cn('font-medium', r.closing.qty < 0 && 'text-red-600 dark:text-red-400')}>{q(r.closing.qty)}</span>} value={formatPrice(r.closing.value)} /></td>
                  </tr>
                  {open && (
                    <tr className="border-b border-gray-50 dark:border-gray-800/60 bg-gray-50 dark:bg-gray-800/40">
                      <td colSpan={colCount} className="px-4 py-3">
                        {docTypes.length === 0 ? (
                          <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('prodReports.turnover.noPeriodMoves')}</p>
                        ) : (
                          <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                            <table className="w-full text-[13px]">
                              <thead>
                                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('prodReports.common.docType')}</th>
                                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('prodReports.turnover.inflow')}</th>
                                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('prodReports.turnover.outflow')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {docTypes.map(d => {
                                  const f = r.byDocType.get(d)!
                                  return (
                                    <tr key={d} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                                      <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{t(docTypeKey(d))}</td>
                                      <td className="px-3 py-2"><QtyValueCell qty={q(f.in.qty)} value={formatPrice(f.in.value)} /></td>
                                      <td className="px-3 py-2"><QtyValueCell qty={q(f.out.qty)} value={formatPrice(f.out.value)} /></td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
              <td colSpan={byWarehouse ? 2 : 1} className="px-4 py-3">{t('production.common.total')}</td>
              <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(totals.opening)}</td>
              <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(totals.inflow)}</td>
              <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(totals.outflow)}</td>
              <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(totals.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </TableCard>
      {rows.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={rows.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodReports.turnover.note')}</p>
    </div>
  )
}
