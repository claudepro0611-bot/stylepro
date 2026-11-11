import {
  LayoutDashboard, ShoppingCart, Users, Package,
  ArrowDownCircle, ArrowUpCircle, Trash2, ShoppingBag, Tag,
  BarChart2, Megaphone, MessageSquare, Receipt,
  Briefcase, Settings, UserCog, Archive, TrendingUp, Truck, ArrowLeftRight,
  Factory, Recycle, Boxes, BookOpen, HandCoins, Milk, FlaskConical, CreditCard, Landmark,
  type LucideIcon,
} from 'lucide-react'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { BusinessType } from '@/lib/business-type'

export const PERMISSION_KEYS = [
  'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
  'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
  'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
  // Per-report access. Each requires the parent 'reports' key as well —
  // 'reports' stays the master switch for the whole Hisobotlar group.
  'reports_moliya', 'reports_foyda', 'reports_sotuvlar', 'reports_mijozlar',
  'reports_yetkazuvchilar', 'reports_kirim', 'reports_spisaniya',
  'reports_xarajatlar', 'reports_inventar', 'reports_peremeshenie',
  'peremeshenie', 'yetkazuvchilar',
  // Production firms only (business_type = 'production'). Fail-closed: a
  // missing key means NO access for non-owners, unlike the retail keys.
  'prod_catalog', 'prod_production', 'prod_processing', 'prod_receipts',
  'prod_stock', 'prod_supply', 'prod_suppliers', 'prod_milk', 'prod_lab',
  'prod_sales', 'prod_customer_payments', 'prod_cash',
] as const

export type PermissionKey = typeof PERMISSION_KEYS[number]

export type Permissions = Record<PermissionKey, boolean>

export const PRODUCTION_PERMISSION_KEYS: readonly PermissionKey[] = [
  'prod_catalog', 'prod_production', 'prod_processing', 'prod_receipts', 'prod_stock', 'prod_supply',
  'prod_suppliers', 'prod_milk', 'prod_lab', 'prod_sales', 'prod_customer_payments', 'prod_cash',
]

/** Retail keys that production firms also use (mirrors has_permission()). */
export const SHARED_PERMISSION_KEYS: readonly PermissionKey[] = [
  'dashboard', 'xarajatlar', 'hr', 'jamoa', 'sozlamalar',
]

export function isProductionPermissionKey(key: PermissionKey): boolean {
  return PRODUCTION_PERMISSION_KEYS.includes(key)
}

/** Whether a permission key means anything for the given business type. */
export function isPermissionKeyForType(key: PermissionKey, type: BusinessType, productionModule = false): boolean {
  if (type === 'production') return isProductionPermissionKey(key) || SHARED_PERMISSION_KEYS.includes(key)
  // Retail firm with the "production" add-on module: retail keys + prod keys.
  return productionModule || !isProductionPermissionKey(key)
}

// Legacy retail keys default to true (rows written before a key existed keep
// working); prod_* keys default to false (fail-closed).
export const DEFAULT_PERMISSIONS: Permissions = PERMISSION_KEYS.reduce((acc, key) => {
  acc[key] = !isProductionPermissionKey(key)
  return acc
}, {} as Permissions)

export function withDefaultPermissions(permissions: Partial<Permissions> | null | undefined): Permissions {
  return { ...DEFAULT_PERMISSIONS, ...(permissions ?? {}) }
}

