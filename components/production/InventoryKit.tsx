'use client'

// UI pieces for the inventory documents of migration 20261110000014:
// availability hook + "available after update" note, write-off reason /
// stock-count status badges, lot hold dialog and the price correction dialog
// + list. Writes go through prod_set_lot_hold / prod_create_price_correction /
// prod_cancel_document only.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Ban, Info, Loader2, ShieldAlert } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { DocStatusBadge, NoteField, Segmented, prodCardCls, prodFieldCls, prodLabelCls, secondaryBtnCls } from '@/components/production/ProdKit'
import { LotHoldPill } from '@/components/production/LotPicker'
import { useCancelDoc } from '@/components/production/useCancelDoc'
import { useHasPermission } from '@/components/production/MilkKit'
import {
  LOT_HOLD_STATUSES, formatQty, prodErrorKey, unitKey,
  type LotHoldStatus, type ProdItem, type ProdUnit,
} from '@/lib/production'
import {
  effectiveLinePrice, fetchLineLots, latestCorrectionIds, parseMoneyOrNull, previewCorrection, probeInventoryDocs, writeoffReasonKey,
  type PriceCorrection, type RevaluedLot,
} from '@/lib/inventory'

/** null while probing, then whether migration 20261110000014 is live. */
export function useInventoryDocs(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    probeInventoryDocs(createClient()).then(v => { if (!cancelled) setOk(v) })
    return () => { cancelled = true }
  }, [])
  return ok
}

/** Shown instead of a feature while the migration is not applied. */
export function NotAvailableNote({ className }: { className?: string }) {
  const { t } = useLanguage()
  return (
    <div className={cn(prodCardCls, 'flex items-center gap-3 p-6 text-sm text-gray-500 dark:text-gray-400', className)}>
      <Info className="h-4 w-4 shrink-0 text-gray-400" />
      {t('prodInventory.common.notAvailable')}
    </div>
  )
}

/** Write-off reason is categorical: monochrome pill. */
export function WriteoffReasonBadge({ reason }: { reason: string }) {
  const { t } = useLanguage()
  return (
    <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-gray-700 dark:text-gray-300">
      {t(writeoffReasonKey(reason))}
    </span>
  )
}

/** Draft (gray) / posted / cancelled. */
export function CountStatusBadge({ status }: { status: string }) {
  const { t } = useLanguage()
  if (status === 'draft') {
    return (
      <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-gray-600 dark:text-gray-400">
        {t('prodInventory.common.statusDraft')}
      </span>
    )
  }
  return <DocStatusBadge status={status} />
}

// ---------------------------------------------------------------------------
// Lot hold

export interface HoldTarget { id: string; lotNo: string; holdStatus: LotHoldStatus; holdReason: string; holdAt?: string | null }

/** Pill + "change" button (prod_stock only). onSaved reloads the caller. */
export function LotHoldControl({ lot, onSaved, compact }: { lot: HoldTarget; onSaved: () => void; compact?: boolean }) {
  const { t } = useLanguage()
  const canEdit = useHasPermission('prod_stock')
  const [open, setOpen] = useState(false)
  return (
    <span className="inline-flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
      <LotHoldPill status={lot.holdStatus} reason={lot.holdReason} />
      {canEdit && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={t('prodInventory.hold.change')}
          aria-label={t('prodInventory.hold.change')}
          className={compact
            ? 'flex h-6 w-6 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'
            : cn(secondaryBtnCls, 'h-7 px-2 text-xs')}
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          {!compact && t('prodInventory.hold.change')}
        </button>
      )}
      <LotHoldDialog lot={open ? lot : null} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved() }} />
    </span>
  )
}

