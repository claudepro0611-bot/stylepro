'use client'

import { useEffect, useRef } from 'react'
import Barcode from 'react-barcode'
import { useCurrency } from '@/lib/currency/CurrencyContext'

interface BarcodeLabelProps {
  productName: string
  variant: string
  price: number
  barcode: string
  emptyText?: string
}

// Physical 50×30mm thermal label. Always white/black regardless of theme — it
// previews the printed paper, not app chrome.
export function BarcodeLabel({ productName, variant, price, barcode, emptyText }: BarcodeLabelProps) {
  const { formatPrice } = useCurrency()
  const barsRef = useRef<HTMLDivElement>(null)

  // Stretch the bars to the full label width. CODE128 scans fine when scaled
  // horizontally; the digits are rendered as HTML below, so nothing distorts.
  useEffect(() => {
    barsRef.current?.querySelector('svg')?.setAttribute('preserveAspectRatio', 'none')
  }, [barcode])

  return (
    <div
      className="barcode-label flex shrink-0 flex-col overflow-hidden rounded-md bg-white px-[2mm] pb-[1mm] pt-[1.5mm] text-black shadow-sm ring-1 ring-gray-200 dark:ring-gray-700"
      style={{ width: '50mm', height: '30mm' }}
    >
      <p className="truncate text-[8.5pt] font-bold leading-[1.2]">{productName}</p>
      <div className="flex items-baseline justify-between gap-2 leading-[1.2]">
        <span className="truncate text-[7pt]">{variant}</span>
        <span className="shrink-0 text-[8.5pt] font-bold">{formatPrice(price)}</span>
      </div>
      {barcode ? (
        <>
          <div ref={barsRef} className="mt-[1mm] h-[14mm] w-full [&_svg]:block [&_svg]:h-full [&_svg]:w-full">
            <Barcode value={barcode} format="CODE128" renderer="svg" width={2} height={80} margin={0} displayValue={false} />
          </div>
          <p className="mt-[0.5mm] text-center font-mono text-[7pt] leading-none tracking-wider">{barcode}</p>
        </>
      ) : (
        <p className="m-auto text-[7pt] italic text-gray-500">{emptyText}</p>
      )}
    </div>
  )
}
