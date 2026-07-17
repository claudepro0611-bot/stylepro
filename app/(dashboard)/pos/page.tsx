'use client'

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { Search, Plus, Minus, X, Tag, Loader2, Printer, Clock, ScanBarcode } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { VariantMatrixModal } from '@/components/pos/VariantMatrixModal'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { formatPhone, formatDuration, formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useFeatures } from '@/lib/features'
import type { Shift } from '@/lib/types'

const CATEGORIES = ['Barchasi', "Ko'ylak", 'Shim', 'Kurtka', 'Libos']
const PAYMENT_METHODS = ['Naqd', 'Karta', 'Click', 'Payme']

interface ProductCatalogRow {
  id: string
  name: string
  sku: string | null
  category: string
  price: number
  status: 'active' | 'inactive'
  image_url: string | null
}

interface ProductSizeRow {
  id: string
  product_id: string
  size: string
  color: string
  stock: number
  purchase_price: number
  selling_price: number
  sku: string | null
}

interface PosItem {
  id: string          // product_sizes.id — used as cart key
  productId: string
  productName: string
  category: string
  size: string
  color: string       // real per-variant color (product_sizes.color)
  stock: number
  price: number       // selling_price from product_sizes, fallback to products.price
  purchasePrice: number
  sku: string
  imageUrl: string
}

// One card per parent product.
interface ProductGroupCard {
  productId: string
  productName: string
  category: string
  imageUrl: string
  totalStock: number
  variants: PosItem[]
}

interface CustomerLite { id: string; fullName: string; phone: string }
interface CustomerRow { id: string; full_name: string; phone: string | null }
function mapCustomerLite(row: CustomerRow): CustomerLite {
  return { id: row.id, fullName: row.full_name, phone: row.phone ?? '' }
}

interface CartLine {
  key: string
  productId: string
  productName: string
  size: string
  unitPrice: number
  purchasePrice: number
  quantity: number
  maxStock: number
}

interface OrderTab {
  id: string
  cart: CartLine[]
  customerId: string
  discountPercent: string
  paymentMethod: string
  amountReceived: string
}

const MAX_TABS = 5

function createEmptyTab(id: string): OrderTab {
  return { id, cart: [], customerId: '', discountPercent: '', paymentMethod: '', amountReceived: '' }
}

const pillCls = (active: boolean) =>
  cn(
    'rounded-lg px-3 py-1.5 text-sm transition-colors',
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'border border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800',
  )

// ─── Product card (one per parent product) ─────────────────────────────────

function ProductGroupCardView({ group, onOpen }: { group: ProductGroupCard; onOpen: () => void }) {
  const outOfStock = group.totalStock <= 0

  return (
    <div
      onClick={onOpen}
      className={cn(
        'flex flex-col rounded-xl border border-[#E5E7EB] dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden transition-colors cursor-pointer hover:border-gray-300 dark:hover:border-gray-600',
        outOfStock && 'opacity-50',
      )}
    >
      <div className="flex h-36 items-center justify-center bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
        {group.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={group.imageUrl} alt={group.productName} className="h-full w-full object-cover" />
        ) : (
          <Tag className="h-8 w-8 text-gray-300 dark:text-gray-600" />
        )}
      </div>
      <div className="p-3 space-y-1">
        <p className="text-xs text-gray-400 dark:text-gray-500">{group.category}</p>
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 leading-tight">{group.productName}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500">{group.totalStock} ta</p>
      </div>
    </div>
  )
}

// ─── Receipt ───────────────────────────────────────────────────────────────

interface ReceiptItem { name: string; size: string; quantity: number; price: number }
interface ReceiptData {
  companyName: string
  date: string
  receiptNumber: string
  items: ReceiptItem[]
  total: number
  paymentType: string
}

