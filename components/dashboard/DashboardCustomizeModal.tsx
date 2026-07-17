'use client'

import { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { DashboardConfig } from '@/hooks/useDashboardConfig'

const SECTIONS: { titleKey: TranslationKey; rows: { key: keyof DashboardConfig; labelKey: TranslationKey }[] }[] = [
  {
    titleKey: 'dashboard.customize.sections.kpiCards',
    rows: [
      { key: 'showMonthlyRevenue', labelKey: 'dashboard.kpi.revenue' },
      { key: 'showTotalSales', labelKey: 'dashboard.kpi.sales' },
      { key: 'showLowStock', labelKey: 'dashboard.kpi.lowStock' },
      { key: 'showMonthlyGoal', labelKey: 'dashboard.kpi.monthlyGoal' },
      { key: 'showTodaySales', labelKey: 'dashboard.kpi.todaySales' },
    ],
  },
  {
    titleKey: 'dashboard.customize.sections.charts',
    rows: [
      { key: 'showDailyChart', labelKey: 'dashboard.customize.items.dailyChart' },
      { key: 'showTopProducts', labelKey: 'dashboard.topProducts.title' },
    ],
  },
  {
    titleKey: 'dashboard.customize.sections.tables',
    rows: [
      { key: 'showRecentSales', labelKey: 'dashboard.recentSales.title' },
    ],
  },
]

interface DashboardCustomizeModalProps {
  config: DashboardConfig
  onSave: (config: DashboardConfig) => void
}

export function DashboardCustomizeModal({ config, onSave }: DashboardCustomizeModalProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DashboardConfig>(config)

  useEffect(() => {
    if (open) setDraft(config)
  }, [open, config])

  const toggle = (key: keyof DashboardConfig) => {
    setDraft(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSave = () => {
    onSave(draft)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <Settings className="h-4 w-4" />
        {t('dashboard.customize.button')}
      </button>

      <DialogContent className="max-w-md rounded-2xl bg-white dark:bg-gray-900">
        <DialogHeader>
          <DialogTitle>{t('dashboard.customize.title')}</DialogTitle>
          <DialogDescription>{t('dashboard.customize.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {SECTIONS.map((section, i) => (
            <div key={section.titleKey}>
              {i > 0 && <div className="border-t border-gray-100 dark:border-gray-800 mb-4" />}
              <p className="text-[11px] font-semibold text-gray-400 dark:text-gray-500 tracking-wide uppercase mb-2">
                {t(section.titleKey)}
              </p>
              <div className="space-y-2.5">
                {section.rows.map(row => (
                  <div key={row.key} className="flex items-center justify-between">
                    <span className="text-[13px] text-gray-700 dark:text-gray-300">{t(row.labelKey)}</span>
                    <Switch
                      checked={draft[row.key]}
                      onCheckedChange={() => toggle(row.key)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="bg-transparent border-0 mx-0 mb-0 p-0 pt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
