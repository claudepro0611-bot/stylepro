'use client'

// One raw milk intake: weighing card, then the lab block while the intake is
// 'weighed' (prod_lab only), or the read-only lab results + settlement after
// the decision. Writes: prod_record_milk_lab, prod_cancel_milk_intake,
// prod_amend_milk_lab ("Natijani tuzatish" while the milk lot is untouched)
// and prod_create_price_correction (price of the posted receipt line).

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Ban, Check, FileText, FlaskConical, Loader2, PencilLine, Tags, Truck, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BackLink, InfoField, NoteField, TotalsBox, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { useProdRefs } from '@/components/production/useProdRefs'
import { useProdSuppliers } from '@/components/production/SupplierKit'
import {
  AntibioticBadge, EMPTY_LAB, LabFields, MilkStatusBadge, NetReadout, PricePreviewBox, ThresholdChecks, labPayload, labValues,
  useCancelMilkIntake, useHasPermission, useMilkSettings, type LabDraft,
} from '@/components/production/MilkKit'
import { formatQty, prodErrorKey } from '@/lib/production'
import {
  antibioticKey, focusNextField, formatDensity, formatPct, isStockStatus, milkStatusKey, numInput, parseOverride, pricingModeKey, previewConditional,
  type LabValues, type MilkAntibiotic, type MilkDecision, type MilkIntakeRow,
} from '@/lib/milk'
import { PrintButton, PrintFields, PrintSection, PrintSheet, PrintSignatures } from '@/components/production/PrintKit'
import { PriceCorrectionDialog, PriceCorrectionsSection, type CorrectableLine } from '@/components/production/InventoryKit'
import { effectiveLinePrice, fetchReceiptCorrections, type PriceCorrection } from '@/lib/inventory'

/** Receipt line + its lot state for amend / price correction; null = not available (migration 20261110000014). */
interface ReceiptState {
  line: CorrectableLine | null
  corrections: PriceCorrection[]
  /** The receipt lot still holds exactly the intake's net kg. */
  lotUntouched: boolean
}

