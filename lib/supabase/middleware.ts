import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { PermissionKey } from '@/lib/permissions'

const PUBLIC_PATHS = ['/login']
const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

// Route-prefix -> PERMISSION_KEY. Only the modules named in the Phase 4
// brief are gated here; /dashboard, /sozlamalar, /pos stay role-based-only
// (every authenticated company user can reach them). Other permission-
// gated pages (e.g. /mahsulot-guruhi, /xarajatlar, /hr) are not in this
// list and remain guarded only by the sidebar's visibility check, not this
// middleware — flagged as out of this migration's literal scope.
const ROUTE_PERMISSIONS: Record<string, PermissionKey> = {
  '/mahsulotlar': 'mahsulotlar',
  '/kirim': 'kirim',
  '/chiqim': 'chiqim',
  '/brak': 'brak',
  '/arxiv': 'pos',
  '/customers': 'customers',
  '/reports': 'reports',
  '/marketing': 'marketing',
}

export async function updateSession(request: NextRequest) {
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

  const { pathname } = request.nextUrl
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
