'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Undo2, Banknote, FileText, Loader2, MapPin, Package, Pencil, Phone, Trash2, Wallet, Building2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { KpiGrid } from '@/components/reports/ReportKit'
import { BalanceBadge, SupplierFormDialog, SupplierPaymentDialog } from '@/components/suppliers/SupplierDialogs'
import { entryAmount, mapSupplier, returnValue, supplierErrorKey, type Supplier, type SupplierPaymentMethod } from '@/lib/suppliers'

interface EntryRow {
  id: string
  product_name: string | null
  size: string | null
  color: string | null
  quantity: number
  purchase_price: number | null
  total_amount: number | null
  date: string
}

interface PaymentRow {
  id: string
  amount: number
  payment_method: SupplierPaymentMethod
  date: string
  note: string | null
  created_by_name: string | null
}

interface ReturnRow {
  id: string
  number: number
  date: string
  note: string | null
  supplier_return_items: { id: string; product_name: string; size: string; color: string; quantity: number; price: number }[]
}

type Tab = 'entries' | 'returns' | 'payments'

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()

  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('entries')
  const [editOpen, setEditOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [supRes, entriesRes, paymentsRes, returnsRes] = await Promise.all([
      supabase.from('suppliers').select('id, name, phone, company_name, inn, address, note, opening_balance, is_active').eq('id', id).maybeSingle(),
      fetchAllRows<EntryRow>((from, to) =>
        supabase.from('stock_in_entries')
          .select('id, product_name, size, color, quantity, purchase_price, total_amount, date')
          .eq('supplier_id', id).eq('entry_type', 'purchase')
          .order('date', { ascending: false }).order('id').range(from, to)),
      supabase.from('supplier_payments')
        .select('id, amount, payment_method, date, note, created_by_name')
        .eq('supplier_id', id).order('date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('supplier_returns')
        .select('id, number, date, note, supplier_return_items(id, product_name, size, color, quantity, price)')
        .eq('supplier_id', id).order('number', { ascending: false }),
    ])
    setSupplier(supRes.data ? mapSupplier(supRes.data) : null)
    setEntries(entriesRes.data)
    setPayments((paymentsRes.data ?? []) as PaymentRow[])
    setReturns((returnsRes.data ?? []) as unknown as ReturnRow[])
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const purchases = useMemo(() => entries.reduce((s, e) => s + entryAmount(e), 0), [entries])
  const paid = useMemo(() => payments.reduce((s, p) => s + Number(p.amount), 0), [payments])
  const returned = useMemo(() => returns.reduce((s, r) => s + returnValue(r.supplier_return_items), 0), [returns])
  const balance = (supplier?.openingBalance ?? 0) + purchases - returned - paid

  const methodLabel: Record<SupplierPaymentMethod, string> = {
    cash: t('suppliersPage.cash'), card: t('suppliersPage.card'), transfer: t('suppliersPage.transfer'),
  }

  async function deletePayment(p: PaymentRow) {
    if (!window.confirm(t('suppliersPage.deleteConfirm'))) return
    const { error } = await createClient().rpc('delete_supplier_payment', { p_id: p.id })
    if (error) { toast.error(t(supplierErrorKey(error.message))); return }
    toast.success(t('suppliersPage.paymentDeleted'))
    load()
  }

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!supplier) {
    return (
      <div className="space-y-4">
        <Link href="/yetkazuvchilar" className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4" /> {t('suppliersPage.back')}
        </Link>
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('suppliersPage.notFound')}</p>
      </div>
    )
  }

  const tabCls = (active: boolean) => cn(
    'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
  )

  return (
    <div className="space-y-5">
      <Link href="/yetkazuvchilar" className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
        <ArrowLeft className="h-4 w-4" /> {t('suppliersPage.back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{supplier.name}</h1>
            {!supplier.isActive && <span className="rounded-full px-2 py-0.5 text-xs bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">{t('suppliersPage.inactive')}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
            {supplier.phone && <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 text-gray-400" />{supplier.phone}</span>}
            {supplier.companyName && <span className="inline-flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-gray-400" />{supplier.companyName}{supplier.inn && ` · ${t('suppliersPage.inn')} ${supplier.inn}`}</span>}
            {supplier.address && <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-gray-400" />{supplier.address}</span>}
          </div>
          {supplier.note && <p className="text-sm text-gray-500 dark:text-gray-400">{supplier.note}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/yetkazuvchilar/${supplier.id}/akt-sverka`}
            className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <FileText className="h-4 w-4" /> {t('aktSverka.button')}
          </Link>
          <button
            onClick={() => setEditOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <Pencil className="h-4 w-4" /> {t('suppliersPage.edit')}
          </button>
          <button
            onClick={() => setPayOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            <Banknote className="h-4 w-4" /> {t('suppliersPage.pay')}
          </button>
        </div>
      </div>

      <KpiGrid items={[
        { label: t('suppliersPage.purchases'), value: formatPrice(purchases), icon: Package },
        ...(returned ? [{ label: t('suppliersPage.returned'), value: formatPrice(returned), icon: Undo2 }] : []),
        { label: t('suppliersPage.paid'), value: formatPrice(paid), icon: Banknote },
        ...(supplier.openingBalance ? [{ label: t('suppliersPage.openingBalance'), value: formatPrice(supplier.openingBalance), icon: Wallet }] : []),
        { label: t('suppliersPage.position'), value: Math.abs(balance) < 0.5 ? formatPrice(0) : `${balance < 0 ? '+' : '−'}${formatPrice(Math.abs(balance))}`, icon: Wallet, tone: balance > 0.5 ? 'negative' as const : balance < -0.5 ? 'positive' as const : undefined },
      ]} />

      <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
        <button onClick={() => setTab('entries')} className={tabCls(tab === 'entries')}>{t('suppliersPage.entriesTab')} ({entries.length})</button>
        <button onClick={() => setTab('returns')} className={tabCls(tab === 'returns')}>{t('suppliersPage.returnsTab')} ({returns.length})</button>
        <button onClick={() => setTab('payments')} className={tabCls(tab === 'payments')}>{t('suppliersPage.paymentsTab')} ({payments.length})</button>
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {tab === 'entries' ? (
          entries.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('suppliersPage.noEntries')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.date')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.product')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.qty')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('kirimReport.purchasePrice')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.sum')}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(e.date.slice(0, 10))}</td>
                      <td className="px-4 py-2.5">
                        <p className="text-gray-900 dark:text-gray-100">{e.product_name ?? '—'}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{[e.color, e.size].filter(Boolean).join(' / ')}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{e.quantity}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(Number(e.purchase_price ?? 0))}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(entryAmount(e))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    <td className="px-4 py-3" colSpan={2}>{t('reportsKit.total')}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{entries.reduce((s, e) => s + Number(e.quantity), 0)}</td>
                    <td />
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(purchases)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        ) : tab === 'returns' ? (
          returns.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('suppliersPage.noReturns')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.date')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('transfers.number')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.product')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.qty')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.sum')}</th>
                  </tr>
                </thead>
                <tbody>
                  {returns.flatMap(r => r.supplier_return_items.map((i, idx) => (
                    <tr key={i.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">{idx === 0 ? formatDate(r.date) : ''}</td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{idx === 0 ? `#${r.number}` : ''}</td>
                      <td className="px-4 py-2.5">
                        <p className="text-gray-900 dark:text-gray-100">{i.product_name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{[i.color, i.size].filter(Boolean).join(' / ')}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{i.quantity}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(i.quantity * Number(i.price))}</td>
                    </tr>
                  )))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    <td className="px-4 py-3" colSpan={4}>{t('reportsKit.total')}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(returned)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        ) : payments.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('suppliersPage.noPayments')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.date')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.method')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.note')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.by')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.amount')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">{formatDate(p.date)}</td>
                    <td className="px-4 py-2.5"><span className="rounded-full px-2 py-0.5 text-xs bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">{methodLabel[p.payment_method] ?? p.payment_method}</span></td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{p.note ?? ''}</td>
                    <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{p.created_by_name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(Number(p.amount))}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => deletePayment(p)} aria-label={t('suppliersPage.delete')} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                  <td className="px-4 py-3" colSpan={4}>{t('reportsKit.total')}</td>
                  <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(paid)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 text-sm text-gray-500 dark:text-gray-400">
        {t('suppliersPage.position')}: <BalanceBadge balance={balance} />
      </div>

      <SupplierFormDialog open={editOpen} onOpenChange={setEditOpen} supplier={supplier} onSaved={() => { setEditOpen(false); load() }} onDeleted={() => router.push('/yetkazuvchilar')} />
      <SupplierPaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        supplierId={supplier.id}
        supplierName={supplier.name}
        balance={balance}
        onSaved={() => { setPayOpen(false); load() }}
      />
    </div>
  )
}
