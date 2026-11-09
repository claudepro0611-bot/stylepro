'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Store } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'

/**
 * Header branch switcher.
 *  - owner/admin with >1 active branches: dropdown ("all branches" + each active branch)
 *  - manager/staff in a company with >1 branches: static label of their own branch
 *  - single-branch company: renders nothing (header looks exactly as before)
 */
export function BranchSwitcher() {
  const { t } = useLanguage()
  const { isSuperAdmin, branches, homeBranchId, canSeeAllBranches, activeBranchId, setActiveBranch } = useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (isSuperAdmin) return null

  const activeBranches = branches.filter(b => b.isActive)

  if (!canSeeAllBranches) {
    if (branches.length <= 1) return null
    const home = branches.find(b => b.id === homeBranchId)
    if (!home) return null
    return (
      <div className="hidden sm:flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-1.5">
        <Store className="h-3.5 w-3.5 text-gray-400" />
        <span className="max-w-40 truncate text-sm font-medium text-gray-800 dark:text-gray-200">{home.name}</span>
      </div>
    )
  }

  if (activeBranches.length <= 1) return null

  const current = activeBranches.find(b => b.id === activeBranchId)
  const label = current ? current.name : t('branches.allBranches')

  function pick(id: string | null) {
    setActiveBranch(id)
    setOpen(false)
  }

  const itemCls = 'flex w-full items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors'

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('branches.branchLabel')}
        className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors"
      >
        <Store className="h-3.5 w-3.5 text-gray-400" />
        <span className="max-w-40 truncate text-sm font-medium text-gray-800 dark:text-gray-200">{label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-gray-400 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-10 z-50 w-56 max-h-80 overflow-y-auto rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl"
        >
          <button type="button" role="option" aria-selected={activeBranchId === null} onClick={() => pick(null)} className={itemCls}>
            <span className="flex-1 truncate text-left">{t('branches.allBranches')}</span>
            {activeBranchId === null && <Check className="h-3.5 w-3.5 text-gray-900 dark:text-gray-100" />}
          </button>
          <div className="border-t border-gray-100 dark:border-gray-800" />
          {activeBranches.map(b => (
            <button key={b.id} type="button" role="option" aria-selected={activeBranchId === b.id} onClick={() => pick(b.id)} className={itemCls}>
              <span className="flex-1 truncate text-left">{b.name}</span>
              {activeBranchId === b.id && <Check className="h-3.5 w-3.5 text-gray-900 dark:text-gray-100" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
