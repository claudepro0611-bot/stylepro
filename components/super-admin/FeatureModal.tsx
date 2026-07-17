'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { createClient } from '@/lib/supabase/client'
import type { CompanyRow } from '@/app/(dashboard)/super-admin/actions'
import { updateCompanyBilling } from '@/app/(dashboard)/super-admin/actions'

interface FeatureDefRow {
  key: string
  name: string
  description: string | null
  price_usd: number
  is_core: boolean
}

interface CompanyFeatureRow {
  feature_key: string
  is_active: boolean
}

interface CompanyLimitsRow {
  user_limit: number
  warehouse_limit: number
  balance: number
  payment_due_date: string | null
  has_contract: boolean
  daily_penalty: number
  penalty_days: number
  total_penalty: number
  max_grace_days: number
}

const BASE_FEE = 199000
const MODULE_PRICES_UZS: Record<string, number> = {
  hr: 120000,
  marketing: 120000,
  reports: 60000,
  barcode: 60000,
  excel_import: 60000,
}

interface FeatureCard {
  key: string
  name: string
  description: string
  priceUsd: number
  isCore: boolean
  isActive: boolean
}

interface FeatureModalProps {
  company: CompanyRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function FeatureModal({ company, open, onOpenChange }: FeatureModalProps) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [features, setFeatures] = useState<FeatureCard[]>([])
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({})
  const [companyLimits, setCompanyLimits] = useState<CompanyLimitsRow | null>(null)
  const [pendingLimits, setPendingLimits] = useState<{
    user_limit?: number; warehouse_limit?: number; balance?: number; payment_due_date?: string
    has_contract?: boolean; daily_penalty?: number; max_grace_days?: number
  }>({})
  const [clearingPenalty, setClearingPenalty] = useState(false)

