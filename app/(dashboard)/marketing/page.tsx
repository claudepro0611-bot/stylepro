'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PromotionPanel, type PromotionProductLite, type PromotionGroupLite } from '@/components/marketing/PromotionPanel'
import { createClient } from '@/lib/supabase/client'
import { useFeatures } from '@/lib/features'
import { formatDate } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { Promotion } from '@/lib/types'

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

  function formatPromotionRange(p: Promotion): string {
    if (!p.startsOn && !p.endsOn) return t('marketing.aksiya.noDate')
    const start = p.startsOn ? formatDate(p.startsOn) : t('marketing.aksiya.noDate')
    const end = p.endsOn ? formatDate(p.endsOn) : t('marketing.aksiya.noDate')
    return `${start} – ${end}`
  }

  if (featuresLoading || !features.marketing) return null

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('marketing.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('marketing.subtitle')}</p>
        </div>
      </div>

      {/* Aksiyalar (promotions) — two-column: list table left, fixed
          380px inline create/edit panel right (not a Dialog/modal), per
          the approved layout. Blue accents here (button, badges, radio
          rows in the panel) are an explicit, approved deviation from the
          rest of the app's monochrome Floxen convention — flagged in the
          task report, not a silent drift from the design system. */}
      <div className="flex items-stretch rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
            <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">{t('marketing.aksiya.sectionTitle')}</p>
            <button
              onClick={openCreatePromotion}
              className="flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-3.5 py-2 text-[13px] font-medium text-white transition-colors"
            >
              {t('marketing.aksiya.addNew')}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr className="border-b border-gray-100 dark:border-gray-800">
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.name')}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.scope')}</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.discount')}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.period')}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('marketing.aksiya.table.status')}</th>
                </tr>
              </thead>
              <tbody>
                {promotionsLoading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                      <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                      {t('common.loading')}
                    </td>
                  </tr>
                ) : promotions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                      {t('marketing.aksiya.notFound')}
                    </td>
                  </tr>
                ) : promotions.map(p => {
                  const active = isPromotionCurrentlyActive(p)
                  return (
                    <tr
                      key={p.id}
                      onClick={() => openEditPromotion(p)}
                      className={`group border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer ${active ? '' : 'opacity-60'}`}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{p.name}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{scopeSummary(p)}</td>
                      <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{p.discountPercent}%</td>
                      <td className="px-4 py-3 text-[12px] text-gray-400 dark:text-gray-500">{formatPromotionRange(p)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <MiniBadge status={active ? 'active' : 'ended'} />
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); setDeleteTarget(p) }}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 dark:hover:text-red-400 transition-opacity"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {isPromotionPanelOpen && (
          <PromotionPanel
            open={isPromotionPanelOpen}
            onClose={() => setIsPromotionPanelOpen(false)}
            promotion={editingPromotion}
            products={productLites}
            productSizesByProduct={productSizesByProduct}
            sizeIdToProductId={sizeIdToProductId}
            groups={groupLites}
            onSaved={fetchPromotions}
          />
        )}
      </div>

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
