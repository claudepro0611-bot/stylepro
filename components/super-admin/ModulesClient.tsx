'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Package, Edit2, Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  createFeatureDefinition, updateFeatureDefinition, deleteFeatureDefinition,
  type FeatureDefinitionRow,
} from '@/app/(dashboard)/super-admin/actions'

const fieldCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

const emptyAddForm = { key: '', name: '', description: '', price: '' }

interface EditForm {
  name: string
  description: string
  price: string
  isCore: boolean
}

function emptyEditForm(m: FeatureDefinitionRow): EditForm {
  return { name: m.name, description: m.description ?? '', price: String(m.priceUsd), isCore: m.isCore }
}

interface ModulesClientProps {
  modules: FeatureDefinitionRow[]
}

export function ModulesClient({ modules }: ModulesClientProps) {
  const router = useRouter()
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [addForm, setAddForm] = useState(emptyAddForm)
  const [saving, setSaving] = useState(false)

  const [editTarget, setEditTarget] = useState<FeatureDefinitionRow | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<FeatureDefinitionRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  function refresh() {
    router.refresh()
  }

  function openEdit(m: FeatureDefinitionRow) {
    setEditTarget(m)
    setEditForm(emptyEditForm(m))
  }

  async function handleAdd() {
    const price = Number(addForm.price)
    if (Number.isNaN(price)) {
      toast.error("Narx to'g'ri kiritilmagan")
      return
    }
    setSaving(true)
    const result = await createFeatureDefinition({
      key: addForm.key,
      name: addForm.name,
      description: addForm.description,
      priceUsd: price,
    })
    setSaving(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }
    toast.success("Modul qo'shildi")
    setIsAddOpen(false)
    setAddForm(emptyAddForm)
    refresh()
  }

  async function handleEditSave() {
    if (!editTarget || !editForm) return
    const price = Number(editForm.price)
    if (Number.isNaN(price)) {
      toast.error("Narx to'g'ri kiritilmagan")
      return
    }
    setSaving(true)
    const result = await updateFeatureDefinition(editTarget.key, {
      name: editForm.name,
      description: editForm.description,
      priceUsd: price,
      isCore: editForm.isCore,
    })
    setSaving(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }
    toast.success('Modul yangilandi')
    setEditTarget(null)
    setEditForm(null)
    refresh()
  }

  async function executeDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    const result = await deleteFeatureDefinition(deleteTarget.key)
    setDeleting(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }
    toast.success("Modul o'chirildi")
    setDeleteTarget(null)
    refresh()
  }

  return (
    <div className="space-y-6 max-w-screen-xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Modullar</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Tizimdagi barcha modullar va narxlar</p>
        </div>
        <button
          onClick={() => { setAddForm(emptyAddForm); setIsAddOpen(true) }}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-3.5 py-2 text-[13px] font-medium text-white transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Yangi modul
        </button>
      </div>

      {modules.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm py-16 text-center transition-colors">
          <Package className="h-8 w-8 text-gray-300 dark:text-gray-600 mb-2" />
          <p className="text-sm text-gray-400 dark:text-gray-500">Modullar topilmadi</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {modules.map(m => (
            <div
              key={m.key}
              className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 shadow-sm hover:shadow-md transition-all duration-200 p-4 flex flex-col"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800">
                  <Package className="h-4 w-4 text-gray-400 dark:text-gray-500" />
                </div>
                {m.isCore ? (
                  <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                    Asosiy
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-md bg-indigo-50 dark:bg-indigo-500/10 px-1.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 shrink-0">
                    ${m.priceUsd}/oy
                  </span>
                )}
              </div>

              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{m.name}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 font-mono">{m.key}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 flex-1">
                {m.description || '—'}
              </p>

              <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {m.companiesUsing} ta firmada
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEdit(m)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(m)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add module modal */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Yangi modul</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Kalit (key)</label>
              <input
                value={addForm.key}
                onChange={e => setAddForm(f => ({ ...f, key: e.target.value }))}
                placeholder="masalan: loyalty_program"
                className={`${fieldCls} font-mono`}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Nomi</label>
              <input
                value={addForm.name}
                onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Tavsif</label>
              <textarea
                value={addForm.description}
                onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                className={`${fieldCls} h-auto py-2 resize-none`}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Narx (USD/oy)</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={addForm.price}
                onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))}
                className={fieldCls}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>Bekor qilish</Button>
            <Button onClick={handleAdd} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Qo'shish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit module modal */}
      <Dialog open={!!editTarget} onOpenChange={open => { if (!open) { setEditTarget(null); setEditForm(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Modulni tahrirlash {editTarget && `— ${editTarget.key}`}</DialogTitle>
          </DialogHeader>
          {editForm && (
            <div className="space-y-3 mt-2">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Nomi</label>
                <input
                  value={editForm.name}
                  onChange={e => setEditForm(f => f && ({ ...f, name: e.target.value }))}
                  className={fieldCls}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Tavsif</label>
                <textarea
                  value={editForm.description}
                  onChange={e => setEditForm(f => f && ({ ...f, description: e.target.value }))}
                  rows={2}
                  className={`${fieldCls} h-auto py-2 resize-none`}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Narx (USD/oy)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={editForm.price}
                  onChange={e => setEditForm(f => f && ({ ...f, price: e.target.value }))}
                  className={fieldCls}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5">
                <span className="text-[13px] font-medium text-gray-700 dark:text-gray-300">Asosiy (har doim yoqilgan)</span>
                <Switch
                  checked={editForm.isCore}
                  onCheckedChange={next => setEditForm(f => f && ({ ...f, isCore: next }))}
                />
              </div>
            </div>
          )}
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => { setEditTarget(null); setEditForm(null) }}>Bekor qilish</Button>
            <Button onClick={handleEditSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Saqlash'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Modulni o&apos;chirish
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium text-gray-900 dark:text-gray-100">{deleteTarget?.name}</span> modulini o&apos;chirishni tasdiqlaysizmi? Bu amalni orqaga qaytarib bo&apos;lmaydi.
            </p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Bekor qilish</Button>
            <Button variant="destructive" onClick={executeDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "O'chirish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
