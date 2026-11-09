'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LabelPrintPanel } from '@/components/barcode/LabelPrintPanel'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { generateEAN13, generateUniqueBarcode } from '@/lib/barcode'
import type { Product } from '@/lib/types'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useBranchFilter } from '@/lib/session/useBranch'
import { branchAwareErrorKey } from '@/lib/branchStock'

interface SizeRow {
  id: string
  size: string
  color: string
  sellingPrice: number
  barcode: string
}

interface ProductSizeRow {
  id: string
  size: string
  color: string | null
  selling_price: number | null
  barcode: string | null
}

interface BarcodeModalProps {
  product: Product | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BarcodeModal({ product, open, onOpenChange }: BarcodeModalProps) {
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<SizeRow[]>([])
  const { t } = useLanguage()
  const applyBranch = useBranchFilter()

  useEffect(() => {
    if (!open || !product) return

    let cancelled = false
    async function load() {
      if (!product) return
      setLoading(true)
      const supabase = createClient()
      const companyId = await getCompanyId(supabase)
      if (!companyId) { setLoading(false); toast.error('Xatolik yuz berdi'); return }

      const { data, error } = await applyBranch(supabase
        .from('product_sizes')
        .select('id, size, color, selling_price, barcode')
        .eq('product_id', product.id))
        .order('size')
      if (error || !data) { setLoading(false); toast.error('Xatolik yuz berdi'); return }

      const sizeRows = data as ProductSizeRow[]
      const prefix = companyId.replace(/-/g, '').slice(0, 3)
      const resolved: SizeRow[] = []

      // A variant stocked in several warehouses has one product_sizes row per
      // warehouse, all sharing one barcode — show it once.
      const seen = new Set<string>()
      let saveError: string | null = null
      for (const row of sizeRows) {
        const variantKey = `${row.size}|${row.color ?? ''}`
        if (seen.has(variantKey)) continue
        seen.add(variantKey)
        let barcode = row.barcode
        if (!barcode) {
          const candidate = generateEAN13(prefix, product.id, row.size)
          const { data: dupe } = await supabase
            .from('product_sizes')
            .select('id')
            .eq('company_id', companyId)
            .eq('barcode', candidate)
            .limit(1)
          barcode = dupe && dupe.length > 0 ? generateUniqueBarcode() : candidate
          const { error: setErr } = await supabase.rpc('set_product_size_barcode', { p_id: row.id, p_barcode: barcode })
          // Not saved (e.g. catalog_forbidden / branch_forbidden): don't
          // print a label with a barcode the scanner won't find.
          if (setErr) { saveError = setErr.message; continue }
        }
        resolved.push({
          id: row.id,
          size: row.size,
          color: row.color ?? '',
          sellingPrice: row.selling_price && row.selling_price > 0 ? Number(row.selling_price) : product.price,
          barcode,
        })
      }

      if (saveError && !cancelled) toast.error(t(branchAwareErrorKey(saveError)))
      if (!cancelled) { setRows(resolved); setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [open, product, applyBranch, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Shtrix-kodlar {product && `— ${product.name}`}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400 dark:text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Yuklanmoqda...
          </div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">
            Bu mahsulot uchun razmerlar topilmadi
          </div>
        ) : (
          <LabelPrintPanel
            labels={rows.map(row => ({
              key: row.id,
              productName: product?.name ?? '',
              variant: row.color ? `${row.color} / ${row.size}` : row.size,
              price: row.sellingPrice,
              barcode: row.barcode,
            }))}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
