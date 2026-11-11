'use client'

import { useCallback, useMemo } from 'react'
import { useSession } from '@/lib/session/SessionContext'
import { useHasPermission } from '@/components/production/MilkKit'
import { isAllBranchRole } from '@/lib/branches'
import { usePrefs, type HomeChoice } from '@/lib/prefs'
import type { DeskKind } from './homeApi'

/** Order of the desks in the switcher and in "Mening ishlarim". */
export const DESK_ORDER: DeskKind[] = ['milk', 'lab', 'stock', 'sales', 'cash']

/** What the start page renders: the dashboard, one desk, or several desks ("Mening ishlarim"). */
export type ResolvedHome = { kind: 'dashboard' } | { kind: 'desk'; desk: DeskKind } | { kind: 'mine'; desks: DeskKind[] }

/**
 * Start page of a production user. prefs.home (lib/prefs.ts usePrefs) wins when the user may see that page; 'auto' decides from the
 * role and permissions: owner / admin -> dashboard; otherwise the user's desks
 * (one -> that desk, several -> "Mening ishlarim", none -> dashboard).
 */
export function useHomePref() {
  const { profile } = useSession()
  const canMilk = useHasPermission('prod_milk')
  const canLab = useHasPermission('prod_lab')
  const canStock = useHasPermission('prod_stock')
  const canSales = useHasPermission('prod_sales')
  const canCash = useHasPermission('prod_cash')
  const isManager = isAllBranchRole(profile?.role)

  const desks = useMemo(() => {
    const allowed: Record<DeskKind, boolean> = { milk: canMilk, lab: canLab, stock: canStock, sales: canSales, cash: canCash }
    return DESK_ORDER.filter(d => allowed[d])
  }, [canMilk, canLab, canStock, canSales, canCash])

  const { prefs, loading: prefsLoading, save } = usePrefs()
  const choice: HomeChoice = prefs.home ?? 'auto'

  const change = useCallback((next: HomeChoice) => { void save({ home: next }) }, [save])

  const resolved: ResolvedHome = useMemo(() => {
    const c = choice
    if (c === 'dashboard') return { kind: 'dashboard' }
    if (c !== 'auto' && desks.includes(c)) return { kind: 'desk', desk: c }
    if (isManager || desks.length === 0) return { kind: 'dashboard' }
    if (desks.length === 1) return { kind: 'desk', desk: desks[0] }
    return { kind: 'mine', desks }
  }, [choice, desks, isManager])

  /** Options of the switcher: Avto, Dashboard and only the desks the user may see. */
  const options: HomeChoice[] = useMemo(() => ['auto', 'dashboard', ...desks], [desks])

  return { loading: prefsLoading || !profile, choice, options, resolved, change, desks }
}
