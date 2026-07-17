'use client'

import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { Download, Upload, FileSpreadsheet, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

const PREVIEW_LIMIT = 10
const BOLIM_TO_TYPE: Record<string, string> = { Kiyimlar: 'clothing', 'Oyoq kiyim': 'footwear' }

interface WarehouseRow { id: string; name: string; type: string }
interface ParsedRow {
  rowNumber: number
  name: string
  size: string
  color: string
  purchasePrice: number
  sellingPrice: number
  quantity: number
  bolim: string
  errors: string[]
}

function toNumber(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function validateRow(r: Record<string, unknown>, rowNumber: number, warehouses: WarehouseRow[]): ParsedRow {
  const name = String(r['Mahsulot nomi'] ?? '').trim()
  const size = String(r['Razmer'] ?? '').trim()
  const color = String(r['Rang'] ?? '').trim()
  const bolim = String(r['Bolim'] ?? '').trim()
  const purchasePrice = toNumber(r['Olish narxi'])
  const sellingPrice = toNumber(r['Sotuv narxi'])
  const quantity = toNumber(r['Miqdor'])

  const errors: string[] = []
  if (!name) errors.push('Mahsulot nomi kiritilmagan')
  if (!size) errors.push('Razmer kiritilmagan')
  if (purchasePrice === null || purchasePrice < 0) errors.push("Olish narxi noto'g'ri")
  if (sellingPrice === null || sellingPrice < 0) errors.push("Sotuv narxi noto'g'ri")
  if (quantity === null || quantity <= 0) errors.push("Miqdor noto'g'ri")
  if (bolim !== 'Kiyimlar' && bolim !== 'Oyoq kiyim') {
    errors.push("Bolim 'Kiyimlar' yoki 'Oyoq kiyim' bo'lishi kerak")
  } else if (!warehouses.some(w => w.type === BOLIM_TO_TYPE[bolim])) {
    errors.push(`${bolim} ombori topilmadi`)
  }

  return {
    rowNumber, name, size, color, bolim,
    purchasePrice: purchasePrice ?? 0,
    sellingPrice: sellingPrice ?? 0,
    quantity: quantity ?? 0,
    errors,
  }
}

interface ImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}

export function ImportModal({ open, onOpenChange, onImported }: ImportModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload')
  const [fileName, setFileName] = useState('')
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([])
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [summary, setSummary] = useState<{ success: number; failed: number } | null>(null)

  function reset() {
    setStep('upload')
    setFileName('')
    setParsedRows([])
    setSummary(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleClose(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleFile(file: File) {
    setParsing(true)
    setFileName(file.name)
    try {
      const supabase = createClient()
      const { data: whData } = await supabase.from('warehouses').select('id, name, type')
      const warehouses = (whData ?? []) as WarehouseRow[]

      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

      if (rows.length === 0) {
        toast.error('Fayl bo‘sh')
        setParsing(false)
        return
      }

      setParsedRows(rows.map((r, i) => validateRow(r, i + 2, warehouses)))
      setStep('preview')
    } catch {
      toast.error('Faylni o‘qib bo‘lmadi')
    }
    setParsing(false)
  }

  async function runImport() {
    setImporting(true)
    const supabase = createClient()

    const { data: whData } = await supabase.from('warehouses').select('id, name, type')
    const warehouses = (whData ?? []) as WarehouseRow[]

    const { data: groupData } = await supabase.from('product_groups').select('id, name, size_type')
    let groups = (groupData ?? []) as { id: string; name: string; size_type: string }[]

    async function ensureGroup(name: string, sizeType: string): Promise<string> {
      if (groups.some(g => g.name === name)) return name
      const { data, error } = await supabase.rpc('create_product_group', {
        p_data: { name, size_type: sizeType, status: 'active' },
      })
      if (!error && data) groups = [...groups, { id: data as string, name, size_type: sizeType }]
      return name
    }

    const { data: prodData } = await supabase.from('products').select('id, name, category')
    let productsList = (prodData ?? []) as { id: string; name: string; category: string | null }[]

    const validRows = parsedRows.filter(r => r.errors.length === 0)
    let successCount = 0
    let failCount = parsedRows.length - validRows.length

    for (const row of validRows) {
      const warehouse = warehouses.find(w => w.type === BOLIM_TO_TYPE[row.bolim])
      if (!warehouse) { failCount++; continue }

      let product = productsList.find(p => p.name.trim().toLowerCase() === row.name.toLowerCase())
      if (!product) {
        const groupName = row.bolim
        const sizeType = row.bolim === 'Kiyimlar' ? 'clothing' : 'shoe'
        const categoryName = await ensureGroup(groupName, sizeType)
        const { data: newProductId, error: prodErr } = await supabase.rpc('create_product', {
          p_data: {
            name: row.name,
            category: categoryName,
            price: row.sellingPrice,
            min_stock: 5,
            colors: row.color ? [row.color] : [],
            status: 'active',
            warehouse_id: warehouse.id,
          },
        })
        if (prodErr || !newProductId) { failCount++; continue }
        product = { id: newProductId as string, name: row.name, category: categoryName }
        productsList = [...productsList, product]
      }

      // stock_in creates-or-increments product_sizes atomically (no
      // client-side read of the current stock value) and writes the
      // matching stock_in_entries ledger row in the same transaction.
      const { error: sizeErr } = await supabase.rpc('stock_in', {
        p_entries: [{
          product_id: product.id,
          product_name: product.name,
          category: product.category,
          size: row.size,
          color: row.color || '',
          quantity: row.quantity,
          purchase_price: row.purchasePrice,
          selling_price: row.sellingPrice,
          warehouse_id: warehouse.id,
        }],
      })

      if (sizeErr) { failCount++; continue }
      successCount++
    }

    setImporting(false)
    setSummary({ success: successCount, failed: failCount })
    setStep('done')
    onImported()
  }

  const previewRows = parsedRows.slice(0, PREVIEW_LIMIT)
  const validCount = parsedRows.filter(r => r.errors.length === 0).length
  const invalidCount = parsedRows.length - validCount

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Excel orqali import qilish</DialogTitle>
        </DialogHeader>

        {step === 'upload' && (
          <div className="mt-2 space-y-4">
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                Avval shablonni yuklab oling, uni to&apos;ldiring va qayta yuklang.
              </p>
              <a
                href="/import-template.xlsx"
                download
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-2 text-[13px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Shablonni yuklab olish
              </a>
            </div>

            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={parsing}
                className="w-full flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700 py-10 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors disabled:opacity-50"
              >
                {parsing ? (
                  <Loader2 className="h-6 w-6 animate-spin" />
                ) : (
                  <Upload className="h-6 w-6" />
                )}
                <span className="text-sm font-medium">
                  {parsing ? 'Fayl o‘qilmoqda...' : "Excel faylni tanlash uchun bosing"}
                </span>
                {fileName && !parsing && <span className="text-[12px] text-gray-400 dark:text-gray-500">{fileName}</span>}
              </button>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <div className="mt-2 space-y-3">
            <div className="flex items-center gap-3 text-[13px]">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400 px-2.5 py-1 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {validCount} ta to&apos;g&apos;ri
              </span>
              {invalidCount > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400 px-2.5 py-1 font-medium">
                  <XCircle className="h-3.5 w-3.5" />
                  {invalidCount} ta xato
                </span>
              )}
              <span className="text-gray-400 dark:text-gray-500">Jami {parsedRows.length} qator</span>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="overflow-x-auto max-h-[50vh]">
                <table className="w-full text-[13px]">
                  <thead className="bg-gray-50 dark:bg-gray-800/50 sticky top-0">
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">#</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Nomi</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Razmer</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Rang</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Olish narxi</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Sotuv narxi</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500 dark:text-gray-400">Miqdor</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Bolim</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Holat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map(row => (
                      <tr
                        key={row.rowNumber}
                        className={row.errors.length === 0
                          ? 'bg-green-50/60 dark:bg-green-500/5 border-b border-gray-100 dark:border-gray-800'
                          : 'bg-red-50/60 dark:bg-red-500/5 border-b border-gray-100 dark:border-gray-800'}
                      >
                        <td className="px-3 py-2 text-gray-400 dark:text-gray-500">{row.rowNumber}</td>
                        <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{row.name || '—'}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.size || '—'}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.color || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{row.purchasePrice}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{row.sellingPrice}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{row.quantity}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.bolim || '—'}</td>
                        <td className="px-3 py-2">
                          {row.errors.length === 0 ? (
                            <span className="text-green-700 dark:text-green-400 font-medium">To&apos;g&apos;ri</span>
                          ) : (
                            <span className="text-red-700 dark:text-red-400">{row.errors.join(', ')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {parsedRows.length > PREVIEW_LIMIT && (
              <p className="text-[12px] text-gray-400 dark:text-gray-500">
                ... va yana {parsedRows.length - PREVIEW_LIMIT} ta qator
              </p>
            )}
          </div>
        )}

        {step === 'done' && summary && (
          <div className="mt-2 flex flex-col items-center gap-3 py-8 text-center">
            <FileSpreadsheet className="h-10 w-10 text-gray-400 dark:text-gray-500" />
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {summary.success} ta mahsulot muvaffaqiyatli qo&apos;shildi
            </p>
            {summary.failed > 0 && (
              <p className="text-sm text-red-600 dark:text-red-400">{summary.failed} ta qator xato</p>
            )}
          </div>
        )}

        <DialogFooter className="mt-4">
          {step === 'upload' && (
            <Button variant="outline" onClick={() => handleClose(false)}>Bekor qilish</Button>
          )}
          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={reset}>Orqaga</Button>
              <Button onClick={runImport} disabled={importing || validCount === 0}>
                {importing ? 'Import qilinmoqda...' : `Tasdiqlash (${validCount} ta)`}
              </Button>
            </>
          )}
          {step === 'done' && (
            <Button onClick={() => handleClose(false)}>Yopish</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
