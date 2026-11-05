'use client'

import { useRef, useState } from 'react'
import { Minus, Plus, Printer } from 'lucide-react'
import { DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { BarcodeLabel } from '@/components/barcode/BarcodeLabel'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { printLabels } from '@/lib/print-labels'

export interface PrintableLabel {
  key: string
  productName: string
  variant: string
  price: number
  barcode: string
}

interface LabelPrintPanelProps {
  labels: PrintableLabel[]
  onClose: () => void
}

const MAX_COPIES = 999

// Shared body + footer for every label-print dialog: one preview per variant
// with a copy stepper. Copies only multiply in the (offscreen) print sheet, so
// raising the count never floods the preview.
export function LabelPrintPanel({ labels, onClose }: LabelPrintPanelProps) {
  const { t } = useLanguage()
  const sheetRef = useRef<HTMLDivElement>(null)
  const [copies, setCopies] = useState<Record<string, number>>({})
  const copiesFor = (key: string) => copies[key] ?? 1
  const setCount = (key: string, n: number) =>
    setCopies(prev => ({ ...prev, [key]: Math.min(MAX_COPIES, Math.max(1, Math.floor(n) || 1)) }))

  const printable = labels.filter(l => l.barcode)
  const total = printable.reduce((sum, l) => sum + copiesFor(l.key), 0)

  return (
    <>
      <div className="mt-2 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
        {labels.map(label => (
          <div
            key={label.key}
            className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3 sm:flex-row sm:items-center dark:border-gray-800 dark:bg-gray-950"
          >
            <BarcodeLabel
              productName={label.productName}
              variant={label.variant}
              price={label.price}
              barcode={label.barcode}
              emptyText={t('kirim.printLabels.noBarcode')}
            />
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{label.productName}</p>
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">{label.variant}</p>
              </div>
              {label.barcode && (
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t('kirim.printLabels.copies')}</span>
                  <div className="flex items-center rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
                    <button
                      type="button"
                      onClick={() => setCount(label.key, copiesFor(label.key) - 1)}
                      disabled={copiesFor(label.key) <= 1}
                      className="flex h-8 w-8 items-center justify-center text-gray-500 transition-colors hover:text-gray-900 disabled:opacity-40 dark:text-gray-400 dark:hover:text-gray-100"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={copiesFor(label.key)}
                      onChange={e => setCount(label.key, Number(e.target.value.replace(/\D/g, '')))}
                      className="h-8 w-10 border-x border-gray-200 bg-transparent text-center text-sm text-gray-900 focus:outline-none dark:border-gray-700 dark:text-gray-100"
                    />
                    <button
                      type="button"
                      onClick={() => setCount(label.key, copiesFor(label.key) + 1)}
                      className="flex h-8 w-8 items-center justify-center text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Print sheet: every copy, offscreen. printLabels() copies its markup into an iframe. */}
      <div aria-hidden className="pointer-events-none fixed -left-[10000px] top-0">
        <div ref={sheetRef}>
          {printable.flatMap(label =>
            Array.from({ length: copiesFor(label.key) }, (_, i) => (
              <BarcodeLabel
                key={`${label.key}-${i}`}
                productName={label.productName}
                variant={label.variant}
                price={label.price}
                barcode={label.barcode}
              />
            )),
          )}
        </div>
      </div>

      <DialogFooter className="mt-4">
        <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
        <Button onClick={() => printLabels(sheetRef.current)} disabled={total === 0}>
          <Printer className="h-3.5 w-3.5" />
          {t('kirim.printLabels.print')} ({total})
        </Button>
      </DialogFooter>
    </>
  )
}
