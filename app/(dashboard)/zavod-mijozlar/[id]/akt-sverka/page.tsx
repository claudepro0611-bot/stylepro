'use client'

// Akt sverka (reconciliation statement) with one wholesale CUSTOMER of the
// production module. Mirrors the supplier statement
// (zavod-yetkazuvchilar/[id]/akt-sverka):
//   Debet = sale (the customer's debt grows), Kredit = return / payment.
//   Balance = sales - returns - payments (posted only) =
//   prod_customer_balances.balance. Cancelled documents are listed struck
//   through and excluded from every total and from the running balance.
//   + green = the customer owes us, − red = advance (we owe the customer).

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowDown, ArrowLeft, Loader2, Printer } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { DateRangeValue } from '@/components/ui/date-range-filter'
import { DateRangeFilter } from '@/components/ui/date-range-filter'
import { downloadCsv, monthToDate } from '@/components/reports/ReportKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { useSalesAvailable } from '@/components/production/SalesKit'
import { formatQty, unitKey } from '@/lib/production'
import {
  CUSTOMER_PAYMENT_COLS, RETURN_COLS, SALE_COLS, SALE_ITEM_COLS,
  type CustomerPaymentRow, type ReturnRow, type SaleItemRow, type SaleRow,
} from '@/lib/sales'

type TxType = 'sale' | 'return' | 'payment'

interface Tx {
  key: string
  type: TxType
  number: string
  at: string
  debit: number
  credit: number
  description: string
  author: string
  items: { name: string; unit: string; qty: number; price: number; sum: number }[]
  info: { label: string; value: string }[]
  cancelled?: boolean
}

interface CustomerRow { id: string; name: string; legal_name: string | null; inn: string | null; phone: string | null }

const timeOf = (iso: string) => (iso.length > 10 ? iso.slice(11, 16) : '')
const dayOf = (iso: string) => iso.slice(0, 10)
const sumDebit = (list: Tx[]) => list.filter(x => !x.cancelled).reduce((s, x) => s + x.debit, 0)
const sumCredit = (list: Tx[]) => list.filter(x => !x.cancelled).reduce((s, x) => s + x.credit, 0)

