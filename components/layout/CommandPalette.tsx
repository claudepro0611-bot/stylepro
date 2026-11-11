'use client'

// Ctrl/Cmd+K command palette: menu pages (same permission filter as the
// sidebar; hidden menu items stay reachable here), quick actions ("Yangi
// sotuv", ...) and, for production firms / the add-on, live data: suppliers,
// customers, items, lot numbers (P-000123) and document numbers by type
// ("sotuv 15", "kirim 7", "ishlab chiqarish 3"). Opened by the shortcut
// anywhere or by the sidebar search box (openCommandPalette()). Read-only:
// every query is an RLS-scoped select.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, CornerDownLeft, FileText, Contact, Truck, ShoppingBag, Layers, Plus, History, type LucideIcon,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { useFeatures } from '@/lib/features'
import { DEFAULT_PERMISSIONS, withDefaultPermissions, type PermissionKey, type Permissions } from '@/lib/permissions'
import { isAllBranchRole } from '@/lib/branches'
import { cn } from '@/lib/utils'
import type { TranslationKey } from '@/lib/i18n/translations'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  ADMIN_NAV_ITEM, NAV_ITEMS, PRODUCTION_NAV_ITEMS, SETTINGS_NAV_ITEM, filterNavItems, type NavEntry,
} from '@/components/layout/Sidebar'
import { lotTraceHref } from '@/lib/production-reports'
import { looseFrom } from '@/lib/approvals'
import { COMMAND_PALETTE_OPEN_EVENT as OPEN_EVENT } from '@/components/layout/commandPaletteEvents'


type ResultKind = 'page' | 'action' | 'supplier' | 'customer' | 'item' | 'lot' | 'doc'

interface Result {
  id: string
  kind: ResultKind
  label: string
  sub?: string
  href: string
}

const KIND_ICON: Record<ResultKind, LucideIcon> = {
  page: Layers, action: Plus, supplier: Truck, customer: Contact, item: ShoppingBag, lot: Layers, doc: FileText,
}

const KIND_GROUP: Record<ResultKind, TranslationKey> = {
  page: 'prodShell.cmdk.groups.pages',
  action: 'prodShell.cmdk.groups.actions',
  supplier: 'prodShell.cmdk.groups.suppliers',
  customer: 'prodShell.cmdk.groups.customers',
  item: 'prodShell.cmdk.groups.items',
  lot: 'prodShell.cmdk.groups.lots',
  doc: 'prodShell.cmdk.groups.docs',
}

// ---------------------------------------------------------------------------
// Static entries

interface ActionDef { href: string; labelKey: TranslationKey; perm?: PermissionKey; production?: boolean; feature?: string }

const ACTIONS: ActionDef[] = [
  { href: '/zavod-sotuv/yangi', labelKey: 'prodShell.cmdk.actions.sale', perm: 'prod_sales', production: true },
  { href: '/xom-ashyo-kirim/yangi', labelKey: 'prodShell.cmdk.actions.receipt', perm: 'prod_receipts', production: true },
  { href: '/sut-qabuli/yangi', labelKey: 'prodShell.cmdk.actions.milk', perm: 'prod_milk', production: true },
  { href: '/ishlab-chiqarish/yangi', labelKey: 'prodShell.cmdk.actions.production', perm: 'prod_production', production: true },
  { href: '/separatsiya/yangi', labelKey: 'prodShell.cmdk.actions.separation', perm: 'prod_production', production: true },
  { href: '/qayta-ishlash/yangi', labelKey: 'prodShell.cmdk.actions.processing', perm: 'prod_processing', production: true },
  { href: '/zavod-kochirish/yangi', labelKey: 'prodShell.cmdk.actions.transfer', perm: 'prod_stock', production: true },
  { href: '/zavod-hisobdan-chiqarish/yangi', labelKey: 'prodShell.cmdk.actions.writeoff', perm: 'prod_stock', production: true },
  { href: '/zavod-inventarizatsiya/yangi', labelKey: 'prodShell.cmdk.actions.stockCount', perm: 'prod_stock', production: true },
  { href: '/zavod-retseptlar/yangi', labelKey: 'prodShell.cmdk.actions.recipe', perm: 'prod_catalog', production: true },
  { href: '/pos', labelKey: 'prodShell.cmdk.actions.pos', perm: 'pos', feature: 'pos' },
]

