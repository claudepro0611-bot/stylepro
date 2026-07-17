'use client'

import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'

const GREEN = 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400'
const AMBER = 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
const RED = 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
const GRAY = 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'

export const STATUS_PILL: Record<string, string> = {
  // Customer status
  VIP: GRAY,
  Regular: GRAY,
  New: GRAY,
  // Transaction/Invoice
  paid: GREEN,
  completed: GREEN,
  pending: AMBER,
  overdue: RED,
  cancelled: RED,
  // Campaign/Product
  active: GREEN,
  inactive: GRAY,
  ended: GRAY,
  expired: RED,
  // Request status
  new: GRAY,
  'in-progress': AMBER,
  resolved: GREEN,
  // Priority
  high: RED,
  medium: AMBER,
  low: GREEN,
  // Stock
  in: GREEN,
  out: RED,
  // HR employee status
  'on-leave': AMBER,
  terminated: RED,
}

const STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  VIP: 'status.vip',
  Regular: 'status.regular',
  New: 'status.newCustomer',
  paid: 'status.paid',
  completed: 'status.completed',
  pending: 'status.pending',
  overdue: 'status.overdue',
  cancelled: 'status.cancelled',
  active: 'status.active',
  inactive: 'status.inactive',
  ended: 'status.ended',
  expired: 'status.expired',
  new: 'status.new',
  'in-progress': 'status.inProgress',
  resolved: 'status.resolved',
  high: 'status.high',
  medium: 'status.medium',
  low: 'status.low',
  in: 'status.stockIn',
  out: 'status.stockOut',
  complaint: 'status.complaint',
  inquiry: 'status.inquiry',
  return: 'status.return',
  'on-leave': 'status.onLeave',
  terminated: 'status.terminated',
}

interface MiniBadgeProps {
  status: string
  label?: string
}

export function MiniBadge({ status, label }: MiniBadgeProps) {
  const { t } = useLanguage()
  const pillCls = STATUS_PILL[status] ?? GRAY
  const labelKey = STATUS_LABEL_KEYS[status]
  const text = label ?? (labelKey ? t(labelKey) : status)
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', pillCls)}>
      {text}
    </span>
  )
}
