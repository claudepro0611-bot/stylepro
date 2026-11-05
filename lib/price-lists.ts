export type PriceListBase = 'selling' | 'purchase'

export interface PriceList {
  id: string
  name: string
  base: PriceListBase
  adjustPercent: number
  rounding: number
  isActive: boolean
}

export interface PriceListRow {
  id: string
  name: string
  base: string
  adjust_percent: number
  rounding: number
  is_active: boolean
}

export function mapPriceList(r: PriceListRow): PriceList {
  return {
    id: r.id,
    name: r.name,
    base: r.base === 'purchase' ? 'purchase' : 'selling',
    adjustPercent: Number(r.adjust_percent) || 0,
    rounding: Number(r.rounding) || 0,
    isActive: r.is_active,
  }
}

export const ROUNDING_OPTIONS = [0, 100, 500, 1000] as const

/**
 * Client mirror of public.price_list_price(): a manual override wins,
 * otherwise base (retail or cost) adjusted by the percent and rounded.
 * The server recomputes this at sale time — this is for display only.
 */
export function computeListPrice(
  pl: Pick<PriceList, 'base' | 'adjustPercent' | 'rounding'>,
  retailPrice: number,
  purchasePrice: number,
  override?: number | null,
): number {
  if (override !== undefined && override !== null) return override
  const base = pl.base === 'purchase' ? purchasePrice : retailPrice
  let price = base * (1 + pl.adjustPercent / 100)
  if (pl.rounding > 0) price = Math.round(price / pl.rounding) * pl.rounding
  return Math.max(0, Math.round(price * 100) / 100)
}
