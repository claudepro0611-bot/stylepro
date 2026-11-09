'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { primeCompanyId } from '@/lib/supabase/helpers'
import { isAllBranchRole, type BranchSummary } from '@/lib/branches'

const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'
const BRANCH_STORAGE_PREFIX = 'stylepro-branch:'
// Stored value for "all branches" (null can't round-trip through localStorage).
const ALL_BRANCHES_VALUE = 'all'

function readStoredBranch(userId: string): string | null {
  try {
    return window.localStorage.getItem(BRANCH_STORAGE_PREFIX + userId)
  } catch {
    return null
  }
}

function writeStoredBranch(userId: string, value: string) {
  try {
    window.localStorage.setItem(BRANCH_STORAGE_PREFIX + userId, value)
  } catch {
    // storage unavailable (private mode / quota) - selection just won't persist
  }
}

export interface SessionProfile {
  role: string | null
  permissions: unknown
  companyId: string | null
  fullName: string | null
}

export interface SessionCompany {
  name: string | null
  balance: number
  monthlyFee: number
  paymentDueDate: string | null
  hasContract: boolean
  dailyPenalty: number
  penaltyDays: number
  totalPenalty: number
  maxGraceDays: number
}

interface SessionState {
  loading: boolean
  userId: string | null
  email: string | null
  isSuperAdmin: boolean
  profile: SessionProfile | null
  company: SessionCompany | null
  refresh: () => Promise<void>
  /** Every branch of the company (active and inactive), default first. */
  branches: BranchSummary[]
  /** The user's own branch (users.branch_id). */
  homeBranchId: string | null
  /** owner/admin: may view all branches and switch between them. */
  canSeeAllBranches: boolean
  /** null = all branches (only possible when canSeeAllBranches). */
  activeBranchId: string | null
  setActiveBranch: (id: string | null) => void
  /** Reloads only the branch list (after branch create/edit/delete). */
  refreshBranches: () => Promise<void>
}

type LoadedState = Omit<SessionState, 'refresh' | 'canSeeAllBranches' | 'activeBranchId' | 'setActiveBranch' | 'refreshBranches'>

interface BranchDbRow { id: string; name: string; is_default: boolean; is_active: boolean }

function mapBranches(rows: BranchDbRow[] | null | undefined): BranchSummary[] {
  return (rows ?? []).map(b => ({ id: b.id, name: b.name, isDefault: b.is_default, isActive: b.is_active }))
}

const SessionContext = createContext<SessionState | null>(null)

/**
 * Loads the signed-in user's profile + company ONCE for the whole dashboard
 * shell. Previously Layout, Sidebar, Header, usePenaltyStatus and
 * usePaymentStatus each called auth.getUser() (a network round trip to the
 * Auth server) and re-queried users/companies on their own — 5+ sequential
 * round trips per full page load. Now: one local getSession() + two parallel
 * queries.
 *
 * UI-only: route access is still enforced server-side in proxy.ts and by RLS.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LoadedState>({
    loading: true,
    userId: null,
    email: null,
    isSuperAdmin: false,
    profile: null,
    company: null,
    branches: [],
    homeBranchId: null,
  })
  // Raw persisted preference: ALL_BRANCHES_VALUE, a branch id, or null
  // (nothing stored yet). Validated against loaded branches in useMemo below.
  const [branchPref, setBranchPref] = useState<string | null>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) {
      setState({ loading: false, userId: null, email: null, isSuperAdmin: false, profile: null, company: null, branches: [], homeBranchId: null })
      setBranchPref(null)
      return
    }

    const isSuperAdmin = user.email?.toLowerCase() === SUPER_ADMIN_EMAIL

    const [userRes, companyRes, branchesRes] = await Promise.all([
      supabase
        .from('users')
        .select('role, permissions, company_id, full_name, branch_id')
        .eq('id', user.id)
        .maybeSingle(),
      // Super admin has no company of their own — querying companies for
      // them would match every row, not one.
      isSuperAdmin
        ? Promise.resolve({ data: null })
        : supabase
            .from('companies')
            .select('name, balance, monthly_fee, payment_due_date, has_contract, daily_penalty, penalty_days, total_penalty, max_grace_days')
            .maybeSingle(),
      // Same reason: the super-admin read policy would return every
      // company's branches.
      isSuperAdmin
        ? Promise.resolve({ data: null })
        : supabase
            .from('branches')
            .select('id, name, is_default, is_active')
            .order('is_default', { ascending: false })
            .order('created_at'),
    ])

    const u = userRes.data
    const c = companyRes.data

    if (u?.company_id) primeCompanyId(user.id, u.company_id)
    setBranchPref(readStoredBranch(user.id))

    setState({
      loading: false,
      userId: user.id,
      email: user.email ?? null,
      isSuperAdmin,
      profile: u
        ? { role: u.role ?? null, permissions: u.permissions, companyId: u.company_id ?? null, fullName: u.full_name ?? null }
        : null,
      company: c
        ? {
            name: c.name ?? null,
            balance: Number(c.balance ?? 0),
            monthlyFee: Number(c.monthly_fee ?? 0),
            paymentDueDate: c.payment_due_date ?? null,
            hasContract: c.has_contract ?? false,
            dailyPenalty: Number(c.daily_penalty ?? 0),
            penaltyDays: c.penalty_days ?? 0,
            totalPenalty: Number(c.total_penalty ?? 0),
            maxGraceDays: c.max_grace_days ?? 5,
          }
        : null,
      branches: mapBranches(branchesRes.data as BranchDbRow[] | null),
      homeBranchId: u?.branch_id ?? null,
    })
  }, [])

  const refreshBranches = useCallback(async () => {
    if (state.isSuperAdmin || !state.userId) return
    const { data } = await createClient()
      .from('branches')
      .select('id, name, is_default, is_active')
      .order('is_default', { ascending: false })
      .order('created_at')
    if (data) setState(prev => ({ ...prev, branches: mapBranches(data as BranchDbRow[]) }))
  }, [state.isSuperAdmin, state.userId])

  const canSeeAllBranches = isAllBranchRole(state.profile?.role)

  // manager/staff are always pinned to their home branch. owner/admin may
  // hold null (= all branches) or any ACTIVE branch; a stale stored id
  // (branch deleted/deactivated) falls back to all branches.
  const activeBranchId = useMemo<string | null>(() => {
    if (!canSeeAllBranches) return state.homeBranchId
    if (!branchPref || branchPref === ALL_BRANCHES_VALUE) return null
    return state.branches.some(b => b.id === branchPref && b.isActive) ? branchPref : null
  }, [canSeeAllBranches, branchPref, state.homeBranchId, state.branches])

  const setActiveBranch = useCallback((id: string | null) => {
    if (!canSeeAllBranches || !state.userId) return
    const value = id ?? ALL_BRANCHES_VALUE
    setBranchPref(value)
    writeStoredBranch(state.userId, value)
  }, [canSeeAllBranches, state.userId])

  useEffect(() => {
    load()
  }, [load])

  return (
    <SessionContext.Provider value={{ ...state, refresh: load, canSeeAllBranches, activeBranchId, setActiveBranch, refreshBranches }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
