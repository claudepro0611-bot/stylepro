'use client'

import { Eye, EyeOff } from 'lucide-react'
import { useLocalStorage } from '@/hooks/useLocalStorage'

interface StatsPanelProps {
  storageKey: string
  title: string
  subtitle?: string
  children: React.ReactNode
}

export function StatsPanel({ storageKey, title, subtitle, children }: StatsPanelProps) {
  const [open, setOpen] = useLocalStorage<boolean>(storageKey, false)

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</p>
          {subtitle && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{subtitle}</p>
          )}
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
          {open ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </div>
      </button>
      <div className={`grid transition-all duration-200 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="border-t border-gray-100 dark:border-gray-800 px-4 pt-4 pb-4">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
