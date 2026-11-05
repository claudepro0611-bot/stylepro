'use client'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LabelPrintPanel } from '@/components/barcode/LabelPrintPanel'
import { useLanguage } from '@/lib/i18n/LanguageContext'

export interface LabelRow {
  productName: string
  color: string
  size: string
  sellingPrice: number
  barcode: string
  quantity: number
}

interface PrintLabelsModalProps {
  labels: LabelRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PrintLabelsModal({ labels, open, onOpenChange }: PrintLabelsModalProps) {
  const { t } = useLanguage()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('kirim.printLabels.button')}</DialogTitle>
        </DialogHeader>
        {/* Remount per open so copy counts reset to 1 for the next stock-in. */}
        {open && (
          <LabelPrintPanel
            labels={labels.map((label, i) => ({
              key: String(i),
              productName: label.productName,
              variant: label.color ? `${label.color} / ${label.size}` : label.size,
              price: label.sellingPrice,
              barcode: label.barcode,
            }))}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
