'use client'

import { Fragment, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, Package,
  ShoppingBag, BarChart2, Megaphone,
  MessageSquare, Settings, ArrowDownCircle, Trash2, ChevronDown, ShoppingCart,
  Database, Tag, Building2, Briefcase, User, Target, LineChart, Crown, UserCog, Archive,
  Receipt, Warehouse, Store, Wallet, TrendingUp, ClipboardList, ClipboardCheck, RotateCcw, CreditCard, Contact, ListOrdered, Truck, ArrowLeftRight, PackagePlus,
  Factory, Recycle, BookOpen, HandCoins, Banknote, Milk, Split, FileBarChart, PackageOpen, Tags, Undo2,
  Landmark, ReceiptText, ArrowRightLeft, Boxes,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useSession } from '@/lib/session/SessionContext'
import { DEFAULT_PERMISSIONS, withDefaultPermissions, type Permissions, type PermissionKey } from '@/lib/permissions'
import { useFeatures } from '@/lib/features'
import { isAllBranchRole } from '@/lib/branches'
import type { TranslationKey } from '@/lib/i18n/translations'


export interface NavLeaf {
  href: string
  labelKey: TranslationKey
  icon: LucideIcon
  permKey?: PermissionKey
  featureKey?: string
  /** Only owner/admin (all-branch roles) see this item; no PermissionKey. */
  allBranchRolesOnly?: boolean
  /** Highlight only on this exact path (siblings live under it, e.g. /taminot/*). */
  exact?: boolean
  /** Shared module the retail nav already lists elsewhere: dropped from the retail production add-on. */
  retailHasOwn?: boolean
}

export interface NavEntry extends NavLeaf {
  children?: NavLeaf[]
  noLink?: boolean
  /** Nav section: a labelled divider is drawn above the first visible item of a section. */
  section?: 'production'
}

interface SidebarProps {
  forceExpanded?: boolean
}

