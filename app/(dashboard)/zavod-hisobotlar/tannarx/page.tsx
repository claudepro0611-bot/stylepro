'use client'

// "To'liq tannarx": per produced item and month, the material cost of the
// posted production outputs plus the allocated overhead
// (prod_product_costs_month, migration 20261110000018), compared with the
// item's sale price and standard cost. Stock itself stays at material cost.
// Owner / admin only: proxy.ts (OWNER_ADMIN_PATHS + 'prod_stock').

import { useEffect, useMemo, useState } from 'react'
import { Factory, Layers, PieChart, Scale } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { ReportTable, type ReportColumn } from '@/components/reports/ReportKit'
import { BackLink, prodCardCls, prodFieldCls } from '@/components/production/ProdKit'
import { ExportButton, ProdKpiGrid } from '@/components/production/ReportKit'
import { AcctNote } from '@/components/production/AccountingKit'
import { useRole } from '@/components/production/ControlKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { isOwnerAdminRole, todayYmd } from '@/lib/production-controls'
import { formatQty, round2, unitKey } from '@/lib/production'
import { formatMarginPct, marginPct } from '@/lib/sales'
import { downloadXlsx, x2, x3 } from '@/lib/production-reports'
import { fetchProductCosts, monthStart, type ProductCostRow } from '@/lib/production-accounting'

interface Row extends ProductCostRow {
  name: string
  salePrice: number | null
  standardCost: number | null
  unitMargin: number | null
  vsStandard: number | null
}

const money = (v: number | null, f: (n: number) => string) => (v === null ? '—' : f(v))

