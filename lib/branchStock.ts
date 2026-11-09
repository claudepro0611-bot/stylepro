'use client'

import { useCallback } from 'react'
import type { TranslationKey } from '@/lib/i18n/translations'
import { branchErrorKey } from '@/lib/branches'
import { useSession } from '@/lib/session/SessionContext'
import { useIsMultiBranch } from '@/lib/session/useBranch'

/**
 * Branches rollout, phase 3 (POS, stock and sales pages) helpers.
 */

// Order matters: 'customer_wrong_branch' contains 'wrong_branch'.
const BRANCH_STOCK_ERROR_KEYS: [string, TranslationKey][] = [
  ['customer_wrong_branch', 'branchStock.errors.customerWrongBranch'],
  ['wrong_branch', 'branchStock.errors.wrongBranch'],
  ['invalid_shift', 'branchStock.errors.invalidShift'],
  ['catalog_forbidden', 'branchStock.errors.catalogForbidden'],
]

/**
 * Maps the branch-related RPC errors raised by sell_cart, the stock write
 * RPCs and the catalog mutations to a translation key ('branch_forbidden'
 * etc. fall through to branchErrorKey). null = not a branch error.
 */
export function branchStockErrorKey(message: string | null | undefined): TranslationKey | null {
  if (!message) return null
  for (const [needle, key] of BRANCH_STOCK_ERROR_KEYS) {
    if (message.includes(needle)) return key
  }
  const key = branchErrorKey(message)
  // The generic 'forbidden' fallback is left to each caller's own mapping.
  return key === 'branches.errors.forbidden' ? null : key
}

interface BranchedWarehouse { id: string; name: string; branch_id?: string | null }

/**
 * Warehouse pickers scoped to the active branch.
 *  - scope(list): warehouses of the active branch (owner/admin on "All
 *    branches": every warehouse). Single-branch companies: list unchanged.
 *  - label(w): warehouse name, suffixed with its branch name when the list
 *    spans several branches (multi-branch and no single branch active).
 *  - labelAlways(w): suffix whenever the company is multi-branch (pickers
 *    that list every company warehouse, e.g. a transfer destination).
 */
export function useWarehouseScope() {
  const { branches, activeBranchId } = useSession()
  const multiBranch = useIsMultiBranch()
  const showBranch = multiBranch && activeBranchId === null

  const branchName = useCallback(
    (id: string | null | undefined) => (id ? branches.find(b => b.id === id)?.name ?? '' : ''),
    [branches],
  )

  const scope = useCallback(
    <W extends BranchedWarehouse>(list: W[]): W[] =>
      multiBranch && activeBranchId ? list.filter(w => w.branch_id === activeBranchId) : list,
    [multiBranch, activeBranchId],
  )

  const withBranch = useCallback(
    (w: BranchedWarehouse) => {
      const b = branchName(w.branch_id)
      return b ? `${w.name} · ${b}` : w.name
    },
    [branchName],
  )

  const label = useCallback(
    (w: BranchedWarehouse) => (showBranch ? withBranch(w) : w.name),
    [showBranch, withBranch],
  )

  const labelAlways = useCallback(
    (w: BranchedWarehouse) => (multiBranch ? withBranch(w) : w.name),
    [multiBranch, withBranch],
  )

  /** Sorts warehouses by branch (default branch first) when labels show branches. */
  const groupByBranch = useCallback(
    <W extends BranchedWarehouse>(list: W[], force = false): W[] => {
      if (!(force ? multiBranch : showBranch)) return list
      const order = new Map(branches.map((b, i) => [b.id, i]))
      return [...list].sort((a, b) => (order.get(a.branch_id ?? '') ?? 999) - (order.get(b.branch_id ?? '') ?? 999))
    },
    [branches, multiBranch, showBranch],
  )

  return { multiBranch, showBranch, activeBranchId, branchName, scope, label, labelAlways, groupByBranch }
}

/**
 * `.eq(column, branchId)` for tables whose branch columns aren't in the
 * generated Database types yet (product_sizes, customers, shifts...). No-op
 * when branchId is empty.
 */
export function eqBranch<Q>(query: Q, branchId: string | null | undefined, column = 'branch_id'): Q {
  if (!branchId) return query
  return (query as unknown as { eq: (c: string, v: string) => Q }).eq(column, branchId)
}

/** stock_transfers touching a branch at either end (no-op when branchId is empty). */
export function eitherBranchEnd<Q>(query: Q, branchId: string | null | undefined): Q {
  if (!branchId) return query
  return (query as unknown as { or: (f: string) => Q }).or(`from_branch_id.eq.${branchId},to_branch_id.eq.${branchId}`)
}

/**
 * Error toast key for stock / catalog writes: branch errors first, then the
 * generic forbidden / error fallback every page used before.
 */
export function branchAwareErrorKey(message: string | null | undefined): TranslationKey {
  return branchStockErrorKey(message) ?? (message?.includes('forbidden') ? 'common.forbidden' : 'common.error')
}
