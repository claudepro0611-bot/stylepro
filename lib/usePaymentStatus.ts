'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

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

export function usePaymentStatus() {
  const [status, setStatus] = useState<PaymentStatus>(INITIAL_STATUS)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    async function load() {
      const { data: { user } } = await supabase.auth.getUser()

      // Super admin has no company of their own — never blocked, and
      // querying companies for them would match every row, not one.
      if (!user || user.email?.toLowerCase() === SUPER_ADMIN_EMAIL) {
        if (!cancelled) setStatus(prev => ({ ...prev, loading: false }))
        return
      }

      const { data } = await supabase
        .from('companies')
        .select('payment_due_date, monthly_fee')
        .maybeSingle()

      if (cancelled) return

      if (!data?.payment_due_date) {
        setStatus(prev => ({ ...prev, loading: false }))
        return
      }

      const daysLeft = Math.ceil((new Date(data.payment_due_date).getTime() - Date.now()) / 86400000)
      setStatus({
        daysLeft,
        isBlocked: daysLeft < 0,
        monthlyFee: data.monthly_fee ?? 0,
        dueDate: data.payment_due_date,
        loading: false,
      })
    }

    load()
    return () => { cancelled = true }
  }, [])

  return status
}
