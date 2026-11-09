'use client'

import { useCallback, useMemo } from 'react'
import { useSession } from '@/lib/session/SessionContext'
import { useIsMultiBranch } from '@/lib/session/useBranch'
import { branchErrorKey } from '@/lib/branches'
import type { TranslationKey } from '@/lib/i18n/translations'

/**
 * Branch column for list pages (customers, expenses, requests): only shown
 * to owner/admin viewing "All branches" in a multi-branch company. With a
 * single branch nothing changes visually.
 */
export function useBranchColumn() {
  const { canSeeAllBranches, activeBranchId, branches } = useSession()
  const isMulti = useIsMultiBranch()
  const show = isMulti && canSeeAllBranches && activeBranchId === null
  const names = useMemo(() => new Map(branches.map(b => [b.id, b.name])), [branches])
  const branchName = useCallback((id: string | null | undefined) => (id && names.get(id)) || '—', [names])
  return { show, branchName }
}

/**
 * Maps a branch-aware RPC error (customers / nasiya / loyalty / expenses)
 * to a translation key. Returns null for unknown errors so callers can fall
 * back to their existing message. The Postgres error code is deliberately
 * not forwarded: branchErrorKey treats 23505 as a branch-name clash.
 */
export function branchRpcErrorKey(message: string | null | undefined): TranslationKey | null {
  if (!message) return null
  if (message.includes('customer_not_found')) return 'branchCustomers.customerNotFound'
  return branchErrorKey(message)
}
