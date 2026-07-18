'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, RefreshCw, Percent, Calendar, Activity, Edit2, Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PromotionPanel, type PromotionProductLite, type PromotionGroupLite } from '@/components/marketing/PromotionPanel'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { useFeatures } from '@/lib/features'
import { formatDate } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { Campaign, Coupon, Promotion } from '@/lib/types'

const emptyForm = {
  name: '', type: 'discount' as Campaign['type'],
  discount: '', startDate: '', endDate: '',
  usageLimit: '', couponCode: '',
}

function genCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase()
}

const TYPE_LABEL_KEY: Record<string, TranslationKey> = {
  coupon: 'marketing.typeLabel.coupon', discount: 'marketing.typeLabel.discount', promo: 'marketing.typeLabel.promo',
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900 transition-colors'

interface CampaignRow {
  id: string
  name: string
  type: Campaign['type']
  status: Campaign['status']
  discount: number
  start_date: string
  end_date: string
  usage_count: number
  usage_limit: number
}

function mapCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    discount: Number(row.discount),
    startDate: row.start_date,
    endDate: row.end_date,
    usageCount: row.usage_count,
    usageLimit: row.usage_limit,
  }
}

interface CouponRow {
  id: string
  code: string
  discount: number
  usage_limit: number
  used_count: number
  expiry_date: string
  status: Coupon['status']
}

function mapCoupon(row: CouponRow): Coupon {
  return {
    id: row.id,
    code: row.code,
    discount: Number(row.discount),
    usageLimit: row.usage_limit,
    usedCount: row.used_count,
    expiryDate: row.expiry_date,
    status: row.status,
  }
}

interface PromotionRow {
  id: string
  name: string
  discount_percent: number
  scope_type: Promotion['scopeType']
  category: string | null
  starts_on: string | null
  ends_on: string | null
  is_active: boolean
}

function mapPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    name: row.name,
    discountPercent: Number(row.discount_percent),
    scopeType: row.scope_type,
    category: row.category,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    isActive: row.is_active,
  }
}

interface ProductLiteRow { id: string; name: string; category: string | null }
interface ProductSizeLiteRow { id: string; product_id: string }
interface GroupLiteRow { id: string; name: string; status: string }

function isPromotionCurrentlyActive(p: Promotion): boolean {
  if (!p.isActive) return false
  const today = new Date().toISOString().slice(0, 10)
  if (p.startsOn && p.startsOn > today) return false
  if (p.endsOn && p.endsOn < today) return false
  return true
}

