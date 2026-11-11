import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { PermissionKey } from '@/lib/permissions'
import { isPathAllowed, toBusinessType } from '@/lib/business-type'

const PUBLIC_PATHS = ['/login']
const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

// Paths that must fully bypass the auth/permission logic below - called
// server-to-server (e.g. by Telegram's webhook infra) with no browser
// session/cookies, so they can never satisfy the `user` check and would
// otherwise get redirected to /login on every request.
const BYPASS_PATHS = ['/api/telegram/webhook', '/api/cron']

// Role-gated (not permission-gated) prefixes: only all-branch roles
// (owner/admin) may enter. Deliberately no PermissionKey - branch
// management is tied to the role, same as get_branch_id() in SQL.
const ALL_BRANCH_ROLE_PATHS = ['/filiallar']
const ALL_BRANCH_ROLES = ['owner', 'admin']

// Production controls (migration 20261110000017), also role-gated: control
// settings and period close are owner-only, the audit log owner/admin (the
// RPCs and the audit-log RLS policy re-check the same roles).
const OWNER_ONLY_PATHS = ['/zavod-nazorat', '/zavod-davr-yopish']
// Accounting (migration 20261110000018): overhead pools and the P&L / VAT /
// full-cost reports are owner / admin too (prod_pnl, the pool RPCs re-check).
const OWNER_ADMIN_PATHS = [
  '/zavod-audit',
  '/zavod-xarajat-taqsimoti',
  '/zavod-hisobotlar/foyda',
  '/zavod-hisobotlar/qqs',
  '/zavod-hisobotlar/tannarx',
]

// Route-prefix -> PERMISSION_KEY. /dashboard, /sozlamalar, /pos stay
// role-based-only (every authenticated company user can reach them).
// All other permission-gated pages are now covered here as well, closing
// the earlier gap where they were guarded only by the sidebar's
// visibility check and not this middleware.
const ROUTE_PERMISSIONS: Record<string, PermissionKey> = {
  '/mahsulotlar': 'mahsulotlar',
  '/kirim': 'kirim',
  '/chiqim': 'chiqim',
  '/brak': 'brak',
  '/peremeshenie': 'peremeshenie',
  '/yetkazuvchilar': 'yetkazuvchilar',
  '/xaridlar': 'yetkazuvchilar',
  '/yetkazuvchi-qaytarish': 'yetkazuvchilar',
  '/yetkazuvchi-tolovlar': 'yetkazuvchilar',
  '/arxiv': 'pos',
  '/sotuvlar': 'arxiv',
  '/qaytarishlar': 'arxiv',
  '/tolovlar': 'arxiv',
  '/customers': 'customers',
  '/reports': 'reports',
  '/reports/moliya': 'reports_moliya',
  '/reports/foyda': 'reports_foyda',
  '/reports/sotuvlar': 'reports_sotuvlar',
  '/reports/yetkazuvchilar': 'reports_yetkazuvchilar',
  '/reports/kirim': 'reports_kirim',
  '/reports/peremeshenie': 'reports_peremeshenie',
  '/reports/spisaniya': 'reports_spisaniya',
  '/reports/xarajatlar': 'reports_xarajatlar',
  '/reports/inventar': 'reports_inventar',
  '/marketing': 'marketing',
  '/mahsulot-guruhi': 'mahsulot_guruhi',
  '/xarajatlar': 'xarajatlar',
  '/requests': 'requests',
  '/hr': 'hr',
  '/jamoa': 'jamoa',
  '/inventory': 'inventory',
  '/omborlar': 'inventory',
  '/inventarizatsiya': 'inventory',
  '/valyuta-kurslari': 'sozlamalar',
  '/prays-list': 'mahsulotlar',
  // Production firms (business_type = 'production'). Retail firms never get
  // this far for these paths: the business-type check redirects them first.
  '/ishlab-chiqarish': 'prod_production',
  '/separatsiya': 'prod_production',
  '/qayta-ishlash': 'prod_processing',
  '/xom-ashyo-kirim': 'prod_receipts',
  '/zavod-qoldiq': 'prod_stock',
  '/zavod-mahsulotlar': 'prod_catalog',
  '/zavod-guruhlar': 'prod_catalog',
  '/zavod-omborlar': 'prod_stock',
  '/zavod-kochirish': 'prod_stock',
  // Inventory documents (migration 20261110000014).
  '/zavod-hisobdan-chiqarish': 'prod_stock',
  '/zavod-inventarizatsiya': 'prod_stock',
  '/zavod-boshlangich-qoldiq': 'prod_stock',
  '/zavod-narx-tuzatish': 'prod_receipts',
  '/zavod-retseptlar': 'prod_catalog',
  '/taminot': 'prod_supply',
  '/zavod-yetkazuvchilar': 'prod_suppliers',
  '/zavod-yetkazuvchi-tolovlar': 'prod_suppliers',
  // Covers /sut-qabuli/yangi, /[id] and /sozlamalar too. Lab actions need
  // 'prod_lab' as well, checked on the page and in prod_record_milk_lab.
  '/sut-qabuli': 'prod_milk',
  // Read-only production reports (oborot, qoldiq, muddat, partiya, ...).
  '/zavod-hisobotlar': 'prod_stock',
  // Wholesale sales (migration 20261110000015). The sales reports need
  // 'prod_stock' (parent prefix) and 'prod_sales'.
  '/zavod-hisobotlar/sotuv': 'prod_sales',
  '/zavod-hisobotlar/debitorlik': 'prod_sales',
  '/zavod-sotuv': 'prod_sales',
  '/zavod-qaytarishlar': 'prod_sales',
  '/zavod-mijozlar': 'prod_sales',
  '/zavod-narxlar': 'prod_sales',
  '/zavod-mijoz-tolovlari': 'prod_customer_payments',
  // Cash & bank (migration 20261110000016). The cash report also needs
  // 'prod_stock' (parent /zavod-hisobotlar prefix).
  '/zavod-kassa': 'prod_cash',
  '/zavod-kassa-orderlar': 'prod_cash',
  '/zavod-kassa-otkazmalar': 'prod_cash',
  '/zavod-hisobotlar/kassa': 'prod_cash',
  // Overhead pools (migration 20261110000018); also owner / admin (OWNER_ADMIN_PATHS).
  '/zavod-xarajat-taqsimoti': 'prod_stock',
}

