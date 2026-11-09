'use client'

// Akt sverka (reconciliation statement) with one supplier.
//
// Supplier-side convention (mirror of a customer statement):
//   Kredit = purchase (our debt grows), Debet = payment / return (debt shrinks).
//   Balance = what we owe: opening + purchases − returns − payments.
//   Displayed from OUR side (pos = −balance): + green = in our favour
//   (prepaid, the supplier owes us), − red = we owe the supplier.

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
import { entryAmount, mapSupplier, type Supplier } from '@/lib/suppliers'

type TxType = 'purchase' | 'payment' | 'return'

interface Tx {
  key: string
  type: TxType
  number: string
  at: string          // sortable ISO-ish timestamp
  debit: number       // payment / return
  credit: number      // purchase
  description: string
  author: string
  /** Lines shown in the details dialog (purchase / return). */
  items: { name: string; variant: string; qty: number; price: number; sum: number }[]
  /** Extra label/value facts shown in the details dialog. */
  info: { label: string; value: string }[]
}

interface EntryRow { id: string; product_name: string | null; size: string | null; color: string | null; quantity: number; purchase_price: number | null; total_amount: number | null; date: string; created_at: string; note: string | null; product_size_id: string | null }
interface PaymentRow { id: string; amount: number; payment_method: string; date: string; created_at: string; note: string | null; created_by_name: string | null }
interface ReturnRow { id: string; number: number; date: string; created_at: string; note: string | null; created_by_name: string | null; supplier_return_items: { product_name: string; size: string; color: string; quantity: number; price: number }[] }

const timeOf = (iso: string) => (iso.length > 10 ? iso.slice(11, 16) : '')
const dayOf = (iso: string) => iso.slice(0, 10)
/** Our side of a debt amount: + in our favour, − we owe (avoids -0). */
const pos = (debt: number) => (debt === 0 ? 0 : -debt)
const sumBy = (list: Tx[], type: TxType) => list.filter(x => x.type === type).reduce((s, x) => s + x.credit + x.debit, 0)

