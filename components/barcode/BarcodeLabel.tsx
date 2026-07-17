'use client'

import Barcode from 'react-barcode'
import { useCurrency } from '@/lib/currency/CurrencyContext'

interface BarcodeLabelProps {
  productName: string
  size: string
  price: number
  barcode: string
}

export function BarcodeLabel({ productName, size, price, barcode }: BarcodeLabelProps) {
  const { formatPrice } = useCurrency()

  return (
    <div
      className="barcode-label flex flex-col items-center justify-between overflow-hidden border border-gray-200 bg-white px-1.5 py-1 text-black"
      style={{ width: '50mm', height: '30mm' }}
    >
      <p className="w-full truncate text-center text-[8px] font-semibold leading-tight">
        {productName} · {size}
      </p>
      <Barcode
        value={barcode}
        format="EAN13"
        renderer="svg"
        width={1.1}
        height={28}
        fontSize={9}
        margin={0}
        displayValue
      />
      <p className="text-[10px] font-bold">{formatPrice(price)}</p>
    </div>
  )
}
