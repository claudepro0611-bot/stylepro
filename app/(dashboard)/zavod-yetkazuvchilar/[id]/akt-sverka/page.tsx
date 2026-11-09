'use client'

// Akt sverka (reconciliation statement) with one PRODUCTION supplier.
// Mirrors the retail statement (app/(dashboard)/yetkazuvchilar/[id]/akt-sverka):
//   Kredit = receipt (our debt grows), Debet = payment (debt shrinks).
//   Balance = what we owe = receipts − payments (posted documents only).
//   Displayed from OUR side (pos = −balance): + green = advance (supplier owes
//   us), − red = we owe the supplier.

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
import { formatQty, unitKey } from '@/lib/production'

type TxType = 'receipt' | 'payment'

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
}

interface SupplierRow { id: string; name: string; phone: string | null; address: string | null }
interface ReceiptItemRow { item_id: string; qty: number; price: number; total: number }
interface ReceiptRow {
  id: string; number: number; doc_date: string; warehouse_id: string; total: number
  note: string | null; created_by_name: string | null; prod_receipt_items: ReceiptItemRow[]
}
interface PaymentRow { id: string; number: number; pay_date: string; amount: number; method: string; note: string | null; created_by_name: string | null; created_at: string }

const timeOf = (iso: string) => (iso.length > 10 ? iso.slice(11, 16) : '')
const dayOf = (iso: string) => iso.slice(0, 10)
const pos = (debt: number) => (debt === 0 ? 0 : -debt)
const sumBy = (list: Tx[], type: TxType) => list.filter(x => x.type === type).reduce((s, x) => s + x.credit + x.debit, 0)

