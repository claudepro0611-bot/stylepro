'use client'

// "Interfeys sozlamalari": the caller's own UI preferences (lib/prefs.ts,
// prod_user_prefs of migration 20261110000019; localStorage before it): home
// page, tablet mode, menu favorites / hidden items. Per-user, so every
// authenticated user may open it (/sozlamalar is a shared, role-free route).

import { useMemo } from 'react'
import { Eye, RotateCcw, Star } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import type { TranslationKey } from '@/lib/i18n/translations'
import { Switch } from '@/components/ui/switch'
import { PageHeader, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { ADMIN_NAV_ITEM, NAV_ITEMS, PRODUCTION_NAV_ITEMS, SETTINGS_NAV_ITEM } from '@/components/layout/Sidebar'
import { useProductionEnabled } from '@/components/layout/useProdNotifications'
import { HOME_CHOICES, usePrefs, type HomeChoice } from '@/lib/prefs'

const HOME_KEYS: Record<HomeChoice, TranslationKey> = {
  auto: 'prodShell.prefs.home.auto',
  dashboard: 'prodShell.prefs.home.dashboard',
  milk: 'prodShell.prefs.home.milk',
  lab: 'prodShell.prefs.home.lab',
  stock: 'prodShell.prefs.home.stock',
  sales: 'prodShell.prefs.home.sales',
  cash: 'prodShell.prefs.home.cash',
}

export default function InterfacePrefsPage() {
  const { t } = useLanguage()
  const { company } = useSession()
  const productionEnabled = useProductionEnabled()
  const { prefs, loading, save } = usePrefs()

  // href -> label of every nav leaf (hidden / favorite lists show names, not paths).
  const labels = useMemo(() => {
    const map = new Map<string, string>()
    const items = [...(company?.businessType === 'production' ? PRODUCTION_NAV_ITEMS : NAV_ITEMS), SETTINGS_NAV_ITEM, ADMIN_NAV_ITEM]
    for (const item of items) {
      if (!map.has(item.href)) map.set(item.href, t(item.labelKey))
      for (const c of item.children ?? []) if (!map.has(c.href)) map.set(c.href, t(c.labelKey))
    }
    return map
  }, [company?.businessType, t])

  async function update(partial: Parameters<typeof save>[0]) {
    await save(partial)
    toast.success(t('prodShell.prefs.saved'))
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader title={t('prodShell.prefs.title')} subtitle={t('prodShell.prefs.subtitle')} />

      {productionEnabled && (
        <div className={cn(prodCardCls, 'p-6 space-y-5')}>
          <label className="block max-w-sm">
            <span className={prodLabelCls}>{t('prodShell.prefs.homeLabel')}</span>
            <select
              value={prefs.home ?? 'auto'}
              disabled={loading}
              onChange={e => update({ home: e.target.value as HomeChoice })}
              className={prodFieldCls}
            >
              {HOME_CHOICES.map(h => <option key={h} value={h}>{t(HOME_KEYS[h])}</option>)}
            </select>
            <span className="mt-1 block text-[12px] text-gray-500 dark:text-gray-400">{t('prodShell.prefs.homeHint')}</span>
          </label>

          <div className="flex items-start justify-between gap-4 border-t border-gray-100 dark:border-gray-800 pt-5">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('prodShell.prefs.tablet')}</p>
              <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">{t('prodShell.prefs.tabletHint')}</p>
            </div>
            <Switch checked={prefs.tabletMode} disabled={loading} onCheckedChange={v => update({ tabletMode: v })} />
          </div>
        </div>
      )}

      <div className={cn(prodCardCls, 'p-6 space-y-5')}>
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodShell.prefs.menuTitle')}</p>
          <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400">{t('prodShell.prefs.menuHint')}</p>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-gray-700 dark:text-gray-300">
            <Star className="h-3.5 w-3.5 text-gray-400" /> {t('prodShell.menu.favorites')}
          </p>
          {prefs.favorites.length === 0 ? (
            <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('prodShell.prefs.noFavorites')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {prefs.favorites.map(h => (
                <span key={h} className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">{labels.get(h) ?? h}</span>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-gray-700 dark:text-gray-300">
            <Eye className="h-3.5 w-3.5 text-gray-400" /> {t('prodShell.prefs.hidden')}
          </p>
          {prefs.hiddenMenu.length === 0 ? (
            <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('prodShell.prefs.noHidden')}</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-100 dark:border-gray-800">
              {prefs.hiddenMenu.map(h => (
                <li key={h} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <span className="text-gray-800 dark:text-gray-200">{labels.get(h) ?? h}</span>
                  <button
                    type="button"
                    onClick={() => update({ hiddenMenu: prefs.hiddenMenu.filter(x => x !== h) })}
                    className="text-[12px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                  >
                    {t('prodShell.menu.show')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-gray-100 dark:border-gray-800 pt-5">
          <button
            type="button"
            disabled={loading || prefs.favorites.length === 0}
            onClick={() => update({ favorites: [] })}
            className={cn(secondaryBtnCls, 'disabled:opacity-40 disabled:cursor-not-allowed')}
          >
            <RotateCcw className="h-3.5 w-3.5" /> {t('prodShell.prefs.resetFavorites')}
          </button>
          <button
            type="button"
            disabled={loading || prefs.hiddenMenu.length === 0}
            onClick={() => update({ hiddenMenu: [] })}
            className={cn(secondaryBtnCls, 'disabled:opacity-40 disabled:cursor-not-allowed')}
          >
            <RotateCcw className="h-3.5 w-3.5" /> {t('prodShell.prefs.resetHidden')}
          </button>
        </div>
      </div>
    </div>
  )
}
