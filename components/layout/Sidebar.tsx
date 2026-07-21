'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, Package,
  ShoppingBag, BarChart2, Megaphone,
  MessageSquare, Settings, ArrowDownCircle, ArrowUpCircle, Trash2, ChevronDown, ShoppingCart,
  Database, Tag, Building2, Briefcase, User, Target, LineChart, Crown, UserCog, Archive,
  Receipt, Search,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { createClient } from '@/lib/supabase/client'
import { DEFAULT_PERMISSIONS, withDefaultPermissions, type Permissions, type PermissionKey } from '@/lib/permissions'
import { useFeatures } from '@/lib/features'
import type { TranslationKey } from '@/lib/i18n/translations'

const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

interface NavLeaf {
  href: string
  labelKey: TranslationKey
  icon: LucideIcon
  permKey?: PermissionKey
  featureKey?: string
}

interface NavEntry extends NavLeaf {
  children?: NavLeaf[]
  noLink?: boolean
}

interface SidebarProps {
  forceExpanded?: boolean
}

const NAV_ITEMS: NavEntry[] = [
  { href: '/dashboard', labelKey: 'sidebar.dashboard', icon: LayoutDashboard, permKey: 'dashboard' },
  { href: '/pos', labelKey: 'sidebar.pos', icon: ShoppingCart, permKey: 'pos' },
  { href: '/customers', labelKey: 'sidebar.customers', icon: Users, permKey: 'customers' },
  {
    href: '/tovarlar', labelKey: 'sidebar.tovarlar', icon: Package, noLink: true,
    children: [
      { href: '/inventory', labelKey: 'sidebar.inventory', icon: Package, permKey: 'inventory' },
      { href: '/kirim', labelKey: 'sidebar.kirim', icon: ArrowDownCircle, permKey: 'kirim' },
      { href: '/chiqim', labelKey: 'sidebar.chiqim', icon: ArrowUpCircle, permKey: 'chiqim' },
      { href: '/brak', labelKey: 'sidebar.brak', icon: Trash2, permKey: 'brak' },
    ],
  },
  {
    href: '/data', labelKey: 'sidebar.data', icon: Database, noLink: true,
    children: [
      { href: '/mahsulotlar', labelKey: 'sidebar.products', icon: ShoppingBag, permKey: 'mahsulotlar' },
      { href: '/mahsulot-guruhi', labelKey: 'sidebar.productGroups', icon: Tag, permKey: 'mahsulot_guruhi' },
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
      { href: '/reports/moliya', labelKey: 'sidebar.reportsMoliya', icon: BarChart2 },
      { href: '/reports/inventar', labelKey: 'sidebar.reportsInventar', icon: Package },
    ],
  },
  { href: '/xarajatlar', labelKey: 'sidebar.expenses', icon: Receipt, permKey: 'xarajatlar', featureKey: 'expenses' },
  { href: '/marketing', labelKey: 'sidebar.marketing', icon: Megaphone, permKey: 'marketing', featureKey: 'marketing' },
  { href: '/requests', labelKey: 'sidebar.requests', icon: MessageSquare, permKey: 'requests' },
  { href: '/jamoa', labelKey: 'sidebar.jamoa', icon: UserCog, permKey: 'jamoa' },
  { href: '/arxiv', labelKey: 'sidebar.arxiv', icon: Archive, permKey: 'arxiv' },
]

const ADMIN_NAV_ITEM: NavEntry = {
  href: '/super-admin', labelKey: 'sidebar.adminPanel', icon: Crown, noLink: true,
  children: [
    { href: '/super-admin/firms', labelKey: 'sidebar.firmalar', icon: Building2 },
    { href: '/super-admin/modullar', labelKey: 'sidebar.modules', icon: Package },
  ],
}

const SETTINGS_NAV_ITEM: NavEntry = {
  href: '/sozlamalar', labelKey: 'sidebar.settings', icon: Settings, permKey: 'sozlamalar',
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager', staff: 'Staff',
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + '/')
}

function groupActive(pathname: string, item: NavEntry) {
  return isActive(pathname, item.href) || (item.children?.some(c => isActive(pathname, c.href)) ?? false)
}