// API routes do their own auth and are called by pages of both business
// types (e.g. /api/exchange-rates/cbu from /valyuta-kurslari), so the
// business-type route split does not apply to them.
const API_PREFIX = '/api/'

/** users.companies embed: an object for a many-to-one FK, tolerate arrays. */
function embeddedBusinessType(companies: unknown): unknown {
  const row = Array.isArray(companies) ? companies[0] : companies
  return row && typeof row === 'object' ? (row as { business_type?: unknown }).business_type : undefined
}

/** Whether the firm has the "production" add-on module active and unexpired. */
function embeddedProductionModule(companies: unknown): boolean {
  const row = Array.isArray(companies) ? companies[0] : companies
  const features = row && typeof row === 'object' ? (row as { company_features?: unknown }).company_features : undefined
  if (!Array.isArray(features)) return false
  const now = Date.now()
  return features.some((f: { feature_key?: unknown; is_active?: unknown; expires_at?: unknown }) =>
    f.feature_key === 'production' && f.is_active === true &&
    (f.expires_at == null || new Date(String(f.expires_at)).getTime() > now))
}

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (BYPASS_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next()
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  // getClaims() verifies the JWT locally against the project's cached
  // asymmetric (ES256) signing keys — no Auth-server round trip on every
  // navigation, unlike getUser(). It still refreshes an expired session.
  const { data: claimsData } = await supabase.auth.getClaims()
  const claims = claimsData?.claims
  const user = claims?.sub ? { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined } : null

  const isPublicPath = PUBLIC_PATHS.includes(pathname)

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && isPublicPath) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  if (pathname.startsWith('/super-admin') && user?.email?.toLowerCase() !== SUPER_ADMIN_EMAIL) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  if (user && !pathname.startsWith(API_PREFIX)) {
    // The ONE profile query per request: role (for /filiallar) and the
    // company's business type (module split) together.
    // eslint-disable-next-line prefer-const
    let { data: me, error: meError } = await supabase
      .from('users')
      .select('role, companies(business_type, company_features(feature_key, is_active, expires_at))')
      .eq('id', user.id)
      .maybeSingle()
    // Safety net while migration 20261110000001 is not yet applied (column
    // companies.business_type missing): fall back to the role-only query so
    // every firm keeps working as retail instead of breaking navigation.
    if (meError) {
      const fallback = await supabase.from('users').select('role').eq('id', user.id).maybeSingle()
      me = fallback.data ? { ...fallback.data, companies: [] } : null
    }

    // Super admin has no company of their own; route split does not apply.
    if (user.email?.toLowerCase() !== SUPER_ADMIN_EMAIL) {
      const businessType = toBusinessType(embeddedBusinessType(me?.companies))
      // Production firms: only production + shared routes (this also blocks
      // /pos and /filiallar). Retail firms: production routes are blocked.
      if (!isPathAllowed(businessType, pathname, embeddedProductionModule(me?.companies))) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
      }
    }

    if (ALL_BRANCH_ROLE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      if (!me?.role || !ALL_BRANCH_ROLES.includes(me.role)) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
      }
    }

    const ownerOnly = OWNER_ONLY_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
    const ownerAdmin = OWNER_ADMIN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
    if ((ownerOnly && me?.role !== 'owner') || (ownerAdmin && (!me?.role || !ALL_BRANCH_ROLES.includes(me.role)))) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      return NextResponse.redirect(url)
    }
  }

  if (user) {
    // Every matching prefix must pass, so a nested route (/reports/kirim)
    // needs both its parent key ('reports') and its own ('reports_kirim').
    const guardedPrefixes = Object.keys(ROUTE_PERMISSIONS).filter(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
    if (guardedPrefixes.length > 0) {
      const results = await Promise.all(
        guardedPrefixes.map((p) => supabase.rpc('has_permission', { p_key: ROUTE_PERMISSIONS[p] })),
      )
      if (results.some(({ data: allowed }) => !allowed)) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
      }
    }
  }

  return response
}
