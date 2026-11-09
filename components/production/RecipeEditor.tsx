'use client'

// Full-page recipe editor (/zavod-retseptlar/yangi and /zavod-retseptlar/[id]).
// Saves through prod_save_recipe only. The RPC keeps one active recipe per
// item and refuses to activate a second one, so the editor deactivates the
// current one first (after confirmation) when the user replaces it.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { Switch } from '@/components/ui/switch'
import {
  BackLink, FormFooter, NoteField, PageHeader, TotalsBox, prodCardCls, prodFieldCls, prodLabelCls,
} from '@/components/production/ProdKit'
import { UnitQtyInput, entryToBase, useQtyFormat } from '@/components/production/RecipeKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import {
  NOTE_MAX, RECIPE_MAX_LINES, fetchAvgCosts, fetchProdRecipe, fetchProdRecipes, itemTypeKey, parseDecimal, prodErrorKey,
  round2, round4, smartUnit, sumByUnitGroup, toInputString, fromBaseQty, unitKey, yieldPercent,
  type EntryUnit, type ProdRecipe,
} from '@/lib/production'

interface EditorLine { key: string; itemId: string; value: string; unit: EntryUnit; note: string }

let lineSeq = 0
const nextKey = () => `l${++lineSeq}`

function recipePayload(r: { itemId: string; outputQty: number; note: string; isActive: boolean; lines: { itemId: string; qty: number; note: string }[] }) {
  return {
    item_id: r.itemId,
    output_qty: round4(r.outputQty),
    note: r.note.trim() || null,
    is_active: r.isActive,
    lines: r.lines.map(l => ({ item_id: l.itemId, qty: round4(l.qty), note: l.note.trim() || null })),
  }
}

