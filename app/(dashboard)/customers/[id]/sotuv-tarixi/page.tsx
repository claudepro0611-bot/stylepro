'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { formatDate } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'

const SALES_PAYMENT_FILTERS = ['Barchasi', 'Naqd', 'Karta', 'Click', 'Payme', 'Nasiya'] as const

const PILL_CLS = (active: boolean) =>
  cn(
    'px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors',
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
  )

const DATE_INPUT_CLS = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

interface CustomerHeader {
  id: string
  fullName: string
  vipSince: string | null
}

interface SalesHistoryRow {
  id: string
  date: string
  itemCount: number
  listPriceTotal: number
  discount: number
  totalAmount: number
  paid: number
  balls: number
  paymentMethod: string
  isNasiya: boolean
}

export default function SotuvTarixiPage() {
  const { id: customerId } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [loading, setLoading] = useState(true)
  const [customer, setCustomer] = useState<CustomerHeader | null>(null)
  const [salesHistory, setSalesHistory] = useState<SalesHistoryRow[]>([])
  const [salesDateFrom, setSalesDateFrom] = useState('')
  const [salesDateTo, setSalesDateTo] = useState('')
  const [salesPaymentFilter, setSalesPaymentFilter] = useState<typeof SALES_PAYMENT_FILTERS[number]>('Barchasi')

  // ─── Sales-since-VIP history — moved as-is from customers/page.tsx's Karta
  // tab (loadSalesHistory). Sourced from `transactions_net` (not raw
  // `transactions`), matching the "xaridlar" tab's precedent — it already
  // accounts for returns via net_amount. "Asl narx"/"Chegirma" use
  // transaction_items.list_price and the transaction's own total_amount
  // (pre-return, authoritative from sell_cart) so the discount shown
  // reflects the sale-time discount only; "To'langan" uses net_amount
  // (post-return) for consistency with the purchases tab.
  const loadSalesHistory = useCallback(async (c: CustomerHeader) => {
    if (!c.vipSince) {
      setSalesHistory([])
      return
    }
    const supabase = createClient()

    const [{ data: txnRows, error: txnError }, { data: earnRows }, { data: nasiyaGivenRows }] = await Promise.all([
      supabase
        .from('transactions_net')
        .select('id, date, total_amount, net_amount, payment_method, transaction_items(quantity, list_price)')
        .eq('customer_id', c.id)
        .eq('status', 'completed')
        .gte('date', c.vipSince)
        .order('date', { ascending: false }),
      supabase
        .from('loyalty_transactions')
        .select('transaction_id, amount')
        .eq('customer_id', c.id)
        .eq('type', 'earn')
        .not('transaction_id', 'is', null),
      supabase
        .from('nasiya_transactions')
        .select('related_transaction_id')
        .eq('customer_id', c.id)
        .eq('type', 'given')
        .not('related_transaction_id', 'is', null),
    ])

    if (txnError) {
      toast.error(t('common.error'))
      setSalesHistory([])
      return
    }

    const ballsByTxn = new Map<string, number>()
    for (const row of (earnRows ?? []) as { transaction_id: string | null; amount: number }[]) {
      if (!row.transaction_id) continue
      ballsByTxn.set(row.transaction_id, (ballsByTxn.get(row.transaction_id) ?? 0) + Number(row.amount))
    }

    // Judgment call: `transactions.payment_method` never contains a "Nasiya"
    // value (POS only ever writes Naqd/Karta/Click/Payme, see pos/page.tsx's
    // PAYMENT_METHODS) — a nasiya sale is still recorded with one of those
    // four methods for whatever was paid up front. Whether a sale is "on
    // credit" is instead detected via nasiya_transactions.related_transaction_id
    // (set by give_nasiya when tied to a specific sale).
    const nasiyaTxnIds = new Set(
      ((nasiyaGivenRows ?? []) as { related_transaction_id: string | null }[])
        .map(r => r.related_transaction_id)
        .filter((id): id is string => !!id),
    )

    const rows: SalesHistoryRow[] = (txnRows ?? []).map(row => {
      const items = (row.transaction_items ?? []) as { quantity: number; list_price: number }[]
      const itemCount = items.reduce((s, i) => s + Number(i.quantity), 0)
      const listPriceTotal = items.reduce((s, i) => s + Number(i.list_price) * Number(i.quantity), 0)
      const totalAmount = Number(row.total_amount)
      const id = row.id ?? ''
      return {
        id,
        date: row.date ?? '',
        itemCount,
        listPriceTotal,
        discount: Math.max(0, listPriceTotal - totalAmount),
        totalAmount,
        paid: Number(row.net_amount),
        balls: ballsByTxn.get(id) ?? 0,
        paymentMethod: row.payment_method ?? '',
        isNasiya: nasiyaTxnIds.has(id),
      }
    })

    setSalesHistory(rows)
  }, [t])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const supabase = createClient()
      const { data, error } = await supabase
        .from('customers')
        .select('id, full_name, vip_since')
        .eq('id', customerId)
        .single()

      if (cancelled) return

      if (error || !data) {
        setCustomer(null)
        setLoading(false)
        return
      }

      const c: CustomerHeader = {
        id: data.id,
        fullName: data.full_name,
        vipSince: data.vip_since ?? null,
      }
      setCustomer(c)
      await loadSalesHistory(c)
      if (!cancelled) setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [customerId, loadSalesHistory])

  const filteredSalesHistory = useMemo(() => {
    let list = salesHistory
    if (salesDateFrom) list = list.filter(r => r.date >= salesDateFrom)
    if (salesDateTo) list = list.filter(r => r.date <= salesDateTo)
    if (salesPaymentFilter !== 'Barchasi') {
      list = salesPaymentFilter === 'Nasiya'
        ? list.filter(r => r.isNasiya)
        : list.filter(r => r.paymentMethod === salesPaymentFilter && !r.isNasiya)
    }
    return list
  }, [salesHistory, salesDateFrom, salesDateTo, salesPaymentFilter])

  const salesTotals = useMemo(() => filteredSalesHistory.reduce((acc, r) => ({
    itemCount: acc.itemCount + r.itemCount,
    listPriceTotal: acc.listPriceTotal + r.listPriceTotal,
    discount: acc.discount + r.discount,
    paid: acc.paid + r.paid,
    balls: acc.balls + r.balls,
  }), { itemCount: 0, listPriceTotal: 0, discount: 0, paid: 0, balls: 0 }), [filteredSalesHistory])

  return (
    <div className="space-y-6">
      <Link
        href="/customers"
        className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors w-fit"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('customers.karta.backToCustomer')}
      </Link>

      {loading ? (
        <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-12">
          <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
          {t('common.loading')}
        </p>
      ) : !customer ? (
        <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-12">
          {t('customers.karta.customerNotFound')}
        </p>
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{customer.fullName}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('customers.karta.salesHistory')}</p>
          </div>

          {!customer.vipSince ? (
            <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('customers.karta.notVipYet')}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" value={salesDateFrom} onChange={e => setSalesDateFrom(e.target.value)} className={DATE_INPUT_CLS} />
                <span className="text-[12px] text-gray-400">—</span>
                <input type="date" value={salesDateTo} onChange={e => setSalesDateTo(e.target.value)} className={DATE_INPUT_CLS} />
                <div className="flex flex-wrap gap-1.5 sm:ml-auto">
                  {SALES_PAYMENT_FILTERS.map(f => (
                    <button key={f} onClick={() => setSalesPaymentFilter(f)} className={PILL_CLS(salesPaymentFilter === f)}>
                      {f === 'Barchasi' ? t('customers.karta.paymentFilterAll') : f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-table-header-bg dark:bg-gray-800/50">
                      <tr className="border-b border-gray-100 dark:border-gray-800">
                        <th className="px-3 py-2.5 text-left text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.date')}</th>
                        <th className="px-3 py-2.5 text-center text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.productsCount')}</th>
                        <th className="px-3 py-2.5 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.listPrice')}</th>
                        <th className="px-3 py-2.5 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.discount')}</th>
                        <th className="px-3 py-2.5 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.paid')}</th>
                        <th className="px-3 py-2.5 text-right text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.ball')}</th>
                        <th className="px-3 py-2.5 text-left text-sm font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('customers.karta.paymentType')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSalesHistory.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                            {t('customers.karta.noSalesHistory')}
                          </td>
                        </tr>
                      ) : filteredSalesHistory.map(r => (
                        <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                          <td className="px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(r.date)}</td>
                          <td className="px-3 py-2.5 text-sm text-center text-gray-700 dark:text-gray-300">{r.itemCount}</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-400 dark:text-gray-500 line-through whitespace-nowrap">
                            {formatPrice(r.listPriceTotal)}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-red-600 dark:text-red-400 whitespace-nowrap">
                            {r.discount > 0 ? `-${formatPrice(r.discount)}` : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">
                            {formatPrice(r.paid)}
                          </td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-700 dark:text-gray-300">
                            {r.balls > 0 ? `+${r.balls}` : '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            {r.isNasiya ? (
                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400">
                                {t('customers.karta.nasiyaType')}
                              </span>
                            ) : (
                              <span className="text-sm text-gray-500 dark:text-gray-400">{r.paymentMethod}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {filteredSalesHistory.length > 0 && (
                      <tfoot>
                        <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold">
                          <td className="px-3 py-2.5 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{t('customers.karta.totalRow')}</td>
                          <td className="px-3 py-2.5 text-sm text-center text-gray-900 dark:text-gray-100">{salesTotals.itemCount}</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatPrice(salesTotals.listPriceTotal)}</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-red-600 dark:text-red-400 whitespace-nowrap">{formatPrice(salesTotals.discount)}</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-900 dark:text-gray-100 whitespace-nowrap">{formatPrice(salesTotals.paid)}</td>
                          <td className="px-3 py-2.5 text-sm text-right tabular-nums text-gray-900 dark:text-gray-100">{salesTotals.balls}</td>
                          <td className="px-3 py-2.5" />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
