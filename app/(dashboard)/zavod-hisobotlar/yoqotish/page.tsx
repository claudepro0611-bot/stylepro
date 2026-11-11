'use client'

// Yo'qotish: technological losses of a period.
//   * Separation: loss_qty per document, valued at that document's milk unit
//     cost (milk_cost / milk_qty).
//   * Production: per product, input kg (mass components, pieces / litres
//     via prod_items.weight_kg; packaging excluded) vs output kg; the loss is
//     valued at the measured components' average cost per kg (estimate).

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Factory, Percent, Scale, Split, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { ReportHeader, ReportTable, monthToDate, type ReportColumn } from '@/components/reports/ReportKit'
import { BackLink, Segmented } from '@/components/production/ProdKit'
import { ProdKpiGrid } from '@/components/production/ReportKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { formatQty, rangeToIsoBounds, type ProdItem } from '@/lib/production'
import { formatPct } from '@/lib/milk'
import { downloadXlsx, fetchByIds, toKg, x2, x3, ymdOf } from '@/lib/production-reports'

type Tab = 'separation' | 'production'

interface SeparationRow { id: string; number: number; doc_date: string; milk_item_id: string; milk_qty: number; milk_fat: number; loss_qty: number; loss_pct: number; milk_cost: number }
interface ProductionRow { id: string; number: number; output_item_id: string; output_qty: number }
interface ComponentRow { production_id: string; item_id: string; qty: number; total: number }

interface SepView extends SeparationRow { item: ProdItem | undefined; unitCost: number; lossValue: number; lossShare: number }

interface ProdLoss {
  itemId: string
  item: ProdItem | undefined
  runs: number
  measuredRuns: number
  inputKg: number
  outputKg: number
  lossKg: number
  lossPct: number | null
  lossValue: number
}

