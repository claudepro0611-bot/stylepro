'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { toast } from '@/lib/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/Pagination'
import { DatePickerField } from '@/components/ui/date-picker-field'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { useCurrency, DEFAULT_USD_RATE } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'

const ITEMS_PER_PAGE = 20
const CHART_POINTS = 30

type RateSource = 'manual' | 'cbu' | 'market'

interface RateRow {
  id: string
  rate: number
  rateDate: string
  source: RateSource
}

interface DbRateRow {
  id: string
  rate: number
  rate_date: string
  source: string
}

const cardCls = 'bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800'
const labelCls = 'block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1'
const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors tabular-nums'
const thCls = 'px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400'
const primaryBtnCls = 'inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed'
const outlineBtnCls = 'inline-flex items-center justify-center gap-2 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed'

const sumFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const intFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })

function formatSum(n: number): string {
  return sumFormatter.format(n)
}

// 'YYYY-MM-DD' -> 'dd.mm.yyyy' without going through Date (no TZ shift).
function formatDmy(ymd: string): string {
  const [y, m, d] = ymd.split('-')
  return `${d}.${m}.${y}`
}

// Canonical form kept in state: digits with at most one '.' and 2 decimals.
function sanitizeRateInput(raw: string): string {
  const cleaned = raw.replace(/[\s  ]/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, '')
  const dot = cleaned.indexOf('.')
  if (dot === -1) return cleaned
  const intPart = cleaned.slice(0, dot)
  const fracPart = cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 2)
  return `${intPart}.${fracPart}`
}

// Displayed form: thousands grouped the ru-RU way, ',' as decimal separator.
function displayRateInput(canonical: string): string {
  if (!canonical) return ''
  const [intPart, fracPart] = canonical.split('.')
  const grouped = intPart ? intFormatter.format(Number(intPart)) : '0'
  return fracPart === undefined ? grouped : `${grouped},${fracPart}`
}

function rpcErrorKey(message: string | undefined): TranslationKey {
  const msg = message ?? ''
  if (msg.includes('forbidden')) return 'common.forbidden'
  if (msg.includes('Invalid rate')) return 'exchangeRates.errors.invalidRate'
  if (msg.includes('Date is required')) return 'exchangeRates.errors.dateRequired'
  if (msg.includes('Date cannot be in the future')) return 'exchangeRates.errors.futureDate'
  if (msg.includes('Exchange rate not found')) return 'exchangeRates.errors.notFound'
  return 'common.error'
}

function SourcePill({ source, label }: { source: RateSource; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs',
        source !== 'manual'
          ? 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300'
          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
      )}
    >
      {label}
    </span>
  )
}

