'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { createTeamUser } from '@/app/(dashboard)/jamoa/actions'

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

const emptyForm = { fullName: '', login: '', password: '', status: 'active' as 'active' | 'inactive' }

interface AddUserModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  limitReached: boolean
}

export function AddUserModal({ open, onOpenChange, onCreated, limitReached }: AddUserModalProps) {
  const { t } = useLanguage()
  const [form, setForm] = useState(emptyForm)
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  function handleOpenChange(next: boolean) {
    if (!next) setForm(emptyForm)
    onOpenChange(next)
  }

  async function handleSubmit() {
    setSubmitting(true)
    const result = await createTeamUser(form)
    setSubmitting(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }

    toast.success(t('jamoa.toasts.addSuccess'))
    handleOpenChange(false)
    onCreated()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('jamoa.addModal.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {limitReached && (
            <p className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-400">
              {t('jamoa.limitReached')}
            </p>
          )}

          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('jamoa.addModal.fullName')}</label>
            <input
              value={form.fullName}
              onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))}
              className={inputCls}
              placeholder={t('jamoa.addModal.fullNamePlaceholder')}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('jamoa.addModal.login')}</label>
            <input
              value={form.login}
              onChange={e => setForm(f => ({ ...f, login: e.target.value.replace(/[^a-zA-Z0-9]/g, '') }))}
              className={inputCls}
              placeholder={t('jamoa.addModal.loginPlaceholder')}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('jamoa.addModal.password')}</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                className={`${inputCls} pr-9`}
                placeholder={t('jamoa.addModal.passwordPlaceholder')}
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                aria-label={showPassword ? 'Parolni yashirish' : "Parolni ko'rsatish"}
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('jamoa.addModal.status')}</label>
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
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={submitting || limitReached}>
            {submitting ? `${t('common.loading')}` : t('common.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