export default function LossReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, loading: refsLoading } = useProdRefs()

  const [tab, setTab] = useState<Tab>('separation')
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [seps, setSeps] = useState<SeparationRow[]>([])
  const [prods, setProds] = useState<ProductionRow[]>([])
  const [comps, setComps] = useState<ComponentRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    ;(async () => {
      const [sRes, pRes] = await Promise.all([
        fetchAllRows<SeparationRow>((from, to) => {
          let q = supabase.from('prod_separations').select('id, number, doc_date, milk_item_id, milk_qty, milk_fat, loss_qty, loss_pct, milk_cost').eq('status', 'posted')
          if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
          return q.order('number').range(from, to)
        }),
        fetchAllRows<ProductionRow>((from, to) => {
          let q = supabase.from('prod_productions').select('id, number, output_item_id, output_qty').eq('status', 'posted')
          if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
          return q.order('number').range(from, to)
        }),
      ])
      const cRes = await fetchByIds<ComponentRow>(pRes.data.map(p => p.id), (chunk, from, to) =>
        supabase.from('prod_production_components').select('production_id, item_id, qty, total').in('production_id', chunk).order('id').range(from, to))
      if (cancelled) return
      if (sRes.error || pRes.error || cRes.error) toast.error(t('productionErrors.unknown'))
      setSeps(sRes.data)
      setProds(pRes.data)
      setComps(cRes.data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, t])

  const sepRows = useMemo<SepView[]>(() => seps.map(s => {
    const milk = Number(s.milk_qty)
    const unitCost = milk > 0 ? Number(s.milk_cost) / milk : 0
    const loss = Number(s.loss_qty)
    return { ...s, item: itemById.get(s.milk_item_id), unitCost, lossValue: loss * unitCost, lossShare: milk > 0 ? (loss / milk) * 100 : 0 }
  }), [seps, itemById])

  const sepTotals = useMemo(() => {
    const milk = sepRows.reduce((s, r) => s + Number(r.milk_qty), 0)
    const loss = sepRows.reduce((s, r) => s + Number(r.loss_qty), 0)
    return { milk, loss, value: sepRows.reduce((s, r) => s + r.lossValue, 0), pct: milk > 0 ? (loss / milk) * 100 : 0 }
  }, [sepRows])

  const prodRows = useMemo<ProdLoss[]>(() => {
    const byDoc = new Map<string, ComponentRow[]>()
    for (const c of comps) {
      const arr = byDoc.get(c.production_id)
      if (arr) arr.push(c)
      else byDoc.set(c.production_id, [c])
    }
    const out = new Map<string, ProdLoss & { measuredCost: number }>()
    for (const p of prods) {
      let r = out.get(p.output_item_id)
      if (!r) {
        r = { itemId: p.output_item_id, item: itemById.get(p.output_item_id), runs: 0, measuredRuns: 0, inputKg: 0, outputKg: 0, lossKg: 0, lossPct: null, lossValue: 0, measuredCost: 0 }
        out.set(p.output_item_id, r)
      }
      r.runs++
      const outKg = toKg(Number(p.output_qty), r.item)
      let inKg = 0
      let cost = 0
      let measurable = outKg !== null
      for (const c of byDoc.get(p.id) ?? []) {
        const item = itemById.get(c.item_id)
        if (item?.itemType === 'packaging') continue
        const kg = toKg(Number(c.qty), item)
        if (kg === null) { measurable = false; break }
        inKg += kg
        cost += Number(c.total)
      }
      if (!measurable || !(inKg > 0)) continue
      r.measuredRuns++
      r.inputKg += inKg
      r.outputKg += outKg as number
      r.measuredCost += cost
    }
    return [...out.values()].map(({ measuredCost, ...r }) => {
      const lossKg = r.inputKg - r.outputKg
      return {
        ...r,
        lossKg,
        lossPct: r.inputKg > 0 ? (lossKg / r.inputKg) * 100 : null,
        lossValue: r.inputKg > 0 ? lossKg * (measuredCost / r.inputKg) : 0,
      }
    })
  }, [prods, comps, itemById])

  const prodTotals = useMemo(() => {
    const input = prodRows.reduce((s, r) => s + r.inputKg, 0)
    const loss = prodRows.reduce((s, r) => s + r.lossKg, 0)
    return { input, loss, value: prodRows.reduce((s, r) => s + r.lossValue, 0), pct: input > 0 ? (loss / input) * 100 : 0 }
  }, [prodRows])

  const kg = t('production.units.kg')
  const qkg = (n: number) => `${formatQty(n)} ${kg}`

  const sepColumns: ReportColumn<SepView>[] = [
    {
      key: 'number', label: t('production.common.number'), sortValue: r => r.number,
      render: r => <Link href={`/separatsiya/${r.id}`} className="font-medium text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">#{r.number}</Link>,
      footer: t('production.common.total'),
    },
    { key: 'date', label: t('production.common.date'), sortValue: r => r.doc_date, render: r => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDateTime(r.doc_date)}</span> },
    { key: 'item', label: t('production.separation.milkItem'), sortValue: r => r.item?.name ?? '', render: r => <span className="text-gray-900 dark:text-gray-100">{r.item?.name ?? '—'}</span> },
    { key: 'milk', label: t('production.separation.milkQty'), align: 'right', sortValue: r => Number(r.milk_qty), render: r => qkg(Number(r.milk_qty)), footer: qkg(sepTotals.milk) },
    { key: 'fat', label: t('production.separation.fatPct'), align: 'right', sortValue: r => Number(r.milk_fat), render: r => <span className="text-gray-500 dark:text-gray-400">{formatPct(Number(r.milk_fat))}</span> },
    { key: 'loss', label: t('production.separation.lossLabel'), align: 'right', sortValue: r => Number(r.loss_qty), render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{qkg(Number(r.loss_qty))}</span>, footer: qkg(sepTotals.loss) },
    { key: 'share', label: t('prodReports.loss.lossPct'), align: 'right', sortValue: r => r.lossShare, render: r => <span className="text-gray-500 dark:text-gray-400">{formatPct(r.lossShare)}%</span>, footer: `${formatPct(sepTotals.pct)}%` },
    { key: 'unit', label: t('prodReports.loss.milkUnitCost'), align: 'right', sortValue: r => r.unitCost, render: r => <span className="text-gray-500 dark:text-gray-400">{formatPrice(r.unitCost)}</span> },
    { key: 'value', label: t('prodReports.loss.lossValue'), align: 'right', sortValue: r => r.lossValue, render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.lossValue)}</span>, footer: formatPrice(sepTotals.value) },
  ]

  const prodColumns: ReportColumn<ProdLoss>[] = [
    { key: 'item', label: t('prodReports.norm.product'), sortValue: r => r.item?.name ?? '', render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{r.item?.name ?? '—'}</span>, footer: t('production.common.total') },
    {
      key: 'runs', label: t('prodReports.norm.runs'), align: 'right', sortValue: r => r.runs,
      render: r => <span className="text-gray-700 dark:text-gray-300">{r.runs}{r.measuredRuns !== r.runs && <span className="text-gray-400"> ({r.measuredRuns})</span>}</span>,
    },
    { key: 'input', label: t('prodReports.loss.inputKg'), align: 'right', sortValue: r => r.inputKg, render: r => qkg(r.inputKg), footer: qkg(prodTotals.input) },
    { key: 'output', label: t('prodReports.loss.outputKg'), align: 'right', sortValue: r => r.outputKg, render: r => qkg(r.outputKg) },
    {
      key: 'loss', label: t('prodReports.loss.lossKg'), align: 'right', sortValue: r => r.lossKg,
      render: r => <span className={cn('font-medium', r.lossKg < 0 ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100')}>{qkg(r.lossKg)}</span>,
      footer: qkg(prodTotals.loss),
    },
    { key: 'pct', label: t('prodReports.loss.lossPct'), align: 'right', sortValue: r => r.lossPct ?? -999, render: r => <span className="text-gray-500 dark:text-gray-400">{r.lossPct === null ? '—' : `${formatPct(r.lossPct)}%`}</span>, footer: `${formatPct(prodTotals.pct)}%` },
    { key: 'value', label: t('prodReports.loss.lossValueEst'), align: 'right', sortValue: r => r.lossValue, render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.lossValue)}</span>, footer: formatPrice(prodTotals.value) },
  ]

  function exportXlsx() {
    if (tab === 'separation') {
      downloadXlsx('yoqotish_separatsiya', [
        t('production.common.number'), t('production.common.date'), t('production.separation.milkItem'), `${t('production.separation.milkQty')} (${kg})`,
        t('production.separation.fatPct'), `${t('production.separation.lossLabel')} (${kg})`, t('prodReports.loss.lossPct'),
        `${t('prodReports.loss.milkUnitCost')} (UZS)`, `${t('prodReports.loss.lossValue')} (UZS)`,
      ], sepRows.map(r => [
        r.number, ymdOf(r.doc_date), r.item?.name ?? '', x3(Number(r.milk_qty)), Number(r.milk_fat), x3(Number(r.loss_qty)),
        x2(r.lossShare), x2(r.unitCost), x2(r.lossValue),
      ]), t('production.separation.title'))
      return
    }
    downloadXlsx('yoqotish_ishlab_chiqarish', [
      t('prodReports.norm.product'), t('prodReports.norm.runs'), t('prodReports.loss.measuredRuns'), `${t('prodReports.loss.inputKg')}`,
      t('prodReports.loss.outputKg'), t('prodReports.loss.lossKg'), t('prodReports.loss.lossPct'), `${t('prodReports.loss.lossValueEst')} (UZS)`,
    ], prodRows.map(r => [
      r.item?.name ?? '', r.runs, r.measuredRuns, x3(r.inputKg), x3(r.outputKg), x3(r.lossKg), r.lossPct === null ? '' : x2(r.lossPct), x2(r.lossValue),
    ]), t('production.productions.title'))
  }

  const busy = loading || refsLoading
  const hasRows = tab === 'separation' ? sepRows.length > 0 : prodRows.length > 0

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodReports.loss.title')}
        subtitle={t('prodReports.loss.subtitle')}
        range={range}
        onRangeChange={setRange}
        onExport={hasRows ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
        <Segmented
          className="ml-auto"
          options={[
            { value: 'separation' as const, label: t('production.separation.title') },
            { value: 'production' as const, label: t('production.productions.title') },
          ]}
          value={tab}
          onChange={setTab}
        />
      </ReportHeader>

      {tab === 'separation' ? (
        <>
          <ProdKpiGrid items={[
            { label: t('prodReports.loss.docs'), value: String(sepRows.length), icon: Split },
            { label: t('production.separation.milkQty'), value: qkg(sepTotals.milk), icon: Scale },
            { label: t('production.separation.lossLabel'), value: qkg(sepTotals.loss), sub: `${formatPct(sepTotals.pct)}%`, icon: Percent },
            { label: t('prodReports.loss.lossValue'), value: formatPrice(sepTotals.value), icon: Wallet, tone: sepTotals.value > 0 ? 'negative' : undefined },
          ]} />
          <ReportTable rows={sepRows} columns={sepColumns} rowKey={r => r.id} loading={busy} emptyText={t('prodReports.common.empty')} initialSort={{ key: 'number', dir: 'desc' }} pageSize={50} />
        </>
      ) : (
        <>
          <ProdKpiGrid items={[
            { label: t('prodReports.norm.runs'), value: String(prodRows.reduce((s, r) => s + r.runs, 0)), icon: Factory },
            { label: t('prodReports.loss.inputKg'), value: qkg(prodTotals.input), icon: Scale },
            { label: t('prodReports.loss.lossKg'), value: qkg(prodTotals.loss), sub: `${formatPct(prodTotals.pct)}%`, icon: Percent },
            { label: t('prodReports.loss.lossValueEst'), value: formatPrice(prodTotals.value), icon: Wallet, tone: prodTotals.value > 0 ? 'negative' : undefined },
          ]} />
          <ReportTable rows={prodRows} columns={prodColumns} rowKey={r => r.itemId} loading={busy} emptyText={t('prodReports.common.empty')} initialSort={{ key: 'loss', dir: 'desc' }} pageSize={50} />
          <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodReports.loss.prodNote')}</p>
        </>
      )}
    </div>
  )
}
