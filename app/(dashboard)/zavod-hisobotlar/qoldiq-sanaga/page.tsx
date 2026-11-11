'use client'

// Qoldiq sanaga: stock quantity, value and weighted fat as of the end of a
// chosen day. Same ledger math as Oborot (closing balance only).

import { useEffect, useMemo, useState } from 'react'
import { Boxes, Package, Search, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { ReportHeader, ReportTable, type ReportColumn } from '@/components/reports/ReportKit'
import { BackLink, Segmented, prodFieldCls } from '@/components/production/ProdKit'
import { DateField, FilterSelect, ProdKpiGrid } from '@/components/production/ReportKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { formatQty, rangeToIsoBounds, unitKey, type ProdItem } from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { aggregateTurnover, downloadXlsx, fetchLedgerEvents, x2, x3, type LedgerEvent } from '@/lib/production-reports'

type GroupBy = 'item' | 'warehouse'

interface Row {
  key: string
  item: ProdItem | undefined
  warehouseName: string
  qty: number
  value: number
  avgCost: number
  fat: number | null
}

export default function StockAtDatePage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { items, warehouses, groups, itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const today = localYmd()
  const [date, setDate] = useState(today)
  const [warehouseId, setWarehouseId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('warehouse')
  const [search, setSearch] = useState('')
  const [events, setEvents] = useState<LedgerEvent[]>([])
  const [loading, setLoading] = useState(true)

  const toIso = useMemo(() => rangeToIsoBounds({ from: date, to: date }).toIso, [date])
  const itemIds = useMemo(() => (groupId ? items.filter(i => i.groupId === groupId).map(i => i.id) : null), [groupId, items])

  useEffect(() => {
    if (refsLoading) return
    let cancelled = false
    setLoading(true)
    fetchLedgerEvents(createClient(), { toIso, warehouseId: warehouseId || undefined, itemIds }).then(ev => {
      if (cancelled) return
      if (ev === null) toast.error(t('productionErrors.unknown'))
      setEvents(ev ?? [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [toIso, warehouseId, itemIds, refsLoading, t])

  const rows = useMemo<Row[]>(() => {
    const q = search.trim().toLowerCase()
    return aggregateTurnover(events, { fromMs: null, toMs: new Date(toIso).getTime(), byWarehouse: groupBy === 'warehouse' })
      .filter(r => Math.abs(r.closing.qty) > 0.0005)
      .map(r => ({
        key: r.key,
        item: itemById.get(r.itemId),
        warehouseName: r.warehouseId ? warehouseById.get(r.warehouseId)?.name ?? '' : '',
        qty: r.closing.qty,
        value: r.closing.value,
        avgCost: r.closing.qty > 0 ? r.closing.value / r.closing.qty : 0,
        fat: r.closingFat,
      }))
      .filter(r => !q || (r.item?.name ?? '').toLowerCase().includes(q) || (r.item?.sku ?? '').toLowerCase().includes(q))
  }, [events, toIso, groupBy, search, itemById, warehouseById])

  const totalValue = rows.reduce((s, r) => s + r.value, 0)
  const byWarehouse = groupBy === 'warehouse'
  const hasFat = rows.some(r => r.fat !== null)

  const columns: ReportColumn<Row>[] = [
    {
      key: 'item', label: t('production.common.item'), sortValue: r => r.item?.name ?? '',
      render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{r.item?.name ?? '—'}</span>,
      footer: t('production.common.total'),
    },
    ...(byWarehouse ? [{
      key: 'warehouse', label: t('production.common.warehouse'), sortValue: (r: Row) => r.warehouseName,
      render: (r: Row) => <span className="text-gray-500 dark:text-gray-400">{r.warehouseName || '—'}</span>,
    }] : []),
    {
      key: 'qty', label: t('production.common.stockLeft'), align: 'right', sortValue: r => r.qty,
      render: r => <span className={cn('font-medium', r.qty < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')}>{formatQty(r.qty)} {r.item ? t(unitKey(r.item.unit)) : ''}</span>,
    },
    ...(hasFat ? [{
      key: 'fat', label: t('production.stock.fat'), align: 'right' as const, sortValue: (r: Row) => r.fat ?? -1,
      render: (r: Row) => <span className="text-gray-700 dark:text-gray-300">{r.fat === null ? '' : formatPct(r.fat)}</span>,
    }] : []),
    {
      key: 'avg', label: t('production.common.avgCost'), align: 'right', sortValue: r => r.avgCost,
      render: r => <span className="text-gray-500 dark:text-gray-400">{formatPrice(r.avgCost)}</span>,
    },
    {
      key: 'value', label: t('production.stock.value'), align: 'right', sortValue: r => r.value,
      render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.value)}</span>,
      footer: formatPrice(totalValue),
    },
  ]

  function exportXlsx() {
    downloadXlsx(`qoldiq_${date}`, [
      t('production.common.item'), ...(byWarehouse ? [t('production.common.warehouse')] : []), t('production.common.unit'),
      t('production.common.stockLeft'), t('production.stock.fat'), `${t('production.common.avgCost')} (UZS)`, `${t('production.stock.value')} (UZS)`,
    ], rows.map(r => [
      r.item?.name ?? '', ...(byWarehouse ? [r.warehouseName] : []), r.item ? t(unitKey(r.item.unit)) : '',
      x3(r.qty), r.fat === null ? '' : x3(r.fat), x2(r.avgCost), x2(r.value),
    ]), t('prodReports.stockAt.title'))
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodReports.stockAt.title')}
        subtitle={t('prodReports.stockAt.subtitle')}
        range={null}
        onExport={rows.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
        <DateField label={t('prodReports.stockAt.asOf')} value={date} onChange={setDate} max={today} />
        <FilterSelect value={warehouseId} onChange={setWarehouseId}>
          <option value="">{t('production.common.allWarehouses')}</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </FilterSelect>
        <FilterSelect value={groupId} onChange={setGroupId} className="w-44">
          <option value="">{t('prodReports.common.allGroups')}</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </FilterSelect>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('production.common.searchItem')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <Segmented
          className="ml-auto"
          options={[
            { value: 'warehouse' as const, label: t('prodReports.common.byItemWarehouse') },
            { value: 'item' as const, label: t('prodReports.common.byItem') },
          ]}
          value={groupBy}
          onChange={setGroupBy}
        />
      </ReportHeader>

      <ProdKpiGrid cols={3} items={[
        { label: t('production.stock.totalValue'), value: formatPrice(totalValue), icon: Wallet },
        { label: t('production.stock.itemsCount'), value: String(new Set(rows.map(r => r.item?.id ?? r.key)).size), icon: Package },
        { label: t('prodReports.stockAt.rows'), value: String(rows.length), icon: Boxes },
      ]} />

      <ReportTable
        rows={rows}
        columns={columns}
        rowKey={r => r.key}
        loading={loading || refsLoading}
        emptyText={t('prodReports.common.empty')}
        initialSort={{ key: 'value', dir: 'desc' }}
        pageSize={50}
      />
    </div>
  )
}
