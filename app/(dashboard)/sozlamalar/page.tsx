'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { SlidersHorizontal, Store, Target, Info, Sun, Moon, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { useSettings } from '@/lib/useSettings'
import { formatDate } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import type { TranslationKey } from '@/lib/i18n/translations'

const segCls = (active: boolean) =>
  cn(
    'flex h-8 items-center justify-center rounded-md px-3 text-[12.5px] font-medium transition-colors',
    active
      ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
  )

const pill = 'flex items-center gap-0.5 rounded-lg bg-gray-100 dark:bg-gray-800 p-1'

interface StoreInfo {
  name: string
  address: string
  phone: string
}

const DEFAULT_STORE_INFO: StoreInfo = {
  name: 'StylePro',
  address: "Toshkent sh., Chilonzor t., Bunyodkor ko'chasi 12",
  phone: '+998 90 123 45 67',
}

const APP_VERSION = 'v1.0.0'
const LAST_UPDATE = '2026-06-08'

const inputCls = 'h-10 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

const saveBtnCls = 'flex h-9 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white transition-colors hover:bg-slate-800'

type SettingsTab = 'general' | 'store' | 'goals' | 'system'

const TABS: { key: SettingsTab; labelKey: TranslationKey; icon: typeof SlidersHorizontal }[] = [
  { key: 'general', labelKey: 'settings.tabs.general', icon: SlidersHorizontal },
  { key: 'store', labelKey: 'settings.tabs.store', icon: Store },
  { key: 'goals', labelKey: 'settings.tabs.goals', icon: Target },
  { key: 'system', labelKey: 'settings.tabs.system', icon: Info },
]

function Card({ title, description, children }: { title?: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-6 space-y-4 transition-colors duration-200">
      {title && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          {description && <p className="text-[12.5px] text-gray-400 dark:text-gray-500 mt-0.5">{description}</p>}
        </div>
      )}
      {children}
    </div>
  )
}