export default function FullCostReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const role = useRole()
  const allowed = isOwnerAdminRole(role)
  const { itemById, loading: refsLoading } = useProdRefs()

  const [month, setMonth] = useState('')
  const [data, setData] = useState<ProductCostRow[]>([])
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)

  useEffect(() => { setMonth(todayYmd().slice(0, 7)) }, [])

  useEffect(() => {
    if (!allowed || !month) return
    let alive = true
    setLoading(true)
    fetchProductCosts(createClient(), { month: monthStart(month) }).then(r => {
      if (!alive) return
      if (r === null) setMissing(true)
      setData(r ?? [])
      setLoading(false)
    }).catch(() => { if (alive) { toast.error(t('productionErrors.unknown')); setLoading(false) } })
    return () => { alive = false }
  }, [allowed, month, t])

  const rows = useMemo<Row[]>(() => data.map(r => {
    const item = itemById.get(r.itemId)
    const salePrice = item?.salePrice ?? null
    const standardCost = item?.standardCost ?? null
    return {
      ...r,
      name: item?.name ?? r.itemName,
      salePrice,
      standardCost,
      unitMargin: salePrice !== null && r.fullUnitCost !== null ? round2(salePrice - r.fullUnitCost) : null,
      vsStandard: standardCost !== null && r.fullUnitCost !== null ? round2(r.fullUnitCost - standardCost) : null,
    }
  }), [data, itemById])

  const sum = useMemo(() => rows.reduce((s, r) => ({
    material: s.material + r.materialCost, overhead: s.overhead + r.overhead, full: s.full + r.fullCost,
  }), { material: 0, overhead: 0, full: 0 }), [rows])

  const columns: ReportColumn<Row>[] = [
    { key: 'name', label: t('production.common.item'), sortValue: r => r.name, render: r => <span className="text-gray-900 dark:text-gray-100">{r.name}</span>, footer: t('production.common.total') },
    {
      key: 'qty', label: t('production.common.qty'), align: 'right', sortValue: r => r.qty,
      render: r => <span className="text-gray-700 dark:text-gray-300">{formatQty(r.qty)} {r.itemUnit ? t(unitKey(r.itemUnit)) : ''}</span>,
    },
    { key: 'material', label: t('prodAcct.costReport.material'), align: 'right', sortValue: r => r.materialCost, render: r => <span className="text-gray-500 dark:text-gray-400">{formatPrice(r.materialCost)}</span>, footer: formatPrice(sum.material) },
    { key: 'overhead', label: t('prodAcct.pools.overhead'), align: 'right', sortValue: r => r.overhead, render: r => <span className="text-gray-500 dark:text-gray-400">{formatPrice(r.overhead)}</span>, footer: formatPrice(sum.overhead) },
    { key: 'full', label: t('prodAcct.costReport.full'), align: 'right', sortValue: r => r.fullCost, render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.fullCost)}</span>, footer: formatPrice(sum.full) },
    { key: 'materialUnit', label: t('prodAcct.costReport.materialUnit'), align: 'right', sortValue: r => r.materialUnitCost ?? -1, render: r => <span className="text-gray-500 dark:text-gray-400">{money(r.materialUnitCost, formatPrice)}</span> },
    { key: 'fullUnit', label: t('prodAcct.costReport.fullUnit'), align: 'right', sortValue: r => r.fullUnitCost ?? -1, render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{money(r.fullUnitCost, formatPrice)}</span> },
    { key: 'salePrice', label: t('prodAcct.costReport.salePrice'), align: 'right', sortValue: r => r.salePrice ?? -1, render: r => <span className="text-gray-500 dark:text-gray-400">{money(r.salePrice, formatPrice)}</span> },
    {
      key: 'unitMargin', label: t('prodAcct.costReport.unitMargin'), align: 'right', sortValue: r => r.unitMargin ?? -1e12,
      render: r => r.unitMargin === null ? <span className="text-gray-400">—</span> : (
        <span className={r.unitMargin < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}>
          {formatPrice(r.unitMargin)}
          <span className="ml-1 text-[11px] text-gray-400 dark:text-gray-500">{formatMarginPct(marginPct(r.unitMargin, r.salePrice ?? 0))}</span>
        </span>
      ),
    },
    { key: 'standard', label: t('prodAcct.costReport.standardCost'), align: 'right', sortValue: r => r.standardCost ?? -1, render: r => <span className="text-gray-500 dark:text-gray-400">{money(r.standardCost, formatPrice)}</span> },
    {
      key: 'vsStandard', label: t('prodAcct.costReport.vsStandard'), align: 'right', sortValue: r => r.vsStandard ?? -1e12,
      render: r => r.vsStandard === null ? <span className="text-gray-400">—</span> : (
        <span className={r.vsStandard > 0 ? 'text-red-600 dark:text-red-400' : r.vsStandard < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'}>
          {r.vsStandard > 0 ? '+' : ''}{formatPrice(r.vsStandard)}
        </span>
      ),
    },
  ]

  function exportXlsx() {
    downloadXlsx(`tannarx_${month}`, [
      t('production.common.item'), t('production.common.qty'), t('production.common.unit'),
      `${t('prodAcct.costReport.material')} (UZS)`, `${t('prodAcct.pools.overhead')} (UZS)`, `${t('prodAcct.costReport.full')} (UZS)`,
      t('prodAcct.costReport.materialUnit'), t('prodAcct.costReport.fullUnit'), t('prodAcct.costReport.salePrice'),
      t('prodAcct.costReport.unitMargin'), t('prodAcct.costReport.standardCost'), t('prodAcct.costReport.vsStandard'),
    ], rows.map(r => [
      r.name, x3(r.qty), r.itemUnit ? t(unitKey(r.itemUnit)) : '', x2(r.materialCost), x2(r.overhead), x2(r.fullCost),
      r.materialUnitCost ?? '', r.fullUnitCost ?? '', r.salePrice ?? '', r.unitMargin ?? '', r.standardCost ?? '', r.vsStandard ?? '',
    ]), t('prodAcct.reports.costTitle'))
  }

  if (!allowed || missing) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
        <AcctNote text={!allowed ? t('prodAcct.ownerAdminOnly') : t('prodAcct.notAvailable')} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodAcct.reports.costTitle')}</h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('prodAcct.reports.costSubtitle')}</p>
        </div>
        <ExportButton onClick={exportXlsx} disabled={rows.length === 0} />
      </div>

      <div className={cn(prodCardCls, 'p-3 flex flex-wrap items-center gap-2')}>
        <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-gray-400">
          <span>{t('prodAcct.pools.month')}</span>
          <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className={cn(prodFieldCls, 'w-44')} />
        </label>
      </div>

      <ProdKpiGrid items={[
        { label: t('prodAcct.costReport.material'), value: formatPrice(sum.material), icon: Layers },
        { label: t('prodAcct.pools.overhead'), value: formatPrice(sum.overhead), icon: PieChart },
        { label: t('prodAcct.costReport.full'), value: formatPrice(sum.full), icon: Scale },
        { label: t('prodAcct.costReport.items'), value: String(rows.length), icon: Factory },
      ]} />

      <ReportTable
        rows={rows}
        columns={columns}
        rowKey={r => r.itemId}
        loading={loading || refsLoading}
        emptyText={t('prodReports.common.empty')}
        initialSort={{ key: 'full', dir: 'desc' }}
        pageSize={50}
      />
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodAcct.pools.inventoryNote')}</p>
    </div>
  )
}
