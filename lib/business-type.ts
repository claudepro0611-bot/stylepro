// Company business type. Set once by the super admin on firm creation and
// immutable afterwards (DB trigger). It decides which modules a firm sees:
// retail firms get the existing StylePro shop modules, production firms get
// the plant modules below plus a small set of shared ones.
//
// This is the single source of truth for route access by business type, used
// by the proxy guard (lib/supabase/middleware.ts). The DB enforces the same
// split in has_permission() / assert_business_type(), so this is defence in
// depth, not the only boundary.

export type BusinessType = 'retail' | 'production'

export const BUSINESS_TYPES: BusinessType[] = ['retail', 'production']

/** Routes that exist only for production firms. */
export const PRODUCTION_PREFIXES = [
  '/ishlab-chiqarish',
  '/qayta-ishlash',
  '/xom-ashyo-kirim',
  '/zavod-qoldiq',
  '/zavod-mahsulotlar',
  '/zavod-guruhlar',
  '/zavod-omborlar',
  '/taminot',
] as const

/** Routes both business types may open. */
export const SHARED_PREFIXES = [
  '/dashboard',
  '/xarajatlar',
  '/hr',
  '/jamoa',
  '/sozlamalar',
  '/valyuta-kurslari',
  '/super-admin',
] as const

/** Anything that is not literally 'production' is treated as retail. */
export function toBusinessType(value: unknown): BusinessType {
  return value === 'production' ? 'production' : 'retail'
}

function matchesPrefix(pathname: string, prefixes: readonly string[]) {
  return prefixes.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

export function isProductionPath(pathname: string): boolean {
  return matchesPrefix(pathname, PRODUCTION_PREFIXES)
}

/**
 * Production firms: only production + shared routes.
 * Retail firms: everything except production routes (unchanged behaviour).
 */
export function isPathAllowed(type: BusinessType, pathname: string): boolean {
  if (type === 'production') {
    return matchesPrefix(pathname, PRODUCTION_PREFIXES) || matchesPrefix(pathname, SHARED_PREFIXES)
  }
  return !isProductionPath(pathname)
}
