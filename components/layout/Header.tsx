'use client'

import { useEffect, useRef, useState, Fragment } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Bell, Menu, LogOut } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { PaymentModal } from '@/components/PaymentModal'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { NAV_ITEMS, ADMIN_NAV_ITEM, SETTINGS_NAV_ITEM } from '@/components/layout/Sidebar'
import type { TranslationKey } from '@/lib/i18n/translations'

interface HeaderProps {
  onMenuClick?: () => void
}

const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'

interface Crumb {
  label: string
  href?: string
}

const BREADCRUMB_NAV_ITEMS = [...NAV_ITEMS, ADMIN_NAV_ITEM, SETTINGS_NAV_ITEM]

// Reuses the sidebar nav config (components/layout/Sidebar.tsx) as the single
// source of truth for route labels, so breadcrumb text never drifts from the
// sidebar. Only "root + section" is derived here — a page-specific detail
// crumb (e.g. a selected customer's name) would need each page to own that
// state and isn't wired up by this shared Header.
function buildBreadcrumbTrail(pathname: string, t: (key: TranslationKey) => string): Crumb[] {
  const home: Crumb = { label: t('sidebar.dashboard'), href: '/dashboard' }

  for (const item of BREADCRUMB_NAV_ITEMS) {
    if (item.children) {
      for (const child of item.children) {
        if (pathname === child.href || pathname.startsWith(child.href + '/')) {
          const trail: Crumb[] = [home]
          if (item.href !== child.href) trail.push({ label: t(item.labelKey) })
          trail.push({ label: t(child.labelKey), href: child.href })
          return trail
        }
      }
    } else if (pathname === item.href || pathname.startsWith(item.href + '/')) {
      if (item.href === '/dashboard') return [home]
      return [home, { label: t(item.labelKey), href: item.href }]
    }
  }

  return [home]
}

export function Header({ onMenuClick }: HeaderProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { t } = useLanguage()
  const breadcrumbTrail = buildBreadcrumbTrail(pathname, t)
  const [companyName, setCompanyName] = useState('')
  const [userName, setUserName] = useState('')
  const [balance, setBalance] = useState(0)
  const [monthlyFee, setMonthlyFee] = useState(0)
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [paymentModalOpen, setPaymentModalOpen] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const supabase = createClient()

    async function loadCompany() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      if (user.email?.toLowerCase() === SUPER_ADMIN_EMAIL) {
        setIsSuperAdmin(true)
        return
      }

      const { data: userData } = await supabase
        .from('users')
        .select('company_id, full_name')
        .eq('id', user.id)
        .single()

      if (userData?.company_id) {
        const { data: company } = await supabase
          .from('companies')
          .select('name, balance, monthly_fee')
          .eq('id', userData.company_id)
          .single()

        setCompanyName(company?.name || '')
        setBalance(Number(company?.balance ?? 0))
        setMonthlyFee(Number(company?.monthly_fee ?? 0))
        setUserName(userData.full_name || '')
      }
    }

    loadCompany()
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const displayName = isSuperAdmin ? 'Super Admin' : (userName || companyName)
  const initial = isSuperAdmin ? 'SA' : (displayName ? displayName.charAt(0).toUpperCase() : '')

  return (
    <header
      className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 px-6 shrink-0 transition-colors duration-200"
      style={{ height: '64px' }}
    >
      {/* Left — mobile menu + breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onMenuClick}
          className="flex lg:hidden h-8 w-8 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
        >
          <Menu className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        </button>
        <Breadcrumb className="hidden sm:block min-w-0">
          <BreadcrumbList>
            {breadcrumbTrail.map((crumb, i) => {
              const isLast = i === breadcrumbTrail.length - 1
              return (
                <Fragment key={`${crumb.label}-${i}`}>
                  <BreadcrumbItem>
                    {isLast || !crumb.href ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink render={<Link href={crumb.href} />}>
                        {crumb.label}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {!isLast && <BreadcrumbSeparator />}
                </Fragment>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Right — notifications + profile */}
      <div className="flex items-center gap-2">
        {/* Dolphy brand mark */}
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="#2563eb" width="20" height="20">
            <path d="M21 8c-1.5 0-2.5.5-3.5 1.5C16 8 14.5 7 13 7c-1 0-2 .3-2.8.8L8 6.5C6.5 5.5 4.5 5 2.5 5.5L2 6l2 2c-1 1-1.5 2.5-1 4 .5 1.5 2 3 4 3.5 1 .3 2 .2 3-.2l1.5 1.5c.5.5 1 .7 1.5.7s1-.2 1.5-.7l.5-.5c1 .3 2 .2 3-.5 1.5-1 2-2.5 2-4 0-.5 0-1-.2-1.5.7-.5 1.2-1.3 1.2-2.3z" />
          </svg>
          <span className="text-sm font-semibold text-[#2563eb]">Dolphy</span>
        </div>

        {/* Notification bell */}
        <button className="relative flex h-8 w-8 items-center justify-center rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <Bell className="h-4 w-4 text-gray-500 dark:text-gray-400" />
          <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-gray-900 dark:bg-gray-100 ring-1 ring-white dark:ring-gray-950" />
        </button>

        {/* Company balance */}
        {!isSuperAdmin && (
          <button onClick={() => setPaymentModalOpen(true)}>
            <div className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-1.5 border transition-colors hover:opacity-80',
              balance < 0
                ? 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-900'
                : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
            )}>
              <span className="text-xs text-gray-500 dark:text-gray-400">Balans</span>
              <span className={cn(
                'text-sm font-semibold',
                balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-200',
              )}>
                {balance.toLocaleString()} UZS
              </span>
            </div>
          </button>
        )}

        {/* Profile avatar + dropdown */}
        <div className="relative" ref={profileRef}>
          <button
            onClick={() => setProfileOpen(v => !v)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 dark:bg-gray-100 text-[11px] font-medium text-white dark:text-gray-900 select-none transition-opacity hover:opacity-90',
              profileOpen && 'ring-2 ring-gray-900/20 dark:ring-gray-100/20',
            )}
          >
            {initial}
          </button>

          {profileOpen && (
            <div className="absolute right-0 top-10 z-50 w-52 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl overflow-hidden">
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                {t('header.logout')}
              </button>
            </div>
          )}
        </div>
      </div>

      {!isSuperAdmin && (
        <PaymentModal open={paymentModalOpen} onOpenChange={setPaymentModalOpen} monthlyFee={monthlyFee} />
      )}
    </header>
  )
}
