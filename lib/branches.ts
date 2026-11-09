import type { TranslationKey } from '@/lib/i18n/translations'

export interface BranchSummary {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
}

export interface BranchOverviewRow {
  id: string
  name: string
  address: string | null
  phone: string | null
  is_default: boolean
  is_active: boolean
  created_at: string
  warehouse_count: number
  user_count: number
}

/** Roles that see every branch of the company (mirrors get_branch_id() in SQL). */
export function isAllBranchRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

// Order matters: specific codes before the generic 'forbidden'
// ('branch_forbidden' contains 'forbidden'; 'warehouse_not_empty' and
// 'branch_not_empty' are distinct substrings).
const BRANCH_ERROR_KEYS: [string, TranslationKey][] = [
  ['branch_name_required', 'branches.errors.branchNameRequired'],
  ['branch_name_taken', 'branches.errors.branchNameTaken'],
  ['branch_limit_reached', 'branches.errors.branchLimitReached'],
  ['branch_not_found', 'branches.errors.branchNotFound'],
  ['branch_is_default', 'branches.errors.branchIsDefault'],
  ['branch_has_open_shift', 'branches.errors.branchHasOpenShift'],
  ['branch_has_users', 'branches.errors.branchHasUsers'],
  ['branch_inactive', 'branches.errors.branchInactive'],
  ['branch_not_empty', 'branches.errors.branchNotEmpty'],
  ['warehouse_not_empty', 'branches.errors.warehouseNotEmpty'],
  ['branch_forbidden', 'branches.errors.branchForbidden'],
  ['branch_required', 'branches.errors.branchRequired'],
  ['forbidden', 'branches.errors.forbidden'],
]

/**
 * Maps a branch RPC / server-action error message to a translation key.
 * Returns null when the message is not a known branch error code.
 */
export function branchErrorKey(message: string | null | undefined, code?: string | null): TranslationKey | null {
  if (code === '23505') return 'branches.errors.branchNameTaken'
  if (!message) return null
  for (const [needle, key] of BRANCH_ERROR_KEYS) {
    if (message.includes(needle)) return key
  }
  return null
}
