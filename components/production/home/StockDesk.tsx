'use client'

// Storekeeper desk (prod_stock): stock search, expiring / expired lots, low stock.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeftRight, Boxes, ClipboardCheck, Search, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { prodFieldCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { expiryWarnDaysOf, fetchProdStock, formatQty, lotExpiryState, unitKey } from '@/lib/production'
import { addDaysYmd } from '@/lib/production-dashboard'
import { BigAction, DeskList, DeskShell, DeskStat, deskRowCls } from './DeskKit'

interface LotRow { id: string | null; lot_no: string | null; warehouse_name: string | null; item_id: string | null; item_name: string | null; item_unit: string | null; remaining_qty: number | null; expiry_date: string | null }

/** Lots expiring within this many days are read, then classified by the item's own warn window. */
const LOOKAHEAD_DAYS = 30
const pill = 'inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap'

export function StockDesk({ compact }: { compact?: boolean }) {
  const { t } = useLanguage()
  const { items, itemById, loading: refsLoading } = useProdRefs()
  const [qtyByItem, setQtyByItem] = useState<Map<string, number>>(new Map())
  const [lots, setLots] = useState<LotRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const today = localYmd()

  useEffect(() => {
    let active = true
    const supabase = createClient()
    Promise.all([
      fetchProdStock(supabase, { positiveOnly: true }),
      fetchAllRows<LotRow>((from, to) => supabase.from('prod_lot_stock')
        .select('id, lot_no, warehouse_name, item_id, item_name, item_unit, remaining_qty, expiry_date')
        .gt('remaining_qty', 0).not('expiry_date', 'is', null).lte('expiry_date', addDaysYmd(localYmd(), LOOKAHEAD_DAYS))
        .order('expiry_date').order('id').range(from, to)),
    ]).then(([stock, lotRes]) => {
      if (!active) return
      const m = new Map<string, number>()
      for (const r of stock) m.set(r.itemId, (m.get(r.itemId) ?? 0) + r.qty)
      setQtyByItem(m)
      setLots(lotRes.data)
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  const busy = loading || refsLoading
  const unitOf = (itemId: string | null | undefined, fallback?: string | null) => {
    const u = (itemId && itemById.get(itemId)?.unit) || fallback
    return u ? t(unitKey(u)) : ''
  }

  const riskLots = useMemo(() => lots
    .map(l => ({ ...l, state: lotExpiryState(l.expiry_date, today, expiryWarnDaysOf(l.item_id ? itemById.get(l.item_id) : null)) }))
    .filter(l => l.state === 'expired' || l.state === 'soon'), [lots, itemById, today])
  const expired = riskLots.filter(l => l.state === 'expired').length

  const low = useMemo(() => items
    .filter(i => i.isActive && i.minStock !== null && i.minStock > 0 && (qtyByItem.get(i.id) ?? 0) < i.minStock)
    .map(i => ({ item: i, qty: qtyByItem.get(i.id) ?? 0 })), [items, qtyByItem])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return items.filter(i => i.isActive && (i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q) || i.barcode === q)).slice(0, 8)
  }, [items, query])

  const limit = compact ? 5 : 10

  return (
    <DeskShell
      title={t('prodHome.desks.stock')}
      compact={compact}
      actions={<>
        <BigAction href="/zavod-kochirish/yangi" label={t('prodHome.stock.transfer')} icon={ArrowLeftRight} primary compact={compact} />
        <BigAction href="/zavod-hisobdan-chiqarish/yangi" label={t('prodHome.stock.writeoff')} icon={Trash2} compact={compact} />
        <BigAction href="/zavod-inventarizatsiya/yangi" label={t('prodHome.stock.count')} icon={ClipboardCheck} compact={compact} />
        <BigAction href="/zavod-qoldiq" label={t('prodHome.stock.balances')} icon={Boxes} compact={compact} />
      </>}
      stats={<>
        <DeskStat label={t('prodHome.stock.expired')} value={String(expired)} tone={expired > 0 ? 'negative' : undefined} loading={busy} />
        <DeskStat label={t('prodHome.stock.expiring')} value={String(riskLots.length - expired)} tone={riskLots.length - expired > 0 ? 'warning' : undefined} loading={busy} />
        <DeskStat label={t('prodHome.stock.low')} value={String(low.length)} tone={low.length > 0 ? 'warning' : undefined} loading={busy} />
      </>}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('prodHome.stock.searchPlaceholder')}
          className={cn(prodFieldCls, 'h-11 pl-9 text-base sm:text-sm')}
        />
      </div>
      {query.trim() && (
        <DeskList title={t('prodHome.stock.searchResults')} href="/zavod-qoldiq" loading={busy} empty={matches.length === 0} emptyText={t('prodHome.common.nothingFound')}>
          {matches.map(i => (
            <div key={i.id} className={deskRowCls}>
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{i.name}</span>
              <span className="shrink-0 tabular-nums font-medium text-gray-900 dark:text-gray-100">{formatQty(qtyByItem.get(i.id) ?? 0)} {t(unitKey(i.unit))}</span>
            </div>
          ))}
        </DeskList>
      )}
      <div className={cn('grid gap-4', !compact && 'lg:grid-cols-2')}>
        <DeskList title={t('prodHome.stock.expiryList')} href="/zavod-qoldiq" loading={busy} empty={riskLots.length === 0} emptyText={t('prodHome.stock.noExpiry')}>
          {riskLots.slice(0, limit).map(l => (
            <div key={l.id ?? l.lot_no ?? ''} className={deskRowCls}>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-gray-900 dark:text-gray-100">{l.item_name ?? ''}</span>
                <span className="ml-1.5 text-[12px] text-gray-400 dark:text-gray-500">{l.lot_no ?? ''} · {l.warehouse_name ?? ''}</span>
              </span>
              <span className="shrink-0 tabular-nums text-gray-700 dark:text-gray-300">{formatQty(Number(l.remaining_qty ?? 0))} {unitOf(l.item_id, l.item_unit)}</span>
              <span className={cn(pill, l.state === 'expired'
                ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400')}>
                {l.expiry_date ? `${l.expiry_date.slice(8, 10)}.${l.expiry_date.slice(5, 7)}` : ''}
              </span>
            </div>
          ))}
        </DeskList>
        <DeskList title={t('prodHome.stock.lowList')} href="/zavod-qoldiq" loading={busy} empty={low.length === 0} emptyText={t('prodHome.stock.noLow')}>
          {low.slice(0, limit).map(({ item, qty }) => (
            <Link key={item.id} href="/zavod-qoldiq" className={cn(deskRowCls, 'hover:bg-gray-50 dark:hover:bg-gray-800/40')}>
              <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{item.name}</span>
              <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">{formatQty(qty)}</span>
              <span className="shrink-0 tabular-nums text-gray-400 dark:text-gray-500">/ {formatQty(item.minStock ?? 0)} {t(unitKey(item.unit))}</span>
            </Link>
          ))}
        </DeskList>
      </div>
    </DeskShell>
  )
}