export default function AktSverkaPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [txs, setTxs] = useState<Tx[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const [supRes, entriesRes, paymentsRes, returnsRes] = await Promise.all([
        supabase.from('suppliers').select('id, name, phone, company_name, inn, address, note, opening_balance, is_active').eq('id', id).maybeSingle(),
        fetchAllRows<EntryRow>((from, to) =>
          supabase.from('stock_in_entries')
            .select('id, product_name, size, color, quantity, purchase_price, total_amount, date, created_at, note, product_size_id')
            .eq('supplier_id', id).eq('entry_type', 'purchase').order('id').range(from, to)),
        supabase.from('supplier_payments').select('id, amount, payment_method, date, created_at, note, created_by_name').eq('supplier_id', id),
        supabase.from('supplier_returns')
          .select('id, number, date, created_at, note, created_by_name, supplier_return_items(product_name, size, color, quantity, price)')
          .eq('supplier_id', id),
      ])
      if (cancelled) return

      const methodLabel: Record<string, string> = { cash: t('suppliersPage.cash'), card: t('suppliersPage.card'), transfer: t('suppliersPage.transfer') }
      const list: Tx[] = []
      const variantOf = (color: string | null, size: string | null) => [color, size].filter(Boolean).join(' / ')

      // Warehouse of each received variant row (stock_in_entries has none).
      const sizeIds = Array.from(new Set(entriesRes.data.map(e => e.product_size_id).filter((x): x is string => !!x)))
      const whOfSize = new Map<string, string>()
      if (sizeIds.length) {
        const [sizesRes, whRes] = await Promise.all([
          supabase.from('product_sizes').select('id, warehouse_id').in('id', sizeIds),
          supabase.from('warehouses').select('id, name'),
        ])
        const whName = new Map(((whRes.data ?? []) as { id: string; name: string }[]).map(w => [w.id, w.name]))
        for (const s of (sizesRes.data ?? []) as { id: string; warehouse_id: string }[]) whOfSize.set(s.id, whName.get(s.warehouse_id) ?? '—')
      }
      if (cancelled) return

      // One kirim save = several stock_in_entries rows sharing the same
      // timestamp → show it as one purchase document.
      const docs = new Map<string, EntryRow[]>()
      for (const e of entriesRes.data) {
        const k = `${e.date}|${e.created_at.slice(0, 19)}`
        const arr = docs.get(k)
        if (arr) arr.push(e)
        else docs.set(k, [e])
      }
      for (const [k, rows] of docs) {
        const names = Array.from(new Set(rows.map(r => r.product_name ?? '—')))
        const qty = rows.reduce((s, r) => s + Number(r.quantity), 0)
        const at = rows[0].date.length > 10 ? rows[0].date : `${rows[0].date}T${rows[0].created_at.slice(11, 19)}`
        list.push({
          key: `p:${k}`,
          type: 'purchase',
          number: rows[0].id.slice(0, 6).toUpperCase(),
          at,
          debit: 0,
          credit: rows.reduce((s, r) => s + entryAmount(r), 0),
          description: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} · ${rows.length} ${t('aktSverka.positions')}, ${qty} ${t('kirim.unitsSuffix')}${rows[0].note ? ` · ${rows[0].note}` : ''}`,
          author: '—',
          items: rows.map(r => ({
            name: r.product_name ?? '—',
            variant: variantOf(r.color, r.size),
            qty: Number(r.quantity),
            price: Number(r.purchase_price ?? 0),
            sum: entryAmount(r),
          })),
          info: [
            { label: t('suppliersPage.warehouse'), value: Array.from(new Set(rows.map(r => (r.product_size_id && whOfSize.get(r.product_size_id)) || '—'))).join(', ') },
            ...(rows[0].note ? [{ label: t('suppliersPage.note'), value: rows[0].note }] : []),
          ],
        })
      }
      for (const p of (paymentsRes.data ?? []) as PaymentRow[]) {
        list.push({
          key: `pay:${p.id}`,
          type: 'payment',
          number: p.id.slice(0, 6).toUpperCase(),
          at: `${p.date}T${p.created_at.slice(11, 19)}`,
          debit: Number(p.amount),
          credit: 0,
          description: [methodLabel[p.payment_method] ?? p.payment_method, p.note].filter(Boolean).join(' · '),
          author: p.created_by_name ?? '—',
          items: [],
          info: [
            { label: t('suppliersPage.amount'), value: formatPrice(Number(p.amount)) },
            { label: t('suppliersPage.method'), value: methodLabel[p.payment_method] ?? p.payment_method },
            { label: t('suppliersPage.date'), value: `${formatDate(p.date)} · ${t('aktSverka.enteredAt')} ${formatDate(p.created_at.slice(0, 10))} ${p.created_at.slice(11, 16)}` },
            { label: t('aktSverka.author'), value: p.created_by_name ?? '—' },
            ...(p.note ? [{ label: t('suppliersPage.note'), value: p.note }] : []),
          ],
        })
      }
      for (const r of (returnsRes.data ?? []) as unknown as ReturnRow[]) {
        const names = Array.from(new Set(r.supplier_return_items.map(i => i.product_name)))
        list.push({
          key: `ret:${r.id}`,
          type: 'return',
          number: String(r.number),
          at: `${r.date}T${r.created_at.slice(11, 19)}`,
          debit: r.supplier_return_items.reduce((s, i) => s + Number(i.quantity) * Number(i.price), 0),
          credit: 0,
          description: [`${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`, r.note].filter(Boolean).join(' · '),
          author: r.created_by_name ?? '—',
          items: r.supplier_return_items.map(i => ({
            name: i.product_name,
            variant: variantOf(i.color, i.size),
            qty: Number(i.quantity),
            price: Number(i.price),
            sum: Number(i.quantity) * Number(i.price),
          })),
          info: r.note ? [{ label: t('suppliersPage.note'), value: r.note }] : [],
        })
      }

      setSupplier(supRes.data ? mapSupplier(supRes.data) : null)
      setTxs(list)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, t, formatPrice])

  const opening = supplier?.openingBalance ?? 0

  // Ascending pass for running balances, then filter/sort for display.
  const withBalance = useMemo(() => {
    const sorted = [...txs].sort((a, b) => a.at.localeCompare(b.at))
    const out: (Tx & { balance: number })[] = []
    for (const tx of sorted) {
      const prev = out.length ? out[out.length - 1].balance : opening
      out.push({ ...tx, balance: prev + tx.credit - tx.debit })
    }
    return out
  }, [txs, opening])

  const all = useMemo(() => {
    const purchases = sumBy(txs, 'purchase'), returns = sumBy(txs, 'return'), payments = sumBy(txs, 'payment')
    return { purchases, returns, payments, final: opening + purchases - returns - payments }
  }, [txs, opening])

  const inPeriod = useMemo(
    () => withBalance.filter(x => !range || (dayOf(x.at) >= range.from && dayOf(x.at) <= range.to)),
    [withBalance, range],
  )
  const period = useMemo(() => {
    const before = range ? withBalance.filter(x => dayOf(x.at) < range.from) : []
    const start = before.length ? before[before.length - 1].balance : opening
    const purchases = sumBy(inPeriod, 'purchase'), returns = sumBy(inPeriod, 'return'), payments = sumBy(inPeriod, 'payment')
    return { start, purchases, returns, payments, end: start + purchases - returns - payments }
  }, [withBalance, inPeriod, range, opening])

  const rows = useMemo(() => [...inPeriod].reverse(), [inPeriod])

  // Row clicked in the transactions table → details open in a dialog.
  const [selected, setSelected] = useState<(Tx & { balance: number }) | null>(null)

  const typeLabel: Record<TxType, string> = {
    purchase: t('aktSverka.typePurchase'), payment: t('aktSverka.typePayment'), return: t('aktSverka.typeReturn'),
  }
  const money = (n: number) => formatPrice(n)
  // n is our position (pos()): + = in our favour, − = we owe.
  const balanceCls = (n: number) => (n < -0.5 ? 'text-red-600 dark:text-red-400' : n > 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-gray-100')

  function exportCsv() {
    if (!supplier) return
    downloadCsv(`akt_sverka_${supplier.name.replace(/\s+/g, '_')}`,
      [t('aktSverka.no'), t('aktSverka.number'), t('aktSverka.dateTime'), t('aktSverka.type'), t('aktSverka.debit'), t('aktSverka.credit'), t('aktSverka.runningBalance'), t('aktSverka.description'), t('aktSverka.author')],
      rows.map((r, i) => [i + 1, r.number, `${dayOf(r.at)} ${timeOf(r.at)}`, typeLabel[r.type], r.debit || '', r.credit || '', Math.round(pos(r.balance)), r.description, r.author]))
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!supplier) {
    return (
      <Link href="/yetkazuvchilar" className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
        <ArrowLeft className="h-4 w-4" /> {t('suppliersPage.notFound')}
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

      <Link href={`/yetkazuvchilar/${supplier.id}`} className="no-print inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
        <ArrowLeft className="h-4 w-4" /> {supplier.name}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.title')}: {supplier.name}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {range ? `${t('aktSverka.periodLabel')}: ${formatDate(range.from)} — ${formatDate(range.to)}` : t('aktSverka.allTime')}
            {supplier.phone && ` · ${supplier.phone}`}
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
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{t('aktSverka.balanceHint')}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 text-sm">
          <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.allTime')}</p>
          {opening !== 0 && summaryRow(t('aktSverka.opening'), pos(opening))}
          {summaryRow(t('aktSverka.purchases'), pos(all.purchases))}
          {summaryRow(t('aktSverka.returns'), all.returns)}
          {summaryRow(t('aktSverka.payments'), all.payments)}
          {summaryRow(t('aktSverka.finalBalance'), pos(all.final), true, true)}
        </div>
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 text-sm">
          <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.period')}</p>
          {summaryRow(t('aktSverka.periodStart'), pos(period.start), true, true)}
          {summaryRow(t('aktSverka.purchases'), pos(period.purchases))}
          {summaryRow(t('aktSverka.returns'), period.returns)}
          {summaryRow(t('aktSverka.payments'), period.payments)}
          {summaryRow(t('aktSverka.periodEnd'), pos(period.end), true, true)}
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
                      className="cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                    >
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">{i + 1}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">#{r.number}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-900 dark:text-gray-100">{formatDate(dayOf(r.at))} {timeOf(r.at)}</td>
                      <td className="px-4 py-2.5 text-gray-900 dark:text-gray-100">{typeLabel[r.type]}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{r.debit ? money(r.debit) : ''}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{r.credit ? money(r.credit) : ''}</td>
                      <td className={cn('px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-semibold', balanceCls(pos(r.balance)))}>{money(pos(r.balance))}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-400">{r.description}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-gray-600 dark:text-gray-400">{r.author}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                    <td className="px-4 py-3" colSpan={4}>{t('reportsKit.total')}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{money(period.returns + period.payments)}</td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{money(period.purchases)}</td>
                    <td className={cn('px-4 py-3 text-right tabular-nums whitespace-nowrap', balanceCls(pos(period.end)))}>{money(pos(period.end))}</td>
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
                  <p className="text-xs text-gray-400 dark:text-gray-500">{selected.credit ? t('aktSverka.credit') : t('aktSverka.debit')}</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">{money(selected.credit || selected.debit)}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                  <p className="text-xs text-gray-400 dark:text-gray-500">{t('aktSverka.runningBalance')}</p>
                  <p className={cn('mt-0.5 font-semibold tabular-nums', balanceCls(pos(selected.balance)))}>{money(pos(selected.balance))}</p>
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
                        <th className="px-3 py-2 text-left font-medium">{t('kirimReport.variant')}</th>
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
                          <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{it.variant || '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.qty}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(it.price)}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{money(it.sum)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                        <td className="px-3 py-2" colSpan={3}>{t('reportsKit.total')}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{selected.items.reduce((s, it) => s + it.qty, 0)}</td>
                        <td />
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(selected.items.reduce((s, it) => s + it.sum, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Signature block — shown on print only */}
      <div className="hidden print:grid grid-cols-2 gap-10 pt-8 text-sm text-gray-900">
        <div>
          <p className="font-semibold">{t('aktSverka.ourSide')}</p>
          <p className="mt-10 border-t border-gray-400 pt-1 text-xs text-gray-500">{t('aktSverka.signature')}</p>
        </div>
        <div>
          <p className="font-semibold">{t('aktSverka.supplierSide')}: {supplier.name}</p>
          <p className="mt-10 border-t border-gray-400 pt-1 text-xs text-gray-500">{t('aktSverka.signature')}</p>
        </div>
      </div>
    </div>
  )
}
