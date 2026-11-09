'use client'

import { useEffect, useMemo, useState } from 'react'
import { Boxes, PackagePlus, Truck, Wallet, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useBranchFilter } from '@/lib/session/useBranch'
import { formatDate } from '@/lib/utils/formatters'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { KpiGrid, ReportHeader, ReportTable, downloadCsv, monthToDate, type ReportColumn } from '@/components/reports/ReportKit'

interface EntryRow {
  id: string
  product_id: string | null
  product_name: string | null
  size: string | null
  color: string | null
  quantity: number
  purchase_price: number | null
  unit_price: number | null
  total_amount: number | null
  supplier: string | null
  date: string
}

interface SupplierRow {
  key: string
  name: string
  isUnknown: boolean
  entries: number
  qty: number
  amount: number
  share: number
  lastDate: string
}

interface ProductLine {
  key: string
  name: string
  qty: number
  amount: number
}

const UNKNOWN = '__unknown__'

// Cost of one kirim line: stored total, else quantity × purchase price.
function entryCost(e: EntryRow): number {
  const total = Number(e.total_amount ?? 0)
  if (total > 0) return total
  return Number(e.quantity) * Number(e.purchase_price ?? e.unit_price ?? 0)
}

// Suppliers are typed by hand on kirim, so group case/space-insensitively.
function supplierKey(name: string | null): string {
  const n = (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return n || UNKNOWN
}

export default function SuppliersReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const applyBranch = useBranchFilter()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const { data } = await fetchAllRows<EntryRow>((from, to) => {
        let q = applyBranch(supabase.from('stock_in_entries')
          .select('id, product_id, product_name, size, color, quantity, purchase_price, unit_price, total_amount, supplier, date')
          .eq('entry_type', 'purchase'))
        if (range) q = q.gte('date', range.from).lte('date', `${range.to}T23:59:59`)
        return q.order('id').range(from, to) as unknown as PromiseLike<{ data: EntryRow[] | null; error: unknown }>
      })
      if (cancelled) return
      setEntries(data)
      setSelected(null)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, applyBranch])

  const rows = useMemo<SupplierRow[]>(() => {
    const map = new Map<string, SupplierRow>()
    for (const e of entries) {
      const key = supplierKey(e.supplier)
      let r = map.get(key)
      if (!r) {
        r = { key, name: key === UNKNOWN ? t('suppliersReport.unknown') : (e.supplier ?? '').trim(), isUnknown: key === UNKNOWN, entries: 0, qty: 0, amount: 0, share: 0, lastDate: '' }
        map.set(key, r)
      }
      r.entries += 1
      r.qty += Number(e.quantity)
      r.amount += entryCost(e)
      const day = e.date.slice(0, 10)
      if (day > r.lastDate) r.lastDate = day
    }
    const sum = Array.from(map.values()).reduce((s, r) => s + r.amount, 0)
    for (const r of map.values()) r.share = sum > 0 ? (r.amount / sum) * 100 : 0
    return Array.from(map.values())
  }, [entries, t])

  const totals = useMemo(() => ({
    suppliers: rows.filter(r => !r.isUnknown).length,
    amount: rows.reduce((s, r) => s + r.amount, 0),
    qty: rows.reduce((s, r) => s + r.qty, 0),
    entries: rows.reduce((s, r) => s + r.entries, 0),
  }), [rows])

  const selectedRow = rows.find(r => r.key === selected) ?? null
  const productLines = useMemo<ProductLine[]>(() => {
    if (!selected) return []
    const map = new Map<string, ProductLine>()
    for (const e of entries) {
      if (supplierKey(e.supplier) !== selected) continue
      const variant = [e.color, e.size].filter(Boolean).join(' / ')
      const name = `${e.product_name ?? '—'}${variant ? ` · ${variant}` : ''}`
      const key = name
      const l = map.get(key) ?? { key, name, qty: 0, amount: 0 }
      l.qty += Number(e.quantity)
      l.amount += entryCost(e)
      map.set(key, l)
    }
    return Array.from(map.values())
  }, [entries, selected])

  const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, '')}%`

  const columns: ReportColumn<SupplierRow>[] = [
    {
      key: 'name', label: t('suppliersReport.supplier'),
      render: r => <span className={r.isUnknown ? 'italic text-gray-500 dark:text-gray-400' : 'font-medium text-gray-900 dark:text-gray-100'}>{r.name}</span>,
      sortValue: r => r.name, footer: t('reportsKit.total'),
    },
    { key: 'entries', label: t('suppliersReport.entries'), align: 'right', render: r => r.entries, sortValue: r => r.entries, footer: totals.entries },
    { key: 'qty', label: t('suppliersReport.qty'), align: 'right', render: r => r.qty, sortValue: r => r.qty, footer: totals.qty },
    { key: 'amount', label: t('suppliersReport.amount'), align: 'right', render: r => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(r.amount)}</span>, sortValue: r => r.amount, footer: formatPrice(totals.amount) },
    {
      key: 'share', label: t('salesReport.share'), align: 'right',
      render: r => (
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-16 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div className="h-full rounded-full bg-gray-900 dark:bg-gray-100" style={{ width: `${Math.min(100, r.share)}%` }} />
          </div>
          <span className="w-12 text-gray-500 dark:text-gray-400">{pct(r.share)}</span>
        </div>
      ),
      sortValue: r => r.share,
    },
    { key: 'lastDate', label: t('suppliersReport.lastEntry'), align: 'right', render: r => <span className="text-gray-500 dark:text-gray-400">{r.lastDate ? formatDate(r.lastDate) : '—'}</span>, sortValue: r => r.lastDate },
  ]

  const productColumns: ReportColumn<ProductLine>[] = [
    { key: 'name', label: t('reportsKit.product'), render: l => <span className="text-gray-900 dark:text-gray-100">{l.name}</span>, sortValue: l => l.name },
    { key: 'qty', label: t('suppliersReport.qty'), align: 'right', render: l => l.qty, sortValue: l => l.qty },
    { key: 'amount', label: t('suppliersReport.amount'), align: 'right', render: l => formatPrice(l.amount), sortValue: l => l.amount },
  ]

  function exportCsv() {
    downloadCsv('yetkazuvchilar', [t('suppliersReport.supplier'), t('suppliersReport.entries'), t('suppliersReport.qty'), t('suppliersReport.amount'), t('salesReport.share'), t('suppliersReport.lastEntry')],
      [...rows].sort((a, b) => b.amount - a.amount).map(r => [r.name, r.entries, r.qty, Math.round(r.amount), r.share.toFixed(1), r.lastDate]))
  }

  return (
    <div className="space-y-6">
      <ReportHeader title={t('suppliersReport.title')} subtitle={t('suppliersReport.subtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')} showBranch />

      <KpiGrid items={[
        { label: t('suppliersReport.suppliers'), value: String(totals.suppliers), icon: Truck },
        { label: t('suppliersReport.amount'), value: formatPrice(totals.amount), icon: Wallet },
        { label: t('suppliersReport.qty'), value: String(totals.qty), icon: Boxes },
        { label: t('suppliersReport.entries'), value: String(totals.entries), icon: PackagePlus },
      ]} />

      {!loading && rows.length > 0 && rows.every(r => r.isUnknown) && (
        <p className="-mt-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-500/10 px-4 py-2 text-[12.5px] text-amber-700 dark:text-amber-400">{t('suppliersReport.noSupplierHint')}</p>
      )}

      <ReportTable
        rows={rows}
        columns={columns}
        rowKey={r => r.key}
        loading={loading}
        emptyText={t('reportsKit.empty')}
        initialSort={{ key: 'amount', dir: 'desc' }}
        onRowClick={r => setSelected(prev => (prev === r.key ? null : r.key))}
        selectedKey={selected}
      />

      {selectedRow && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{selectedRow.name} — {t('suppliersReport.itemsTitle')}</p>
            <button onClick={() => setSelected(null)} aria-label={t('common.cancel')} className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ReportTable
            key={selectedRow.key}
            rows={productLines}
            columns={productColumns}
            rowKey={l => l.key}
            loading={false}
            emptyText={t('reportsKit.empty')}
            initialSort={{ key: 'amount', dir: 'desc' }}
            pageSize={15}
          />
        </div>
      )}
    </div>
  )
}
