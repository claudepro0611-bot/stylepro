'use client'

// "Versiyalar tarixi" of a recipe (prod_recipe_versions, migration
// 20261110000014): every saved version with a read-only view of its lines.
// /zavod-retseptlar/[id]?v=N opens version N directly (link from the
// production document that used it). Renders nothing while the table is not
// available.

import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InfoField, prodCardCls } from '@/components/production/ProdKit'
import { useQtyFormat } from '@/components/production/RecipeKit'
import type { ProdItem } from '@/lib/production'
import { fetchRecipeVersions, type RecipeVersion } from '@/lib/inventory'

const th = 'px-4 py-2.5 text-left font-medium whitespace-nowrap'
const thR = 'px-4 py-2.5 text-right font-medium whitespace-nowrap'
const td = 'px-4 py-2'

export function RecipeVersionHistory({ recipeId, currentVersion, itemById, reloadKey }: {
  recipeId: string
  currentVersion: number | null
  itemById: Map<string, ProdItem>
  /** Changing it re-reads the history (after a save). */
  reloadKey?: string | number
}) {
  const { t } = useLanguage()
  const { smart } = useQtyFormat()
  const [versions, setVersions] = useState<RecipeVersion[] | null>(null)
  const [viewing, setViewing] = useState<RecipeVersion | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchRecipeVersions(createClient(), recipeId).then(v => {
      if (cancelled) return
      setVersions(v)
      const want = Number(new URLSearchParams(window.location.search).get('v'))
      if (v && want) setViewing(v.find(x => x.version === want) ?? null)
    })
    return () => { cancelled = true }
  }, [recipeId, reloadKey])

  if (!versions || versions.length === 0) return null

  const outItem = viewing ? itemById.get(viewing.outputItemId) : undefined

  return (
    <div className={cn(prodCardCls, 'overflow-hidden')}>
      <h2 className="flex items-center gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <History className="h-4 w-4 text-gray-400" /> {t('prodInventory.recipes.versions')}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={th}>{t('prodInventory.recipes.version')}</th>
              <th className={th}>{t('prodInventory.recipes.savedAt')}</th>
              <th className={th}>{t('prodInventory.recipes.savedBy')}</th>
              <th className={thR}>{t('production.recipes.batch')}</th>
              <th className={thR}>{t('prodInventory.recipes.linesCount')}</th>
              <th className={thR}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {versions.map(v => {
              const item = itemById.get(v.outputItemId)
              return (
                <tr key={v.version} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className={cn(td, 'font-medium text-gray-900 dark:text-gray-100')}>
                    v{v.version}
                    {v.version === currentVersion && (
                      <span className="ml-2 inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:text-gray-400">{t('prodInventory.recipes.current')}</span>
                    )}
                  </td>
                  <td className={cn(td, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(v.savedAt)}</td>
                  <td className={cn(td, 'text-gray-500 dark:text-gray-400')}>{v.savedByName || '—'}</td>
                  <td className={cn(td, 'text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300')}>{item ? smart(v.outputQty, item.unit) : v.outputQty}</td>
                  <td className={cn(td, 'text-right tabular-nums text-gray-500 dark:text-gray-400')}>{v.lines.length}</td>
                  <td className={td}>
                    <div className="flex justify-end">
                      <button type="button" onClick={() => setViewing(v)} className="text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                        {t('prodInventory.recipes.view')}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={viewing !== null} onOpenChange={o => { if (!o) setViewing(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('prodInventory.recipes.versionTitle')} v{viewing?.version ?? ''}</DialogTitle>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodInventory.recipes.readOnly')}</p>
          </DialogHeader>
          {viewing && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <InfoField label={t('production.common.item')}>{outItem?.name ?? '—'}</InfoField>
                <InfoField label={t('production.recipes.batch')}>{outItem ? smart(viewing.outputQty, outItem.unit) : viewing.outputQty}</InfoField>
                <InfoField label={t('prodInventory.recipes.savedBy')}>{viewing.savedByName || '—'}</InfoField>
                <InfoField label={t('prodInventory.recipes.savedAt')}>{formatDateTime(viewing.savedAt)}</InfoField>
              </div>
              <div className="max-h-[50vh] overflow-auto rounded-xl border border-gray-100 dark:border-gray-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                      <th className={cn(th, 'w-8')}>#</th>
                      <th className={th}>{t('production.recipes.component')}</th>
                      <th className={thR}>{t('production.common.qty')}</th>
                      <th className={th}>{t('production.common.note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewing.lines.map((l, i) => {
                      const it = itemById.get(l.itemId)
                      return (
                        <tr key={`${l.itemId}:${i}`} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                          <td className={cn(td, 'tabular-nums text-gray-400')}>{i + 1}</td>
                          <td className={cn(td, 'text-gray-900 dark:text-gray-100')}>{it?.name ?? '—'}</td>
                          <td className={cn(td, 'text-right tabular-nums whitespace-nowrap')}>{it ? smart(l.qty, it.unit) : l.qty}</td>
                          <td className={cn(td, 'text-gray-500 dark:text-gray-400')}>{l.note || ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {viewing.note && <p className="text-[13px] text-gray-500 dark:text-gray-400 whitespace-pre-wrap">{viewing.note}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