export default function ValyutaKurslariPage() {
  const { t } = useLanguage()
  const { usdRate, usdRateDate, refreshRate } = useCurrency()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [rows, setRows] = useState<RateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  const [formDate, setFormDate] = useState(() => localYmd())
  const [formRate, setFormRate] = useState('')
  const [formSource, setFormSource] = useState<RateSource>('manual')
  const [fetchingCbu, setFetchingCbu] = useState(false)
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<RateRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await fetchAllRows<DbRateRow>((from, to) =>
      supabase
        .from('exchange_rates')
        .select('id, rate, rate_date, source')
        .eq('currency', 'USD')
        .order('rate_date', { ascending: false })
        .order('id')
        .range(from, to))
    if (error) toast.error(t('common.error'))
    else {
      setRows(data.map(r => ({
        id: r.id,
        rate: Number(r.rate),
        rateDate: r.rate_date,
        source: r.source === 'cbu' || r.source === 'market' ? r.source : 'manual',
      })))
    }
    setLoading(false)
  }, [t])

  useEffect(() => { load() }, [load])

  const sourceLabel = (s: RateSource) => t(s === 'cbu' ? 'exchangeRates.source.cbu' : s === 'market' ? 'exchangeRates.source.market' : 'exchangeRates.source.manual')

  const currentRow = usdRateDate ? rows.find(r => r.rateDate === usdRateDate) ?? null : null
  const existingForDate = rows.find(r => r.rateDate === formDate) ?? null

  const totalPages = Math.ceil(rows.length / ITEMS_PER_PAGE)
  // Clamp after a delete empties the last page.
  const currentPage = Math.min(page, Math.max(1, totalPages))
  const paginated = rows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE)

  // rows are newest-first; the previous day's rate is the next element.
  const changeById = useMemo(() => {
    const map = new Map<string, { diff: number; pct: number }>()
    rows.forEach((r, i) => {
      const prev = rows[i + 1]
      if (!prev || prev.rate <= 0) return
      const diff = r.rate - prev.rate
      map.set(r.id, { diff, pct: (diff / prev.rate) * 100 })
    })
    return map
  }, [rows])

  const chartData = useMemo(
    () => rows.slice(0, CHART_POINTS).reverse().map(r => ({ label: formatDmy(r.rateDate).slice(0, 5), date: r.rateDate, rate: r.rate })),
    [rows],
  )

  function handleDateChange(next: string) {
    if (next > localYmd()) {
      toast.error(t('exchangeRates.errors.futureDate'))
      return
    }
    setFormDate(next)
    // A CBU-fetched value belongs to the previous date; treat it as manual now.
    setFormSource('manual')
  }

  function handleRateChange(raw: string) {
    setFormRate(sanitizeRateInput(raw))
    setFormSource('manual')
  }

  async function fetchFromCbu() {
    if (!formDate) { toast.error(t('exchangeRates.errors.dateRequired')); return }
    setFetchingCbu(true)
    try {
      const res = await fetch(`/api/exchange-rates/cbu?date=${encodeURIComponent(formDate)}`, { cache: 'no-store' })
      const body = (await res.json()) as { rate?: number; date?: string; source?: 'cbu' | 'market'; error?: string }
      if (!res.ok || typeof body.rate !== 'number' || !body.date) throw new Error(body.error ?? 'CBU')
      setFormRate(sanitizeRateInput(String(Math.round(body.rate * 100) / 100)))
      setFormSource(body.source === 'market' ? 'market' : 'cbu')
      toast.success(t(body.source === 'market' ? 'exchangeRates.toast.marketFetched' : 'exchangeRates.toast.cbuFetched'), {
        description: `${t('exchangeRates.toast.cbuRateDate')}: ${formatDmy(body.date)}`,
      })
    } catch {
      toast.error(t('exchangeRates.toast.cbuFailed'))
    } finally {
      setFetchingCbu(false)
    }
  }

  async function save() {
    if (!formDate) { toast.error(t('exchangeRates.errors.dateRequired')); return }
    if (formDate > localYmd()) { toast.error(t('exchangeRates.errors.futureDate')); return }
    const rate = Number(formRate)
    if (!formRate || !Number.isFinite(rate) || rate <= 0) {
      toast.error(t('exchangeRates.errors.invalidRate'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('set_exchange_rate', {
      p_date: formDate,
      p_rate: rate,
      p_currency: 'USD',
      p_source: formSource,
    })
    setSaving(false)
    if (error) {
      toast.error(t(rpcErrorKey(error.message)))
      return
    }
    toast.success(t('exchangeRates.toast.saved'))
    setFormRate('')
    setFormSource('manual')
    await Promise.all([load(), refreshRate()])
  }

  async function executeDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_exchange_rate', { p_id: deleteTarget.id })
    setDeleting(false)
    if (error) {
      toast.error(t(rpcErrorKey(error.message)))
      return
    }
    setDeleteTarget(null)
    toast.success(t('exchangeRates.toast.deleted'))
    await Promise.all([load(), refreshRate()])
  }

  const lineColor = isDark ? '#cbd5e1' : '#0f172a'
  const axisColor = isDark ? '#9ca3af' : '#6b7280'
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : '#f3f4f6'
  const tooltipStyle = {
    contentStyle: {
      background: isDark ? '#111827' : '#fff',
      border: '1px solid ' + (isDark ? '#1f2937' : '#f3f4f6'),
      borderRadius: 8,
      fontSize: 12,
    },
    labelStyle: { color: isDark ? '#f3f4f6' : '#111827' },
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('exchangeRates.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('exchangeRates.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Current rate */}
        <div className={cn(cardCls, 'p-6')}>
          <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('exchangeRates.current.title')}</h2>
          <p className="mt-3 text-2xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            1 USD = {formatSum(usdRate)} {t('exchangeRates.sum')}
          </p>
          {usdRateDate ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <span className="tabular-nums">{formatDmy(usdRateDate)}</span>
              {currentRow && <SourcePill source={currentRow.source} label={sourceLabel(currentRow.source)} />}
            </div>
          ) : (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t('exchangeRates.current.noRate')} {formatSum(DEFAULT_USD_RATE)} {t('exchangeRates.sum')}
              </span>
            </div>
          )}
        </div>

        {/* Add / update rate */}
        <div className={cn(cardCls, 'p-6 lg:col-span-2')}>
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('exchangeRates.form.title')}</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>{t('exchangeRates.form.date')}</label>
              <DatePickerField value={formDate} onChange={handleDateChange} className="w-full" />
            </div>
            <div>
              <label className={labelCls} htmlFor="exchange-rate-input">{t('exchangeRates.form.rate')}</label>
              <input
                id="exchange-rate-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={displayRateInput(formRate)}
                onChange={e => handleRateChange(e.target.value)}
                placeholder={t('exchangeRates.form.ratePlaceholder')}
                className={inputCls}
              />
            </div>
          </div>

          {existingForDate && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              {t('exchangeRates.form.overwriteNote')} ({formatSum(existingForDate.rate)} {t('exchangeRates.sum')})
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={fetchFromCbu} disabled={fetchingCbu || saving} className={outlineBtnCls}>
              <RefreshCw className={cn('h-3.5 w-3.5 text-gray-400 dark:text-gray-500', fetchingCbu && 'animate-spin')} />
              {t('exchangeRates.form.fetchCbu')}
            </button>
            <button type="button" onClick={save} disabled={saving || fetchingCbu} className={primaryBtnCls}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Trend chart */}
      {!loading && chartData.length >= 2 && (
        <div className={cn(cardCls, 'p-6')}>
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-4">{t('exchangeRates.chart.title')}</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="label" tick={{ fill: axisColor, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis
                  tick={{ fill: axisColor, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={60}
                  domain={['auto', 'auto']}
                  tickFormatter={v => intFormatter.format(Number(v))}
                />
                <Tooltip
                  {...tooltipStyle}
                  labelFormatter={(_, payload) => {
                    const d = payload?.[0]?.payload?.date as string | undefined
                    return d ? formatDmy(d) : ''
                  }}
                  formatter={(v) => [`${formatSum(Number(v))} ${t('exchangeRates.sum')}`, t('exchangeRates.table.rate')]}
                />
                <Line type="monotone" dataKey="rate" stroke={lineColor} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* History */}
      <div className={cardCls}>
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('exchangeRates.table.title')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left border-b border-gray-100 dark:border-gray-800">
                <th className={thCls}>{t('exchangeRates.table.date')}</th>
                <th className={cn(thCls, 'text-right')}>{t('exchangeRates.table.rate')}</th>
                <th className={cn(thCls, 'text-right')}>{t('exchangeRates.table.change')}</th>
                <th className={thCls}>{t('exchangeRates.table.source')}</th>
                <th className={cn(thCls, 'text-right')}>{t('exchangeRates.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('exchangeRates.table.empty')}
                  </td>
                </tr>
              ) : (
                paginated.map(r => {
                  const change = changeById.get(r.id)
                  return (
                    <tr key={r.id} className="border-b border-gray-50 dark:border-gray-800/60 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                      <td className="px-6 py-3 text-sm text-gray-600 dark:text-gray-400 tabular-nums">{formatDmy(r.rateDate)}</td>
                      <td className="px-6 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                        {formatSum(r.rate)} {t('exchangeRates.sum')}
                      </td>
                      <td className="px-6 py-3 text-right text-sm tabular-nums">
                        {!change ? (
                          <span className="text-gray-400 dark:text-gray-500">—</span>
                        ) : change.diff === 0 ? (
                          <span className="text-gray-500 dark:text-gray-400">0</span>
                        ) : (
                          <span className={change.diff > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                            {change.diff > 0 ? '+' : '−'}{formatSum(Math.abs(change.diff))} {t('exchangeRates.sum')}
                            {' '}({change.diff > 0 ? '+' : '−'}{Math.abs(change.pct).toFixed(2)}%)
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <SourcePill source={r.source} label={sourceLabel(r.source)} />
                      </td>
                      <td className="px-6 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(r)}
                          aria-label={t('common.delete')}
                          className="text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={rows.length}
            itemsPerPage={ITEMS_PER_PAGE}
            onPageChange={setPage}
          />
        )}
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('exchangeRates.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-2">
            {deleteTarget && (
              <p className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                {formatDmy(deleteTarget.rateDate)} — {formatSum(deleteTarget.rate)} {t('exchangeRates.sum')}
              </p>
            )}
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('exchangeRates.deleteConfirm')}</p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDelete} disabled={deleting} loading={deleting}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
