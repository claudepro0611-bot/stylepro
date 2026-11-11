'use client'

// Muddat: lots that still hold stock and carry an expiry date, bucketed
// expired / within 3 days / within 7 days / later, with value. Each lot links
// to its trace page.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CalendarClock, Hourglass, Search, TimerOff } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { ReportHeader, ReportTable, type ReportColumn } from '@/components/reports/ReportKit'
import { BackLink, Segmented, prodFieldCls } from '@/components/production/ProdKit'
import { FilterSelect, ProdKpiGrid } from '@/components/production/ReportKit'
import { LotExpiry, LotNo } from '@/components/production/LotPicker'
import { useProdRefs } from '@/components/production/useProdRefs'
import { LOT_COLUMNS, expiryWarnDaysOf, formatQty, mapLot, unitKey, type LotColumnsRow, type ProdItem, type ProdLot } from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { EXPIRY_BUCKETS, daysUntil, downloadXlsx, expiryBucket, lotTraceHref, x2, x3, type ExpiryBucket } from '@/lib/production-reports'

interface Row extends ProdLot { item: ProdItem | undefined; warehouseName: string; bucket: ExpiryBucket; days: number }

const BUCKET_TONE: Record<ExpiryBucket, 'negative' | 'warning' | undefined> = { expired: 'negative', d3: 'warning', d7: 'warning', later: undefined }

