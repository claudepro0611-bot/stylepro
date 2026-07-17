'use client'

import { useState, useCallback, useEffect } from 'react'
import { Plus, Edit2, Trash2, AlertTriangle, Gift, ShieldAlert, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { getCompanyId } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import type { RewardPenaltyTypeDef, RewardPenaltyKind } from '@/lib/types'

type Unit = 'UZS' | '%'
const emptyForm = { name: '', amount: '', unit: 'UZS' as Unit, description: '' }

interface RewardPenaltyTypeRow {
  id: string
  name: string
  amount: number
  kind: RewardPenaltyKind
  category: 'reward' | 'penalty'
  description: string | null
}

function mapType(row: RewardPenaltyTypeRow): RewardPenaltyTypeDef {
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    kind: row.kind,
    description: row.description ?? '',
  }
}

export default function MukofotJarimaTurlariPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [rewardTypes, setRewardTypes] = useState<RewardPenaltyTypeDef[]>([])
  const [penaltyTypes, setPenaltyTypes] = useState<RewardPenaltyTypeDef[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase.from('reward_penalty_types').select('*').order('created_at', { ascending: false })
    if (error) {
      toast.error(t('common.error'))
    } else {
      const rows = data as RewardPenaltyTypeRow[]
      setRewardTypes(rows.filter(r => r.category === 'reward').map(mapType))
      setPenaltyTypes(rows.filter(r => r.category === 'penalty').map(mapType))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const [formSection, setFormSection] = useState<'reward' | 'penalty'>('reward')
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editType, setEditType] = useState<RewardPenaltyTypeDef | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteTarget, setDeleteTarget] = useState<{ section: 'reward' | 'penalty'; item: RewardPenaltyTypeDef } | null>(null)

  const typeLabel: Record<RewardPenaltyKind, string> = {
    fixed: t('hr.turlari.typeLabel.fixed'),
    percent: t('hr.turlari.typeLabel.percent'),
    oneTime: t('hr.turlari.typeLabel.oneTime'),
    perOccurrence: t('hr.turlari.typeLabel.perOccurrence'),
    perDay: t('hr.turlari.typeLabel.perDay'),
  }

  function amountLabel(item: RewardPenaltyTypeDef) {
    return item.kind === 'percent' ? `${item.amount}%` : formatPrice(item.amount)
  }

  function openAdd(section: 'reward' | 'penalty') {
    setFormSection(section)
    setEditType(null)
    setForm(emptyForm)
    setIsFormOpen(true)
  }

  function openEdit(section: 'reward' | 'penalty', item: RewardPenaltyTypeDef) {
    setFormSection(section)
    setEditType(item)
    setForm({ name: item.name, amount: String(item.amount), unit: item.kind === 'percent' ? '%' : 'UZS', description: item.description })
    setIsFormOpen(true)
  }

  async function saveType() {
    if (!form.name.trim() || !form.amount) {
      toast.error(t('hr.turlari.toasts.requiredError'))
      return
    }
    setSaving(true)
    const supabase = createClient()
    const kind: RewardPenaltyKind = form.unit === '%' ? 'percent' : 'fixed'
    const payload = {
      name: form.name,
      amount: Number(form.amount),
      kind,
      category: formSection,
      description: form.description,
    }
    if (editType) {
      const { error } = await supabase.from('reward_penalty_types').update(payload).eq('id', editType.id)
      setSaving(false)
      if (error) {
        toast.error(t('common.error'))
        return
      }
      toast.success(t('hr.turlari.toasts.updateSuccess'))
    } else {
      const companyId = await getCompanyId(supabase)
      if (!companyId) { setSaving(false); toast.error(t('common.error')); return }
      const { error } = await supabase.from('reward_penalty_types').insert({ ...payload, company_id: companyId })
      setSaving(false)
      if (error) {
        toast.error(t('common.error'))
        return
      }
      toast.success(t('hr.turlari.toasts.addSuccess'))
    }
    setIsFormOpen(false)
    fetchData()
  }

  function confirmDelete(section: 'reward' | 'penalty', item: RewardPenaltyTypeDef) {
    setDeleteTarget({ section, item })
  }

  async function executeDelete() {
    if (!deleteTarget) return
    const supabase = createClient()
    const { error } = await supabase.from('reward_penalty_types').delete().eq('id', deleteTarget.item.id)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    toast.success(t('hr.turlari.toasts.deleteSuccess'))
    setDeleteTarget(null)
    fetchData()
  }

  const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  function renderTable(section: 'reward' | 'penalty', items: RewardPenaltyTypeDef[], colors: { border: string; bg: string; text: string; iconBg: string }) {
    const prefix = section === 'reward' ? 'hr.turlari.rewards' : 'hr.turlari.penalties' as const
    return (
      <div className={`rounded-lg border ${colors.border} bg-white dark:bg-gray-900 overflow-hidden transition-colors`}>
        <div className={`flex items-center justify-between px-4 py-3 ${colors.bg} border-b ${colors.border}`}>
          <h2 className={`text-sm font-semibold ${colors.text}`}>{t(`${prefix}.sectionTitle`)}</h2>
          <button
            onClick={() => openAdd(section)}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              section === 'reward'
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-red-600 text-white hover:bg-red-700'
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
            {t(`${prefix}.addNew`)}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 w-12">{t(`${prefix}.table.number`)}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t(`${prefix}.table.name`)}</th>
                <th className="px-4 py-3 text-right text-sm font-medium text-gray-500 dark:text-gray-400">{t(`${prefix}.table.amount`)}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t(`${prefix}.table.type`)}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">{t(`${prefix}.table.description`)}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t(`${prefix}.table.actions`)}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2 text-gray-400 dark:text-gray-500" />
                    <span className="text-sm text-gray-400 dark:text-gray-500">{t('common.loading')}</span>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <p className="text-sm text-gray-400 dark:text-gray-500">{t(`${prefix}.notFound`)}</p>
                  </td>
                </tr>
              ) : (
                items.map((item, i) => (
                  <tr
                    key={item.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/30' : ''}`}
                  >
                    <td className="px-4 py-3 text-[13px] text-gray-400 dark:text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{item.name}</td>
                    <td className="px-4 py-3 text-sm text-right font-medium tabular-nums text-gray-900 dark:text-gray-100">{amountLabel(item)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors.iconBg} ${colors.text}`}>
                        {typeLabel[item.kind]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell max-w-xs truncate">{item.description || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => openEdit(section, item)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => confirmDelete(section, item)}
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
    )
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('hr.turlari.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('hr.turlari.subtitle')}</p>
      </div>

      {renderTable('reward', rewardTypes, {
        border: 'border-green-200 dark:border-green-900',
        bg: 'bg-green-50 dark:bg-green-950/30',
        text: 'text-green-700 dark:text-green-400',
        iconBg: 'bg-green-100 dark:bg-green-900/40',
      })}

      {renderTable('penalty', penaltyTypes, {
        border: 'border-red-200 dark:border-red-900',
        bg: 'bg-red-50 dark:bg-red-950/30',
        text: 'text-red-700 dark:text-red-400',
        iconBg: 'bg-red-100 dark:bg-red-900/40',
      })}

      {/* Add / Edit Modal */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {formSection === 'reward' ? <Gift className="h-4 w-4 text-green-600" /> : <ShieldAlert className="h-4 w-4 text-red-600" />}
              {editType
                ? (formSection === 'reward' ? t('hr.turlari.rewards.modal.editTitle') : t('hr.turlari.penalties.modal.editTitle'))
                : (formSection === 'reward' ? t('hr.turlari.rewards.modal.addTitle') : t('hr.turlari.penalties.modal.addTitle'))}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.turlari.modal.name')}</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className={inputCls}
                placeholder={t('hr.turlari.modal.namePlaceholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.turlari.modal.amount')}</label>
                <input
                  type="number"
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className={inputCls}
                  placeholder={t('hr.turlari.modal.amountPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.turlari.modal.typeLabel')}</label>
                <div className="flex gap-2">
                  {(['UZS', '%'] as const).map(u => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, unit: u }))}
                      className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${
                        form.unit === u
                          ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                          : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      {u === 'UZS' ? t('hr.turlari.modal.unitUZS') : t('hr.turlari.modal.unitPercent')}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('hr.turlari.modal.description')}</label>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 resize-none transition-colors"
                placeholder={t('hr.turlari.modal.descriptionPlaceholder')}
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveType} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editType ? t('common.edit') : t('common.add')}
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
              {deleteTarget?.section === 'reward' ? t('hr.turlari.rewards.deleteTitle') : t('hr.turlari.penalties.deleteTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {deleteTarget?.section === 'reward' ? t('hr.turlari.rewards.deleteConfirm') : t('hr.turlari.penalties.deleteConfirm')}
            </p>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={executeDelete}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
