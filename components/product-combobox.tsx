'use client'

import { useMemo } from 'react'
import { Loader2, Package } from 'lucide-react'
import {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxIcon,
  ComboboxInputGroup,
  ComboboxInput,
  ComboboxPopup,
  ComboboxList,
  ComboboxEmpty,
  ComboboxStatus,
  ComboboxItem,
} from '@/components/ui/combobox'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'
import type { Product } from '@/lib/types'

interface ProductOption {
  value: string
  label: string
  sku: string
}

export interface ProductComboboxProps {
  /** Products to choose from — caller owns fetching/filtering (e.g. by warehouse). */
  products: Pick<Product, 'id' | 'name' | 'sku'>[]
  /** Selected product id, or '' for none. */
  value: string
  onChange: (productId: string) => void
  label?: string
  placeholder?: string
  /** Shown while the caller is still fetching `products`. */
  loading?: boolean
  /** Validation/error message rendered below the field. */
  error?: string
  className?: string
}

export function ProductCombobox({
  products, value, onChange, label, placeholder, loading, error, className,
}: ProductComboboxProps) {
  const { t } = useLanguage()

  const options = useMemo<ProductOption[]>(
    () => products.map(p => ({ value: p.id, label: p.name, sku: p.sku ?? '' })),
    [products],
  )
  const selected = useMemo(() => options.find(o => o.value === value) ?? null, [options, value])

  return (
    <div className={className}>
      {label && (
        <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">
          {label}
        </label>
      )}

      <Combobox
        items={options}
        value={selected}
        onValueChange={item => onChange(item ? (item as ProductOption).value : '')}
        isItemEqualToValue={(a: ProductOption, b: ProductOption) => a.value === b.value}
        filter={(item: ProductOption, query: string) => {
          const q = query.trim().toLowerCase()
          if (!q) return true
          return item.label.toLowerCase().includes(q) || item.sku.toLowerCase().includes(q)
        }}
        modal={false}
        disabled={loading}
        defaultOpen
      >
        <ComboboxTrigger
          aria-invalid={!!error}
          className={error ? 'border-red-300 focus:border-red-400 focus:ring-red-100 dark:border-red-900' : undefined}
        >
          <ComboboxValue placeholder={placeholder ?? t('kirim.modal.selectProductPlaceholder')}>
            {(item: ProductOption | null) => (
              <span className={cn('flex-1 truncate text-left', !item && 'text-gray-400 dark:text-gray-500')}>
                {item ? item.label : (placeholder ?? t('kirim.modal.selectProductPlaceholder'))}
              </span>
            )}
          </ComboboxValue>
          {loading ? <Loader2 className="size-4 shrink-0 animate-spin text-gray-400" /> : <ComboboxIcon />}
        </ComboboxTrigger>

        <ComboboxPopup>
          <div className="border-b border-gray-100 p-1.5 dark:border-gray-800">
            <ComboboxInputGroup>
              <ComboboxInput autoFocus placeholder={t('common.searchPlaceholder')} />
            </ComboboxInputGroup>
          </div>

          {loading ? (
            <ComboboxStatus className="flex items-center justify-center gap-2 py-6">
              <Loader2 className="size-3.5 animate-spin" />
              {t('common.loading')}
            </ComboboxStatus>
          ) : (
            <>
              <ComboboxEmpty>{t('kirim.modal.productNotFound')}</ComboboxEmpty>
              <ComboboxList>
                {(item: ProductOption) => (
                  <ComboboxItem key={item.value} value={item}>
                    <Package className="size-3.5 shrink-0 text-gray-300 dark:text-gray-600" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.sku && (
                      <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{item.sku}</span>
                    )}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </>
          )}
        </ComboboxPopup>
      </Combobox>

      {error && <p className="mt-1.5 text-[12px] text-red-500 dark:text-red-400">{error}</p>}
    </div>
  )
}