function ReceiptModal({ open, onOpenChange, data }: { open: boolean; onOpenChange: (open: boolean) => void; data: ReceiptData | null }) {
  const { formatPrice } = useCurrency()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {data && (
          <div id="receipt-print" className="bg-white text-gray-900">
            <div className="text-center">
              <p className="text-xl font-bold">{data.companyName}</p>
              <p className="text-xs text-gray-500 mt-1">Sana: {data.date}</p>
              <p className="text-xs text-gray-500">Chek #: {data.receiptNumber}</p>
            </div>

            <div className="border-t border-dashed border-gray-300 my-3" />

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="font-medium pb-1">Mahsulot</th>
                  <th className="font-medium pb-1 text-center">Dona</th>
                  <th className="font-medium pb-1 text-right">Narx</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, i) => (
                  <tr key={i}>
                    <td className="py-0.5">{item.name} {item.size}</td>
                    <td className="py-0.5 text-center tabular-nums">{item.quantity}</td>
                    <td className="py-0.5 text-right tabular-nums">{formatPrice(item.price * item.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="border-t border-dashed border-gray-300 my-3" />

            <div className="flex items-center justify-between">
              <span className="text-base font-semibold">Jami:</span>
              <span className="text-xl font-bold">{formatPrice(data.total)}</span>
            </div>
            <div className="flex items-center justify-between mt-1 text-sm text-gray-600">
              <span>To&apos;lov:</span>
              <span>{data.paymentType}</span>
            </div>
          </div>
        )}

        <div className="mt-4 flex gap-2 print:hidden">
          <button
            onClick={() => window.print()}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
          >
            <Printer className="h-3.5 w-3.5" />
            Chop etish
          </button>
          <button
            onClick={() => onOpenChange(false)}
            className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Yopish
          </button>
        </div>

        <style>{`
          @media print {
            body * { visibility: hidden; }
            #receipt-print, #receipt-print * { visibility: visible; }
            #receipt-print { position: fixed; top: 0; left: 0; width: 80mm; }
          }
        `}</style>
      </DialogContent>
    </Dialog>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function POSPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { features } = useFeatures()
  const [posItems, setPosItems] = useState<PosItem[]>([])
  const [customers, setCustomers] = useState<CustomerLite[]>([])
  const [loading, setLoading] = useState(true)
  const [selling, setSelling] = useState(false)

  const [companyName, setCompanyName] = useState('')
  const [maxDiscountPercent, setMaxDiscountPercent] = useState(20)
  const [currentUser, setCurrentUser] = useState<{ id: string; fullName: string } | null>(null)
  const [activeShift, setActiveShift] = useState<Shift | null>(null)
  const [shiftLoading, setShiftLoading] = useState(true)
  const [startingShift, setStartingShift] = useState(false)
  const [closeReportOpen, setCloseReportOpen] = useState(false)
  const [closingShift, setClosingShift] = useState(false)
  const [shiftSummary, setShiftSummary] = useState<{
    totalSales: number; totalAmount: number; cashAmount: number
    cardAmount: number; clickAmount: number; paymeAmount: number
  } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const fetchShiftState = useCallback(async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setShiftLoading(false); return }
    const { data: userRow } = await supabase.from('users').select('id, full_name').eq('id', user.id).single()
    setCurrentUser({ id: user.id, fullName: userRow?.full_name ?? user.email ?? '' })
    const { data: shiftRow } = await supabase.from('shifts').select('*')
      .eq('cashier_id', user.id).eq('status', 'active').order('started_at', { ascending: false }).limit(1).maybeSingle()
    setActiveShift(shiftRow as Shift | null)
    setShiftLoading(false)
  }, [])

  useEffect(() => { fetchShiftState() }, [fetchShiftState])
  useEffect(() => {
    const supabase = createClient()
    supabase.from('companies').select('name, max_discount_percent').single().then(({ data }) => {
      if (data) {
        const row = data as unknown as { name: string; max_discount_percent: number | null }
        setCompanyName(row.name)
        if (row.max_discount_percent != null) setMaxDiscountPercent(Number(row.max_discount_percent))
      }
    })
  }, [])
  useEffect(() => {
    if (!activeShift) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [activeShift])

  async function startShift() {
    if (!currentUser) return
    setStartingShift(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setStartingShift(false); toast.error(t('common.error')); return }
    const { data, error } = await supabase.from('shifts').insert({
      company_id: companyId, cashier_id: currentUser.id, cashier_name: currentUser.fullName,
      initial_cash: 0, status: 'active',
    }).select().single()
    setStartingShift(false)
    if (error || !data) { toast.error(t('common.error')); return }
    setActiveShift(data as Shift)
  }

  async function openCloseReport() {
    if (!activeShift) return
    const supabase = createClient()
    const { data, error } = await supabase.from('transactions').select('total_amount, payment_method').eq('shift_id', activeShift.id)
    if (error) { toast.error(t('common.error')); return }
    const rows = (data ?? []) as { total_amount: number; payment_method: string }[]
    setShiftSummary({
      totalSales: rows.length,
      totalAmount: rows.reduce((s, r) => s + Number(r.total_amount), 0),
      cashAmount: rows.filter(r => r.payment_method === 'Naqd').reduce((s, r) => s + Number(r.total_amount), 0),
      cardAmount: rows.filter(r => r.payment_method === 'Karta').reduce((s, r) => s + Number(r.total_amount), 0),
      clickAmount: rows.filter(r => r.payment_method === 'Click').reduce((s, r) => s + Number(r.total_amount), 0),
      paymeAmount: rows.filter(r => r.payment_method === 'Payme').reduce((s, r) => s + Number(r.total_amount), 0),
    })
    setCloseReportOpen(true)
  }

  async function closeShift() {
    if (!activeShift || !shiftSummary) return
    if (!window.confirm(t('pos.shift.confirmClose'))) return
    setClosingShift(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('shifts').update({
      status: 'closed' as const, ended_at: new Date().toISOString(),
      total_sales: shiftSummary.totalSales, total_amount: shiftSummary.totalAmount,
      cash_amount: shiftSummary.cashAmount, card_amount: shiftSummary.cardAmount,
      click_amount: shiftSummary.clickAmount, payme_amount: shiftSummary.paymeAmount,
    }).eq('id', activeShift.id).eq('status', 'active').select()
    setClosingShift(false)
    if (error || !data || data.length === 0) { toast.error(t('common.error')); return }
    toast.success(t('pos.shift.closedSuccess'))
    setCloseReportOpen(false); setShiftSummary(null); setActiveShift(null)
  }

  const fetchProducts = useCallback(async (): Promise<PosItem[]> => {
    const supabase = createClient()
    const [{ data: catalogData }, { data: sizesData }] = await Promise.all([
      supabase.from('products').select('id, name, sku, category, price, status, image_url').eq('status', 'active'),
      // Unfiltered (including stock=0 rows): the variant matrix needs every
      // size/color a product has ever been stocked in, so it can show
      // zero-stock cells grayed-out rather than omitting them.
      supabase.from('product_sizes').select('id, product_id, size, color, stock, purchase_price, selling_price, sku'),
    ])
    const catalogMap = new Map((catalogData as ProductCatalogRow[] ?? []).map(p => [p.id, p]))
    const items: PosItem[] = []
    for (const sz of (sizesData as ProductSizeRow[] ?? [])) {
      const p = catalogMap.get(sz.product_id)
      if (!p) continue
      items.push({
        id: sz.id,
        productId: p.id,
        productName: p.name,
        category: p.category,
        size: sz.size,
        color: sz.color ?? '',
        stock: sz.stock,
        price: sz.selling_price > 0 ? sz.selling_price : p.price,
        purchasePrice: sz.purchase_price,
        sku: sz.sku ?? p.sku ?? '',
        imageUrl: p.image_url ?? '',
      })
    }
    items.sort((a, b) => a.productName.localeCompare(b.productName) || a.size.localeCompare(b.size))
    setPosItems(items)
    return items
  }, [])

  const fetchCustomers = useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await supabase.from('customers').select('id, full_name, phone')
    if (error) toast.error(t('common.error'))
    else setCustomers((data as CustomerRow[]).map(mapCustomerLite))
  }, [t])

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchProducts(), fetchCustomers()]).finally(() => setLoading(false))
  }, [fetchProducts, fetchCustomers])

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('Barchasi')

  const tabIdRef = useRef(1)
  const [tabs, setTabs] = useState<OrderTab[]>(() => [createEmptyTab('tab-1')])
  const [activeTabId, setActiveTabId] = useState('tab-1')

  const activeTab = tabs.find(tb => tb.id === activeTabId) ?? tabs[0]
  const { cart, customerId, discountPercent, paymentMethod, amountReceived } = activeTab

  function updateActiveTab(updater: (tab: OrderTab) => OrderTab) {
    setTabs(prev => prev.map(tb => (tb.id === activeTabId ? updater(tb) : tb)))
  }

  function addTab() {
    if (tabs.length >= MAX_TABS) { toast.error(t('pos.tabs.maxReached')); return }
    const id = `tab-${++tabIdRef.current}`
    setTabs(prev => [...prev, createEmptyTab(id)]); setActiveTabId(id)
  }

  function closeTab(id: string) {
    if (tabs.length <= 1) return
    const tab = tabs.find(tb => tb.id === id)
    if (!tab) return
    if (tab.cart.length > 0 && !window.confirm(t('pos.tabs.closeConfirm'))) return
    const remaining = tabs.filter(tb => tb.id !== id)
    setTabs(remaining)
    if (activeTabId === id) setActiveTabId(remaining[0].id)
  }

  function closeActiveTabAfterSale() {
    const remaining = tabs.filter(tb => tb.id !== activeTabId)
    if (remaining.length > 0) { setTabs(remaining); setActiveTabId(remaining[0].id) }
    else { const id = `tab-${++tabIdRef.current}`; setTabs([createEmptyTab(id)]); setActiveTabId(id) }
  }

  const [receiptOpen, setReceiptOpen] = useState(false)
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null)

  const productGroups = useMemo(() => {
    const map = new Map<string, ProductGroupCard>()
    for (const item of posItems) {
      let group = map.get(item.productId)
      if (!group) {
        group = {
          productId: item.productId,
          productName: item.productName,
          category: item.category,
          imageUrl: item.imageUrl,
          totalStock: 0,
          variants: [],
        }
        map.set(item.productId, group)
      }
      group.variants.push(item)
      group.totalStock += item.stock
    }
    return Array.from(map.values()).sort((a, b) => a.productName.localeCompare(b.productName))
  }, [posItems])

  const filteredProducts = useMemo(() => {
    let list = productGroups
    if (category !== 'Barchasi') list = list.filter(p => p.category === category)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(g =>
        g.productName.toLowerCase().includes(q) ||
        g.variants.some(v => v.sku.toLowerCase().includes(q) || v.size.toLowerCase().includes(q)),
      )
    }
    return list
  }, [productGroups, category, search])

  const [matrixProduct, setMatrixProduct] = useState<ProductGroupCard | null>(null)

  // ─── Barcode scanning ─────────────────────────────────────────────────
  const barcodeInputRef = useRef<HTMLInputElement>(null)
  const [scanValue, setScanValue] = useState('')
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [manualBarcodeOpen, setManualBarcodeOpen] = useState(false)
  const [manualBarcodeValue, setManualBarcodeValue] = useState('')
  const manualBarcodeInputRef = useRef<HTMLInputElement>(null)

  const customer = customers.find(c => c.id === customerId) ?? null

  function addToCart(item: PosItem) {
    if (item.stock <= 0) { toast.error(t('pos.noSizesAvailable')); return }
    const key = item.id  // product_sizes.id
    updateActiveTab(tab => {
      const existing = tab.cart.find(l => l.key === key)
      if (existing) {
        if (existing.quantity >= item.stock) return tab
        return { ...tab, cart: tab.cart.map(l => l.key === key ? { ...l, quantity: l.quantity + 1 } : l) }
      }
      return {
        ...tab,
        cart: [...tab.cart, { key, productId: item.productId, productName: item.productName, size: item.size, unitPrice: item.price, purchasePrice: item.purchasePrice, quantity: 1, maxStock: item.stock }],
      }
    })
  }

  // product_sizes.color is '' for products with no declared color — reuse
  // the same "Asosiy/Default" label the kirim matrix and VariantMatrixModal
  // already use for that case, so the wording stays consistent everywhere.
  function colorOrDefault(color: string): string {
    return color || t('kirim.matrix.defaultColor')
  }

  async function performBarcodeLookup(rawValue: string) {
    const value = rawValue.trim()
    if (value.length < 3) return

    // Scanner always takes priority: close the variant matrix first,
    // regardless of what the lookup below finds.
    if (matrixProduct) setMatrixProduct(null)

    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) return

    const { data, error } = await supabase
      .from('product_sizes')
      .select('id, product_id, size, color, stock')
      .eq('barcode', value)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error || !data) {
      toast.error(t('pos.barcode.notFound'))
      return
    }

    // The scanned row may not be in local state yet (e.g. just stocked in
    // from another till) — refetch once before giving up.
    let item = posItems.find(p => p.id === data.id)
    if (!item) {
      const refreshed = await fetchProducts()
      item = refreshed.find(p => p.id === data.id)
    }
    if (!item) {
      toast.error(t('pos.barcode.notFound'))
      return
    }

    if (data.stock <= 0) {
      toast.error(`${t('pos.barcode.outOfStock')} — ${item.productName} ${colorOrDefault(item.color)} ${item.size}`)
      return
    }

    addToCart(item)
    toast.success(t('pos.barcode.added'), {
      description: `${colorOrDefault(item.color)} ${item.size} — ${item.productName}`,
      duration: 1500,
    })
    setManualBarcodeOpen(false)
  }

  function scheduleBarcodeLookup(value: string) {
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current)
    scanTimerRef.current = setTimeout(() => {
      performBarcodeLookup(value)
      setScanValue('')
    }, 80)
  }

  function handleScanChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setScanValue(value)
    scheduleBarcodeLookup(value)
  }

  function handleScanKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current)
      performBarcodeLookup(scanValue)
      setScanValue('')
    }
  }

  // Auto-focus on mount and after every cart mutation (add/increment/
  // decrement/remove/clear/tab-switch all flow through `cart`'s identity).
  useEffect(() => {
    barcodeInputRef.current?.focus()
  }, [cart])

  // Re-focus on any click on the page that isn't aimed at a real text input
  // — clicking a product card, the cart list, payment buttons, etc. should
  // hand focus straight back to the scanner. Clicks that land in an actual
  // input/textarea/select (search box, discount %, the manual barcode
  // dialog's own field, ...) are left alone so typing there still works —
  // otherwise this would steal focus away from every other field on the
  // page and make manual typing impossible.
  useEffect(() => {
    function handlePageClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select')) return
      barcodeInputRef.current?.focus()
    }
    document.addEventListener('click', handlePageClick)
    return () => document.removeEventListener('click', handlePageClick)
  }, [])

  useEffect(() => {
    if (manualBarcodeOpen) manualBarcodeInputRef.current?.focus()
  }, [manualBarcodeOpen])

  function incrementLine(key: string) {
    updateActiveTab(tab => ({
      ...tab,
      cart: tab.cart.map(l => (l.key === key && l.quantity < l.maxStock) ? { ...l, quantity: l.quantity + 1 } : l),
    }))
  }

  function decrementLine(key: string) {
    updateActiveTab(tab => {
      const line = tab.cart.find(l => l.key === key)
      if (line && line.quantity <= 1) return { ...tab, cart: tab.cart.filter(l => l.key !== key) }
      return { ...tab, cart: tab.cart.map(l => l.key === key ? { ...l, quantity: l.quantity - 1 } : l) }
    })
  }

  function removeLine(key: string) {
    updateActiveTab(tab => ({ ...tab, cart: tab.cart.filter(l => l.key !== key) }))
  }

  function resetSale() {
    updateActiveTab(tab => ({ ...tab, cart: [], customerId: '', discountPercent: '', paymentMethod: '', amountReceived: '' }))
  }

  const cartCount = cart.reduce((s, l) => s + l.quantity, 0)
  const subtotal = cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0)
  const discountPct = Math.min(maxDiscountPercent, Math.max(0, Number(discountPercent) || 0))
  const discountAmount = Math.round(subtotal * discountPct / 100)
  const total = subtotal - discountAmount
  const received = Number(amountReceived) || 0
  const change = Math.max(0, received - total)

  const canSell = cart.length > 0 && paymentMethod !== '' && (!features.shift_system || !!activeShift)

  async function handleSell() {
    if (!canSell) return
    setSelling(true)
    const supabase = createClient()

    const today = new Date().toISOString().slice(0, 10)
    const customerName = customer?.fullName ?? t('dashboard.recentSales.guestCustomer')

    const items = cart.map(line => ({
      product_size_id: line.key,
      quantity: line.quantity,
      discount_percent: discountPct,
    }))

    const { data: transactionId, error } = await supabase.rpc('sell_cart', {
      p_items: items,
      // Supabase's generated RPC arg types don't reflect that this Postgres
      // uuid parameter accepts NULL (guest sale, no customer) — cast around it.
      p_customer_id: (customer?.id ?? null) as unknown as string,
      p_payment: {
        customer_name: customerName,
        payment_method: paymentMethod,
        date: today,
        shift_id: activeShift?.id ?? null,
        cashier_id: currentUser?.id ?? null,
        cashier_name: currentUser?.fullName ?? null,
      },
    })

    setSelling(false)

    if (error || !transactionId) {
      if (error?.message.includes('forbidden')) {
        toast.error(t('common.forbidden'))
      } else if (error?.message.includes('Discount percent') && error.message.includes('is invalid for product_size')) {
        // sell_cart raises "Discount percent % is invalid for product_size %
        // (must be between 0 and %)" when a line's discount exceeds the
        // company's max_discount_percent cap.
        toast.error(`${t('pos.discountExceedsMax')} (${maxDiscountPercent}%)`)
      } else {
        // sell_cart raises "Insufficient stock for product_size <uuid>" — pull the
        // uuid back out so the toast names the item instead of a generic error.
        const failedId = error?.message.match(/product_size ([0-9a-f-]{36})/i)?.[1]
        const failedItem = failedId ? posItems.find(p => p.id === failedId) : undefined
        toast.error(failedItem ? `${t('pos.noSizesAvailable')}: ${failedItem.productName} (${failedItem.size})` : t('common.error'))
      }
      await fetchProducts()
      return
    }

    await fetchProducts()
    toast.success(t('pos.success.title'))
    setReceiptData({
      companyName,
      date: new Date().toLocaleDateString('uz-UZ'),
      receiptNumber: transactionId.slice(-6).toUpperCase(),
      items: cart.map(line => ({ name: line.productName, size: line.size, quantity: line.quantity, price: line.unitPrice })),
      total,
      paymentType: paymentMethod,
    })
    setReceiptOpen(true)
    closeActiveTabAfterSale()
  }

  return (
    <div className="space-y-6">
      {/* Invisible barcode-scanner input — always focused, captures scans
          anywhere on this page without a visible field. */}
      <input
        ref={barcodeInputRef}
        type="text"
        value={scanValue}
        onChange={handleScanChange}
        onKeyDown={handleScanKeyDown}
        autoComplete="off"
        aria-hidden="true"
        tabIndex={-1}
        style={{ opacity: 0, position: 'absolute', width: '1px', height: '1px', padding: 0, border: 'none', pointerEvents: 'none' }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('pos.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('pos.subtitle')}</p>
        </div>
        {features.shift_system && activeShift && (
          <div className="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-green-600 dark:text-green-400">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              {t('pos.shift.active')}
            </span>
            <span className="flex items-center gap-1.5 text-[13px] text-gray-500 dark:text-gray-400 tabular-nums">
              <Clock className="h-3.5 w-3.5" />
              {formatDuration(activeShift.started_at, new Date(now).toISOString())}
            </span>
            <button onClick={openCloseReport} className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              {t('pos.shift.closeButton')}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col lg:h-[calc(100vh-13rem)] rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        {/* Order tabs */}
        <div className="shrink-0 flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-5 py-2 overflow-x-auto">
          {tabs.map((tb, i) => (
            <button key={tb.id} onClick={() => setActiveTabId(tb.id)}
              className={cn('flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors shrink-0',
                tb.id === activeTabId ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100' : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800')}>
              <span>{t('pos.tabs.label')} #{i + 1}</span>
              {tb.cart.length > 0 && <span className="tabular-nums opacity-70">({tb.cart.reduce((s, l) => s + l.quantity, 0)})</span>}
              {tabs.length > 1 && <X className="h-3.5 w-3.5 opacity-60 hover:opacity-100" onClick={e => { e.stopPropagation(); closeTab(tb.id) }} />}
            </button>
          ))}
          {tabs.length < MAX_TABS && (
            <button onClick={addTab} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors">
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex flex-1 flex-col lg:flex-row min-h-0">
          {/* LEFT — Products (65%) */}
          <div className="flex flex-col lg:w-[65%] bg-gray-50 dark:bg-gray-800 min-h-0">
            <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-5 py-4 space-y-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500 pointer-events-none" />
                  <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('pos.searchPlaceholder')}
                    className="h-10 w-full rounded-lg bg-gray-100 dark:bg-gray-800 pl-10 pr-4 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:bg-white dark:focus:bg-gray-900 border border-transparent focus:border-gray-400 dark:focus:border-gray-500 transition-colors" />
                </div>
                <button
                  onClick={() => { setManualBarcodeValue(''); setManualBarcodeOpen(true) }}
                  className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <ScanBarcode className="h-4 w-4" />
                  {t('pos.barcode.button')}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {CATEGORIES.map(cat => (
                  <button key={cat} onClick={() => setCategory(cat)} className={pillCls(category === cat)}>{cat === 'Barchasi' ? t('common.all') : cat}</button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {loading ? (
                <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-300 dark:text-gray-600" />
                  <p className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</p>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
                  <Tag className="h-8 w-8 text-gray-300 dark:text-gray-600" />
                  <p className="text-sm text-gray-400 dark:text-gray-500">{t('pos.emptyProducts')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredProducts.map(group => (
                    <ProductGroupCardView key={group.productId} group={group} onOpen={() => setMatrixProduct(group)} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT — Cart (35%) */}
          <div className="flex flex-col lg:w-[35%] bg-white dark:bg-gray-900 border-t lg:border-t-0 lg:border-l border-gray-200 dark:border-gray-700 min-h-0">
            <div className="shrink-0 flex items-center justify-between border-b border-gray-100 dark:border-gray-800 px-5 py-4">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t('pos.cart')}</h2>
                <span className="text-[12px] text-gray-400 dark:text-gray-500">{cartCount} {t('pos.unitsSuffix')}</span>
              </div>
              <button onClick={resetSale} disabled={cart.length === 0}
                className="text-sm text-red-500 hover:text-red-700 disabled:opacity-40 disabled:hover:text-red-500 transition-colors">
                {t('pos.clear')}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* Customer selector */}
              <div>
                {customer ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-gray-900 dark:text-gray-100 truncate">{customer.fullName}</p>
                      <p className="text-[11px] text-gray-400 dark:text-gray-500">{formatPhone(customer.phone)}</p>
                    </div>
                    <button onClick={() => updateActiveTab(tab => ({ ...tab, customerId: '' }))} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <SearchSelect
                    options={customers.map(c => ({ value: c.id, label: c.fullName, sublabel: formatPhone(c.phone) }))}
                    value={customerId}
                    onChange={value => updateActiveTab(tab => ({ ...tab, customerId: value }))}
                    placeholder={t('pos.selectCustomerPlaceholder')}
                  />
                )}
              </div>

              {/* Cart items */}
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 py-10 text-center">
                  <p className="text-[13px] text-gray-400 dark:text-gray-500">{t('pos.emptyCart')}</p>
                </div>
              ) : (
                <div>
                  {cart.map((line, i) => (
                    <div key={line.key} className={cn('flex items-center justify-between gap-2 py-3', i > 0 && 'border-t border-gray-100 dark:border-gray-800')}>
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                          {line.productName} <span className="text-gray-400 dark:text-gray-500">· {line.size}</span>
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 tabular-nums">{formatPrice(line.unitPrice)}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="flex items-center gap-1">
                          <button onClick={() => decrementLine(line.key)} className="flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className="w-5 text-center text-sm text-gray-900 dark:text-gray-100 tabular-nums">{line.quantity}</span>
                          <button onClick={() => incrementLine(line.key)} className="flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                            <Plus className="h-3 w-3" />
                          </button>
                        </div>
                        <span className="w-20 text-right text-sm text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(line.unitPrice * line.quantity)}</span>
                        <button onClick={() => removeLine(line.key)} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Discount */}
              {cart.length > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-500 dark:text-gray-400">{t('pos.discount')}</span>
                  <div className="flex items-center gap-1.5">
                    <input type="number" min={0} max={maxDiscountPercent} value={discountPercent}
                      onChange={e => updateActiveTab(tab => ({ ...tab, discountPercent: e.target.value }))}
                      placeholder="0"
                      className="h-8 w-16 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-right text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors" />
                    <span className="text-sm text-gray-400 dark:text-gray-500">%</span>
                  </div>
                </div>
              )}
            </div>

            {/* Summary + payment + sell */}
            {cart.length > 0 && (
              <div className="shrink-0 border-t border-gray-100 dark:border-gray-800 px-5 py-4 space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500 dark:text-gray-400">{t('pos.total')}</span>
                    <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(subtotal)}</span>
                  </div>
                  {discountAmount > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500 dark:text-gray-400">{t('pos.discount')}</span>
                      <span className="text-gray-500 dark:text-gray-400 tabular-nums">-{formatPrice(discountAmount)}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-1.5 border-t border-gray-100 dark:border-gray-800">
                    <span className="text-base font-bold text-gray-900 dark:text-gray-100">{t('pos.payment')}</span>
                    <span className="text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(total)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {PAYMENT_METHODS.map(method => (
                    <button key={method} onClick={() => updateActiveTab(tab => ({ ...tab, paymentMethod: method }))}
                      className={cn('h-9 rounded-lg border text-[12px] font-medium transition-colors',
                        paymentMethod === method ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600')}>
                      {method}
                    </button>
                  ))}
                </div>

                {paymentMethod === 'Naqd' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-gray-500 dark:text-gray-400">{t('pos.received')}</span>
                      <input type="number" min={0} value={amountReceived}
                        onChange={e => updateActiveTab(tab => ({ ...tab, amountReceived: e.target.value }))}
                        placeholder="0"
                        className="h-8 w-32 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-right text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors" />
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500 dark:text-gray-400">{t('pos.change')}</span>
                      <span className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(change)}</span>
                    </div>
                  </div>
                )}

                <button onClick={handleSell} disabled={!canSell || selling}
                  className={cn('flex w-full items-center justify-center rounded-xl px-4 py-3 text-lg font-semibold transition-colors',
                    canSell && !selling ? 'bg-slate-900 text-white hover:bg-slate-800' : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed')}>
                  {selling ? <Loader2 className="h-4 w-4 animate-spin" /> : t('pos.sell')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Variant matrix modal */}
      <VariantMatrixModal
        productName={matrixProduct?.productName ?? ''}
        variants={matrixProduct?.variants.map(v => ({ id: v.id, size: v.size, color: v.color, stock: v.stock })) ?? []}
        open={matrixProduct !== null}
        onOpenChange={open => { if (!open) setMatrixProduct(null) }}
        onSelect={variantId => {
          const item = posItems.find(p => p.id === variantId)
          if (item) addToCart(item)
        }}
      />

      {/* Manual barcode entry (fallback for when a scanner isn't available) */}
      <Dialog open={manualBarcodeOpen} onOpenChange={setManualBarcodeOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('pos.barcode.button')}</DialogTitle>
          </DialogHeader>
          <input
            ref={manualBarcodeInputRef}
            type="text"
            value={manualBarcodeValue}
            onChange={e => setManualBarcodeValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); performBarcodeLookup(manualBarcodeValue) } }}
            className="mt-2 h-10 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
          />
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setManualBarcodeOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => performBarcodeLookup(manualBarcodeValue)}>{t('common.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt modal */}
      <ReceiptModal open={receiptOpen} onOpenChange={setReceiptOpen} data={receiptData} />

      {/* Open shift modal */}
      <Dialog open={Boolean(features.shift_system && !shiftLoading && !activeShift)} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader><DialogTitle>{t('pos.shift.openTitle')}</DialogTitle></DialogHeader>
          <DialogFooter className="mt-4">
            <Button onClick={startShift} disabled={startingShift} className="w-full">
              {startingShift ? <Loader2 className="h-4 w-4 animate-spin" /> : t('pos.shift.startButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shift closing report modal */}
      <Dialog open={closeReportOpen} onOpenChange={setCloseReportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>{t('pos.shift.closeTitle')}</DialogTitle>
              <button onClick={() => window.print()} className="print:hidden flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                <Printer className="h-3.5 w-3.5" />{t('pos.shift.print')}
              </button>
            </div>
          </DialogHeader>
          {activeShift && shiftSummary && (
            <div className="mt-2 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.cashier')}</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{activeShift.cashier_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.date')}</span>
                <span className="text-gray-900 dark:text-gray-100">{formatDateTime(activeShift.started_at)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.duration')}</span>
                <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatDuration(activeShift.started_at, new Date(now).toISOString())}</span>
              </div>
              <div className="h-px bg-gray-100 dark:bg-gray-800 my-1" />
              <div className="flex items-center justify-between">
                <span className="text-gray-500 dark:text-gray-400">{t('pos.shift.totalSales')}</span>
                <span className="text-gray-900 dark:text-gray-100 tabular-nums">{shiftSummary.totalSales}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-medium text-gray-900 dark:text-gray-100">{t('pos.shift.totalAmount')}</span>
                <span className="font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(shiftSummary.totalAmount)}</span>
              </div>
              <div className="h-px bg-gray-100 dark:bg-gray-800 my-1" />
              {[['Naqd', shiftSummary.cashAmount], ['Karta', shiftSummary.cardAmount], ['Click', shiftSummary.clickAmount], ['Payme', shiftSummary.paymeAmount]].map(([label, amount]) => (
                <div key={label as string} className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">{label}</span>
                  <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(amount as number)}</span>
                </div>
              ))}
              <div className="h-px bg-gray-100 dark:bg-gray-800 my-1" />
              <div className="flex items-center justify-between">
                <span className="font-medium text-gray-900 dark:text-gray-100">{t('pos.shift.cashInRegister')}</span>
                <span className="font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(Number(activeShift.initial_cash) + shiftSummary.cashAmount)}</span>
              </div>
            </div>
          )}
          <DialogFooter className="mt-4 print:hidden">
            <Button variant="outline" onClick={() => setCloseReportOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={closeShift} disabled={closingShift}>
              {closingShift ? <Loader2 className="h-4 w-4 animate-spin" /> : t('pos.shift.closeShift')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
