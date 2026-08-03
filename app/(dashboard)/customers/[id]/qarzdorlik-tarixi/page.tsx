'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { formatDate } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'

const KARTA_KPI_CARD_CLS = 'rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4'

interface CustomerHeader {
  id: string
  fullName: string
}

interface NasiyaTxnRow {
  id: string
  created_at: string
  type: 'given' | 'repaid'
  amount: number
  note: string | null
}

export default function QarzdorlikTarixiPage() {
  const { id: customerId } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [loading, setLoading] = useState(true)
  const [customer, setCustomer] = useState<CustomerHeader | null>(null)
  const [nasiyaBalance, setNasiyaBalance] = useState(0)
  const [nasiyaHistory, setNasiyaHistory] = useState<NasiyaTxnRow[]>([])

  const [giveNasiyaOpen, setGiveNasiyaOpen] = useState(false)
  const [giveAmount, setGiveAmount] = useState('')
  const [giveNote, setGiveNote] = useState('')
  const [giving, setGiving] = useState(false)

  const [repayNasiyaOpen, setRepayNasiyaOpen] = useState(false)
  const [repayAmount, setRepayAmount] = useState('')
  const [repayNote, setRepayNote] = useState('')
  const [repaying, setRepaying] = useState(false)

  const reloadNasiya = useCallback(async (id: string) => {
    const supabase = createClient()
    const [{ data: balanceData }, { data: rows }] = await Promise.all([
      supabase.rpc('get_customer_nasiya_balance', { p_customer_id: id }),
      supabase.from('nasiya_transactions').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
    ])
    setNasiyaBalance(Number(balanceData ?? 0))
    setNasiyaHistory((rows ?? []) as NasiyaTxnRow[])
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const supabase = createClient()
      const { data, error } = await supabase
        .from('customers')
        .select('id, full_name')
        .eq('id', customerId)
        .single()

      if (cancelled) return

      if (error || !data) {
        setCustomer(null)
        setLoading(false)
        return
      }

      setCustomer({ id: data.id, fullName: data.full_name })
      await reloadNasiya(data.id)
      if (!cancelled) setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [customerId, reloadNasiya])

  async function submitGiveNasiya() {
    if (!customer) return
    const amt = Number(giveAmount)
    if (!giveAmount.trim() || Number.isNaN(amt) || amt <= 0) {
      toast.error(t('customers.karta.requiredAmountError'))
      return
    }
    setGiving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('give_nasiya', {
      p_customer_id: customer.id,
      p_amount: amt,
      p_related_transaction_id: null,
      p_note: giveNote.trim() || null,
    })
    setGiving(false)

    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }

    toast.success(t('customers.karta.giveSuccess'))
    setGiveNasiyaOpen(false)
    setGiveAmount('')
    setGiveNote('')
    await reloadNasiya(customer.id)
  }

  async function submitRepayNasiya() {
    if (!customer) return
    const amt = Number(repayAmount)
    if (!repayAmount.trim() || Number.isNaN(amt) || amt <= 0) {
      toast.error(t('customers.karta.requiredAmountError'))
      return
    }
    setRepaying(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('repay_nasiya', {
      p_customer_id: customer.id,
      p_amount: amt,
      p_note: repayNote.trim() || null,
    })
    setRepaying(false)

    if (error) {
      // repay_nasiya hard-rejects an over-repayment with a message containing
      // this exact substring — surfaced as a specific toast rather than the
      // generic error, same pattern as pos/page.tsx's handleSell branches.
      if (error.message.includes('exceeds outstanding nasiya balance')) {
        toast.error(t('customers.karta.repayExceedsError'))
      } else if (error.message.includes('forbidden')) {
        toast.error(t('common.forbidden'))
      } else {
        toast.error(t('common.error'))
      }
      return
    }

    toast.success(t('customers.karta.repaySuccess'))
    setRepayNasiyaOpen(false)
    setRepayAmount('')
    setRepayNote('')
    await reloadNasiya(customer.id)
  }

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
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('customers.karta.nasiyaHistory')}</p>
          </div>

          <div className={cn(KARTA_KPI_CARD_CLS, 'max-w-xs')}>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800 mb-3">
              <Wallet className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t('customers.karta.nasiyaBalance')}</p>
            <p className={cn(
              'text-lg font-semibold tabular-nums whitespace-nowrap',
              nasiyaBalance > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100',
            )}>
              {formatPrice(nasiyaBalance)}
            </p>
          </div>

          <div className="flex items-center justify-end flex-wrap gap-2">
            <div className="flex gap-2">
              <button
                onClick={() => setGiveNasiyaOpen(true)}
                className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-[13px] font-medium transition-colors"
              >
                {t('customers.karta.giveNasiya')}
              </button>
              <button
                onClick={() => setRepayNasiyaOpen(true)}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[13px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                {t('customers.karta.acceptPayment')}
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-table-header-bg dark:bg-gray-800/50">
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                    <th className="px-3 py-2.5 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.date')}</th>
                    <th className="px-3 py-2.5 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.type')}</th>
                    <th className="px-3 py-2.5 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.amount')}</th>
                    <th className="px-3 py-2.5 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.karta.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {nasiyaHistory.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                        {t('customers.karta.noNasiyaHistory')}
                      </td>
                    </tr>
                  ) : nasiyaHistory.map(r => (
                    <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <td className="px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400">{formatDate(r.created_at)}</td>
                      <td className="px-3 py-2.5">
                        <span className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          r.type === 'given'
                            ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                            : 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
                        )}>
                          {r.type === 'given' ? t('customers.karta.given') : t('customers.karta.repaid')}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">
                        {formatPrice(Number(r.amount))}
                      </td>
                      <td className="px-3 py-2.5 text-sm text-gray-700 dark:text-gray-300">{r.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Give Nasiya Modal */}
      <Dialog open={giveNasiyaOpen} onOpenChange={setGiveNasiyaOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customers.karta.giveNasiya')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.amountLabel')}</label>
              <input
                type="number"
                min={0}
                placeholder={t('customers.karta.amountPlaceholder')}
                value={giveAmount}
                onChange={e => setGiveAmount(e.target.value)}
                className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.noteLabel')}</label>
              <textarea
                value={giveNote}
                onChange={e => setGiveNote(e.target.value)}
                rows={2}
                placeholder={t('customers.karta.notePlaceholder')}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setGiveNasiyaOpen(false)}>{t('customers.karta.cancel')}</Button>
            <Button onClick={submitGiveNasiya} disabled={giving} loading={giving}>
              {t('customers.karta.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Accept Payment (repay nasiya) Modal */}
      <Dialog open={repayNasiyaOpen} onOpenChange={setRepayNasiyaOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customers.karta.acceptPayment')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-500 dark:text-gray-400">
              {t('customers.karta.nasiyaBalance')}: <span className="font-semibold text-gray-800 dark:text-gray-200">{formatPrice(nasiyaBalance)}</span>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.amountLabel')}</label>
              <input
                type="number"
                min={0}
                placeholder={t('customers.karta.amountPlaceholder')}
                value={repayAmount}
                onChange={e => setRepayAmount(e.target.value)}
                className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.karta.noteLabel')}</label>
              <textarea
                value={repayNote}
                onChange={e => setRepayNote(e.target.value)}
                rows={2}
                placeholder={t('customers.karta.notePlaceholder')}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setRepayNasiyaOpen(false)}>{t('customers.karta.cancel')}</Button>
            <Button onClick={submitRepayNasiya} disabled={repaying} loading={repaying}>
              {t('customers.karta.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
