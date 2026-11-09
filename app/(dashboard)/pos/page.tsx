'use client'

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { localYmd } from '@/lib/utils/date'
import { Search, Plus, Minus, X, Tag, Loader2, Printer, Clock, ScanBarcode, Gift, History } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { VariantMatrixModal } from '@/components/pos/VariantMatrixModal'
import { PastPurchasesDialog, type PastPurchase } from '@/components/pos/PastPurchasesDialog'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { formatPhone, formatDuration, formatDateTime, formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useFeatures } from '@/lib/features'
import type { Shift, Promotion } from '@/lib/types'
import { isPerMl } from '@/lib/sizes'
import { computeListPrice, mapPriceList, type PriceList, type PriceListRow } from '@/lib/price-lists'
import { fetchAllRows } from '@/lib/supabase/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useSession } from '@/lib/session/SessionContext'
import { useBranchFilter, useIsMultiBranch, useWriteBranchId } from '@/lib/session/useBranch'
import { branchStockErrorKey, eqBranch } from '@/lib/branchStock'
import type { Database } from '@/lib/database.types'
import { BranchSelect } from '@/components/filiallar/BranchSelect'

// pos_catalog / pos_lookups aren't in the generated Database types yet.
async function callRpc<T>(supabase: SupabaseClient, fn: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: unknown }> {
  const { data, error } = await (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>).call(supabase, fn, args)
  return { data: (data as T | null) ?? null, error }
}

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
  companion_product_size_id: string | null
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
  companionId: string | null  // product_sizes.id of the auto-added bottle
  // Every warehouse row of this variant (same product+size+color), most
  // stock first. `id` is rows[0]; `stock` is the sum. sell_cart works on
  // concrete rows, so handleSell splits a line's quantity across these.
  rows: { id: string; stock: number }[]
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

interface CustomerLite { id: string; fullName: string; phone: string; priceListId: string | null }
interface CustomerRow { id: string; full_name: string; phone: string | null; price_list_id?: string | null }
function mapCustomerLite(row: CustomerRow): CustomerLite {
  return { id: row.id, fullName: row.full_name, phone: row.phone ?? '', priceListId: row.price_list_id ?? null }
}

interface PastPurchaseRow {
  product_id: string | null
  product_size_id: string | null
  product_name: string | null
  product_sizes: { size: string | null; color: string | null } | { size: string | null; color: string | null }[] | null
  products: { name: string | null; category: string | null } | { name: string | null; category: string | null }[] | null
  price: number
  quantity: number
  returned_quantity: number | null
  transactions: { date: string } | { date: string }[] | null
}

interface CartLine {
  key: string
  productSizeId: string  // product_sizes.id sent to sell_cart (differs from key on bottle lines)
  companionId: string | null   // bottle to auto-add alongside this line
  bottleDropped: boolean       // cashier removed the bottle; do not re-add
  companionOf?: string         // set on bottle lines: key of the perfume line they belong to
  productId: string
  productName: string
  size: string
  unitPrice: number
  purchasePrice: number
  quantity: number
  maxStock: number
  isGift: boolean  // free gift line: sold at 0, still decrements stock
}

interface SelectedPromotion {
  id: string
  name: string
  discountPercent: number
}

interface OrderTab {
  id: string
  cart: CartLine[]
  customerId: string
  paymentMethod: string
  amountReceived: string
  manualDiscount: string  // cheque-level discount in so'm, typed by the cashier
  selectedPromotion: SelectedPromotion | null
}

const MAX_TABS = 5

// Bottle lines are fully derived from their perfume line: same quantity,
// placed right after it, dropped when the perfume line is gone, and not
// regenerated once the cashier removed them (bottleDropped on the parent).
function syncBottles(cart: CartLine[], items: PosItem[]): CartLine[] {
  // Keyed by every warehouse row id, so a companion pointing at any row of
  // the bottle variant still resolves to its (merged) POS item.
  const byId = new Map(items.flatMap(i => i.rows.map(r => [r.id, i] as const)))
  const out: CartLine[] = []
  for (const line of cart) {
    if (line.companionOf) continue
    out.push(line)
    if (!line.companionId || line.bottleDropped) continue
    const b = byId.get(line.companionId)
    if (!b) continue
    out.push({
      key: `bottle:${line.key}`, productSizeId: b.id, companionId: null, bottleDropped: false, companionOf: line.key,
      productId: b.productId, productName: b.productName, size: b.size,
      unitPrice: b.price, purchasePrice: b.purchasePrice,
      // Per-ml perfume: one bottle per pour, not one per ml.
      quantity: isPerMl(line.size) ? 1 : line.quantity, maxStock: b.stock, isGift: line.isGift,
    })
  }
  return out
}

function createEmptyTab(id: string): OrderTab {
  return { id, cart: [], customerId: '', paymentMethod: '', amountReceived: '', manualDiscount: '', selectedPromotion: null }
}

interface PromotionRow {
  id: string
  name: string
  discount_percent: number
  scope_type: Promotion['scopeType']
  category: string | null
  starts_on: string | null
  ends_on: string | null
  is_active: boolean
}

function mapPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    name: row.name,
    discountPercent: Number(row.discount_percent),
    scopeType: row.scope_type,
    category: row.category,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    isActive: row.is_active,
  }
}

const pillCls = (active: boolean) =>
  cn(
    'rounded-lg px-3 py-1.5 text-sm transition-colors',
    active
      ? 'bg-indigo-600 dark:bg-indigo-500 shadow-sm border border-indigo-600 dark:border-indigo-500 text-white'
      : 'border border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800',
  )

// ─── Product card (one per parent product) ─────────────────────────────────

