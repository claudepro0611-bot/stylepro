'use client'

import { Store } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { useIsMultiBranch } from '@/lib/session/useBranch'

/**
 * Small "which branch is this data for" line under a report/dashboard title.
 * Follows the Header branch switcher. Renders nothing for single-branch
 * companies, so those pages look exactly as before.
 */
export function BranchScopeLabel({ className }: { className?: string }) {
  const { t } = useLanguage()
  const { branches, activeBranchId } = useSession()
  const isMultiBranch = useIsMultiBranch()
  if (!isMultiBranch) return null

  const name = activeBranchId ? branches.find(b => b.id === activeBranchId)?.name : null

  return (
    <p className={cn('flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400', className)}>
      <Store className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
      <span className="truncate">{name ?? t('branchReports.allBranches')}</span>
    </p>
  )
}
