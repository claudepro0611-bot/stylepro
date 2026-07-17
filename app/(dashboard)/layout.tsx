'use client'

import { useEffect, useState } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { PaymentBlockScreen } from '@/components/PaymentBlockScreen'
import { usePenaltyStatus } from '@/lib/usePenaltyStatus'
import { createClient } from '@/lib/supabase/client'

const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { status, monthlyFee, penaltyDays, totalPenalty } = usePenaltyStatus()
  const [userEmail, setUserEmail] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null)
    })
  }, [])

  const isSuperAdmin = userEmail?.toLowerCase() === SUPER_ADMIN_EMAIL

  if (status === 'blocked' && !isSuperAdmin) {
    return <PaymentBlockScreen status="blocked" monthlyFee={monthlyFee} penaltyDays={penaltyDays} totalPenalty={totalPenalty} />
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden transition-colors duration-200">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex relative z-10 border-r border-gray-100 dark:border-gray-800">
        <Sidebar />
      </div>

      {/* Mobile sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50">
            <Sidebar forceExpanded />
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        {status === 'grace' && !isSuperAdmin && (
          <PaymentBlockScreen status="grace" monthlyFee={monthlyFee} penaltyDays={penaltyDays} totalPenalty={totalPenalty} />
        )}
        <main className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </main>
      </div>
    </div>
  )
}