function ProductGroupCardView({ group, onOpen }: { group: ProductGroupCard; onOpen: () => void }) {
  const outOfStock = group.totalStock <= 0

  return (
    <div
      onClick={onOpen}
      className={cn(
        'flex flex-col rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden transition-colors cursor-pointer hover:border-gray-300 dark:hover:border-gray-600',
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
        <p className="text-xs text-gray-400 dark:text-gray-500">{group.totalStock} {group.variants.every(v => isPerMl(v.size)) ? 'ml' : 'ta'}</p>
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
  discount: number
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

            {data.discount > 0 && (
              <div className="flex items-center justify-between mb-1 text-sm text-gray-600">
                <span>Chegirma:</span>
                <span className="tabular-nums">−{formatPrice(data.discount)}</span>
              </div>
            )}
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
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
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
  const [currentUser, setCurrentUser] = useState<{ id: string; fullName: string } | null>(null)
  const [userRole, setUserRole] = useState('')
  const [giftSettings, setGiftSettings] = useState<{ maxPercent: number; staffAllowed: boolean } | null>(null)
  const canGift = !!giftSettings && giftSettings.maxPercent > 0 && userRole !== '' && (userRole !== 'staff' || giftSettings.staffAllowed)
  const [activeShift, setActiveShift] = useState<Shift | null>(null)
  const [shiftLoading, setShiftLoading] = useState(true)

  // Branch: POS branch = the open shift's branch (locked while the shift is
  // open), else the header-selected branch / useWriteBranchId(). Owner/admin
  // on "All branches" in a multi-branch company pick it with a compact select.
  const { loading: sessionLoading, branches, canSeeAllBranches, activeBranchId } = useSession()
  const applyBranch = useBranchFilter()
  const multiBranch = useIsMultiBranch()
  const writeBranchId = useWriteBranchId()
  const activeBranches = branches.filter(b => b.isActive)
  const [shiftBranchId, setShiftBranchId] = useState<string | null>(null)
  const [pickedBranchId, setPickedBranchId] = useState<string | null>(null)
  const showBranchPicker = multiBranch && canSeeAllBranches && activeBranchId === null
  const pickedValid = !!pickedBranchId && activeBranches.some(b => b.id === pickedBranchId)
  const posBranchId: string | null = shiftBranchId
    ?? (showBranchPicker && pickedValid ? pickedBranchId : writeBranchId)
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
    // Local session read (no Auth round trip); RLS still enforces access.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setShiftLoading(false); return }
    const { data: userRow } = await supabase.from('users').select('id, full_name, role').eq('id', user.id).single()
    setCurrentUser({ id: user.id, fullName: userRow?.full_name ?? user.email ?? '' })
    setUserRole(userRow?.role ?? '')
    // Header branch filter: a concrete branch only finds a shift opened in
    // it; owner/admin on "All branches" pick up any open shift and the POS
    // locks to that shift's branch.
    const { data: shiftRow } = await applyBranch(supabase.from('shifts').select('*')
      .eq('cashier_id', user.id).eq('status', 'active'))
      .order('started_at', { ascending: false }).limit(1).maybeSingle()
    setActiveShift(shiftRow as Shift | null)
    setShiftBranchId((shiftRow as { branch_id?: string | null } | null)?.branch_id ?? null)
    setShiftLoading(false)
  }, [applyBranch])

  useEffect(() => { fetchShiftState() }, [fetchShiftState])
  useEffect(() => {
    const supabase = createClient()
    supabase.from('companies').select('name').single().then(({ data }) => {
      if (data) {
        const row = data as unknown as { name: string }
        setCompanyName(row.name)
      }
    })
    // Gift settings — separate query so the company name still loads if the
    // gift migration hasn't been applied yet.
    supabase.from('companies').select('max_gift_percent, gift_staff_allowed').single().then(({ data }) => {
      if (data) {
        const row = data as unknown as { max_gift_percent: number; gift_staff_allowed: boolean }
        setGiftSettings({ maxPercent: Number(row.max_gift_percent) || 0, staffAllowed: !!row.gift_staff_allowed })
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
    // branch_id isn't in the generated shifts Insert type yet - cast. Omitted
    // when unknown so the DB fill trigger picks the user's branch as before.
    const { data, error } = await supabase.from('shifts').insert({
      company_id: companyId, cashier_id: currentUser.id, cashier_name: currentUser.fullName,
      initial_cash: 0, status: 'active' as const,
      ...(posBranchId ? { branch_id: posBranchId } : {}),
    } as Database['public']['Tables']['shifts']['Insert']).select().single()
    setStartingShift(false)
    if (error || !data) {
      const branchKey = branchStockErrorKey(error?.message)
      toast.error(branchKey ? t(branchKey) : t('common.error'))
      return
    }
    setActiveShift(data as Shift)
    setShiftBranchId((data as { branch_id?: string | null }).branch_id ?? posBranchId)
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
    setCloseReportOpen(false); setShiftSummary(null); setActiveShift(null); setShiftBranchId(null)
  }

  // product_sizes.id → all warehouse rows of the same variant (incl. itself).
  const variantRowsRef = useRef<Map<string, { id: string; stock: number }[]>>(new Map())

  const fetchProducts = useCallback(async (): Promise<PosItem[]> => {
    const supabase = createClient()
    let catalogData: ProductCatalogRow[] = []
    let sizesData: ProductSizeRow[] = []
    // One round trip, no PostgREST 1000-row cap (returns a single jsonb).
    type Catalog = { products: ProductCatalogRow[]; sizes: ProductSizeRow[] }
    let { data: rpcData, error: rpcError } = await callRpc<Catalog>(supabase, 'pos_catalog', { p_branch_id: posBranchId })
    if ((rpcError || !rpcData) && !multiBranch) {
      // Pre-branch DB: pos_catalog() has no p_branch_id yet. With one branch
      // the unfiltered catalog is the same thing.
      ({ data: rpcData, error: rpcError } = await callRpc<Catalog>(supabase, 'pos_catalog'))
    }
    if (!rpcError && rpcData) {
      catalogData = rpcData.products ?? []
      sizesData = rpcData.sizes ?? []
    } else {
      // Fallback (RPC not deployed yet): page through both tables so big
      // catalogs aren't silently truncated at 1000 rows.
      const [catalogRes, sizesRes] = await Promise.all([
        fetchAllRows((from, to) =>
          supabase.from('products').select('id, name, sku, category, price, status, image_url').eq('status', 'active').order('id').range(from, to)),
        // Unfiltered (including stock=0 rows): the variant matrix needs every
        // size/color a product has ever been stocked in, so it can show
        // zero-stock cells grayed-out rather than omitting them.
        fetchAllRows((from, to) => {
          const q = supabase.from('product_sizes').select('id, product_id, size, color, stock, purchase_price, selling_price, sku, companion_product_size_id')
          return eqBranch(q, posBranchId).order('id').range(from, to)
        }),
      ])
      catalogData = catalogRes.data as unknown as ProductCatalogRow[]
      sizesData = sizesRes.data as unknown as ProductSizeRow[]
    }
    const catalogMap = new Map(catalogData.map(p => [p.id, p]))
    // One POS item per variant: a variant stocked in several warehouses has
    // one product_sizes row per warehouse — merge them.
    const byVariant = new Map<string, ProductSizeRow[]>()
    for (const sz of sizesData) {
      if (!catalogMap.has(sz.product_id)) continue
      const k = `${sz.product_id}|${sz.size}|${sz.color ?? ''}`
      const list = byVariant.get(k)
      if (list) list.push(sz)
      else byVariant.set(k, [sz])
    }
    const items: PosItem[] = []
    const rowMap = new Map<string, { id: string; stock: number }[]>()
    for (const group of byVariant.values()) {
      group.sort((a, b) => b.stock - a.stock)
      const sz = group[0]
      const p = catalogMap.get(sz.product_id)!
      const rows = group.map(g => ({ id: g.id, stock: g.stock }))
      for (const r of rows) rowMap.set(r.id, rows)
      items.push({
        id: sz.id,
        productId: p.id,
        productName: p.name,
        category: p.category,
        size: sz.size,
        color: sz.color ?? '',
        stock: group.reduce((s, g) => s + g.stock, 0),
        price: sz.selling_price > 0 ? sz.selling_price : p.price,
        purchasePrice: sz.purchase_price,
        sku: sz.sku ?? p.sku ?? '',
        imageUrl: p.image_url ?? '',
        companionId: group.find(g => g.companion_product_size_id)?.companion_product_size_id ?? null,
        rows,
      })
    }
    variantRowsRef.current = rowMap
    items.sort((a, b) => a.productName.localeCompare(b.productName) || a.size.localeCompare(b.size))
    setPosItems(items)
    return items
  }, [posBranchId, multiBranch])

  // Re-reads stock for just the given product_sizes rows and patches local
  // state — after a sale only the sold variants changed, so re-downloading
  // the whole catalog (thousands of rows in a big store) is wasted time.
  const refreshStock = useCallback(async (rowIds: string[]) => {
    const ids = [...new Set(rowIds)]
    if (ids.length === 0) return
    const supabase = createClient()
    const stockById = new Map<string, number>()
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await supabase.from('product_sizes').select('id, stock').in('id', ids.slice(i, i + 150))
      if (error) { await fetchProducts(); return }
      for (const r of data ?? []) stockById.set(r.id, r.stock)
    }
    setPosItems(prev => prev.map(item => {
      if (!item.rows.some(r => stockById.has(r.id))) return item
      const rows = item.rows.map(r => ({ id: r.id, stock: stockById.get(r.id) ?? r.stock }))
      for (const r of rows) variantRowsRef.current.set(r.id, rows)
      return { ...item, rows, stock: rows.reduce((sum, r) => sum + r.stock, 0) }
    }))
  }, [fetchProducts])

  const fetchCustomers = useCallback(async () => {
    const supabase = createClient()
    const { data, error } = await fetchAllRows((from, to) => {
      const q = supabase.from('customers').select('id, full_name, phone, price_list_id')
      return eqBranch(q, posBranchId).order('id').range(from, to)
    })
    if (error) toast.error(t('common.error'))
    else setCustomers((data as unknown as CustomerRow[]).map(mapCustomerLite))
  }, [t, posBranchId])

  // Price lists (wholesale etc.) for customers attached to one. Preview only —
  // sell_cart recomputes the same price server-side.
  const [priceLists, setPriceLists] = useState<PriceList[]>([])
  const [plOverrides, setPlOverrides] = useState<Map<string, number>>(new Map())
  const fetchPriceLists = useCallback(async () => {
    const supabase = createClient()
    const [{ data: lists }, { data: items }] = await Promise.all([
      supabase.from('price_lists').select('id, name, base, adjust_percent, rounding, is_active'),
      fetchAllRows<{ price_list_id: string; product_size_id: string; price: number }>((from, to) =>
        supabase.from('price_list_items').select('price_list_id, product_size_id, price').order('product_size_id').range(from, to)),
    ])
    setPriceLists(((lists ?? []) as PriceListRow[]).map(mapPriceList))
    setPlOverrides(new Map(items.map(i => [`${i.price_list_id}|${i.product_size_id}`, Number(i.price)])))
  }, [])

  // Customers + price lists in one round trip; falls back to the separate
  // (paged) fetches if the RPC isn't deployed yet.
  const fetchLookups = useCallback(async () => {
    const supabase = createClient()
    type Lookups = {
      customers: CustomerRow[]
      price_lists: PriceListRow[]
      price_list_items: { price_list_id: string; product_size_id: string; price: number }[]
    }
    let { data, error } = await callRpc<Lookups>(supabase, 'pos_lookups', { p_branch_id: posBranchId })
    if ((error || !data) && !multiBranch) {
      // Pre-branch DB: pos_lookups() has no p_branch_id yet (one branch = same data).
      ({ data, error } = await callRpc<Lookups>(supabase, 'pos_lookups'))
    }
    if (error || !data) {
      await Promise.all([fetchCustomers(), fetchPriceLists()])
      return
    }
    setCustomers((data.customers ?? []).map(mapCustomerLite))
    setPriceLists((data.price_lists ?? []).map(mapPriceList))
    setPlOverrides(new Map((data.price_list_items ?? []).map(i => [`${i.price_list_id}|${i.product_size_id}`, Number(i.price)])))
  }, [fetchCustomers, fetchPriceLists, posBranchId, multiBranch])

  // Waits for the session (branch list) and the shift (its branch locks the
  // POS) so the catalog isn't downloaded twice on load; re-runs when the POS
  // branch changes.
  useEffect(() => {
    if (sessionLoading || shiftLoading) return
    setLoading(true)
    Promise.all([fetchProducts(), fetchLookups()]).finally(() => setLoading(false))
  }, [fetchProducts, fetchLookups, sessionLoading, shiftLoading])

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('Barchasi')

  const tabIdRef = useRef(1)
  const [tabs, setTabs] = useState<OrderTab[]>(() => [createEmptyTab('tab-1')])
  const [activeTabId, setActiveTabId] = useState('tab-1')

  // Cart lines / customers belong to one branch's stock: switching the POS
  // branch (picker or header switcher) starts with fresh, empty tabs.
  const lastBranchRef = useRef<string | null>(posBranchId)
  useEffect(() => {
    if (lastBranchRef.current === posBranchId) return
    const hadBranch = lastBranchRef.current !== null
    lastBranchRef.current = posBranchId
    if (!hadBranch) return
    tabIdRef.current += 1
    const id = `tab-${tabIdRef.current}`
    setTabs([createEmptyTab(id)])
    setActiveTabId(id)
  }, [posBranchId])

  function pickPosBranch(id: string) {
    if (id === posBranchId) return
    if (tabs.some(tb => tb.cart.length > 0) && !window.confirm(t('branchStock.switchConfirm'))) return
    setPickedBranchId(id)
  }

  const activeTab = tabs.find(tb => tb.id === activeTabId) ?? tabs[0]
  const { cart: rawCart, customerId, paymentMethod, amountReceived, manualDiscount: rawManualDiscount = '', selectedPromotion: tabPromotion } = activeTab

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
  // Last raw scan value actually dispatched to performBarcodeLookup — lets
  // the debounce timer and the Enter keydown handler (which both call
  // performBarcodeLookup for the same physical scan) detect that the other
  // one already handled it, regardless of which of the two fires first.
  const lastDispatchedScanRef = useRef<string | null>(null)
  const [manualBarcodeOpen, setManualBarcodeOpen] = useState(false)
  const [manualBarcodeValue, setManualBarcodeValue] = useState('')
  const manualBarcodeInputRef = useRef<HTMLInputElement>(null)

  const customer = customers.find(c => c.id === customerId) ?? null
  const customerPriceList = customer?.priceListId ? priceLists.find(p => p.id === customer.priceListId && p.isActive) ?? null : null
  // With a price list the list price is final (server ignores promotions
  // for these customers), so the promotion preview is switched off too.
  const cart = customerPriceList
    ? rawCart.map(l => ({ ...l, unitPrice: computeListPrice(customerPriceList, l.unitPrice, l.purchasePrice, plOverrides.get(`${customerPriceList.id}|${l.productSizeId}`)) }))
    : rawCart
  const selectedPromotion = customerPriceList ? null : tabPromotion

  // Selected customer's past purchases, so the cashier can answer "what did I
  // pay for this last time?". Newest first; gifts, cancelled cheques and
  // fully returned lines are skipped.
  const [pastPurchases, setPastPurchases] = useState<PastPurchase[]>([])
  useEffect(() => {
    if (!customerId) { setPastPurchases([]); return }
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('transaction_items')
      .select('product_id, product_size_id, product_name, price, quantity, returned_quantity, product_sizes(size, color), products(name, category), transactions!inner(date, customer_id, status)')
      .eq('transactions.customer_id', customerId)
      .neq('transactions.status', 'cancelled')
      .eq('is_gift', false)
      .limit(2000)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { setPastPurchases([]); return }
        const rows = (data ?? []) as unknown as PastPurchaseRow[]
        setPastPurchases(rows
          .filter(r => r.product_id && Number(r.quantity) > Number(r.returned_quantity ?? 0))
          .map(r => {
            const one = <T,>(v: T | T[] | null): T | null => Array.isArray(v) ? v[0] ?? null : v
            const tx = one(r.transactions)
            const ps = one(r.product_sizes)
            const pr = one(r.products)
            return {
              productId: r.product_id as string, productSizeId: r.product_size_id,
              productName: r.product_name || pr?.name || '', size: ps?.size ?? '', color: ps?.color ?? '', category: pr?.category ?? '',
              price: Number(r.price), quantity: Number(r.quantity), date: tx?.date ?? '',
            }
          })
          .sort((a, b) => b.date.localeCompare(a.date)))
      })
    return () => { cancelled = true }
  }, [customerId])

  // Last purchase for a cart line: same variant (any of its warehouse rows)
  // first, otherwise the latest purchase of the same product.
  const lastPurchaseFor = useCallback((line: CartLine): { purchase: PastPurchase; sameVariant: boolean } | null => {
    const item = posItems.find(i => i.id === line.key)
    const rowIds = new Set(item ? item.rows.map(r => r.id) : [line.productSizeId])
    const exact = pastPurchases.find(p => p.productSizeId && rowIds.has(p.productSizeId))
    if (exact) return { purchase: exact, sameVariant: true }
    const any = pastPurchases.find(p => p.productId === line.productId)
    return any ? { purchase: any, sameVariant: false } : null
  }, [pastPurchases, posItems])

  const [pastPurchasesOpen, setPastPurchasesOpen] = useState(false)

  // A past purchase maps back to today's POS item: the same variant if it is
  // still stocked, otherwise the product's variant picker.
  function resolvePastPurchase(p: PastPurchase): { item: PosItem } | { group: ProductGroupCard } | null {
    const item = p.productSizeId ? posItems.find(i => i.rows.some(r => r.id === p.productSizeId)) : undefined
    if (item && item.stock > 0) return { item }
    const group = productGroups.find(g => g.productId === p.productId)
    return group && group.totalStock > 0 ? { group } : null
  }

  function addPastPurchase(p: PastPurchase) {
    const target = resolvePastPurchase(p)
    if (!target) { toast.error(t('pos.noSizesAvailable')); return }
    setPastPurchasesOpen(false)
    if ('item' in target) addToCart(target.item)
    else setMatrixProduct(target.group)
  }

  // Per-ml perfume: ask the cashier how many ml before adding.
  const [mlPrompt, setMlPrompt] = useState<{ item: PosItem; value: string } | null>(null)

  function addToCart(item: PosItem, mlQty?: number) {
    if (item.stock <= 0) { toast.error(t('pos.noSizesAvailable')); return }
    const qty = mlQty ?? 1
    if (isPerMl(item.size) && mlQty === undefined) {
      setMatrixProduct(null)
      setMlPrompt({ item, value: '' })
      return
    }
    const key = item.id  // product_sizes.id
    updateActiveTab(tab => {
      const existing = tab.cart.find(l => l.key === key)
      if (existing) {
        if (existing.quantity >= item.stock) return tab
        return { ...tab, cart: syncBottles(tab.cart.map(l => l.key === key ? { ...l, quantity: Math.min(item.stock, l.quantity + qty) } : l), posItems) }
      }
      return {
        ...tab,
        cart: syncBottles([...tab.cart, { key, productSizeId: item.id, companionId: item.companionId, bottleDropped: false, productId: item.productId, productName: item.productName, size: item.size, unitPrice: item.price, purchasePrice: item.purchasePrice, quantity: Math.min(item.stock, qty), maxStock: item.stock, isGift: false }], posItems),
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

    // limit(1), not maybeSingle(): a variant stocked in several warehouses
    // has one row per warehouse, all sharing the barcode.
    let barcodeQuery = supabase
      .from('product_sizes')
      .select('id, product_id, size, color, stock')
      .eq('barcode', value)
      .eq('company_id', companyId)
    // Only this POS branch's warehouse rows are sellable here.
    barcodeQuery = eqBranch(barcodeQuery, posBranchId)
    const { data: matches, error } = await barcodeQuery.limit(1)
    const data = matches?.[0] ?? null

    if (error || !data) {
      // Fallback: no variant matched — try the product-level barcode and, if
      // it matches, open that product's variant matrix so the cashier can
      // pick the size themselves.
      const { data: productMatch } = await supabase
        .from('products')
        .select('id')
        .eq('barcode', value)
        .eq('company_id', companyId)
        .maybeSingle()
      if (productMatch) {
        let group = productGroups.find(g => g.productId === productMatch.id)
        if (!group) {
          // Product may not be in local state yet — refetch and rebuild the card.
          const refreshed = await fetchProducts()
          const variants = refreshed.filter(p => p.productId === productMatch.id)
          if (variants.length > 0) {
            group = {
              productId: productMatch.id,
              productName: variants[0].productName,
              category: variants[0].category,
              imageUrl: variants[0].imageUrl,
              totalStock: variants.reduce((sum, v) => sum + v.stock, 0),
              variants,
            }
          }
        }
        if (group) {
          setMatrixProduct(group)
          setManualBarcodeOpen(false)
          return
        }
      }
      toast.error(t('pos.barcode.notFound'))
      return
    }

    // The scanned row may not be in local state yet (e.g. just stocked in
    // from another till) — refetch once before giving up.
    const matchesRow = (p: PosItem) => p.rows.some(r => r.id === data.id)
    let item = posItems.find(matchesRow)
    if (!item) {
      const refreshed = await fetchProducts()
      item = refreshed.find(matchesRow)
    }
    if (!item) {
      toast.error(t('pos.barcode.notFound'))
      return
    }

    if (item.stock <= 0) {
      toast.error(`${t('pos.barcode.outOfStock')} — ${item.productName} ${colorOrDefault(item.color)} ${item.size}`)
      return
    }

    addToCart(item)
    if (isPerMl(item.size)) { setManualBarcodeOpen(false); return }
    toast.success(t('pos.barcode.added'), {
      description: `${colorOrDefault(item.color)} ${item.size} — ${item.productName}`,
      duration: 1500,
    })
    setManualBarcodeOpen(false)
  }

  // Routes both the debounce-timer path and the Enter-keydown path through a
  // single guard: if the timer already fired (dispatched this exact value)
  // before Enter's keydown was processed — the race described above — the
  // second call is dropped instead of adding the scanned item twice.
  function dispatchBarcodeLookup(value: string) {
    const trimmed = value.trim()
    if (trimmed && lastDispatchedScanRef.current === trimmed) return
    lastDispatchedScanRef.current = trimmed || null
    performBarcodeLookup(value)
  }

  function scheduleBarcodeLookup(value: string) {
    // Clearing the timer only cancels it if it hasn't fired yet — a stale
    // non-null ref doesn't mean there's still a pending timer to cancel, so
    // null it out immediately (both here and when the timer itself runs)
    // rather than leaving a dangling reference.
    if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null }
    scanTimerRef.current = setTimeout(() => {
      scanTimerRef.current = null
      dispatchBarcodeLookup(value)
      setScanValue('')
    }, 80)
  }

  function handleScanChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setScanValue(value)
    // A new keystroke means this is a new scan sequence — allow its own
    // lookup through even if it happens to match a previously-dispatched value.
    lastDispatchedScanRef.current = null
    scheduleBarcodeLookup(value)
  }

  function handleScanKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null }
      dispatchBarcodeLookup(scanValue)
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
  // Also left alone: any click inside an open dialog (role="dialog" — every
  // modal on this page, incl. the manual barcode entry one, renders via the
  // same Base UI Dialog primitive and gets this role). Dialogs render into a
  // portal appended to <body>, so their clicks still bubble to `document`;
  // without this exclusion, clicking anywhere in an open dialog that isn't
  // literally the <input> itself (its title, padding, footer, ...) silently
  // steals focus back to the hidden scanner input, and further keystrokes
  // stop reaching the visible field the cashier is looking at.
  useEffect(() => {
    function handlePageClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select, [role="dialog"], [role="alertdialog"]')) return
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
      cart: syncBottles(tab.cart.map(l => (l.key === key && !l.companionOf && l.quantity < l.maxStock) ? { ...l, quantity: l.quantity + 1 } : l), posItems),
    }))
  }

  function setLineQty(key: string, qty: number) {
    updateActiveTab(tab => ({
      ...tab,
      cart: syncBottles(tab.cart.map(l => (l.key === key && !l.companionOf) ? { ...l, quantity: Math.max(1, Math.min(l.maxStock, Math.floor(qty) || 1)) } : l), posItems),
    }))
  }

  function confirmMlPrompt() {
    if (!mlPrompt) return
    const ml = Math.floor(Number(mlPrompt.value))
    if (!ml || ml <= 0) return
    if (ml > mlPrompt.item.stock) { toast.error(`${t('pos.perMl.notEnough')}: ${mlPrompt.item.stock} ml`); return }
    addToCart(mlPrompt.item, ml)
    setMlPrompt(null)
  }

  function decrementLine(key: string) {
    updateActiveTab(tab => {
      const line = tab.cart.find(l => l.key === key)
      if (!line || line.companionOf) return tab
      if (line.quantity <= 1) return { ...tab, cart: syncBottles(tab.cart.filter(l => l.key !== key), posItems) }
      return { ...tab, cart: syncBottles(tab.cart.map(l => l.key === key ? { ...l, quantity: l.quantity - 1 } : l), posItems) }
    })
  }

  function removeLine(key: string) {
    updateActiveTab(tab => {
      const line = tab.cart.find(l => l.key === key)
      // Removing a bottle line only drops the bottle (customer brought their own).
      if (line?.companionOf) {
        return { ...tab, cart: syncBottles(tab.cart.map(l => l.key === line.companionOf ? { ...l, bottleDropped: true } : l), posItems) }
      }
      return { ...tab, cart: syncBottles(tab.cart.filter(l => l.key !== key), posItems) }
    })
  }

  // Flip a line between paid and gift. Gift lines live under their own key
  // (`gift:<product_size_id>`) so scanning the same item again adds a paid
  // line instead of growing the gift; flipping merges into an existing line
  // of the target kind.
  function toggleGift(key: string) {
    updateActiveTab(tab => {
      const line = tab.cart.find(l => l.key === key)
      if (!line || line.companionOf) return tab
      const toGift = !line.isGift
      const targetKey = toGift ? `gift:${line.productSizeId}` : line.productSizeId
      const target = tab.cart.find(l => l.key === targetKey)
      let next: CartLine[]
      if (target) {
        next = tab.cart
          .filter(l => l.key !== key)
          .map(l => l.key === targetKey ? { ...l, quantity: l.quantity + line.quantity } : l)
      } else {
        next = tab.cart.map(l => l.key === key ? { ...l, key: targetKey, isGift: toGift } : l)
      }
      return { ...tab, cart: syncBottles(next, posItems) }
    })
  }

  function resetSale() {
    updateActiveTab(tab => ({ ...tab, cart: [], customerId: '', paymentMethod: '', amountReceived: '', manualDiscount: '', selectedPromotion: null }))
  }

  // ─── Promotion selector ("Aksiya qo'llash") ────────────────────────────
  const [promotionModalOpen, setPromotionModalOpen] = useState(false)
  const [promotionsLoading, setPromotionsLoading] = useState(false)
  const [activePromotions, setActivePromotions] = useState<Promotion[]>([])

  async function openPromotionModal() {
    setPromotionModalOpen(true)
    setPromotionsLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('promotions').select('*').eq('is_active', true)
    if (error) {
      toast.error(t('common.error'))
      setPromotionsLoading(false)
      return
    }
    const today = localYmd()
    const rows = (data as PromotionRow[])
      .filter(r => (!r.starts_on || r.starts_on <= today) && (!r.ends_on || r.ends_on >= today))
      .map(mapPromotion)
    setActivePromotions(rows)
    setPromotionsLoading(false)
  }

  function selectPromotion(p: Promotion) {
    updateActiveTab(tab => ({ ...tab, selectedPromotion: { id: p.id, name: p.name, discountPercent: p.discountPercent } }))
    setPromotionModalOpen(false)
  }

  function clearSelectedPromotion() {
    updateActiveTab(tab => ({ ...tab, selectedPromotion: null }))
  }

  // Reuses the marketing.aksiya i18n namespace rather than duplicating the
  // same scope/date-range copy under a second key — same three scope
  // labels and "no date" string are already defined there.
  function promotionScopeLabel(p: Promotion): string {
    if (p.scopeType === 'store') return t('marketing.aksiya.scopeLabel.store')
    if (p.scopeType === 'category') return `${t('marketing.aksiya.scopeLabel.category')}: ${p.category ?? ''}`
    return t('marketing.aksiya.scopeLabel.product')
  }

  function promotionDateRange(p: Promotion): string {
    if (!p.startsOn && !p.endsOn) return t('marketing.aksiya.noDate')
    const start = p.startsOn ? formatDate(p.startsOn) : t('marketing.aksiya.noDate')
    const end = p.endsOn ? formatDate(p.endsOn) : t('marketing.aksiya.noDate')
    return `${start} – ${end}`
  }

  const cartCount = cart.reduce((s, l) => s + l.quantity, 0)
  // Catalog-price estimate only — the actual charged amount is derived
  // server-side by sell_cart from active promotions and the customer's VIP
  // status, so this is not a guaranteed final price.
  const subtotal = cart.reduce((s, l) => s + (l.isGift ? 0 : l.unitPrice * l.quantity), 0)
  const giftAmount = cart.reduce((s, l) => s + (l.isGift ? l.unitPrice * l.quantity : 0), 0)
  // Client-side preview only: applies the selected promotion's percent
  // uniformly across the cart (no scope_type/product/category matching —
  // sell_cart doesn't read promotion_id yet, so this is a simplified
  // estimate, consistent with pos.estimateNote's "may differ" framing).
  const promoDiscountAmount = selectedPromotion ? Math.round(subtotal * selectedPromotion.discountPercent / 100) : 0
  // Paid total before the cashier's manual discount — gift limits use this.
  const totalBeforeDiscount = subtotal - promoDiscountAmount
  const manualDiscount = Math.max(0, Number(rawManualDiscount) || 0)
  const discountTooBig = manualDiscount > totalBeforeDiscount
  const total = Math.max(0, totalBeforeDiscount - manualDiscount)
  // Per-line breakdown for the cart list: each line's promo-discounted unit
  // price/total, computed independently per line (no cross-line remainder
  // distribution needed — that only existed to split a single whole-cart
  // cashback amount across lines, which no longer applies here).
  const cartLineDiscounts = cart.map(line => {
    if (line.isGift) return { promoUnitPrice: 0, finalLineTotal: 0 }
    const promoUnitPrice = selectedPromotion
      ? Math.round(line.unitPrice * (1 - selectedPromotion.discountPercent / 100))
      : line.unitPrice
    return { promoUnitPrice, finalLineTotal: promoUnitPrice * line.quantity }
  })
  const received = Number(amountReceived) || 0
  const change = Math.max(0, received - total)

  // Paid and gift lines of the same variant share one stock pool.
  const qtyBySize = new Map<string, number>()
  for (const l of cart) qtyBySize.set(l.productSizeId, (qtyBySize.get(l.productSizeId) ?? 0) + l.quantity)
  const isLineShort = (l: CartLine) => (qtyBySize.get(l.productSizeId) ?? 0) > l.maxStock
  const hasStockShortage = cart.some(isLineShort)
  const giftLimit = giftSettings ? Math.floor(totalBeforeDiscount * giftSettings.maxPercent / 100) : 0
  const giftError = giftAmount <= 0
    ? null
    : !canGift
      ? t('pos.gift.forbidden')
      : totalBeforeDiscount <= 0
        ? t('pos.gift.needsPaidItem')
        : giftAmount > giftLimit
          ? t('pos.gift.limitExceeded')
          : null
  const canSell = cart.length > 0 && !hasStockShortage && !giftError && !discountTooBig && paymentMethod !== '' && (!features.shift_system || !!activeShift)

  async function handleSell() {
    if (!canSell) return
    setSelling(true)
    const supabase = createClient()

    const today = localYmd()
    const customerName = customer?.fullName ?? t('dashboard.recentSales.guestCustomer')

    // Bottle lines are separate cart lines but merge here if the same bottle
    // is also present twice (e.g. two perfumes sharing one bottle size) so
    // sell_cart sees one line per product_size.
    const perVariant = new Map<string, { product_size_id: string; quantity: number; is_gift: boolean }>()
    for (const line of cart) {
      const k = `${line.productSizeId}|${line.isGift ? 1 : 0}`
      const prev = perVariant.get(k)
      if (prev) prev.quantity += line.quantity
      else perVariant.set(k, { product_size_id: line.productSizeId, quantity: line.quantity, is_gift: line.isGift })
    }
    // A variant held in several warehouses: take the quantity from its
    // warehouse rows, most stock first. Any shortfall stays on the first row
    // so sell_cart reports "insufficient stock" as before.
    const merged = new Map<string, { product_size_id: string; quantity: number; is_gift: boolean }>()
    const used = new Map<string, number>()
    const put = (id: string, quantity: number, isGift: boolean) => {
      const k = `${id}|${isGift ? 1 : 0}`
      const prev = merged.get(k)
      if (prev) prev.quantity += quantity
      else merged.set(k, { product_size_id: id, quantity, is_gift: isGift })
      used.set(id, (used.get(id) ?? 0) + quantity)
    }
    for (const it of perVariant.values()) {
      const rows = variantRowsRef.current.get(it.product_size_id)
      if (!rows || rows.length < 2) { put(it.product_size_id, it.quantity, it.is_gift); continue }
      let left = it.quantity
      for (const r of rows) {
        if (left <= 0) break
        const take = Math.min(left, Math.max(0, r.stock - (used.get(r.id) ?? 0)))
        if (take > 0) { put(r.id, take, it.is_gift); left -= take }
      }
      if (left > 0) put(rows[0].id, left, it.is_gift)
    }
    const items = Array.from(merged.values())
    // Every warehouse row of every variant in the cart — the only stock
    // that can change because of this sale.
    const touchedRowIds = cart.flatMap(l => (variantRowsRef.current.get(l.productSizeId) ?? [{ id: l.productSizeId }]).map(r => r.id))

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
        branch_id: posBranchId,
        // Not yet read by sell_cart (server derives discounts itself from
        // active promotions/VIP status) — carried through for future use,
        // e.g. attributing a sale to the promotion the cashier picked.
        promotion_id: selectedPromotion?.id ?? null,
        manual_discount: manualDiscount,
      },
    })

    setSelling(false)

    if (error || !transactionId) {
      const branchKey = branchStockErrorKey(error?.message)
      if (branchKey) {
        toast.error(t(branchKey))
        // A stale shift (closed elsewhere / other branch): re-read it so the
        // open-shift dialog shows up again.
        if (error?.message.includes('invalid_shift')) fetchShiftState()
      } else if (error?.message.includes('discount_exceeds_total') || error?.message.includes('invalid_discount')) {
        toast.error(t('pos.manualDiscount.tooBig'))
      } else if (error?.message.includes('gift_forbidden')) {
        toast.error(t('pos.gift.forbidden'))
      } else if (error?.message.includes('gift_requires_paid_item')) {
        toast.error(t('pos.gift.needsPaidItem'))
      } else if (error?.message.includes('gift_limit_exceeded')) {
        toast.error(t('pos.gift.limitExceeded'))
      } else if (error?.message.includes('forbidden')) {
        toast.error(t('common.forbidden'))
      } else if (error?.message.includes('Invalid customer_id for this company')) {
        // sell_cart raises this when the selected customer doesn't belong
        // to the caller's company.
        toast.error(t('pos.invalidCustomer'), { duration: 1500 })
      } else {
        // sell_cart raises "Insufficient stock for product_size <uuid>" — pull the
        // uuid back out so the toast names the item instead of a generic error.
        const failedId = error?.message.match(/product_size ([0-9a-f-]{36})/i)?.[1]
        const failedItem = failedId ? posItems.find(p => p.rows.some(r => r.id === failedId)) : undefined
        toast.error(failedItem ? `${t('pos.noSizesAvailable')}: ${failedItem.productName} (${failedItem.size})` : t('common.error'))
      }
      await refreshStock(touchedRowIds)
      return
    }

    await refreshStock(touchedRowIds)
    toast.success(t('pos.success.title'))
    setReceiptData({
      companyName,
      date: new Date().toLocaleDateString('uz-UZ'),
      receiptNumber: transactionId.slice(-6).toUpperCase(),
      // Preview-only: show the discounted per-line price on the receipt when
      // a promotion was selected, matching the total the cashier/customer
      // saw during the sale (the actual charged amount is still confirmed
      // server-side by sell_cart).
      items: cart.map(line => ({
        name: line.isGift ? `${line.productName} (${t('pos.gift.badge')})` : line.productName,
        size: isPerMl(line.size) ? `${line.quantity} ml` : line.size,
        quantity: isPerMl(line.size) ? 1 : line.quantity,
        price: (isPerMl(line.size) ? line.quantity : 1) * (line.isGift ? 0 : selectedPromotion ? Math.round(line.unitPrice * (1 - selectedPromotion.discountPercent / 100)) : line.unitPrice),
      })),
      discount: manualDiscount,
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
        {showBranchPicker && (
          <div className="ml-auto flex items-center gap-2" title={activeShift ? t('branchStock.shiftLockedHint') : undefined}>
            <span className="text-[13px] text-gray-500 dark:text-gray-400">{t('branchStock.posBranch')}</span>
            <select
              value={posBranchId ?? ''}
              onChange={e => pickPosBranch(e.target.value)}
              disabled={!!activeShift}
              aria-label={t('branchStock.posBranch')}
              className="h-9 max-w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors disabled:opacity-60"
            >
              {!posBranchId && <option value="" disabled>{t('branches.errors.branchRequired')}</option>}
              {posBranchId && !activeBranches.some(b => b.id === posBranchId) && (
                <option value={posBranchId}>{branches.find(b => b.id === posBranchId)?.name ?? ''}</option>
              )}
              {activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
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
                tb.id === activeTabId ? 'bg-indigo-600 dark:bg-indigo-500 shadow-sm border border-indigo-600 dark:border-indigo-500 text-white' : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800')}>
              <span>{t('pos.tabs.label')} #{i + 1}</span>
              {tb.cart.length > 0 && <span className="tabular-nums opacity-70">({tb.cart.reduce((s, l) => s + l.quantity, 0)})</span>}
              {tabs.length > 1 && <X className="h-3.5 w-3.5 opacity-60 hover:opacity-100" onClick={e => { e.stopPropagation(); closeTab(tb.id) }} />}
            </button>
          ))}
          {tabs.length < MAX_TABS && (
            <button onClick={addTab} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors">
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex flex-1 flex-col lg:flex-row min-h-0">
          {/* LEFT — Products (65%) */}
          <div className="flex flex-col lg:w-[65%] bg-gray-50 dark:bg-gray-950 min-h-0">
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
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-gray-900 dark:text-gray-100 truncate">{customer.fullName}</p>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500">{formatPhone(customer.phone)}</p>
                        {customerPriceList && (
                          <span className="mt-1 inline-block rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-0.5 text-[10.5px] font-medium text-gray-700 dark:text-gray-300">
                            {t('pos.priceList')}: {customerPriceList.name}
                          </span>
                        )}
                        <button
                          onClick={() => setPastPurchasesOpen(true)}
                          className="mt-1.5 flex items-center gap-1 text-[11.5px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                        >
                          <History className="h-3.5 w-3.5" />
                          {t('pos.pastPurchases.button')}
                          <span className="tabular-nums text-gray-400 dark:text-gray-500">({new Set(pastPurchases.map(p => p.productSizeId ? `${p.productId}|${p.size}|${p.color}` : p.productId)).size})</span>
                        </button>
                      </div>
                      <button onClick={() => updateActiveTab(tab => ({ ...tab, customerId: '' }))} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
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
                  {cart.map((line, i) => {
                    // Preview-only estimate — see promoDiscountAmount comment above.
                    const { promoUnitPrice, finalLineTotal } = cartLineDiscounts[i]
                    const hasLineDiscount = !!selectedPromotion && !line.isGift
                    return (
                    <div key={line.key} className={cn('flex items-center justify-between gap-2 py-3', i > 0 && 'border-t border-gray-100 dark:border-gray-800')}>
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                          {line.productName} <span className="text-gray-400 dark:text-gray-500">· {isPerMl(line.size) ? `${line.quantity} ml` : line.size}</span>
                          {line.companionOf && (
                            <span className="ml-1.5 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-400 whitespace-nowrap">
                              {t('pos.bottleBadge')}
                            </span>
                          )}
                          {line.isGift && (
                            <span className="ml-1.5 rounded-full bg-green-100 dark:bg-green-950/40 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400 whitespace-nowrap">
                              {t('pos.gift.badge')}
                            </span>
                          )}
                        </p>
                        {isLineShort(line) && (
                          <p className="text-xs text-red-500 mt-0.5">{t('pos.noSizesAvailable')}</p>
                        )}
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 tabular-nums">
                          {line.isGift ? (
                            <>
                              <span className="line-through text-gray-300 dark:text-gray-600 mr-1">{formatPrice(line.unitPrice)}</span>
                              {formatPrice(0)}
                            </>
                          ) : selectedPromotion ? (
                            <>
                              <span className="line-through text-gray-300 dark:text-gray-600 mr-1">{formatPrice(line.unitPrice)}</span>
                              {formatPrice(promoUnitPrice)}
                            </>
                          ) : (
                            formatPrice(line.unitPrice)
                          )}
                          {isPerMl(line.size) && ` / 1 ml`}
                          {customer && !line.companionOf && (() => {
                            const last = lastPurchaseFor(line)
                            if (!last) return null
                            const { purchase, sameVariant } = last
                            const hint = [t('pos.lastPurchase.label'), purchase.date && formatDate(purchase.date), !sameVariant && t('pos.lastPurchase.otherSize')].filter(Boolean).join(' · ')
                            return (
                              <span title={hint} className="ml-1 font-medium text-red-600 dark:text-red-400">← {formatPrice(purchase.price)}</span>
                            )
                          })()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {line.companionOf ? (
                          <span className="w-[4.25rem] text-center text-sm text-gray-900 dark:text-gray-100 tabular-nums">{line.quantity}</span>
                        ) : (
                        <div className="flex items-center gap-1">
                          <button onClick={() => decrementLine(line.key)} className="flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                            <Minus className="h-3 w-3" />
                          </button>
                          {isPerMl(line.size) ? (
                            <input
                              type="number" min={1} max={line.maxStock}
                              value={line.quantity}
                              onChange={e => setLineQty(line.key, Number(e.target.value))}
                              aria-label="ml"
                              className="h-6 w-12 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-1 text-center text-sm text-gray-900 dark:text-gray-100 tabular-nums outline-none focus:border-gray-400 dark:focus:border-gray-500"
                            />
                          ) : (
                          <span className="w-5 text-center text-sm text-gray-900 dark:text-gray-100 tabular-nums">{line.quantity}</span>
                          )}
                          <button onClick={() => incrementLine(line.key)} className="flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                            <Plus className="h-3 w-3" />
                          </button>
                        </div>
                        )}
                        {hasLineDiscount ? (
                          <div className="flex flex-col items-end gap-1 min-w-20">
                            <span className="text-[11px] line-through text-gray-300 dark:text-gray-600 tabular-nums">{formatPrice(line.unitPrice * line.quantity)}</span>
                            <span className="text-sm text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(finalLineTotal)}</span>
                            <div className="flex flex-wrap justify-end gap-1">
                              {selectedPromotion && (
                                <span className="rounded-full border border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400 whitespace-nowrap">
                                  {t('pos.lineBadge.promo')} −{selectedPromotion.discountPercent}%
                                </span>
                              )}
                            </div>
                          </div>
                        ) : line.isGift ? (
                          <div className="flex flex-col items-end min-w-20">
                            <span className="text-[11px] line-through text-gray-300 dark:text-gray-600 tabular-nums">{formatPrice(line.unitPrice * line.quantity)}</span>
                            <span className="text-sm text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(0)}</span>
                          </div>
                        ) : (
                          <span className="w-20 text-right text-sm text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(line.unitPrice * line.quantity)}</span>
                        )}
                        {canGift && !line.companionOf && (
                          <button
                            type="button"
                            onClick={() => toggleGift(line.key)}
                            aria-label={line.isGift ? t('pos.gift.unmark') : t('pos.gift.mark')}
                            title={line.isGift ? t('pos.gift.unmark') : t('pos.gift.mark')}
                            className={cn(
                              'flex h-6 w-6 items-center justify-center rounded-md transition-colors',
                              line.isGift
                                ? 'bg-indigo-600 dark:bg-indigo-500 shadow-sm border border-indigo-600 dark:border-indigo-500 text-white'
                                : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300',
                            )}
                          >
                            <Gift className="h-4 w-4" />
                          </button>
                        )}
                        <button onClick={() => removeLine(line.key)} aria-label={line.companionOf ? t('pos.removeBottle') : undefined} title={line.companionOf ? t('pos.removeBottle') : undefined} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    )
                  })}
                </div>
              )}

              {/* Promotion selector — cashier picks from currently active
                  promotions; the actual discount is still derived
                  server-side by sell_cart (highest of promotion vs. VIP),
                  this only carries the chosen promotion_id through for
                  future attribution. */}
              {cart.length > 0 && !customerPriceList && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={openPromotionModal}
                    className="flex h-9 w-full items-center justify-center rounded-lg border border-blue-600 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
                  >
                    {t('pos.applyPromotion')}
                  </button>
                  {selectedPromotion && (
                    <div className="flex items-center justify-between gap-2 rounded-full border border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 pl-3 pr-1.5 py-1">
                      <span className="text-[12px] font-medium text-blue-700 dark:text-blue-400 truncate">
                        {selectedPromotion.name} — {selectedPromotion.discountPercent}%
                      </span>
                      <button
                        type="button"
                        onClick={clearSelectedPromotion}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Summary + payment + sell */}
            {cart.length > 0 && (
              <div className="shrink-0 border-t border-gray-100 dark:border-gray-800 px-5 py-4 space-y-4">
                <div className="space-y-1">
                  {selectedPromotion && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500 dark:text-gray-400">{t('pos.promotionDiscount')}</span>
                      <span className="text-gray-900 dark:text-gray-100 tabular-nums">−{formatPrice(promoDiscountAmount)}</span>
                    </div>
                  )}
                  {giftAmount > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500 dark:text-gray-400">
                        {t('pos.gift.total')}
                        {giftSettings && giftSettings.maxPercent > 0 && (
                          <span className="ml-1 text-[11px] text-gray-400 dark:text-gray-500">({t('pos.gift.limit')}: {formatPrice(giftLimit)})</span>
                        )}
                      </span>
                      <span className="text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(giftAmount)}</span>
                    </div>
                  )}
                  {giftError && <p className="text-xs text-red-500">{giftError}</p>}
                  <div className="flex items-center justify-between gap-2 py-1">
                    <span className="text-sm text-gray-500 dark:text-gray-400">{t('pos.manualDiscount.label')}</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number" min={0} inputMode="numeric"
                        value={rawManualDiscount}
                        onChange={e => updateActiveTab(tab => ({ ...tab, manualDiscount: e.target.value }))}
                        placeholder="0"
                        aria-label={t('pos.manualDiscount.label')}
                        className={cn(
                          'h-8 w-32 rounded-lg border bg-white dark:bg-gray-900 px-2 text-right text-sm text-gray-900 dark:text-gray-100 tabular-nums outline-none transition-colors',
                          discountTooBig ? 'border-red-400 dark:border-red-500' : 'border-gray-200 dark:border-gray-700 focus:border-gray-400 dark:focus:border-gray-500',
                        )}
                      />
                      {rawManualDiscount !== '' && (
                        <button
                          type="button"
                          onClick={() => updateActiveTab(tab => ({ ...tab, manualDiscount: '' }))}
                          aria-label={t('pos.manualDiscount.clear')}
                          className="flex h-6 w-6 items-center justify-center rounded-full text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {discountTooBig && <p className="text-xs text-red-500">{t('pos.manualDiscount.tooBig')}</p>}
                  {manualDiscount > 0 && !discountTooBig && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400 dark:text-gray-500">{t('pos.manualDiscount.before')}</span>
                      <span className="text-gray-400 dark:text-gray-500 line-through tabular-nums">{formatPrice(totalBeforeDiscount)}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-base font-bold text-gray-900 dark:text-gray-100">{t('pos.payment')}</span>
                    <span className="text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(total)}</span>
                  </div>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('pos.estimateNote')}</p>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {PAYMENT_METHODS.map(method => (
                    <button key={method} onClick={() => updateActiveTab(tab => ({ ...tab, paymentMethod: method }))}
                      className={cn('h-9 rounded-lg border text-[12px] font-medium transition-colors',
                        paymentMethod === method ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600')}>
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
                    canSell && !selling ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed')}>
                  {selling ? <Loader2 className="h-4 w-4 animate-spin" /> : t('pos.sell')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Promotion selector modal */}
      <PastPurchasesDialog
        open={pastPurchasesOpen && !!customer}
        onOpenChange={setPastPurchasesOpen}
        customerName={customer?.fullName ?? ''}
        purchases={pastPurchases}
        canAdd={p => resolvePastPurchase(p) !== null}
        onAdd={addPastPurchase}
      />

      <Dialog open={promotionModalOpen} onOpenChange={setPromotionModalOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('pos.promotionModal.title')}</DialogTitle>
          </DialogHeader>
          <div className="mt-2 max-h-[60vh] space-y-1.5 overflow-y-auto">
            {promotionsLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400 dark:text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common.loading')}
              </div>
            ) : activePromotions.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">{t('pos.promotionModal.empty')}</p>
            ) : activePromotions.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPromotion(p)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.name}</p>
                  <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                    {promotionScopeLabel(p)} · {promotionDateRange(p)}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-blue-600 dark:text-blue-400 tabular-nums">{p.discountPercent}%</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

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

      {/* Per-ml perfume: how many ml to pour */}
      <Dialog open={mlPrompt !== null} onOpenChange={open => { if (!open) setMlPrompt(null) }}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('pos.perMl.title')}</DialogTitle>
          </DialogHeader>
          {mlPrompt && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {mlPrompt.item.productName}{mlPrompt.item.color ? ` · ${mlPrompt.item.color}` : ''}
              </p>
              <div className="relative">
                <input
                  autoFocus
                  type="number" min={1} max={mlPrompt.item.stock}
                  value={mlPrompt.value}
                  onChange={e => setMlPrompt(p => (p ? { ...p, value: e.target.value.replace(/\D/g, '') } : p))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirmMlPrompt() } }}
                  placeholder="10"
                  className="h-11 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 pr-12 text-lg text-gray-900 dark:text-gray-100 tabular-nums outline-none focus:border-gray-400 dark:focus:border-gray-500"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 dark:text-gray-500">ml</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[5, 10, 15, 20, 30, 50].map(ml => (
                  <button key={ml} type="button" onClick={() => setMlPrompt(p => (p ? { ...p, value: String(ml) } : p))} className={pillCls(mlPrompt.value === String(ml))}>
                    {ml} ml
                  </button>
                ))}
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-gray-500 dark:text-gray-400">
                  <span>1 ml</span><span className="tabular-nums">{formatPrice(mlPrompt.item.price)}</span>
                </div>
                <div className="flex justify-between text-gray-500 dark:text-gray-400">
                  <span>{t('pos.perMl.inStock')}</span><span className="tabular-nums">{mlPrompt.item.stock} ml</span>
                </div>
                <div className="flex justify-between font-semibold text-gray-900 dark:text-gray-100">
                  <span>{t('pos.perMl.total')}</span>
                  <span className="tabular-nums">{formatPrice((Number(mlPrompt.value) || 0) * mlPrompt.item.price)}</span>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMlPrompt(null)}>{t('common.cancel')}</Button>
            <Button onClick={confirmMlPrompt} disabled={!mlPrompt || !(Number(mlPrompt.value) > 0)} className="bg-slate-900 hover:bg-slate-800 text-white">
              {t('pos.perMl.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          {showBranchPicker && (
            <BranchSelect value={posBranchId ?? ''} onChange={pickPosBranch} options={activeBranches} allBranches={branches} />
          )}
          <DialogFooter className="mt-4">
            <Button onClick={startShift} disabled={startingShift || (showBranchPicker && !posBranchId)} className="w-full">
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
