'use client'

import { useSession } from '@/lib/session/SessionContext'

interface PaymentStatus {
  daysLeft: number | null
  isBlocked: boolean
  monthlyFee: number
  dueDate: string | null
  loading: boolean
}

const INITIAL_STATUS: PaymentStatus = {
  daysLeft: null,
  isBlocked: false,
  monthlyFee: 0,
  dueDate: null,
  loading: true,
}

function daysUntilCeil(dueDateStr: string): number {
  return Math.ceil((new Date(dueDateStr).getTime() - Date.now()) / 86400000)
}

export function usePaymentStatus(): PaymentStatus {
  const { loading, isSuperAdmin, company } = useSession()

  if (loading) return INITIAL_STATUS
  // Super admin has no company of their own — never blocked.
  if (isSuperAdmin || !company?.paymentDueDate) return { ...INITIAL_STATUS, loading: false }

  const daysLeft = daysUntilCeil(company.paymentDueDate)
  return {
    daysLeft,
    isBlocked: daysLeft < 0,
    monthlyFee: company.monthlyFee,
    dueDate: company.paymentDueDate,
    loading: false,
  }
}
