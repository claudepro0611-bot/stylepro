'use client'

// Sut qabuli (raw milk intake) list: today's intakes by default. Two action
// cards (waiting for the lab, rejected - a click filters the table); the
// period totals (kg, litres, avg fat, credited, amount) sit in the table's
// totals row. Rows open /sut-qabuli/[id] (lab results + decision).

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Ban, FlaskConical, Milk, Plus, Search, Settings } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { Pagination } from '@/components/ui/Pagination'
import {
  ColumnSettings, DocActions, FilterBar, TableCard, useHiddenColumns,
  prodFieldCls, secondaryBtnCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdSuppliers } from '@/components/production/SupplierKit'
import { AntibioticBadge, MilkKpi, MilkSetupBanner, MilkStatusBadge, useCancelMilkIntake, useHasPermission, useMilkSettings } from '@/components/production/MilkKit'
import { formatQty, rangeToIsoBounds, round2, round3 } from '@/lib/production'
import { MILK_STATUSES, antibioticKey, formatPct, isStockStatus, milkStatusKey, type MilkIntakeRow } from '@/lib/milk'
import { ExportButton } from '@/components/production/ReportKit'
import { dateTimeCell, downloadXlsx, x2, x3 } from '@/lib/production-reports'

const PAGE_SIZE = 50

type Row = Pick<MilkIntakeRow,
  'id' | 'number' | 'intake_date' | 'supplier_id' | 'vehicle_no' | 'net_kg' | 'volume_l' | 'fat_pct' | 'protein_pct' |
  'acidity' | 'antibiotic' | 'status' | 'credited_kg' | 'amount'>

function today(): DateRangeValue {
  const d = localYmd()
  return { from: d, to: d }
}

