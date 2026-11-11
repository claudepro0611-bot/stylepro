'use client'

// "Foyda va zarar": profit and loss of the plant (prod_pnl, migration
// 20261110000018) by month / week / day columns with the category drill of
// the whole range, export and print. Owner / admin only: proxy.ts
// (OWNER_ADMIN_PATHS + 'prod_stock'); the RPC re-checks. Formulas: migration
// header "P&L" (summarised under "Hisoblash usuli").

import { Fragment, useEffect, useMemo, useState } from 'react'
import { Banknote, Landmark, Receipt, TrendingUp } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { BackLink, MoreFields, Segmented, TableCard, prodCardCls } from '@/components/production/ProdKit'
import { ExpandChevron, ExportButton, ProdKpiGrid } from '@/components/production/ReportKit'
import { PrintButton, PrintSheet, PrintTable } from '@/components/production/PrintKit'
import { AcctNote } from '@/components/production/AccountingKit'
import { useRole } from '@/components/production/ControlKit'
import { isOwnerAdminRole } from '@/lib/production-controls'
import { formatMarginPct, marginPct } from '@/lib/sales'
import { writeoffReasonKey } from '@/lib/inventory'
import { downloadXlsx, x2 } from '@/lib/production-reports'
import {
  acctErrorText, fetchPnl, pnlKindKey,
  type PnlDetail, type PnlDetailMetric, type PnlGroup, type PnlMetric, type PnlResult,
} from '@/lib/production-accounting'

const PRESETS = ['thisMonth', 'lastMonth', 'thisQuarter', 'thisYear', 'last12'] as const
type Preset = typeof PRESETS[number]
interface Range { from: string; to: string }

function presetRange(p: Preset, now = new Date()): Range {
  const y = now.getFullYear()
  const m = now.getMonth()
  const today = localYmd(now)
  switch (p) {
    case 'thisMonth': return { from: localYmd(new Date(y, m, 1)), to: today }
    case 'lastMonth': return { from: localYmd(new Date(y, m - 1, 1)), to: localYmd(new Date(y, m, 0)) }
    case 'thisQuarter': return { from: localYmd(new Date(y, m - (m % 3), 1)), to: today }
    case 'thisYear': return { from: localYmd(new Date(y, 0, 1)), to: today }
    case 'last12': return { from: localYmd(new Date(y, m - 11, 1)), to: today }
  }
}

const daysBetween = (r: Range) => Math.round((new Date(`${r.to}T00:00:00Z`).getTime() - new Date(`${r.from}T00:00:00Z`).getTime()) / 86_400_000)

const MONTH_KEYS: TranslationKey[] = [
  'dashboard.monthsShort.jan', 'dashboard.monthsShort.feb', 'dashboard.monthsShort.mar', 'dashboard.monthsShort.apr',
  'dashboard.monthsShort.may', 'dashboard.monthsShort.jun', 'dashboard.monthsShort.jul', 'dashboard.monthsShort.aug',
  'dashboard.monthsShort.sep', 'dashboard.monthsShort.oct', 'dashboard.monthsShort.nov', 'dashboard.monthsShort.dec',
]

type LineMetric = PnlMetric | 'separation_loss_value'
interface Line { metric: LineMetric; strong?: boolean; memo?: boolean; detail?: PnlDetailMetric }

const LINES: Line[] = [
  { metric: 'revenue', detail: 'revenue' },
  { metric: 'cogs', detail: 'cogs' },
  { metric: 'gross_profit', strong: true },
  { metric: 'writeoffs', detail: 'writeoffs' },
  { metric: 'production_losses', detail: 'production_losses' },
  { metric: 'price_variance', detail: 'price_variance' },
  { metric: 'overhead', detail: 'overhead' },
  { metric: 'other_expenses', detail: 'other_expenses' },
  { metric: 'operating_profit', strong: true },
  { metric: 'separation_loss_value', memo: true },
]

