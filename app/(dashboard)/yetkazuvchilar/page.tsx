'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2, Pencil, Plus, Search, Truck, Wallet, Banknote } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { KpiGrid } from '@/components/reports/ReportKit'
import { Pagination } from '@/components/ui/Pagination'
import { BalanceBadge, SupplierFormDialog, SupplierPaymentDialog, supplierFieldCls } from '@/components/suppliers/SupplierDialogs'
import { fetchSuppliersWithBalance, type SupplierWithBalance } from '@/lib/suppliers'

const PAGE_SIZE = 25

export default function SuppliersPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()

  const [suppliers, setSuppliers] = useState<SupplierWithBalance[]>([])
  const [paidThisMonth, setPaidThisMonth] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [onlyDebt, setOnlyDebt] = useState(false)
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SupplierWithBalance | null>(null)
  const [paying, setPaying] = useState<SupplierWithBalance | null>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const now = new Date()
    const monthStart = localYmd(new Date(now.getFullYear(), now.getMonth(), 1))
    const [list, paymentsRes] = await Promise.all([
      fetchSuppliersWithBalance(supabase),
      supabase.from('supplier_payments').select('amount').gte('date', monthStart),
    ])
    setSuppliers(list)
    setPaidThisMonth((paymentsRes.data ?? []).reduce((s, p) => s + Number(p.amount), 0))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return suppliers
      .filter(s => !onlyDebt || s.balance > 0.5)
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.phone.toLowerCase().includes(q) || s.companyName.toLowerCase().includes(q))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.balance - a.balance || a.name.localeCompare(b.name))
  }, [suppliers, search, onlyDebt])

  const totals = useMemo(() => ({
    debt: suppliers.reduce((s, x) => s + Math.max(0, x.balance), 0),
    withDebt: suppliers.filter(s => s.balance > 0.5).length,
  }), [suppliers])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('suppliersPage.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('suppliersPage.subtitle')}</p>
        </div>
        <button
          onClick={() => { setEditing(null); setFormOpen(true) }}
          className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-gray-100 dark:hover:bg-white dark:text-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <Plus className="h-4 w-4" /> {t('suppliersPage.add')}
        </button>
      </div>

      <KpiGrid items={[
        { label: t('suppliersPage.totalDebt'), value: formatPrice(totals.debt), icon: Wallet, tone: totals.debt > 0 ? 'negative' : undefined },
        { label: t('suppliersPage.withDebt'), value: String(totals.withDebt), icon: AlertCircle },
        { label: t('suppliersPage.suppliersCount'), value: String(suppliers.length), icon: Truck },
        { label: t('suppliersPage.paidPeriod'), value: formatPrice(paidThisMonth), icon: Banknote },
      ]} />

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('suppliersPage.search')} className={cn(supplierFieldCls, 'pl-9')} />
        </div>
        <div className="ml-auto inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
          {[false, true].map(v => (
            <button
              key={String(v)}
              onClick={() => { setOnlyDebt(v); setPage(1) }}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                onlyDebt === v
                  ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                  : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
              )}
            >
              {v ? t('suppliersPage.withDebt') : t('suppliersPage.suppliersCount')}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
            <Truck className="h-6 w-6" />
            {t('suppliersPage.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.name')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.phone')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.purchases')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.returned')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.paid')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('suppliersPage.position')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('suppliersPage.lastPurchase')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {paginated.map(s => (
                  <tr
                    key={s.id}
                    onClick={() => router.push(`/yetkazuvchilar/${s.id}`)}
                    className={cn('cursor-pointer border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors', !s.isActive && 'opacity-60')}
                  >
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{s.name}</p>
                      {(s.companyName || !s.isActive) && (
                        <p className="text-xs text-gray-400 dark:text-gray-500">{[s.companyName, !s.isActive ? t('suppliersPage.inactive') : ''].filter(Boolean).join(' · ')}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">{s.phone || '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100">{formatPrice(s.purchases)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{s.returned ? formatPrice(s.returned) : '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{formatPrice(s.paid)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap"><BalanceBadge balance={s.balance} /></td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">{s.lastPurchase ? formatDate(s.lastPurchase) : '—'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => setPaying(s)}
                          className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                          {t('suppliersPage.pay')}
                        </button>
                        <button
                          onClick={() => { setEditing(s); setFormOpen(true) }}
                          aria-label={t('suppliersPage.edit')}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}

      <SupplierFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        supplier={editing}
        onSaved={() => { setFormOpen(false); load() }}
      />
      <SupplierPaymentDialog
        open={paying !== null}
        onOpenChange={open => { if (!open) setPaying(null) }}
        supplierId={paying?.id ?? null}
        supplierName={paying?.name ?? ''}
        balance={paying?.balance ?? 0}
        onSaved={() => { setPaying(null); load() }}
      />
    </div>
  )
}