export default function MilkIntakeListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { suppliers } = useProdSuppliers()
  const { configured, loading: settingsLoading } = useMilkSettings()
  const supplierNameById = useMemo(() => new Map(suppliers.map(s => [s.id, s.name])), [suppliers])
  const canLab = useHasPermission('prod_lab')

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(today)
  const [supplierId, setSupplierId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows<Row>((from, to) => {
      let q = supabase.from('prod_milk_intakes')
        .select('id, number, intake_date, supplier_id, vehicle_no, net_kg, volume_l, fat_pct, protein_pct, acidity, antibiotic, status, credited_kg, amount')
      if (bounds) q = q.gte('intake_date', bounds.fromIso).lt('intake_date', bounds.toIso)
      if (supplierId) q = q.eq('supplier_id', supplierId)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [range, supplierId, status, t])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelMilkIntake(load)
  const { isVisible, toggle } = useHiddenColumns('sut-qabuli')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^#/, '')
    if (!q) return rows
    return rows.filter(r => String(r.number).includes(q) || (r.vehicle_no ?? '').toLowerCase().replace(/\s/g, '').includes(q.replace(/\s/g, '')))
  }, [rows, search])

  const kpi = useMemo(() => {
    let netKg = 0, litres = 0, credited = 0, amount = 0, fatWeighted = 0, fatKg = 0, rejectedKg = 0, rejectedCount = 0, waiting = 0
    for (const r of filtered) {
      const net = Number(r.net_kg)
      if (isStockStatus(r.status)) {
        netKg += net
        litres += Number(r.volume_l ?? 0)
        credited += Number(r.credited_kg ?? 0)
        amount += Number(r.amount ?? 0)
        if (r.fat_pct !== null) { fatWeighted += net * Number(r.fat_pct); fatKg += net }
      } else if (r.status === 'rejected') {
        rejectedKg += net
        rejectedCount += 1
      } else if (r.status === 'weighed') {
        waiting += 1
      }
    }
    return {
      netKg: round3(netKg), litres: round3(litres), credited: round3(credited), amount: round2(amount),
      avgFat: fatKg > 0 ? fatWeighted / fatKg : null, rejectedKg: round3(rejectedKg), rejectedCount, waiting,
    }
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const kg = t('production.units.kg')
  const columns = [
    { key: 'date', label: t('production.milk.dateTime') },
    { key: 'supplier', label: t('production.milk.supplier') },
    { key: 'vehicle', label: t('production.milk.vehicle') },
    { key: 'net', label: t('production.milk.netKg') },
    { key: 'litres', label: t('production.milk.litres') },
    { key: 'fat', label: t('production.milk.fat') },
    { key: 'protein', label: t('production.milk.protein') },
    { key: 'acidity', label: t('production.milk.acidity') },
    { key: 'antibiotic', label: t('production.milk.antibiotic') },
    { key: 'status', label: t('production.common.status') },
    { key: 'credited', label: t('production.milk.credited') },
    { key: 'amount', label: t('production.milk.amount') },
  ]

  function exportXlsx() {
    downloadXlsx('sut_qabuli', [
      t('production.common.number'), t('production.milk.dateTime'), t('production.milk.supplier'), t('production.milk.vehicleNo'),
      `${t('production.milk.netKg')} (${kg})`, `${t('prodReports.print.volume')} (${t('production.units.l')})`, t('production.milk.fat'), t('production.milk.protein'),
      t('production.milk.acidity'), t('production.milk.antibiotic'), t('production.common.status'), `${t('production.milk.credited')} (${kg})`, `${t('production.milk.amount')} (UZS)`,
    ], filtered.map(r => [
      r.number, dateTimeCell(r.intake_date), supplierNameById.get(r.supplier_id) ?? '', r.vehicle_no ?? '', x3(Number(r.net_kg)),
      r.volume_l === null ? '' : x3(Number(r.volume_l)), r.fat_pct === null ? '' : Number(r.fat_pct), r.protein_pct === null ? '' : Number(r.protein_pct),
      r.acidity === null ? '' : Number(r.acidity), r.antibiotic ? t(antibioticKey(r.antibiotic)) : '', t(milkStatusKey(r.status)),
      r.credited_kg === null ? '' : x3(Number(r.credited_kg)), r.amount === null ? '' : x2(Number(r.amount)),
    ]), t('production.milk.title'))
  }

  function reset() {
    setRange(today())
    setSupplierId('')
    setStatus('')
    setSearch('')
  }

  const supplierOptions = useMemo(() => [
    { value: '', label: t('production.suppliers.allSuppliers') },
    ...suppliers.map(s => ({ value: s.id, label: s.name })),
  ], [suppliers, t])

  const num = (v: number | null, fmt: (n: number) => string = formatQty) => (v === null ? '—' : fmt(Number(v)))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('production.milk.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {canLab && (
            <Link href="/sut-qabuli/laboratoriya" className={secondaryBtnCls}>
              <FlaskConical className="h-3.5 w-3.5" /> {t('prodOps.tablet.labTitle')}
            </Link>
          )}
          <Link href="/sut-qabuli/sozlamalar" className={secondaryBtnCls}>
            <Settings className="h-3.5 w-3.5" /> {t('production.milk.settings')}
          </Link>
          <Link
            href="/sut-qabuli/yangi"
            className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            <Plus className="h-4 w-4" /> {t('production.milk.new')}
          </Link>
        </div>
      </div>

      {!settingsLoading && !configured && <MilkSetupBanner />}

      <div className="grid grid-cols-2 gap-4 lg:max-w-xl">
        <button type="button" onClick={() => setStatus(status === 'weighed' ? '' : 'weighed')} aria-pressed={status === 'weighed'} className={cn('text-left rounded-xl transition-all duration-200 hover:shadow-md', status === 'weighed' && 'ring-1 ring-gray-400 dark:ring-gray-500')}>
          <MilkKpi icon={FlaskConical} label={t('production.milk.kpiWaitingLab')} value={String(kpi.waiting)} />
        </button>
        <button type="button" onClick={() => setStatus(status === 'rejected' ? '' : 'rejected')} aria-pressed={status === 'rejected'} className={cn('text-left rounded-xl transition-all duration-200 hover:shadow-md', status === 'rejected' && 'ring-1 ring-gray-400 dark:ring-gray-500')}>
          <MilkKpi icon={Ban} label={t('production.milk.kpiRejected')} value={`${formatQty(kpi.rejectedKg)} ${kg}`} sub={String(kpi.rejectedCount)} tone={kpi.rejectedCount > 0 ? 'negative' : undefined} />
        </button>
      </div>

      <FilterBar
        onReset={reset}
        columns={<><ExportButton onClick={exportXlsx} disabled={filtered.length === 0} /><ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} /></>}
        moreActive={!!status}
        more={(
          <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-44')}>
            <option value="">{t('production.common.allStatuses')}</option>
            {MILK_STATUSES.map(s => <option key={s} value={s}>{t(milkStatusKey(s))}</option>)}
          </select>
        )}
      >
        <DateRangeFilter value={range} onChange={setRange} />
        <div className="w-full sm:w-56">
          <SearchSelect options={supplierOptions} value={supplierId} onChange={setSupplierId} placeholder={t('production.suppliers.allSuppliers')} />
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.milk.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.milk.empty')} emptyIcon={Milk}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.number')}</th>
              {isVisible('date') && <th className={thCls}>{t('production.milk.dateTime')}</th>}
              {isVisible('supplier') && <th className={thCls}>{t('production.milk.supplier')}</th>}
              {isVisible('vehicle') && <th className={thCls}>{t('production.milk.vehicle')}</th>}
              {isVisible('net') && <th className={thRightCls}>{t('production.milk.netKg')}</th>}
              {isVisible('litres') && <th className={thRightCls}>{t('production.milk.litres')}</th>}
              {isVisible('fat') && <th className={thRightCls}>{t('production.milk.fat')}</th>}
              {isVisible('protein') && <th className={thRightCls}>{t('production.milk.protein')}</th>}
              {isVisible('acidity') && <th className={thRightCls}>{t('production.milk.acidity')}</th>}
              {isVisible('antibiotic') && <th className={thCls}>{t('production.milk.antibiotic')}</th>}
              {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
              {isVisible('credited') && <th className={thRightCls}>{t('production.milk.credited')}</th>}
              {isVisible('amount') && <th className={thRightCls}>{t('production.milk.amount')}</th>}
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => (
              <tr key={r.id} onClick={() => router.push(`/sut-qabuli/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                {isVisible('date') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.intake_date)}</td>}
                {isVisible('supplier') && <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{supplierNameById.get(r.supplier_id) ?? '—'}</td>}
                {isVisible('vehicle') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{r.vehicle_no || '—'}</td>}
                {isVisible('net') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatQty(Number(r.net_kg))}</td>}
                {isVisible('litres') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{num(r.volume_l)}</td>}
                {isVisible('fat') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatPct(r.fat_pct)}</td>}
                {isVisible('protein') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatPct(r.protein_pct)}</td>}
                {isVisible('acidity') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{num(r.acidity, n => String(n))}</td>}
                {isVisible('antibiotic') && <td className={tdCls}><AntibioticBadge value={r.antibiotic} /></td>}
                {isVisible('status') && <td className={tdCls}><MilkStatusBadge status={r.status} /></td>}
                {isVisible('credited') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{num(r.credited_kg)}</td>}
                {isVisible('amount') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{r.amount === null ? '—' : formatPrice(Number(r.amount))}</td>}
                <td className={tdCls}>
                  <DocActions
                    viewHref={`/sut-qabuli/${r.id}`}
                    canCancel={canCancel}
                    posted={r.status !== 'cancelled'}
                    busy={busyId === r.id}
                    onCancel={() => cancel(r.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-100 dark:border-gray-800 text-sm font-medium text-gray-900 dark:text-gray-100">
              <td className={cn(tdCls, 'whitespace-nowrap')}>{t('prodUx.total')} <span className="font-normal text-gray-500 dark:text-gray-400">({t('production.milk.kpiAccepted').toLowerCase()})</span></td>
              {isVisible('date') && <td className={tdCls} />}
              {isVisible('supplier') && <td className={tdCls} />}
              {isVisible('vehicle') && <td className={tdCls} />}
              {isVisible('net') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatQty(kpi.netKg)}</td>}
              {isVisible('litres') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatQty(kpi.litres)}</td>}
              {isVisible('fat') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{kpi.avgFat === null ? '—' : formatPct(kpi.avgFat)}</td>}
              {isVisible('protein') && <td className={tdCls} />}
              {isVisible('acidity') && <td className={tdCls} />}
              {isVisible('antibiotic') && <td className={tdCls} />}
              {isVisible('status') && <td className={tdCls} />}
              {isVisible('credited') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatQty(kpi.credited)}</td>}
              {isVisible('amount') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{formatPrice(kpi.amount)}</td>}
              <td className={tdCls} />
            </tr>
          </tfoot>
        </table>
      </TableCard>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}
    </div>
  )
}
