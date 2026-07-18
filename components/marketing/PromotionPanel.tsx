'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { Promotion } from '@/lib/types'

export interface PromotionProductLite {
  id: string
  name: string
  category: string
}

export interface PromotionGroupLite {
  id: string
  name: string
}

type ScopeType = Promotion['scopeType']

interface PromotionProductRow {
  product_size_id: string
}

interface PromotionPanelProps {
  open: boolean
  onClose: () => void
  promotion: Promotion | null
  products: PromotionProductLite[]
  productSizesByProduct: Map<string, string[]>
  sizeIdToProductId: Map<string, string>
  groups: PromotionGroupLite[]
  onSaved: () => void
}

const emptyForm = {
  name: '',
  scopeType: 'product' as ScopeType,
  selectedProductIds: [] as string[],
  category: '',
  discountPercent: '',
  startsOn: '',
  endsOn: '',
  isActive: true,
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900 transition-colors'

const SCOPE_OPTIONS: { value: ScopeType; labelKey: TranslationKey }[] = [
  { value: 'product', labelKey: 'marketing.aksiya.scopeLabel.product' },
  { value: 'category', labelKey: 'marketing.aksiya.scopeLabel.category' },
  { value: 'store', labelKey: 'marketing.aksiya.scopeLabel.store' },
]

// Fixed-width inline panel (not a Dialog/modal) per the approved mockup —
// sits beside the promotions table, not floating above it.
export function PromotionPanel({
  open, onClose, promotion, products, productSizesByProduct, sizeIdToProductId, groups, onSaved,
}: PromotionPanelProps) {
  const { t } = useLanguage()
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [loadingSelection, setLoadingSelection] = useState(false)
  const [productSearchOpen, setProductSearchOpen] = useState(false)
  const [productSearchQuery, setProductSearchQuery] = useState('')
  const productSearchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    if (!promotion) {
      setForm(emptyForm)
      return
    }
    setForm({
      name: promotion.name,
      scopeType: promotion.scopeType,
      selectedProductIds: [],
      category: promotion.category ?? '',
      discountPercent: String(promotion.discountPercent),
      startsOn: promotion.startsOn ?? '',
      endsOn: promotion.endsOn ?? '',
      isActive: promotion.isActive,
    })
    if (promotion.scopeType === 'product') {
      setLoadingSelection(true)
      const supabase = createClient()
      supabase
        .from('promotion_products')
        .select('product_size_id')
        .eq('promotion_id', promotion.id)
        .then(({ data }) => {
          const sizeIds = (data as PromotionProductRow[] | null ?? []).map(r => r.product_size_id)
          const productIds = Array.from(new Set(
            sizeIds.map(id => sizeIdToProductId.get(id)).filter((x): x is string => !!x),
          ))
          setForm(f => ({ ...f, selectedProductIds: productIds }))
          setLoadingSelection(false)
        })
    }
  }, [open, promotion, sizeIdToProductId])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (productSearchRef.current && !productSearchRef.current.contains(e.target as Node)) {
        setProductSearchOpen(false)
        setProductSearchQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!open) return null

  const availableProducts = products
    .filter(p => !form.selectedProductIds.includes(p.id))
    .filter(p => p.name.toLowerCase().includes(productSearchQuery.toLowerCase()))

  function addProduct(id: string) {
    setForm(f => ({ ...f, selectedProductIds: [...f.selectedProductIds, id] }))
    setProductSearchOpen(false)
    setProductSearchQuery('')
  }
  function removeProduct(id: string) {
    setForm(f => ({ ...f, selectedProductIds: f.selectedProductIds.filter(x => x !== id) }))
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error(t('marketing.aksiya.toasts.requiredError')); return }
    const discount = Number(form.discountPercent)
    if (form.discountPercent === '' || Number.isNaN(discount) || discount < 0 || discount > 100) {
      toast.error(t('marketing.aksiya.toasts.requiredError'))
      return
    }
    if (form.scopeType === 'product' && form.selectedProductIds.length === 0) {
      toast.error(t('marketing.aksiya.toasts.requiredError'))
      return
    }
    if (form.scopeType === 'category' && !form.category) {
      toast.error(t('marketing.aksiya.toasts.requiredError'))
      return
    }

    // sell_cart/promotion_products key on product_size_id, not product_id —
    // expand each selected product into every one of its variants.
    const productSizeIds = form.scopeType === 'product'
      ? form.selectedProductIds.flatMap(pid => productSizesByProduct.get(pid) ?? [])
      : []

    setSaving(true)
    const supabase = createClient()
    const { error } = promotion
      ? await supabase.rpc('update_promotion', {
          p_id: promotion.id,
          p_name: form.name.trim(),
          p_discount_percent: discount,
          p_scope_type: form.scopeType,
          p_category: form.scopeType === 'category' ? form.category : null,
          p_starts_on: form.startsOn || null,
          p_ends_on: form.endsOn || null,
          p_is_active: form.isActive,
          p_product_size_ids: productSizeIds,
        })
      : await supabase.rpc('create_promotion', {
          p_name: form.name.trim(),
          p_discount_percent: discount,
          p_scope_type: form.scopeType,
          p_category: form.scopeType === 'category' ? form.category : null,
          p_starts_on: form.startsOn || null,
          p_ends_on: form.endsOn || null,
          p_product_size_ids: productSizeIds,
        })
    setSaving(false)
    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    toast.success(promotion ? t('marketing.aksiya.toasts.updateSuccess') : t('marketing.aksiya.toasts.createSuccess'))
    onSaved()
    onClose()
  }

  return (
    <div className="w-[380px] shrink-0 border-l border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 overflow-y-auto">
      <div>
        <p className="font-semibold text-slate-800 dark:text-gray-100">
          {promotion ? t('marketing.aksiya.panel.editTitle') : t('marketing.aksiya.panel.createTitle')}
        </p>
        <p className="text-xs text-slate-400 dark:text-gray-500 mt-0.5">{t('marketing.aksiya.panel.subtitle')}</p>
      </div>

      <div className="space-y-3 mt-4">
        <div>
          <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.aksiya.panel.name')}</label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className={inputCls}
            placeholder={t('marketing.aksiya.panel.namePlaceholder')}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.aksiya.panel.scopeType')}</label>
          <div className="space-y-2">
            {SCOPE_OPTIONS.map(opt => {
              const selected = form.scopeType === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setForm(f => ({ ...f, scopeType: opt.value }))}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left transition-colors',
                    selected
                      ? 'border-[1.5px] border-blue-500 dark:border-blue-500 bg-blue-50/40 dark:bg-blue-950/20'
                      : 'border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-3.5 w-3.5 shrink-0 rounded-full',
                      selected ? 'border-4 border-blue-600 dark:border-blue-500' : 'border-2 border-slate-300 dark:border-gray-600',
                    )}
                  />
                  <span className={cn('text-[13px]', selected ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300')}>
                    {t(opt.labelKey)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {form.scopeType === 'product' && (
          <div>
            <div className="flex flex-wrap gap-1.5">
              {loadingSelection ? (
                <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
              ) : (
                <>
                  {form.selectedProductIds.length === 0 && (
                    <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('marketing.aksiya.panel.productsEmpty')}</span>
                  )}
                  {form.selectedProductIds.map(id => {
                    const p = products.find(pr => pr.id === id)
                    return (
                      <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-gray-800 pl-3 pr-1.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                        {p?.name ?? id}
                        <button
                          type="button"
                          onClick={() => removeProduct(id)}
                          className="flex h-4 w-4 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    )
                  })}
                  <div className="relative" ref={productSearchRef}>
                    <button
                      type="button"
                      onClick={() => setProductSearchOpen(o => !o)}
                      className="inline-flex items-center rounded-full border border-dashed border-gray-300 dark:border-gray-600 px-3 py-1 text-[12px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      {t('marketing.aksiya.panel.addChip')}
                    </button>
                    {productSearchOpen && (
                      <div className="absolute z-30 mt-1.5 w-56 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 shadow-lg">
                        <input
                          autoFocus
                          value={productSearchQuery}
                          onChange={e => setProductSearchQuery(e.target.value)}
                          placeholder={t('marketing.aksiya.panel.productsSearchPlaceholder')}
                          className="h-8 w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-[13px] text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-600 transition-colors"
                        />
                        <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
                          {availableProducts.length === 0 ? (
                            <p className="px-2 py-3 text-center text-[12px] text-gray-400 dark:text-gray-500">{t('common.notFound')}</p>
                          ) : availableProducts.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => addProduct(p.id)}
                              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                            >
                              <span className="truncate">{p.name}</span>
                              {p.category && <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{p.category}</span>}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {form.scopeType === 'category' && (
          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.aksiya.panel.group')}</label>
            <select
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
            >
              <option value="">{t('marketing.aksiya.panel.groupPlaceholder')}</option>
              {groups.map(g => (
                <option key={g.id} value={g.name}>{g.name}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.aksiya.panel.discount')}</label>
          <div className="relative">
            <input
              type="number" min={0} max={100}
              value={form.discountPercent}
              onChange={e => setForm(f => ({ ...f, discountPercent: e.target.value }))}
              className={cn(inputCls, 'pr-7')}
              placeholder={t('marketing.aksiya.panel.discountPlaceholder')}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 dark:text-gray-500 pointer-events-none">%</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.aksiya.panel.start')}</label>
            <input
              type="date"
              value={form.startsOn}
              onChange={e => setForm(f => ({ ...f, startsOn: e.target.value }))}
              className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.aksiya.panel.end')}</label>
            <input
              type="date"
              value={form.endsOn}
              onChange={e => setForm(f => ({ ...f, endsOn: e.target.value }))}
              className="w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900"
            />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <label className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('marketing.aksiya.panel.active')}</label>
          <Switch checked={form.isActive} onCheckedChange={checked => setForm(f => ({ ...f, isActive: checked }))} />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium text-white transition-colors disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('common.save')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-9 shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 px-4 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            {t('marketing.aksiya.panel.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