// Document number search: "<type word> <number>". Words in uz / ru / en.
interface DocType { table: string; base: string; perm: PermissionKey; labelKey: TranslationKey; words: string[]; dateCol: string }

const DOC_TYPES: DocType[] = [
  { table: 'prod_sales', base: '/zavod-sotuv', perm: 'prod_sales', labelKey: 'prodShell.rpc.sale', dateCol: 'doc_date', words: ['sotuv', 'savdo', 'продажа', 'реализация', 'sale'] },
  { table: 'prod_receipts', base: '/xom-ashyo-kirim', perm: 'prod_receipts', labelKey: 'prodShell.rpc.receipt', dateCol: 'doc_date', words: ['kirim', 'приход', 'поступление', 'receipt'] },
  { table: 'prod_productions', base: '/ishlab-chiqarish', perm: 'prod_production', labelKey: 'prodShell.rpc.production', dateCol: 'doc_date', words: ['ishlab chiqarish', 'ishlab', 'производство', 'production'] },
  { table: 'prod_milk_intakes', base: '/sut-qabuli', perm: 'prod_milk', labelKey: 'prodShell.rpc.milkIntake', dateCol: 'intake_date', words: ['sut qabuli', 'sut', 'молоко', 'приемка', 'milk'] },
  { table: 'prod_sale_returns', base: '/zavod-qaytarishlar', perm: 'prod_sales', labelKey: 'prodShell.rpc.saleReturn', dateCol: 'doc_date', words: ['qaytarish', 'возврат', 'return'] },
  { table: 'prod_separations', base: '/separatsiya', perm: 'prod_production', labelKey: 'prodShell.rpc.separation', dateCol: 'doc_date', words: ['separatsiya', 'сепарация', 'separation'] },
  { table: 'prod_processings', base: '/qayta-ishlash', perm: 'prod_processing', labelKey: 'prodShell.rpc.processing', dateCol: 'doc_date', words: ['qayta ishlash', 'переработка', 'processing'] },
  { table: 'prod_transfers', base: '/zavod-kochirish', perm: 'prod_stock', labelKey: 'prodShell.rpc.transfer', dateCol: 'doc_date', words: ["ko'chirish", 'kochirish', 'перемещение', 'transfer'] },
  { table: 'prod_writeoffs', base: '/zavod-hisobdan-chiqarish', perm: 'prod_stock', labelKey: 'prodShell.rpc.writeoff', dateCol: 'doc_date', words: ['hisobdan chiqarish', 'hisobdan', 'списание', 'writeoff', 'write-off'] },
  { table: 'prod_stock_counts', base: '/zavod-inventarizatsiya', perm: 'prod_stock', labelKey: 'prodShell.rpc.stockCount', dateCol: 'doc_date', words: ['inventarizatsiya', 'инвентаризация', 'stock count'] },
  { table: 'prod_openings', base: '/zavod-boshlangich-qoldiq', perm: 'prod_stock', labelKey: 'prodShell.rpc.opening', dateCol: 'doc_date', words: ["boshlang'ich qoldiq", 'boshlangich', 'начальный остаток', 'opening'] },
]

/** Types a bare number searches (the common ones). */
const BARE_NUMBER_TABLES = ['prod_sales', 'prod_receipts', 'prod_productions', 'prod_milk_intakes']

