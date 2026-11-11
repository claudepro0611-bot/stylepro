'use client'

// Tablet mode of the weigh station and the lab (prefs.tablet_mode or
// ?tablet=1): full-screen touch flows with big targets.
//  - TabletWeighStation: supplier (search + recent) -> brutto / tara keypad
//    (net auto) -> one "Saqlash" -> success screen with "Keyingisi".
//    Network failures go to the offline queue (lib/milk-offline.ts).
//  - TabletLab: queue of weighed intakes as big cards -> keypad for fat,
//    protein, density, acidity, temperature, antibiotic Yo'q / Bor, decision.
// Writes: prod_create_milk_intake / prod_record_milk_lab only.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Check, CheckCircle2, CloudOff, FlaskConical, Loader2, RotateCcw, Search, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useSession } from '@/lib/session/SessionContext'
import { cn } from '@/lib/utils'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useProdSuppliers } from '@/components/production/SupplierKit'
import { EMPTY_LAB, MilkSetupBanner, ThresholdChecks, labPayload, labValues, useHasPermission, useMilkSettings, type LabDraft } from '@/components/production/MilkKit'
import { useApprovalRetry, useProdErrorText } from '@/components/production/ControlKit'
import { OfflineQueueBar, saveIntakeOrQueue } from '@/components/production/MilkOffline'
import {
  BigValueField, Keypad, TabletShell, keypadInput, tabletCardCls, tabletPrimaryBtn, tabletSecondaryBtn,
} from '@/components/production/TabletKit'
import { Term } from '@/components/production/Term'
import { useMilkOfflineQueue } from '@/lib/milk-offline'
import { fillText } from '@/lib/production-controls'
import { formatQty, parseDecimal, round2, round3, warehousesFor } from '@/lib/production'
import { litresOf, parseOverride, suggestDecision, thresholdChecks, type MilkDecision } from '@/lib/milk'

// ---------------------------------------------------------------------------
// Recent suppliers (per user, this device)

const RECENT_MAX = 8

function recentKey(userId: string | null) { return `stylepro-milk-recent:${userId ?? 'anon'}` }

function readRecent(userId: string | null): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(recentKey(userId)) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function pushRecent(userId: string | null, id: string) {
  try {
    const next = [id, ...readRecent(userId).filter(x => x !== id)].slice(0, RECENT_MAX)
    window.localStorage.setItem(recentKey(userId), JSON.stringify(next))
  } catch { /* storage unavailable */ }
}

const bigCardBtn = 'flex min-h-20 w-full flex-col items-start justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-800 transition-colors'

// ---------------------------------------------------------------------------
// Weigh station

type WeighStep = 'supplier' | 'weigh' | 'done'
type WeighField = 'gross' | 'tare'

