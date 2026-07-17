export type SizeType = 'clothing' | 'shoe' | 'universal'

export const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL']
export const SHOE_SIZES = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']

const SIZE_ORDER = new Map<string, number>([
  ...CLOTHING_SIZES.map((s, i) => [s, i] as [string, number]),
  ...SHOE_SIZES.map((s, i) => [s, CLOTHING_SIZES.length + i] as [string, number]),
])

export function getSizesForType(sizeType: SizeType | null | undefined): string[] {
  if (sizeType === 'shoe') return SHOE_SIZES
  if (sizeType === 'universal') return [...CLOTHING_SIZES, ...SHOE_SIZES]
  return CLOTHING_SIZES
}

export function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ai = SIZE_ORDER.get(a) ?? (1000 + Number(a))
    const bi = SIZE_ORDER.get(b) ?? (1000 + Number(b))
    return ai - bi
  })
}