export default function PnlReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const role = useRole()
  const allowed = isOwnerAdminRole(role)

  const [range, setRange] = useState<Range | null>(null)
  const [group, setGroup] = useState<PnlGroup>('month')
  const [data, setData] = useState<PnlResult | null>(null)
  const [missing, setMissing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Set<PnlDetailMetric>>(new Set())

  // Client clock only (avoids a hydration mismatch).
  useEffect(() => { setRange(presetRange('thisMonth')) }, [])

  const days = range ? daysBetween(range) : 0
  const effGroup: PnlGroup = group === 'day' && days > 731 ? 'month' : group

  useEffect(() => {
    if (!range || !allowed) return
    if (days > 3660) { toast.error(t('prodAcct.pnl.rangeTooLong')); return }
    let alive = true
    setLoading(true)
    fetchPnl(createClient(), range.from, range.to, effGroup).then(res => {
      if (!alive) return
      if (res.status === 'missing') setMissing(true)
      else if (res.status === 'error') toast.error(acctErrorText(t, res.error))
      setData(res.status === 'ok' ? res.data : null)
      setLoading(false)
    })
    return () => { alive = false }
  }, [range, effGroup, days, allowed, t])

  const preset = useMemo(() => {
    if (!range) return null
    return PRESETS.find(p => { const r = presetRange(p); return r.from === range.from && r.to === range.to }) ?? null
  }, [range])

  const periods = effGroup === 'total' ? [] : data?.rows ?? []
  const periodLabel = (p: { period: string; from: string; to: string }) => {
    if (effGroup === 'month') return `${t(MONTH_KEYS[Number(p.period.slice(5, 7)) - 1])} ${p.period.slice(2, 4)}`
    if (effGroup === 'week') return `${p.from.slice(8, 10)}.${p.from.slice(5, 7)}–${p.to.slice(8, 10)}.${p.to.slice(5, 7)}`
    return `${p.period.slice(8, 10)}.${p.period.slice(5, 7)}`
  }
  const metricLabel = (m: LineMetric) => t(`prodAcct.pnl.${m}` as TranslationKey)

  const detailLabel = (metric: PnlDetailMetric, d: PnlDetail) => {
    const kind = t(pnlKindKey(metric, d.kind))
    if (metric === 'writeoffs' && d.kind === 'writeoff' && d.ref) return `${kind}: ${t(writeoffReasonKey(d.ref))}`
    if (metric === 'other_expenses') return `${kind}: ${d.name || t('prodAcct.pools.noCategory')}`
    return kind
  }

  const total = data?.total
  const toggle = (m: PnlDetailMetric) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(m)) next.delete(m)
    else next.add(m)
    return next
  })

  function exportXlsx() {
    if (!data || !total) return
    const headers = [t('prodAcct.pnl.metric'), ...periods.map(periodLabel), `${t('prodAcct.pnl.total')} (UZS)`]
    const rows: (string | number)[][] = []
    for (const l of LINES) {
      rows.push([metricLabel(l.metric), ...periods.map(p => x2(p[l.metric])), x2(total[l.metric])])
      if (l.detail) for (const d of total.detail[l.detail]) rows.push([`   ${detailLabel(l.detail, d)}`, ...periods.map(() => ''), x2(d.amount)])
    }
    downloadXlsx('foyda_zarar', headers, rows, t('prodAcct.reports.pnlTitle'))
  }

  if (!allowed || missing) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
        <AcctNote text={!allowed ? t('prodAcct.ownerAdminOnly') : t('prodAcct.notAvailable')} />
      </div>
    )
  }

  const tone = (v: number, strong?: boolean) => (strong && v < 0 ? 'text-red-600 dark:text-red-400' : '')
  const grossMargin = total ? marginPct(total.gross_profit, total.revenue) : null
  const opMargin = total ? marginPct(total.operating_profit, total.revenue) : null

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodAcct.reports.pnlTitle')}</h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('prodAcct.reports.pnlSubtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PrintButton />
          <ExportButton onClick={exportXlsx} disabled={!data} />
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-3 flex flex-wrap items-center gap-2')}>
        <Segmented<Preset | 'custom'>
          value={preset ?? 'custom'}
          onChange={v => { if (v !== 'custom') setRange(presetRange(v)) }}
          options={[
            ...PRESETS.map(p => ({ value: p, label: t(`prodAcct.pnl.presets.${p}`) })),
            ...(preset ? [] : [{ value: 'custom' as const, label: t('prodDash.custom') }]),
          ]}
        />
        <DateRangeFilter value={range} onChange={v => setRange(v ?? presetRange('thisMonth'))} />
        <Segmented<PnlGroup>
          className="ml-auto"
          value={effGroup}
          onChange={setGroup}
          options={(['month', 'week', 'day', 'total'] as const).map(g => ({
            value: g, label: t(`prodAcct.pnl.groups.${g}`), disabled: g === 'day' && days > 731,
          }))}
        />
      </div>

      {total && (
        <ProdKpiGrid items={[
          { label: t('prodAcct.pnl.revenue'), value: formatPrice(total.revenue), icon: Receipt },
          {
            label: t('prodAcct.pnl.gross_profit'), value: formatPrice(total.gross_profit), icon: TrendingUp,
            sub: formatMarginPct(grossMargin), tone: total.gross_profit < 0 ? 'negative' : undefined,
          },
          {
            label: t('prodAcct.pnl.expensesTotal'), value: formatPrice(total.writeoffs + total.production_losses + total.price_variance + total.overhead + total.other_expenses),
            sub: `${t('prodAcct.pnl.overhead')}: ${formatPrice(total.overhead)}`, icon: Banknote,
          },
          {
            label: t('prodAcct.pnl.operating_profit'), value: formatPrice(total.operating_profit), icon: Landmark,
            sub: formatMarginPct(opMargin), tone: total.operating_profit < 0 ? 'negative' : undefined,
          },
        ]} />
      )}

      <TableCard loading={loading || !range} empty={!total} emptyText={t('prodReports.common.empty')} emptyIcon={TrendingUp}>
        {total && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap min-w-56">{t('prodAcct.pnl.metric')}</th>
                {periods.map(p => <th key={p.period} className="px-4 py-3 text-right font-medium whitespace-nowrap">{periodLabel(p)}</th>)}
                <th className="px-4 py-3 text-right font-medium whitespace-nowrap">{t('prodAcct.pnl.total')}</th>
              </tr>
            </thead>
            <tbody>
              {LINES.map(l => {
                const isOpen = !!l.detail && open.has(l.detail)
                const details = l.detail ? total.detail[l.detail] : []
                return (
                  <Fragment key={l.metric}>
                    <tr
                      className={cn(
                        'border-b border-gray-50 dark:border-gray-800/60 transition-colors',
                        l.strong && 'bg-gray-50 dark:bg-gray-800/40 font-semibold',
                        l.detail && details.length > 0 && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40',
                      )}
                      onClick={() => { if (l.detail && details.length > 0) toggle(l.detail) }}
                    >
                      <td className={cn('px-4 py-2.5', l.memo ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100')}>
                        <div className="flex items-center gap-1.5">
                          {l.detail && details.length > 0
                            ? <ExpandChevron open={isOpen} onClick={() => toggle(l.detail!)} label={t('prodAcct.pnl.expand')} />
                            : <span className="w-4 shrink-0" />}
                          <span>{metricLabel(l.metric)}</span>
                        </div>
                        {l.memo && <p className="pl-5.5 text-[11px]">{t('prodAcct.pnl.memoHint')}</p>}
                      </td>
                      {periods.map(p => (
                        <td key={p.period} className={cn('px-4 py-2.5 text-right tabular-nums whitespace-nowrap', l.memo ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300', tone(p[l.metric], l.strong))}>
                          {formatPrice(p[l.metric])}
                        </td>
                      ))}
                      <td className={cn('px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium', l.memo ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100', tone(total[l.metric], l.strong))}>
                        {formatPrice(total[l.metric])}
                      </td>
                    </tr>
                    {isOpen && l.detail && details.map(d => (
                      <tr key={`${l.metric}:${d.kind}:${d.ref ?? ''}`} className="border-b border-gray-50 dark:border-gray-800/60 text-[13px]">
                        <td className="py-2 pl-11 pr-4 text-gray-500 dark:text-gray-400">{detailLabel(l.detail!, d)}</td>
                        {periods.map(p => <td key={p.period} />)}
                        <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(d.amount)}</td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </TableCard>

      <MoreFields label={t('prodAcct.pnl.formulasTitle')}>
        <ul className={cn(prodCardCls, 'space-y-1.5 p-4 text-[13px] text-gray-600 dark:text-gray-400')}>
          {(['revenue', 'cogs', 'writeoffs', 'production_losses', 'price_variance', 'overhead', 'other_expenses', 'operating_profit', 'separation_loss_value'] as const).map(k => (
            <li key={k}><span className="font-medium text-gray-900 dark:text-gray-100">{metricLabel(k)}</span> — {t(`prodAcct.pnl.formulas.${k}`)}</li>
          ))}
        </ul>
      </MoreFields>
    </div>
    {total && range && (
      <PrintSheet title={t('prodAcct.reports.pnlTitle')}>
        <p className="text-center">{range.from.split('-').reverse().join('.')} – {range.to.split('-').reverse().join('.')}</p>
        <PrintTable
          columns={[{ label: t('prodAcct.pnl.metric') }, ...periods.map(p => ({ label: periodLabel(p), right: true })), { label: t('prodAcct.pnl.total'), right: true }]}
          rows={LINES.flatMap(l => [
            [metricLabel(l.metric), ...periods.map(p => formatPrice(p[l.metric])), formatPrice(total[l.metric])],
            ...(l.detail && open.has(l.detail) ? total.detail[l.detail].map(d => [`   ${detailLabel(l.detail!, d)}`, ...periods.map(() => ''), formatPrice(d.amount)]) : []),
          ])}
        />
      </PrintSheet>
    )}
    </>
  )
}
