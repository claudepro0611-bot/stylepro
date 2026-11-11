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
  '/separatsiya',
  '/qayta-ishlash',
  '/xom-ashyo-kirim',
  '/zavod-qoldiq',
  '/zavod-mahsulotlar',
  '/zavod-guruhlar',
  '/zavod-omborlar',
  '/zavod-kochirish',
  '/zavod-hisobdan-chiqarish',
  '/zavod-inventarizatsiya',
  '/zavod-boshlangich-qoldiq',
  '/zavod-narx-tuzatish',
  '/zavod-retseptlar',
  '/taminot',
  '/zavod-yetkazuvchilar',
  '/zavod-yetkazuvchi-tolovlar',
  '/sut-qabuli',
  '/zavod-hisobotlar',
  // Wholesale sales (migration 20261110000015).
  '/zavod-sotuv',
  '/zavod-qaytarishlar',
  '/zavod-mijozlar',
  '/zavod-mijoz-tolovlari',
  '/zavod-narxlar',
  // Cash & bank (migration 20261110000016). '/zavod-kassa' does not match
  // '/zavod-kassa-orderlar' (prefix match is on '<p>/').
  '/zavod-kassa',
  '/zavod-kassa-orderlar',
  '/zavod-kassa-otkazmalar',
  // Controls & audit (migration 20261110000017); role-gated in proxy.ts.
  '/zavod-nazorat',
  '/zavod-davr-yopish',
  '/zavod-audit',
  // Accounting (migration 20261110000018); role-gated in proxy.ts.
  '/zavod-xarajat-taqsimoti',
  // Approval queue (migration 20261110000019): every role (requesters see
  // their own requests); RLS + prod_decide_approval re-check owner / admin.
  '/zavod-tasdiqlar',
  // Daily production plan (migration 20261110000019).
  '/zavod-reja',
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
 * Retail firms: everything except production routes, unless the super admin
 * switched the "production" add-on module on for them (company_features).
 */
export function isPathAllowed(type: BusinessType, pathname: string, productionModule = false): boolean {
  if (type === 'production') {
    return matchesPrefix(pathname, PRODUCTION_PREFIXES) || matchesPrefix(pathname, SHARED_PREFIXES)
  }
  return productionModule || !isProductionPath(pathname)
}
