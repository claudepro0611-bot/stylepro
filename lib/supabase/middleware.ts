import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { PermissionKey } from '@/lib/permissions'

const PUBLIC_PATHS = ['/login']
const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

// Paths that must fully bypass the auth/permission logic below - called
// server-to-server (e.g. by Telegram's webhook infra) with no browser
// session/cookies, so they can never satisfy the `user` check and would
// otherwise get redirected to /login on every request.
const BYPASS_PATHS = ['/api/telegram/webhook']

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
  '/customers': 'customers',
  '/reports': 'reports',
  '/marketing': 'marketing',
  '/mahsulot-guruhi': 'mahsulot_guruhi',
  '/xarajatlar': 'xarajatlar',
  '/requests': 'requests',
  '/hr': 'hr',
  '/jamoa': 'jamoa',
  '/inventory': 'inventory',
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

  const { data: { user } } = await supabase.auth.getUser()

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