// `parent`: the item is shown nested under that key in the access editor and
// only takes effect while the parent is enabled.
export const PERMISSION_ITEMS: { key: PermissionKey; labelKey: TranslationKey; icon: LucideIcon; parent?: PermissionKey }[] = [
  { key: 'dashboard', labelKey: 'sidebar.dashboard', icon: LayoutDashboard },
  { key: 'pos', labelKey: 'sidebar.pos', icon: ShoppingCart },
  { key: 'customers', labelKey: 'sidebar.customers', icon: Users },
  { key: 'inventory', labelKey: 'sidebar.inventory', icon: Package },
  { key: 'kirim', labelKey: 'sidebar.kirim', icon: ArrowDownCircle },
  { key: 'chiqim', labelKey: 'sidebar.chiqim', icon: ArrowUpCircle },
  { key: 'brak', labelKey: 'sidebar.brak', icon: Trash2 },
  { key: 'peremeshenie', labelKey: 'sidebar.peremeshenie', icon: ArrowLeftRight },
  { key: 'yetkazuvchilar', labelKey: 'sidebar.suppliers', icon: Truck },
  { key: 'mahsulotlar', labelKey: 'sidebar.products', icon: ShoppingBag },
  { key: 'mahsulot_guruhi', labelKey: 'sidebar.productGroups', icon: Tag },
  { key: 'reports', labelKey: 'sidebar.reports', icon: BarChart2 },
  { key: 'reports_moliya', labelKey: 'sidebar.reportsMoliya', icon: BarChart2, parent: 'reports' },
  { key: 'reports_foyda', labelKey: 'sidebar.reportsFoyda', icon: TrendingUp, parent: 'reports' },
  { key: 'reports_sotuvlar', labelKey: 'sidebar.reportsSales', icon: ShoppingCart, parent: 'reports' },
  { key: 'reports_yetkazuvchilar', labelKey: 'sidebar.reportsSuppliers', icon: Truck, parent: 'reports' },
  { key: 'reports_kirim', labelKey: 'sidebar.reportsKirim', icon: ArrowDownCircle, parent: 'reports' },
  { key: 'reports_peremeshenie', labelKey: 'sidebar.reportsPeremeshenie', icon: ArrowLeftRight, parent: 'reports' },
  { key: 'reports_spisaniya', labelKey: 'sidebar.reportsWriteoff', icon: Trash2, parent: 'reports' },
  { key: 'reports_xarajatlar', labelKey: 'sidebar.reportsExpenses', icon: Receipt, parent: 'reports' },
  { key: 'reports_inventar', labelKey: 'sidebar.reportsInventar', icon: Package, parent: 'reports' },
  { key: 'xarajatlar', labelKey: 'sidebar.expenses', icon: Receipt },
  { key: 'marketing', labelKey: 'sidebar.marketing', icon: Megaphone },
  { key: 'requests', labelKey: 'sidebar.requests', icon: MessageSquare },
  { key: 'hr', labelKey: 'sidebar.hrModule', icon: Briefcase },
  { key: 'sozlamalar', labelKey: 'sidebar.settings', icon: Settings },
  { key: 'jamoa', labelKey: 'sidebar.jamoa', icon: UserCog },
  { key: 'arxiv', labelKey: 'sidebar.arxiv', icon: Archive },
  { key: 'prod_milk', labelKey: 'production.perm.milk', icon: Milk },
  { key: 'prod_lab', labelKey: 'production.perm.lab', icon: FlaskConical },
  { key: 'prod_production', labelKey: 'production.perm.production', icon: Factory },
  { key: 'prod_processing', labelKey: 'production.perm.processing', icon: Recycle },
  { key: 'prod_receipts', labelKey: 'production.perm.receipts', icon: ArrowDownCircle },
  { key: 'prod_stock', labelKey: 'production.perm.stock', icon: Boxes },
  { key: 'prod_catalog', labelKey: 'production.perm.catalog', icon: BookOpen },
  { key: 'prod_supply', labelKey: 'production.perm.supply', icon: HandCoins },
  { key: 'prod_suppliers', labelKey: 'production.perm.suppliers', icon: Truck },
  { key: 'prod_sales', labelKey: 'production.perm.sales', icon: ShoppingCart },
  { key: 'prod_customer_payments', labelKey: 'production.perm.customerPayments', icon: CreditCard },
  { key: 'prod_cash', labelKey: 'production.perm.cash', icon: Landmark },
  // 'nasiya' intentionally NOT added here yet: PERMISSION_ITEMS entries are
  // typed against TranslationKey = DotPaths<Translations> (a strict literal
  // union generated from lib/i18n/translations.ts's actual keys), so adding
  // a { key: 'nasiya', labelKey: 'sidebar.nasiya', ... } entry now — before
  // 'sidebar.nasiya' exists in translations.ts (uz/ru/en) — would fail to
  // typecheck / break `npm run build`. Adding that translation string is
  // explicitly out of scope for this migration (frontend scope). Follow-up
  // frontend task: add 'sidebar.nasiya' to translations.ts, then add
  // { key: 'nasiya', labelKey: 'sidebar.nasiya', icon: CreditCard } (or
  // similar credit-card-style lucide-react icon) to this array so it
  // appears in the sidebar/permissions UI. 'nasiya' is already a valid
  // PermissionKey (see PERMISSION_KEYS above) and DEFAULT_PERMISSIONS
  // covers it automatically — only the UI-visibility entry is pending.
]

/** The access-editor rows relevant to a firm of the given business type. */
export function permissionItemsFor(type: BusinessType, productionModule = false) {
  return PERMISSION_ITEMS.filter(item => isPermissionKeyForType(item.key, type, productionModule))
}
