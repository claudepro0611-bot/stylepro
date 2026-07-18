'use client'

import { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SearchSelect } from '@/components/ui/SearchSelect'
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
  onOpenChange: (open: boolean) => void
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

export function PromotionPanel({
  open, onOpenChange, promotion, products, productSizesByProduct, sizeIdToProductId, groups, onSaved,
}: PromotionPanelProps) {
  const { t } = useLanguage()
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [loadingSelection, setLoadingSelection] = useState(false)

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

  const availableProducts = products.filter(p => !form.selectedProductIds.includes(p.id))

  function addProduct(id: string) {
    setForm(f => ({ ...f, selectedProductIds: [...f.selectedProductIds, id] }))
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
    onOpenChange(false)
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{promotion ? t('marketing.aksiya.panel.editTitle') : t('marketing.aksiya.panel.createTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 mt-2 max-h-[70vh] overflow-y-auto pr-1">
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
            <div className="grid grid-cols-3 gap-2">
              {SCOPE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={form.scopeType === opt.value}
                  onClick={() => setForm(f => ({ ...f, scopeType: opt.value }))}
                  className={cn(
                    'rounded-lg border px-2 py-2 text-center text-[12px] font-medium transition-colors',
                    form.scopeType === opt.value
                      ? 'bg-white dark:bg-gray-900 shadow-sm border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                      : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800',
                  )}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {form.scopeType === 'product' && (
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('marketing.aksiya.panel.products')}</label>
              <SearchSelect
                options={availableProducts.map(p => ({ value: p.id, label: p.name, sublabel: p.category }))}
                value=""
                onChange={addProduct}
                placeholder={t('marketing.aksiya.panel.productsSearchPlaceholder')}
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {loadingSelection ? (
                  <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
                ) : form.selectedProductIds.length === 0 ? (
                  <span className="text-[12px] text-gray-400 dark:text-gray-500">{t('marketing.aksiya.panel.productsEmpty')}</span>
                ) : form.selectedProductIds.map(id => {
                  const p = products.find(pr => pr.id === id)
                  return (
                    <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-800 pl-3 pr-1.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
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

          <div className="grid grid-cols-2 gap-3">
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
            <div className="flex items-center justify-between pt-5">
              <label className="text-[13px] font-medium text-gray-700 dark:text-gray-300">{t('marketing.aksiya.panel.active')}</label>
              <Switch checked={form.isActive} onCheckedChange={checked => setForm(f => ({ ...f, isActive: checked }))} />
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
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