export function RecipeEditor({ recipeId }: { recipeId?: string }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { smart, groups } = useQtyFormat()
  const { items, itemById, loading: refsLoading } = useProdRefs()

  const [activeRecipes, setActiveRecipes] = useState<ProdRecipe[]>([])
  const [avgCosts, setAvgCosts] = useState<Map<string, number>>(new Map())
  const [original, setOriginal] = useState<ProdRecipe | null>(null)
  const [copyOf, setCopyOf] = useState<ProdRecipe | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [itemId, setItemId] = useState('')
  const [outputQty, setOutputQty] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<EditorLine[]>([])
  const [saving, setSaving] = useState(false)
  const initialized = useRef(false)

  const isEdit = !!recipeId

  // Load once the item catalogue is known (line units depend on item base units).
  useEffect(() => {
    if (refsLoading || initialized.current) return
    initialized.current = true
    const supabase = createClient()
    const params = new URLSearchParams(window.location.search)
    const sourceId = recipeId ?? params.get('from')
    const presetItem = isEdit ? null : params.get('item')
    Promise.all([
      fetchProdRecipes(supabase, { activeOnly: true }),
      fetchAvgCosts(supabase),
      sourceId ? fetchProdRecipe(supabase, sourceId) : Promise.resolve(null),
    ]).then(([active, costs, source]) => {
      setActiveRecipes(active)
      setAvgCosts(costs)
      if (sourceId && !source) {
        setNotFound(true)
      } else if (source) {
        setOutputQty(toInputString(source.outputQty))
        setNote(source.note)
        setLines(source.lines.map(l => {
          const base = itemById.get(l.itemId)?.unit ?? 'pcs'
          const unit = smartUnit(l.qty, base)
          return { key: nextKey(), itemId: l.itemId, value: toInputString(fromBaseQty(l.qty, base, unit)), unit, note: l.note }
        }))
        if (isEdit) {
          setOriginal(source)
          setItemId(source.itemId)
          setIsActive(source.isActive)
        } else {
          setCopyOf(source)
          if (presetItem && presetItem !== source.itemId) setItemId(presetItem)
        }
      } else if (presetItem) {
        setItemId(presetItem)
      }
      setLoading(false)
    })
  }, [refsLoading, recipeId, isEdit, itemById])

  const outputItem = itemById.get(itemId)
  const activeByItem = useMemo(() => new Map(activeRecipes.map(r => [r.itemId, r])), [activeRecipes])
  const conflict = itemId && isActive
    ? activeRecipes.find(r => r.itemId === itemId && r.id !== recipeId) ?? null
    : null

  // Items without an active recipe first.
  const outputOptions = useMemo(() => items
    .filter(i => (i.itemType === 'finished' || i.itemType === 'semi') && !lines.some(l => l.itemId === i.id))
    .sort((a, b) => Number(activeByItem.has(a.id)) - Number(activeByItem.has(b.id)) || a.name.localeCompare(b.name))
    .map(i => {
      const r = activeByItem.get(i.id)
      const parts = [t(unitKey(i.unit)), r ? `${t('production.recipes.hasRecipe')} v${r.version}` : t('production.recipes.noRecipe')]
      if (!i.isActive) parts.push(t('production.recipes.inactiveItem'))
      return { value: i.id, label: i.name, sublabel: parts.join(' · ') }
    }), [items, lines, activeByItem, t])

  const componentOptions = useMemo(() => items
    .filter(i => i.id !== itemId && !lines.some(l => l.itemId === i.id))
    .map(i => {
      const parts = [t(itemTypeKey(i.itemType)), t(unitKey(i.unit))]
      if (!i.isActive) parts.push(t('production.recipes.inactiveItem'))
      return { value: i.id, label: i.name, sublabel: parts.join(' · ') }
    }), [items, itemId, lines, t])

  const outQty = parseDecimal(outputQty)
  const computed = lines.map(l => {
    const item = itemById.get(l.itemId)
    const base = item?.unit ?? 'pcs'
    const qty = entryToBase(l.value, base, l.unit)
    const avg = avgCosts.get(l.itemId) ?? 0
    return { ...l, item, base, qty, avg, cost: round2(qty * avg), perUnit: outQty > 0 ? qty / outQty : 0 }
  })
  const batchCost = round2(computed.reduce((s, c) => s + c.cost, 0))
  const unitCost = outQty > 0 ? round2(batchCost / outQty) : 0
  const inputs = computed.map(c => ({ qty: c.qty, unit: c.base }))
  const yieldPct = outputItem ? yieldPercent({ qty: outQty, unit: outputItem.unit }, inputs) : null
  const outUnitLabel = outputItem ? t(unitKey(outputItem.unit)) : ''

  const valid = !!itemId && round4(outQty) > 0 && computed.length > 0 && computed.length <= RECIPE_MAX_LINES
    && computed.every(c => round4(c.qty) > 0)

  function patchLine(key: string, patch: Partial<EditorLine>) {
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...patch } : l)))
  }

  function addLine(id: string) {
    if (lines.length >= RECIPE_MAX_LINES) { toast.error(t('production.recipes.tooManyLines')); return }
    const base = itemById.get(id)?.unit ?? 'pcs'
    setLines(prev => [...prev, { key: nextKey(), itemId: id, value: '', unit: base, note: '' }])
  }

  async function save() {
    if (!valid) { toast.error(t('productionErrors.invalid_input')); return }
    if (conflict && !window.confirm(t(isEdit ? 'production.recipes.activateConfirm' : 'production.recipes.replaceConfirm'))) return
    setSaving(true)
    const supabase = createClient()
    if (conflict) {
      const { error } = await supabase.rpc('prod_save_recipe', { p_id: conflict.id, p_data: recipePayload({ ...conflict, isActive: false }) })
      if (error) { setSaving(false); toast.error(t(prodErrorKey(error.message))); return }
    }
    const { error } = await supabase.rpc('prod_save_recipe', {
      // A copy is always a new recipe.
      p_id: isEdit ? recipeId! : null,
      p_data: recipePayload({ itemId, outputQty: outQty, note, isActive, lines: computed.map(c => ({ itemId: c.itemId, qty: c.qty, note: c.note })) }),
    })
    if (error && conflict) {
      // Best effort: put the previous recipe back so the item keeps an active one.
      await supabase.rpc('prod_save_recipe', { p_id: conflict.id, p_data: recipePayload({ ...conflict, isActive: true }) })
    }
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error.message))); return }
    toast.success(t('production.common.saved'))
    router.push('/zavod-retseptlar')
  }

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (notFound) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-retseptlar" label={t('production.recipes.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const title = isEdit ? t('production.recipes.editTitle') : copyOf ? t('production.recipes.copyTitle') : t('production.recipes.newTitle')
  const subtitle = isEdit && original
    ? `${t('production.recipes.version')} ${original.version}`
    : copyOf ? t('production.recipes.copyHint') : undefined

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-retseptlar" label={t('production.recipes.title')} />
      <PageHeader title={title} subtitle={subtitle} />

      <div className={cn(prodCardCls, 'p-6 space-y-4')}>
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-4">
          <div>
            <span className={prodLabelCls}>{t('production.recipes.item')}</span>
            {isEdit ? (
              <>
                <input value={outputItem?.name ?? '—'} disabled className={prodFieldCls} />
                <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.recipes.itemLocked')}</span>
              </>
            ) : (
              <SearchSelect options={outputOptions} value={itemId} onChange={setItemId} placeholder={t('production.common.selectItem')} />
            )}
          </div>
          <label className="block">
            <span className={prodLabelCls}>{t('production.recipes.batchSize')}</span>
            <div className="relative">
              <input
                inputMode="decimal"
                value={outputQty}
                onChange={e => setOutputQty(e.target.value)}
                onFocus={e => e.target.select()}
                placeholder="0"
                className={cn(prodFieldCls, 'pr-12 tabular-nums')}
              />
              {outputItem && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{outUnitLabel}</span>}
            </div>
            <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">{t('production.recipes.batchHint')}</span>
          </label>
        </div>

        {conflict && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-300">
            <span>{t('production.recipes.hasActive')} (v{conflict.version})</span>
            <Link href={`/zavod-retseptlar/${conflict.id}`} className="font-medium underline-offset-2 hover:underline">
              {t('production.recipes.openActive')}
            </Link>
          </div>
        )}

        <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
          <span>
            <span className="block text-sm text-gray-700 dark:text-gray-300">{t('production.common.active')}</span>
            <span className="block text-[11px] text-gray-400 dark:text-gray-500">{t('production.recipes.activeHint')}</span>
          </span>
          <Switch checked={isActive} onCheckedChange={v => setIsActive(v)} />
        </label>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('production.recipes.ingredients')}
            {computed.length > 0 && <span className="ml-1.5 font-normal text-gray-400">{computed.length}</span>}
          </h2>
          <div className="w-full sm:w-80">
            <SearchSelect options={componentOptions} value="" onChange={addLine} placeholder={t('production.recipes.addComponent')} />
          </div>
        </div>
        {computed.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('production.recipes.noLines')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium w-8">#</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.recipes.component')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-52">{t('production.common.qty')}</th>
                  <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{t('production.recipes.perUnit')}</th>
                  <th className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{t('production.common.total')}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.note')}</th>
                  <th className="px-4 py-2.5 w-10" />
                </tr>
              </thead>
              <tbody>
                {computed.map((c, idx) => (
                  <tr key={c.key} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 tabular-nums text-gray-400">{idx + 1}</td>
                    <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                      {c.item?.name ?? '—'}
                      {c.item && !c.item.isActive && <span className="ml-1.5 text-[11px] text-gray-400">({t('production.recipes.inactiveItem')})</span>}
                    </td>
                    <td className="px-4 py-2">
                      <UnitQtyInput
                        value={c.value}
                        onChange={v => patchLine(c.key, { value: v })}
                        base={c.base}
                        unit={c.unit}
                        onUnitChange={(u, v) => patchLine(c.key, { unit: u, value: v })}
                        invalid={c.value.trim() !== '' && !(round4(c.qty) > 0)}
                      />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">
                      {c.perUnit > 0 && outputItem ? `${smart(c.perUnit, c.base)} / ${outUnitLabel}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">{formatPrice(c.cost)}</td>
                    <td className="px-4 py-2">
                      <input
                        value={c.note}
                        maxLength={NOTE_MAX}
                        onChange={e => patchLine(c.key, { note: e.target.value.slice(0, NOTE_MAX) })}
                        className={cn(prodFieldCls, 'h-8 min-w-32')}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setLines(prev => prev.filter(l => l.key !== c.key))}
                        aria-label={t('production.common.remove')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <div className={cn(prodCardCls, 'p-6')}>
          <NoteField value={note} onChange={setNote} />
        </div>
        <div className="space-y-2">
          <TotalsBox rows={[
            { label: t('production.recipes.totalInput'), value: groups(sumByUnitGroup(inputs)) },
            { label: t('production.recipes.batch'), value: outQty > 0 && outputItem ? smart(outQty, outputItem.unit) : '—' },
            ...(yieldPct !== null ? [{ label: t('production.recipes.yield'), value: `${yieldPct.toFixed(1)}%` }] : []),
            { label: t('production.recipes.batchCost'), value: formatPrice(batchCost) },
            { label: t('production.recipes.unitCost'), value: outputItem ? `${formatPrice(unitCost)} / ${outUnitLabel}` : formatPrice(unitCost), strong: true },
          ]} />
          <p className="px-1 text-[11px] text-gray-400 dark:text-gray-500">{t('production.recipes.costHint')}</p>
        </div>
      </div>

      <FormFooter onCancel={() => router.push('/zavod-retseptlar')} onSave={save} saving={saving} disabled={!valid} />
    </div>
  )
}