export default function MarketingPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const { features, loading: featuresLoading } = useFeatures()

  useEffect(() => {
    if (!featuresLoading && !features.marketing) router.push('/dashboard')
  }, [featuresLoading, features, router])

  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data: campaignRows, error: campaignsError }, { data: couponRows, error: couponsError }] = await Promise.all([
      supabase.from('campaigns').select('*').order('created_at', { ascending: false }),
      supabase.from('coupons').select('*').order('created_at', { ascending: false }),
    ])
    if (campaignsError || couponsError) {
      toast.error(t('common.error'))
    } else {
      setCampaigns((campaignRows as CampaignRow[]).map(mapCampaign))
      setCoupons((couponRows as CouponRow[]).map(mapCoupon))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [promotionProductCounts, setPromotionProductCounts] = useState<Record<string, number>>({})
  const [promotionsLoading, setPromotionsLoading] = useState(true)
  const [productLites, setProductLites] = useState<PromotionProductLite[]>([])
  const [productSizesByProduct, setProductSizesByProduct] = useState<Map<string, string[]>>(new Map())
  const [sizeIdToProductId, setSizeIdToProductId] = useState<Map<string, string>>(new Map())
  const [groupLites, setGroupLites] = useState<PromotionGroupLite[]>([])
  const [isPromotionPanelOpen, setIsPromotionPanelOpen] = useState(false)
  const [editingPromotion, setEditingPromotion] = useState<Promotion | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Promotion | null>(null)
  const [deletingPromotion, setDeletingPromotion] = useState(false)

  const fetchPromotions = useCallback(async () => {
    setPromotionsLoading(true)
    const supabase = createClient()
    const [{ data: promoRows, error: promoError }, { data: ppRows, error: ppError }] = await Promise.all([
      supabase.from('promotions').select('*').order('created_at', { ascending: false }),
      supabase.from('promotion_products').select('promotion_id'),
    ])
    if (promoError || ppError) {
      toast.error(t('common.error'))
    } else {
      setPromotions((promoRows as PromotionRow[]).map(mapPromotion))
      const counts: Record<string, number> = {}
      for (const r of (ppRows as { promotion_id: string }[])) {
        counts[r.promotion_id] = (counts[r.promotion_id] ?? 0) + 1
      }
      setPromotionProductCounts(counts)
    }
    setPromotionsLoading(false)
  }, [t])

  // Product/variant/group catalog used by the create/edit panel — same
  // read-only direct-select pattern as pos/page.tsx and mahsulotlar/page.tsx
  // (product_sizes.id is the unit promotion_products actually targets, so a
  // product->size-id lookup map is built alongside the plain product list).
  const fetchCatalog = useCallback(async () => {
    const supabase = createClient()
    const [{ data: productRows }, { data: sizeRows }, { data: groupRows }] = await Promise.all([
      supabase.from('products').select('id, name, category').eq('status', 'active').order('name'),
      supabase.from('product_sizes').select('id, product_id'),
      supabase.from('product_groups').select('id, name, status').eq('status', 'active').order('name'),
    ])
    setProductLites((productRows as ProductLiteRow[] ?? []).map(r => ({ id: r.id, name: r.name, category: r.category ?? '' })))
    const bySize = new Map<string, string[]>()
    const sizeToProduct = new Map<string, string>()
    for (const r of (sizeRows as ProductSizeLiteRow[] ?? [])) {
      sizeToProduct.set(r.id, r.product_id)
      const arr = bySize.get(r.product_id) ?? []
      arr.push(r.id)
      bySize.set(r.product_id, arr)
    }
    setProductSizesByProduct(bySize)
    setSizeIdToProductId(sizeToProduct)
    setGroupLites((groupRows as GroupLiteRow[] ?? []).map(r => ({ id: r.id, name: r.name })))
  }, [])

  useEffect(() => {
    fetchPromotions()
    fetchCatalog()
  }, [fetchPromotions, fetchCatalog])

  function openCreatePromotion() {
    setEditingPromotion(null)
    setIsPromotionPanelOpen(true)
  }

  function openEditPromotion(p: Promotion) {
    setEditingPromotion(p)
    setIsPromotionPanelOpen(true)
  }

  async function executeDeletePromotion() {
    if (!deleteTarget) return
    setDeletingPromotion(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_promotion', { p_id: deleteTarget.id })
    setDeletingPromotion(false)
    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    toast.success(t('marketing.aksiya.toasts.deleteSuccess'))
    setDeleteTarget(null)
    fetchPromotions()
  }

  function scopeSummary(p: Promotion): string {
    if (p.scopeType === 'store') return t('marketing.aksiya.scopeLabel.store')
    if (p.scopeType === 'category') return `${t('marketing.aksiya.scopeLabel.category')}: ${p.category ?? ''}`
    return `${t('marketing.aksiya.scopeLabel.product')} (${promotionProductCounts[p.id] ?? 0})`
  }

  function formatDateOrDash(value: string | null): string {
    return value ? formatDate(value) : t('marketing.aksiya.noDate')
  }

  if (featuresLoading || !features.marketing) return null

  const activeCampaigns = campaigns.filter(c => c.status === 'active')

  async function saveCampaign() {
    if (!form.name.trim() || !form.discount || !form.startDate || !form.endDate) {
      toast.error(t('marketing.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setSaving(false); toast.error(t('common.error')); return }
    const { error: campaignError } = await supabase.from('campaigns').insert({
      company_id: companyId,
      name: form.name,
      type: form.type,
      status: 'inactive',
      discount: Number(form.discount),
      start_date: form.startDate,
      end_date: form.endDate,
      usage_count: 0,
      usage_limit: Number(form.usageLimit || 100),
    })
    if (campaignError) {
      setSaving(false)
      toast.error(t('common.error'))
      return
    }
    if (form.couponCode && form.type === 'coupon') {
      const { error: couponError } = await supabase.from('coupons').insert({
        company_id: companyId,
        code: form.couponCode,
        discount: Number(form.discount),
        usage_limit: Number(form.usageLimit || 100),
        used_count: 0,
        expiry_date: form.endDate,
        status: 'inactive',
      })
      if (couponError) {
        setSaving(false)
        toast.error(t('common.error'))
        return
      }
    }
    setSaving(false)
    setForm(emptyForm)
    setIsAddOpen(false)
    toast.success(t('marketing.toasts.createSuccess'))
    fetchData()
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('marketing.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('marketing.subtitle')}</p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('marketing.addNew')}
        </button>
      </div>

      {/* Aksiyalar (promotions) */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('marketing.aksiya.sectionTitle')}</p>
          <button
            onClick={openCreatePromotion}
            className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('marketing.aksiya.addNew')}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.name')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.scope')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.discount')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.start')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.end')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.status')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {promotionsLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : promotions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('marketing.aksiya.notFound')}
                  </td>
                </tr>
              ) : promotions.map((p, i) => (
                <tr key={p.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/50' : ''}`}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{scopeSummary(p)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
                      <Percent className="h-3 w-3 text-gray-400 dark:text-gray-500" />
                      {p.discountPercent}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-gray-400 dark:text-gray-500">{formatDateOrDash(p.startsOn)}</td>
                  <td className="px-4 py-3 text-[12px] text-gray-400 dark:text-gray-500">{formatDateOrDash(p.endsOn)}</td>
                  <td className="px-4 py-3">
                    <MiniBadge status={isPromotionCurrentlyActive(p) ? 'active' : 'ended'} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={() => openEditPromotion(p)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(p)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Active campaign cards */}
      {activeCampaigns.length > 0 && (
        <div>
          <p className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-3">{t('marketing.active')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {activeCampaigns.map(c => {
              const pct = Math.min(Math.round((c.usageCount / c.usageLimit) * 100), 100)
              return (
                <div key={c.id} className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5 space-y-4 transition-colors duration-200">
                  {/* Card header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{c.name}</p>
                      <p className="text-[12px] text-gray-400 dark:text-gray-500 mt-0.5">{t(TYPE_LABEL_KEY[c.type])}</p>
                    </div>
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-bold tabular-nums">
                      {c.discount}%
                    </div>
                  </div>

                  {/* Meta row */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
                      <div>
                        <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-none">{t('marketing.start')}</p>
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mt-0.5">{formatDate(c.startDate)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
                      <div>
                        <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-none">{t('marketing.end')}</p>
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mt-0.5">{formatDate(c.endDate)}</p>
                      </div>
                    </div>
                  </div>

                  {/* Usage progress */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <Activity className="h-3 w-3 text-gray-400 dark:text-gray-500" />
                        <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('marketing.usage')}</span>
                      </div>
                      <span className="text-[11px] font-medium text-gray-700 dark:text-gray-300 tabular-nums">
                        {c.usageCount} / {c.usageLimit}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gray-900 dark:bg-gray-100 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1 text-right">{pct}%</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* All campaigns table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('marketing.allCampaigns')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.table.campaign')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.table.type')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.table.discount')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.table.period')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.table.usage')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.table.status')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : campaigns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('common.notFound')}
                  </td>
                </tr>
              ) : campaigns.map((c, i) => (
                <tr key={c.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/50' : ''}`}>
                  <td className="w-10 px-4 py-3">
                    <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{c.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t(TYPE_LABEL_KEY[c.type])}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
                      <Percent className="h-3 w-3 text-gray-400 dark:text-gray-500" />
                      {c.discount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-gray-400 dark:text-gray-500">
                    {formatDate(c.startDate)} — {formatDate(c.endDate)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-600 dark:text-gray-300">
                    {c.usageCount} / {c.usageLimit}
                  </td>
                  <td className="px-4 py-3">
                    <MiniBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Coupons table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('marketing.coupons.title')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.coupons.code')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.coupons.discount')}</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.coupons.usage')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.coupons.expiry')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.coupons.status')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : coupons.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('common.notFound')}
                  </td>
                </tr>
              ) : coupons.map((c, i) => (
                <tr key={c.id} className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/50' : ''}`}>
                  <td className="w-10 px-4 py-3">
                    <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                  </td>
                  <td className="px-4 py-3">
                    <code className="rounded-md bg-gray-100 dark:bg-gray-800 px-2 py-1 font-mono text-[13px] font-semibold text-gray-800 dark:text-gray-200 tracking-wider">
                      {c.code}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
                      <Percent className="h-3 w-3 text-gray-400 dark:text-gray-500" />
                      {c.discount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-600 dark:text-gray-300">
                    {c.usedCount} / {c.usageLimit}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{formatDate(c.expiryDate)}</td>
                  <td className="px-4 py-3">
                    <MiniBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Campaign Modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('marketing.modal.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.modal.name')}</label>
              <input
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                className={inputCls}
                placeholder={t('marketing.modal.namePlaceholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.modal.type')}</label>
                <select
                  value={form.type}
                  onChange={e => setForm(p => ({ ...p, type: e.target.value as Campaign['type'] }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
                >
                  <option value="discount">{t('marketing.typeLabel.discount')}</option>
                  <option value="coupon">{t('marketing.typeLabel.coupon')}</option>
                  <option value="promo">{t('marketing.typeLabel.promo')}</option>
                </select>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.modal.discount')}</label>
                <input
                  type="number" min="1" max="100"
                  value={form.discount}
                  onChange={e => setForm(p => ({ ...p, discount: e.target.value }))}
                  className={inputCls}
                  placeholder={t('marketing.modal.discountPlaceholder')}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.modal.start')}</label>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={e => setForm(p => ({ ...p, startDate: e.target.value }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.modal.end')}</label>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={e => setForm(p => ({ ...p, endDate: e.target.value }))}
                  className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
                />
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.modal.usageLimit')}</label>
              <input
                type="number"
                value={form.usageLimit}
                onChange={e => setForm(p => ({ ...p, usageLimit: e.target.value }))}
                className={inputCls}
                placeholder={t('marketing.modal.usageLimitPlaceholder')}
              />
            </div>
            {form.type === 'coupon' && (
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.modal.couponCode')}</label>
                <div className="flex gap-2">
                  <input
                    value={form.couponCode}
                    onChange={e => setForm(p => ({ ...p, couponCode: e.target.value.toUpperCase() }))}
                    className="flex-1 h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900 transition-colors"
                    placeholder={t('marketing.modal.couponCodePlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={() => setForm(p => ({ ...p, couponCode: genCode() }))}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-[13px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('marketing.modal.generate')}
                  </button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button onClick={saveCampaign} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('marketing.modal.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/edit promotion panel */}
      <PromotionPanel
        open={isPromotionPanelOpen}
        onOpenChange={setIsPromotionPanelOpen}
        promotion={editingPromotion}
        products={productLites}
        productSizesByProduct={productSizesByProduct}
        sizeIdToProductId={sizeIdToProductId}
        groups={groupLites}
        onSaved={fetchPromotions}
      />

      {/* Delete promotion confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('marketing.aksiya.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('marketing.aksiya.deleteConfirm')}</p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDeletePromotion} disabled={deletingPromotion}>
              {deletingPromotion ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