/** Local "YYYY-MM-DDTHH:mm:ss" of a timestamptz, so day filters match the user's calendar. */
function localIso(ts: string) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function ProdAktSverkaPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, warehouseById, loading: refsLoading } = useProdRefs()

  const [supplier, setSupplier] = useState<SupplierRow | null>(null)
  const [receipts, setReceipts] = useState<ReceiptRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [selected, setSelected] = useState<(Tx & { balance: number }) | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const [supRes, recRes, payRes] = await Promise.all([
        supabase.from('prod_suppliers').select('id, name, phone, address').eq('id', id).maybeSingle(),
        fetchAllRows<Omit<ReceiptRow, 'prod_receipt_items'>>((from, to) => supabase.from('prod_receipts')
          .select('id, number, doc_date, warehouse_id, total, note, created_by_name')
          .eq('supplier_id', id).eq('status', 'posted').order('id').range(from, to)),
        fetchAllRows<PaymentRow>((from, to) => supabase.from('prod_supplier_payments')
          .select('id, number, pay_date, amount, method, note, created_by_name, created_at')
          .eq('supplier_id', id).eq('status', 'posted').order('id').range(from, to)),
      ])
      if (cancelled) return
      // Lines of those receipts, in chunks (URL length limit on .in()).
      const ids = recRes.data.map(r => r.id)
      const lines: (ReceiptItemRow & { receipt_id: string })[] = []
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase.from('prod_receipt_items')
          .select('receipt_id, item_id, qty, price, total').in('receipt_id', ids.slice(i, i + 200))
        lines.push(...((data ?? []) as (ReceiptItemRow & { receipt_id: string })[]))
      }
      if (cancelled) return
      const byReceipt = new Map<string, ReceiptItemRow[]>()
      for (const l of lines) {
        const arr = byReceipt.get(l.receipt_id)
        if (arr) arr.push(l)
        else byReceipt.set(l.receipt_id, [l])
      }
      setSupplier((supRes.data as SupplierRow | null) ?? null)
      setReceipts(recRes.data.map(r => ({ ...r, prod_receipt_items: byReceipt.get(r.id) ?? [] })))
      setPayments(payRes.data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id])

  const methodLabel: Record<string, string> = useMemo(
    () => ({ cash: t('suppliersPage.cash'), card: t('suppliersPage.card'), transfer: t('suppliersPage.transfer') }), [t])

  const txs = useMemo<Tx[]>(() => {
    const list: Tx[] = []
    for (const r of receipts) {
      const lines = r.prod_receipt_items ?? []
      const names = Array.from(new Set(lines.map(l => itemById.get(l.item_id)?.name ?? '—')))
      list.push({
        key: `r:${r.id}`,
        type: 'receipt',
        number: String(r.number),
        at: localIso(r.doc_date),
        debit: 0,
        credit: Number(r.total),
        description: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} · ${lines.length} ${t('aktSverka.positions')}${r.note ? ` · ${r.note}` : ''}`,
        author: r.created_by_name ?? '—',
        items: lines.map(l => {
          const item = itemById.get(l.item_id)
          return { name: item?.name ?? '—', unit: item ? t(unitKey(item.unit)) : '', qty: Number(l.qty), price: Number(l.price), sum: Number(l.total) }
        }),
        info: [
          { label: t('suppliersPage.warehouse'), value: warehouseById.get(r.warehouse_id)?.name ?? '—' },
          ...(r.note ? [{ label: t('suppliersPage.note'), value: r.note }] : []),
        ],
      })
    }
    for (const p of payments) {
      list.push({
        key: `p:${p.id}`,
        type: 'payment',
        number: String(p.number),
        at: `${p.pay_date}T${localIso(p.created_at).slice(11, 19)}`,
        debit: Number(p.amount),
        credit: 0,
        description: [methodLabel[p.method] ?? p.method, p.note].filter(Boolean).join(' · '),
        author: p.created_by_name ?? '—',
        items: [],
        info: [
          { label: t('suppliersPage.amount'), value: formatPrice(Number(p.amount)) },
          { label: t('suppliersPage.method'), value: methodLabel[p.method] ?? p.method },
          { label: t('aktSverka.author'), value: p.created_by_name ?? '—' },
          ...(p.note ? [{ label: t('suppliersPage.note'), value: p.note }] : []),
        ],
      })
    }
    return list
  }, [receipts, payments, itemById, warehouseById, methodLabel, t, formatPrice])

  const withBalance = useMemo(() => {
    const sorted = [...txs].sort((a, b) => a.at.localeCompare(b.at))
    const out: (Tx & { balance: number })[] = []
    for (const tx of sorted) {
      const prev = out.length ? out[out.length - 1].balance : 0
      out.push({ ...tx, balance: prev + tx.credit - tx.debit })
    }
    return out
  }, [txs])

  const all = useMemo(() => {
    const purchases = sumBy(txs, 'receipt'), paid = sumBy(txs, 'payment')
    return { purchases, paid, final: purchases - paid }
  }, [txs])

  const inPeriod = useMemo(
    () => withBalance.filter(x => !range || (dayOf(x.at) >= range.from && dayOf(x.at) <= range.to)),
    [withBalance, range],
  )
  const period = useMemo(() => {
    const before = range ? withBalance.filter(x => dayOf(x.at) < range.from) : []
    const start = before.length ? before[before.length - 1].balance : 0
    const purchases = sumBy(inPeriod, 'receipt'), paid = sumBy(inPeriod, 'payment')
    return { start, purchases, paid, end: start + purchases - paid }
  }, [withBalance, inPeriod, range])

  const rows = useMemo(() => [...inPeriod].reverse(), [inPeriod])

  const typeLabel: Record<TxType, string> = { receipt: t('aktSverka.typePurchase'), payment: t('aktSverka.typePayment') }
  const money = (n: number) => formatPrice(n)
  const balanceCls = (n: number) => (n < -0.5 ? 'text-red-600 dark:text-red-400' : n > 0.5 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-gray-100')

  function exportCsv() {
    if (!supplier) return
    downloadCsv(`akt_sverka_${supplier.name.replace(/\s+/g, '_')}`,
      [t('aktSverka.no'), t('aktSverka.number'), t('aktSverka.dateTime'), t('aktSverka.type'), t('aktSverka.debit'), t('aktSverka.credit'), t('aktSverka.runningBalance'), t('aktSverka.description'), t('aktSverka.author')],
      rows.map((r, i) => [i + 1, r.number, `${dayOf(r.at)} ${timeOf(r.at)}`, typeLabel[r.type], r.debit || '', r.credit || '', Math.round(pos(r.balance)), r.description, r.author]))
  }

  if (loading || refsLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  if (!supplier) {
    return (
      <Link href="/zavod-yetkazuvchilar" className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
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

      <Link href={`/zavod-yetkazuvchilar/${supplier.id}`} className="no-print inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
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
          {summaryRow(t('aktSverka.purchases'), pos(all.purchases))}
          {summaryRow(t('aktSverka.payments'), all.paid)}
          {summaryRow(t('aktSverka.finalBalance'), pos(all.final), true, true)}
        </div>
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 text-sm">
          <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t('aktSverka.period')}</p>
          {summaryRow(t('aktSverka.periodStart'), pos(period.start), true, true)}
          {summaryRow(t('aktSverka.purchases'), pos(period.purchases))}
          {summaryRow(t('aktSverka.payments'), period.paid)}
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
                    <tr key={r.key} onClick={() => setSelected(r)} className="cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
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
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{money(period.paid)}</td>
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
                    <tfoot>
                      <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
                        <td className="px-3 py-2" colSpan={4}>{t('reportsKit.total')}</td>
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