// Production module groups (Bosh sahifa / HR / Jamoa excluded), defined once:
// production firms get them as-is, retail firms with the "production" add-on
// get them under a "Zavod" section (see PRODUCTION_ADDON_ITEMS). Group hrefs
// are synthetic keys (noLink) and never collide with real routes or with the
// retail groups ('/moliya', '/reports', ...), so their open state is separate.
const PRODUCTION_GROUPS: NavEntry[] = [
  {
    href: '/zavod-ishlab-chiqarish-bolimi', labelKey: 'production.nav.production', icon: Factory, noLink: true,
    children: [
      { href: '/sut-qabuli', labelKey: 'production.nav.milk', icon: Milk, permKey: 'prod_milk' },
      { href: '/ishlab-chiqarish', labelKey: 'production.nav.production', icon: Factory, permKey: 'prod_production' },
      { href: '/separatsiya', labelKey: 'production.nav.separation', icon: Split, permKey: 'prod_production' },
      { href: '/qayta-ishlash', labelKey: 'production.nav.processing', icon: Recycle, permKey: 'prod_processing' },
    ],
  },
  {
    href: '/zavod-sotuv-bolimi', labelKey: 'prodSales.nav.group', icon: ShoppingCart, noLink: true,
    children: [
      { href: '/zavod-sotuv', labelKey: 'prodSales.nav.sales', icon: Receipt, permKey: 'prod_sales' },
      { href: '/zavod-qaytarishlar', labelKey: 'prodSales.nav.returns', icon: Undo2, permKey: 'prod_sales' },
      { href: '/zavod-mijozlar', labelKey: 'prodSales.nav.customers', icon: Contact, permKey: 'prod_sales' },
      { href: '/zavod-mijoz-tolovlari', labelKey: 'prodSales.nav.customerPayments', icon: CreditCard, permKey: 'prod_customer_payments' },
      { href: '/zavod-narxlar', labelKey: 'prodSales.nav.priceLists', icon: ListOrdered, permKey: 'prod_sales' },
    ],
  },
  {
    href: '/zavod-xarid-bolimi', labelKey: 'prodCash.nav.purchase', icon: Truck, noLink: true,
    children: [
      { href: '/xom-ashyo-kirim', labelKey: 'production.nav.receipts', icon: PackagePlus, permKey: 'prod_receipts' },
      { href: '/zavod-yetkazuvchilar', labelKey: 'production.nav.suppliers', icon: Contact, permKey: 'prod_suppliers' },
      { href: '/zavod-yetkazuvchi-tolovlar', labelKey: 'prodCash.nav.supplierPayments', icon: CreditCard, permKey: 'prod_suppliers' },
      { href: '/zavod-narx-tuzatish', labelKey: 'prodInventory.nav.priceCorrections', icon: Tags, permKey: 'prod_receipts' },
    ],
  },
  {
    href: '/zavod-ombor-bolimi', labelKey: 'prodCash.nav.stock', icon: Boxes, noLink: true,
    children: [
      { href: '/zavod-omborlar', labelKey: 'production.nav.warehouses', icon: Warehouse, permKey: 'prod_stock' },
      { href: '/zavod-kochirish', labelKey: 'production.nav.transfers', icon: ArrowLeftRight, permKey: 'prod_stock' },
      { href: '/zavod-hisobdan-chiqarish', labelKey: 'prodInventory.nav.writeoffs', icon: Trash2, permKey: 'prod_stock' },
      { href: '/zavod-inventarizatsiya', labelKey: 'prodInventory.nav.stockCounts', icon: ClipboardCheck, permKey: 'prod_stock' },
      { href: '/zavod-boshlangich-qoldiq', labelKey: 'prodInventory.nav.openings', icon: PackageOpen, permKey: 'prod_stock' },
    ],
  },
  {
    href: '/zavod-moliya-bolimi', labelKey: 'sidebar.finance', icon: Wallet, noLink: true,
    children: [
      { href: '/zavod-kassa', labelKey: 'prodCash.nav.cash', icon: Landmark, permKey: 'prod_cash' },
      { href: '/zavod-kassa-orderlar', labelKey: 'prodCash.nav.orders', icon: ReceiptText, permKey: 'prod_cash' },
      { href: '/zavod-kassa-otkazmalar', labelKey: 'prodCash.nav.transfers', icon: ArrowRightLeft, permKey: 'prod_cash' },
      { href: '/xarajatlar', labelKey: 'sidebar.expenses', icon: Receipt, permKey: 'xarajatlar', featureKey: 'expenses', retailHasOwn: true },
      { href: '/valyuta-kurslari', labelKey: 'sidebar.exchangeRates', icon: TrendingUp, permKey: 'sozlamalar', retailHasOwn: true },
    ],
  },
  {
    href: '/taminot-bolimi', labelKey: 'production.nav.supply', icon: HandCoins, noLink: true,
    children: [
      { href: '/taminot', labelKey: 'production.nav.agents', icon: Contact, permKey: 'prod_supply', exact: true },
      { href: '/taminot/pul-berish', labelKey: 'production.nav.cashIssue', icon: Banknote, permKey: 'prod_supply' },
      { href: '/taminot/sarflar', labelKey: 'production.nav.spending', icon: Receipt, permKey: 'prod_supply' },
    ],
  },
  // Single entry: the reports index lists every report (incl. the cash report).
  { href: '/zavod-hisobotlar', labelKey: 'prodReports.nav', icon: FileBarChart, permKey: 'prod_stock' },
  {
    href: '/zavod-malumotnomalar', labelKey: 'production.nav.catalog', icon: BookOpen, noLink: true,
    children: [
      { href: '/zavod-mahsulotlar', labelKey: 'production.nav.items', icon: ShoppingBag, permKey: 'prod_catalog' },
      { href: '/zavod-guruhlar', labelKey: 'production.nav.groups', icon: Tag, permKey: 'prod_catalog' },
      { href: '/zavod-retseptlar', labelKey: 'production.nav.recipes', icon: ClipboardList, permKey: 'prod_catalog' },
    ],
  },
]

// Retail firms with the "production" add-on (super-admin enables the
// 'production' feature): same groups under a "Zavod" section; Xarajatlar and
// Valyuta kurslari stay only in the retail Moliya group.
const PRODUCTION_ADDON_ITEMS: NavEntry[] = PRODUCTION_GROUPS.map(item => ({
  ...item,
  featureKey: 'production',
  section: 'production' as const,
  ...(item.children ? { children: item.children.filter(c => !c.retailHasOwn) } : {}),
}))

