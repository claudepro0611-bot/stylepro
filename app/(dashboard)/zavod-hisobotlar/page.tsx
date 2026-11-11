'use client'

// Zavod hisobotlari: index of the read-only production reports + a lot
// number lookup that opens the lot trace. Route guard: proxy.ts
// (PRODUCTION_PREFIXES + ROUTE_PERMISSIONS 'prod_stock').

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight, Calculator, CalendarClock, GitBranch, HandCoins, Hourglass, Landmark, Milk, Percent, Receipt, Scale, Search, TrendingDown, TrendingUp } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PageHeader, prodCardCls, prodFieldCls } from '@/components/production/ProdKit'
import { ReportNavCard } from '@/components/production/ReportKit'
import { useHasPermission, useIsOwnerOrAdmin } from '@/components/production/MilkKit'
import { lotTraceHref } from '@/lib/production-reports'

export default function ProductionReportsIndexPage() {
  const { t } = useLanguage()
  const router = useRouter()
  const [lotNo, setLotNo] = useState('')
  const [busy, setBusy] = useState(false)
  // Sales reports additionally need 'prod_sales' (proxy.ts).
  const canSales = useHasPermission('prod_sales')
  // Cash report additionally needs 'prod_cash' (proxy.ts).
  const canCash = useHasPermission('prod_cash')
  // Accounting reports (migration 20261110000018): owner / admin (proxy.ts OWNER_ADMIN_PATHS).
  const canAccounting = useIsOwnerOrAdmin()

  async function findLot(e: FormEvent) {
    e.preventDefault()
    let q = lotNo.trim().toUpperCase()
    if (!q) return
    if (/^\d+$/.test(q)) q = `P-${q.padStart(6, '0')}`
    setBusy(true)
    const { data } = await createClient().from('prod_lots').select('id').eq('lot_no', q).limit(1).maybeSingle()
    setBusy(false)
    if (!data) { toast.error(t('prodReports.index.lotNotFound')); return }
    router.push(lotTraceHref(data.id))
  }

  const cards = [
    { href: '/zavod-hisobotlar/oborot', icon: ArrowLeftRight, title: t('prodReports.turnover.title'), description: t('prodReports.turnover.subtitle') },
    { href: '/zavod-hisobotlar/qoldiq-sanaga', icon: CalendarClock, title: t('prodReports.stockAt.title'), description: t('prodReports.stockAt.subtitle') },
    { href: '/zavod-hisobotlar/muddat', icon: Hourglass, title: t('prodReports.expiry.title'), description: t('prodReports.expiry.subtitle') },
    { href: '/zavod-hisobotlar/norma-fakt', icon: Scale, title: t('prodReports.norm.title'), description: t('prodReports.norm.subtitle') },
    { href: '/zavod-hisobotlar/yoqotish', icon: TrendingDown, title: t('prodReports.loss.title'), description: t('prodReports.loss.subtitle') },
    { href: '/zavod-hisobotlar/sut', icon: Milk, title: t('prodReports.milk.title'), description: t('prodReports.milk.subtitle') },
    ...(canSales ? [
      { href: '/zavod-hisobotlar/sotuv', icon: Receipt, title: t('prodSales.reports.salesTitle'), description: t('prodSales.reports.salesSubtitle') },
      { href: '/zavod-hisobotlar/debitorlik', icon: HandCoins, title: t('prodSales.reports.receivablesTitle'), description: t('prodSales.reports.receivablesSubtitle') },
    ] : []),
    ...(canCash ? [
      { href: '/zavod-hisobotlar/kassa', icon: Landmark, title: t('prodCash.report.title'), description: t('prodCash.report.subtitle') },
    ] : []),
    ...(canAccounting ? [
      { href: '/zavod-hisobotlar/foyda', icon: TrendingUp, title: t('prodAcct.reports.pnlTitle'), description: t('prodAcct.reports.pnlSubtitle') },
      { href: '/zavod-hisobotlar/qqs', icon: Percent, title: t('prodAcct.reports.vatTitle'), description: t('prodAcct.reports.vatSubtitle') },
      { href: '/zavod-hisobotlar/tannarx', icon: Calculator, title: t('prodAcct.reports.costTitle'), description: t('prodAcct.reports.costSubtitle') },
    ] : []),
  ]

  return (
    <div className="space-y-5">
      <PageHeader title={t('prodReports.index.title')} subtitle={t('prodReports.index.subtitle')} />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cards.map(c => <ReportNavCard key={c.href} {...c} />)}
      </div>

      <form onSubmit={findLot} className={cn(prodCardCls, 'p-5 flex flex-wrap items-center gap-3')}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
          <GitBranch className="h-4 w-4 text-gray-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodReports.trace.title')}</p>
          <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('prodReports.index.lotHint')}</p>
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={lotNo} onChange={e => setLotNo(e.target.value)} placeholder="P-000001" className={cn(prodFieldCls, 'pl-9')} />
        </div>
        <Button type="submit" loading={busy} disabled={!lotNo.trim()}>{t('prodReports.index.openLot')}</Button>
      </form>
    </div>
  )
}
