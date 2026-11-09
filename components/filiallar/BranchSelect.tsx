'use client'

import { useLanguage } from '@/lib/i18n/LanguageContext'

export interface BranchSelectOption { id: string; name: string; isActive: boolean }

interface BranchSelectProps {
  value: string
  onChange: (id: string) => void
  /** Selectable branches. Pass active branches; an inactive current value is appended automatically. */
  options: BranchSelectOption[]
  /** Branch list used to label an inactive current value. */
  allBranches?: BranchSelectOption[]
  disabled?: boolean
}

const selectCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900 transition-colors disabled:opacity-60'

/** Labelled native branch select - same styling as other dialog selects (AddCustomerDialog). */
export function BranchSelect({ value, onChange, options, allBranches, disabled }: BranchSelectProps) {
  const { t } = useLanguage()
  const current = value && !options.some(o => o.id === value)
    ? allBranches?.find(b => b.id === value)
    : undefined

  return (
    <div>
      <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('branches.branchLabel')}</label>
      <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled} className={selectCls}>
        {!value && <option value="" disabled>{t('branches.errors.branchRequired')}</option>}
        {current && (
          <option value={current.id}>{current.name} ({t('branches.status.inactive')})</option>
        )}
        {options.map(o => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </div>
  )
}
