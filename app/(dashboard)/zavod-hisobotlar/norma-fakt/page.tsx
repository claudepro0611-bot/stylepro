'use client'

// Norma-fakt: per finished product over a period - runs, planned (recipe
// norm, prod_production_components.planned_qty) vs actual consumption per
// component, average deviation % and the deviation value
// (qty - planned) x unit_cost. Lines without a norm ("extra") are shown
// separately. A tolerance highlights products that drift beyond it.

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Factory, Scale, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { ReportHeader, monthToDate } from '@/components/reports/ReportKit'
import { BackLink, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls } from '@/components/production/ProdKit'
import { ExpandChevron, ProdKpiGrid } from '@/components/production/ReportKit'
import { useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { parseDecimal, rangeToIsoBounds, round2, unitKey, type ProdItem } from '@/lib/production'
import { downloadXlsx, fetchByIds, x2, x3 } from '@/lib/production-reports'

interface ProductionRow { id: string; number: number; doc_date: string; output_item_id: string; output_qty: number; total_cost: number }
interface ComponentRow { production_id: string; item_id: string; qty: number; unit_cost: number; total: number; planned_qty: number | null }

interface CompAgg {
  itemId: string
  item: ProdItem | undefined
  planned: number
  actual: number
  extraQty: number
  extraValue: number
  devValue: number
  devPcts: number[]
}

interface ProductAgg {
  itemId: string
  item: ProdItem | undefined
  runs: number
  normRuns: number
  outputQty: number
  totalCost: number
  plannedValue: number
  devValue: number
  extraValue: number
  runDevPcts: number[]
  avgDev: number | null
  components: CompAgg[]
  docs: { id: string; number: number; dev: number | null }[]
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)

export default function NormFactReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { smart } = useQtyFormat()
  const { itemById, loading: refsLoading } = useProdRefs()

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [tolerance, setTolerance] = useState('3')
  const [docs, setDocs] = useState<ProductionRow[]>([])
  const [lines, setLines] = useState<ComponentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    ;(async () => {
      const dRes = await fetchAllRows<ProductionRow>((from, to) => {
        let q = supabase.from('prod_productions').select('id, number, doc_date, output_item_id, output_qty, total_cost').eq('status', 'posted')
        if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
        return q.order('number').range(from, to)
      })
      const lRes = await fetchByIds<ComponentRow>(dRes.data.map(d => d.id), (chunk, from, to) =>
        supabase.from('prod_production_components').select('production_id, item_id, qty, unit_cost, total, planned_qty')
          .in('production_id', chunk).order('id').range(from, to))
      if (cancelled) return
      if (dRes.error || lRes.error) toast.error(t('productionErrors.unknown'))
      setDocs(dRes.data)
      setLines(lRes.data)
      setExpanded(new Set())
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, t])

  const tol = parseDecimal(tolerance)

  const products = useMemo<ProductAgg[]>(() => {
    const linesByDoc = new Map<string, ComponentRow[]>()
    for (const l of lines) {
      const arr = linesByDoc.get(l.production_id)
      if (arr) arr.push(l)
      else linesByDoc.set(l.production_id, [l])
    }
    const byProduct = new Map<string, ProductAgg & { comp: Map<string, CompAgg> }>()
    for (const d of docs) {
      let p = byProduct.get(d.output_item_id)
      if (!p) {
        p = {
          itemId: d.output_item_id, item: itemById.get(d.output_item_id), runs: 0, normRuns: 0, outputQty: 0, totalCost: 0,
          plannedValue: 0, devValue: 0, extraValue: 0, runDevPcts: [], avgDev: null, components: [], docs: [], comp: new Map(),
        }
        byProduct.set(d.output_item_id, p)
      }
      p.runs++
      p.outputQty += Number(d.output_qty)
      p.totalCost += Number(d.total_cost)
      const ls = linesByDoc.get(d.id) ?? []
      const hasNorm = ls.some(l => l.planned_qty !== null)
      let runPlanned = 0
      let runDev = 0
      for (const l of ls) {
        let c = p.comp.get(l.item_id)
        if (!c) {
          c = { itemId: l.item_id, item: itemById.get(l.item_id), planned: 0, actual: 0, extraQty: 0, extraValue: 0, devValue: 0, devPcts: [] }
          p.comp.set(l.item_id, c)
        }
        const qty = Number(l.qty)
        const cost = Number(l.unit_cost)
        if (l.planned_qty === null) {
          if (hasNorm) { c.extraQty += qty; c.extraValue += Number(l.total); p.extraValue += Number(l.total) }
          else c.actual += qty
          continue
        }
        const planned = Number(l.planned_qty)
        c.planned += planned
        c.actual += qty
        const dv = (qty - planned) * cost
        c.devValue += dv
        if (planned > 0) c.devPcts.push(((qty - planned) / planned) * 100)
        runPlanned += planned * cost
        runDev += dv
      }
      let runPct: number | null = null
      if (hasNorm) {
        p.normRuns++
        p.plannedValue += runPlanned
        p.devValue += runDev
        if (runPlanned > 0) { runPct = (runDev / runPlanned) * 100; p.runDevPcts.push(runPct) }
      }
      p.docs.push({ id: d.id, number: d.number, dev: runPct })
    }
    return [...byProduct.values()]
      .map(({ comp, ...p }) => ({
        ...p,
        avgDev: mean(p.runDevPcts),
        components: [...comp.values()].sort((a, b) => Math.abs(b.devValue) - Math.abs(a.devValue)),
      }))
      .sort((a, b) => b.devValue - a.devValue)
  }, [docs, lines, itemById])

  const outOfTol = (p: ProductAgg) => p.avgDev !== null && Math.abs(p.avgDev) > tol
  const totals = useMemo(() => ({
    runs: products.reduce((s, p) => s + p.runs, 0),
    normRuns: products.reduce((s, p) => s + p.normRuns, 0),
    dev: products.reduce((s, p) => s + p.devValue, 0),
    extra: products.reduce((s, p) => s + p.extraValue, 0),
  }), [products])
  const flagged = products.filter(outOfTol).length

  const pct = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`)
  const signedMoney = (n: number) => `${n > 0.005 ? '+' : ''}${formatPrice(round2(n))}`
  const devTone = (n: number | null) => (n === null || Math.abs(n) < 0.05 ? 'text-gray-500 dark:text-gray-400' : n > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')

  function toggleRow(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function exportXlsx() {
    const rows: (string | number)[][] = []
    for (const p of products) {
      for (const c of p.components) {
        rows.push([
          p.item?.name ?? '', p.runs, p.normRuns, p.avgDev === null ? '' : x2(p.avgDev),
          c.item?.name ?? '', c.item ? t(unitKey(c.item.unit)) : '', x3(c.planned), x3(c.actual), x3(c.actual - c.planned),
          mean(c.devPcts) === null ? '' : x2(mean(c.devPcts) as number), x2(c.devValue), x3(c.extraQty), x2(c.extraValue),
        ])
      }
    }
    downloadXlsx('norma_fakt', [
      t('prodReports.norm.product'), t('prodReports.norm.runs'), t('prodReports.norm.normRuns'), t('prodReports.norm.avgDev'),
      t('production.productions.component'), t('production.common.unit'), t('production.productions.norm'), t('production.productions.fact'),
      t('production.productions.diff'), t('prodReports.norm.avgDev'), `${t('prodReports.norm.devValue')} (UZS)`,
      t('prodReports.norm.extraQty'), `${t('prodReports.norm.extraValue')} (UZS)`,
    ], rows, t('prodReports.norm.title'))
  }

  const busy = loading || refsLoading

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <ReportHeader
        title={t('prodReports.norm.title')}
        subtitle={t('prodReports.norm.subtitle')}
        range={range}
        onRangeChange={setRange}
        onExport={products.length ? exportXlsx : undefined}
        exportLabel={t('prodReports.export')}
      >
        <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-gray-400">
          {t('prodReports.norm.tolerance')}
          <input inputMode="decimal" value={tolerance} onChange={e => setTolerance(e.target.value)} className={cn(prodFieldCls, 'w-20 text-right tabular-nums')} />
          %
        </label>
      </ReportHeader>

      <ProdKpiGrid items={[
        { label: t('prodReports.norm.runs'), value: String(totals.runs), sub: `${t('prodReports.norm.normRuns')}: ${totals.normRuns}`, icon: Factory },
        { label: t('prodReports.norm.devValue'), value: signedMoney(totals.dev), icon: Scale, tone: totals.dev > 0.005 ? 'negative' : totals.dev < -0.005 ? 'positive' : undefined },
        { label: t('prodReports.norm.extraValue'), value: formatPrice(round2(totals.extra)), icon: Wallet },
        { label: t('prodReports.norm.flagged'), value: String(flagged), icon: AlertTriangle, tone: flagged > 0 ? 'warning' : undefined },
      ]} />

      <TableCard loading={busy} empty={products.length === 0} emptyText={t('prodReports.common.empty')} emptyIcon={Scale}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('prodReports.norm.product')}</th>
              <th className={thRightCls}>{t('prodReports.norm.runs')}</th>
              <th className={thRightCls}>{t('prodReports.norm.output')}</th>
              <th className={thRightCls}>{t('prodReports.norm.plannedValue')}</th>
              <th className={thRightCls}>{t('prodReports.norm.avgDev')}</th>
              <th className={thRightCls}>{t('prodReports.norm.devValue')}</th>
              <th className={thRightCls}>{t('prodReports.norm.extraValue')}</th>
            </tr>
          </thead>
          <tbody>
            {products.map(p => {
              const open = expanded.has(p.itemId)
              return (
                <Fragment key={p.itemId}>
                  <tr className={cn(trCls, 'cursor-pointer')} onClick={() => toggleRow(p.itemId)}>
                    <td className={tdCls}>
                      <div className="flex items-center gap-1.5">
                        <ExpandChevron open={open} onClick={() => toggleRow(p.itemId)} label={t('production.productions.components')} />
                        <span className="font-medium text-gray-900 dark:text-gray-100">{p.item?.name ?? '—'}</span>
                        {outOfTol(p) && (
                          <span className="inline-flex rounded-full bg-amber-100 dark:bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">{t('prodReports.norm.overTolerance')}</span>
                        )}
                      </div>
                    </td>
                    <td className={cn(tdCls, 'text-right tabular-nums text-gray-700 dark:text-gray-300')}>{p.runs}{p.normRuns !== p.runs && <span className="text-gray-400"> ({p.normRuns})</span>}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300')}>{p.item ? smart(p.outputQty, p.item.unit) : p.outputQty}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(round2(p.plannedValue))}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium', devTone(p.avgDev))}>{pct(p.avgDev)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium', devTone(p.devValue))}>{signedMoney(p.devValue)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{p.extraValue ? formatPrice(round2(p.extraValue)) : '—'}</td>
                  </tr>
                  {open && (
                    <tr className="border-b border-gray-50 dark:border-gray-800/60 bg-gray-50 dark:bg-gray-800/40">
                      <td colSpan={7} className="px-4 py-3 space-y-3">
                        <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('production.productions.component')}</th>
                                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('production.productions.norm')}</th>
                                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('production.productions.fact')}</th>
                                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('production.productions.diff')}</th>
                                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('prodReports.norm.avgDev')}</th>
                                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('prodReports.norm.devValue')}</th>
                                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('prodReports.norm.extraQty')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.components.map(c => {
                                const base = c.item?.unit ?? 'pcs'
                                const diff = c.actual - c.planned
                                const avg = mean(c.devPcts)
                                return (
                                  <tr key={c.itemId} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                                    <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{c.item?.name ?? '—'}</td>
                                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{c.planned ? smart(c.planned, base) : '—'}</td>
                                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{smart(c.actual, base)}</td>
                                    <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap', devTone(c.planned ? diff : null))}>
                                      {c.planned ? `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${smart(Math.abs(diff), base)}` : '—'}
                                    </td>
                                    <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap', devTone(avg))}>{pct(avg)}</td>
                                    <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap', devTone(c.devValue))}>{c.planned ? signedMoney(c.devValue) : '—'}</td>
                                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{c.extraQty ? `${smart(c.extraQty, base)} · ${formatPrice(round2(c.extraValue))}` : '—'}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {p.docs.map(d => (
                            <Link
                              key={d.id}
                              href={`/ishlab-chiqarish/${d.id}`}
                              className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                            >
                              #{d.number}
                              {d.dev !== null && <span className={devTone(d.dev)}>{pct(d.dev)}</span>}
                            </Link>
                          ))}
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
      <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodReports.norm.note')}</p>
    </div>
  )
}
