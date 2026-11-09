'use client'

// Dashboard for production firms (business_type = 'production'). Replaces
// the retail dashboard entirely - none of the retail queries run.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Boxes, Factory, Scale, TrendingUp } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { KpiGrid, monthToDate } from '@/components/reports/ReportKit'
import { DocStatusBadge, prodCardCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { fetchProdStock, formatQty, rangeToIsoBounds, unitKey, type ProdStockRow } from '@/lib/production'

interface ProductionRow { id: string; number: number; doc_date: string; output_item_id: string; output_qty: number; total_cost: number; status: string }

export function ProductionDashboard() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { items, itemById, loading: refsLoading } = useProdRefs()

  const [productions, setProductions] = useState<ProductionRow[]>([])
  const [profit, setProfit] = useState(0)
  const [stock, setStock] = useState<ProdStockRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const supabase = createClient()
    const { fromIso, toIso } = rangeToIsoBounds(monthToDate())
    Promise.all([
      fetchAllRows<ProductionRow>((from, to) =>
        supabase.from('prod_productions').select('id, number, doc_date, output_item_id, output_qty, total_cost, status')
          .gte('doc_date', fromIso).lt('doc_date', toIso).order('number', { ascending: false }).range(from, to)),
      fetchAllRows<{ profit: number }>((from, to) =>
        supabase.from('prod_processings').select('profit').eq('status', 'posted')
          .gte('doc_date', fromIso).lt('doc_date', toIso).order('id').range(from, to)),
      fetchProdStock(supabase),
    ]).then(([prodRes, procRes, stockRows]) => {
      if (!active) return
      setProductions(prodRes.data)
      setProfit(procRes.data.reduce((s, r) => s + Number(r.profit), 0))
      setStock(stockRows)
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  const posted = useMemo(() => productions.filter(p => p.status === 'posted'), [productions])

  // Output quantity per unit (kg and litres must not be added together).
  const outputByUnit = useMemo(() => {
    const m = new Map<string, number>()
    posted.forEach(p => {
      const unit = itemById.get(p.output_item_id)?.unit ?? 'pcs'
      m.set(unit, (m.get(unit) ?? 0) + Number(p.output_qty))
    })
    return Array.from(m.entries())
  }, [posted, itemById])

  const stockValue = useMemo(() => stock.reduce((s, r) => s + r.value, 0), [stock])

  // Low stock is judged on the company-wide quantity of an item.
  const lowStock = useMemo(() => {
    const qtyByItem = new Map<string, number>()
    stock.forEach(r => qtyByItem.set(r.itemId, (qtyByItem.get(r.itemId) ?? 0) + r.qty))
    return items
      .filter(i => i.isActive && i.minStock != null && (qtyByItem.get(i.id) ?? 0) < i.minStock)
      .map(i => ({ item: i, qty: qtyByItem.get(i.id) ?? 0 }))
      .sort((a, b) => a.qty / (a.item.minStock || 1) - b.qty / (b.item.minStock || 1))
  }, [items, stock])

  const busy = loading || refsLoading
  const outputLabel = outputByUnit.length
    ? outputByUnit.map(([unit, qty]) => `${formatQty(qty)} ${t(unitKey(unit))}`).join(' · ')
    : '0'

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.dashboard.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('production.dashboard.subtitle')}</p>
      </div>

      {busy ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[124px] rounded-xl" />)}
        </div>
      ) : (
        <KpiGrid items={[
          { label: t('production.dashboard.productionCount'), value: String(posted.length), icon: Factory },
          { label: t('production.dashboard.outputQty'), value: outputLabel, icon: Scale },
          { label: t('production.dashboard.processingProfit'), value: formatPrice(profit), icon: TrendingUp, tone: profit < 0 ? 'negative' : profit > 0 ? 'positive' : undefined },
          { label: t('production.dashboard.stockValue'), value: formatPrice(stockValue), icon: Boxes },
        ]} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className={cn(prodCardCls, 'overflow-hidden')}>
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.dashboard.lowStock')}</h2>
            <Link href="/zavod-qoldiq" className="text-[13px] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">{t('production.dashboard.viewAll')}</Link>
          </div>
          {busy ? (
            <div className="p-4 space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
          ) : lowStock.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.dashboard.noLowStock')}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.common.stockLeft')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('production.items.minStock')}</th>
                </tr>
              </thead>
              <tbody>
                {lowStock.slice(0, 8).map(({ item, qty }) => (
                  <tr key={item.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2 text-gray-900 dark:text-gray-100">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> {item.name}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-amber-700 dark:text-amber-400">{formatQty(qty)} {t(unitKey(item.unit))}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatQty(item.minStock ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className={cn(prodCardCls, 'overflow-hidden')}>
          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.dashboard.recentProductions')}</h2>
            <Link href="/ishlab-chiqarish" className="text-[13px] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">{t('production.dashboard.viewAll')}</Link>
          </div>
          {busy ? (
            <div className="p-4 space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
          ) : productions.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.productions.empty')}</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {productions.slice(0, 8).map(p => {
                  const item = itemById.get(p.output_item_id)
                  return (
                    <tr key={p.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                      <td className="px-4 py-2">
                        <Link href={`/ishlab-chiqarish/${p.id}`} className="block">
                          <p className="text-gray-900 dark:text-gray-100">#{p.number} · {item?.name ?? '—'}</p>
                          <p className="text-xs text-gray-400 dark:text-gray-500">{formatDateTime(p.doc_date)}</p>
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(Number(p.output_qty))} {item ? t(unitKey(item.unit)) : ''}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(p.total_cost))}</td>
                      <td className="px-4 py-2 text-right"><DocStatusBadge status={p.status} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
