// Generate EAN-13 barcode
export function generateEAN13(companyPrefix: string, productId: string, size: string): string {
  // Create base number from inputs (12 digits)
  const prefix = companyPrefix.slice(0, 3).padEnd(3, '0')
  const pid = productId.replace(/-/g, '').slice(0, 6).padEnd(6, '0')
  const sizeCode = size.replace(/[^0-9]/g, '').padStart(3, '0').slice(0, 3)
  const base = `${prefix}${pid}${sizeCode}`.replace(/[^0-9]/g, '0').slice(0, 12)

  // Calculate check digit
  const digits = base.split('').map(Number)
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0)
  const checkDigit = (10 - (sum % 10)) % 10

  return `${base}${checkDigit}`
}

// Generate unique barcode with timestamp fallback
export function generateUniqueBarcode(): string {
  const timestamp = Date.now().toString().slice(-12).padStart(12, '0')
  const digits = timestamp.split('').map(Number)
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0)
  const checkDigit = (10 - (sum % 10)) % 10
  return `${timestamp}${checkDigit}`
}
