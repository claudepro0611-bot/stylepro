'use client'

// Price list editor: name / default / active and an item x price grid with
// search, group filter, bulk % change and "copy from the item sale price".
// id 'yangi' = new list. Saves through prod_save_price_list (items replace).

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Copy, Loader2, Percent, Search } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import {
  BackLink, FormFooter, ItemTypeBadge, PageHeader, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls,
} from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { NotAvailableNote } from '@/components/production/InventoryKit'
import { usePriceLists, useSalesAvailable } from '@/components/production/SalesKit'
import { PROD_ITEM_TYPES, itemTypeKey, prodErrorKey, round2, toInputString, unitKey } from '@/lib/production'
import { parseMoneyOrNull } from '@/lib/inventory'

export default function PriceListEditorPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'yangi'
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const available = useSalesAvailable()
  const { items, groups, loading: refsLoading } = useProdRefs()
  const { lists, loading: listsLoading } = usePriceLists()

  const [name, setName] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [isActive, setIsActive] = useState(true)
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [groupId, setGroupId] = useState('')
  const [itemType, setItemType] = useState('finished')
  const [onlyPriced, setOnlyPriced] = useState(false)
  const [pct, setPct] = useState('')
  const [saving, setSaving] = useState(false)

  const list = isNew ? null : lists.find(l => l.id === id) ?? null

  useEffect(() => {
    if (loaded || listsLoading) return
    if (list) {
      setName(list.name)
      setIsDefault(list.isDefault)
      setIsActive(list.isActive)
      setPrices(Object.fromEntries([...list.prices].map(([k, v]) => [k, toInputString(v) || '0'])))
    } else if (isNew) {
      setIsDefault(lists.length === 0)
    }
    setLoaded(true)
  }, [list, lists.length, isNew, listsLoading, loaded])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items
      .filter(i => i.isActive || prices[i.id] !== undefined)
      .filter(i => !itemType || i.itemType === itemType)
      .filter(i => !groupId || i.groupId === groupId)
      .filter(i => !q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q))
      .filter(i => !onlyPriced || (prices[i.id] ?? '').trim() !== '')
  }, [items, itemType, groupId, search, onlyPriced, prices])

  const pricedCount = Object.values(prices).filter(v => v.trim() !== '').length
  const invalidIds = Object.entries(prices).filter(([, v]) => parseMoneyOrNull(v) === undefined).map(([k]) => k)

  function setPrice(itemId: string, v: string) {
    setPrices(prev => ({ ...prev, [itemId]: v }))
  }

  function applyPct() {
    const p = Number(pct.replace(',', '.'))
    if (!Number.isFinite(p) || p <= -100 || p === 0) { toast.error(t('prodSales.priceLists.pctError')); return }
    setPrices(prev => {
      const next = { ...prev }
      for (const i of visible) {
        const cur = parseMoneyOrNull(prev[i.id] ?? '')
        if (cur === null || cur === undefined) continue
        next[i.id] = toInputString(round2(cur * (1 + p / 100))) || '0'
      }
      return next
    })
    setPct('')
  }

  function copyFromSalePrice() {
    let n = 0
    setPrices(prev => {
      const next = { ...prev }
      for (const i of visible) {
        if (i.salePrice == null) continue
        next[i.id] = toInputString(i.salePrice) || '0'
        n++
      }
      return next
    })
    toast.success(`${t('prodSales.priceLists.copied')}: ${n}`)
  }

  async function save() {
    if (!name.trim()) { toast.error(t('production.common.nameRequired')); return }
    if (invalidIds.length) { toast.error(t('prodSales.priceLists.priceError')); return }
    const payloadItems = Object.entries(prices)
      .map(([itemId, v]) => ({ item_id: itemId, price: parseMoneyOrNull(v) }))
      .filter((x): x is { item_id: string; price: number } => typeof x.price === 'number')
    setSaving(true)
    const { data, error } = await createClient().rpc('prod_save_price_list', {
      p_id: isNew ? null : id,
      p_data: { name: name.trim(), is_default: isDefault, is_active: isActive, items: payloadItems },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    if (isNew && typeof data === 'string') router.replace(`/zavod-narxlar/${data}`)
    else router.push('/zavod-narxlar')
  }

  if (available === false) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-narxlar" label={t('prodSales.priceLists.title')} />
        <NotAvailableNote />
      </div>
    )
  }
  if (available === null || listsLoading || refsLoading || !loaded) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!isNew && !list) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-narxlar" label={t('prodSales.priceLists.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-narxlar" label={t('prodSales.priceLists.title')} />
      <PageHeader title={isNew ? t('prodSales.priceLists.new') : t('prodSales.priceLists.editTitle')} subtitle={t('prodSales.priceLists.editorHint')} />

      <div className={cn(prodCardCls, 'p-6 grid grid-cols-1 md:grid-cols-3 gap-4 items-end')}>
        <label className="block">
          <span className={prodLabelCls}>{t('production.common.name')}</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('prodSales.priceLists.namePlaceholder')} className={prodFieldCls} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2">
          <span>
            <span className="block text-sm text-gray-700 dark:text-gray-300">{t('prodSales.priceLists.isDefault')}</span>
            <span className="block text-[11px] text-gray-400 dark:text-gray-500">{t('prodSales.priceLists.defaultHint')}</span>
          </span>
          <Switch checked={isDefault} onCheckedChange={setIsDefault} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
          <span className="text-sm text-gray-700 dark:text-gray-300">{t('production.common.active')}</span>
          <Switch checked={isActive} onCheckedChange={setIsActive} />
        </label>
      </div>

      <div className={cn(prodCardCls, 'overflow-hidden')}>
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <h2 className="mr-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodSales.priceLists.priceGrid')}</h2>
          <span className="text-[12px] tabular-nums text-gray-500 dark:text-gray-400">{t('prodSales.priceLists.itemsCount')}: {pricedCount}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <input
                inputMode="decimal"
                value={pct}
                onChange={e => setPct(e.target.value.replace(/[^\d.,-]/g, '').slice(0, 7))}
                placeholder="+10 / -5"
                aria-label={t('prodSales.priceLists.bulkPct')}
                className={cn(prodFieldCls, 'w-28 tabular-nums')}
              />
              <button type="button" onClick={applyPct} disabled={!pct.trim()} className={cn(secondaryBtnCls, 'disabled:opacity-50')} title={t('prodSales.priceLists.bulkHint')}>
                <Percent className="h-3.5 w-3.5" /> {t('prodSales.priceLists.bulkApply')}
              </button>
            </div>
            <button type="button" onClick={copyFromSalePrice} className={secondaryBtnCls} title={t('prodSales.priceLists.copyHint')}>
              <Copy className="h-3.5 w-3.5" /> {t('prodSales.priceLists.copyFromSale')}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-3">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('production.common.search')} className={cn(prodFieldCls, 'pl-9')} />
          </div>
          <select value={itemType} onChange={e => setItemType(e.target.value)} className={cn(prodFieldCls, 'w-44')}>
            <option value="">{t('prodReports.common.allItems')}</option>
            {PROD_ITEM_TYPES.map(x => <option key={x} value={x}>{t(itemTypeKey(x))}</option>)}
          </select>
          <select value={groupId} onChange={e => setGroupId(e.target.value)} className={cn(prodFieldCls, 'w-44')}>
            <option value="">{t('prodReports.common.allGroups')}</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={onlyPriced} onChange={e => setOnlyPriced(e.target.checked)} className="h-3.5 w-3.5 accent-slate-900 dark:accent-gray-100" />
            {t('prodSales.priceLists.onlyPriced')}
          </label>
          <span className="ml-auto text-[12px] text-gray-400 dark:text-gray-500">{t('prodSales.priceLists.bulkHint')}</span>
        </div>
        {visible.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-gray-400 dark:text-gray-500">{t('prodReports.common.empty')}</div>
        ) : (
          <div className="max-h-[65vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-white dark:bg-gray-900">
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.common.item')}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.items.group')}</th>
                  <th className="px-4 py-2.5 text-left font-medium">{t('production.stock.type')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('prodInventory.items.salePrice')}</th>
                  <th className="px-4 py-2.5 text-right font-medium w-48">{t('prodSales.priceLists.priceCol')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(i => {
                  const v = prices[i.id] ?? ''
                  const bad = v.trim() !== '' && parseMoneyOrNull(v) === undefined
                  return (
                    <tr key={i.id} className="border-b border-gray-50 dark:border-gray-800/60 last:border-0">
                      <td className="px-4 py-2">
                        <p className="text-gray-900 dark:text-gray-100">{i.name}</p>
                        <p className="text-[12px] text-gray-400 dark:text-gray-500">{i.sku ? `${i.sku} · ` : ''}{t(unitKey(i.unit))}</p>
                      </td>
                      <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{i.groupId ? groups.find(g => g.id === i.groupId)?.name ?? '—' : '—'}</td>
                      <td className="px-4 py-2"><ItemTypeBadge type={i.itemType} /></td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400">{i.salePrice == null ? '—' : formatPrice(i.salePrice)}</td>
                      <td className="px-4 py-2">
                        <input
                          inputMode="decimal"
                          value={v}
                          onChange={e => setPrice(i.id, e.target.value)}
                          placeholder="—"
                          className={cn(prodFieldCls, 'text-right tabular-nums', bad && 'border-red-300 dark:border-red-800')}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <FormFooter onCancel={() => router.push('/zavod-narxlar')} onSave={save} saving={saving} disabled={invalidIds.length > 0} />
    </div>
  )
}