  useEffect(() => {
    if (!open || !company) return

    let cancelled = false
    async function load() {
      if (!company) return
      setLoading(true)
      setPendingChanges({})
      setPendingLimits({})
      const supabase = createClient()
      const [{ data: defs, error: defsError }, { data: cf, error: cfError }, { data: companyData }] = await Promise.all([
        supabase.from('feature_definitions').select('key, name, description, price_usd, is_core').order('is_core', { ascending: false }),
        supabase.from('company_features').select('feature_key, is_active').eq('company_id', company.id),
        supabase.from('companies').select('user_limit, warehouse_limit, balance, payment_due_date, has_contract, daily_penalty, penalty_days, total_penalty, max_grace_days').eq('id', company.id).single(),
      ])
      if (defsError || cfError || !defs) {
        setLoading(false)
        toast.error('Xatolik yuz berdi')
        return
      }

      const activeMap = new Map((cf as CompanyFeatureRow[] ?? []).map(row => [row.feature_key, row.is_active]))
      const cards: FeatureCard[] = (defs as FeatureDefRow[]).map(d => ({
        key: d.key,
        name: d.name,
        description: d.description ?? '',
        priceUsd: Number(d.price_usd),
        isCore: d.is_core,
        isActive: d.is_core ? true : (activeMap.get(d.key) ?? false),
      }))

      if (!cancelled) {
        setFeatures(cards)
        setCompanyLimits((companyData as CompanyLimitsRow | null) ?? null)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [open, company])

  function handleToggle(featureKey: string, next: boolean) {
    setFeatures(prev => prev.map(f => (f.key === featureKey ? { ...f, isActive: next } : f)))
    setPendingChanges(prev => ({ ...prev, [featureKey]: next }))
  }

  const activeModules = features.filter(f => f.isActive && MODULE_PRICES_UZS[f.key])
  const calculatedFee = BASE_FEE + activeModules.reduce((sum, f) => sum + MODULE_PRICES_UZS[f.key], 0)

  async function handleSave() {
    if (!company) return
    const hasFeatureChanges = Object.keys(pendingChanges).length > 0
    const limitEntries = Object.keys(pendingLimits)
    if (!hasFeatureChanges && limitEntries.length === 0) { onOpenChange(false); return }

    setSaving(true)
    const supabase = createClient()
    let hasError = false

    // Upsert every non-core feature (not just the ones toggled this
    // session) so every company always has a row per feature — a missing
    // row and an explicit is_active: false row were previously
    // indistinguishable, which made "is this feature really off, or just
    // never touched" impossible to answer from the data alone.
    if (hasFeatureChanges) {
      const allFeatureUpdates = features
        .filter(f => !f.isCore)
        .map(f => ({
          company_id: company.id,
          feature_key: f.key,
          is_active: f.isActive,
          activated_at: new Date().toISOString(),
        }))

      const { error } = await supabase
        .from('company_features')
        .upsert(allFeatureUpdates, { onConflict: 'company_id,feature_key' })
      if (error) hasError = true
    }

    // monthly_fee always auto-syncs to the calculated total, whether a
    // feature toggle or a limit/balance edit is what triggered this save.
    // Goes through a server action (service-role client) because the
    // browser client's RLS policy on companies only allows a user to
    // update their own company row, not an arbitrary one as super admin.
    if (limitEntries.length > 0 || hasFeatureChanges) {
      const result = await updateCompanyBilling(company.id, {
        ...pendingLimits,
        monthly_fee: calculatedFee,
      })
      if (result?.error) hasError = true
    }

    setSaving(false)

    if (hasError) {
      toast.error('Xatolik yuz berdi')
      return
    }
    toast.success("O'zgarishlar saqlandi")
    setCompanyLimits(prev => (prev ? { ...prev, ...pendingLimits } : prev))
    setPendingChanges({})
    setPendingLimits({})
    onOpenChange(false)
  }

  async function handleClearPenalty() {
    if (!company) return
    setClearingPenalty(true)
    const result = await updateCompanyBilling(company.id, {
      penalty_days: 0,
      total_penalty: 0,
      grace_period_start: null,
    })
    setClearingPenalty(false)

    if (result?.error) {
      toast.error('Xatolik yuz berdi')
      return
    }
    toast.success('Jarima tozalandi')
    setCompanyLimits(prev => (prev ? { ...prev, penalty_days: 0, total_penalty: 0 } : prev))
  }

  const pendingCount = Object.keys(pendingChanges).length + Object.keys(pendingLimits).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Firma modullari {company && `— ${company.name}`}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-1 py-2">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">Yuklanmoqda...</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {features.map(f => (
                  <div
                    key={f.key}
                    className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[13px] font-medium text-gray-800 dark:text-gray-200">{f.name}</span>
                      <span className="text-[11px] text-gray-400 dark:text-gray-500">
                        {f.isCore ? 'Bepul' : `$${f.priceUsd}/oy`}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-2">{f.description}</p>
                    <div className="flex items-center justify-between">
                      {f.isCore ? (
                        <span className="text-[11px] text-gray-400 dark:text-gray-500">Doim yoqilgan</span>
                      ) : (
                        <span className="text-[11px] text-gray-500 dark:text-gray-400">
                          {f.isActive ? 'Yoqilgan' : "O'chirilgan"}
                        </span>
                      )}
                      {!f.isCore && <Switch checked={f.isActive} onCheckedChange={next => handleToggle(f.key, next)} />}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-4 py-3">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Jami</span>
                <span className="text-base font-bold text-gray-900 dark:text-gray-100 tabular-nums">{calculatedFee.toLocaleString()} UZS/oy</span>
              </div>

              <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-3">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Limitlar</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Foydalanuvchi limiti</p>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={pendingLimits.user_limit ?? companyLimits?.user_limit ?? company?.userLimit ?? 10}
                      onChange={e => setPendingLimits(prev => ({ ...prev, user_limit: Number(e.target.value) }))}
                      className="w-full bg-transparent text-sm font-medium text-gray-800 dark:text-gray-200 outline-none"
                    />
                  </div>

                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Ombor limiti</p>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={pendingLimits.warehouse_limit ?? companyLimits?.warehouse_limit ?? company?.warehouseLimit ?? 2}
                      onChange={e => setPendingLimits(prev => ({ ...prev, warehouse_limit: Number(e.target.value) }))}
                      className="w-full bg-transparent text-sm font-medium text-gray-800 dark:text-gray-200 outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-3">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Shartnoma</p>

                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 mb-2">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[13px] font-medium text-gray-800 dark:text-gray-200">Shartnoma jarimasi</span>
                    <Switch
                      checked={pendingLimits.has_contract ?? companyLimits?.has_contract ?? false}
                      onCheckedChange={next => setPendingLimits(prev => ({ ...prev, has_contract: next }))}
                    />
                  </div>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500">
                    Blok bo&apos;lganda N kun ishlaydi, jarima yig&apos;iladi
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Kunlik jarima (UZS)</p>
                    <input
                      type="number"
                      value={pendingLimits.daily_penalty ?? companyLimits?.daily_penalty ?? 33000}
                      onChange={e => setPendingLimits(prev => ({ ...prev, daily_penalty: Number(e.target.value) }))}
                      className="w-full bg-transparent text-sm font-medium text-gray-800 dark:text-gray-200 outline-none"
                    />
                  </div>

                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Maksimal kun</p>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={pendingLimits.max_grace_days ?? companyLimits?.max_grace_days ?? 5}
                      onChange={e => setPendingLimits(prev => ({ ...prev, max_grace_days: Number(e.target.value) }))}
                      className="w-full bg-transparent text-sm font-medium text-gray-800 dark:text-gray-200 outline-none"
                    />
                  </div>
                </div>

                {(companyLimits?.penalty_days ?? 0) > 0 && (
                  <div className="mt-2 flex items-center justify-between rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 px-4 py-3">
                    <span className="text-sm font-medium text-red-700 dark:text-red-400">
                      {companyLimits?.penalty_days} kun — {(companyLimits?.total_penalty ?? 0).toLocaleString()} UZS
                    </span>
                    <button
                      onClick={handleClearPenalty}
                      disabled={clearingPenalty}
                      className="flex items-center gap-1.5 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 rounded-lg px-3 py-1.5 text-[12px] font-medium hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                    >
                      {clearingPenalty && <Loader2 className="h-3 w-3 animate-spin" />}
                      Tozalash
                    </button>
                  </div>
                )}
              </div>

              <div className="border-t border-gray-100 dark:border-gray-800 pt-3 mt-3">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">To&apos;lov</p>

                <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50 mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-600 dark:text-gray-400">Asosiy to&apos;lov</span>
                    <span className="text-xs font-medium text-gray-800 dark:text-gray-200">{BASE_FEE.toLocaleString()} UZS</span>
                  </div>
                  {activeModules.map(m => (
                    <div key={m.key} className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-0.5">
                      <span>+ {m.name}</span>
                      <span>{MODULE_PRICES_UZS[m.key].toLocaleString()} UZS</span>
                    </div>
                  ))}
                  <div className="border-t border-gray-200 dark:border-gray-700 mt-1.5 pt-1.5 flex items-center justify-between">
                    <span className="font-semibold text-gray-800 dark:text-gray-200 text-sm">Oylik to&apos;lov</span>
                    <span className="font-bold text-gray-900 dark:text-gray-100 text-base">{calculatedFee.toLocaleString()} UZS</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Balans (UZS)</p>
                    <input
                      type="number"
                      value={pendingLimits.balance ?? companyLimits?.balance ?? 0}
                      onChange={e => setPendingLimits(prev => ({ ...prev, balance: Number(e.target.value) }))}
                      className="w-full bg-transparent text-sm font-medium text-gray-800 dark:text-gray-200 outline-none"
                    />
                  </div>

                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">To&apos;lov kuni</p>
                    <input
                      type="date"
                      value={pendingLimits.payment_due_date ?? companyLimits?.payment_due_date?.slice(0, 10) ?? ''}
                      onChange={e => setPendingLimits(prev => ({ ...prev, payment_due_date: e.target.value }))}
                      className="w-full bg-transparent text-sm font-medium text-gray-800 dark:text-gray-200 outline-none"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-gray-100 dark:border-gray-800 pt-3 flex justify-between items-center">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {pendingCount > 0 ? `${pendingCount} ta o'zgarish saqlanmagan` : ''}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg px-4 py-2 text-[13px] font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              Bekor qilish
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Saqlash
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
