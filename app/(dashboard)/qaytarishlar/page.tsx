'use client'

import { SaleDetailDialog } from '@/components/sales/SaleDetailDialog'
import { useEffect, useMemo, useState } from 'react'
import { Download, Loader2, RotateCcw, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { eqBranch, useWarehouseScope } from '@/lib/branchStock'

const ITEMS_PER_PAGE = 20

interface ReturnRow {
  id: string
  reason: string
  created_at: string
  created_by: string | null
  transaction_id: string
  branch_id?: string | null
  transactions: { customer_name: string | null; payment_method: string | null } | null
  return_items: { quantity: number; refund_amount: number; transaction_items: { product_name: string | null } | null }[]
}

interface ReturnView {
  id: string
  txId: string
  createdAt: string
  receipt: string
  customer: string
  products: string
  quantity: number
  refund: number
  paymentMethod: string
  reason: string
  by: string
  branch: string
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export default function QaytarishlarPage() {
  const [openTx, setOpenTx] = useState<string | null>(null)
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<ReturnView[]>([])
  const [range, setRange] = useState<DateRangeValue | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  // Header branch filter; multi-branch owner/admin on "All" get a Branch column.
  const { showBranch: showBranchCol, branchName, activeBranchId } = useWarehouseScope()

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      const supabase = createClient()
      const [{ data: returnsData }, usersRes] = await Promise.all([
        fetchAllRows<ReturnRow>((from, to) =>
          eqBranch(supabase
            .from('returns')
            .select('id, reason, created_at, created_by, transaction_id, branch_id, transactions(customer_name, payment_method), return_items(quantity, refund_amount, transaction_items(product_name))'), activeBranchId)
            .order('id')
            .range(from, to) as unknown as PromiseLike<{ data: ReturnRow[] | null; error: unknown }>,
        ),
        supabase.from('users').select('id, full_name'),
      ])
      if (!active) return
      const userName = new Map((usersRes.data ?? []).map(u => [u.id as string, (u.full_name as string | null) ?? '']))
      const views = returnsData.map<ReturnView>(r => {
        const names = Array.from(new Set(r.return_items.map(i => i.transaction_items?.product_name ?? '—')))
        return {
          id: r.id,
          txId: r.transaction_id,
          createdAt: r.created_at,
          receipt: `#${r.transaction_id.slice(0, 8).toUpperCase()}`,
          customer: r.transactions?.customer_name ?? '—',
          products: names.join(', '),
          quantity: r.return_items.reduce((s, i) => s + i.quantity, 0),
          refund: r.return_items.reduce((s, i) => s + Number(i.refund_amount), 0),
          paymentMethod: r.transactions?.payment_method ?? '—',
          reason: r.reason,
          by: (r.created_by && userName.get(r.created_by)) || '—',
          branch: branchName(r.branch_id) || '—',
        }
      })
      views.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setRows(views)
      setLoading(false)
    })()
    return () => { active = false }
  }, [activeBranchId, branchName])

  const filtered = useMemo(() => {
    let list = rows
    if (range) {
      list = list.filter(r => {
        const day = localYmd(new Date(r.createdAt))
        return day >= range.from && day <= range.to
      })
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(r =>
        r.customer.toLowerCase().includes(q) ||
        r.receipt.toLowerCase().includes(q) ||
        r.products.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q),
      )
    }
    return list
  }, [rows, range, search])

  const totalRefund = filtered.reduce((s, r) => s + r.refund, 0)
  const totalQty = filtered.reduce((s, r) => s + r.quantity, 0)
  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE))
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  function exportCSV() {
    const headers = [t('returnsPage.date'), t('returnsPage.receipt'), t('returnsPage.customer'), t('returnsPage.products'), t('returnsPage.quantity'), t('returnsPage.refund'), t('returnsPage.payment'), t('returnsPage.reason'), t('returnsPage.by'), ...(showBranchCol ? [t('branches.branchLabel')] : [])]
    const data = filtered.map(r => [formatDateTime(r.createdAt), r.receipt, r.customer, r.products, String(r.quantity), String(r.refund), r.paymentMethod, r.reason, r.by, ...(showBranchCol ? [r.branch] : [])])
    const csv = [headers, ...data].map(r => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `qaytarishlar_${localYmd()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('returnsPage.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('returnsPage.subtitle')}</p>
        </div>
        <button onClick={exportCSV} disabled={filtered.length === 0}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50">
          <Download className="h-4 w-4" /> {t('returnsPage.export')}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: t('returnsPage.count'), value: String(filtered.length) },
          { label: t('returnsPage.quantity'), value: String(totalQty) },
          { label: t('returnsPage.refund'), value: formatPrice(totalRefund) },
        ].map(k => (
          <div key={k.label} className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-5">
            <p className="text-[12.5px] text-gray-500 dark:text-gray-400">{k.label}</p>
            <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{k.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 flex flex-wrap items-center gap-2">
        <DateRangeFilter value={range} onChange={r => { setRange(r); setPage(1) }} />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('returnsPage.search')}
            className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500" />
        </div>
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
            <RotateCcw className="h-6 w-6" /> {t('returnsPage.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3 font-medium">{t('returnsPage.date')}</th>
                  <th className="px-4 py-3 font-medium">{t('returnsPage.receipt')}</th>
                  <th className="px-4 py-3 font-medium">{t('returnsPage.customer')}</th>
                  {showBranchCol && <th className="px-4 py-3 font-medium">{t('branches.branchLabel')}</th>}
                  <th className="px-4 py-3 font-medium">{t('returnsPage.products')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('returnsPage.quantity')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('returnsPage.refund')}</th>
                  <th className="px-4 py-3 font-medium">{t('returnsPage.payment')}</th>
                  <th className="px-4 py-3 font-medium">{t('returnsPage.reason')}</th>
                  <th className="px-4 py-3 font-medium">{t('returnsPage.by')}</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(r => (
                  <tr key={r.id} onClick={() => setOpenTx(r.txId)} className="cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-gray-700 dark:text-gray-300 tabular-nums">{formatDateTime(r.createdAt)}</td>
                    <td className="px-4 py-3 font-mono text-[12.5px] text-gray-700 dark:text-gray-300">{r.receipt}</td>
                    <td className="px-4 py-3 text-gray-900 dark:text-gray-100">{r.customer}</td>
                    {showBranchCol && <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{r.branch}</td>}
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300 max-w-xs truncate" title={r.products}>{r.products}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-900 dark:text-gray-100">{r.quantity}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-red-600 dark:text-red-400">−{formatPrice(r.refund)}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{r.paymentMethod}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 max-w-xs truncate" title={r.reason}>{r.reason}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{r.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination currentPage={page} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
      <SaleDetailDialog transactionId={openTx} onClose={() => setOpenTx(null)} />
    </div>
  )
}
