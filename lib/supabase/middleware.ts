import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { PermissionKey } from '@/lib/permissions'

const PUBLIC_PATHS = ['/login']
const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

// Paths that must fully bypass the auth/permission logic below - called
// server-to-server (e.g. by Telegram's webhook infra) with no browser
// session/cookies, so they can never satisfy the `user` check and would
// otherwise get redirected to /login on every request.
const BYPASS_PATHS = ['/api/telegram/webhook', '/api/cron']

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
  '/arxiv': 'pos',
  '/sotuvlar': 'arxiv',
  '/qaytarishlar': 'arxiv',
  '/tolovlar': 'arxiv',
  '/customers': 'customers',
  '/reports': 'reports',
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

  if (user) {
    const guardedPrefix = Object.keys(ROUTE_PERMISSIONS).find(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
    if (guardedPrefix) {
      const { data: allowed } = await supabase.rpc('has_permission', {
        p_key: ROUTE_PERMISSIONS[guardedPrefix],
      })
      if (!allowed) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
      }
    }
  }

  return response
}
