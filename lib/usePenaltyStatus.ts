'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

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

export function usePenaltyStatus() {
  const [status, setStatus] = useState<PenaltyStatus>(INITIAL_STATUS)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    async function load() {
      const { data: { user } } = await supabase.auth.getUser()

      // Super admin has no company of their own — never blocked, and
      // querying companies for them would match every row, not one.
      if (!user || user.email?.toLowerCase() === SUPER_ADMIN_EMAIL) {
        if (!cancelled) setStatus(INITIAL_STATUS)
        return
      }

      const { data } = await supabase
        .from('companies')
        .select('payment_due_date, monthly_fee, has_contract, daily_penalty, penalty_days, total_penalty, grace_period_start, max_grace_days')
        .maybeSingle()

      if (cancelled) return

      if (!data?.payment_due_date) {
        setStatus(INITIAL_STATUS)
        return
      }

      const daysLeft = daysUntil(data.payment_due_date)
      const hasContract = data.has_contract ?? false
      const penaltyDays = data.penalty_days ?? 0
      const maxGraceDays = data.max_grace_days ?? 5

      setStatus({
        status: computeStatus(daysLeft, hasContract, penaltyDays, maxGraceDays),
        daysLeft,
        penaltyDays,
        totalPenalty: Number(data.total_penalty ?? 0),
        dailyPenalty: Number(data.daily_penalty ?? 0),
        monthlyFee: Number(data.monthly_fee ?? 0),
        hasContract,
        maxGraceDays,
      })
    }

    load()
    return () => { cancelled = true }
  }, [])

  return status
}
