'use client'

// "QQS": VAT per business month (prod_vat_summary, migration 20261110000018):
// output VAT (sales - returns), input VAT (receipts of VAT-payer periods +
// their price corrections) and the payable balance. Owner / admin only:
// proxy.ts (OWNER_ADMIN_PATHS + 'prod_stock').

import { useEffect, useMemo, useState } from 'react'
import { ArrowDownCircle, ArrowUpCircle, Landmark, Percent } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { BackLink, TableCard, prodCardCls, prodFieldCls, tdCls, thCls, thRightCls, trCls } from '@/components/production/ProdKit'
import { ExportButton, ProdKpiGrid } from '@/components/production/ReportKit'
import { AcctNote, useAccounting } from '@/components/production/AccountingKit'
import { useRole } from '@/components/production/ControlKit'
import { isOwnerAdminRole, todayYmd } from '@/lib/production-controls'
import { round2 } from '@/lib/production'
import { downloadXlsx, x2 } from '@/lib/production-reports'

interface VatRow {
  month: string; salesVat: number; returnsVat: number; outputVat: number; receiptsVat: number; correctionsVat: number; inputVat: number; payable: number
}

const MONTH_KEYS: TranslationKey[] = [
  'dashboard.monthsShort.jan', 'dashboard.monthsShort.feb', 'dashboard.monthsShort.mar', 'dashboard.monthsShort.apr',
  'dashboard.monthsShort.may', 'dashboard.monthsShort.jun', 'dashboard.monthsShort.jul', 'dashboard.monthsShort.aug',
  'dashboard.monthsShort.sep', 'dashboard.monthsShort.oct', 'dashboard.monthsShort.nov', 'dashboard.monthsShort.dec',
]

const COLS: { key: Exclude<keyof VatRow, 'month'>; label: TranslationKey; strong?: boolean }[] = [
  { key: 'salesVat', label: 'prodAcct.vatReport.salesVat' },
  { key: 'returnsVat', label: 'prodAcct.vatReport.returnsVat' },
  { key: 'outputVat', label: 'prodAcct.vatReport.outputVat', strong: true },
  { key: 'receiptsVat', label: 'prodAcct.vatReport.receiptsVat' },
  { key: 'correctionsVat', label: 'prodAcct.vatReport.correctionsVat' },
  { key: 'inputVat', label: 'prodAcct.vatReport.inputVat', strong: true },
  { key: 'payable', label: 'prodAcct.vatReport.payable', strong: true },
]

