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

  // One label per unit — quantity=5 renders 5 identical labels.
  const expanded = labels.flatMap((label, i) =>
    Array.from({ length: label.quantity }, (_, unit) => ({ ...label, key: `${i}-${unit}` })),
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('kirim.printLabels.button')}</DialogTitle>
        </DialogHeader>

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
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
          <Button onClick={() => window.print()} disabled={!scriptReady || expanded.length === 0}>
            <Printer className="h-3.5 w-3.5" />
            {t('kirim.printLabels.print')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
