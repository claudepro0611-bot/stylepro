'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/Pagination'
import { SearchSelect } from '@/components/ui/SearchSelect'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { formatDate } from '@/lib/utils/formatters'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { useFeatures } from '@/lib/features'

const ITEMS_PER_PAGE = 10
type Period = 'today' | 'week' | 'month' | 'year'
type PaymentMethod = 'cash' | 'card' | 'transfer'

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Naqd',
  card: 'Karta',
  transfer: "O'tkazma",
}

const PERIODS: [Period, string][] = [
  ['today', 'Bugun'],
  ['week', 'Bu hafta'],
  ['month', 'Bu oy'],
  ['year', 'Bu yil'],
]

const COLOR_PRESETS = [
  '#6366f1', '#22c55e', '#f59e0b', '#3b82f6', '#ec4899',
  '#f97316', '#ef4444', '#8b5cf6', '#14b8a6', '#64748b',
]

interface ExpenseCategory {
  id: string
  name: string
  color: string
}

interface Expense {
  id: string
  categoryId: string | null
  categoryName: string
  categoryColor: string
  amount: number
  paymentMethod: PaymentMethod
  date: string
  note: string
}

const emptyExpenseForm = {
  categoryId: '',
  amount: '',
  paymentMethod: 'cash' as PaymentMethod,
  date: new Date().toISOString().slice(0, 10),
  note: '',
}

const fieldCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

