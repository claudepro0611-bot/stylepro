'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Ban, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BackLink, DocStatusBadge, InfoField, TotalsBox, prodCardCls, type TotalRow } from '@/components/production/ProdKit'
import { useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { DocLotsSection } from '@/components/production/DocLots'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { formatQty, round2, smartUnit, sumByUnitGroup, unitKey, yieldPercent, yieldWeightOf } from '@/lib/production'
import type { Database } from '@/lib/database.types'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'

type Doc = Database['public']['Tables']['prod_productions']['Row']
type Line = Database['public']['Tables']['prod_production_components']['Row']

export default function ProductionViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, warehouseById } = useProdRefs()
  const { inUnit, groups } = useQtyFormat()

  const [doc, setDoc] = useState<Doc | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [docRes, linesRes] = await Promise.all([
      supabase.from('prod_productions').select('*').eq('id', id).maybeSingle(),
      supabase.from('prod_production_components').select('*').eq('production_id', id).order('id'),
    ])
    setDoc(docRes.data ?? null)
    setLines(linesRes.data ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('production', load)

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/ishlab-chiqarish" label={t('production.productions.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const output = itemById.get(doc.output_item_id)
  const outUnit = output ? t(unitKey(output.unit)) : ''
  const hasPlan = lines.some(l => l.planned_qty !== null)
  const inputs = lines.map(l => ({ qty: Number(l.qty), unit: itemById.get(l.item_id)?.unit ?? 'pcs', weightKg: yieldWeightOf(itemById.get(l.item_id)) }))
  const yieldPct = output ? yieldPercent({ qty: Number(doc.output_qty), unit: output.unit, weightKg: output.weightKg }, inputs) : null
  // Deviation from the norm, priced at the document's own component costs.
  const normCost = round2(lines.reduce((s, l) => s + (l.planned_qty === null ? 0 : round2(Number(l.planned_qty) * Number(l.unit_cost))), 0))
  const totalRows: TotalRow[] = [
    { label: t('production.productions.totalConsumption'), value: groups(sumByUnitGroup(inputs)) },
  ]
  if (yieldPct !== null) totalRows.push({ label: t('production.productions.yield'), value: `${yieldPct.toFixed(1)}%` })
  if (hasPlan) {
    const d = round2(Number(doc.total_cost) - normCost)
    totalRows.push({ label: t('production.productions.normCostDiff'), value: `${d > 0 ? '+' : ''}${formatPrice(d)}`, tone: d > 0 ? 'negative' : d < 0 ? 'positive' : undefined })
  }
  totalRows.push(
    { label: t('production.productions.totalCost'), value: formatPrice(Number(doc.total_cost)) },
    { label: t('production.productions.unitCost'), value: `${formatPrice(Number(doc.unit_cost))}${outUnit ? ` / ${outUnit}` : ''}`, strong: true },
  )

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/ishlab-chiqarish" label={t('production.productions.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.productions.docTitle')} #{doc.number}</h1>
          <DocStatusBadge status={doc.status} />
          {doc.recipe_version !== null && (doc.recipe_id ? (
            <Link href={`/zavod-retseptlar/${doc.recipe_id}?v=${doc.recipe_version}`} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
              {t('production.productions.recipe')} v{doc.recipe_version}
            </Link>
          ) : (
            <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">{t('production.productions.recipe')} v{doc.recipe_version}</span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PrintButton />
          {canCancel && doc.status === 'posted' && (
            <Button variant="outline" onClick={() => cancel(doc.id)} loading={busyId === doc.id}>
              <Ban className="h-3.5 w-3.5" /> {t('production.common.cancelDoc')}
            </Button>
          )}
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4')}>
        <InfoField label={t('production.common.date')}>{formatDateTime(doc.doc_date)}</InfoField>
        <InfoField label={t('production.productions.rawWarehouse')}>{warehouseById.get(doc.warehouse_id)?.name ?? '—'}</InfoField>
        <InfoField label={t('production.productions.outputWarehouse')}>{warehouseById.get(doc.output_warehouse_id ?? doc.warehouse_id)?.name ?? '—'}</InfoField>
        <InfoField label={t('production.productions.outputItem')}>{output?.name ?? '—'}</InfoField>
        <InfoField label={t('production.common.qty')}>{formatQty(Number(doc.output_qty))} {outUnit}</InfoField>
        <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
        <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
        {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.productions.components')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.productions.component')}</th>
                {hasPlan && <th className="px-4 py-2.5 text-right font-medium">{t('production.productions.norm')}</th>}
                <th className="px-4 py-2.5 text-right font-medium">{hasPlan ? t('production.productions.fact') : t('production.common.qty')}</th>
                {hasPlan && <th className="px-4 py-2.5 text-right font-medium">{t('production.productions.diff')}</th>}
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.avgCost')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.common.total')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const item = itemById.get(l.item_id)
                const base = item?.unit ?? 'pcs'
                const qty = Number(l.qty)
                const planned = l.planned_qty === null ? null : Number(l.planned_qty)
                const unit = smartUnit(planned ?? qty, base)
                const diff = planned === null ? null : qty - planned
                const even = diff === null || Math.abs(diff) < 0.0005
                return (
                  <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                      {item?.name ?? '—'}
                      {hasPlan && planned === null && (
                        <span className="ml-1.5 inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('production.productions.extra')}</span>
                      )}
                    </td>
                    {hasPlan && <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{planned === null ? '—' : inUnit(planned, base, unit)}</td>}
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{hasPlan ? inUnit(qty, base, unit) : `${formatQty(qty)} ${item ? t(unitKey(item.unit)) : ''}`}</td>
                    {hasPlan && (
                      <td className={cn(
                        'px-4 py-2 text-right tabular-nums whitespace-nowrap',
                        diff === null || even ? 'text-gray-400 dark:text-gray-500' : diff > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400',
                      )}>
                        {diff === null ? '—' : even ? '0' : (
                          <>
                            {diff > 0 ? '+' : '−'}{inUnit(Math.abs(diff), base, unit)}
                            {planned !== null && planned > 0 && <span className="ml-1 text-[11px]">({diff > 0 ? '+' : '−'}{Math.abs((diff / planned) * 100).toFixed(1)}%)</span>}
                          </>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(l.unit_cost))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(l.total))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocLotsSection docId={doc.id} itemById={itemById} warehouseById={warehouseById} reloadKey={doc.status} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {doc.note ? (
          <div className={cn(prodCardCls, 'p-6')}>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.common.note')}</p>
            <p className="mt-1 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{doc.note}</p>
          </div>
        ) : <div className="hidden lg:block" />}
        <TotalsBox rows={totalRows} />
      </div>
    </div>
    <PrintSheet
      title={t('prodReports.print.productionAct')}
      number={doc.number}
      date={doc.doc_date}
      signatures={[t('prodReports.print.technologist'), t('prodReports.print.master'), t('prodReports.print.storekeeper')]}
    >
      <PrintFields rows={[
        { label: t('production.productions.outputItem'), value: output?.name ?? '—' },
        { label: t('production.common.qty'), value: `${formatQty(Number(doc.output_qty))} ${outUnit}` },
        { label: t('production.productions.rawWarehouse'), value: warehouseById.get(doc.warehouse_id)?.name ?? '—' },
        { label: t('production.productions.outputWarehouse'), value: warehouseById.get(doc.output_warehouse_id ?? doc.warehouse_id)?.name ?? '—' },
        ...(doc.recipe_version !== null ? [{ label: t('production.productions.recipe'), value: `v${doc.recipe_version}` }] : []),
        { label: t('production.common.author'), value: doc.created_by_name ?? '—' },
      ]} />
      <PrintTable
        title={t('production.productions.components')}
        columns={[
          { label: t('production.productions.component') },
          ...(hasPlan ? [{ label: t('production.productions.norm'), right: true }] : []),
          { label: hasPlan ? t('production.productions.fact') : t('production.common.qty'), right: true },
          { label: t('production.common.avgCost'), right: true },
          { label: t('production.common.total'), right: true },
        ]}
        rows={lines.map(l => {
          const item = itemById.get(l.item_id)
          const u = item ? ` ${t(unitKey(item.unit))}` : ''
          return [
            item?.name ?? '—',
            ...(hasPlan ? [l.planned_qty === null ? '—' : `${formatQty(Number(l.planned_qty))}${u}`] : []),
            `${formatQty(Number(l.qty))}${u}`,
            formatPrice(Number(l.unit_cost)),
            formatPrice(Number(l.total)),
          ]
        })}
        total={[t('production.common.total'), ...(hasPlan ? [''] : []), '', '', formatPrice(Number(doc.total_cost))]}
      />
      <PrintFields rows={totalRows.map(r => ({ label: r.label, value: r.value }))} />
      {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
    </PrintSheet>
    </>
  )
}
