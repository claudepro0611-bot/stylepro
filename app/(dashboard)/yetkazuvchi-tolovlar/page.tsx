'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Banknote, Plus, Receipt, Trash2, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { KpiGrid, ReportHeader, ReportTable, downloadCsv, monthToDate, type ReportColumn } from '@/components/reports/ReportKit'
import { SupplierPaymentDialog } from '@/components/suppliers/SupplierDialogs'
import { fetchSuppliersWithBalance, supplierErrorKey, type SupplierPaymentMethod, type SupplierWithBalance } from '@/lib/suppliers'

interface PaymentRow {
  id: string
  supplier_id: string
  amount: number
  payment_method: SupplierPaymentMethod
  date: string
  note: string | null
  created_by_name: string | null
}

export default function SupplierPaymentsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [supplierFilter, setSupplierFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [suppliers, setSuppliers] = useState<SupplierWithBalance[]>([])
  const [payOpen, setPayOpen] = useState(false)

  const loadSuppliers = useCallback(async () => { setSuppliers(await fetchSuppliersWithBalance(createClient())) }, [])
  useEffect(() => { loadSuppliers() }, [loadSuppliers])

  const loadPayments = useCallback(async () => {
    setLoading(true)
    let q = createClient().from('supplier_payments')
      .select('id, supplier_id, amount, payment_method, date, note, created_by_name')
      .order('date', { ascending: false })
    if (range) q = q.gte('date', range.from).lte('date', range.to)
    if (supplierFilter) q = q.eq('supplier_id', supplierFilter)
    const { data } = await q
    setPayments((data ?? []) as PaymentRow[])
    setLoading(false)
  }, [range, supplierFilter])
  useEffect(() => { loadPayments() }, [loadPayments])

  const nameOf = useMemo(() => {
    const m = new Map(suppliers.map(s => [s.id, s.name]))
    return (id: string) => m.get(id) ?? '—'
  }, [suppliers])

  const methodLabel: Record<SupplierPaymentMethod, string> = {
    cash: t('suppliersPage.cash'), card: t('suppliersPage.card'), transfer: t('suppliersPage.transfer'),
  }

  const totals = useMemo(() => {
    const byMethod = { cash: 0, card: 0, transfer: 0 } as Record<SupplierPaymentMethod, number>
    for (const p of payments) byMethod[p.payment_method] = (byMethod[p.payment_method] ?? 0) + Number(p.amount)
    return { sum: payments.reduce((s, p) => s + Number(p.amount), 0), count: payments.length, byMethod }
  }, [payments])
  const totalDebt = useMemo(() => suppliers.reduce((s, x) => s + Math.max(0, x.balance), 0), [suppliers])

  async function remove(p: PaymentRow) {
    if (!window.confirm(t('suppliersPage.deleteConfirm'))) return
    const { error } = await createClient().rpc('delete_supplier_payment', { p_id: p.id })
    if (error) { toast.error(t(supplierErrorKey(error.message))); return }
    toast.success(t('suppliersPage.paymentDeleted'))
    loadPayments()
    loadSuppliers()
  }

  const columns: ReportColumn<PaymentRow>[] = [
    { key: 'date', label: t('suppliersPage.date'), render: p => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(p.date)}</span>, sortValue: p => p.date },
    {
      key: 'supplier', label: t('suppliersPage.supplier'),
      render: p => <Link href={`/yetkazuvchilar/${p.supplier_id}`} className="text-gray-900 dark:text-gray-100 hover:underline">{nameOf(p.supplier_id)}</Link>,
      sortValue: p => nameOf(p.supplier_id), footer: t('reportsKit.total'),
    },
    { key: 'method', label: t('suppliersPage.method'), render: p => <span className="rounded-full px-2 py-0.5 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">{methodLabel[p.payment_method] ?? p.payment_method}</span>, sortValue: p => p.payment_method },
    { key: 'note', label: t('suppliersPage.note'), render: p => <span className="text-gray-500 dark:text-gray-400">{p.note ?? ''}</span> },
    { key: 'by', label: t('suppliersPage.by'), render: p => <span className="text-gray-500 dark:text-gray-400">{p.created_by_name ?? '—'}</span> },
    { key: 'amount', label: t('suppliersPage.amount'), align: 'right', render: p => <span className="font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(p.amount))}</span>, sortValue: p => Number(p.amount), footer: formatPrice(totals.sum) },
    {
      key: 'actions', label: '', align: 'right',
      render: p => (
        <button onClick={() => remove(p)} aria-label={t('suppliersPage.delete')} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ),
    },
  ]

  function exportCsv() {
    downloadCsv('yetkazuvchi_tolovlar', [t('suppliersPage.date'), t('suppliersPage.supplier'), t('suppliersPage.method'), t('suppliersPage.note'), t('suppliersPage.by'), t('suppliersPage.amount')],
      payments.map(p => [p.date, nameOf(p.supplier_id), methodLabel[p.payment_method] ?? p.payment_method, p.note ?? '', p.created_by_name ?? '', Number(p.amount)]))
  }

  return (
    <div className="space-y-6">
      <ReportHeader title={t('suppliersPage.paymentsTitle')} subtitle={t('suppliersPage.paymentsSubtitle')} range={range} onRangeChange={setRange} onExport={exportCsv} exportLabel={t('reportsKit.export')}>
        <div className="w-full sm:w-64">
          <SearchSelect
            options={[{ value: '', label: t('suppliersPage.allSuppliers') }, ...suppliers.map(s => ({ value: s.id, label: s.name, sublabel: s.phone || undefined }))]}
            value={supplierFilter}
            onChange={setSupplierFilter}
            placeholder={t('suppliersPage.allSuppliers')}
          />
        </div>
        <button
          onClick={() => setPayOpen(true)}
          className="sm:ml-auto flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <Plus className="h-4 w-4" /> {t('suppliersPage.newPayment')}
        </button>
      </ReportHeader>

      <KpiGrid items={[
        { label: t('suppliersPage.totalPaid'), value: formatPrice(totals.sum), icon: Banknote },
        { label: t('suppliersPage.paymentsCount'), value: String(totals.count), icon: Receipt },
        { label: t('suppliersPage.cash'), value: formatPrice(totals.byMethod.cash), icon: Wallet },
        { label: t('suppliersPage.totalDebt'), value: formatPrice(totalDebt), icon: Wallet, tone: totalDebt > 0 ? 'negative' : undefined },
      ]} />

      <ReportTable rows={payments} columns={columns} rowKey={p => p.id} loading={loading} emptyText={t('suppliersPage.noPaymentsList')} initialSort={{ key: 'date', dir: 'desc' }} />

      <SupplierPaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        supplierId={null}
        supplierName=""
        balance={0}
        choices={suppliers.filter(s => s.isActive).map(s => ({ id: s.id, name: s.name, phone: s.phone, balance: s.balance }))}
        onSaved={() => { setPayOpen(false); loadPayments(); loadSuppliers() }}
      />
    </div>
  )
}