export const NAV_ITEMS: NavEntry[] = [
  { href: '/dashboard', labelKey: 'sidebar.dashboard', icon: LayoutDashboard, permKey: 'dashboard' },
  { href: '/pos', labelKey: 'sidebar.pos', icon: ShoppingCart, permKey: 'pos' },
  {
    href: '/mijozlar', labelKey: 'sidebar.customersGroup', icon: Users, noLink: true,
    children: [
      { href: '/customers', labelKey: 'sidebar.customers', icon: Contact, permKey: 'customers' },
      { href: '/sotuvlar', labelKey: 'sidebar.sales', icon: Receipt, permKey: 'arxiv' },
      { href: '/qaytarishlar', labelKey: 'sidebar.returns', icon: RotateCcw, permKey: 'arxiv' },
      { href: '/tolovlar', labelKey: 'sidebar.payments', icon: CreditCard, permKey: 'arxiv' },
    ],
  },
  {
    href: '/operatsiyalar', labelKey: 'sidebar.operations', icon: ClipboardList, noLink: true,
    children: [
      { href: '/inventarizatsiya', labelKey: 'sidebar.inventarizatsiya', icon: ClipboardCheck, permKey: 'inventory' },
      { href: '/brak', labelKey: 'sidebar.brak', icon: Trash2, permKey: 'brak' },
      { href: '/peremeshenie', labelKey: 'sidebar.peremeshenie', icon: ArrowLeftRight, permKey: 'peremeshenie' },
    ],
  },
  {
    // Own group; children use distinct top-level paths so prefix-based
    // active highlighting doesn't light up the list on its sibling pages.
    // Permissions are per child (not on the group) so a kirim-only user
    // still sees Kirim here; the group hides itself when no child is left.
    href: '/yetkazuvchilar-bolimi', labelKey: 'sidebar.suppliers', icon: Truck, noLink: true,
    children: [
      { href: '/kirim', labelKey: 'sidebar.kirim', icon: PackagePlus, permKey: 'kirim' },
      { href: '/yetkazuvchilar', labelKey: 'sidebar.suppliersList', icon: Contact, permKey: 'yetkazuvchilar' },
      { href: '/xaridlar', labelKey: 'sidebar.supplierPurchases', icon: ArrowDownCircle, permKey: 'yetkazuvchilar' },
      { href: '/yetkazuvchi-qaytarish', labelKey: 'sidebar.supplierReturns', icon: RotateCcw, permKey: 'yetkazuvchilar' },
      { href: '/yetkazuvchi-tolovlar', labelKey: 'sidebar.supplierPayments', icon: CreditCard, permKey: 'yetkazuvchilar' },
    ],
  },
  {
    href: '/data', labelKey: 'sidebar.data', icon: Database, noLink: true,
    children: [
      { href: '/mahsulotlar', labelKey: 'sidebar.products', icon: ShoppingBag, permKey: 'mahsulotlar' },
      { href: '/mahsulot-guruhi', labelKey: 'sidebar.productGroups', icon: Tag, permKey: 'mahsulot_guruhi' },
      { href: '/omborlar', labelKey: 'sidebar.warehouses', icon: Warehouse, permKey: 'inventory' },
      { href: '/filiallar', labelKey: 'branches.nav', icon: Store, allBranchRolesOnly: true },
      { href: '/prays-list', labelKey: 'sidebar.priceLists', icon: ListOrdered, permKey: 'mahsulotlar' },
    ],
  },
  {
    href: '/hr', labelKey: 'sidebar.hrModule', icon: Users, noLink: true, permKey: 'hr', featureKey: 'hr',
    children: [
      { href: '/hr/bolimlar', labelKey: 'sidebar.bolimlar', icon: Building2 },
      { href: '/hr/lavozim', labelKey: 'sidebar.lavozim', icon: Briefcase },
      { href: '/hr/xodim', labelKey: 'sidebar.xodim', icon: User },
      { href: '/hr/mukofot-jarima-turlari', labelKey: 'sidebar.mukofotJarimaTurlari', icon: Tag },
      { href: '/hr/mukofot-jarimalar', labelKey: 'sidebar.mukofotJarimalar', icon: Target },
      { href: '/hr/grafik', labelKey: 'sidebar.grafik', icon: LineChart },
    ],
  },
  {
    href: '/reports', labelKey: 'sidebar.reports', icon: BarChart2, noLink: true, permKey: 'reports', featureKey: 'reports',
    children: [
      { href: '/reports/moliya', labelKey: 'sidebar.reportsMoliya', icon: BarChart2, permKey: 'reports_moliya' },
      { href: '/reports/foyda', labelKey: 'sidebar.reportsFoyda', icon: TrendingUp, permKey: 'reports_foyda' },
      { href: '/reports/sotuvlar', labelKey: 'sidebar.reportsSales', icon: ShoppingCart, permKey: 'reports_sotuvlar' },
      { href: '/reports/yetkazuvchilar', labelKey: 'sidebar.reportsSuppliers', icon: Truck, permKey: 'reports_yetkazuvchilar' },
      { href: '/reports/kirim', labelKey: 'sidebar.reportsKirim', icon: ArrowDownCircle, permKey: 'reports_kirim' },
      { href: '/reports/peremeshenie', labelKey: 'sidebar.reportsPeremeshenie', icon: ArrowLeftRight, permKey: 'reports_peremeshenie' },
      { href: '/reports/spisaniya', labelKey: 'sidebar.reportsWriteoff', icon: Trash2, permKey: 'reports_spisaniya' },
      { href: '/reports/xarajatlar', labelKey: 'sidebar.reportsExpenses', icon: Receipt, permKey: 'reports_xarajatlar' },
      { href: '/reports/inventar', labelKey: 'sidebar.reportsInventar', icon: Package, permKey: 'reports_inventar' },
    ],
  },
  {
    href: '/moliya', labelKey: 'sidebar.finance', icon: Wallet, noLink: true,
    children: [
      { href: '/xarajatlar', labelKey: 'sidebar.expenses', icon: Receipt, permKey: 'xarajatlar', featureKey: 'expenses' },
      { href: '/valyuta-kurslari', labelKey: 'sidebar.exchangeRates', icon: TrendingUp, permKey: 'sozlamalar' },
    ],
  },
  // Production add-on module (retail firms): see PRODUCTION_ADDON_ITEMS.
  ...PRODUCTION_ADDON_ITEMS,
  { href: '/marketing', labelKey: 'sidebar.marketing', icon: Megaphone, permKey: 'marketing', featureKey: 'marketing' },
  { href: '/requests', labelKey: 'sidebar.requests', icon: MessageSquare, permKey: 'requests' },
  { href: '/jamoa', labelKey: 'sidebar.jamoa', icon: UserCog, permKey: 'jamoa' },
  { href: '/arxiv', labelKey: 'sidebar.arxiv', icon: Archive, permKey: 'arxiv' },
]

