'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlarmClock, Banknote, Eye, Pencil, Search, Truck, Users, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { KpiGrid } from '@/components/reports/ReportKit'
import {
  ActiveBadge, FilterBar, PageHeader, TableCard, prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { DebtValue, SupplierFormDialog, SupplierPaymentDialog, useProdSuppliers } from '@/components/production/SupplierKit'
import type { ProdSupplier } from '@/lib/production'
import { ExportButton } from '@/components/production/ReportKit'
import { dateTimeCell, downloadXlsx, x2 } from '@/lib/production-reports'
import { fetchSupplierAgeing, type SupplierAgeing } from '@/lib/inventory'

const iconBtn = 'flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'

export default function ProdSuppliersPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { suppliers, loading, reload } = useProdSuppliers()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [onlyDebtors, setOnlyDebtors] = useState(false)
  const [editing, setEditing] = useState<ProdSupplier | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [payFor, setPayFor] = useState<string | undefined>(undefined)
  const [payOpen, setPayOpen] = useState(false)
  const [paidThisMonth, setPaidThisMonth] = useState(0)
  const [monthTick, setMonthTick] = useState(0)
  // prod_supplier_ageing (migration 20261110000014); null = not available.
  const [ageing, setAgeing] = useState<Map<string, SupplierAgeing> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchSupplierAgeing(createClient()).then(a => { if (!cancelled) setAgeing(a) })
    return () => { cancelled = true }
  }, [suppliers])

  // Posted payments since the 1st of the current month.
  useEffect(() => {
    const now = new Date()
    const from = localYmd(new Date(now.getFullYear(), now.getMonth(), 1))
    const supabase = createClient()
    fetchAllRows<{ amount: number }>((f, to) => supabase.from('prod_supplier_payments')
      .select('amount')
      .eq('status', 'posted')
      .gte('pay_date', from)
      .order('id')
      .range(f, to))
      .then(({ data }) => setPaidThisMonth(data.reduce((s, r) => s + Number(r.amount), 0)))
  }, [monthTick])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return suppliers
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.phone.includes(q))
      .filter(s => !status || (status === 'active' ? s.isActive : !s.isActive))
      .filter(s => !onlyDebtors || s.debt > 0)
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name))
  }, [suppliers, search, status, onlyDebtors])

  const totalDebt = useMemo(() => suppliers.reduce((s, x) => s + (x.debt > 0 ? x.debt : 0), 0), [suppliers])
  const totalOverdue = useMemo(() => (ageing ? [...ageing.values()].reduce((s, a) => s + a.d1_15 + a.d16_30 + a.d31, 0) : 0), [ageing])
  const ageCell = (n: number | undefined, tone: 'none' | 'amber' | 'red') => (
    <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap', !n ? 'text-gray-400 dark:text-gray-500'
      : tone === 'red' ? 'text-red-600 dark:text-red-400' : tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100')}>
      {n ? formatPrice(n) : '—'}
    </td>
  )

  function exportXlsx() {
    downloadXlsx('zavod_yetkazuvchilar', [
      t('production.common.name'), t('production.suppliers.phone'), t('production.suppliers.address'), t('production.common.status'),
      `${t('production.suppliers.purchased')} (UZS)`, `${t('production.suppliers.paid')} (UZS)`, `${t('production.suppliers.debt')} (UZS)`,
      t('production.suppliers.lastReceipt'), t('production.suppliers.lastPayment'),
      ...(ageing ? [t('prodInventory.ageing.notDue'), t('prodInventory.ageing.d1_15'), t('prodInventory.ageing.d16_30'), t('prodInventory.ageing.d31')] : []),
    ], filtered.map(s => {
      const a = ageing?.get(s.id)
      return [
        s.name, s.phone, s.address, s.isActive ? t('production.common.active') : t('production.common.inactive'),
        x2(s.purchased), x2(s.paid), x2(s.debt), s.lastReceiptAt ? dateTimeCell(s.lastReceiptAt) : '', s.lastPaymentAt ?? '',
        ...(ageing ? [x2(a?.notDue ?? 0), x2(a?.d1_15 ?? 0), x2(a?.d16_30 ?? 0), x2(a?.d31 ?? 0)] : []),
      ]
    }), t('production.suppliers.title'))
  }

  function reset() {
    setSearch('')
    setStatus('')
    setOnlyDebtors(false)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('production.suppliers.title')}
        subtitle={t('production.suppliers.subtitle')}
        actionLabel={t('production.suppliers.new')}
        onAction={() => { setEditing(null); setFormOpen(true) }}
      />

      <KpiGrid items={[
        { label: t('production.suppliers.totalDebt'), value: formatPrice(totalDebt), icon: Wallet, tone: totalDebt > 0 ? 'negative' : undefined },
        { label: t('production.suppliers.paidThisMonth'), value: formatPrice(paidThisMonth), icon: Banknote },
        { label: t('production.suppliers.count'), value: String(suppliers.length), icon: Users },
        ...(ageing ? [{ label: t('prodInventory.ageing.overdue'), value: formatPrice(totalOverdue), icon: AlarmClock, tone: totalOverdue > 0 ? 'negative' as const : undefined }] : []),
      ]} />

      <FilterBar onReset={search || status || onlyDebtors ? reset : undefined} columns={<ExportButton onClick={exportXlsx} disabled={filtered.length === 0} />}>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('production.suppliers.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} className={cn(prodFieldCls, 'w-40')}>
          <option value="">{t('production.common.allStatuses')}</option>
          <option value="active">{t('production.common.active')}</option>
          <option value="inactive">{t('production.common.inactive')}</option>
        </select>
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={onlyDebtors} onChange={e => setOnlyDebtors(e.target.checked)} className="h-3.5 w-3.5 accent-slate-900 dark:accent-gray-100" />
          {t('production.suppliers.onlyDebtors')}
        </label>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.suppliers.empty')} emptyIcon={Truck}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.suppliers.name')}</th>
              <th className={thCls}>{t('production.suppliers.phone')}</th>
              <th className={thRightCls}>{t('production.suppliers.purchased')}</th>
              <th className={thRightCls}>{t('production.suppliers.paid')}</th>
              <th className={thRightCls}>{t('production.suppliers.debt')}</th>
              {ageing && (
                <>
                  <th className={thRightCls}>{t('prodInventory.ageing.notDue')}</th>
                  <th className={thRightCls}>{t('prodInventory.ageing.d1_15')}</th>
                  <th className={thRightCls}>{t('prodInventory.ageing.d16_30')}</th>
                  <th className={thRightCls}>{t('prodInventory.ageing.d31')}</th>
                </>
              )}
              <th className={thCls}>{t('production.suppliers.lastReceipt')}</th>
              <th className={thCls}>{t('production.common.status')}</th>
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(s => (
              <tr key={s.id} onClick={() => router.push(`/zavod-yetkazuvchilar/${s.id}`)} className={cn(trCls, 'cursor-pointer', !s.isActive && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{s.name}</td>
                <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{s.phone || '—'}</td>
                <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-900 dark:text-gray-100')}>{formatPrice(s.purchased)}</td>
                <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatPrice(s.paid)}</td>
                <td className={cn(tdCls, 'text-right')}><DebtValue debt={s.debt} /></td>
                {ageing && (
                  <>
                    {ageCell(ageing.get(s.id)?.notDue, 'none')}
                    {ageCell(ageing.get(s.id)?.d1_15, 'amber')}
                    {ageCell(ageing.get(s.id)?.d16_30, 'red')}
                    {ageCell(ageing.get(s.id)?.d31, 'red')}
                  </>
                )}
                <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{s.lastReceiptAt ? formatDate(s.lastReceiptAt) : '—'}</td>
                <td className={tdCls}><ActiveBadge active={s.isActive} /></td>
                <td className={tdCls}>
                  <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                    <Link href={`/zavod-yetkazuvchilar/${s.id}`} aria-label={t('production.common.view')} title={t('production.common.view')} className={iconBtn}>
                      <Eye className="h-3.5 w-3.5" />
                    </Link>
                    <button type="button" onClick={() => { setEditing(s); setFormOpen(true) }} aria-label={t('production.common.edit')} title={t('production.common.edit')} className={iconBtn}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => { setPayFor(s.id); setPayOpen(true) }} aria-label={t('production.suppliers.pay')} title={t('production.suppliers.pay')} className={iconBtn}>
                      <Banknote className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <SupplierFormDialog open={formOpen} onOpenChange={setFormOpen} supplier={editing} onSaved={() => { setFormOpen(false); reload() }} />
      <SupplierPaymentDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        suppliers={suppliers}
        supplierId={payFor}
        onSaved={() => { setPayOpen(false); reload(); setMonthTick(n => n + 1) }}
      />
    </div>
  )
}
