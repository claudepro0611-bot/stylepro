'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ClipboardList, Copy, Pencil, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { Pagination } from '@/components/ui/Pagination'
import {
  ActiveBadge, ColumnSettings, FilterBar, PageHeader, TableCard, useHiddenColumns,
  prodCardCls, prodFieldCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { fetchProdRecipes, unitKey, type ProdRecipe } from '@/lib/production'

const PAGE_SIZE = 25

export default function RecipesListPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const { smart } = useQtyFormat()
  const { items, itemById, loading: refsLoading } = useProdRefs()

  const [recipes, setRecipes] = useState<ProdRecipe[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    fetchProdRecipes(createClient()).then(r => { setRecipes(r); setLoading(false) })
  }, [])

  const { isVisible, toggle } = useHiddenColumns('zavod-retseptlar')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return recipes
      .filter(r => !status || (status === 'active') === r.isActive)
      .filter(r => !q || (itemById.get(r.itemId)?.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => (itemById.get(a.itemId)?.name ?? '').localeCompare(itemById.get(b.itemId)?.name ?? '') || b.version - a.version)
  }, [recipes, search, status, itemById])

  // Finished / semi items (active ones) that have no active recipe yet.
  const withoutRecipe = useMemo(() => {
    const covered = new Set(recipes.filter(r => r.isActive).map(r => r.itemId))
    return items.filter(i => i.isActive && (i.itemType === 'finished' || i.itemType === 'semi') && !covered.has(i.id))
  }, [items, recipes])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const columns = [
    { key: 'batch', label: t('production.recipes.batch') },
    { key: 'lines', label: t('production.recipes.linesCount') },
    { key: 'version', label: t('production.recipes.version') },
    { key: 'status', label: t('production.common.status') },
    { key: 'updated', label: t('production.recipes.updatedAt') },
  ]

  function reset() {
    setSearch('')
    setStatus('')
    setPage(1)
  }

  const iconBtn = 'flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('production.recipes.title')}
        subtitle={t('production.recipes.subtitle')}
        actionLabel={t('production.recipes.new')}
        actionHref="/zavod-retseptlar/yangi"
      />

      {!loading && !refsLoading && (
        <div className={cn(prodCardCls, 'p-4 flex flex-wrap items-center justify-between gap-3')}>
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('production.recipes.withoutRecipe')}: <span className="tabular-nums">{withoutRecipe.length}</span>
            </p>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">
              {withoutRecipe.length ? t('production.recipes.withoutRecipeHint') : t('production.recipes.allCovered')}
            </p>
          </div>
          {withoutRecipe.length > 0 && (
            <div className="w-full sm:w-80">
              <SearchSelect
                options={withoutRecipe.map(i => ({ value: i.id, label: i.name, sublabel: t(unitKey(i.unit)) }))}
                value=""
                onChange={id => router.push(`/zavod-retseptlar/yangi?item=${id}`)}
                placeholder={t('production.recipes.create')}
              />
            </div>
          )}
        </div>
      )}

      <FilterBar onReset={reset} columns={<ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} />}>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.recipes.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1) }} className={cn(prodFieldCls, 'w-36')}>
          <option value="">{t('production.common.allStatuses')}</option>
          <option value="active">{t('production.common.active')}</option>
          <option value="inactive">{t('production.common.inactive')}</option>
        </select>
      </FilterBar>

      <TableCard loading={loading || refsLoading} empty={filtered.length === 0} emptyText={t('production.recipes.empty')} emptyIcon={ClipboardList}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.recipes.item')}</th>
              {isVisible('batch') && <th className={thRightCls}>{t('production.recipes.batch')}</th>}
              {isVisible('lines') && <th className={thRightCls}>{t('production.recipes.linesCount')}</th>}
              {isVisible('version') && <th className={thCls}>{t('production.recipes.version')}</th>}
              {isVisible('status') && <th className={thCls}>{t('production.common.status')}</th>}
              {isVisible('updated') && <th className={thCls}>{t('production.recipes.updatedAt')}</th>}
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => {
              const item = itemById.get(r.itemId)
              return (
                <tr key={r.id} onClick={() => router.push(`/zavod-retseptlar/${r.id}`)} className={cn(trCls, 'cursor-pointer', !r.isActive && 'opacity-60')}>
                  <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{item?.name ?? '—'}</td>
                  {isVisible('batch') && <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap')}>{item ? smart(r.outputQty, item.unit) : '—'}</td>}
                  {isVisible('lines') && <td className={cn(tdCls, 'text-right tabular-nums text-gray-500 dark:text-gray-400')}>{r.lines.length}</td>}
                  {isVisible('version') && <td className={cn(tdCls, 'tabular-nums text-gray-500 dark:text-gray-400')}>v{r.version}</td>}
                  {isVisible('status') && <td className={tdCls}><ActiveBadge active={r.isActive} /></td>}
                  {isVisible('updated') && <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(r.updatedAt)}</td>}
                  <td className={tdCls}>
                    <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                      <Link href={`/zavod-retseptlar/${r.id}`} aria-label={t('production.common.edit')} title={t('production.common.edit')} className={iconBtn}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Link>
                      <Link href={`/zavod-retseptlar/yangi?from=${r.id}`} aria-label={t('production.recipes.copy')} title={t('production.recipes.copy')} className={iconBtn}>
                        <Copy className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableCard>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}
    </div>
  )
}