export default function ExpiryReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { warehouses, groups, itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const [lots, setLots] = useState<ProdLot[]>([])
  const [loading, setLoading] = useState(true)
  const [warehouseId, setWarehouseId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [bucket, setBucket] = useState<ExpiryBucket | 'all'>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    fetchAllRows<LotColumnsRow>((from, to) => {
      let q = supabase.from('prod_lot_stock').select(LOT_COLUMNS).gt('remaining_qty', 0).not('expiry_date', 'is', null)
      if (warehouseId) q = q.eq('warehouse_id', warehouseId)
      return q.order('expiry_date').order('lot_no').range(from, to)
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) toast.error(t('productionErrors.unknown'))
      setLots(data.filter(r => r.id).map(mapLot))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [warehouseId, t])

  const today = localYmd()
  const all = useMemo<Row[]>(() => lots.map(l => ({
    ...l,
    item: itemById.get(l.itemId),
    warehouseName: warehouseById.get(l.warehouseId)?.name ?? '',
    bucket: expiryBucket(l.expiryDate as string, today, expiryWarnDaysOf(itemById.get(l.itemId))),
    days: daysUntil(l.expiryDate as string, today),
  })), [lots, itemById, warehouseById, today])

  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase()
    return all
      .filter(r => !groupId || r.item?.groupId === groupId)
      .filter(r => !q || (r.item?.name ?? '').toLowerCase().includes(q) || r.lotNo.toLowerCase().includes(q) || r.supplierName.toLowerCase().includes(q))
  }, [all, groupId, search])

  const sums = useMemo(() => {
    const m = new Map<ExpiryBucket, { count: number; value: number }>(EXPIRY_BUCKETS.map(b => [b, { count: 0, value: 0 }]))
    for (const r of scoped) { const s = m.get(r.bucket)!; s.count++; s.value += r.value }
    return m
  }, [scoped])

  const rows = useMemo(() => (bucket === 'all' ? scoped : scoped.filter(r => r.bucket === bucket)), [scoped, bucket])
  const bucketLabel = (b: ExpiryBucket) => t(`prodReports.expiry.bucket.${b}`)

  const columns: ReportColumn<Row>[] = [
    {
      key: 'lot', label: t('production.lots.lotNo'), sortValue: r => r.lotNo,
      render: r => <Link href={lotTraceHref(r.id)} className="hover:opacity-70 transition-opacity"><LotNo lot={r} /></Link>,
      footer: t('production.common.total'),
    },
    { key: 'item', label: t('production.common.item'), sortValue: r => r.item?.name ?? '', render: r => <span className="text-gray-900 dark:text-gray-100">{r.item?.name ?? '—'}</span> },
    { key: 'warehouse', label: t('production.common.warehouse'), sortValue: r => r.warehouseName, render: r => <span className="text-gray-500 dark:text-gray-400">{r.warehouseName || '—'}</span> },
    { key: 'supplier', label: t('production.lots.supplier'), sortValue: r => r.supplierName, render: r => <span className="text-gray-500 dark:text-gray-400">{r.supplierName || '—'}</span> },
    { key: 'received', label: t('production.lots.received'), sortValue: r => r.receivedAt, render: r => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(r.receivedAt)}</span> },
    { key: 'expiry', label: t('production.lots.expiry'), sortValue: r => r.expiryDate ?? '', render: r => <LotExpiry date={r.expiryDate} today={today} warnDays={expiryWarnDaysOf(r.item)} /> },
    {
      key: 'days', label: t('prodReports.expiry.daysLeft'), align: 'right', sortValue: r => r.days,
      render: r => <span className={cn(r.bucket === 'expired' ? 'text-red-600 dark:text-red-400' : r.bucket === 'd3' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300')}>{r.days}</span>,
    },
    {
      key: 'qty', label: t('production.lots.remaining'), align: 'right', sortValue: r => r.remainingQty,
      render: r => <span className="text-gray-900 dark:text-gray-100">{formatQty(r.remainingQty)} {r.item ? t(unitKey(r.item.unit)) : ''}</span>,
    },
    { key: 'fat', label: t('production.lots.fat'), align: 'right', sortValue: r => r.fatPct ?? -1, render: r => <span className="text-gray-500 dark:text-gray-400">{r.fatPct === null ? '—' : formatPct(r.fatPct)}</span> },
    {
      key: 'value', label: t('production.stock.value'), align: 'right', sortValue: r => r.value,
      render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.value)}</span>,
      footer: formatPrice(rows.reduce((s, r) => s + r.value, 0)),
    },
  ]

  function exportXlsx() {
    downloadXlsx('muddat', [
      t('production.lots.lotNo'), t('production.common.item'), t('production.common.warehouse'), t('production.lots.supplier'),
      t('production.lots.received'), t('production.lots.expiry'), t('prodReports.expiry.daysLeft'), t('prodReports.expiry.bucketCol'),
      t('production.lots.remaining'), t('production.common.unit'), t('production.lots.fat'), `${t('production.lots.unitCost')} (UZS)`, `${t('production.stock.value')} (UZS)`,
    ], rows.map(r => [
      r.lotNo, r.item?.name ?? '', r.warehouseName, r.supplierName, localYmd(new Date(r.receivedAt)), r.expiryDate, r.days, bucketLabel(r.bucket),
      x3(r.remainingQty), r.item ? t(unitKey(r.item.unit)) : '', r.fatPct ?? '', x2(r.unitCost), x2(r.value),
    ]), t('prodReports.expiry.title'))
  }

  const icons = { expired: TimerOff, d3: AlertTriangle, d7: Hourglass, later: CalendarClock }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodReports.expiry.title')}
        subtitle={t('prodReports.expiry.subtitle')}
        range={null}
        onExport={rows.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
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
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('prodReports.expiry.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <Segmented
          className="ml-auto"
          options={[
            { value: 'all' as const, label: t('prodReports.common.all') },
            ...EXPIRY_BUCKETS.map(b => ({ value: b, label: bucketLabel(b) })),
          ]}
          value={bucket}
          onChange={setBucket}
        />
      </ReportHeader>

      <ProdKpiGrid items={EXPIRY_BUCKETS.map(b => ({
        label: bucketLabel(b),
        value: formatPrice(sums.get(b)!.value),
        sub: `${sums.get(b)!.count} ${t('production.lots.lotsShort')}`,
        icon: icons[b],
        tone: sums.get(b)!.count > 0 ? BUCKET_TONE[b] : undefined,
      }))} />

      <ReportTable
        rows={rows}
        columns={columns}
        rowKey={r => r.id}
        loading={loading || refsLoading}
        emptyText={t('prodReports.expiry.empty')}
        initialSort={{ key: 'days', dir: 'asc' }}
        pageSize={50}
      />
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodReports.expiry.note')}</p>
    </div>
  )
}
