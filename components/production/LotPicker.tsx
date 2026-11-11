'use client'

// Lot ("partiya") selection for a consumed document line. The trigger sits
// next to the line's quantity and shows "Avto (FIFO)" or "N partiya". The
// dialog lists the warehouse's lots of the item in FEFO order with a live
// preview of what automatic consumption would take, so the exact cost is
// visible either way. Picks are sent to the RPC as [{lot_id, qty}] (see
// picksPayload); the server re-validates and consumes the lots.

import { useState } from 'react'
import { Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { localYmd } from '@/lib/utils/date'
import { formatDate } from '@/lib/utils/formatters'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { prodFieldCls } from '@/components/production/ProdKit'
import { useControls, useRole } from '@/components/production/ControlKit'
import {
  allocateFefo, allocatePicks, formatQty, isLotFree, lotExpiryState, lotPickable, parseDecimal, picksValid, round3, unitKey,
  type LotHoldMode, type LotHoldStatus, type LotPick, type ProdLot, type ProdUnit,
} from '@/lib/production'
import { formatPct } from '@/lib/milk'

/** "YYYY-MM-DD" (a date column) -> display date, parsed as a local day. */
export function formatYmd(ymd: string | null): string {
  return ymd ? formatDate(`${ymd}T00:00:00`) : '—'
}

/** Expiry date, red when expired and amber when within warnDays (the item's expiry_warn_days, default LOT_EXPIRY_WARN_DAYS). */
export function LotExpiry({ date, today, warnDays }: { date: string | null; today?: string; warnDays?: number }) {
  const { t } = useLanguage()
  const state = lotExpiryState(date, today ?? localYmd(), warnDays)
  if (!date) return <span className="text-gray-400 dark:text-gray-500">—</span>
  if (state === 'expired' || state === 'soon') {
    return (
      <span
        title={state === 'expired' ? t('production.lots.expired') : t('production.lots.expiresSoon')}
        className={cn(
          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
          state === 'expired'
            ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
        )}
      >
        {formatYmd(date)}
      </span>
    )
  }
  return <span className="whitespace-nowrap text-gray-700 dark:text-gray-300">{formatYmd(date)}</span>
}

/** Lot number with an "opening balance" pill for backfilled lots. */
export function LotNo({ lot }: { lot: Pick<ProdLot, 'lotNo' | 'isOpening'> }) {
  const { t } = useLanguage()
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{lot.lotNo || '—'}</span>
      {lot.isOpening && (
        <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('production.lots.opening')}</span>
      )}
    </span>
  )
}

/** Lot quarantine status pill: free green, hold amber, blocked red (semantic colors). */
export function LotHoldPill({ status, reason }: { status: LotHoldStatus; reason?: string }) {
  const { t } = useLanguage()
  return (
    <span
      title={reason || undefined}
      className={cn(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        status === 'blocked' ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
          : status === 'hold' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
            : 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400',
      )}
    >
      {t(`prodInventory.hold.${status}`)}
    </span>
  )
}

const thSm = 'px-3 py-2 text-left font-medium whitespace-nowrap'
const thSmRight = 'px-3 py-2 text-right font-medium whitespace-nowrap'
const tdSm = 'px-3 py-2'

/**
 * Trigger + dialog. Renders nothing when lots are not available (null), so
 * forms keep working unchanged until the lots migration is applied.
 * `picks` null = automatic FEFO.
 */
