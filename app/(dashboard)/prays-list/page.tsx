'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, ListOrdered, Loader2, Plus, Printer, Search, Trash2, Users, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { sortSizes } from '@/lib/sizes'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { Pagination } from '@/components/ui/Pagination'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { computeListPrice, mapPriceList, ROUNDING_OPTIONS, type PriceList, type PriceListBase, type PriceListRow } from '@/lib/price-lists'

const ITEMS_PER_PAGE = 30

const inputCls = 'h-9 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'
const labelCls = 'block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5'
const segCls = (active: boolean) => cn(
  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
  active
    ? 'bg-slate-900 dark:bg-white shadow-sm border border-slate-900 dark:border-white text-white dark:text-gray-900'
    : 'border border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
)

interface VariantRow {
  id: string
  name: string
  sku: string
  variant: string
  size: string
  retail: number
  purchase: number
}

interface CustomerLite { id: string; fullName: string; phone: string; priceListId: string | null }

interface Draft { id: string | null; name: string; base: PriceListBase; adjust: string; rounding: number; isActive: boolean }

const emptyDraft: Draft = { id: null, name: '', base: 'selling', adjust: '0', rounding: 0, isActive: true }

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export default function PriceListPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()

  const [loading, setLoading] = useState(true)
  const [lists, setLists] = useState<PriceList[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [variants, setVariants] = useState<VariantRow[]>([])
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map())
  const [customers, setCustomers] = useState<CustomerLite[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [overrideDraft, setOverrideDraft] = useState<Record<string, string>>({})

  const active = lists.find(l => l.id === activeId) ?? null

  const loadLists = useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase.from('price_lists').select('id, name, base, adjust_percent, rounding, is_active').order('created_at')
    if (error) { toast.error(t('common.error')); return [] }
    const mapped = (data as PriceListRow[]).map(mapPriceList)
    setLists(mapped)
    return mapped
  }, [t])

  // Catalog + customers: loaded once.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const [mapped, sizesRes, productsRes, customersRes] = await Promise.all([
        loadLists(),
        fetchAllRows<{ id: string; product_id: string; size: string; color: string; selling_price: number | null; purchase_price: number | null; sku: string | null }>((from, to) =>
          supabase.from('product_sizes').select('id, product_id, size, color, selling_price, purchase_price, sku').order('id').range(from, to)),
        fetchAllRows<{ id: string; name: string; sku: string | null; price: number; status: string }>((from, to) =>
          supabase.from('products').select('id, name, sku, price, status').order('id').range(from, to)),
        fetchAllRows<{ id: string; full_name: string; phone: string | null; price_list_id: string | null }>((from, to) =>
          supabase.from('customers').select('id, full_name, phone, price_list_id').order('id').range(from, to)),
      ])
      if (cancelled) return
      const productMap = new Map(productsRes.data.map(p => [p.id, p]))
      const rank = new Map(sortSizes(Array.from(new Set(sizesRes.data.map(s => s.size)))).map((s, i) => [s, i]))
      const rows: VariantRow[] = []
      for (const sz of sizesRes.data) {
        const p = productMap.get(sz.product_id)
        if (!p || p.status !== 'active') continue
        rows.push({
          id: sz.id,
          name: p.name,
          sku: sz.sku ?? p.sku ?? '',
          variant: [sz.color, sz.size].filter(Boolean).join(' / '),
          size: sz.size,
          retail: Number(sz.selling_price) > 0 ? Number(sz.selling_price) : Number(p.price),
          purchase: Number(sz.purchase_price ?? 0),
        })
      }
      rows.sort((a, b) => a.name.localeCompare(b.name) || (rank.get(a.size) ?? 0) - (rank.get(b.size) ?? 0) || a.variant.localeCompare(b.variant))
      setVariants(rows)
      setCustomers(customersRes.data.map(c => ({ id: c.id, fullName: c.full_name, phone: c.phone ?? '', priceListId: c.price_list_id })))
      setActiveId(prev => prev ?? mapped[0]?.id ?? null)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [loadLists])

  // Overrides of the selected list.
  useEffect(() => {
    if (!activeId) { setOverrides(new Map()); return }
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const { data } = await fetchAllRows<{ product_size_id: string; price: number }>((from, to) =>
        supabase.from('price_list_items').select('product_size_id, price').eq('price_list_id', activeId).order('product_size_id').range(from, to))
      if (cancelled) return
      setOverrides(new Map(data.map(r => [r.product_size_id, Number(r.price)])))
      setOverrideDraft({})
    })()
    return () => { cancelled = true }
  }, [activeId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return variants
    return variants.filter(v => v.name.toLowerCase().includes(q) || v.sku.toLowerCase().includes(q) || v.variant.toLowerCase().includes(q))
  }, [variants, search])
  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE))
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  const priceOf = (v: VariantRow) => (active ? computeListPrice(active, v.retail, v.purchase, overrides.get(v.id)) : v.retail)

  const assigned = customers.filter(c => active && c.priceListId === active.id)

  // ─── List CRUD ──────────────────────────────────────────────────────────
  function openCreate() {
    setDraft(emptyDraft)
    setDialogOpen(true)
  }

  function openEdit() {
    if (!active) return
    setDraft({ id: active.id, name: active.name, base: active.base, adjust: String(active.adjustPercent), rounding: active.rounding, isActive: active.isActive })
    setDialogOpen(true)
  }

  async function saveDraft() {
    const adjust = Number(draft.adjust.replace(',', '.'))
    if (!draft.name.trim()) { toast.error(t('priceLists.nameRequired')); return }
    if (!Number.isFinite(adjust) || adjust <= -100 || adjust > 1000) { toast.error(t('priceLists.invalidPercent')); return }
    setSaving(true)
    const supabase = createClient()
    const { data, error } = await supabase.rpc('save_price_list', {
      p_id: draft.id, p_name: draft.name.trim(), p_base: draft.base, p_adjust_percent: adjust, p_rounding: draft.rounding, p_is_active: draft.isActive,
    })
    setSaving(false)
    if (error) { toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error')); return }
    await loadLists()
    if (data) setActiveId(data as string)
    setDialogOpen(false)
    toast.success(t('priceLists.saved'))
  }

  async function deleteActive() {
    if (!active) return
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_price_list', { p_id: active.id })
    setDeleteOpen(false)
    if (error) { toast.error(t('common.error')); return }
    const next = await loadLists()
    setCustomers(prev => prev.map(c => (c.priceListId === active.id ? { ...c, priceListId: null } : c)))
    setActiveId(next[0]?.id ?? null)
    toast.success(t('priceLists.deleted'))
  }

  // ─── Manual price per variant ───────────────────────────────────────────
  async function commitOverride(v: VariantRow) {
    if (!active) return
    const raw = overrideDraft[v.id]
    if (raw === undefined) return
    const digits = raw.replace(/\D/g, '')
    const price = digits === '' ? null : Number(digits)
    const supabase = createClient()
    const { error } = await supabase.rpc('set_price_list_item', { p_price_list_id: active.id, p_product_size_id: v.id, p_price: price })
    if (error) { toast.error(t('common.error')); return }
    setOverrides(prev => {
      const next = new Map(prev)
      if (price === null) next.delete(v.id)
      else next.set(v.id, price)
      return next
    })
    setOverrideDraft(prev => { const n = { ...prev }; delete n[v.id]; return n })
  }

  // ─── Customers ──────────────────────────────────────────────────────────
  async function setCustomerList(customerId: string, listId: string | null) {
    const supabase = createClient()
    const { error } = await supabase.rpc('set_customer_price_list', { p_customer_id: customerId, p_price_list_id: listId })
    if (error) { toast.error(t('common.error')); return }
    setCustomers(prev => prev.map(c => (c.id === customerId ? { ...c, priceListId: listId } : c)))
  }

  // ─── Export / print ─────────────────────────────────────────────────────
  function exportCSV() {
    if (!active) return
    const headers = [t('priceLists.table.product'), t('priceLists.table.variant'), 'SKU', t('priceLists.table.price')]
    const data = filtered.map(v => [v.name, v.variant, v.sku, String(priceOf(v))])
    const csv = [headers, ...data].map(r => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `prays-list_${active.name}_${localYmd()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function printList() {
    if (!active) return
    const w = window.open('', '_blank')
    if (!w) return
    const rows = filtered.map(v => `<tr><td>${escapeHtml(v.name)}</td><td>${escapeHtml(v.variant)}</td><td>${escapeHtml(v.sku)}</td><td class="r">${escapeHtml(formatPrice(priceOf(v)))}</td></tr>`).join('')
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(active.name)}</title>
<style>body{font-family:system-ui,sans-serif;font-size:12px;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px}p{color:#666;margin:0 0 16px}
table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}th{color:#555;font-weight:600}.r{text-align:right}</style></head>
<body><h1>${escapeHtml(t('priceLists.title'))}: ${escapeHtml(active.name)}</h1><p>${escapeHtml(localYmd())}</p>
<table><thead><tr><th>${escapeHtml(t('priceLists.table.product'))}</th><th>${escapeHtml(t('priceLists.table.variant'))}</th><th>SKU</th><th class="r">${escapeHtml(t('priceLists.table.price'))}</th></tr></thead><tbody>${rows}</tbody></table></body></html>`)
    w.document.close()
    w.focus()
    w.print()
  }

  const ruleText = active
    ? `${active.base === 'purchase' ? t('priceLists.base.purchase') : t('priceLists.base.selling')} ${active.adjustPercent >= 0 ? '+' : '−'}${Math.abs(active.adjustPercent)}%${active.rounding ? ` · ${t('priceLists.roundTo')} ${active.rounding}` : ''}`
    : ''

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('priceLists.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('priceLists.subtitle')}</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-white transition-colors">
          <Plus className="h-4 w-4" /> {t('priceLists.create')}
        </button>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
      ) : lists.length === 0 ? (
        <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm px-4 py-16 flex flex-col items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
          <ListOrdered className="h-6 w-6 text-gray-300 dark:text-gray-600" />
          <p className="font-medium text-gray-900 dark:text-gray-100">{t('priceLists.emptyTitle')}</p>
          <p className="max-w-md text-center">{t('priceLists.emptyHint')}</p>
          <button onClick={openCreate} className="mt-2 flex items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm font-medium text-white transition-colors">
            <Plus className="h-4 w-4" /> {t('priceLists.create')}
          </button>
        </div>
      ) : (
        <>
          {/* List selector */}
          <div className="flex flex-wrap gap-2">
            {lists.map(l => (
              <button
                key={l.id}
                onClick={() => { setActiveId(l.id); setPage(1) }}
                className={cn(
                  'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                  l.id === activeId
                    ? 'bg-slate-900 dark:bg-white shadow-sm border border-slate-900 dark:border-white text-white dark:text-gray-900'
                    : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
                  !l.isActive && 'opacity-60',
                )}
              >
                {l.name}
              </button>
            ))}
          </div>

          {active && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Rule card */}
              <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{active.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-gray-500 dark:text-gray-400">{ruleText}</p>
                  </div>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', active.isActive ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400')}>
                    {active.isActive ? t('priceLists.active') : t('priceLists.inactive')}
                  </span>
                </div>
                <p className="text-[12.5px] text-gray-400 dark:text-gray-500">{t('priceLists.overrideHint')}</p>
                <div className="flex gap-2">
                  <button onClick={openEdit} className="flex-1 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    {t('priceLists.edit')}
                  </button>
                  <button onClick={() => setDeleteOpen(true)} aria-label={t('priceLists.delete')} className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Customers card */}
              <div className="lg:col-span-2 rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 space-y-3">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-gray-400" />
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('priceLists.customers')}</p>
                  <span className="rounded-md bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">{assigned.length}</span>
                </div>
                <p className="text-[12.5px] text-gray-400 dark:text-gray-500">{t('priceLists.customersHint')}</p>
                <div className="max-w-sm">
                  <SearchSelect
                    options={customers.filter(c => c.priceListId !== active.id).map(c => ({ value: c.id, label: c.fullName, sublabel: c.phone }))}
                    value=""
                    onChange={value => { if (value) setCustomerList(value, active.id) }}
                    placeholder={t('priceLists.addCustomer')}
                  />
                </div>
                {assigned.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {assigned.map(c => (
                      <span key={c.id} className="flex items-center gap-1 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 pl-3 pr-1 py-1 text-[12.5px] text-gray-700 dark:text-gray-300">
                        {c.fullName}
                        <button onClick={() => setCustomerList(c.id, null)} aria-label={t('priceLists.removeCustomer')} className="flex h-5 w-5 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {active && (
            <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 dark:border-gray-800 p-4">
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('priceLists.search')} className={cn(inputCls, 'pl-9')} />
                </div>
                <div className="ml-auto flex gap-2">
                  <button onClick={printList} className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <Printer className="h-4 w-4 text-gray-400" /> {t('priceLists.print')}
                  </button>
                  <button onClick={exportCSV} className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-4 py-2 text-sm font-medium text-white transition-colors">
                    <Download className="h-4 w-4" /> {t('priceLists.export')}
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-800 text-left text-gray-500 dark:text-gray-400">
                      <th className="px-4 py-3 font-medium">{t('priceLists.table.product')}</th>
                      <th className="px-4 py-3 font-medium">SKU</th>
                      <th className="px-4 py-3 font-medium text-right">{t('priceLists.table.purchase')}</th>
                      <th className="px-4 py-3 font-medium text-right">{t('priceLists.table.retail')}</th>
                      <th className="px-4 py-3 font-medium text-right">{t('priceLists.table.price')}</th>
                      <th className="px-4 py-3 font-medium text-right">{t('priceLists.table.manual')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.map(v => {
                      const price = priceOf(v)
                      const hasOverride = overrides.has(v.id)
                      const draftVal = overrideDraft[v.id]
                      const belowCost = price < v.purchase
                      return (
                        <tr key={v.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                          <td className="px-4 py-2.5 text-gray-900 dark:text-gray-100">
                            {v.name}{v.variant && <span className="text-gray-400 dark:text-gray-500"> · {v.variant}</span>}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{v.sku || '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatPrice(v.purchase)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatPrice(v.retail)}</td>
                          <td className={cn('px-4 py-2.5 text-right tabular-nums font-medium whitespace-nowrap', belowCost ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100')} title={belowCost ? t('priceLists.belowCost') : undefined}>
                            {formatPrice(price)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <input
                              type="text" inputMode="numeric"
                              value={draftVal !== undefined ? draftVal : hasOverride ? new Intl.NumberFormat('ru-RU').format(overrides.get(v.id) ?? 0) : ''}
                              placeholder={t('priceLists.auto')}
                              onChange={e => setOverrideDraft(prev => ({ ...prev, [v.id]: e.target.value }))}
                              onBlur={() => commitOverride(v)}
                              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                              className={cn('h-8 w-28 rounded-lg border bg-white dark:bg-gray-900 px-2 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500', hasOverride ? 'border-gray-400 dark:border-gray-500' : 'border-gray-200 dark:border-gray-700')}
                            />
                          </td>
                        </tr>
                      )
                    })}
                    {paginated.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">{t('common.notFound')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <Pagination currentPage={page} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setPage} />
        </>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft.id ? t('priceLists.edit') : t('priceLists.create')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>{t('priceLists.name')}</label>
              <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder={t('priceLists.namePlaceholder')} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('priceLists.baseLabel')}</label>
              <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
                <button type="button" onClick={() => setDraft(d => ({ ...d, base: 'selling' }))} className={segCls(draft.base === 'selling')}>{t('priceLists.base.selling')}</button>
                <button type="button" onClick={() => setDraft(d => ({ ...d, base: 'purchase' }))} className={segCls(draft.base === 'purchase')}>{t('priceLists.base.purchase')}</button>
              </div>
            </div>
            <div>
              <label className={labelCls}>{t('priceLists.adjust')}</label>
              <div className="relative">
                <input inputMode="decimal" value={draft.adjust} onChange={e => setDraft(d => ({ ...d, adjust: e.target.value.replace(/[^\d.,-]/g, '') }))} className={cn(inputCls, 'pr-8')} />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
              </div>
              <p className="mt-1 text-[12px] text-gray-400 dark:text-gray-500">{t('priceLists.adjustHint')}</p>
            </div>
            <div>
              <label className={labelCls}>{t('priceLists.rounding')}</label>
              <div className="inline-flex rounded-lg bg-gray-100 dark:bg-gray-800 p-0.5">
                {ROUNDING_OPTIONS.map(r => (
                  <button key={r} type="button" onClick={() => setDraft(d => ({ ...d, rounding: r }))} className={segCls(draft.rounding === r)}>
                    {r === 0 ? t('priceLists.noRounding') : new Intl.NumberFormat('ru-RU').format(r)}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={draft.isActive} onChange={e => setDraft(d => ({ ...d, isActive: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" />
              {t('priceLists.active')}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveDraft} disabled={saving} className="bg-slate-900 hover:bg-slate-800 text-white">{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('priceLists.deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('priceLists.deleteConfirm')}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={deleteActive} className="bg-red-600 hover:bg-red-700 text-white">{t('priceLists.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