export function LotHoldDialog({ lot, onClose, onSaved }: { lot: HoldTarget | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useLanguage()
  const [status, setStatus] = useState<LotHoldStatus>('free')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!lot) return
    setStatus(lot.holdStatus)
    setReason(lot.holdReason)
  }, [lot])

  async function save() {
    if (!lot) return
    setSaving(true)
    const { error } = await createClient().rpc('prod_set_lot_hold', {
      p_lot_id: lot.id,
      p_status: status,
      p_reason: status === 'free' ? null : reason.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('prodInventory.hold.saved'))
    onSaved()
  }

  return (
    <Dialog open={lot !== null} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('prodInventory.hold.title')} {lot?.lotNo ?? ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <span className={prodLabelCls}>{t('prodInventory.hold.status')}</span>
            <Segmented
              options={LOT_HOLD_STATUSES.map(s => ({ value: s, label: t(`prodInventory.hold.${s}`) }))}
              value={status}
              onChange={setStatus}
            />
          </div>
          {status !== 'free' && (
            <NoteField value={reason} onChange={setReason} label={t('prodInventory.hold.reason')} />
          )}
          <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodInventory.hold.fefoHint')}</p>
          {lot?.holdAt && (
            <p className="text-[12px] text-gray-400 dark:text-gray-500">{t('prodInventory.hold.since')}: {formatDateTime(lot.holdAt)}</p>
          )}
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={onClose}>{t('production.common.cancel')}</Button>
          <Button onClick={save} loading={saving} disabled={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Price correction

export interface CorrectableLine { id: string; itemId: string; qty: number; price: number }

/**
 * New-price dialog of one receipt line with a live preview of the debt
 * delta, the revalued stock and the consumed variance (same formulas as
 * prod_create_price_correction; the server recomputes everything).
 */
export function PriceCorrectionDialog({ open, onOpenChange, receipt, line, corrections, item, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  receipt: { id: string; warehouseId: string }
  line: CorrectableLine | null
  corrections: PriceCorrection[]
  item: ProdItem | undefined
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [lots, setLots] = useState<RevaluedLot[] | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const oldPrice = line ? effectiveLinePrice(line.id, line.price, corrections) : 0
  const lineCorrectionIds = useMemo(
    () => (line ? corrections.filter(c => c.receiptItemId === line.id && c.status === 'posted').map(c => c.id) : []),
    [line, corrections],
  )

  useEffect(() => {
    if (!open || !line) return
    setValue('')
    setNote('')
    setLots(undefined)
    let cancelled = false
    fetchLineLots(createClient(), { receiptId: receipt.id, warehouseId: receipt.warehouseId, itemId: line.itemId, correctionIds: lineCorrectionIds })
      .then(l => { if (!cancelled) setLots(l) })
    return () => { cancelled = true }
  }, [open, line, receipt.id, receipt.warehouseId, lineCorrectionIds])

  const newPrice = parseMoneyOrNull(value)
  const valid = newPrice !== null && newPrice !== undefined && newPrice !== oldPrice
  const preview = line && newPrice != null ? previewCorrection(line.qty, oldPrice, newPrice, lots ?? null) : null
  const unit = item ? t(unitKey(item.unit as ProdUnit)) : ''

  async function save() {
    if (!line || !valid) { toast.error(t('prodInventory.corrections.samePrice')); return }
    setSaving(true)
    const { error } = await createClient().rpc('prod_create_price_correction', {
      p_data: { receipt_id: receipt.id, receipt_item_id: line.id, new_price: newPrice, note: note.trim() || null },
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('prodInventory.corrections.saved'))
    onSaved()
  }

  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatPrice(Math.abs(n))}`
  const toneCls = (n: number) => (n > 0 ? 'text-red-600 dark:text-red-400' : n < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-gray-100')
  const row = (label: string, v: string, cls = 'text-gray-900 dark:text-gray-100') => (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className={cn('tabular-nums font-medium', cls)}>{v}</span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('prodInventory.corrections.dialogTitle')}{item ? `: ${item.name}` : ''}</DialogTitle>
        </DialogHeader>
        {line && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('production.common.qty')}</p>
                <p className="mt-0.5 font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatQty(line.qty)} {unit}</p>
              </div>
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('prodInventory.corrections.linePrice')}</p>
                <p className="mt-0.5 font-medium tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(line.price)}</p>
              </div>
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 px-3 py-2.5">
                <p className="text-xs text-gray-400 dark:text-gray-500">{t('prodInventory.corrections.oldPrice')}</p>
                <p className="mt-0.5 font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatPrice(oldPrice)}</p>
              </div>
            </div>
            <label className="block">
              <span className={prodLabelCls}>{t('prodInventory.corrections.newPrice')}</span>
              <input
                autoFocus
                inputMode="decimal"
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={String(oldPrice)}
                className={cn(prodFieldCls, 'h-11 text-base text-right tabular-nums', newPrice === undefined && 'border-red-300 dark:border-red-800')}
              />
              {newPrice !== null && newPrice !== undefined && newPrice === oldPrice && (
                <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">{t('prodInventory.corrections.samePrice')}</span>
              )}
            </label>
            {preview && (
              <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-4 space-y-2">
                {row(t('prodInventory.corrections.debtDelta'), signed(preview.debtDelta), toneCls(preview.debtDelta))}
                {lots === undefined ? (
                  <div className="flex justify-center py-1"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
                ) : lots === null ? (
                  <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('prodInventory.corrections.noLotsHint')}</p>
                ) : (
                  <>
                    {row(t('prodInventory.corrections.stockQty'), `${formatQty(preview.stockQty)} ${unit}`)}
                    {row(t('prodInventory.corrections.stockDelta'), signed(preview.stockDelta))}
                    {row(t('prodInventory.corrections.consumedQty'), `${formatQty(preview.consumedQty)} ${unit}`)}
                    {row(t('prodInventory.corrections.consumedVariance'), signed(preview.consumedVariance))}
                  </>
                )}
                <p className="border-t border-gray-200 dark:border-gray-700 pt-2 text-[11px] text-gray-400 dark:text-gray-500">{t('prodInventory.corrections.varianceHint')}</p>
              </div>
            )}
            <NoteField value={note} onChange={setNote} />
          </div>
        )}
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} loading={saving} disabled={saving || !valid}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const th = 'px-4 py-2.5 text-left font-medium whitespace-nowrap'
const thR = 'px-4 py-2.5 text-right font-medium whitespace-nowrap'
const td = 'px-4 py-2'
const tdR = 'px-4 py-2 text-right tabular-nums whitespace-nowrap'

/** Corrections of a receipt; cancel only for the latest posted one of a line (owner/admin). */
export function PriceCorrectionsSection({ corrections, itemById, onChanged, showReceipt }: {
  corrections: PriceCorrection[]
  itemById: Map<string, ProdItem>
  onChanged: () => void
  showReceipt?: { numberById: Map<string, number> }
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { canCancel, cancel, busyId } = useCancelDoc('price_correction', onChanged)
  const latest = useMemo(() => latestCorrectionIds(corrections), [corrections])
  if (corrections.length === 0) return null
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatPrice(Math.abs(n))}`

  return (
    <div className={cn(prodCardCls, 'overflow-hidden')}>
      <h2 className="border-b border-gray-100 dark:border-gray-800 px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('prodInventory.corrections.listTitle')}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={th}>{t('production.common.number')}</th>
              <th className={th}>{t('production.common.date')}</th>
              {showReceipt && <th className={th}>{t('prodInventory.corrections.receipt')}</th>}
              <th className={th}>{t('production.common.item')}</th>
              <th className={thR}>{t('prodInventory.corrections.oldPrice')}</th>
              <th className={thR}>{t('prodInventory.corrections.newPrice')}</th>
              <th className={thR}>{t('prodInventory.corrections.debtDelta')}</th>
              <th className={thR}>{t('prodInventory.corrections.stockDelta')}</th>
              <th className={thR}>{t('prodInventory.corrections.consumedVariance')}</th>
              <th className={th}>{t('production.common.status')}</th>
              <th className={th}>{t('production.common.author')}</th>
              <th className={thR}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {corrections.map(c => (
              <tr key={c.id} className={cn('border-b border-gray-50 dark:border-gray-800/60 last:border-0', c.status === 'cancelled' && 'opacity-60')}>
                <td className={cn(td, 'font-medium text-gray-900 dark:text-gray-100')}>#{c.number}</td>
                <td className={cn(td, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(c.docDate)}</td>
                {showReceipt && (
                  <td className={td}>
                    <Link href={`/xom-ashyo-kirim/${c.receiptId}`} className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                      #{showReceipt.numberById.get(c.receiptId) ?? '—'}
                    </Link>
                  </td>
                )}
                <td className={cn(td, 'text-gray-900 dark:text-gray-100')}>{itemById.get(c.itemId)?.name ?? '—'}</td>
                <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{formatPrice(c.oldPrice)}</td>
                <td className={cn(tdR, 'font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(c.newPrice)}</td>
                <td className={cn(tdR, c.debtDelta > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>{signed(c.debtDelta)}</td>
                <td className={cn(tdR, 'text-gray-700 dark:text-gray-300')}>{signed(c.stockDelta)}</td>
                <td className={cn(tdR, 'text-gray-500 dark:text-gray-400')}>{signed(c.consumedVariance)}</td>
                <td className={td}><DocStatusBadge status={c.status} /></td>
                <td className={cn(td, 'text-gray-500 dark:text-gray-400')}>{c.createdByName || '—'}</td>
                <td className={td}>
                  <div className="flex justify-end">
                    {canCancel && c.status === 'posted' && (
                      <button
                        type="button"
                        onClick={() => cancel(c.id)}
                        disabled={busyId === c.id || !latest.has(c.id)}
                        title={latest.has(c.id) ? t('production.common.cancelDoc') : t('prodInventory.corrections.latestOnly')}
                        aria-label={t('production.common.cancelDoc')}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-30 disabled:hover:text-gray-400 transition-colors"
                      >
                        {busyId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