export function LotPicker({ lots, qty, unit, picks, onChange, disabled, mode = 'strict', warnDays }: {
  lots: ProdLot[] | null
  /** Required line quantity in the item's base unit. */
  qty: number
  unit: ProdUnit
  picks: LotPick[] | null
  onChange: (picks: LotPick[] | null) => void
  disabled?: boolean
  /**
   * Held / blocked lots: 'strict' (production, processing, separation) shows
   * them greyed and not pickable; 'pick' (transfer) and 'any' (write-off)
   * allow picking them. FEFO preview follows prod_consume (see allocateFefo).
   */
  mode?: LotHoldMode
  /** The item's expiry warning window (days). */
  warnDays?: number
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Map<string, string>>(new Map())
  // Controls (migration 20261110000017): manual picks of expired lots (except
  // write-off / stock count, mode 'any') and picks by a role outside
  // manual_lot_pick_roles need owner / admin approval when saving.
  const controls = useControls()
  const role = useRole()

  if (!lots) return null

  const required = round3(qty)
  const hasPicks = !!picks && picks.length > 0
  const unitLabel = t(unitKey(unit))
  const today = localYmd()
  const roleMayPick = !controls.available || !role || (controls.settings.manualLotPickRoles as string[]).includes(role)

  function openDialog() {
    setDraft(new Map((picks ?? []).map(p => [p.lotId, String(p.qty)])))
    setOpen(true)
  }

  const draftPicks: LotPick[] = [...draft]
    .map(([lotId, v]) => ({ lotId, qty: round3(parseDecimal(v)) }))
    .filter(p => p.qty > 0)
  const fifo = allocateFefo(lots, required, mode)
  const hasHeld = lots.some(l => !isLotFree(l))
  const fifoTake = new Map(fifo.takes.map(x => [x.lot.id, x.qty]))
  const picked = allocatePicks(lots, draftPicks, required)
  const pickedSum = round3(draftPicks.reduce((s, p) => s + p.qty, 0))
  const canConfirm = picksValid(lots, draftPicks, required, mode)
  const pickedExpired = controls.available && mode !== 'any'
    && draftPicks.some(p => { const l = lots.find(x => x.id === p.lotId); return !!l?.expiryDate && l.expiryDate < today })

  function setDraftQty(lotId: string, v: string) {
    setDraft(prev => {
      const next = new Map(prev)
      if (v.trim() === '') next.delete(lotId)
      else next.set(lotId, v)
      return next
    })
  }

  /** Fills one lot with what is still missing (capped by its remaining qty). */
  function fillLot(lot: ProdLot) {
    const others = round3(draftPicks.filter(p => p.lotId !== lot.id).reduce((s, p) => s + p.qty, 0))
    const q = round3(Math.min(lot.remainingQty, Math.max(0, required - others)))
    setDraftQty(lot.id, q > 0 ? String(q) : '')
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={disabled || !(required > 0) || lots.length === 0}
        title={lots.length === 0 ? t('production.lots.noLots') : t('production.lots.pickTitle')}
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          hasPicks
            ? 'bg-white dark:bg-gray-900 shadow-sm border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
            : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
        )}
      >
        <Layers className="h-3 w-3" />
        {hasPicks ? `${picks!.length} ${t('production.lots.lotsShort')}` : t('production.lots.auto')}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t('production.lots.pickTitle')}</DialogTitle>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">{t('production.lots.pickHint')}</p>
            {hasHeld && (
              <p className="text-[12px] text-amber-700 dark:text-amber-400">
                {mode === 'strict' ? t('prodInventory.hold.notPickable') : t('prodInventory.hold.fefoHint')}
              </p>
            )}
            {!roleMayPick && <p className="text-[12px] text-amber-700 dark:text-amber-400">{t('prodControls.hints.manualPickRole')}</p>}
            {pickedExpired && <p className="text-[12px] text-amber-700 dark:text-amber-400">{t('prodControls.hints.expiredPick')}</p>}
          </DialogHeader>

          <div className="max-h-[55vh] overflow-auto rounded-xl border border-gray-100 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                  <th className={thSm}>{t('production.lots.lotNo')}</th>
                  <th className={thSm}>{t('production.lots.received')}</th>
                  <th className={thSm}>{t('production.lots.supplier')}</th>
                  <th className={thSmRight}>{t('production.lots.remaining')}</th>
                  <th className={thSmRight}>{t('production.lots.unitCost')}</th>
                  <th className={thSmRight}>{t('production.lots.fat')}</th>
                  <th className={thSm}>{t('production.lots.expiry')}</th>
                  {hasHeld && <th className={thSm}>{t('prodInventory.hold.status')}</th>}
                  <th className={thSmRight}>{t('production.lots.fifoTake')}</th>
                  <th className={cn(thSmRight, 'w-36')}>{t('production.lots.take')}</th>
                </tr>
              </thead>
              <tbody>
                {lots.map(lot => {
                  const v = draft.get(lot.id) ?? ''
                  const q = round3(parseDecimal(v))
                  const over = q > lot.remainingQty
                  const fq = fifoTake.get(lot.id)
                  const pickable = lotPickable(lot, mode)
                  return (
                    <tr key={lot.id} className={cn('border-b border-gray-50 dark:border-gray-800/60 last:border-0', !pickable && 'opacity-50')}>
                      <td className={tdSm}><LotNo lot={lot} /></td>
                      <td className={cn(tdSm, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(lot.receivedAt)}</td>
                      <td className={cn(tdSm, 'text-gray-700 dark:text-gray-300')}>{lot.supplierName || '—'}</td>
                      <td className={cn(tdSm, 'text-right')}>
                        <button
                          type="button"
                          onClick={() => fillLot(lot)}
                          disabled={!pickable}
                          title={pickable ? t('production.lots.fillHint') : t('prodInventory.hold.notPickable')}
                          className="tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                        >
                          {formatQty(lot.remainingQty)} {unitLabel}
                        </button>
                      </td>
                      <td className={cn(tdSm, 'text-right tabular-nums whitespace-nowrap text-gray-700 dark:text-gray-300')}>{formatPrice(lot.unitCost)}</td>
                      <td className={cn(tdSm, 'text-right tabular-nums whitespace-nowrap text-gray-500 dark:text-gray-400')}>{lot.fatPct === null ? '—' : formatPct(lot.fatPct)}</td>
                      <td className={tdSm}><LotExpiry date={lot.expiryDate} today={today} warnDays={warnDays} /></td>
                      {hasHeld && <td className={tdSm}><LotHoldPill status={lot.holdStatus} reason={lot.holdReason} /></td>}
                      <td className={cn(tdSm, 'text-right tabular-nums whitespace-nowrap text-gray-400 dark:text-gray-500')}>{fq ? formatQty(fq) : '—'}</td>
                      <td className={tdSm}>
                        <input
                          inputMode="decimal"
                          value={v}
                          disabled={!pickable && !v}
                          onChange={e => setDraftQty(lot.id, e.target.value)}
                          onFocus={e => e.target.select()}
                          placeholder="0"
                          className={cn(prodFieldCls, 'h-8 text-right tabular-nums', over && 'border-red-300 dark:border-red-800')}
                        />
                        {over && <p className="mt-0.5 text-right text-[11px] text-red-600 dark:text-red-400">{t('production.lots.overLot')}</p>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-1.5 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-gray-500 dark:text-gray-400">{t('production.lots.required')}</span>
                <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">{formatQty(required)} {unitLabel}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-500 dark:text-gray-400">{t('production.lots.picked')}</span>
                <span className={cn(
                  'tabular-nums font-semibold',
                  draftPicks.length === 0 ? 'text-gray-400 dark:text-gray-500'
                    : canConfirm ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
                )}>
                  {formatQty(pickedSum)} / {formatQty(required)} {unitLabel}
                </span>
              </div>
              {draftPicks.length > 0 && (
                <div className="flex justify-between gap-4">
                  <span className="text-gray-500 dark:text-gray-400">{t('production.lots.pickedCost')}</span>
                  <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">{formatPrice(picked.cost)}</span>
                </div>
              )}
              {draftPicks.length > 0 && !canConfirm && (
                <p className="text-[12px] text-red-600 dark:text-red-400">{t('production.lots.mismatch')}</p>
              )}
            </div>
            <div className="rounded-xl border border-gray-100 dark:border-gray-800 p-3 space-y-1.5 text-sm">
              <p className="text-[12px] font-medium text-gray-700 dark:text-gray-300">{t('production.lots.fifoPreview')}</p>
              {fifo.takes.length === 0 ? (
                <p className="text-[12px] text-gray-400 dark:text-gray-500">—</p>
              ) : fifo.takes.map(x => (
                <div key={x.lot.id} className="flex justify-between gap-4 text-[12px]">
                  <span className="text-gray-500 dark:text-gray-400 tabular-nums">{x.lot.lotNo} · {formatQty(x.qty)} {unitLabel} × {formatPrice(x.lot.unitCost)}</span>
                  <span className="tabular-nums text-gray-700 dark:text-gray-300">{formatPrice(x.cost)}</span>
                </div>
              ))}
              <div className="flex justify-between gap-4 border-t border-gray-100 dark:border-gray-800 pt-1.5">
                <span className="text-gray-500 dark:text-gray-400">{t('production.lots.fifoCost')}</span>
                <span className="tabular-nums font-semibold text-gray-900 dark:text-gray-100">{formatPrice(fifo.cost)}</span>
              </div>
              {fifo.short > 0 && (
                <p className="text-[12px] text-red-600 dark:text-red-400">{t('production.lots.shortage')}: {formatQty(fifo.short)} {unitLabel}</p>
              )}
            </div>
          </div>

          <DialogFooter className="mt-2 sm:justify-between">
            <Button variant="outline" onClick={() => { onChange(null); setOpen(false) }}>{t('production.lots.autoButton')}</Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => setOpen(false)}>{t('production.common.cancel')}</Button>
              <Button disabled={!canConfirm} onClick={() => { onChange(draftPicks); setOpen(false) }}>{t('production.lots.confirm')}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
