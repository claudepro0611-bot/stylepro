'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { parseVolume, sortSizes } from '@/lib/sizes'

interface SizeRow {
  id: string
  product_id: string
  size: string
  color: string | null
  selling_price: number | null
  companion_product_size_id: string | null
}

interface Props {
  productId: string
}

// Per-volume "Idish (bottle)" picker. Lives in the product edit dialog because
// that is the one place a product's variants are managed as a whole; shown
// only when the product has volume ('<n> ml') sizes. Writes go through the
// set_product_size_companion RPC (direct product_sizes writes are revoked).
export function CompanionSection({ productId }: Props) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [rows, setRows] = useState<SizeRow[]>([])
  const [options, setOptions] = useState<{ value: string; label: string; price: number }[]>([])
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const supabase = createClient()
      const [{ data: sizes }, { data: prods }] = await Promise.all([
        supabase.from('product_sizes').select('id, product_id, size, color, selling_price, companion_product_size_id'),
        supabase.from('products').select('id, name'),
      ])
      if (cancelled) return
      const all = (sizes ?? []) as SizeRow[]
      const nameById = new Map(((prods ?? []) as { id: string; name: string }[]).map(p => [p.id, p.name]))
      setRows(all.filter(s => s.product_id === productId && parseVolume(s.size) !== null))
      setOptions(all
        .filter(s => s.product_id !== productId)
        .map(s => ({
          value: s.id,
          label: `${nameById.get(s.product_id) ?? ''} · ${s.size}${s.color ? ` · ${s.color}` : ''}`,
          price: Number(s.selling_price ?? 0),
        })))
    }
    load()
    return () => { cancelled = true }
  }, [productId])

  async function setCompanion(rowId: string, companionId: string) {
    setSavingId(rowId)
    const supabase = createClient()
    // TODO: remove cast once set_product_size_companion is in lib/database.types.ts
    const rpc = supabase.rpc as unknown as (
      fn: string,
      args: { p_id: string; p_companion_id: string | null },
    ) => Promise<{ error: { message: string } | null }>
    const { error } = await rpc.call(supabase, 'set_product_size_companion', { p_id: rowId, p_companion_id: companionId || null })
    setSavingId(null)
    if (error) { toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error')); return }
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, companion_product_size_id: companionId || null } : r))
    toast.success(t('products.companion.saved'))
  }

  if (rows.length === 0) return null
  const ordered = sortSizes(rows.map(r => r.size))

  return (
    <div>
      <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('products.companion.title')}</label>
      <div className="space-y-2">
        {rows.slice().sort((a, b) => ordered.indexOf(a.size) - ordered.indexOf(b.size)).map(r => (
          <div key={r.id} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-sm text-gray-700 dark:text-gray-300">
              {r.size}{r.color ? ` · ${r.color}` : ''}
              <span className="block text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">{formatPrice(Number(r.selling_price ?? 0))}</span>
            </span>
            <div className={`min-w-0 flex-1 ${savingId === r.id ? 'opacity-50 pointer-events-none' : ''}`}>
              <SearchSelect
                options={options.map(o => ({ value: o.value, label: o.label, sublabel: formatPrice(o.price) }))}
                value={r.companion_product_size_id ?? ''}
                onChange={v => setCompanion(r.id, v)}
                placeholder={t('products.companion.placeholder')}
              />
            </div>
            {r.companion_product_size_id && (
              <button
                type="button"
                onClick={() => setCompanion(r.id, '')}
                aria-label={t('products.companion.none')}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
