'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Plus, Edit2, Trash2, AlertTriangle, Layers, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { ProductGroup } from '@/lib/types'
import { type SizeType } from '@/lib/sizes'

const emptyForm = { name: '', description: '', status: 'active' as ProductGroup['status'], sizeType: 'clothing' as SizeType }

interface ProductGroupRow {
  id: string
  name: string
  description: string | null
  status: 'active' | 'inactive'
  size_type: string | null
}

export default function MahsulotGuruhlariPage() {
  const { t } = useLanguage()
  const [groups, setGroups] = useState<ProductGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editGroup, setEditGroup] = useState<ProductGroup | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteTarget, setDeleteTarget] = useState<ProductGroup | null>(null)

  const fetchGroups = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data: groupRows, error } = await supabase.from('product_groups').select('*').order('name')
    if (error) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }
    const { data: productRows, error: productsError } = await supabase.from('products').select('category')
    if (productsError) {
      toast.error(t('common.error'))
      setLoading(false)
      return
    }
    const counts = new Map<string, number>()
    for (const p of productRows as { category: string | null }[]) {
      if (!p.category) continue
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1)
    }
    setGroups((groupRows as ProductGroupRow[]).map(row => ({
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      productsCount: counts.get(row.name) ?? 0,
      status: row.status,
      sizeType: (row.size_type as SizeType) ?? 'clothing',
    })))
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchGroups()
  }, [fetchGroups])

  const stats = useMemo(() => ({
    total: groups.length,
    active: groups.filter(g => g.status === 'active').length,
    totalProducts: groups.reduce((sum, g) => sum + g.productsCount, 0),
  }), [groups])

  function openAdd() {
    setEditGroup(null)
    setForm(emptyForm)
    setIsFormOpen(true)
  }

  function openEdit(g: ProductGroup) {
    setEditGroup(g)
    setForm({ name: g.name, description: g.description, status: g.status, sizeType: g.sizeType })
    setIsFormOpen(true)
  }

  async function saveGroup() {
    if (!form.name.trim()) {
      toast.error(t('productGroups.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      status: form.status,
      size_type: form.sizeType,
    }
    if (editGroup) {
      const { error } = await supabase.rpc('update_product_group', { p_id: editGroup.id, p_data: payload })
      setSaving(false)
      if (error) {
        toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
        return
      }
      toast.success(t('productGroups.toasts.updateSuccess'))
    } else {
      const { error } = await supabase.rpc('create_product_group', { p_data: payload })
      setSaving(false)
      if (error) {
        toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
        return
      }
      toast.success(t('productGroups.toasts.addSuccess'))
    }
    setIsFormOpen(false)
    fetchGroups()
  }

  async function toggleStatus(g: ProductGroup) {
    const supabase = createClient()
    const newStatus = g.status === 'active' ? 'inactive' : 'active'
    const { error } = await supabase.rpc('update_product_group', { p_id: g.id, p_data: { status: newStatus } })
    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    fetchGroups()
  }

  function confirmDelete(g: ProductGroup) {
    setDeleteTarget(g)
  }

  async function executeDelete() {
    if (!deleteTarget) return
    const supabase = createClient()
    const { error } = await supabase.rpc('delete_product_group', { p_id: deleteTarget.id })
    if (error) {
      toast.error(error.message.includes('forbidden') ? t('common.forbidden') : t('common.error'))
      return
    }
    toast.success(t('productGroups.toasts.deleteSuccess'))
    setDeleteTarget(null)
    fetchGroups()
  }

  const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('productGroups.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('productGroups.subtitle')}</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('productGroups.addNew')}
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5 transition-colors">
          <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('productGroups.stats.total')}</p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{stats.total}</p>
        </div>
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5 transition-colors">
          <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('productGroups.stats.active')}</p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{stats.active}</p>
        </div>
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-5 transition-colors">
          <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('productGroups.stats.totalProducts')}</p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{stats.totalProducts}</p>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t('productGroups.table.number')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('productGroups.table.name')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">{t('productGroups.table.description')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('productGroups.table.productsCount')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('productGroups.table.status')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('productGroups.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Loader2 className="h-5 w-5 animate-spin text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</p>
                  </td>
                </tr>
              ) : groups.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Layers className="h-8 w-8 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 dark:text-gray-500">{t('productGroups.notFound')}</p>
                  </td>
                </tr>
              ) : (
                groups.map((g, i) => (
                  <tr
                    key={g.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{g.name}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell max-w-xs truncate">{g.description || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-[12px] font-medium text-gray-700 dark:text-gray-300">
                        {g.productsCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => toggleStatus(g)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                          g.status === 'active' ? 'bg-gray-900 dark:bg-gray-100' : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                        aria-label="toggle status"
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white dark:bg-gray-900 transition-transform ${
                            g.status === 'active' ? 'translate-x-4' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => openEdit(g)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => confirmDelete(g)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Modal */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editGroup ? t('productGroups.modal.editTitle') : t('productGroups.modal.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('productGroups.modal.name')}</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className={inputCls}
                placeholder={t('productGroups.modal.namePlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('productGroups.modal.description')}</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
                placeholder={t('productGroups.modal.descriptionPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('productGroups.modal.statusLabel')}</label>
              <div className="flex gap-2">
                {(['active', 'inactive'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, status: s }))}
                    className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${
                      form.status === s
                        ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    {s === 'active' ? t('status.active') : t('status.inactive')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">O&apos;lcham turi</label>
              <div className="flex gap-2">
                {([['clothing', "Kiyim (XS–XXL)"], ['shoe', "Poyabzal (36–45)"], ['universal', "Universal"]] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, sizeType: val }))}
                    className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${
                      form.sizeType === val
                        ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveGroup} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editGroup ? t('common.edit') : t('common.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              {t('productGroups.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('productGroups.deleteConfirm')}</p>
            {deleteTarget && deleteTarget.productsCount > 0 && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3">
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  <span className="font-semibold">{deleteTarget.productsCount}</span> {t('productGroups.deleteWarning')}
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              onClick={executeDelete}
              disabled={!!deleteTarget && deleteTarget.productsCount > 0}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
