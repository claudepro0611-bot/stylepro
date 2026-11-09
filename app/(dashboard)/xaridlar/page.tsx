'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Boxes, Loader2, PackagePlus, Truck, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { Pagination } from '@/components/ui/Pagination'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KpiGrid, ReportHeader, downloadCsv, monthToDate } from '@/components/reports/ReportKit'
import { entryAmount, fetchSuppliers, type Supplier } from '@/lib/suppliers'
import { eqBranch, useWarehouseScope } from '@/lib/branchStock'

interface EntryRow {
  id: string
  product_name: string | null
  size: string | null
  color: string | null
  quantity: number
  purchase_price: number | null
  selling_price: number | null
  total_amount: number | null
  supplier: string | null
  supplier_id: string | null
  date: string
  created_at: string
  note: string | null
  product_size_id: string | null
}

/** One kirim save = one purchase document (rows share supplier + timestamp). */
interface Doc {
  key: string
  at: string
  supplierId: string | null
  supplierName: string
  warehouses: string
  note: string
  rows: EntryRow[]
  qty: number
  sum: number
}

const NO_SUPPLIER = '__none__'
const PAGE_SIZE = 25
const variantOf = (e: EntryRow) => [e.color, e.size].filter(Boolean).join(' / ')

export default function PurchasesPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [supplierFilter, setSupplierFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouseOf, setWarehouseOf] = useState<Map<string, string>>(new Map())
  // Clicked purchase document → its lines open in a dialog.
  const [selected, setSelected] = useState<Doc | null>(null)
  const [page, setPage] = useState(1)
  const { label: warehouseLabel, activeBranchId } = useWarehouseScope()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const [list, sizesRes, whRes] = await Promise.all([
        fetchSuppliers(supabase),
        fetchAllRows<{ id: string; warehouse_id: string | null }>((from, to) => supabase.from('product_sizes').select('id, warehouse_id').order('id').range(from, to)),
        supabase.from('warehouses').select('id, name, branch_id'),
      ])
      if (cancelled) return
      setSuppliers(list)
      const whName = new Map(((whRes.data ?? []) as { id: string; name: string; branch_id: string | null }[]).map(w => [w.id, warehouseLabel(w)]))
      setWarehouseOf(new Map(sizesRes.data.map(s => [s.id, (s.warehouse_id && whName.get(s.warehouse_id)) || '—'])))
    })()
    return () => { cancelled = true }
  }, [warehouseLabel])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const { data } = await fetchAllRows<EntryRow>((from, to) => {
        let q = eqBranch(supabase.from('stock_in_entries')
          .select('id, product_name, size, color, quantity, purchase_price, selling_price, total_amount, supplier, supplier_id, date, created_at, note, product_size_id')
          .eq('entry_type', 'purchase'), activeBranchId)
        if (range) q = q.gte('date', range.from).lte('date', `${range.to}T23:59:59`)
        if (supplierFilter === NO_SUPPLIER) q = q.is('supplier_id', null)
        else if (supplierFilter) q = q.eq('supplier_id', supplierFilter)
        return q.order('id').range(from, to) as unknown as PromiseLike<{ data: EntryRow[] | null; error: unknown }>
      })
      if (cancelled) return
      setEntries(data)
      setSelected(null)
      setPage(1)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [range, supplierFilter, activeBranchId])

  const supplierName = useMemo(() => new Map(suppliers.map(s => [s.id, s.name])), [suppliers])

  const docs = useMemo<Doc[]>(() => {
    const map = new Map<string, EntryRow[]>()
    for (const e of entries) {
      const k = `${e.supplier_id ?? e.supplier ?? ''}|${e.date}|${e.created_at.slice(0, 19)}`
      const arr = map.get(k)
      if (arr) arr.push(e)
      else map.set(k, [e])
    }
    return Array.from(map.entries()).map(([key, rows]) => {
      const first = rows[0]
      return {
        key,
        at: first.date.length > 10 ? first.date : `${first.date}T${first.created_at.slice(11, 19)}`,
        supplierId: first.supplier_id,
        supplierName: (first.supplier_id && supplierName.get(first.supplier_id)) || first.supplier?.trim() || t('suppliersPage.withoutSupplier'),
        warehouses: Array.from(new Set(rows.map(r => (r.product_size_id && warehouseOf.get(r.product_size_id)) || '—'))).join(', '),
        note: first.note ?? '',
        rows,
        qty: rows.reduce((s, r) => s + Number(r.quantity), 0),
        sum: rows.reduce((s, r) => s + entryAmount(r), 0),
      }
    }).sort((a, b) => b.at.localeCompare(a.at))
  }, [entries, supplierName, warehouseOf, t])

  const totals = useMemo(() => ({
    sum: docs.reduce((s, d) => s + d.sum, 0),
    qty: docs.reduce((s, d) => s + d.qty, 0),
    suppliers: new Set(docs.map(d => d.supplierId).filter(Boolean)).size,
  }), [docs])

  const totalPages = Math.max(1, Math.ceil(docs.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = docs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function exportCsv() {
    downloadCsv('xaridlar', [t('suppliersPage.date'), t('suppliersPage.supplier'), t('suppliersPage.product'), t('kirimReport.variant'), t('suppliersPage.warehouse'), t('suppliersPage.qty'), t('suppliersPage.price'), t('kirimReport.sellingPrice'), t('suppliersPage.sum')],
      docs.flatMap(d => d.rows.map(e => [
        `${d.at.slice(0, 10)} ${d.at.slice(11, 16)}`, d.supplierName, e.product_name ?? '', variantOf(e),
        (e.product_size_id && warehouseOf.get(e.product_size_id)) || '', e.quantity, Number(e.purchase_price ?? 0), Number(e.selling_price ?? 0), Math.round(entryAmount(e)),
      ])))
  }

  const options = [
    { value: '', label: t('suppliersPage.allSuppliers') },
    ...suppliers.map(s => ({ value: s.id, label: s.name, sublabel: s.phone || undefined })),
    { value: NO_SUPPLIER, label: t('suppliersPage.withoutSupplier') },
  ]

  return (
    <div className="space-y-6">
      <ReportHeader title={t('suppliersPage.purchasesTitle')} subtitle={t('suppliersPage.purchasesSubtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')}>
        <div className="w-full sm:w-64 sm:ml-auto">
          <SearchSelect options={options} value={supplierFilter} onChange={setSupplierFilter} placeholder={t('suppliersPage.allSuppliers')} />
        </div>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('suppliersPage.sum'), value: formatPrice(totals.sum), icon: Wallet },
        { label: t('suppliersPage.entriesTab'), value: String(docs.length), icon: PackagePlus },
        { label: t('suppliersPage.qty'), value: String(totals.qty), icon: Boxes },
        { label: t('suppliersPage.suppliersCount'), value: String(totals.suppliers), icon: Truck },
      ]} />

      <div className="space-y-2">
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
          ) : docs.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('suppliersPage.noPurchases')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap">{t('aktSverka.dateTime')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.supplier')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.warehouse')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.product')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.qty')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.sum')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map(d => {
                    const names = Array.from(new Set(d.rows.map(r => r.product_name ?? '—')))
                    return (
                      <tr
                        key={d.key}
                        onClick={() => setSelected(d)}
                        className="cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap text-gray-900 dark:text-gray-100">
                          {formatDate(d.at.slice(0, 10))} <span className="text-gray-400">{d.at.slice(11, 16)}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          {d.supplierId
                            ? <Link href={`/yetkazuvchilar/${d.supplierId}`} onClick={ev => ev.stopPropagation()} className="text-gray-900 dark:text-gray-100 hover:underline">{d.supplierName}</Link>
                            : <span className="text-gray-400 dark:text-gray-500">{d.supplierName}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{d.warehouses}</td>
                        <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">
                          {names.slice(0, 2).join(', ')}{names.length > 2 && ` +${names.length - 2}`}
                          <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">· {d.rows.length} {t('aktSverka.positions')}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{d.qty}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(d.sum)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    <td className="px-4 py-3" colSpan={4}>{t('reportsKit.total')}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{totals.qty}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(totals.sum)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        {docs.length > PAGE_SIZE && (
          <Pagination currentPage={safePage} totalPages={totalPages} totalItems={docs.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
        )}
      </div>

      <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('aktSverka.typePurchase')}{selected ? ` · ${formatDate(selected.at.slice(0, 10))} ${selected.at.slice(11, 16)}` : ''}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('suppliersPage.supplier')}</p>
                  <p className="mt-0.5 font-medium text-gray-900 dark:text-gray-100">{selected.supplierName}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('suppliersPage.warehouse')}</p>
                  <p className="mt-0.5 font-medium text-gray-900 dark:text-gray-100">{selected.warehouses}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('suppliersPage.qty')}</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">{selected.qty}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('suppliersPage.sum')}</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(selected.sum)}</p>
                </div>
              </div>
              {selected.note && (
                <p><span className="text-gray-400 dark:text-gray-500">{t('suppliersPage.note')}:</span> <span className="text-gray-900 dark:text-gray-100">{selected.note}</span></p>
              )}
              <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-800">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-white dark:bg-gray-900">
                    <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                      <th className="px-3 py-2 text-left font-medium">{t('aktSverka.no')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('suppliersPage.product')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('kirimReport.variant')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('suppliersPage.qty')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('kirimReport.purchasePrice')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('kirimReport.sellingPrice')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('suppliersPage.sum')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.rows.map((e, j) => (
                      <tr key={e.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                        <td className="px-3 py-2 text-gray-400 dark:text-gray-500">{j + 1}</td>
                        <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{e.product_name ?? '—'}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{variantOf(e) || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatPrice(Number(e.purchase_price ?? 0))}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(e.selling_price ?? 0))}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(entryAmount(e))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                      <td className="px-3 py-2" colSpan={3}>{t('reportsKit.total')}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{selected.qty}</td>
                      <td colSpan={2} />
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatPrice(selected.sum)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
