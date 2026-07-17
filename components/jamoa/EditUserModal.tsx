'use client'

import { useEffect, useState } from 'react'
import { Eye, EyeOff, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { withDefaultPermissions, PERMISSION_ITEMS, type Permissions } from '@/lib/permissions'
import { updateTeamUser, type TeamUserRow } from '@/app/(dashboard)/jamoa/actions'

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

interface EditFormState {
  fullName: string
  password: string
  status: 'active' | 'inactive'
  permissions: Permissions
}

function formFromUser(user: TeamUserRow): EditFormState {
  return {
    fullName: user.fullName,
    password: '',
    status: user.status,
    permissions: withDefaultPermissions(user.permissions),
  }
}

interface EditUserModalProps {
  user: TeamUserRow | null
  onOpenChange: (open: boolean) => void
  onUpdated: () => void
}

export function EditUserModal({ user, onOpenChange, onUpdated }: EditUserModalProps) {
  const { t } = useLanguage()
  const [tab, setTab] = useState('info')
  const [form, setForm] = useState<EditFormState | null>(null)
  const [initial, setInitial] = useState<EditFormState | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (user) {
      const initialForm = formFromUser(user)
      setForm(initialForm)
      setInitial(initialForm)
      setTab('info')
      setShowPassword(false)
    }
  }, [user])

  if (!user || !form) {
    return (
      <Dialog open={!!user} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" />
      </Dialog>
    )
  }

  const isDirty = !!initial && (
    form.fullName !== initial.fullName ||
    form.password !== initial.password ||
    form.status !== initial.status ||
    JSON.stringify(form.permissions) !== JSON.stringify(initial.permissions)
  )

  async function handleSubmit() {
    if (!form) return
    setSubmitting(true)
    const result = await updateTeamUser(user!.id, {
      fullName: form.fullName,
      password: form.password || undefined,
      status: form.status,
      permissions: form.permissions,
    })
    setSubmitting(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }

    toast.success(t('jamoa.toasts.updateSuccess'))
    onOpenChange(false)
    onUpdated()
  }

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('jamoa.editModal.title')}</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="info">{t('jamoa.editModal.tabs.info')}</TabsTrigger>
            <TabsTrigger value="access">{t('jamoa.editModal.tabs.access')}</TabsTrigger>
          </TabsList>

          <TabsContent value="info" className="mt-4 space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('jamoa.editModal.fullName')}</label>
              <input
                value={form.fullName}
                onChange={e => setForm(f => f && ({ ...f, fullName: e.target.value }))}
                className={inputCls}
              />
            </div>

            <div>
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">{t('jamoa.editModal.password')}</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => setForm(f => f && ({ ...f, password: e.target.value }))}
                  className={`${inputCls} pr-9`}
                  placeholder={t('jamoa.editModal.passwordPlaceholder')}
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
              <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">{t('jamoa.editModal.status')}</label>
              <div className="flex gap-2">
                {(['active', 'inactive'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setForm(f => f && ({ ...f, status: s }))}
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
          </TabsContent>

          <TabsContent value="access" className="mt-4">
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">{t('jamoa.editModal.accessTitle')}</p>
            <div className="space-y-0.5 max-h-[50vh] overflow-y-auto pr-1">
              {PERMISSION_ITEMS.map(({ key, labelKey, icon: Icon }) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
                >
                  <div className="flex items-center gap-2.5 text-sm text-gray-700 dark:text-gray-300">
                    <Icon className="h-4 w-4 text-gray-400 dark:text-gray-500 shrink-0" />
                    {t(labelKey)}
                  </div>
                  <Switch
                    checked={form.permissions[key]}
                    onCheckedChange={checked => setForm(f => f && ({
                      ...f,
                      permissions: { ...f.permissions, [key]: checked },
                    }))}
                    className="data-checked:bg-emerald-500 dark:data-checked:bg-emerald-500"
                  />
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4 flex items-center sm:justify-between">
          {isDirty ? (
            <p className="flex items-center gap-1.5 text-[12px] text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5" />
              {t('jamoa.editModal.unsavedChanges')}
            </p>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? t('common.loading') : t('common.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