export default function XarajatlarPage() {
  const { formatPrice } = useCurrency()
  const router = useRouter()
  const { features, loading: featuresLoading } = useFeatures()

  useEffect(() => {
    if (!featuresLoading && !features.expenses) router.push('/dashboard')
  }, [featuresLoading, features, router])

  const [tab, setTab] = useState<'xarajatlar' | 'kategoriyalar'>('xarajatlar')
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [page, setPage] = useState(1)

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(emptyExpenseForm)

  const [isCategoryOpen, setIsCategoryOpen] = useState(false)
  const [savingCategory, setSavingCategory] = useState(false)
  const [categoryForm, setCategoryForm] = useState({ name: '', color: COLOR_PRESETS[0] })

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data: catRows, error: catError }, { data: expRows, error: expError }] = await Promise.all([
      supabase.from('expense_categories').select('id, name, color').order('name'),
      supabase
        .from('expenses')
        .select('id, category_id, amount, payment_method, date, note, expense_categories(name, color)')
        .order('date', { ascending: false }),
    ])

    if (catError || expError) {
      toast.error('Xatolik yuz berdi')
      setLoading(false)
      return
    }

    setCategories((catRows ?? []).map(c => ({ id: c.id, name: c.name, color: c.color ?? '#6366f1' })))
    setExpenses((expRows ?? []).map(e => {
      const cat = e.expense_categories as { name: string; color: string | null } | null
      return {
        id: e.id,
        categoryId: e.category_id,
        categoryName: cat?.name ?? "Noma'lum",
        categoryColor: cat?.color ?? '#9ca3af',
        amount: Number(e.amount),
        paymentMethod: e.payment_method as PaymentMethod,
        date: e.date,
        note: e.note ?? '',
      }
    }))
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const filtered = useMemo(() => {
    const now = new Date()
    return expenses.filter(e => {
      const d = new Date(e.date)
      if (period === 'today') return d.toDateString() === now.toDateString()
      if (period === 'week') {
        const diff = (now.getTime() - d.getTime()) / 86400000
        return diff >= 0 && diff < 7
      }
      if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      return d.getFullYear() === now.getFullYear()
    })
  }, [expenses, period])

  const total = useMemo(() => filtered.reduce((s, e) => s + e.amount, 0), [filtered])

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE)
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  // All-time count, not period-filtered — a category can only be deleted
  // once it has zero expenses ever recorded against it.
  const categoryExpenseCounts = useMemo(() => {
    const map = new Map<string, number>()
    expenses.forEach(e => { if (e.categoryId) map.set(e.categoryId, (map.get(e.categoryId) ?? 0) + 1) })
    return map
  }, [expenses])

  const categoryOptions = useMemo(
    () => categories.map(c => ({ value: c.id, label: c.name })),
    [categories],
  )

  function openAddExpense() {
    setForm({ ...emptyExpenseForm, categoryId: categories[0]?.id ?? '' })
    setIsAddOpen(true)
  }

  async function saveExpense() {
    if (!form.categoryId || !form.amount) {
      toast.error("Barcha maydonlarni to'ldiring")
      return
    }
    setSaving(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setSaving(false); toast.error('Xatolik yuz berdi'); return }

    const { data: { user } } = await supabase.auth.getUser()

    const { error } = await supabase.from('expenses').insert({
      company_id: companyId,
      category_id: form.categoryId,
      amount: Number(form.amount),
      payment_method: form.paymentMethod,
      date: form.date,
      note: form.note.trim() || null,
      created_by: user?.id ?? null,
    })

    setSaving(false)
    if (error) {
      toast.error('Xatolik yuz berdi')
      return
    }
    setIsAddOpen(false)
    toast.success("Xarajat qo'shildi")
    fetchData()
  }

  async function deleteExpense(id: string) {
    if (!window.confirm("Xarajatni o'chirishni tasdiqlaysizmi?")) return
    const supabase = createClient()
    const { error } = await supabase.from('expenses').delete().eq('id', id)
    if (error) {
      toast.error('Xatolik yuz berdi')
      return
    }
    toast.success("Xarajat o'chirildi")
    fetchData()
  }

  function openAddCategory() {
    setCategoryForm({ name: '', color: COLOR_PRESETS[0] })
    setIsCategoryOpen(true)
  }

  async function saveCategory() {
    if (!categoryForm.name.trim()) {
      toast.error('Kategoriya nomini kiriting')
      return
    }
    setSavingCategory(true)
    const supabase = createClient()
    const companyId = await getCompanyId(supabase)
    if (!companyId) { setSavingCategory(false); toast.error('Xatolik yuz berdi'); return }

    const { error } = await supabase.from('expense_categories').insert({
      company_id: companyId,
      name: categoryForm.name.trim(),
      color: categoryForm.color,
    })

    setSavingCategory(false)
    if (error) {
      toast.error(error.code === '23505' ? 'Bu nomdagi kategoriya allaqachon mavjud' : 'Xatolik yuz berdi')
      return
    }
    setIsCategoryOpen(false)
    toast.success("Kategoriya qo'shildi")
    fetchData()
  }

  async function deleteCategory(cat: ExpenseCategory) {
    if ((categoryExpenseCounts.get(cat.id) ?? 0) > 0) return
    if (!window.confirm(`"${cat.name}" kategoriyasini o'chirishni tasdiqlaysizmi?`)) return
    const supabase = createClient()
    const { error } = await supabase.from('expense_categories').delete().eq('id', cat.id)
    if (error) {
      toast.error("Bu kategoriyada xarajatlar mavjud, o'chirib bo'lmaydi")
      return
    }
    toast.success("Kategoriya o'chirildi")
    fetchData()
  }

  if (featuresLoading || !features.expenses) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Xarajatlar</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Do&apos;kon xarajatlarini kuzating</p>
        </div>
        <button
          onClick={tab === 'xarajatlar' ? openAddExpense : openAddCategory}
          className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {tab === 'xarajatlar' ? "Xarajat qo'shish" : 'Kategoriya qo\'shish'}
        </button>
      </div>

      {/* Xarajatlar / Kategoriyalar tabs — same style as inventory's warehouse tabs */}
      <div className="flex gap-2 mb-6">
        {([['xarajatlar', 'Xarajatlar'], ['kategoriyalar', 'Kategoriyalar']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
              tab === key
                ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'xarajatlar' ? (
        <>
          <div className="inline-flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 mb-6">
            {PERIODS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => { setPeriod(key); setPage(1) }}
                className={cn(
                  'px-4 py-1.5 rounded-md text-sm font-medium transition-all',
                  period === key
                    ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
            <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Xarajatlar ro&apos;yxati</h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-sm text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                    <th className="px-6 py-3 font-medium">Sana</th>
                    <th className="px-6 py-3 font-medium">Kategoriya</th>
                    <th className="px-6 py-3 font-medium hidden md:table-cell">Izoh</th>
                    <th className="px-6 py-3 font-medium">To&apos;lov turi</th>
                    <th className="px-6 py-3 font-medium text-right">Summa</th>
                    <th className="px-6 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                        <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                        Yuklanmoqda...
                      </td>
                    </tr>
                  ) : paginated.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                        Xarajatlar topilmadi
                      </td>
                    </tr>
                  ) : (
                    paginated.map(e => (
                      <tr
                        key={e.id}
                        className="border-b border-gray-50 dark:border-gray-800/60 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                      >
                        <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">{formatDate(e.date)}</td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.categoryColor }} />
                            <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{e.categoryName}</span>
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell max-w-xs truncate">{e.note || '—'}</td>
                        <td className="px-6 py-4">
                          <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-2 py-0.5 rounded-full">
                            {PAYMENT_LABELS[e.paymentMethod]}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right text-sm font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                          {formatPrice(e.amount)}
                        </td>
                        <td className="px-6 py-4">
                          <button
                            onClick={() => deleteExpense(e.id)}
                            className="text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Jami</span>
              <span className="text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatPrice(total)}</span>
            </div>

            {totalPages > 1 && (
              <div className="px-6 pb-4">
                <Pagination
                  currentPage={page}
                  totalPages={totalPages}
                  totalItems={filtered.length}
                  itemsPerPage={ITEMS_PER_PAGE}
                  onPageChange={setPage}
                />
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
          <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Kategoriyalar</h2>
          </div>
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">
              <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
              Yuklanmoqda...
            </div>
          ) : categories.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">Kategoriyalar topilmadi</div>
          ) : (
            <div className="divide-y divide-gray-50 dark:divide-gray-800/60">
              {categories.map(cat => {
                const count = categoryExpenseCounts.get(cat.id) ?? 0
                return (
                  <div key={cat.id} className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: cat.color }} />
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{cat.name}</span>
                    </span>
                    {count === 0 ? (
                      <button
                        onClick={() => deleteCategory(cat)}
                        className="text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    ) : (
                      <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded-full">{count} ta xarajat</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Add Expense Modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Xarajat qo&apos;shish</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Kategoriya</label>
              <SearchSelect
                options={categoryOptions}
                value={form.categoryId}
                onChange={v => setForm(f => ({ ...f, categoryId: v }))}
                placeholder="Kategoriyani tanlang"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Summa</label>
              <input
                type="number"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">To&apos;lov turi</label>
              <div className="flex gap-2">
                {(['cash', 'card', 'transfer'] as PaymentMethod[]).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, paymentMethod: m }))}
                    className={cn(
                      'flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      form.paymentMethod === m
                        ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
                    )}
                  >
                    {PAYMENT_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Sana</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Izoh</label>
              <textarea
                value={form.note}
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
                placeholder="Ixtiyoriy"
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>Bekor qilish</Button>
            <Button onClick={saveExpense} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Saqlash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Category Modal */}
      <Dialog open={isCategoryOpen} onOpenChange={setIsCategoryOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Kategoriya qo&apos;shish</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Nomi</label>
              <input
                type="text"
                value={categoryForm.name}
                onChange={e => setCategoryForm(f => ({ ...f, name: e.target.value }))}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">Rang</label>
              <div className="flex flex-wrap gap-2">
                {COLOR_PRESETS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoryForm(f => ({ ...f, color: c }))}
                    className={cn(
                      'h-7 w-7 rounded-full transition-transform',
                      categoryForm.color === c && 'ring-2 ring-offset-2 ring-gray-900 dark:ring-gray-100 dark:ring-offset-gray-900 scale-110',
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsCategoryOpen(false)}>Bekor qilish</Button>
            <Button onClick={saveCategory} disabled={savingCategory}>
              {savingCategory ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Saqlash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