function filterNavItems(items: NavEntry[], permissions: Permissions, isOwner: boolean, features: Record<string, boolean>): NavEntry[] {
  return items.reduce<NavEntry[]>((acc, item) => {
    if (item.featureKey && !features[item.featureKey]) return acc
    if (!isOwner && item.permKey && !permissions[item.permKey]) return acc
    if (item.children) {
      const children = isOwner ? item.children : item.children.filter(c => !c.permKey || permissions[c.permKey])
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
  const [isAdmin, setIsAdmin] = useState(false)
  const [permissions, setPermissions] = useState<Permissions>(DEFAULT_PERMISSIONS)
  const [isOwner, setIsOwner] = useState(true)
  const [companyName, setCompanyName] = useState('')
  const [userRole, setUserRole] = useState('')
  const [storedCollapsed, setStoredCollapsed] = useLocalStorage<boolean>('sidebar-collapsed', false)
  const { features } = useFeatures()

  const collapsed = forceExpanded ? false : storedCollapsed

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      setIsAdmin(user.email?.toLowerCase() === SUPER_ADMIN_EMAIL)
      const { data } = await supabase
        .from('users')
        .select('role, permissions, company_id')
        .eq('id', user.id)
        .single()
      if (data) {
        setIsOwner(data.role === 'owner')
        setUserRole(data.role ?? '')
        setPermissions(withDefaultPermissions(data.permissions as Partial<Permissions> | null))
        if (data.company_id) {
          const { data: company } = await supabase
            .from('companies')
            .select('name')
            .eq('id', data.company_id)
            .single()
          setCompanyName(company?.name ?? '')
        }
      }
    })
  }, [])

  const filteredNavItems = filterNavItems(NAV_ITEMS, permissions, isOwner, features)
  const filteredSettingsItem = filterNavItems([SETTINGS_NAV_ITEM], permissions, isOwner, features)[0]
  const navItems = isAdmin ? [...filteredNavItems, ADMIN_NAV_ITEM] : filteredNavItems
  const groups = [...navItems, ...(filteredSettingsItem ? [filteredSettingsItem] : [])].filter(i => i.children)

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    groups.forEach(g => { init[g.href] = groupActive(pathname, g) })
    return init
  })

  // Auto-collapse all accordion groups when sidebar collapses
  useEffect(() => {
    if (collapsed) setExpandedGroups({})
  }, [collapsed])

  useEffect(() => {
    groups.forEach(g => {
      if (groupActive(pathname, g)) {
        setExpandedGroups(prev => ({ ...prev, [g.href]: true }))
      }
    })
  }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleGroup(href: string) {
    setExpandedGroups(prev => ({ ...prev, [href]: !prev[href] }))
  }

  // ─── Monochrome nav icon ──────────────────────────────────────────────────
  function renderIcon(icon: LucideIcon, active: boolean, small = false) {
    const Icon = icon
    return (
      <Icon className={cn(
        'shrink-0',
        small ? 'h-3.5 w-3.5' : 'h-4 w-4',
        active ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500',
      )} />
    )
  }

  // ─── Collapsed icon-only item (with hover tooltip) ──────────────────────────
  function renderCollapsedItem(key: string, icon: LucideIcon, label: string, active: boolean, onClick?: () => void, href?: string) {
    const itemCls = cn(
      'flex h-9 w-full items-center justify-center rounded-lg transition-colors',
      active
        ? 'bg-white dark:bg-gray-800 shadow-sm border border-gray-100 dark:border-gray-700'
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
            ? 'bg-white dark:bg-gray-800 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100 font-medium'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60',
        )}
      >
        {renderIcon(icon, active, small)}
        {label}
      </Link>
    )
  }

  // ─── Main renderItem ─────────────────────────────────────────────────────────
  function renderItem(item: NavEntry) {
    const Icon = item.icon

    if (item.children) {
      const active = groupActive(pathname, item)
      const expanded = expandedGroups[item.href]

      if (collapsed) {
        return renderCollapsedItem(
          item.href, Icon, t(item.labelKey), active,
          () => setStoredCollapsed(false), // clicking a group in collapsed mode expands sidebar
        )
      }

      const headerCls = cn(
        'flex w-full items-center gap-2.5 rounded-lg py-2 px-2.5 text-[13.5px] transition-colors',
        active
          ? 'bg-white dark:bg-gray-800 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100 font-medium'
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
          <div className={cn('overflow-hidden transition-all duration-200 ease-in-out', expanded ? 'mt-0.5 max-h-72 opacity-100' : 'max-h-0 opacity-0')}>
            <div className="space-y-0.5">
              {item.children.map(child =>
                renderExpandedLeaf(child.href, child.href, child.icon, t(child.labelKey), isActive(pathname, child.href), true)
              )}
            </div>
          </div>
        </div>
      )
    }

    const active = isActive(pathname, item.href)

    if (collapsed) {
      return renderCollapsedItem(item.href, Icon, t(item.labelKey), active, undefined, item.href)
    }

    return renderExpandedLeaf(item.href, item.href, Icon, t(item.labelKey), active, false)
  }

  const planLabel = ROLE_LABEL[userRole] ?? ''

  return (
    <aside
      className={cn(
        'flex h-full flex-col shrink-0 overflow-hidden bg-white dark:bg-gray-900',
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
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-bold text-[13px]">
              {companyName ? companyName[0].toUpperCase() : 'S'}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStoredCollapsed(true)}
            title={t('sidebar.collapse')}
            className="flex w-full items-center gap-2.5 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-bold text-sm">
              {companyName ? companyName[0].toUpperCase() : 'S'}
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[13.5px] font-semibold text-gray-900 dark:text-gray-100">{companyName || 'StylePro'}</span>
              {planLabel && <span className="block truncate text-[11px] text-gray-400 dark:text-gray-500">{planLabel}</span>}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
          </button>
        )}
      </div>

      {/* ── Search ───────────────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className="shrink-0 px-3 pt-2.5 pb-1">
          <div className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              placeholder={t('header.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-600 dark:text-gray-300 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none"
            />
            <kbd className="hidden sm:inline-flex shrink-0 items-center rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 dark:text-gray-500">
              ⌘K
            </kbd>
          </div>
        </div>
      )}

      {/* ── Nav ──────────────────────────────────────────────────────────────── */}
      <nav className={cn('flex-1 py-2 space-y-0.5 overflow-y-auto', collapsed ? 'px-2' : 'px-2.5')}>
        {filteredNavItems.map(renderItem)}

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