// Production firms (business_type = 'production'). Only production + shared
// modules; route access is enforced in proxy.ts and by has_permission().
export const PRODUCTION_NAV_ITEMS: NavEntry[] = [
  { href: '/dashboard', labelKey: 'sidebar.dashboard', icon: LayoutDashboard, permKey: 'dashboard' },
  ...PRODUCTION_GROUPS,
  {
    href: '/hr', labelKey: 'sidebar.hrModule', icon: Users, noLink: true, permKey: 'hr', featureKey: 'hr',
    children: [
      { href: '/hr/bolimlar', labelKey: 'sidebar.bolimlar', icon: Building2 },
      { href: '/hr/lavozim', labelKey: 'sidebar.lavozim', icon: Briefcase },
      { href: '/hr/xodim', labelKey: 'sidebar.xodim', icon: User },
      { href: '/hr/mukofot-jarima-turlari', labelKey: 'sidebar.mukofotJarimaTurlari', icon: Tag },
      { href: '/hr/mukofot-jarimalar', labelKey: 'sidebar.mukofotJarimalar', icon: Target },
      { href: '/hr/grafik', labelKey: 'sidebar.grafik', icon: LineChart },
    ],
  },
  { href: '/jamoa', labelKey: 'sidebar.jamoa', icon: UserCog, permKey: 'jamoa' },
]

