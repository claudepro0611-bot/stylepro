'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Package, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface PickerProduct {
  id: string
  name: string
  sku: string
  category: string
  warehouseId: string
  imageUrl?: string
}

interface ProductPickerProps {
  products: PickerProduct[]
  value: string
  onChange: (productId: string) => void
  placeholder: string
  notFoundLabel: string
  changeLabel: string
  noWarehouseLabel: string
  autoFocus?: boolean
}

const MAX_RESULTS = 50

function Thumb({ product }: { product: PickerProduct }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-50 dark:bg-gray-800">
      {product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <Package className="h-4 w-4 text-gray-400" />
      )}
    </div>
  )
}

// Search-first product picker for the stock-in dialog: matches by name, SKU or
// category, and an exact SKU + Enter (typed or scanned) selects immediately.
export function ProductPicker({
  products, value, onChange, placeholder, notFoundLabel, changeLabel, noWarehouseLabel, autoFocus,
}: ProductPickerProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selected = products.find(p => p.id === value)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products.slice(0, MAX_RESULTS)
    const exact: PickerProduct[] = []
    const rest: PickerProduct[] = []
    for (const p of products) {
      if (p.sku && p.sku.toLowerCase() === q) exact.push(p)
      else if (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      ) rest.push(p)
    }
    return [...exact, ...rest].slice(0, MAX_RESULTS)
  }, [products, query])

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (p: PickerProduct) => {
    onChange(p.id)
    setQuery('')
    setOpen(false)
  }

  const clear = () => {
    onChange('')
    setQuery('')
    setOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  if (selected) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <Thumb product={selected} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{selected.name}</p>
          <div className="mt-0.5 flex items-center gap-2">
            {selected.sku && (
              <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">{selected.sku}</span>
            )}
            {selected.category && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{selected.category}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={clear}
          aria-label={changeLabel}
          title={changeLabel}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, results.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (open && results[active]) pick(results[active]) }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) }
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className="h-11 w-full rounded-lg border border-gray-200 bg-white pl-10 pr-3 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-gray-500"
      />
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-gray-100 bg-white p-1 shadow-md dark:border-gray-800 dark:bg-gray-900"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-gray-400 dark:text-gray-500">{notFoundLabel}</p>
          ) : results.map((p, i) => (
            <div
              key={p.id}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors',
                i === active ? 'bg-gray-50 dark:bg-gray-800' : '',
              )}
            >
              <Thumb product={p} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {p.name}
                  {!p.warehouseId && (
                    <span className="ml-2 text-[11px] font-normal italic text-amber-600 dark:text-amber-500">({noWarehouseLabel})</span>
                  )}
                </p>
                {p.sku && <p className="font-mono text-[11px] text-gray-500 dark:text-gray-400">{p.sku}</p>}
              </div>
              {p.category && (
                <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{p.category}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