export default function SettingsPage() {
  const { t, language, setLanguage } = useLanguage()
  const { currency, setCurrency, formatPrice } = useCurrency()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isDark = mounted && theme === 'dark'

  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  const [storeInfo, setStoreInfo] = useLocalStorage<StoreInfo>('stylepro-store-info', DEFAULT_STORE_INFO)
  const [form, setForm] = useState<StoreInfo>(DEFAULT_STORE_INFO)
  useEffect(() => setForm(storeInfo), [storeInfo])

  const { settings } = useSettings()
  const [unitTypes, setUnitTypes] = useState<string[]>(['dona'])
  const [blockSize, setBlockSize] = useState(1)

  useEffect(() => {
    if (settings?.product) {
      setUnitTypes(settings.product.unit_types ?? ['dona'])
      setBlockSize(settings.product.block_size ?? 1)
    }
  }, [settings])

  function toggleUnit(unit: string) {
    setUnitTypes(prev =>
      prev.includes(unit)
        ? prev.filter(u => u !== unit)
        : [...prev, unit],
    )
  }

  const [monthlyGoal, setMonthlyGoal] = useLocalStorage<number>('stylepro-monthly-goal', 10000000)
  const [goalInput, setGoalInput] = useState(String(monthlyGoal))
  useEffect(() => setGoalInput(String(monthlyGoal)), [monthlyGoal])

  const [currentMonthRevenue, setCurrentMonthRevenue] = useState(0)
  useEffect(() => {
    let active = true
    const supabase = createClient()
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)

    supabase
      .from('transactions_net')
      .select('net_amount, date, status')
      .eq('status', 'completed')
      .gte('date', start)
      .lte('date', end)
      .then(({ data }) => {
        if (!active) return
        setCurrentMonthRevenue((data ?? []).reduce((s, tx) => s + Number(tx.net_amount), 0))
      })

    return () => { active = false }
  }, [])

  const goalPct = Math.min(100, monthlyGoal > 0 ? Math.round((currentMonthRevenue / monthlyGoal) * 100) : 0)

  async function handleSaveProductSettings() {
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { toast.error('Xatolik yuz berdi'); return }

    const { error } = await supabase
      .from('company_settings')
      .update({
        settings: {
          ...settings,
          product: { unit_types: unitTypes, block_size: blockSize },
        },
      })
      .eq('company_id', companyId)

    if (error) {
      toast.error('Xatolik yuz berdi')
    } else {
      toast.success('Sozlamalar saqlandi')
    }
  }

  function handleSaveStore() {
    setStoreInfo(form)
    toast.success(t('settings.store.saveSuccess'))
  }

  function handleSaveGoal() {
    const num = Number(goalInput)
    if (!num || num < 0) {
      toast.error(t('common.error'))
      return
    }
    setMonthlyGoal(num)
    toast.success(t('settings.goals.saveSuccess'))
  }

  function handleClearCache() {
    if (!window.confirm(t('settings.system.clearCacheConfirm'))) return
    const preserve = ['stylepro-language', 'stylepro-theme', 'stylepro-currency']
    Object.keys(window.localStorage)
      .filter(key => !preserve.includes(key))
      .forEach(key => window.localStorage.removeItem(key))
    toast.success(t('settings.system.clearCacheSuccess'))
    setTimeout(() => window.location.reload(), 600)
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('settings.title')}</h1>
        <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">{t('settings.subtitle')}</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-6">
        {/* Left — vertical nav tabs */}
        <nav className="flex sm:flex-col gap-1 overflow-x-auto sm:overflow-visible pb-2 sm:pb-0 sm:w-52 shrink-0">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap transition-colors border-l-2 shrink-0',
                activeTab === tab.key
                  ? 'bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-l-gray-900 dark:border-l-gray-100'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 border-l-transparent',
              )}
            >
              <tab.icon className="h-4 w-4 shrink-0" />
              {t(tab.labelKey)}
            </button>
          ))}
        </nav>

        {/* Right — active section content */}
        <div className="flex-1 min-w-0 space-y-4">
          {activeTab === 'general' && (
            <>
              <Card title={t('settings.general.language')} description={t('settings.general.languageDescription')}>
                <div className={pill}>
                  <button onClick={() => setLanguage('uz')} className={segCls(language === 'uz')}>UZ</button>
                  <button onClick={() => setLanguage('ru')} className={segCls(language === 'ru')}>RU</button>
                  <button onClick={() => setLanguage('en')} className={segCls(language === 'en')}>EN</button>
                </div>
              </Card>

              <Card title={t('settings.general.theme')} description={t('settings.general.themeDescription')}>
                {mounted && (
                  <div className="relative grid grid-cols-2 w-20 h-9 rounded-full bg-gray-100 dark:bg-gray-800 p-1">
                    <div
                      className={cn(
                        'absolute left-1 top-1 h-7 w-9 rounded-full bg-white dark:bg-gray-700 shadow-sm transition-transform duration-300 ease-out',
                        isDark && 'translate-x-9',
                      )}
                    />
                    <button onClick={() => setTheme('light')} className="relative z-10 flex items-center justify-center" aria-label="Light mode">
                      <Sun className={cn('h-4 w-4 transition-colors', !isDark ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500')} />
                    </button>
                    <button onClick={() => setTheme('dark')} className="relative z-10 flex items-center justify-center" aria-label="Dark mode">
                      <Moon className={cn('h-4 w-4 transition-colors', isDark ? 'text-indigo-400' : 'text-gray-400 dark:text-gray-500')} />
                    </button>
                  </div>
                )}
              </Card>

              <Card title={t('settings.general.currency')} description={t('settings.general.currencyDescription')}>
                <div className={pill}>
                  <button onClick={() => setCurrency('UZS')} className={segCls(currency === 'UZS')}>UZS</button>
                  <button onClick={() => setCurrency('USD')} className={segCls(currency === 'USD')}>USD</button>
                </div>
              </Card>
            </>
          )}

          {activeTab === 'store' && (
            <Card>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('settings.store.name')}</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder={t('settings.store.namePlaceholder')}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('settings.store.phone')}</label>
                  <input
                    value={form.phone}
                    onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder={t('settings.store.phonePlaceholder')}
                    className={inputCls}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('settings.store.address')}</label>
                  <input
                    value={form.address}
                    onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                    placeholder={t('settings.store.addressPlaceholder')}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('settings.store.currency')}</label>
                  <input value="UZS" disabled className={cn(inputCls, 'bg-gray-50 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed')} />
                </div>
              </div>
              <div className="flex justify-end">
                <button onClick={handleSaveStore} className={saveBtnCls}>
                  {t('common.save')}
                </button>
              </div>
            </Card>
          )}

          {activeTab === 'store' && (
            <Card title="Mahsulot sozlamalari">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    O&apos;lchov birligi
                  </label>
                  <div className="flex gap-2">
                    {['dona', 'blok', 'kg', 'litr', 'metr'].map(unit => (
                      <button
                        key={unit}
                        onClick={() => toggleUnit(unit)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          unitTypes.includes(unit)
                            ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                            : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                        }`}
                      >
                        {unit === 'dona' ? 'Dona' : unit === 'blok' ? 'Blok' : unit === 'kg' ? 'Kg' : unit === 'litr' ? 'Litr' : 'Metr'}
                      </button>
                    ))}
                  </div>
                </div>

                {unitTypes.includes('blok') && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Bir blokda nechta dona
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={blockSize}
                      onChange={e => setBlockSize(Number(e.target.value))}
                      className="w-full max-w-xs border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
                    />
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Masalan: 1 blok = 12 dona</p>
                  </div>
                )}

                <div className="flex justify-end">
                  <button onClick={handleSaveProductSettings} className={saveBtnCls}>
                    Saqlash
                  </button>
                </div>
              </div>
            </Card>
          )}

          {activeTab === 'goals' && (
            <Card>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('settings.goals.monthlyGoal')}</label>
                <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-5">
                  <div className="flex items-baseline gap-2">
                    <input
                      type="number"
                      value={goalInput}
                      onChange={e => setGoalInput(e.target.value)}
                      placeholder={t('settings.goals.monthlyGoalPlaceholder')}
                      className="w-full bg-transparent text-3xl font-bold text-gray-900 dark:text-gray-100 outline-none tabular-nums"
                    />
                    <span className="text-sm font-medium text-gray-400 dark:text-gray-500 shrink-0">UZS</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-[13px] mb-1.5">
                  <span className="text-gray-500 dark:text-gray-400">{t('settings.goals.currentProgress')}</span>
                  <span className="font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{goalPct}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gray-900 dark:bg-gray-100 transition-all duration-500"
                    style={{ width: `${goalPct}%` }}
                  />
                </div>
                <p className="text-[12px] text-gray-400 dark:text-gray-500 mt-1.5 tabular-nums">
                  {formatPrice(currentMonthRevenue)} / {formatPrice(monthlyGoal)}
                </p>
              </div>

              <div className="flex justify-end">
                <button onClick={handleSaveGoal} className={saveBtnCls}>
                  {t('common.save')}
                </button>
              </div>
            </Card>
          )}

          {activeTab === 'system' && (
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                  {t('settings.system.version')}: StylePro {APP_VERSION}
                </span>
                <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                  {t('settings.system.lastUpdate')}: {formatDate(LAST_UPDATE)}
                </span>
              </div>
              <button
                onClick={handleClearCache}
                className="flex h-9 items-center gap-2 rounded-lg border border-red-200 dark:border-red-500/30 px-4 text-sm font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {t('settings.system.clearCache')}
              </button>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