export const ADMIN_NAV_ITEM: NavEntry = {
  href: '/super-admin', labelKey: 'sidebar.adminPanel', icon: Crown, noLink: true,
  children: [
    { href: '/super-admin/firms', labelKey: 'sidebar.firmalar', icon: Building2 },
    { href: '/super-admin/modullar', labelKey: 'sidebar.modules', icon: Package },
  ],
}

export const SETTINGS_NAV_ITEM: NavEntry = {
  href: '/sozlamalar', labelKey: 'sidebar.settings', icon: Settings, permKey: 'sozlamalar',
}

function isActive(pathname: string, href: string, exact = false) {
  return pathname === href || (!exact && pathname.startsWith(href + '/'))
}

function groupActive(pathname: string, item: NavEntry) {
  return isActive(pathname, item.href) || (item.children?.some(c => isActive(pathname, c.href, c.exact)) ?? false)
}

function filterNavItems(items: NavEntry[], permissions: Permissions, isOwner: boolean, features: Record<string, boolean>, isAllBranchUser: boolean): NavEntry[] {
  return items.reduce<NavEntry[]>((acc, item) => {
    if (item.featureKey && !features[item.featureKey]) return acc
    if (item.allBranchRolesOnly && !isAllBranchUser) return acc
    if (!isOwner && item.permKey && !permissions[item.permKey]) return acc
    if (item.children) {
      // Child-level featureKey applies to owners too (module disabled for the
      // company); child-level permKey only to non-owners, same as top level.
      const children = item.children.filter(c =>
        (!c.featureKey || features[c.featureKey]) &&
        (!c.allBranchRolesOnly || isAllBranchUser) &&
        (isOwner || !c.permKey || permissions[c.permKey]),
      )
      if (item.noLink && children.length === 0) return acc
      acc.push({ ...item, children })
      return acc
    }
    acc.push(item)
    return acc
  }, [])
}