function localIso(ts: string) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function ProdCustomerAktSverkaPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const available = useSalesAvailable()
  const { itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const [customer, setCustomer] = useState<CustomerRow | null>(null)
  const [sales, setSales] = useState<(SaleRow & { items: SaleItemRow[] })[]>([])
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [payments, setPayments] = useState<CustomerPaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [selected, setSelected] = useState<(Tx & { balance: number }) | null>(null)

  useEffect(() => {
    if (!available) return
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const [cRes, sRes, rRes, pRes] = await Promise.all([
        supabase.from('prod_customers').select('id, name, legal_name, inn, phone').eq('id', id).maybeSingle(),
        fetchAllRows<SaleRow>((from, to) => supabase.from('prod_sales').select(SALE_COLS).eq('customer_id', id).order('id').range(from, to)),
        fetchAllRows<ReturnRow>((from, to) => supabase.from('prod_sale_returns').select(RETURN_COLS).eq('customer_id', id).order('id').range(from, to)),
        fetchAllRows<CustomerPaymentRow>((from, to) => supabase.from('prod_customer_payments').select(CUSTOMER_PAYMENT_COLS).eq('customer_id', id).order('id').range(from, to)),
      ])
      if (cancelled) return
      const ids = sRes.data.map(s => s.id)
      const lines: SaleItemRow[] = []
      for (let i = 0; i < ids.length; i += 150) {
        const { data } = await supabase.from('prod_sale_items').select(SALE_ITEM_COLS).in('sale_id', ids.slice(i, i + 150))
        lines.push(...((data ?? []) as SaleItemRow[]))
      }
      if (cancelled) return
      const bySale = new Map<string, SaleItemRow[]>()
      for (const l of lines) {
        const arr = bySale.get(l.sale_id)
        if (arr) arr.push(l)
        else bySale.set(l.sale_id, [l])
      }
      setCustomer((cRes.data as CustomerRow | null) ?? null)
      setSales(sRes.data.map(s => ({ ...s, items: bySale.get(s.id) ?? [] })))
      setReturns(rRes.data)
      setPayments(pRes.data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, available])

  const methodLabel: Record<string, string> = useMemo(
    () => ({ cash: t('suppliersPage.cash'), card: t('suppliersPage.card'), transfer: t('suppliersPage.transfer') }), [t])

  const txs = useMemo<Tx[]>(() => {
    const list: Tx[] = []
    const saleNo = new Map(sales.map(s => [s.id, s.number]))
    for (const s of sales) {
      const names = Array.from(new Set(s.items.map(l => itemById.get(l.item_id)?.name ?? '—')))
      list.push({
        key: `s:${s.id}`,
        type: 'sale',
        cancelled: s.status === 'cancelled',
        number: String(s.number),
        at: localIso(s.doc_date),
        debit: Number(s.total),
        credit: 0,
        description: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} · ${s.items.length} ${t('aktSverka.positions')}${s.note ? ` · ${s.note}` : ''}`,
        author: s.created_by_name ?? '—',
        items: s.items.map(l => {
          const item = itemById.get(l.item_id)
          return { name: item?.name ?? '—', unit: t(unitKey(l.unit || item?.unit || 'pcs')), qty: Number(l.qty), price: Number(l.price), sum: Number(l.total) }
        }),
        info: [
          { label: t('suppliersPage.warehouse'), value: warehouseById.get(s.warehouse_id)?.name ?? '—' },
          { label: t('prodSales.common.subtotal'), value: formatPrice(Number(s.subtotal)) },
          { label: `${t('prodSales.common.vat')} ${Number(s.vat_rate)}%`, value: formatPrice(Number(s.vat_amount)) },
          ...(s.due_date ? [{ label: t('prodInventory.ageing.dueDate'), value: formatDate(s.due_date) }] : []),
          ...(s.note ? [{ label: t('suppliersPage.note'), value: s.note }] : []),
        ],
      })
    }
    for (const r of returns) {
      list.push({
        key: `r:${r.id}`,
        type: 'return',
        cancelled: r.status === 'cancelled',
        number: String(r.number),
        at: localIso(r.doc_date),
        debit: 0,
        credit: Number(r.total),
        description: [saleNo.has(r.sale_id) ? `${t('prodSales.customers.saleDoc')} #${saleNo.get(r.sale_id)}` : '', r.reason, r.note].filter(Boolean).join(' · '),
        author: r.created_by_name ?? '—',
        items: [],
        info: [
          { label: t('suppliersPage.warehouse'), value: warehouseById.get(r.warehouse_id)?.name ?? '—' },
          { label: t('prodSales.returns.credit'), value: formatPrice(Number(r.total)) },
          ...(r.reason ? [{ label: t('prodInventory.common.reason'), value: r.reason }] : []),
          ...(r.note ? [{ label: t('suppliersPage.note'), value: r.note }] : []),
        ],
      })
    }
    for (const p of payments) {
      list.push({
        key: `p:${p.id}`,
        type: 'payment',
        cancelled: p.status === 'cancelled',
        number: String(p.number),
        at: `${p.pay_date}T${localIso(p.created_at).slice(11, 19)}`,
        debit: 0,
        credit: Number(p.amount),
        description: [methodLabel[p.method] ?? p.method, p.note].filter(Boolean).join(' · '),
        author: p.created_by_name ?? '—',
        items: [],
        info: [
          { label: t('suppliersPage.amount'), value: formatPrice(Number(p.amount)) },
          { label: t('suppliersPage.method'), value: methodLabel[p.method] ?? p.method },
          ...(p.note ? [{ label: t('suppliersPage.note'), value: p.note }] : []),
        ],
      })
    }
    return list
  }, [sales, returns, payments, itemById, warehouseById, methodLabel, t, formatPrice])

  const withBalance = useMemo(() => {
    const sorted = [...txs].sort((a, b) => a.at.localeCompare(b.at))
    const out: (Tx & { balance: number })[] = []
    for (const tx of sorted) {
      const prev = out.length ? out[out.length - 1].balance : 0
      out.push({ ...tx, balance: tx.cancelled ? prev : prev + tx.debit - tx.credit })
    }
    return out
  }, [txs])

  const all = useMemo(() => {
    const debit = sumDebit(txs), credit = sumCredit(txs)
    return { debit, credit, final: debit - credit }
  }, [txs])

  const inPeriod = useMemo(
    () => withBalance.filter(x => !range || (dayOf(x.at) >= range.from && dayOf(x.at) <= range.to)),
    [withBalance, range],
  )
  const period = useMemo(() => {
    const before = range ? withBalance.filter(x => dayOf(x.at) < range.from) : []
    const start = before.length ? before[before.length - 1].balance : 0
    const debit = sumDebit(inPeriod), credit = sumCredit(inPeriod)
    return { start, debit, credit, end: start + debit - credit }
  }, [withBalance, inPeriod, range])

  const rows = useMemo(() => [...inPeriod].reverse(), [inPeriod])

  const typeLabel: Record<TxType, string> = {
    sale: t('prodSales.customers.saleDoc'), return: t('prodSales.customers.returnDoc'), payment: t('aktSverka.typePayment'),
  }
  const money = (n: number) => formatPrice(n)
  const balanceCls = (n: number) => (n > 0.5 ? 'text-emerald-600 dark:text-emerald-400' : n < -0.5 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')

  function exportCsv() {
    if (!customer) return
    downloadCsv(`akt_sverka_${customer.name.replace(/\s+/g, '_')}`,
      [t('aktSverka.no'), t('aktSverka.number'), t('aktSverka.dateTime'), t('aktSverka.type'), t('aktSverka.debit'), t('aktSverka.credit'), t('aktSverka.runningBalance'), t('aktSverka.description'), t('aktSverka.author')],
      rows.map((r, i) => [
        i + 1, r.number, `${dayOf(r.at)} ${timeOf(r.at)}`, typeLabel[r.type], r.debit || '', r.credit || '', Math.round(r.balance),
        r.cancelled ? `${t('prodInventory.akt.cancelledRow')} · ${r.description}` : r.description, r.author,
      ]))
  }

  if (available === false) {
    return (
      <div className="space-y-5">
        <Link href={`/zavod-mijozlar/${id}`} className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4" /> {t('prodSales.customers.title')}
        </Link>
        <NotAvailableNote />
      </div>
    )
  }
  if (loading || refsLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!customer) {
    return (
      <Link href="/zavod-mijozlar" className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
        <ArrowLeft className="h-4 w-4" /> {t('productionErrors.not_found')}
      </Link>
    )
  }

  const summaryRow = (label: string, value: number, strong = false, colored = false) => (
    <div className={cn('flex items-center justify-between border-b border-gray-100 dark:border-gray-800 py-2.5 last:border-0', strong ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400')}>
      <span>{label}</span>
      <span className={cn('tabular-nums', colored ? balanceCls(value) : strong ? '' : 'text-gray-900 dark:text-gray-100')}>{money(value)}</span>
    </div>
  )

  return (
    <div className="space-y-5 print:space-y-3">
      <style>{'@media print { aside, header, .no-print { display: none !important; } main { padding: 0 !important; } }'}</style>

      <Link href={`/zavod-mijozlar/${customer.id}`} className="no-print inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
        <ArrowLeft className="h-4 w-4" /> {customer.name}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.title')}: {customer.legal_name || customer.name}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {range ? `${t('aktSverka.periodLabel')}: ${formatDate(range.from)} — ${formatDate(range.to)}` : t('aktSverka.allTime')}
            {customer.inn && ` · ${t('prodSales.common.inn')} ${customer.inn}`}
            {customer.phone && ` · ${customer.phone}`}
          </p>
        </div>
        <div className="no-print flex items-center gap-2">
          <button onClick={() => window.print()} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <Printer className="h-4 w-4" /> {t('aktSverka.print')}
          </button>
          <button onClick={exportCsv} className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-medium text-white transition-colors">
            {t('reportsKit.export')}
          </button>
        </div>
      </div>

      <div className="no-print rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={setRange} />
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{t('prodSales.akt.balanceHint')}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 text-sm">
          <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.allTime')}</p>
          {summaryRow(t('prodSales.akt.shipped'), all.debit)}
          {summaryRow(t('prodSales.akt.returnsAndPayments'), all.credit)}
          {summaryRow(t('aktSverka.finalBalance'), all.final, true, true)}
        </div>
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 text-sm">
          <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.period')}</p>
          {summaryRow(t('aktSverka.periodStart'), period.start, true, true)}
          {summaryRow(t('prodSales.akt.shipped'), period.debit)}
          {summaryRow(t('prodSales.akt.returnsAndPayments'), period.credit)}
          {summaryRow(t('aktSverka.periodEnd'), period.end, true, true)}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.transactions')}</p>
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          {rows.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('aktSverka.empty')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="px-4 py-3 text-left font-medium">{t('aktSverka.no')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('aktSverka.number')}</th>
                    <th className="px-4 py-3 text-left font-medium whitespace-nowrap"><span className="inline-flex items-center gap-1">{t('aktSverka.dateTime')} <ArrowDown className="h-3 w-3" /></span></th>
                    <th className="px-4 py-3 text-left font-medium">{t('aktSverka.type')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('aktSverka.debit')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('aktSverka.credit')}</th>
                    <th className="px-4 py-3 text-right font-medium whitespace-nowrap">{t('aktSverka.runningBalance')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('aktSverka.description')}</th>
                    <th className="px-4 py-3 text-left font-medium">{t('aktSverka.author')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.key}
                      onClick={() => setSelected(r)}
                      title={r.cancelled ? t('prodInventory.akt.cancelledRow') : undefined}
                      className={cn('cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors', r.cancelled && 'line-through opacity-50')}
                    >
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{i + 1}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">#{r.number}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-900 dark:text-gray-100">{formatDate(dayOf(r.at))} {timeOf(r.at)}</td>
                      <td className="px-4 py-2.5 text-gray-900 dark:text-gray-100">{typeLabel[r.type]}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{r.debit ? money(r.debit) : ''}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{r.credit ? money(r.credit) : ''}</td>
                      <td className={cn('px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-semibold', balanceCls(r.balance))}>{r.cancelled ? '' : money(r.balance)}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{r.description}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-600 dark:text-gray-400">{r.author}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    <td className="px-4 py-3" colSpan={4}>{t('reportsKit.total')}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{money(period.debit)}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{money(period.credit)}</td>
                    <td className={cn('px-4 py-3 text-right tabular-nums whitespace-nowrap', balanceCls(period.end))}>{money(period.end)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selected ? `${typeLabel[selected.type]} #${selected.number}` : ''}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('aktSverka.dateTime')}</p>
                  <p className="mt-0.5 font-medium text-gray-900 dark:text-gray-100">{formatDate(dayOf(selected.at))} {timeOf(selected.at)}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{selected.debit ? t('aktSverka.debit') : t('aktSverka.credit')}</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">{money(selected.debit || selected.credit)}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('aktSverka.runningBalance')}</p>
                  <p className={cn('mt-0.5 font-semibold tabular-nums', balanceCls(selected.balance))}>{money(selected.balance)}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('aktSverka.author')}</p>
                  <p className="mt-0.5 font-medium text-gray-900 dark:text-gray-100">{selected.author}</p>
                </div>
              </div>

              {selected.info.length > 0 && (
                <div className="rounded-lg border border-gray-100 dark:border-gray-800">
                  {selected.info.map(f => (
                    <div key={f.label} className="flex items-start justify-between gap-4 border-b border-gray-100 dark:border-gray-800 px-3 py-2 last:border-0">
                      <span className="text-gray-500 dark:text-gray-400">{f.label}</span>
                      <span className="text-right text-gray-900 dark:text-gray-100">{f.value}</span>
                    </div>
                  ))}
                </div>
              )}

              {selected.items.length > 0 && (
                <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-800">
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 bg-white dark:bg-gray-900">
                      <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                        <th className="px-3 py-2 text-left font-medium">{t('aktSverka.no')}</th>
                        <th className="px-3 py-2 text-left font-medium">{t('suppliersPage.product')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('suppliersPage.qty')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('suppliersPage.price')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('suppliersPage.sum')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map((it, j) => (
                        <tr key={j} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                          <td className="px-3 py-2 text-gray-400 dark:text-gray-500">{j + 1}</td>
                          <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{it.name}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatQty(it.qty)} {it.unit}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(it.price)}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{money(it.sum)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div className="hidden print:grid grid-cols-2 gap-10 pt-8 text-sm text-gray-900">
        <div>
          <p className="font-semibold">{t('aktSverka.ourSide')}</p>
          <p className="mt-10 border-t border-gray-400 pt-1 text-xs text-gray-500">{t('aktSverka.signature')}</p>
        </div>
        <div>
          <p className="font-semibold">{t('prodSales.akt.customerSide')}: {customer.legal_name || customer.name}</p>
          <p className="mt-10 border-t border-gray-400 pt-1 text-xs text-gray-500">{t('aktSverka.signature')}</p>
        </div>
      </div>
    </div>
  )
}
