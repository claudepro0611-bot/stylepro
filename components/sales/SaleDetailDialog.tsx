'use client'

// Read-only receipt view for one POS sale: header facts, every line with
// list price / discount / paid, returns made against it and the nasiya
// (credit) part. Opened from Payments, customer sales history, and the
// nasiya dialog.

import { useEffect, useState } from 'react'
import { Gift, Loader2, RotateCcw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useWarehouseScope } from '@/lib/branchStock'

interface Line {
  id: string
  name: string
  variant: string
  qty: number
  returnedQty: number
  listPrice: number
  price: number
  discountPercent: number
  isGift: boolean
}

interface ReturnInfo {
  id: string
  at: string
  reason: string
  amount: number
  qty: number
}

interface Sale {
  id: string
  at: string
  customer: string
  method: string
  cashier: string
  branchId: string | null
  status: string
  total: number
  lines: Line[]
  returns: ReturnInfo[]
  nasiya: number
}

export const receiptNo = (id: string) => `#${id.slice(0, 8).toUpperCase()}`

export function Fact({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
      <p className="text-xs text-gray-400 dark:text-gray-500">{label}</p>
      <p className={cn('mt-0.5 font-medium text-gray-900 dark:text-gray-100', className)}>{value}</p>
    </div>
  )
}