export function Sidebar({ forceExpanded = false }: SidebarProps) {
  const pathname = usePathname()
  const { t } = useLanguage()
  const { isSuperAdmin: isAdmin, profile, company } = useSession()
  const isProduction = company?.businessType === 'production'
  // Until the profile loads, keep the previous defaults (owner + all
  // permissions) so the nav doesn't flash empty.
  const isOwner = profile ? profile.role === 'owner' : true
  const permissions: Permissions = profile
    ? withDefaultPermissions(profile.permissions as Partial<Permissions> | null)
    : DEFAULT_PERMISSIONS
  // Unlike isOwner, default to hidden while loading so staff never see a
  // flash of the owner/admin-only Filiallar item.
  const isAllBranchUser = profile ? isAllBranchRole(profile.role) : false
  const [storedCollapsed, setStoredCollapsed] = useLocalStorage<boolean>('sidebar-collapsed', false)
  const { features } = useFeatures()

  const collapsed = forceExpanded ? false : storedCollapsed

  const filteredNavItems = filterNavItems(isProduction ? PRODUCTION_NAV_ITEMS : NAV_ITEMS, permissions, isOwner, features, isAllBranchUser)
  const filteredSettingsItem = filterNavItems([SETTINGS_NAV_ITEM], permissions, isOwner, features, isAllBranchUser)[0]
  const navItems = isAdmin ? [...filteredNavItems, ADMIN_NAV_ITEM] : filteredNavItems
  const groups = [...navItems, ...(filteredSettingsItem ? [filteredSettingsItem] : [])].filter(i => i.children)

  // Accordion: only one group is open at a time; the active route's group opens.
  const [openGroup, setOpenGroup] = useState<string | null>(() => groups.find(g => groupActive(pathname, g))?.href ?? null)

  // Auto-collapse all accordion groups when sidebar collapses
  useEffect(() => {
    if (collapsed) setOpenGroup(null)
  }, [collapsed])

  // Re-run when the visible groups change too (features / session load after
  // the first render), so the group of the active route opens on a hard reload.
  const groupKey = groups.map(g => g.href).join('|')
  useEffect(() => {
    const active = groups.find(g => groupActive(pathname, g))
    if (active && !collapsed) setOpenGroup(active.href)
  }, [pathname, isProduction, groupKey]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleGroup(href: string) {
    setOpenGroup(prev => (prev === href ? null : href))
  }

  // ─── Monochrome nav icon ──────────────────────────────────────────────────
  function renderIcon(icon: LucideIcon, active: boolean, small = false) {
    const Icon = icon
    return (
      <Icon className={cn(
        'shrink-0',
        small ? 'h-3.5 w-3.5' : 'h-4 w-4',
        active ? 'text-blue-600' : 'text-gray-400 dark:text-gray-500',
      )} />
    )
  }

  // ─── Collapsed icon-only item (with hover tooltip) ──────────────────────────
  function renderCollapsedItem(key: string, icon: LucideIcon, label: string, active: boolean, onClick?: () => void, href?: string) {
    const itemCls = cn(
      'flex h-9 w-full items-center justify-center rounded-lg transition-colors',
      active
        ? 'bg-sidebar-accent dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 border-l-2 border-l-sidebar-accent-border'
        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60',
    )

    return (
      <div key={key} className="relative group/tip">
        {href ? (
          <Link href={href} className={itemCls}>
            {renderIcon(icon, active)}
          </Link>
        ) : (
          <button type="button" onClick={onClick} className={itemCls}>
            {renderIcon(icon, active)}
          </button>
        )}
        {/* Tooltip */}
        <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2.5 py-1.5 text-[12px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover/tip:opacity-100">
          {label}
        </span>
      </div>
    )
  }

  // ─── Expanded leaf item ──────────────────────────────────────────────────────
  function renderExpandedLeaf(key: string, href: string, icon: LucideIcon, label: string, active: boolean, small = false) {
    return (
      <Link
        key={key}
        href={href}
        className={cn(
          'flex items-center gap-2.5 rounded-lg transition-colors',
          small ? 'py-1.5 pl-9 pr-2.5 text-[12.5px]' : 'py-2 px-2.5 text-[13.5px]',
          active
            ? 'bg-sidebar-accent dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 border-l-2 border-l-sidebar-accent-border text-sidebar-accent-foreground dark:text-gray-100 font-medium'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60',
        )}
      >
        {renderIcon(icon, active, small)}
        {label}
      </Link>
    )
  }

  /** Collapsed tooltip label: "Zavod · Sotuv" inside the production add-on section. */
  function navLabel(item: NavEntry) {
    return item.section === 'production' ? `${t('prodCash.nav.section')} · ${t(item.labelKey)}` : t(item.labelKey)
  }

  // ─── Section header (labelled divider; plain divider when collapsed) ────────
  function renderSectionHeader(item: NavEntry) {
    if (collapsed) return <div key={`section:${item.href}`} className="my-2 border-t border-gray-100 dark:border-gray-800" />
    return (
      <div key={`section:${item.href}`} className="mt-3 mb-1 flex items-center gap-2 px-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">{t('prodCash.nav.section')}</span>
        <span className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
      </div>
    )
  }

  // ─── Main renderItem ─────────────────────────────────────────────────────────
  function renderItem(item: NavEntry) {
    const Icon = item.icon

    if (item.children) {
      const active = groupActive(pathname, item)
      const expanded = openGroup === item.href

      if (collapsed) {
        return renderCollapsedItem(
          item.href, Icon, navLabel(item), active,
          () => setStoredCollapsed(false), // clicking a group in collapsed mode expands sidebar
        )
      }

      const headerCls = cn(
        'flex w-full items-center gap-2.5 rounded-lg py-2 px-2.5 text-[13.5px] transition-colors',
        active
          ? 'bg-sidebar-accent dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 border-l-2 border-l-sidebar-accent-border text-sidebar-accent-foreground dark:text-gray-100 font-medium'
          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60',
      )

      return (
        <div key={item.href}>
          {item.noLink ? (
            <button type="button" onClick={() => toggleGroup(item.href)} className={headerCls}>
              {renderIcon(Icon, active)}
              <span className="flex-1 text-left">{t(item.labelKey)}</span>
              <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200', expanded ? 'rotate-0' : '-rotate-90')} />
            </button>
          ) : (
            <Link href={item.href} onClick={() => toggleGroup(item.href)} className={headerCls}>
              {renderIcon(Icon, active)}
              <span className="flex-1">{t(item.labelKey)}</span>
              <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200', expanded ? 'rotate-0' : '-rotate-90')} />
            </Link>
          )}
          <div className={cn('overflow-hidden transition-all duration-200 ease-in-out', expanded ? 'mt-0.5 max-h-96 opacity-100' : 'max-h-0 opacity-0')}>
            <div className="space-y-0.5">
              {item.children.map(child =>
                renderExpandedLeaf(child.href, child.href, child.icon, t(child.labelKey), isActive(pathname, child.href, child.exact), true)
              )}
            </div>
          </div>
        </div>
      )
    }

    const active = isActive(pathname, item.href)

    if (collapsed) {
      return renderCollapsedItem(item.href, Icon, navLabel(item), active, undefined, item.href)
    }

    return renderExpandedLeaf(item.href, item.href, Icon, t(item.labelKey), active, false)
  }

  return (
    <aside
      className={cn(
        'flex h-full flex-col shrink-0 overflow-hidden bg-sidebar',
        'transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* ── Company header card ─────────────────────────────────────────────── */}
      <div className={cn('shrink-0 pt-3', collapsed ? 'px-2' : 'px-3')}>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setStoredCollapsed(false)}
            className="flex h-10 w-full items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-800/70 transition-colors"
            title={t('sidebar.expand')}
          >
            <svg viewBox="0 0 24 24" fill="#2563eb" width="18" height="18">
              <path d="M21 8c-1.5 0-2.5.5-3.5 1.5C16 8 14.5 7 13 7c-1 0-2 .3-2.8.8L8 6.5C6.5 5.5 4.5 5 2.5 5.5L2 6l2 2c-1 1-1.5 2.5-1 4 .5 1.5 2 3 4 3.5 1 .3 2 .2 3-.2l1.5 1.5c.5.5 1 .7 1.5.7s1-.2 1.5-.7l.5-.5c1 .3 2 .2 3-.5 1.5-1 2-2.5 2-4 0-.5 0-1-.2-1.5.7-.5 1.2-1.3 1.2-2.3z" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStoredCollapsed(true)}
            title={t('sidebar.collapse')}
            className="flex w-full items-center gap-2.5 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <svg viewBox="0 0 24 24" fill="#2563eb" width="24" height="24">
                <path d="M21 8c-1.5 0-2.5.5-3.5 1.5C16 8 14.5 7 13 7c-1 0-2 .3-2.8.8L8 6.5C6.5 5.5 4.5 5 2.5 5.5L2 6l2 2c-1 1-1.5 2.5-1 4 .5 1.5 2 3 4 3.5 1 .3 2 .2 3-.2l1.5 1.5c.5.5 1 .7 1.5.7s1-.2 1.5-.7l.5-.5c1 .3 2 .2 3-.5 1.5-1 2-2.5 2-4 0-.5 0-1-.2-1.5.7-.5 1.2-1.3 1.2-2.3z" />
              </svg>
              <span className="font-bold text-[17px] text-blue-600">Dolphy</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
          </button>
        )}
      </div>

      {/* ── Nav ──────────────────────────────────────────────────────────────── */}
      <nav className={cn('flex-1 py-2 space-y-0.5 overflow-y-auto', collapsed ? 'px-2' : 'px-2.5')}>
        {filteredNavItems.map((item, i) => {
          const sectionStart = !!item.section && filteredNavItems[i - 1]?.section !== item.section
          const sectionEnd = !!item.section && i < filteredNavItems.length - 1 && !filteredNavItems[i + 1]?.section
          return (
            <Fragment key={item.href}>
              {sectionStart && renderSectionHeader(item)}
              {renderItem(item)}
              {sectionEnd && <div className="my-2 border-t border-gray-100 dark:border-gray-800" />}
            </Fragment>
          )
        })}

        {isAdmin && (
          <>
            <div className="my-2 border-t border-gray-100 dark:border-gray-800" />
            {renderItem(ADMIN_NAV_ITEM)}
          </>
        )}

        {filteredSettingsItem && (
          <>
            <div className="my-2 border-t border-gray-100 dark:border-gray-800" />
            {renderItem(filteredSettingsItem)}
          </>
        )}
      </nav>
    </aside>
  )
}
