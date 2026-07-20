import {
  LayoutDashboard, ShoppingCart, Users, Package,
  ArrowDownCircle, ArrowUpCircle, Trash2, ShoppingBag, Tag,
  BarChart2, Megaphone, MessageSquare, Receipt,
  Briefcase, Settings, UserCog, Archive,
  type LucideIcon,
} from 'lucide-react'
import type { TranslationKey } from '@/lib/i18n/translations'

export const PERMISSION_KEYS = [
  'dashboard', 'pos', 'customers', 'inventory', 'kirim', 'chiqim', 'brak',
  'mahsulotlar', 'mahsulot_guruhi', 'reports', 'xarajatlar', 'marketing',
  'requests', 'hr', 'sozlamalar', 'jamoa', 'arxiv', 'nasiya',
] as const

export type PermissionKey = typeof PERMISSION_KEYS[number]

export type Permissions = Record<PermissionKey, boolean>

export const DEFAULT_PERMISSIONS: Permissions = PERMISSION_KEYS.reduce((acc, key) => {
  acc[key] = true
  return acc
}, {} as Permissions)

export function withDefaultPermissions(permissions: Partial<Permissions> | null | undefined): Permissions {
  return { ...DEFAULT_PERMISSIONS, ...(permissions ?? {}) }
}

export const PERMISSION_ITEMS: { key: PermissionKey; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { key: 'dashboard', labelKey: 'sidebar.dashboard', icon: LayoutDashboard },
  { key: 'pos', labelKey: 'sidebar.pos', icon: ShoppingCart },
  { key: 'customers', labelKey: 'sidebar.customers', icon: Users },
  { key: 'inventory', labelKey: 'sidebar.inventory', icon: Package },
  { key: 'kirim', labelKey: 'sidebar.kirim', icon: ArrowDownCircle },
  { key: 'chiqim', labelKey: 'sidebar.chiqim', icon: ArrowUpCircle },
  { key: 'brak', labelKey: 'sidebar.brak', icon: Trash2 },
  { key: 'mahsulotlar', labelKey: 'sidebar.products', icon: ShoppingBag },
  { key: 'mahsulot_guruhi', labelKey: 'sidebar.productGroups', icon: Tag },
  { key: 'reports', labelKey: 'sidebar.reports', icon: BarChart2 },
  { key: 'xarajatlar', labelKey: 'sidebar.expenses', icon: Receipt },
  { key: 'marketing', labelKey: 'sidebar.marketing', icon: Megaphone },
  { key: 'requests', labelKey: 'sidebar.requests', icon: MessageSquare },
  { key: 'hr', labelKey: 'sidebar.hrModule', icon: Briefcase },
  { key: 'sozlamalar', labelKey: 'sidebar.settings', icon: Settings },
  { key: 'jamoa', labelKey: 'sidebar.jamoa', icon: UserCog },
  { key: 'arxiv', labelKey: 'sidebar.arxiv', icon: Archive },
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
