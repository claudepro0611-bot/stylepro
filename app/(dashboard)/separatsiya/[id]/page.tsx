'use client'

// Read-only separation document: the balance (calculated vs actual, fat kg)
// and the cost allocation breakdown. Cancel (owner/admin) via
// prod_cancel_document('separation').

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Ban, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { BackLink, DocStatusBadge, InfoField, TotalsBox, prodCardCls, type TotalRow } from '@/components/production/ProdKit'
import { DocOverrides, ManualPickBadge, pickDeviationOf } from '@/components/production/ControlKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { DocLotsSection } from '@/components/production/DocLots'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { FatBalance, allocationKey } from '@/components/production/SeparationKit'
import { computeSeparation, formatQty, round2, round3, toSeparationAllocation } from '@/lib/production'
import { formatPct } from '@/lib/milk'
import type { Database } from '@/lib/database.types'
import { PrintButton, PrintFields, PrintSheet, PrintTable } from '@/components/production/PrintKit'

type Doc = Database['public']['Tables']['prod_separations']['Row']

export default function SeparationViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, warehouseById } = useProdRefs()

  const [doc, setDoc] = useState<Doc | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data } = await createClient().from('prod_separations').select('*').eq('id', id).maybeSingle()
    setDoc(data ?? null)
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelDoc('separation', load)

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/separatsiya" label={t('production.separation.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const kg = t('production.units.kg')
  const milkQty = Number(doc.milk_qty)
  const creamQty = Number(doc.cream_qty)
  const skimQty = Number(doc.skim_qty)
  const lossQty = Number(doc.loss_qty)
  const milkFat = Number(doc.milk_fat)
  const creamFat = Number(doc.cream_fat)
  const skimFat = Number(doc.skim_fat)
  const milkCost = Number(doc.milk_cost)
  const creamUnit = Number(doc.cream_unit_cost)
  const skimUnit = Number(doc.skim_unit_cost)
  const method = toSeparationAllocation(doc.allocation_method)
  // Fat balance of the posted (actual) amounts; costs come from the document.
  const balance = computeSeparation({
    milkQty, milkFat, creamFat, skimFat, lossPct: Number(doc.loss_pct),
    creamActual: creamQty, skimActual: skimQty, milkCost, method,
    skimPrice: doc.skim_price, creamRefPrice: doc.cream_ref_price, skimRefPrice: doc.skim_ref_price,
  })
  // Same allocation as the server (cream_total / skim_total are not stored).
  const creamTotal = balance.creamTotal
  const skimTotal = balance.skimTotal

  const rows = [
    { key: 'milk', label: itemById.get(doc.milk_item_id)?.name ?? '—', role: t('production.separation.milkItem'), calc: milkQty, actual: milkQty, fat: milkFat, unit: milkQty > 0 ? round2(milkCost / milkQty) : 0, total: milkCost },
    { key: 'cream', label: itemById.get(doc.cream_item_id)?.name ?? '—', role: t('production.separation.creamLabel'), calc: Number(doc.cream_qty_calc), actual: creamQty, fat: creamFat, unit: creamUnit, total: creamTotal },
    { key: 'skim', label: itemById.get(doc.skim_item_id)?.name ?? '—', role: t('production.separation.skimLabel'), calc: Number(doc.skim_qty_calc), actual: skimQty, fat: skimFat, unit: skimUnit, total: skimTotal },
  ]

  const costRows: TotalRow[] = [
    { label: t('production.separation.method'), value: t(allocationKey(method)) },
  ]
  if (method === 'skim_price' && doc.skim_price !== null) {
    costRows.push({ label: t('production.separation.skimPrice'), value: formatPrice(Number(doc.skim_price)) })
  }
  if (method === 'value') {
    if (doc.cream_ref_price !== null) costRows.push({ label: t('production.separation.creamRefPrice'), value: formatPrice(Number(doc.cream_ref_price)) })
    if (doc.skim_ref_price !== null) costRows.push({ label: t('production.separation.skimRefPrice'), value: formatPrice(Number(doc.skim_ref_price)) })
  }
  costRows.push(
    { label: t('production.separation.milkCost'), value: formatPrice(milkCost) },
    { label: t('production.separation.creamTotal'), value: formatPrice(creamTotal) },
    { label: t('production.separation.skimTotal'), value: formatPrice(skimTotal) },
    { label: t('production.separation.creamUnitCost'), value: `${formatPrice(creamUnit)} / ${kg}`, strong: true },
    { label: t('production.separation.skimUnitCost'), value: `${formatPrice(skimUnit)} / ${kg}` },
  )

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/separatsiya" label={t('production.separation.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.separation.docTitle')} #{doc.number}</h1>
          <DocStatusBadge status={doc.status} />
          <ManualPickBadge show={pickDeviationOf(doc)} />
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
        <InfoField label={t('production.separation.rawWarehouse')}>{warehouseById.get(doc.warehouse_id)?.name ?? '—'}</InfoField>
        <InfoField label={t('production.separation.outputWarehouse')}>{warehouseById.get(doc.output_warehouse_id)?.name ?? '—'}</InfoField>
        <InfoField label={t('production.separation.lossPct')}>{formatPct(Number(doc.loss_pct))}%</InfoField>
        <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
        <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
        {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-6')}>
        {[
          { label: t('production.separation.milkQty'), qty: milkQty, sub: `${t('production.separation.fatLower')} ${formatPct(milkFat)}%` },
          { label: t('production.separation.creamLabel'), qty: creamQty, sub: `${milkQty > 0 ? formatPct((creamQty / milkQty) * 100) : '0'}% ${t('production.separation.ofMilk')} · ${t('production.separation.fatLower')} ${formatPct(creamFat)}%` },
          { label: t('production.separation.skimLabel'), qty: skimQty, sub: `${t('production.separation.fatLower')} ${formatPct(skimFat)}%` },
          { label: t('production.separation.lossLabel'), qty: lossQty, sub: milkQty > 0 ? `${formatPct((lossQty / milkQty) * 100)}%` : undefined },
        ].map(f => (
          <div key={f.label}>
            <p className="text-[13px] font-medium text-gray-500 dark:text-gray-400">{f.label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-gray-900 dark:text-gray-100">
              {formatQty(f.qty)} <span className="text-lg font-medium text-gray-400 dark:text-gray-500">{kg}</span>
            </p>
            {f.sub && <p className="mt-0.5 text-[12px] tabular-nums text-gray-500 dark:text-gray-400">{f.sub}</p>}
          </div>
        ))}
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.separation.calculated')}, {kg}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.separation.actual')}, {kg}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.separation.fatPct')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.separation.fatBalance')}, {kg}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.separation.unitCost')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('production.separation.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const d = r.actual - r.calc
                return (
                  <tr key={r.key} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2">
                      <span className="text-gray-900 dark:text-gray-100">{r.label}</span>
                      <span className="ml-1.5 inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{r.role}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(r.calc)}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                      {formatQty(r.actual)}
                      {Math.abs(d) >= 0.0005 && <span className="ml-1 text-[11px] font-normal text-amber-700 dark:text-amber-400">({d > 0 ? '+' : '−'}{formatQty(Math.abs(d))})</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatPct(r.fat)}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(round3((r.actual * r.fat) / 100))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(r.unit)}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.total)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <DocOverrides docId={doc.id} reloadKey={doc.status} />
      <DocLotsSection docId={doc.id} itemById={itemById} warehouseById={warehouseById} reloadKey={doc.status} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        <FatBalance r={balance} />
        <TotalsBox rows={costRows} />
        {doc.note ? (
          <div className={cn(prodCardCls, 'p-6')}>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.common.note')}</p>
            <p className="mt-1 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{doc.note}</p>
          </div>
        ) : <div className="hidden lg:block" />}
      </div>
    </div>
    <PrintSheet
      title={t('prodReports.print.separationAct')}
      number={doc.number}
      date={doc.doc_date}
      signatures={[t('prodReports.print.operator'), t('prodReports.print.technologist'), t('prodReports.print.storekeeper')]}
    >
      <PrintFields rows={[
        { label: t('production.separation.rawWarehouse'), value: warehouseById.get(doc.warehouse_id)?.name ?? '—' },
        { label: t('production.separation.outputWarehouse'), value: warehouseById.get(doc.output_warehouse_id)?.name ?? '—' },
        { label: t('production.separation.lossPct'), value: `${formatPct(Number(doc.loss_pct))}%` },
        { label: t('production.separation.method'), value: t(allocationKey(method)) },
        { label: t('production.common.author'), value: doc.created_by_name ?? '—' },
      ]} />
      <PrintTable
        columns={[
          { label: t('production.common.item') },
          { label: `${t('production.separation.calculated')}, ${kg}`, right: true },
          { label: `${t('production.separation.actual')}, ${kg}`, right: true },
          { label: t('production.separation.fatPct'), right: true },
          { label: `${t('production.separation.fatBalance')}, ${kg}`, right: true },
          { label: t('production.separation.unitCost'), right: true },
          { label: t('production.separation.total'), right: true },
        ]}
        rows={[
          ...rows.map(r => [`${r.label} (${r.role})`, formatQty(r.calc), formatQty(r.actual), formatPct(r.fat), formatQty(round3((r.actual * r.fat) / 100)), formatPrice(r.unit), formatPrice(r.total)]),
          [t('production.separation.lossLabel'), '', formatQty(lossQty), '', '', '', ''],
        ]}
      />
      <PrintFields rows={costRows.map(r => ({ label: r.label, value: r.value }))} />
      {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
    </PrintSheet>
    </>
  )
}