export function TabletWeighStation({ onExit }: { onExit: () => void }) {
  const { t } = useLanguage()
  const router = useRouter()
  const { userId } = useSession()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { warehouses } = useProdRefs()
  const { suppliers, loading: suppliersLoading } = useProdSuppliers()
  const { settings, configured, loading: settingsLoading } = useMilkSettings()
  const onPosted = useCallback((n: number) => toast.success(fillText(t('prodOps.offline.synced'), { n })), [t])
  const queue = useMilkOfflineQueue(onPosted)
  const canLab = useHasPermission('prod_lab')

  const [step, setStep] = useState<WeighStep>('supplier')
  const [search, setSearch] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [gross, setGross] = useState('')
  const [tare, setTare] = useState('')
  const [field, setField] = useState<WeighField>('gross')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ number?: number; netKg: number; queued: boolean } | null>(null)

  useEffect(() => { setRecent(readRecent(userId)) }, [userId])

  const rawWarehouses = warehousesFor(warehouses, ['raw'])
  const effectiveWarehouseId = warehouseId
    || (settings.defaultWarehouseId && rawWarehouses.some(w => w.id === settings.defaultWarehouseId) ? settings.defaultWarehouseId : '')
    || (rawWarehouses.length === 1 ? rawWarehouses[0].id : '')

  const active = useMemo(() => suppliers.filter(s => s.isActive), [suppliers])
  const supplier = active.find(s => s.id === supplierId)
  const q = search.trim().toLowerCase()
  const filtered = q ? active.filter(s => s.name.toLowerCase().includes(q) || s.phone.toLowerCase().includes(q)) : active
  const recentSuppliers = recent.map(id => active.find(s => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s)

  const grossNum = parseDecimal(gross)
  const tareNum = parseDecimal(tare)
  const tareExceeds = tareNum > 0 && tareNum > grossNum
  const netKg = tareExceeds ? 0 : round3(grossNum - tareNum)
  const litres = litresOf(netKg, settings.defaultDensity)
  const valid = configured && !!supplierId && !!effectiveWarehouseId && !!settings.milkItemId && grossNum > 0 && netKg > 0 && !tareExceeds

  function pickSupplier(id: string) {
    setSupplierId(id)
    setSearch('')
    setField('gross')
    setStep('weigh')
  }

  function onKey(k: string) {
    if (field === 'gross') setGross(v => keypadInput(v, k))
    else setTare(v => keypadInput(v, k))
  }

  async function save() {
    if (saving || !valid || !supplier) return
    setSaving(true)
    const payload = {
      intake_date: new Date().toISOString(),
      supplier_id: supplierId,
      warehouse_id: effectiveWarehouseId,
      item_id: settings.milkItemId,
      vehicle_no: null,
      driver: null,
      gross_kg: round3(grossNum),
      tare_kg: round3(tareNum),
      density: settings.defaultDensity,
      note: null,
    }
    const r = await saveIntakeOrQueue(approval, queue, payload, supplier.name)
    setSaving(false)
    if (r.kind === 'cancelled') return
    if (r.kind === 'error') { toast.error(errorText(r.error)); return }
    pushRecent(userId, supplierId)
    setRecent(readRecent(userId))
    setResult({ number: r.kind === 'posted' ? r.number : undefined, netKg, queued: r.kind === 'queued' })
    setStep('done')
  }

  function next() {
    setSupplierId('')
    setGross('')
    setTare('')
    setResult(null)
    setField('gross')
    setStep('supplier')
  }

  const kg = t('production.units.kg')

  return (
    <TabletShell
      title={t('prodOps.tablet.weighTitle')}
      onExit={onExit}
      right={canLab ? (
        <button type="button" onClick={() => router.push('/sut-qabuli/laboratoriya')} className={tabletSecondaryBtn}>
          <FlaskConical className="h-5 w-5" /> {t('prodOps.tablet.labTitle')}
        </button>
      ) : undefined}
    >
      <div className="mx-auto max-w-5xl space-y-4">
        <OfflineQueueBar queue={queue} large />
        {!settingsLoading && !configured && <MilkSetupBanner />}

        {step === 'supplier' && (
          <div className="space-y-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('prodOps.tablet.searchSupplier')}
                className="h-16 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-14 pr-4 text-xl text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500"
              />
            </div>
            {!q && recentSuppliers.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('prodOps.tablet.recent')}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {recentSuppliers.map(s => (
                    <button key={s.id} type="button" onClick={() => pickSupplier(s.id)} className={bigCardBtn}>
                      <span className="text-xl font-semibold text-gray-900 dark:text-gray-100">{s.name}</span>
                      {s.phone && <span className="text-lg text-gray-500 dark:text-gray-400">{s.phone}</span>}
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('prodOps.tablet.allSuppliers')}</h2>
              {suppliersLoading ? (
                <div className="flex h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
              ) : filtered.length === 0 ? (
                <p className="py-8 text-center text-lg text-gray-500 dark:text-gray-400">{t('prodOps.tablet.noSuppliers')}</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filtered.slice(0, 60).map(s => (
                    <button key={s.id} type="button" onClick={() => pickSupplier(s.id)} className={bigCardBtn}>
                      <span className="text-xl font-medium text-gray-900 dark:text-gray-100">{s.name}</span>
                      {s.phone && <span className="text-lg text-gray-500 dark:text-gray-400">{s.phone}</span>}
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {step === 'weigh' && (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
            <div className="space-y-4">
              <div className={cn(tabletCardCls, 'flex flex-wrap items-center gap-3 p-4')}>
                <div className="mr-auto min-w-0">
                  <p className="text-lg text-gray-500 dark:text-gray-400">{t('production.milk.supplier')}</p>
                  <p className="truncate text-2xl font-semibold text-gray-900 dark:text-gray-100">{supplier?.name ?? '—'}</p>
                </div>
                <button type="button" onClick={() => setStep('supplier')} className={tabletSecondaryBtn}>
                  <ArrowLeft className="h-5 w-5" /> {t('prodOps.tablet.change')}
                </button>
              </div>
              {!warehouseId && !effectiveWarehouseId && (
                <label className="block">
                  <span className="mb-1 block text-lg text-gray-700 dark:text-gray-300">{t('production.common.warehouse')}</span>
                  <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className="h-14 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 text-lg text-gray-900 dark:text-gray-100">
                    <option value="">{t('production.common.selectWarehouse')}</option>
                    {rawWarehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                <BigValueField label={t('production.milk.gross')} value={gross} unit={kg} active={field === 'gross'} onSelect={() => setField('gross')} />
                <BigValueField label={t('production.milk.tare')} value={tare} unit={kg} active={field === 'tare'} invalid={tareExceeds} onSelect={() => setField('tare')} />
              </div>
              <div className={cn(tabletCardCls, 'p-5')}>
                <p className="text-lg text-gray-500 dark:text-gray-400">{t('production.milk.net')}</p>
                <p className={cn('text-5xl font-semibold tabular-nums', netKg > 0 ? 'text-gray-900 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600')}>
                  {formatQty(netKg > 0 ? netKg : 0)} <span className="text-2xl font-medium text-gray-400 dark:text-gray-500">{kg}</span>
                </p>
                {litres !== null && <p className="mt-1 text-lg tabular-nums text-gray-500 dark:text-gray-400">{formatQty(litres)} {t('production.units.l')}</p>}
                {tareExceeds && <p className="mt-1 text-lg text-red-600 dark:text-red-400">{t('production.milk.tareExceeds')}</p>}
              </div>
            </div>
            <div className="space-y-3">
              <Keypad onKey={onKey} />
              <button type="button" onClick={save} disabled={!valid || saving} className={cn(tabletPrimaryBtn, 'h-16 w-full text-xl')}>
                {saving ? <Loader2 className="h-6 w-6 animate-spin" /> : <Check className="h-6 w-6" />} {t('production.common.save')}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && result && (
          <div className={cn(tabletCardCls, 'mx-auto flex max-w-xl flex-col items-center gap-4 p-8 text-center')}>
            {result.queued
              ? <CloudOff className="h-16 w-16 text-amber-500" />
              : <CheckCircle2 className="h-16 w-16 text-green-600 dark:text-green-400" />}
            <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {result.queued ? t('prodOps.offline.savedOffline') : result.number ? `${t('production.common.saved')}: #${result.number}` : t('production.common.saved')}
            </p>
            <p className="text-4xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatQty(result.netKg)} {kg}</p>
            <p className="text-lg text-gray-500 dark:text-gray-400">{supplier?.name}</p>
            <button type="button" onClick={next} className={cn(tabletPrimaryBtn, 'h-16 w-full text-xl')} autoFocus>
              {t('prodOps.tablet.next')}
            </button>
          </div>
        )}
      </div>
      {approval.dialog}
    </TabletShell>
  )
}

// ---------------------------------------------------------------------------
// Lab

interface QueueRow {
  id: string
  number: number
  intake_date: string
  supplier_id: string
  vehicle_no: string | null
  net_kg: number
  density: number | null
}

type LabField = 'fat' | 'protein' | 'density' | 'acidity' | 'temperature' | 'price'

const LAB_FIELDS: { key: Exclude<LabField, 'price'>; label: 'production.milk.fat' | 'production.milk.protein' | 'production.milk.density' | 'production.milk.acidity' | 'production.milk.temperature' }[] = [
  { key: 'fat', label: 'production.milk.fat' },
  { key: 'protein', label: 'production.milk.protein' },
  { key: 'density', label: 'production.milk.density' },
  { key: 'acidity', label: 'production.milk.acidity' },
  { key: 'temperature', label: 'production.milk.temperature' },
]

export function TabletLab({ onExit, initialId }: { onExit: () => void; initialId?: string | null }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const approval = useApprovalRetry()
  const errorText = useProdErrorText()
  const { suppliers } = useProdSuppliers()
  const { settings } = useMilkSettings()
  const canLab = useHasPermission('prod_lab')
  const supplierById = useMemo(() => new Map(suppliers.map(s => [s.id, s])), [suppliers])

  const [rows, setRows] = useState<QueueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [currentId, setCurrentId] = useState<string | null>(initialId ?? null)
  const [lab, setLab] = useState<LabDraft>(EMPTY_LAB)
  const [field, setField] = useState<LabField>('fat')
  const [decision, setDecision] = useState<MilkDecision | null>(null)
  const [price, setPrice] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await createClient().from('prod_milk_intakes')
      .select('id, number, intake_date, supplier_id, vehicle_no, net_kg, density')
      .eq('status', 'weighed')
      .order('intake_date', { ascending: true })
      .limit(200)
    if (!error) setRows((data ?? []).map(r => ({ ...r, net_kg: Number(r.net_kg), density: r.density === null ? null : Number(r.density) })))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const current = rows.find(r => r.id === currentId) ?? null

  const open = useCallback((r: QueueRow) => {
    setCurrentId(r.id)
    setLab({ ...EMPTY_LAB, density: r.density === null ? '' : String(r.density) })
    setField('fat')
    setDecision(null)
    setPrice('')
    setReason('')
  }, [])

  // ?id= from the intake page: open it once the queue is loaded.
  const [initialOpened, setInitialOpened] = useState(false)
  useEffect(() => {
    if (initialOpened || loading) return
    setInitialOpened(true)
    const r = rows.find(x => x.id === initialId)
    if (r) open(r)
    else setCurrentId(null)
  }, [initialOpened, loading, rows, initialId, open])

  const values = labValues(lab)
  const suggestion = suggestDecision(thresholdChecks(values, settings))
  const antibioticPositive = lab.antibiotic === 'positive'
  const chosen: MilkDecision = decision ?? suggestion
  const effective: MilkDecision = antibioticPositive && chosen === 'accepted' ? 'rejected' : chosen
  const priceNum = parseOverride(price)
  const canSave = !!current && (effective === 'accepted'
    || (effective === 'conditional' && priceNum !== null)
    || (effective === 'rejected' && reason.trim().length > 0))

  function onKey(k: string) {
    if (field === 'price') { setPrice(v => keypadInput(v, k)); return }
    setLab(l => ({ ...l, [field]: keypadInput(l[field], k) }))
  }

  async function save() {
    if (!current || !canSave || saving) return
    setSaving(true)
    const payload = labPayload(lab, effective, effective === 'conditional' ? priceNum : null, effective === 'accepted' ? '' : reason)
    const res = await approval.run(ctl => createClient().rpc('prod_record_milk_lab', { p_id: current.id, p_data: { ...payload, ...ctl } }))
    setSaving(false)
    if (!res) return
    if (res.error) { toast.error(errorText(res.error)); return }
    toast.success(`${t('production.milk.decided')}: #${current.number}`)
    setCurrentId(null)
    void load()
  }

  const kg = t('production.units.kg')
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (!canLab) {
    return (
      <TabletShell title={t('prodOps.tablet.labTitle')} onExit={onExit}>
        <p className="py-12 text-center text-lg text-gray-500 dark:text-gray-400">{t('productionErrors.forbidden')}</p>
      </TabletShell>
    )
  }

  return (
    <TabletShell
      title={current ? `${t('prodOps.tablet.labTitle')} · #${current.number}` : t('prodOps.tablet.labTitle')}
      onExit={onExit}
      right={current ? (
        <button type="button" onClick={() => setCurrentId(null)} className={tabletSecondaryBtn}>
          <ArrowLeft className="h-5 w-5" /> {t('prodOps.tablet.queue')}
        </button>
      ) : (
        <button type="button" onClick={() => { setLoading(true); void load() }} className={tabletSecondaryBtn}>
          <RotateCcw className="h-5 w-5" /> {t('prodOps.tablet.refresh')}
        </button>
      )}
    >
      {!current ? (
        <div className="mx-auto max-w-5xl space-y-3">
          <p className="text-lg text-gray-500 dark:text-gray-400">{fillText(t('prodOps.tablet.waiting'), { n: rows.length })}</p>
          {loading ? (
            <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : rows.length === 0 ? (
            <div className={cn(tabletCardCls, 'flex flex-col items-center gap-3 p-10 text-center')}>
              <FlaskConical className="h-10 w-10 text-gray-400" />
              <p className="text-lg text-gray-500 dark:text-gray-400">{t('prodOps.tablet.queueEmpty')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {rows.map(r => (
                <button key={r.id} type="button" onClick={() => open(r)} className={cn(bigCardBtn, 'min-h-28 gap-1')}>
                  <span className="flex w-full items-center justify-between text-lg text-gray-500 dark:text-gray-400">
                    <span>#{r.number}</span><span className="tabular-nums">{time(r.intake_date)}</span>
                  </span>
                  <span className="text-xl font-semibold text-gray-900 dark:text-gray-100">{supplierById.get(r.supplier_id)?.name ?? '—'}</span>
                  <span className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatQty(r.net_kg)} {kg}</span>
                  {r.vehicle_no && <span className="text-lg text-gray-500 dark:text-gray-400">{r.vehicle_no}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto grid max-w-6xl grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
          <div className="space-y-4">
            <div className={cn(tabletCardCls, 'flex flex-wrap items-center justify-between gap-3 p-4')}>
              <div>
                <p className="text-xl font-semibold text-gray-900 dark:text-gray-100">{supplierById.get(current.supplier_id)?.name ?? '—'}</p>
                <p className="text-lg tabular-nums text-gray-500 dark:text-gray-400">{time(current.intake_date)}{current.vehicle_no ? ` · ${current.vehicle_no}` : ''}</p>
              </div>
              <p className="text-3xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatQty(current.net_kg)} {kg}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {LAB_FIELDS.map(f => (
                <BigValueField key={f.key} label={t(f.label)} value={lab[f.key]} active={field === f.key} onSelect={() => setField(f.key)} placeholder="—" />
              ))}
            </div>
            <div>
              <p className="mb-2 text-lg font-medium text-gray-700 dark:text-gray-300">{t('production.milk.antibiotic')}</p>
              <div className="grid grid-cols-2 gap-3">
                {(['negative', 'positive'] as const).map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setLab(l => ({ ...l, antibiotic: l.antibiotic === v ? 'not_tested' : v }))}
                    aria-pressed={lab.antibiotic === v}
                    className={cn(
                      'min-h-16 rounded-xl border text-xl font-semibold transition-colors',
                      lab.antibiotic === v
                        ? v === 'positive'
                          ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400'
                          : 'border-green-300 bg-green-50 text-green-700 dark:border-green-500/40 dark:bg-green-500/10 dark:text-green-400'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300',
                    )}
                  >
                    {v === 'negative' ? t('prodOps.tablet.abNo') : t('prodOps.tablet.abYes')}
                  </button>
                ))}
              </div>
            </div>
            <div className={cn(tabletCardCls, 'p-4 [&_span]:text-lg [&_p]:text-lg')}>
              <ThresholdChecks values={values} settings={settings} />
            </div>
            <div>
              <p className="mb-2 flex flex-wrap items-center gap-3 text-lg font-medium text-gray-700 dark:text-gray-300">
                {t('production.milk.decision')}
                <Term k="shartliQabul" className="text-base font-normal text-gray-500 dark:text-gray-400" />
              </p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  { v: 'accepted' as const, label: t('production.milk.accept') },
                  { v: 'conditional' as const, label: t('production.milk.conditionalAccept') },
                  { v: 'rejected' as const, label: t('production.milk.reject') },
                ]).map(o => (
                  <button
                    key={o.v}
                    type="button"
                    disabled={o.v === 'accepted' && antibioticPositive}
                    onClick={() => { setDecision(o.v); if (o.v === 'conditional') setField('price') }}
                    aria-pressed={effective === o.v}
                    className={cn(
                      'min-h-16 rounded-xl border px-2 text-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      effective === o.v
                        ? 'border-gray-900 dark:border-gray-100 bg-white dark:bg-gray-900 shadow-sm text-gray-900 dark:text-gray-100'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {antibioticPositive && <p className="mt-2 text-lg text-red-600 dark:text-red-400">{t('prodControls.hints.antibioticAccept')}</p>}
            </div>
            {effective === 'conditional' && (
              <BigValueField
                label={`${t('production.milk.conditionalPrice')}${priceNum !== null ? ` = ${formatPrice(round2(priceNum * current.net_kg))}` : ''}`}
                value={price}
                active={field === 'price'}
                onSelect={() => setField('price')}
              />
            )}
            {effective === 'rejected' && (
              <label className="block">
                <span className="mb-1 block text-lg text-gray-700 dark:text-gray-300">{t('production.milk.rejectReason')}</span>
                <input
                  value={reason}
                  onChange={e => setReason(e.target.value.slice(0, 500))}
                  placeholder={t('prodOps.tablet.reasonPlaceholder')}
                  className="h-14 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 text-lg text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500"
                />
              </label>
            )}
          </div>
          <div className="space-y-3">
            <Keypad onKey={onKey} />
            <button
              type="button"
              onClick={save}
              disabled={!canSave || saving}
              className={cn(effective === 'rejected' ? cn(tabletPrimaryBtn, 'bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 dark:text-white') : tabletPrimaryBtn, 'h-16 w-full text-xl')}
            >
              {saving ? <Loader2 className="h-6 w-6 animate-spin" /> : effective === 'rejected' ? <X className="h-6 w-6" /> : <Check className="h-6 w-6" />}
              {t('production.common.save')}
            </button>
          </div>
        </div>
      )}
      {approval.dialog}
    </TabletShell>
  )
}
