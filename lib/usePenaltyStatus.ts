'use client'

import { useSession } from '@/lib/session/SessionContext'

export type PenaltyStatusValue = 'active' | 'warning' | 'grace' | 'blocked'

interface PenaltyStatus {
  status: PenaltyStatusValue
  daysLeft: number | null
  penaltyDays: number
  totalPenalty: number
  dailyPenalty: number
  monthlyFee: number
  hasContract: boolean
  maxGraceDays: number
}

const INITIAL_STATUS: PenaltyStatus = {
  status: 'active',
  daysLeft: null,
  penaltyDays: 0,
  totalPenalty: 0,
  dailyPenalty: 0,
  monthlyFee: 0,
  hasContract: false,
  maxGraceDays: 5,
}

function computeStatus(daysLeft: number, hasContract: boolean, penaltyDays: number, maxGraceDays: number): PenaltyStatusValue {
  if (daysLeft > 3) return 'active'
  if (daysLeft > 0) return 'warning'
  if (hasContract && penaltyDays < maxGraceDays) return 'grace'
  return 'blocked'
}

// Compares calendar days (local midnight to local midnight) instead of exact
// instants, so the result doesn't drift by a day depending on what time of
// day "now" happens to be relative to the due date's UTC-parsed midnight.
function daysUntil(dueDateStr: string): number {
  const due = new Date(dueDateStr)
  due.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - today.getTime()) / 86400000)
}

export function usePenaltyStatus(): PenaltyStatus {
  const { isSuperAdmin, company } = useSession()

  // Super admin has no company of their own — never blocked.
  if (isSuperAdmin || !company?.paymentDueDate) return INITIAL_STATUS

  const daysLeft = daysUntil(company.paymentDueDate)
  return {
    status: computeStatus(daysLeft, company.hasContract, company.penaltyDays, company.maxGraceDays),
    daysLeft,
    penaltyDays: company.penaltyDays,
    totalPenalty: company.totalPenalty,
    dailyPenalty: company.dailyPenalty,
    monthlyFee: company.monthlyFee,
    hasContract: company.hasContract,
    maxGraceDays: company.maxGraceDays,
  }
}
