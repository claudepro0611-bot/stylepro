'use client'

import { useEffect, useState } from 'react'
import { Printer } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'

const JSBARCODE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js'

declare global {
  interface Window {
    JsBarcode?: (element: SVGSVGElement, value: string, options?: Record<string, unknown>) => void
  }
}

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
  const { formatPrice } = useCurrency()
  const [scriptReady, setScriptReady] = useState(false)

  useEffect(() => {
    if (!open) return
    if (typeof window !== 'undefined' && window.JsBarcode) {
      setScriptReady(true)
      return
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${JSBARCODE_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => setScriptReady(true))
      if (window.JsBarcode) setScriptReady(true)
      return
    }
    const script = document.createElement('script')
    script.src = JSBARCODE_SRC
    script.async = true
    script.onload = () => setScriptReady(true)
    document.body.appendChild(script)
  }, [open])

  // One label per product/colour/size by default (a stock-in of 10 units still
  // shows a single label). The user can raise the copy count per row when they
  // do want several identical stickers.
  const [copies, setCopies] = useState<Record<number, number>>({})
  const copiesFor = (i: number) => copies[i] ?? 1
  // Forget the copy counts whenever the dialog closes so the next stock-in starts at 1 again.
  const handleOpenChange = (next: boolean) => {
    if (!next) setCopies({})
    onOpenChange(next)
  }
  const expanded = labels.flatMap((label, i) =>
    Array.from({ length: copiesFor(i) }, (_, unit) => ({ ...label, key: `${i}-${unit}` })),
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('kirim.printLabels.button')}</DialogTitle>
        </DialogHeader>

        {labels.length > 0 && (
          <div className="mt-2 space-y-1.5 print:hidden">
            {labels.map((label, i) => (
              <div key={i} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-gray-700 dark:text-gray-300">
                  {label.productName} · {label.color ? `${label.color} / ${label.size}` : label.size}
                </span>
                <label className="flex shrink-0 items-center gap-2 text-gray-500 dark:text-gray-400">
                  {t('kirim.printLabels.copies')}
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={copiesFor(i)}
                    onChange={e => {
                      const n = Math.min(999, Math.max(1, Math.floor(Number(e.target.value) || 1)))
                      setCopies(prev => ({ ...prev, [i]: n }))
                    }}
                    className="w-16 rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 focus:border-gray-400 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-gray-500"
                  />
                </label>
              </div>
            ))}
          </div>
        )}

        <div id="kirim-labels-print-area" className="mt-2 max-h-[60vh] overflow-y-auto">
          {!scriptReady ? (
            <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">…</p>
          ) : (
            <div className="label-grid grid grid-cols-2 gap-3">
              {expanded.map(label => (
                <div
                  key={label.key}
                  className="label flex flex-col items-center gap-1 overflow-hidden border border-gray-200 bg-white px-2 py-2 text-black"
                  style={{ width: '220px', height: 'auto' }}
                >
                  <p className="w-full truncate text-center text-[14px] font-bold leading-tight">{label.productName}</p>
                  <p className="text-[12px] leading-tight">
                    {label.color ? `${label.color} / ${label.size}` : label.size}
                  </p>
                  <p className="text-[12px] font-medium leading-tight">{formatPrice(label.sellingPrice)}</p>
                  {label.barcode ? (
                    <svg
                      ref={el => {
                        if (el && window.JsBarcode) {
                          window.JsBarcode(el, label.barcode, {
                            format: 'CODE128',
                            width: 1.5,
                            height: 40,
                            displayValue: true,
                            fontSize: 10,
                          })
                        }
                      }}
                    />
                  ) : (
                    <p className="text-[10px] italic text-gray-400">{t('kirim.printLabels.noBarcode')}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <style>{`
          @media print {
            body * { visibility: hidden; }
            #kirim-labels-print-area, #kirim-labels-print-area * { visibility: visible; }
            #kirim-labels-print-area {
              position: fixed; top: 0; left: 0; width: 100%; max-height: none; overflow: visible;
            }
            #kirim-labels-print-area .label-grid { grid-template-columns: 1fr !important; }
            @page { margin: 0; }
            body { margin: 0; padding: 0; }
          }
        `}</style>

        <DialogFooter className="mt-4 print:hidden">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>{t('common.close')}</Button>
          <Button onClick={() => window.print()} disabled={!scriptReady || expanded.length === 0}>
            <Printer className="h-3.5 w-3.5" />
            {t('kirim.printLabels.print')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