export default function MilkIntakeViewPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { itemById, warehouseById } = useProdRefs()
  const { suppliers } = useProdSuppliers()
  const { settings } = useMilkSettings()
  const canLab = useHasPermission('prod_lab')
  const canReceipts = useHasPermission('prod_receipts')

  const [doc, setDoc] = useState<MilkIntakeRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [lab, setLab] = useState<LabDraft>(EMPTY_LAB)
  const [dialog, setDialog] = useState<'conditional' | 'rejected' | null>(null)
  const [overridePrice, setOverridePrice] = useState('')
  const [decisionNote, setDecisionNote] = useState('')
  const [saving, setSaving] = useState<MilkDecision | null>(null)
  const [amending, setAmending] = useState(false)
  const [receiptState, setReceiptState] = useState<ReceiptState | null>(null)
  const [correcting, setCorrecting] = useState(false)
  const labRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase.from('prod_milk_intakes').select('*').eq('id', id).maybeSingle()
    setDoc(data ?? null)
    setAmending(false)
    // Receipt line, corrections and lot state (only for intakes that posted stock).
    if (data?.receipt_id && (data.status === 'accepted' || data.status === 'conditional')) {
      const [corr, lineRes, lotRes] = await Promise.all([
        fetchReceiptCorrections(supabase, data.receipt_id),
        supabase.from('prod_receipt_items').select('id, item_id, qty, price').eq('receipt_id', data.receipt_id).order('id').limit(1).maybeSingle(),
        supabase.from('prod_lot_stock').select('id, remaining_qty').eq('source_doc_type', 'receipt').eq('source_doc_id', data.receipt_id).eq('item_id', data.item_id).maybeSingle(),
      ])
      if (corr === null) setReceiptState(null)
      else {
        const l = lineRes.data
        setReceiptState({
          line: l ? { id: l.id, itemId: l.item_id, qty: Number(l.qty), price: Number(l.price) } : null,
          corrections: corr,
          lotUntouched: !lotRes.error && !!lotRes.data && Number(lotRes.data.remaining_qty) === Number(data.net_kg),
        })
      }
    } else {
      setReceiptState(null)
    }
    // Weighing density is the lab's starting point (lab may correct it).
    if (data?.status === 'weighed') setLab(l => (l.density ? l : { ...l, density: numInput(data.density) }))
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const { canCancel, cancel, busyId } = useCancelMilkIntake(load)

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
  }
  if (!doc) {
    return (
      <div className="space-y-5">
        <BackLink href="/sut-qabuli" label={t('production.milk.title')} />
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('productionErrors.not_found')}</p>
      </div>
    )
  }

  const kg = t('production.units.kg')
  const netKg = Number(doc.net_kg)
  const supplier = suppliers.find(s => s.id === doc.supplier_id)
  const basePrice = supplier?.milkPricePerKg ?? settings.defaultPricePerKg
  const basePriceIsDefault = supplier?.milkPricePerKg == null
  const values = labValues(lab)
  const overrideNum = parseOverride(overridePrice)
  const weighed = doc.status === 'weighed'
  const decided = doc.status === 'accepted' || doc.status === 'conditional' || doc.status === 'rejected'
    || (doc.status === 'cancelled' && doc.lab_at !== null)

  async function decide(decision: MilkDecision) {
    if (!doc) return
    if (decision === 'conditional' && overrideNum === null) { toast.error(t('production.milk.priceRequired')); return }
    if (decision === 'rejected' && !decisionNote.trim()) { toast.error(t('production.milk.reasonRequired')); return }
    setSaving(decision)
    const payload = labPayload(lab, decision, decision === 'conditional' ? overrideNum : null, decision === 'accepted' ? '' : decisionNote)
    const { error } = amending
      ? await createClient().rpc('prod_amend_milk_lab', { p_intake_id: doc.id, p_lab: payload })
      : await createClient().rpc('prod_record_milk_lab', { p_id: doc.id, p_data: payload })
    setSaving(null)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t(amending ? 'prodInventory.lab.amended' : 'production.milk.decided'))
    setDialog(null)
    load()
  }

  function onLabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter' || e.target instanceof HTMLTextAreaElement) return
    if (focusNextField(labRef.current, e.target)) e.preventDefault()
  }

  // Amend: accepted / conditional, receipt untouched (lot remaining = net kg) and no posted price correction.
  const hasPostedCorrection = !!receiptState?.corrections.some(c => c.status === 'posted')
  const canAmend = canLab && !!receiptState && receiptState.lotUntouched && !hasPostedCorrection
    && (doc.status === 'accepted' || doc.status === 'conditional')
  const canCorrect = canReceipts && !!receiptState?.line && (doc.status === 'accepted' || doc.status === 'conditional')
  const amendCount = Number((doc as { lab_amend_count?: number | null }).lab_amend_count ?? 0)
  const amendedAt = (doc as { lab_amended_at?: string | null }).lab_amended_at ?? null

  function startAmend() {
    if (!doc) return
    setLab({
      fat: numInput(doc.fat_pct), protein: numInput(doc.protein_pct), snf: numInput(doc.snf_pct), density: numInput(doc.density),
      acidity: numInput(doc.acidity), temperature: numInput(doc.temperature),
      antibiotic: (doc.antibiotic as MilkAntibiotic | null) ?? 'not_tested',
    })
    setAmending(true)
    setTimeout(() => labRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
  }

  function openDialog(kind: 'conditional' | 'rejected') {
    setOverridePrice('')
    setDecisionNote('')
    setDialog(kind)
  }

  const savedValues: LabValues = {
    fat: doc.fat_pct === null ? null : Number(doc.fat_pct),
    protein: doc.protein_pct === null ? null : Number(doc.protein_pct),
    snf: doc.snf_pct === null ? null : Number(doc.snf_pct),
    density: doc.density === null ? null : Number(doc.density),
    acidity: doc.acidity === null ? null : Number(doc.acidity),
    temperature: doc.temperature === null ? null : Number(doc.temperature),
    antibiotic: (doc.antibiotic as MilkAntibiotic | null) ?? null,
  }

  return (
    <>
    <div className="space-y-5 print:hidden">
      <BackLink href="/sut-qabuli" label={t('production.milk.title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.docTitle')} #{doc.number}</h1>
          <MilkStatusBadge status={doc.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PrintButton />
          {doc.receipt_id && (
            <Link href={`/xom-ashyo-kirim/${doc.receipt_id}`} className={secondaryBtnCls}>
              <FileText className="h-3.5 w-3.5" /> {t('production.milk.openReceipt')}
            </Link>
          )}
          <Link href={`/zavod-yetkazuvchilar/${doc.supplier_id}`} className={secondaryBtnCls}>
            <Truck className="h-3.5 w-3.5" /> {t('production.milk.supplierCard')}
          </Link>
          {canAmend && !amending && (
            <Button variant="outline" onClick={startAmend}>
              <PencilLine className="h-3.5 w-3.5" /> {t('prodInventory.lab.amend')}
            </Button>
          )}
          {canCorrect && (
            <Button variant="outline" onClick={() => setCorrecting(true)}>
              <Tags className="h-3.5 w-3.5" /> {t('prodInventory.corrections.button')}
            </Button>
          )}
          {canCancel && doc.status !== 'cancelled' && (
            <Button variant="outline" onClick={() => cancel(doc.id)} loading={busyId === doc.id}>
              <Ban className="h-3.5 w-3.5" /> {t('production.milk.cancel')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5 items-stretch">
        <div className={cn(prodCardCls, 'p-6 grid grid-cols-2 lg:grid-cols-4 gap-4 content-start')}>
          <InfoField label={t('production.milk.dateTime')}>{formatDateTime(doc.intake_date)}</InfoField>
          <InfoField label={t('production.milk.supplier')}>
            <Link href={`/zavod-yetkazuvchilar/${doc.supplier_id}`} className="text-gray-900 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-400 transition-colors">
              {supplier?.name ?? '—'}
            </Link>
          </InfoField>
          <InfoField label={t('production.common.warehouse')}>{warehouseById.get(doc.warehouse_id)?.name ?? '—'}</InfoField>
          <InfoField label={t('production.milk.item')}>{itemById.get(doc.item_id)?.name ?? '—'}</InfoField>
          <InfoField label={t('production.milk.vehicleNo')}>{doc.vehicle_no || '—'}</InfoField>
          <InfoField label={t('production.milk.driver')}>{doc.driver || '—'}</InfoField>
          <InfoField label={t('production.milk.gross')}><span className="tabular-nums">{formatQty(Number(doc.gross_kg))}</span></InfoField>
          <InfoField label={t('production.milk.tare')}><span className="tabular-nums">{formatQty(Number(doc.tare_kg))}</span></InfoField>
          <InfoField label={t('production.milk.density')}><span className="tabular-nums">{formatDensity(doc.density)}</span></InfoField>
          <InfoField label={t('production.common.author')}>{doc.created_by_name ?? '—'}</InfoField>
          <InfoField label={t('production.common.createdAt')}>{formatDateTime(doc.created_at)}</InfoField>
          {doc.cancelled_at && <InfoField label={t('production.common.cancelledAt')}>{formatDateTime(doc.cancelled_at)}</InfoField>}
          {doc.note && (
            <div className="col-span-2 lg:col-span-4">
              <InfoField label={t('production.common.note')}><span className="whitespace-pre-wrap font-normal">{doc.note}</span></InfoField>
            </div>
          )}
        </div>
        <NetReadout netKg={netKg} litres={doc.volume_l === null ? null : Number(doc.volume_l)} />
      </div>

      {weighed && !canLab && (
        <div className={cn(prodCardCls, 'p-6 flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400')}>
          <FlaskConical className="h-4 w-4 text-gray-400" />
          {t('production.milk.labWaiting')}
        </div>
      )}

      {(weighed || amending) && canLab && (
        <div ref={labRef} onKeyDown={onLabKeyDown} className={cn(prodCardCls, 'p-6 space-y-5')}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{amending ? t('prodInventory.lab.amendTitle') : t('production.milk.lab')}</h2>
              {amending && <p className="mt-0.5 text-[12px] text-amber-700 dark:text-amber-400">{t('prodInventory.lab.amendHint')}</p>}
            </div>
            {amending && <Button variant="outline" onClick={() => setAmending(false)} disabled={!!saving}>{t('production.common.cancel')}</Button>}
          </div>
          <LabFields draft={lab} onChange={patch => setLab(l => ({ ...l, ...patch }))} settings={settings} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            <div className="space-y-4">
              <div>
                <p className={prodLabelCls}>{t('production.milk.checks')}</p>
                <ThresholdChecks values={values} settings={settings} />
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button onClick={() => decide('accepted')} loading={saving === 'accepted'} disabled={!!saving}>
                  <Check className="h-4 w-4" /> {t('production.milk.accept')}
                </Button>
                <Button variant="outline" onClick={() => openDialog('conditional')} disabled={!!saving}>
                  {t('production.milk.conditionalAccept')}
                </Button>
                <Button variant="outline" onClick={() => openDialog('rejected')} disabled={!!saving} className="text-red-600 dark:text-red-400">
                  <X className="h-4 w-4" /> {t('production.milk.reject')}
                </Button>
              </div>
            </div>
            <PricePreviewBox
              netKg={netKg}
              values={values}
              settings={settings}
              basePrice={basePrice}
              basePriceIsDefault={basePriceIsDefault}
              decision="accepted"
              overridePrice={null}
            />
          </div>
        </div>
      )}

      {decided && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          <div className={cn(prodCardCls, 'p-6 space-y-5')}>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.labResults')}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <InfoField label={t('production.milk.fat')}><span className="tabular-nums">{formatPct(savedValues.fat)}</span></InfoField>
              <InfoField label={t('production.milk.protein')}><span className="tabular-nums">{formatPct(savedValues.protein)}</span></InfoField>
              <InfoField label={t('production.milk.snf')}><span className="tabular-nums">{formatPct(savedValues.snf)}</span></InfoField>
              <InfoField label={t('production.milk.density')}><span className="tabular-nums">{formatDensity(savedValues.density)}</span></InfoField>
              <InfoField label={t('production.milk.acidity')}><span className="tabular-nums">{savedValues.acidity ?? '—'}</span></InfoField>
              <InfoField label={t('production.milk.temperature')}><span className="tabular-nums">{savedValues.temperature ?? '—'}</span></InfoField>
              <InfoField label={t('production.milk.antibiotic')}><AntibioticBadge value={doc.antibiotic} /></InfoField>
            </div>
            <ThresholdChecks values={savedValues} settings={settings} showSuggestion={false} />
            <div className="grid grid-cols-2 gap-4 border-t border-gray-100 dark:border-gray-800 pt-4">
              <InfoField label={t('production.milk.labBy')}>{doc.lab_by_name ?? '—'}</InfoField>
              <InfoField label={t('production.milk.labAt')}>{doc.lab_at ? formatDateTime(doc.lab_at) : '—'}</InfoField>
              {amendCount > 0 && <InfoField label={t('prodInventory.lab.amendCount')}><span className="tabular-nums">{amendCount}</span></InfoField>}
              {amendedAt && <InfoField label={t('prodInventory.lab.amendedAt')}>{formatDateTime(amendedAt)}</InfoField>}
              {doc.decision_note && (
                <div className="col-span-2">
                  <InfoField label={t('production.milk.decisionNote')}><span className="whitespace-pre-wrap font-normal">{doc.decision_note}</span></InfoField>
                </div>
              )}
            </div>
          </div>
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('production.milk.settlement')}</h2>
            {doc.status === 'rejected' || (doc.status === 'cancelled' && doc.receipt_id === null) ? (
              <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-4 text-sm text-red-600 dark:text-red-400">
                {t('production.milk.rejectedNoStock')}
              </div>
            ) : (
              <TotalsBox rows={[
                { label: t('production.milk.pricingMode'), value: doc.status === 'conditional' ? t('production.milk.status.conditional') : doc.pricing_mode ? t(pricingModeKey(doc.pricing_mode)) : '—' },
                ...(doc.base_price_per_kg !== null && doc.status !== 'conditional' ? [{ label: t('production.milk.basePrice'), value: formatPrice(Number(doc.base_price_per_kg)) }] : []),
                { label: t('production.milk.netKg'), value: `${formatQty(netKg)} ${kg}` },
                { label: t('production.milk.credited'), value: doc.credited_kg === null ? '—' : `${formatQty(Number(doc.credited_kg))} ${kg}` },
                { label: t('production.milk.pricePerKg'), value: doc.price_per_kg === null ? '—' : formatPrice(Number(doc.price_per_kg)) },
                { label: t('production.milk.amount'), value: doc.amount === null ? '—' : formatPrice(Number(doc.amount)), strong: true },
                ...(receiptState?.line && hasPostedCorrection ? [{
                  label: t('prodInventory.corrections.effectivePrice'),
                  value: formatPrice(effectiveLinePrice(receiptState.line.id, receiptState.line.price, receiptState.corrections)),
                }] : []),
              ]} />
            )}
            {isStockStatus(doc.status) && doc.receipt_id && (
              <Link href={`/xom-ashyo-kirim/${doc.receipt_id}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                <FileText className="h-3.5 w-3.5" /> {t('production.milk.openReceipt')}
              </Link>
            )}
          </div>
        </div>
      )}

      {receiptState && receiptState.corrections.length > 0 && (
        <PriceCorrectionsSection corrections={receiptState.corrections} itemById={itemById} onChanged={load} />
      )}

      {doc.receipt_id && (
        <PriceCorrectionDialog
          open={correcting}
          onOpenChange={setCorrecting}
          receipt={{ id: doc.receipt_id, warehouseId: doc.warehouse_id }}
          line={receiptState?.line ?? null}
          corrections={receiptState?.corrections ?? []}
          item={itemById.get(doc.item_id)}
          onSaved={() => { setCorrecting(false); load() }}
        />
      )}

      <Dialog open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog === 'conditional' ? t('production.milk.conditionalAccept') : t('production.milk.reject')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {dialog === 'conditional' && (
              <>
                <label className="block">
                  <span className={prodLabelCls}>{t('production.milk.conditionalPrice')}</span>
                  <input
                    autoFocus
                    inputMode="decimal"
                    value={overridePrice}
                    onChange={e => setOverridePrice(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); decide('conditional') } }}
                    placeholder={numInput(basePrice) || '0'}
                    className={cn(prodFieldCls, 'h-11 text-base text-right tabular-nums')}
                  />
                </label>
                {overrideNum !== null && (() => {
                  const p = previewConditional(netKg, overrideNum)
                  return (
                    <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-sm">
                      <span className="text-gray-500 dark:text-gray-400">{formatQty(netKg)} {kg} × {formatPrice(overrideNum)}</span>
                      <span className="tabular-nums font-semibold text-gray-900 dark:text-gray-100">{formatPrice(p.amount ?? 0)}</span>
                    </div>
                  )
                })()}
              </>
            )}
            {dialog === 'rejected' && <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('production.milk.rejectedNoStock')}</p>}
            <NoteField
              value={decisionNote}
              onChange={setDecisionNote}
              label={dialog === 'rejected' ? t('production.milk.rejectReason') : t('production.milk.decisionNote')}
            />
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setDialog(null)}>{t('production.common.cancel')}</Button>
            <Button
              onClick={() => dialog && decide(dialog)}
              loading={saving !== null}
              disabled={saving !== null || (dialog === 'conditional' ? overrideNum === null : !decisionNote.trim())}
              variant={dialog === 'rejected' ? 'destructive' : 'default'}
            >
              {t('production.milk.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    <PrintSheet title={t('prodReports.print.weighTicket')} number={doc.number} date={doc.intake_date}>
      <PrintFields rows={[
        { label: t('production.milk.supplier'), value: supplier?.name ?? '—' },
        { label: t('production.milk.item'), value: itemById.get(doc.item_id)?.name ?? '—' },
        { label: t('production.common.warehouse'), value: warehouseById.get(doc.warehouse_id)?.name ?? '—' },
        { label: t('production.milk.vehicleNo'), value: doc.vehicle_no || '—' },
        { label: t('production.milk.driver'), value: doc.driver || '—' },
        { label: t('production.milk.gross'), value: `${formatQty(Number(doc.gross_kg))} ${kg}` },
        { label: t('production.milk.tare'), value: `${formatQty(Number(doc.tare_kg))} ${kg}` },
        { label: t('production.milk.netKg'), value: <span className="text-[14px] font-semibold">{formatQty(netKg)} {kg}</span> },
        { label: t('production.milk.density'), value: formatDensity(doc.density) },
        { label: t('prodReports.print.volume'), value: doc.volume_l === null ? '—' : `${formatQty(Number(doc.volume_l))} ${t('production.units.l')}` },
        { label: t('prodReports.print.weigher'), value: doc.created_by_name ?? '—' },
      ]} />
      {doc.note && <p>{t('production.common.note')}: {doc.note}</p>}
      <PrintSignatures labels={[t('prodReports.print.weigher'), t('prodReports.print.driver')]} />
      {decided && (
        <PrintSection title={`${t('prodReports.print.labProtocol')} № ${doc.number}`}>
          <PrintFields rows={[
            { label: t('production.milk.fat'), value: formatPct(savedValues.fat) },
            { label: t('production.milk.protein'), value: formatPct(savedValues.protein) },
            { label: t('production.milk.snf'), value: formatPct(savedValues.snf) },
            { label: t('production.milk.density'), value: formatDensity(savedValues.density) },
            { label: t('production.milk.acidity'), value: savedValues.acidity ?? '—' },
            { label: t('production.milk.temperature'), value: savedValues.temperature ?? '—' },
            { label: t('production.milk.antibiotic'), value: doc.antibiotic ? t(antibioticKey(doc.antibiotic)) : '—' },
            { label: t('prodReports.print.decision'), value: t(milkStatusKey(doc.status)) },
            { label: t('production.milk.labBy'), value: doc.lab_by_name ?? '—' },
            { label: t('production.milk.labAt'), value: doc.lab_at ? formatDateTime(doc.lab_at) : '—' },
            ...(doc.status !== 'rejected' ? [
              { label: t('production.milk.credited'), value: doc.credited_kg === null ? '—' : `${formatQty(Number(doc.credited_kg))} ${kg}` },
              { label: t('production.milk.pricePerKg'), value: doc.price_per_kg === null ? '—' : formatPrice(Number(doc.price_per_kg)) },
              { label: t('production.milk.amount'), value: doc.amount === null ? '—' : formatPrice(Number(doc.amount)) },
            ] : []),
          ]} />
          {doc.decision_note && <p>{t('production.milk.decisionNote')}: {doc.decision_note}</p>}
          <PrintSignatures labels={[t('prodReports.print.labTech'), t('prodReports.print.supplierSign')]} />
        </PrintSection>
      )}
    </PrintSheet>
    </>
  )
}
