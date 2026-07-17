'use client'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL']

function compareSizes(a: string, b: string): number {
  const ai = SIZE_ORDER.indexOf(a.trim().toUpperCase())
  const bi = SIZE_ORDER.indexOf(b.trim().toUpperCase())
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  }
  const an = Number(a)
  const bn = Number(b)
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn
  return a.localeCompare(b)
}

export interface MatrixVariant {
  id: string
  size: string
  color: string
  stock: number
}

interface VariantMatrixModalProps {
  productName: string
  variants: MatrixVariant[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (variantId: string) => void
}

export function VariantMatrixModal({ productName, variants, open, onOpenChange, onSelect }: VariantMatrixModalProps) {
  const { t } = useLanguage()

  // Phase 5: color is now a real tracked dimension on product_sizes, so
  // every cell below is that exact row's own stock — no more decorative
  // color guessing/duplication across rows.
  const uniqueSizes = Array.from(new Set(variants.map(v => v.size))).sort(compareSizes)
  const uniqueColors = Array.from(new Set(variants.map(v => v.color))).sort((a, b) => a.localeCompare(b))
  const variantMap = new Map(variants.map(v => [`${v.color}::${v.size}`, v]))

  function getVariant(color: string, size: string): MatrixVariant | undefined {
    return variantMap.get(`${color}::${size}`)
  }

  function selectVariant(v: MatrixVariant | undefined) {
    if (!v || v.stock <= 0) return
    onSelect(v.id)
    onOpenChange(false)
  }

  function colorLabel(color: string): string {
    return color || t('kirim.matrix.defaultColor')
  }

  function cellCls(stock: number) {
    return cn(
      'flex h-11 min-w-[3.5rem] items-center justify-center rounded-lg border px-2 text-sm font-medium tabular-nums transition-colors',
      stock > 0
        ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 hover:border-gray-400 dark:hover:border-gray-500 cursor-pointer'
        : 'border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-gray-300 dark:text-gray-600 cursor-not-allowed',
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{productName}</DialogTitle>
        </DialogHeader>

        <div className="mt-2 overflow-x-auto">
          {uniqueSizes.length === 0 ? null : uniqueColors.length <= 1 ? (
            // Single (or no) color: flat row of size buttons.
            <div className="flex flex-wrap gap-2">
              {uniqueSizes.map(size => {
                const v = getVariant(uniqueColors[0] ?? '', size)
                const stock = v?.stock ?? 0
                return (
                  <button
                    key={size}
                    type="button"
                    disabled={stock <= 0}
                    title={stock <= 0 ? t('pos.variantModal.outOfStock') : undefined}
                    onClick={() => selectVariant(v)}
                    className={cellCls(stock)}
                  >
                    <span className="flex flex-col items-center leading-tight">
                      <span>{size}</span>
                      <span className="text-[11px] font-normal opacity-70">{stock}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ) : uniqueSizes.length <= 1 ? (
            // Single size, multiple colors: flat row of color buttons.
            <div className="flex flex-wrap gap-2">
              {uniqueColors.map(color => {
                const v = getVariant(color, uniqueSizes[0])
                const stock = v?.stock ?? 0
                return (
                  <button
                    key={color || '__default__'}
                    type="button"
                    disabled={stock <= 0}
                    title={stock <= 0 ? t('pos.variantModal.outOfStock') : undefined}
                    onClick={() => selectVariant(v)}
                    className={cellCls(stock)}
                  >
                    <span className="flex flex-col items-center leading-tight">
                      <span>{colorLabel(color)}</span>
                      <span className="text-[11px] font-normal opacity-70">{stock}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            // Full matrix: rows = colors, columns = sizes.
            <table className="border-separate border-spacing-1.5">
              <thead>
                <tr>
                  <th className="w-0" />
                  {uniqueSizes.map(size => (
                    <th key={size} className="px-1 pb-1 text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {size}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {uniqueColors.map(color => (
                  <tr key={color || '__default__'}>
                    <th scope="row" className="pr-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {colorLabel(color)}
                    </th>
                    {uniqueSizes.map(size => {
                      const v = getVariant(color, size)
                      const stock = v?.stock ?? 0
                      return (
                        <td key={size}>
                          <button
                            type="button"
                            disabled={stock <= 0}
                            title={stock <= 0 ? t('pos.variantModal.outOfStock') : undefined}
                            onClick={() => selectVariant(v)}
                            className={cellCls(stock)}
                          >
                            {stock}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
