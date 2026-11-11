'use client'

// Printable document forms of the production module (tortish cheki,
// laboratoriya protokoli, nakladnoy, ishlab chiqarish akti, kirim, separatsiya
// akti). Pure CSS @media print, no extra library: the detail page hides its
// screen content with `print:hidden` and renders a <PrintSheet>, which is
// invisible on screen and the only thing on paper. Same app-chrome hiding
// rule as the akt-sverka pages (aside / header / .no-print).

import type { ReactNode } from 'react'
import { Printer } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useSession } from '@/lib/session/SessionContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { secondaryBtnCls } from '@/components/production/ProdKit'

const PRINT_CSS = '@media print { aside, header, .no-print { display: none !important; } main { padding: 0 !important; } body { background: #fff !important; } @page { margin: 12mm; } }'

export function PrintButton({ label }: { label?: string }) {
  const { t } = useLanguage()
  return (
    <button type="button" onClick={() => window.print()} className={cn(secondaryBtnCls, 'print:hidden')}>
      <Printer className="h-3.5 w-3.5" /> {label ?? t('prodReports.print.print')}
    </button>
  )
}

/** Paper-only document: company name + title header, then the sections, then signatures. */
export function PrintSheet({ title, number, date, children, signatures }: {
  title: string
  number?: number | string
  date?: string
  children: ReactNode
  /** Signature line labels (e.g. "Topshirdi", "Qabul qildi"). */
  signatures?: string[]
}) {
  const { t } = useLanguage()
  const { company } = useSession()
  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="hidden print:block text-[12px] leading-snug text-black">
        <div className="flex items-start justify-between border-b border-black pb-2">
          <p className="text-[13px] font-semibold">{company?.name ?? ''}</p>
          <p className="text-[11px]">{t('prodReports.print.printedAt')}: {formatDateTime(new Date().toISOString())}</p>
        </div>
        <div className="mt-4 text-center">
          <p className="text-base font-semibold uppercase">{title}{number !== undefined ? ` № ${number}` : ''}</p>
          {date && <p className="mt-0.5">{formatDateTime(date)}</p>}
        </div>
        <div className="mt-4 space-y-4">{children}</div>
        {signatures && signatures.length > 0 && <PrintSignatures labels={signatures} />}
      </div>
    </>
  )
}

/** Signature lines ("Topshirdi: ________"). */
export function PrintSignatures({ labels }: { labels: string[] }) {
  const { t } = useLanguage()
  return (
    <div className="mt-10 grid grid-cols-2 gap-x-10 gap-y-8">
      {labels.map(s => (
        <div key={s}>
          <p>{s}:</p>
          <div className="mt-6 border-b border-black" />
          <p className="mt-0.5 text-[10px] text-gray-600">{t('prodReports.print.signHint')}</p>
        </div>
      ))}
    </div>
  )
}

/** A second form inside the same sheet (e.g. lab protocol after the weighing ticket), optionally on a new page. */
export function PrintSection({ title, children, newPage }: { title: string; children: ReactNode; newPage?: boolean }) {
  return (
    <div className={cn('space-y-4', newPage ? 'break-before-page pt-2' : 'border-t border-black pt-4')}>
      <p className="text-center text-base font-semibold uppercase">{title}</p>
      {children}
    </div>
  )
}

/** Label / value grid of a printed form. */
export function PrintFields({ rows, cols = 2 }: { rows: { label: string; value: ReactNode }[]; cols?: 2 | 3 }) {
  return (
    <div className={cn('grid gap-x-6 gap-y-1', cols === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {rows.map(r => (
        <div key={r.label} className="flex gap-2 border-b border-dotted border-gray-400 py-0.5">
          <span className="shrink-0 text-gray-700">{r.label}:</span>
          <span className="font-medium">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

export interface PrintColumn { label: string; right?: boolean }

/** Bordered table of a printed form, optional bold total row. */
export function PrintTable({ title, columns, rows, total }: {
  title?: string
  columns: PrintColumn[]
  rows: ReactNode[][]
  total?: ReactNode[]
}) {
  const cell = 'border border-black px-1.5 py-1'
  return (
    <div>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={cn(cell, 'w-8 text-center font-semibold')}>№</th>
            {columns.map(c => <th key={c.label} className={cn(cell, 'font-semibold', c.right ? 'text-right' : 'text-left')}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className={cn(cell, 'text-center')}>{i + 1}</td>
              {r.map((v, j) => <td key={j} className={cn(cell, columns[j]?.right && 'text-right tabular-nums whitespace-nowrap')}>{v}</td>)}
            </tr>
          ))}
          {total && (
            <tr className="font-semibold">
              <td className={cell} />
              {total.map((v, j) => <td key={j} className={cn(cell, columns[j]?.right && 'text-right tabular-nums whitespace-nowrap')}>{v}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