function parseDocQuery(q: string): { types: DocType[]; num: number } | null {
  const s = q.trim().toLowerCase().replace(/\s+/g, ' ')
  const bare = s.match(/^#?(\d{1,9})$/)
  if (bare) return { types: DOC_TYPES.filter(d => BARE_NUMBER_TABLES.includes(d.table)), num: Number(bare[1]) }
  const m = s.match(/^(.+?)\s*(?:№|#|n)?\s*(\d{1,9})$/)
  if (!m) return null
  const word = m[1].trim()
  if (word.length < 2) return null
  const types = DOC_TYPES.filter(d => d.words.some(w => w.startsWith(word) || word.startsWith(w)))
  return types.length ? { types, num: Number(m[2]) } : null
}

function parseLotQuery(q: string): string | null {
  const m = q.trim().match(/^p-?\s*(\d{1,9})$/i)
  if (!m) return null
  return 'P-' + (m[1].length < 6 ? m[1].padStart(6, '0') : m[1])
}

const norm = (s: string) => s.toLowerCase().replace(/[ʻʼ'`‘’]/g, "'")

function fmtDate(ymd: unknown): string {
  return typeof ymd === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ymd) ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : ''
}

// ---------------------------------------------------------------------------
// Recent

const RECENT_MAX = 8
const recentKey = (userId: string | null) => `stylepro-cmdk-recent:${userId ?? 'anon'}`

function readRecent(userId: string | null): Result[] {
  try {
    const raw = window.localStorage.getItem(recentKey(userId))
    const list = raw ? (JSON.parse(raw) as Result[]) : []
    return Array.isArray(list) ? list.filter(r => r && typeof r.href === 'string' && r.href.startsWith('/')).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function pushRecent(userId: string | null, r: Result) {
  try {
    const next = [r, ...readRecent(userId).filter(x => x.href !== r.href)].slice(0, RECENT_MAX)
    window.localStorage.setItem(recentKey(userId), JSON.stringify(next))
  } catch {
    // storage unavailable
  }
}

// ---------------------------------------------------------------------------

function flattenPages(items: NavEntry[], t: (k: TranslationKey) => string): Result[] {
  const out: Result[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const group = t(item.labelKey)
    const prefix = item.section === 'production' ? `${t('prodCash.nav.section')} · ` : ''
    if (item.children) {
      if (!item.noLink && !seen.has(item.href)) {
        seen.add(item.href)
        out.push({ id: `page:${item.href}`, kind: 'page', label: group, sub: prefix || undefined, href: item.href })
      }
      for (const c of item.children) {
        if (seen.has(c.href)) continue
        seen.add(c.href)
        out.push({ id: `page:${c.href}`, kind: 'page', label: t(c.labelKey), sub: `${prefix}${group}`, href: c.href })
      }
    } else if (!seen.has(item.href)) {
      seen.add(item.href)
      out.push({ id: `page:${item.href}`, kind: 'page', label: group, sub: prefix || undefined, href: item.href })
    }
  }
  return out
}

export function CommandPalette() {
  const router = useRouter()
  const { t } = useLanguage()
  const { userId, isSuperAdmin, profile, company } = useSession()
  const { features } = useFeatures()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [live, setLive] = useState<Result[]>([])
  const [searching, setSearching] = useState(false)
  const [recent, setRecent] = useState<Result[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  const isProductionFirm = company?.businessType === 'production'
  const productionOn = !isSuperAdmin && (isProductionFirm || !!features.production)
  const isOwner = profile ? profile.role === 'owner' : false
  const permissions: Permissions = useMemo(
    () => (profile ? withDefaultPermissions(profile.permissions as Partial<Permissions> | null) : DEFAULT_PERMISSIONS),
    [profile],
  )
  const can = useCallback((k?: PermissionKey) => !k || isOwner || !!permissions[k], [isOwner, permissions])
  const isAllBranchUser = profile ? isAllBranchRole(profile.role) : false

  const pages = useMemo(() => {
    const nav = filterNavItems(isProductionFirm ? PRODUCTION_NAV_ITEMS : NAV_ITEMS, permissions, isOwner, features, isAllBranchUser)
    const settings = filterNavItems([SETTINGS_NAV_ITEM], permissions, isOwner, features, isAllBranchUser)
    const all = [...nav, ...settings, ...(isSuperAdmin ? [ADMIN_NAV_ITEM] : [])]
    const list = flattenPages(all, t)
    // Shell pages that are not in the nav config.
    list.push({ id: 'page:/sozlamalar/interfeys', kind: 'page', label: t('prodShell.prefs.title'), href: '/sozlamalar/interfeys' })
    return list
  }, [isProductionFirm, permissions, isOwner, features, isAllBranchUser, isSuperAdmin, t])

  const actions = useMemo<Result[]>(() => ACTIONS
    .filter(a => (a.production ? productionOn : !isProductionFirm) && (!a.feature || features[a.feature]) && can(a.perm))
    .map(a => ({ id: `action:${a.href}`, kind: 'action' as const, label: t(a.labelKey), href: a.href })),
  [productionOn, isProductionFirm, features, can, t])

  // Shortcut + external open requests.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(v => !v)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setLive([])
    setRecent(readRecent(userId))
  }, [open, userId])

  // Live data (debounced). Each source only when the user may open its page.
  useEffect(() => {
    const q = query.trim()
    if (!open || !productionOn || q.length < 2) { setLive([]); setSearching(false); return }
    const my = ++seq.current
    setSearching(true)
    const timer = setTimeout(async () => {
      const supabase = createClient()
      const like = `%${q.replace(/[%_,()]/g, ' ')}%`
      const tasks: Promise<Result[]>[] = []
      const run = (p: PromiseLike<{ data: unknown; error: unknown }>, map: (row: Record<string, unknown>) => Result) =>
        Promise.resolve(p).then(r => (r.error ? [] : ((r.data ?? []) as Record<string, unknown>[]).map(map))).catch(() => [] as Result[])

      const doc = parseDocQuery(q)
      if (doc) {
        for (const d of doc.types) {
          if (!can(d.perm)) continue
          tasks.push(run(
            looseFrom(supabase, d.table).select(`id, number, ${d.dateCol}, status`).eq('number', doc.num).limit(3),
            row => ({
              id: `doc:${d.table}:${row.id}`, kind: 'doc', href: `${d.base}/${row.id}`,
              label: `${t(d.labelKey)} №${row.number}`,
              sub: [fmtDate(row[d.dateCol]), row.status === 'cancelled' ? t('prodShell.cmdk.cancelled') : ''].filter(Boolean).join(' · ') || undefined,
            }),
          ))
        }
      }
      const lot = parseLotQuery(q)
      if (lot && can('prod_stock')) {
        tasks.push(run(
          looseFrom(supabase, 'prod_lots').select('id, lot_no, item_id, expiry_date, prod_items(name)').eq('lot_no', lot).limit(5),
          row => {
            const it = row.prod_items as { name?: string } | { name?: string }[] | null
            const name = Array.isArray(it) ? it[0]?.name : it?.name
            return { id: `lot:${row.id}`, kind: 'lot', href: lotTraceHref(String(row.id)), label: String(row.lot_no), sub: name || undefined }
          },
        ))
      }
      if (!doc && !lot) {
        if (can('prod_suppliers')) {
          tasks.push(run(
            looseFrom(supabase, 'prod_suppliers').select('id, name, phone').ilike('name', like).order('name', { ascending: true }).limit(5),
            row => ({ id: `supplier:${row.id}`, kind: 'supplier', href: `/zavod-yetkazuvchilar/${row.id}`, label: String(row.name), sub: (row.phone as string) || undefined }),
          ))
        }
        if (can('prod_sales')) {
          tasks.push(run(
            looseFrom(supabase, 'prod_customers').select('id, name, phone, inn').or(`name.ilike.${like},legal_name.ilike.${like},inn.ilike.${like}`).order('name', { ascending: true }).limit(5),
            row => ({ id: `customer:${row.id}`, kind: 'customer', href: `/zavod-mijozlar/${row.id}`, label: String(row.name), sub: (row.phone as string) || (row.inn as string) || undefined }),
          ))
        }
        if (can('prod_catalog') || can('prod_stock')) {
          const itemHref = can('prod_catalog') ? '/zavod-mahsulotlar' : '/zavod-qoldiq'
          tasks.push(run(
            looseFrom(supabase, 'prod_items').select('id, name, sku, unit').or(`name.ilike.${like},sku.ilike.${like},barcode.ilike.${like}`).order('name', { ascending: true }).limit(5),
            row => ({ id: `item:${row.id}`, kind: 'item', href: itemHref, label: String(row.name), sub: [row.sku, row.unit].filter(Boolean).join(' · ') || undefined }),
          ))
        }
      }
      const results = (await Promise.all(tasks)).flat()
      if (my !== seq.current) return
      setLive(results)
      setSearching(false)
    }, 200)
    return () => clearTimeout(timer)
  }, [query, open, productionOn, can, t])

  const results = useMemo<Result[]>(() => {
    const q = norm(query.trim())
    if (!q) return [...recent, ...actions.slice(0, 6)]
    const words = q.split(/\s+/)
    const match = (r: Result) => {
      const hay = norm(`${r.label} ${r.sub ?? ''} ${r.href}`)
      return words.every(w => hay.includes(w))
    }
    return [...actions.filter(match), ...pages.filter(match).slice(0, 12), ...live]
  }, [query, recent, actions, pages, live])

  useEffect(() => { setActive(0) }, [query, live.length])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function go(r: Result) {
    pushRecent(userId, r)
    setOpen(false)
    router.push(r.href)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (results.length ? (i + 1) % results.length : 0)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (results.length ? (i - 1 + results.length) % results.length : 0)) }
    else if (e.key === 'Enter') {
      const r = results[active]
      if (r) { e.preventDefault(); go(r) }
    }
  }

  const showingRecent = !query.trim()
  let lastGroup = ''

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-[12%] translate-y-0 gap-0 p-0 sm:max-w-xl overflow-hidden bg-white dark:bg-gray-900">
        <DialogTitle className="sr-only">{t('prodShell.cmdk.title')}</DialogTitle>
        <div className="flex items-center gap-2.5 border-b border-gray-100 dark:border-gray-800 px-4">
          <Search className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t(productionOn ? 'prodShell.cmdk.placeholder' : 'prodShell.cmdk.placeholderPages')}
            className="h-12 w-full bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none"
          />
          {searching && <span className="text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap">{t('prodShell.cmdk.searching')}</span>}
        </div>
        <div ref={listRef} className="max-h-[420px] overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-gray-500 dark:text-gray-400">
              {query.trim() ? t('prodShell.cmdk.empty') : t('prodShell.cmdk.hint')}
            </p>
          ) : results.map((r, i) => {
            const isRecent = showingRecent && i < recent.length
            const groupLabel = isRecent ? t('prodShell.cmdk.groups.recent') : t(KIND_GROUP[r.kind])
            const header = groupLabel !== lastGroup
            lastGroup = groupLabel
            const Icon = isRecent ? History : KIND_ICON[r.kind]
            return (
              <div key={`${isRecent ? 'recent:' : ''}${r.id}`}>
                {header && (
                  <div className="px-4 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">{groupLabel}</div>
                )}
                <button
                  type="button"
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
                    i === active ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-50 dark:hover:bg-gray-800/60',
                  )}
                >
                  <Icon className={cn('h-4 w-4 shrink-0', i === active ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400')} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-gray-900 dark:text-gray-100">{r.label}</span>
                  {r.sub && <span className="max-w-[45%] truncate text-[12px] text-gray-500 dark:text-gray-400">{r.sub}</span>}
                  {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-gray-100 dark:border-gray-800 px-4 py-2 text-[11px] text-gray-400 dark:text-gray-500">
          <span>{t('prodShell.cmdk.keysNav')}</span>
          <span>{t('prodShell.cmdk.keysOpen')}</span>
          <span>{t('prodShell.cmdk.keysClose')}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
