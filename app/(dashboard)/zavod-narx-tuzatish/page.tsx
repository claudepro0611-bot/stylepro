'use client'

// Narx tuzatish: every price correction of the company. Corrections are
// created from the receipt / milk-intake pages (prod_create_price_correction);
// cancel (latest of a line only) via prod_cancel_document('price_correction').

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Tags } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { monthToDate } from '@/components/reports/ReportKit'
import { FilterBar, PageHeader, TableCard, prodFieldCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useProdSuppliers } from '@/components/production/SupplierKit'
import { ExportButton } from '@/components/production/ReportKit'
import { NotAvailableNote, PriceCorrectionsSection, useInventoryDocs } from '@/components/production/InventoryKit'
import { rangeToIsoBounds } from '@/lib/production'
import { PRICE_CORRECTION_COLS, mapPriceCorrection, type PriceCorrection } from '@/lib/inventory'
import { dateTimeCell, downloadXlsx, x2, x3 } from '@/lib/production-reports'

const ID_CHUNK = 150

export default function PriceCorrectionListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const available = useInventoryDocs()
  const { itemById } = useProdRefs()
  const { suppliers } = useProdSuppliers()

  const [rows, setRows] = useState<PriceCorrection[]>([])
  const [receiptNos, setReceiptNos] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [supplierId, setSupplierId] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    if (!available) return
    setLoading(true)
    const supabase = createClient()
    const bounds = range ? rangeToIsoBounds(range) : null
    const { data, error } = await fetchAllRows((from, to) => {
      let q = supabase.from('prod_price_corrections').select(PRICE_CORRECTION_COLS)
      if (bounds) q = q.gte('doc_date', bounds.fromIso).lt('doc_date', bounds.toIso)
      if (supplierId) q = q.eq('supplier_id', supplierId)
      if (status) q = q.eq('status', status)
      return q.order('number', { ascending: false }).range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    const list = data.map(mapPriceCorrection)
    const ids = [...new Set(list.map(c => c.receiptId))]
    const nos = new Map<string, number>()
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data: rs } = await supabase.from('prod_receipts').select('id, number').in('id', ids.slice(i, i + ID_CHUNK))
      for (const r of rs ?? []) nos.set(r.id, r.number)
    }
    setRows(list)
    setReceiptNos(nos)
    setLoading(false)
  }, [available, range, supplierId, status, t])

  useEffect(() => { load() }, [load])

  const supplierName = useCallback((id: string | null) => (id ? suppliers.find(s => s.id === id)?.name ?? '' : ''), [suppliers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(c => String(c.number).includes(q)
      || (itemById.get(c.itemId)?.name ?? '').toLowerCase().includes(q)
      || supplierName(c.supplierId).toLowerCase().includes(q))
  }, [rows, search, itemById, supplierName])

  const totals = useMemo(() => ({
    debt: filtered.filter(c => c.status === 'posted').reduce((s, c) => s + c.debtDelta, 0),
  }), [filtered])

  function exportXlsx() {
    downloadXlsx('zavod_narx_tuzatish', [
      t('production.common.number'), t('production.common.date'), t('prodInventory.corrections.receipt'), t('production.suppliers.supplier'),
      t('production.common.item'), t('production.common.qty'), `${t('prodInventory.corrections.oldPrice')} (UZS)`, `${t('prodInventory.corrections.newPrice')} (UZS)`,
      `${t('prodInventory.corrections.debtDelta')} (UZS)`, `${t('prodInventory.corrections.stockDelta')} (UZS)`, `${t('prodInventory.corrections.consumedVariance')} (UZS)`,
      t('production.common.status'), t('production.common.author'), t('production.common.note'),
    ], filtered.map(c => [
      c.number, dateTimeCell(c.docDate), receiptNos.get(c.receiptId) ?? '', supplierName(c.supplierId), itemById.get(c.itemId)?.name ?? '',
      x3(c.qty), x2(c.oldPrice), x2(c.newPrice), x2(c.debtDelta), x2(c.stockDelta), x2(c.consumedVariance),
      c.status === 'cancelled' ? t('production.common.statusCancelled') : t('production.common.statusPosted'), c.createdByName, c.note,
    ]), t('prodInventory.corrections.title'))
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('prodInventory.corrections.title')} subtitle={t('prodInventory.corrections.subtitle')} />

      {available === false ? <NotAvailableNote /> : (
        <>
          <FilterBar
            onReset={() => { setRange(monthToDate()); setSupplierId(''); setStatus(''); setSearch('') }}
            columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />}
          >
            <DateRangeFilter value={range} onChange={setRange} />
            <select value={supplierId} onChange={e => setSupplierId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
              <option value="">{t('production.suppliers.allSuppliers')}</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
              <option value="">{t('production.common.allStatuses')}</option>
              <option value="posted">{t('production.common.statusPosted')}</option>
              <option value="cancelled">{t('production.common.statusCancelled')}</option>
            </select>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('prodInventory.corrections.search')} className={cn(prodFieldCls, 'pl-9')} />
            </div>
          </FilterBar>

          {loading || available === null || filtered.length === 0 ? (
            <TableCard loading={loading || available === null} empty emptyText={t('prodInventory.corrections.empty')} emptyIcon={Tags}><span /></TableCard>
          ) : (
            <>
              <PriceCorrectionsSection corrections={filtered} itemById={itemById} onChanged={load} showReceipt={{ numberById: receiptNos }} />
              <p className="text-right text-sm text-gray-500 dark:text-gray-400">
                {t('prodInventory.corrections.debtDelta')}: <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(totals.debt)}</span>
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}
