'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { UserPlus, Search, Eye, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Pagination } from '@/components/ui/Pagination'
import { MiniBadge } from '@/components/ui/MiniBadge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { formatDate, formatPhone } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { Customer, Purchase } from '@/lib/types'

const ITEMS_PER_PAGE = 10
const STATUS_FILTERS = ['Barchasi', 'VIP', 'Regular', 'New'] as const

interface CustomerRow {
  id: string
  full_name: string
  phone: string | null
  email: string | null
  address: string | null
  status: 'VIP' | 'Regular' | 'New'
  total_purchases: number
  last_purchase_date: string | null
  complaints: string[] | null
  created_at: string
}

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone ?? '',
    email: row.email ?? '',
    address: row.address ?? '',
    status: row.status,
    totalPurchases: Number(row.total_purchases),
    lastPurchaseDate: row.last_purchase_date ?? '',
    createdAt: row.created_at.slice(0, 10),
    purchases: [],
    complaints: row.complaints ?? [],
  }
}

export default function CustomersPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('Barchasi')
  const [page, setPage] = useState(1)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [detailTab, setDetailTab] = useState('kontakt')
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [purchasesLoading, setPurchasesLoading] = useState(false)
  const [form, setForm] = useState({
    fullName: '', phone: '', email: '', address: '', status: 'New' as Customer['status'],
  })

  const fetchCustomers = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      toast.error(t('common.error'))
      setCustomers([])
    } else {
      setCustomers((data ?? []).map(row => mapCustomer(row as CustomerRow)))
    }
    setLoading(false)
  }, [t])

  useEffect(() => { fetchCustomers() }, [fetchCustomers])

  const filtered = useMemo(() => {
    let list = customers
    if (filter !== 'Barchasi') list = list.filter(c => c.status === filter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c => c.fullName.toLowerCase().includes(q) || c.phone.includes(q))
    }
    return list
  }, [customers, filter, search])

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE)
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  async function openDetail(c: Customer) {
    setSelectedCustomer(c)
    setDetailTab('kontakt')
    setIsDetailOpen(true)
    setPurchases([])
    setPurchasesLoading(true)

    const supabase = createClient()
    const { data, error } = await supabase
      .from('transactions_net')
      .select('id, date, net_amount, payment_method, transaction_items(product_name)')
      .eq('customer_id', c.id)
      .eq('status', 'completed')
      .order('date', { ascending: false })

    if (error) {
      toast.error(t('common.error'))
    } else {
      setPurchases((data ?? []).map(txn => ({
        id: txn.id ?? '',
        date: txn.date ?? '',
        amount: Number(txn.net_amount),
        items: (txn.transaction_items ?? []).map((i: { product_name: string | null }) => i.product_name ?? ''),
        paymentMethod: txn.payment_method ?? '',
      })))
    }
    setPurchasesLoading(false)
  }

  async function addCustomer() {
    if (!form.fullName.trim() || !form.phone.trim()) {
      toast.error(t('customers.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()

    const { error } = await supabase.rpc('create_customer', {
      p_full_name: form.fullName.trim(),
      p_phone: form.phone.trim(),
      p_email: form.email.trim() || null,
      p_address: form.address.trim() || null,
      p_status: form.status,
    })

    setSaving(false)

    if (error) {
      toast.error(t('common.error'))
      return
    }

    setForm({ fullName: '', phone: '', email: '', address: '', status: 'New' })
    setIsAddOpen(false)
    toast.success(t('customers.addSuccess'))
    fetchCustomers()
  }

  function initials(name: string) {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('customers.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{customers.length} {t('customers.countSuffix')}</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <UserPlus className="h-3.5 w-3.5" />
          {t('customers.addNew')}
        </button>
      </div>

      {/* Search + filter row */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            placeholder={t('customers.searchPlaceholder')}
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-9 pr-4 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
          />
        </div>
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1) }}
              className={`px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                filter === f
                  ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {f === 'Barchasi' ? t('customers.filterAll') : f === 'New' ? t('customers.filterNew') : f}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.customer')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.phone')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.totalPurchases')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.lastPurchase')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.status')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('customers.table.action')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('customers.notFound')}
                  </td>
                </tr>
              ) : paginated.map((c, i) => (
                <tr
                  key={c.id}
                  onClick={() => openDetail(c)}
                  className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                >
                  <td className="w-10 px-4 py-3" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
                        {initials(c.fullName)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.fullName}</p>
                        {c.email && <p className="text-[11px] text-gray-400 dark:text-gray-500">{c.email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{formatPhone(c.phone)}</td>
                  <td className="px-4 py-3 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">
                    {formatPrice(c.totalPurchases)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {c.lastPurchaseDate ? formatDate(c.lastPurchaseDate) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <MiniBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={e => { e.stopPropagation(); openDetail(c) }}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Eye className="h-3 w-3" />
                      {t('customers.view')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={filtered.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setPage}
        />
      </div>

      {/* Customer Detail Modal */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="sm:max-w-lg">
          {selectedCustomer && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-sm font-semibold text-gray-700 dark:text-gray-300">
                    {initials(selectedCustomer.fullName)}
                  </div>
                  <div>
                    <DialogTitle className="text-base">{selectedCustomer.fullName}</DialogTitle>
                    <div className="mt-1">
                      <MiniBadge status={selectedCustomer.status} />
                    </div>
                  </div>
                </div>
              </DialogHeader>

              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList>
                  <TabsTrigger value="kontakt">{t('customers.tabs.contact')}</TabsTrigger>
                  <TabsTrigger value="xaridlar">{t('customers.tabs.purchases')}</TabsTrigger>
                  <TabsTrigger value="murojaatlar">{t('customers.tabs.complaints')}</TabsTrigger>
                </TabsList>

                <TabsContent value="kontakt" className="mt-4 space-y-0">
                  {[
                    [t('customers.detail.phone'), formatPhone(selectedCustomer.phone)],
                    [t('customers.detail.email'), selectedCustomer.email || '—'],
                    [t('customers.detail.address'), selectedCustomer.address || '—'],
                    [t('customers.detail.registeredAt'), formatDate(selectedCustomer.createdAt)],
                    [t('customers.detail.lastPurchase'), selectedCustomer.lastPurchaseDate ? formatDate(selectedCustomer.lastPurchaseDate) : '—'],
                    [t('customers.detail.totalPurchases'), formatPrice(selectedCustomer.totalPurchases)],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <span className="text-sm text-gray-400 dark:text-gray-500">{label}</span>
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</span>
                    </div>
                  ))}
                </TabsContent>

                <TabsContent value="xaridlar" className="mt-4">
                  {purchasesLoading ? (
                    <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">
                      <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                      {t('common.loading')}
                    </p>
                  ) : purchases.length === 0 ? (
                    <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('customers.detail.noPurchases')}</p>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {purchases.slice(0, 20).map(p => (
                        <div key={p.id} className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2.5">
                          <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.items[0] ?? '—'}</p>
                            <p className="text-[11px] text-gray-400 dark:text-gray-500">{formatDate(p.date)} · {p.paymentMethod}</p>
                          </div>
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(p.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="murojaatlar" className="mt-4">
                  {selectedCustomer.complaints.length === 0 ? (
                    <p className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">{t('customers.detail.noComplaints')}</p>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto">
                      {selectedCustomer.complaints.map((c, idx) => (
                        <div key={idx} className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-700 dark:text-gray-300">
                          {c}
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>

              <DialogFooter showCloseButton />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Customer Modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('customers.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {[
              { label: t('customers.fullNameLabel'), key: 'fullName', placeholder: t('customers.fullNamePlaceholder') },
              { label: t('customers.phoneLabel'), key: 'phone', placeholder: t('customers.phonePlaceholder') },
              { label: t('customers.emailLabel'), key: 'email', placeholder: t('customers.emailPlaceholder') },
              { label: t('customers.addressLabel'), key: 'address', placeholder: t('customers.addressPlaceholder') },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
                <input
                  type="text"
                  placeholder={placeholder}
                  value={form[key as keyof typeof form] as string}
                  onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
                />
              </div>
            ))}
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('customers.statusLabel')}</label>
              <select
                value={form.status}
                onChange={e => setForm(prev => ({ ...prev, status: e.target.value as Customer['status'] }))}
                className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
              >
                <option value="New">{t('customers.statusNew')}</option>
                <option value="Regular">Regular</option>
                <option value="VIP">VIP</option>
              </select>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button onClick={addCustomer} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