export default function VatReportPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const role = useRole()
  const allowed = isOwnerAdminRole(role)
  const accounting = useAccounting()

  const [fromMonth, setFromMonth] = useState('')
  const [toMonth, setToMonth] = useState('')
  const [rows, setRows] = useState<VatRow[]>([])
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)

  // Client clock only: this year so far.
  useEffect(() => {
    const today = todayYmd()
    setFromMonth(`${today.slice(0, 4)}-01`)
    setToMonth(today.slice(0, 7))
  }, [])

  useEffect(() => {
    if (!allowed || !fromMonth || !toMonth) return
    let alive = true
    setLoading(true)
    createClient().from('prod_vat_summary').select('*')
      .gte('month', `${fromMonth}-01`).lte('month', `${toMonth}-01`).order('month', { ascending: false })
      .then(({ data, error }) => {
        if (!alive) return
        if (error) {
          // The view does not exist before the migration.
          if (/does not exist|could not find|schema cache/i.test(error.message)) setMissing(true)
          else toast.error(t('productionErrors.unknown'))
        }
        setRows((data ?? []).map(r => ({
          month: r.month ?? '', salesVat: Number(r.sales_vat ?? 0), returnsVat: Number(r.returns_vat ?? 0), outputVat: Number(r.output_vat ?? 0),
          receiptsVat: Number(r.receipts_vat ?? 0), correctionsVat: Number(r.corrections_vat ?? 0), inputVat: Number(r.input_vat ?? 0), payable: Number(r.payable ?? 0),
        })))
        setLoading(false)
      })
    return () => { alive = false }
  }, [allowed, fromMonth, toMonth, t])

  const sum = useMemo(() => {
    const s = { salesVat: 0, returnsVat: 0, outputVat: 0, receiptsVat: 0, correctionsVat: 0, inputVat: 0, payable: 0 }
    for (const r of rows) for (const c of COLS) s[c.key] += r[c.key]
    for (const c of COLS) s[c.key] = round2(s[c.key])
    return s
  }, [rows])

  const monthLabel = (m: string) => `${t(MONTH_KEYS[Number(m.slice(5, 7)) - 1])} ${m.slice(0, 4)}`

  function exportXlsx() {
    downloadXlsx('qqs', [t('prodAcct.vatReport.month'), ...COLS.map(c => `${t(c.label)} (UZS)`)],
      rows.map(r => [monthLabel(r.month), ...COLS.map(c => x2(r[c.key]))]), t('prodAcct.reports.vatTitle'))
  }

  if (!allowed || missing) {
    return (
      <div className="space-y-5">
        <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
        <AcctNote text={!allowed ? t('prodAcct.ownerAdminOnly') : t('prodAcct.notAvailable')} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <BackLink href="/zavod-hisobotlar" label={t('prodReports.index.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('prodAcct.reports.vatTitle')}</h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t('prodAcct.reports.vatSubtitle')}</p>
        </div>
        <ExportButton onClick={exportXlsx} disabled={rows.length === 0} />
      </div>

      <div className={cn(prodCardCls, 'p-3 flex flex-wrap items-center gap-2')}>
        <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-gray-400">
          <span>{t('prodAcct.vatReport.from')}</span>
          <input type="month" value={fromMonth} max={toMonth || undefined} onChange={e => e.target.value && setFromMonth(e.target.value)} className={cn(prodFieldCls, 'w-44')} />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-gray-400">
          <span>{t('prodAcct.vatReport.to')}</span>
          <input type="month" value={toMonth} min={fromMonth || undefined} onChange={e => e.target.value && setToMonth(e.target.value)} className={cn(prodFieldCls, 'w-44')} />
        </label>
      </div>

      <ProdKpiGrid items={[
        { label: t('prodAcct.vatReport.outputVat'), value: formatPrice(sum.outputVat), icon: ArrowUpCircle },
        { label: t('prodAcct.vatReport.inputVat'), value: formatPrice(sum.inputVat), icon: ArrowDownCircle },
        {
          label: sum.payable < 0 ? t('prodAcct.vatReport.refundable') : t('prodAcct.vatReport.payable'),
          value: formatPrice(Math.abs(sum.payable)), icon: Landmark, tone: sum.payable < 0 ? 'positive' : undefined,
        },
        { label: t('prodAcct.vatReport.months'), value: String(rows.length), icon: Percent },
      ]} />

      <TableCard loading={loading} empty={rows.length === 0} emptyText={t('prodReports.common.empty')} emptyIcon={Percent}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('prodAcct.vatReport.month')}</th>
              {COLS.map(c => <th key={c.key} className={thRightCls}>{t(c.label)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.month} className={trCls}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap')}>{monthLabel(r.month)}</td>
                {COLS.map(c => (
                  <td key={c.key} className={cn(
                    tdCls, 'text-right tabular-nums whitespace-nowrap',
                    c.strong ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400',
                    c.key === 'payable' && r.payable < 0 && 'text-emerald-600 dark:text-emerald-400',
                  )}>{formatPrice(r[c.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 dark:bg-gray-800/50 font-semibold text-gray-900 dark:text-gray-100">
              <td className="px-4 py-3">{t('production.common.total')}</td>
              {COLS.map(c => <td key={c.key} className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatPrice(sum[c.key])}</td>)}
            </tr>
          </tfoot>
        </table>
      </TableCard>
      <p className="text-[12px] text-gray-400 dark:text-gray-500">
        {t('prodAcct.vatReport.note')} {accounting.available && !accounting.settings.vatPayer ? t('prodAcct.vatReport.notPayer') : ''}
      </p>
    </div>
  )
}