export function SaleDetailDialog({ transactionId, onClose }: { transactionId: string | null; onClose: () => void }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [sale, setSale] = useState<Sale | null>(null)
  const [loading, setLoading] = useState(false)
  // Multi-branch owner/admin on "All branches": show which branch sold it.
  const { showBranch, branchName } = useWarehouseScope()

  useEffect(() => {
    if (!transactionId) { setSale(null); return }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const [txRes, retRes, nasRes] = await Promise.all([
        supabase.from('transactions')
          .select('id, created_at, customer_name, payment_method, cashier_name, status, total_amount, branch_id, transaction_items(id, product_name, product_size_id, quantity, returned_quantity, list_price, price, discount_percent, is_gift)')
          .eq('id', transactionId).maybeSingle(),
        supabase.from('returns').select('id, created_at, reason, return_items(quantity, refund_amount)').eq('transaction_id', transactionId),
        supabase.from('nasiya_transactions').select('amount').eq('related_transaction_id', transactionId).eq('type', 'given'),
      ])
      if (cancelled) return
      const tx = txRes.data as unknown as {
        id: string; created_at: string; customer_name: string | null; payment_method: string | null; cashier_name: string | null; status: string; total_amount: number; branch_id?: string | null
        transaction_items: { id: string; product_name: string | null; product_size_id: string | null; quantity: number; returned_quantity: number; list_price: number; price: number; discount_percent: number; is_gift: boolean }[]
      } | null
      if (!tx) { setSale(null); setLoading(false); return }

      const sizeIds = tx.transaction_items.map(i => i.product_size_id).filter((x): x is string => !!x)
      const variants = new Map<string, string>()
      if (sizeIds.length) {
        const { data } = await supabase.from('product_sizes').select('id, size, color').in('id', sizeIds)
        for (const s of (data ?? []) as { id: string; size: string; color: string | null }[]) variants.set(s.id, [s.color, s.size].filter(Boolean).join(' / '))
      }
      if (cancelled) return

      setSale({
        id: tx.id,
        at: tx.created_at,
        customer: tx.customer_name || t('dashboard.recentSales.guestCustomer'),
        method: tx.payment_method || '—',
        cashier: tx.cashier_name || '—',
        branchId: tx.branch_id ?? null,
        status: tx.status,
        total: Number(tx.total_amount),
        lines: tx.transaction_items.map(i => ({
          id: i.id,
          name: i.product_name ?? '—',
          variant: (i.product_size_id && variants.get(i.product_size_id)) || '',
          qty: Number(i.quantity),
          returnedQty: Number(i.returned_quantity ?? 0),
          listPrice: Number(i.list_price) > 0 ? Number(i.list_price) : Number(i.price),
          price: Number(i.price),
          discountPercent: Number(i.discount_percent ?? 0),
          isGift: i.is_gift,
        })),
        returns: ((retRes.data ?? []) as { id: string; created_at: string; reason: string; return_items: { quantity: number; refund_amount: number }[] }[]).map(r => ({
          id: r.id,
          at: r.created_at,
          reason: r.reason,
          amount: r.return_items.reduce((s, x) => s + Number(x.refund_amount), 0),
          qty: r.return_items.reduce((s, x) => s + Number(x.quantity), 0),
        })),
        nasiya: ((nasRes.data ?? []) as { amount: number }[]).reduce((s, n) => s + Number(n.amount), 0),
      })
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [transactionId, t])

  const listTotal = sale?.lines.reduce((s, l) => s + l.listPrice * l.qty, 0) ?? 0
  const paidTotal = sale?.lines.reduce((s, l) => s + l.price * l.qty, 0) ?? 0
  const returnedTotal = sale?.returns.reduce((s, r) => s + r.amount, 0) ?? 0

  return (
    <Dialog open={transactionId !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('saleDetail.title')} {transactionId ? receiptNo(transactionId) : ''}
            {sale?.status === 'cancelled' && (
              <span className="rounded-full px-2 py-0.5 text-xs font-normal bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400">{t('saleDetail.fullyReturned')}</span>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading || !sale ? (
          <div className="flex h-48 items-center justify-center">
            {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-400" /> : <span className="text-sm text-gray-400">{t('saleDetail.notFound')}</span>}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Fact label={t('saleDetail.dateTime')} value={formatDateTime(sale.at)} />
              <Fact label={t('saleDetail.customer')} value={sale.customer} />
              <Fact label={t('saleDetail.method')} value={sale.nasiya > 0 ? `${sale.method} · ${t('saleDetail.nasiya')}` : sale.method} />
              <Fact label={t('saleDetail.cashier')} value={sale.cashier} />
              {showBranch && <Fact label={t('branches.branchLabel')} value={branchName(sale.branchId) || '—'} />}
            </div>

            <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-800">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-white dark:bg-gray-900">
                  <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2 text-left font-medium">№</th>
                    <th className="px-3 py-2 text-left font-medium">{t('saleDetail.product')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('saleDetail.qty')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('saleDetail.price')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('saleDetail.discount')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('saleDetail.sum')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.lines.map((l, i) => (
                    <tr key={l.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 align-top">
                      <td className="px-3 py-2 text-gray-400 dark:text-gray-500">{i + 1}</td>
                      <td className="px-3 py-2">
                        <p className="text-gray-900 dark:text-gray-100">
                          {l.name}
                          {l.isGift && <span className="ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400"><Gift className="h-3 w-3" />{t('saleDetail.gift')}</span>}
                        </p>
                        {l.variant && <p className="text-xs text-gray-400 dark:text-gray-500">{l.variant}</p>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {l.qty}
                        {l.returnedQty > 0 && <p className="text-[11px] text-red-600 dark:text-red-400">−{l.returnedQty} {t('saleDetail.returnedShort')}</p>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {l.price < l.listPrice && <p className="text-[11px] text-gray-400 line-through">{formatPrice(l.listPrice)}</p>}
                        {formatPrice(l.price)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {l.listPrice > l.price ? `−${formatPrice((l.listPrice - l.price) * l.qty)}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(l.price * l.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ml-auto w-full max-w-sm space-y-1.5">
              <div className="flex justify-between text-gray-500 dark:text-gray-400"><span>{t('saleDetail.listTotal')}</span><span className="tabular-nums">{formatPrice(listTotal)}</span></div>
              {listTotal > paidTotal && (
                <div className="flex justify-between text-gray-500 dark:text-gray-400"><span>{t('saleDetail.discount')}</span><span className="tabular-nums">−{formatPrice(listTotal - paidTotal)}</span></div>
              )}
              <div className="flex justify-between border-t border-gray-100 dark:border-gray-800 pt-1.5 font-semibold text-gray-900 dark:text-gray-100"><span>{t('saleDetail.total')}</span><span className="tabular-nums">{formatPrice(sale.total)}</span></div>
              {sale.nasiya > 0 && (
                <div className="flex justify-between text-amber-700 dark:text-amber-400"><span>{t('saleDetail.nasiyaPart')}</span><span className="tabular-nums">{formatPrice(sale.nasiya)}</span></div>
              )}
              {returnedTotal > 0 && (
                <div className="flex justify-between text-red-600 dark:text-red-400"><span>{t('saleDetail.returned')}</span><span className="tabular-nums">−{formatPrice(returnedTotal)}</span></div>
              )}
            </div>

            {sale.returns.length > 0 && (
              <div className="rounded-lg border border-red-100 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-red-700 dark:text-red-400"><RotateCcw className="h-3.5 w-3.5" />{t('saleDetail.returnsTitle')}</p>
                {sale.returns.map(r => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-red-100 dark:border-red-900/40 py-1.5 text-[13px] last:border-0">
                    <span className="text-gray-700 dark:text-gray-300">{formatDateTime(r.at)} · {r.qty} {t('saleDetail.pcs')}{r.reason ? ` · ${r.reason}` : ''}</span>
                    <span className="tabular-nums font-medium text-red-600 dark:text-red-400">−{formatPrice(r.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Nasiya (customer credit) movement: given or repaid. */
export interface NasiyaMove {
  id: string
  type: 'given' | 'repaid'
  amount: number
  at: string
  customer: string
  note: string | null
  relatedTransactionId: string | null
}

export function NasiyaDetailDialog({ move, onClose, onOpenSale }: { move: NasiyaMove | null; onClose: () => void; onOpenSale: (transactionId: string) => void }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  return (
    <Dialog open={move !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{move?.type === 'given' ? t('saleDetail.nasiyaGiven') : t('saleDetail.nasiyaRepaid')}</DialogTitle>
        </DialogHeader>
        {move && (
          <div className="space-y-3 text-sm">
            <div className={cn('rounded-lg px-4 py-3 text-center', move.type === 'given' ? 'bg-amber-50 dark:bg-amber-950/30' : 'bg-green-50 dark:bg-green-950/30')}>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('saleDetail.amount')}</p>
              <p className={cn('mt-0.5 text-2xl font-semibold tabular-nums', move.type === 'given' ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400')}>
                {move.type === 'given' ? '+' : '−'}{formatPrice(move.amount)}
              </p>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{move.type === 'given' ? t('saleDetail.debtUp') : t('saleDetail.debtDown')}</p>
            </div>
            <div className="rounded-lg border border-gray-100 dark:border-gray-800">
              <div className="flex justify-between gap-4 border-b border-gray-100 dark:border-gray-800 px-3 py-2"><span className="text-gray-500 dark:text-gray-400">{t('saleDetail.customer')}</span><span className="text-right text-gray-900 dark:text-gray-100">{move.customer}</span></div>
              <div className="flex justify-between gap-4 border-b border-gray-100 dark:border-gray-800 px-3 py-2 last:border-0"><span className="text-gray-500 dark:text-gray-400">{t('saleDetail.dateTime')}</span><span className="text-right text-gray-900 dark:text-gray-100">{formatDateTime(move.at)}</span></div>
              {move.note && <div className="flex justify-between gap-4 px-3 py-2"><span className="text-gray-500 dark:text-gray-400">{t('saleDetail.note')}</span><span className="text-right text-gray-900 dark:text-gray-100">{move.note}</span></div>}
            </div>
            {move.relatedTransactionId && (
              <button
                onClick={() => onOpenSale(move.relatedTransactionId!)}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                {t('saleDetail.openReceipt')} {receiptNo(move.relatedTransactionId)}
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
