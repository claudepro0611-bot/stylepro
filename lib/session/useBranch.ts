'use client'

import { useCallback } from 'react'
import { useSession } from '@/lib/session/SessionContext'

/**
 * Shared branch helpers for pages. Single source of truth for the
 * branches rollout (phases 3–5) — use these instead of reading
 * SessionContext branch fields ad hoc.
 *
 * Security model: RLS already restricts manager/staff to their own branch,
 * so these helpers are about the owner/admin "current branch" choice
 * (Header switcher) and about picking a concrete branch for writes.
 */

/**
 * Read filter. Returns a function that narrows a Supabase query to the
 * active branch, or leaves it untouched when the owner/admin chose
 * "All branches" (activeBranchId === null). Pass the column name when a
 * table names it differently.
 *
 *   const applyBranch = useBranchFilter()
 *   const q = applyBranch(supabase.from('transactions_net').select('*'))
 *
 * Add `activeBranchId` (from useActiveBranchId) to the fetching effect's
 * dependency list so the page reloads when the switcher changes.
 */
export function useBranchFilter() {
  const { activeBranchId } = useSession()
  return useCallback(
    <Q extends { eq: (column: string, value: string) => Q }>(query: Q, column = 'branch_id'): Q =>
      activeBranchId ? query.eq(column, activeBranchId) : query,
    [activeBranchId],
  )
}

/** The active branch id (null = all branches; staff always get their own). */
export function useActiveBranchId(): string | null {
  return useSession().activeBranchId
}

/**
 * A concrete branch for writes (POS sale, new customer, new expense, opening
 * a shift). Owner/admin on "All branches" fall back to their home branch,
 * then the company default. The server re-validates it with
 * resolve_branch_id(), so this is a UX default, never a security boundary.
 */
export function useWriteBranchId(): string | null {
  const { activeBranchId, homeBranchId, branches } = useSession()
  if (activeBranchId) return activeBranchId
  const home = branches.find(b => b.id === homeBranchId && b.isActive)
  if (home) return home.id
  return branches.find(b => b.isDefault)?.id ?? homeBranchId ?? null
}

/** True when the company has more than one active branch (show branch UI). */
export function useIsMultiBranch(): boolean {
  return useSession().branches.filter(b => b.isActive).length > 1
}
