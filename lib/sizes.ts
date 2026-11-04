export type SizeType = 'clothing' | 'shoe' | 'universal' | 'volume'

export const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL']
export const SHOE_SIZES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']
export const VOLUME_SIZES = ['5 ml', '10 ml', '15 ml', '20 ml', '30 ml', '50 ml', '100 ml']

const SIZE_ORDER = new Map<string, number>([
  ...CLOTHING_SIZES.map((s, i) => [s, i] as [string, number]),
  ...SHOE_SIZES.map((s, i) => [s, CLOTHING_SIZES.length + i] as [string, number]),
])

const VOLUME_RE = /^(\d+(?:[.,]\d+)?)\s*ml$/i

export function parseVolume(size: string): number | null {
  const m = VOLUME_RE.exec(size.trim())
  return m ? Number(m[1].replace(',', '.')) : null
}

export function formatVolume(ml: number): string {
  return `${ml} ml`
}

export function getSizesForType(sizeType: SizeType | null | undefined): string[] {
  if (sizeType === 'shoe') return SHOE_SIZES
  if (sizeType === 'universal') return [...CLOTHING_SIZES, ...SHOE_SIZES]
  if (sizeType === 'volume') return VOLUME_SIZES
  return CLOTHING_SIZES
}

function sizeRank(s: string): number {
  const known = SIZE_ORDER.get(s)
  if (known !== undefined) return known
  const ml = parseVolume(s)
  if (ml !== null) return 1000 + ml
  return 1000 + Number(s)
}

export function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => sizeRank(a) - sizeRank(b))
}
