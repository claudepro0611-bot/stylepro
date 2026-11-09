'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Banknote, CreditCard, FileText, Loader2, PackagePlus, Pencil, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate, formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { KpiGrid } from '@/components/reports/ReportKit'
import {
  ActiveBadge, BackLink, DocActions, DocStatusBadge, InfoField, Segmented, TableCard,
  prodCardCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import {
  DebtValue, PaymentCancelButton, PaymentMethodBadge, SupplierFormDialog, SupplierPaymentDialog, useCancelSupplierPayment, useProdSuppliers,
} from '@/components/production/SupplierKit'

type Tab = 'receipts' | 'payments' | 'ledger'

interface ReceiptRow {
  id: string
  number: number
  doc_date: string
  warehouse_id: string
  total: number
  status: string
  created_by_name: string | null
}

interface PaymentRow {
  id: string
  number: number
  pay_date: string
  amount: number
  method: string
  status: string
  note: string | null
  created_by_name: string | null
  created_at: string
}

interface LedgerRow {
  key: string
  ymd: string
  sortTs: string
  href: string | null
  label: string
  income: number
  outcome: number
  balance: number
}

export default function ProdSupplierViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { warehouseById } = useProdRefs()
  const { suppliers, loading: suppliersLoading, reload: reloadSuppliers } = useProdSuppliers()

  const [tab, setTab] = useState<Tab>('receipts')
  const [receipts, setReceipts] = useState<ReceiptRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)

  const supplier = suppliers.find(s => s.id === id) ?? null

  const load = useCallback(async () => {
    const supabase = createClient()
    const [rRes, pRes] = await Promise.all([
      fetchAllRows<ReceiptRow>((from, to) => supabase.from('prod_receipts')
        .select('id, number, doc_date, warehouse_id, total, status, created_by_name')
        .eq('supplier_id', id)
        .order('number', { ascending: false })
        .range(from, to)),
      fetchAllRows<PaymentRow>((from, to) => supabase.from('prod_supplier_payments')
        .select('id, number, pay_date, amount, method, status, note, created_by_name, created_at')
        .eq('supplier_id', id)
        .order('number', { ascending: false })
        .range(from, to)),
    ])
    if (rRes.error || pRes.error) toast.error(t('productionErrors.unknown'))
    setReceipts(rRes.data)
    setPayments(pRes.data)
    setLoading(false)
  }, [id, t])

  useEffect(() => { load() }, [load])

  const reloadAll = useCallback(() => { load(); reloadSuppliers() }, [load, reloadSuppliers])

  const { canCancel: canCancelReceipt, cancel: cancelReceipt, busyId: receiptBusyId } = useCancelDoc('receipt', reloadAll)
  const { canCancel: canCancelPayment, cancel: cancelPayment, busyId: paymentBusyId } = useCancelSupplierPayment(reloadAll)

  // Akt-sverka: posted receipts (+) and payments (-) in date order with a running balance.
  const ledger = useMemo<LedgerRow[]>(() => {
    const entries = [
      ...receipts.filter(r => r.status === 'posted').map(r => ({
        key: `r-${r.id}`,
        ymd: localYmd(new Date(r.doc_date)),
        sortTs: r.doc_date,
        href: `/xom-ashyo-kirim/${r.id}`,
        label: `${t('production.suppliers.receiptDoc')} #${r.number}`,
        income: Number(r.total),
        outcome: 0,
      })),
      ...payments.filter(p => p.status === 'posted').map(p => ({
        key: `p-${p.id}`,
        ymd: p.pay_date,
        sortTs: p.created_at,
        href: null,
        label: `${t('production.suppliers.paymentDoc')} #${p.number}`,
        income: 0,
        outcome: Number(p.amount),
      })),
    ].sort((a, b) => a.ymd.localeCompare(b.ymd) || a.sortTs.localeCompare(b.sortTs))
    const out: LedgerRow[] = []
    for (const e of entries) {
      const prev = out.length > 0 ? out[out.length - 1].balance : 0
      out.push({ ...e, balance: Math.round((prev + e.income - e.outcome) * 100) / 100 })
    }
    return out
  }, [receipts, payments, t])

  if (suppliersLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!supplier) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-yetkazuvchilar" label={t('production.suppliers.backToList')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const ledgerIncome = ledger.reduce((s, e) => s + e.income, 0)
  const ledgerOutcome = ledger.reduce((s, e) => s + e.outcome, 0)

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-yetkazuvchilar" label={t('production.suppliers.backToList')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{supplier.name}</h1>
          <ActiveBadge active={supplier.isActive} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setFormOpen(true)}>
            <Pencil className="h-3.5 w-3.5" /> {t('production.common.edit')}
          </Button>
          <Button onClick={() => setPayOpen(true)}>
            <Banknote className="h-3.5 w-3.5" /> {t('production.suppliers.pay')}
          </Button>
        </div>
      </div>

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4')}>
        <InfoField label={t('production.suppliers.phone')}>{supplier.phone || '—'}</InfoField>
        <InfoField label={t('production.suppliers.address')}>{supplier.address || '—'}</InfoField>
        <InfoField label={t('production.suppliers.lastReceipt')}>{supplier.lastReceiptAt ? formatDate(supplier.lastReceiptAt) : '—'}</InfoField>
        <InfoField label={t('production.suppliers.lastPayment')}>{supplier.lastPaymentAt ? formatDate(supplier.lastPaymentAt) : '—'}</InfoField>
        {supplier.note && (
          <div className="col-span-2 lg:col-span-4">
            <InfoField label={t('production.common.note')}><span className="whitespace-pre-wrap font-normal">{supplier.note}</span></InfoField>
          </div>
        )}
      </div>

      <KpiGrid items={[
        { label: t('production.suppliers.purchased'), value: formatPrice(supplier.purchased), icon: PackagePlus },
        { label: t('production.suppliers.paid'), value: formatPrice(supplier.paid), icon: CreditCard },
        supplier.debt < 0
          ? { label: t('production.suppliers.advance'), value: formatPrice(-supplier.debt), icon: Wallet, tone: 'positive' as const }
          : { label: t('production.suppliers.debt'), value: formatPrice(supplier.debt), icon: Wallet, tone: supplier.debt > 0 ? 'negative' as const : undefined },
      ]} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          options={[
            { value: 'receipts' as const, label: `${t('production.suppliers.tabReceipts')} (${receipts.length})` },
            { value: 'payments' as const, label: `${t('production.suppliers.tabPayments')} (${payments.length})` },
            { value: 'ledger' as const, label: t('production.suppliers.tabLedger') },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'ledger' && <span className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.suppliers.postedOnly')}</span>}
      </div>

      {tab === 'receipts' && (
        <TableCard loading={loading} empty={receipts.length === 0} emptyText={t('production.suppliers.receiptsEmpty')} emptyIcon={PackagePlus}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.number')}</th>
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thCls}>{t('production.common.warehouse')}</th>
                <th className={thRightCls}>{t('production.common.total')}</th>
                <th className={thCls}>{t('production.common.status')}</th>
                <th className={thCls}>{t('production.common.author')}</th>
                <th className={thRightCls}>{t('production.common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map(r => (
                <tr key={r.id} onClick={() => router.push(`/xom-ashyo-kirim/${r.id}`)} className={cn(trCls, 'cursor-pointer', r.status === 'cancelled' && 'opacity-60')}>
                  <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{r.number}</td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.doc_date)}</td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{warehouseById.get(r.warehouse_id)?.name ?? '—'}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(r.total))}</td>
                  <td className={tdCls}><DocStatusBadge status={r.status} /></td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>
                  <td className={tdCls}>
                    <DocActions
                      viewHref={`/xom-ashyo-kirim/${r.id}`}
                      canCancel={canCancelReceipt}
                      posted={r.status === 'posted'}
                      busy={receiptBusyId === r.id}
                      onCancel={() => cancelReceipt(r.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      {tab === 'payments' && (
        <TableCard loading={loading} empty={payments.length === 0} emptyText={t('production.suppliers.paymentsEmpty')} emptyIcon={CreditCard}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.number')}</th>
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thRightCls}>{t('production.suppliers.amount')}</th>
                <th className={thCls}>{t('production.suppliers.method')}</th>
                <th className={thCls}>{t('production.common.status')}</th>
                <th className={thCls}>{t('production.common.author')}</th>
                <th className={thCls}>{t('production.common.note')}</th>
                <th className={thRightCls}>{t('production.common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id} className={cn(trCls, p.status === 'cancelled' && 'opacity-60')}>
                  <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>#{p.number}</td>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(p.pay_date)}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(Number(p.amount))}</td>
                  <td className={tdCls}><PaymentMethodBadge method={p.method} /></td>
                  <td className={tdCls}><DocStatusBadge status={p.status} /></td>
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{p.created_by_name ?? '—'}</td>
                  <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>{p.note ?? ''}</td>
                  <td className={tdCls}>
                    <PaymentCancelButton
                      show={canCancelPayment && p.status === 'posted'}
                      busy={paymentBusyId === p.id}
                      onClick={() => cancelPayment(p.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}

      {tab === 'ledger' && (
        <TableCard loading={loading} empty={ledger.length === 0} emptyText={t('production.suppliers.ledgerEmpty')} emptyIcon={FileText}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                <th className={thCls}>{t('production.common.date')}</th>
                <th className={thCls}>{t('production.suppliers.document')}</th>
                <th className={thRightCls}>{t('production.suppliers.income')}</th>
                <th className={thRightCls}>{t('production.suppliers.outcome')}</th>
                <th className={thRightCls}>{t('production.suppliers.runningBalance')}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map(e => (
                <tr key={e.key} className={trCls}>
                  <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(e.ymd)}</td>
                  <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>
                    {e.href ? (
                      <Link href={e.href} className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">{e.label}</Link>
                    ) : e.label}
                  </td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{e.income ? formatPrice(e.income) : ''}</td>
                  <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{e.outcome ? formatPrice(e.outcome) : ''}</td>
                  <td className={cn(tdCls, 'text-right')}><DebtValue debt={e.balance} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800/50 font-medium text-gray-900 dark:text-gray-100">
                <td colSpan={2} className="px-4 py-3">{t('production.common.total')}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(ledgerIncome)}</td>
                <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(ledgerOutcome)}</td>
                <td className="px-4 py-3 text-right"><DebtValue debt={Math.round((ledgerIncome - ledgerOutcome) * 100) / 100} /></td>
              </tr>
            </tfoot>
          </table>
        </TableCard>
      )}

      <SupplierFormDialog open={formOpen} onOpenChange={setFormOpen} supplier={supplier} onSaved={() => { setFormOpen(false); reloadSuppliers() }} />
      <SupplierPaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        suppliers={suppliers}
        supplierId={supplier.id}
        onSaved={() => { setPayOpen(false); reloadAll() }}
      />
    </div>
  )
}
