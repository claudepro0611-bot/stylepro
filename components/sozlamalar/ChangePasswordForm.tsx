'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'

const MIN_PASSWORD_LENGTH = 8

// Error messages are translation keys, resolved with t() at render time.
const schema = z
  .object({
    currentPassword: z.string().min(1, 'settings.password.errRequired'),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH, 'settings.password.errTooShort'),
    confirmPassword: z.string().min(1, 'settings.password.errRequired'),
  })
  .refine(v => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'settings.password.errMismatch',
  })
  .refine(v => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'settings.password.errSame',
  })

type FormValues = z.infer<typeof schema>

const inputCls =
  'h-10 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 pl-3 pr-10 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

const labelCls = 'block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5'

function PasswordField({
  id,
  label,
  autoComplete,
  error,
  registration,
}: {
  id: string
  label: string
  autoComplete: string
  error?: string
  registration: ReturnType<ReturnType<typeof useForm<FormValues>>['register']>
}) {
  const { t } = useLanguage()
  const [show, setShow] = useState(false)

  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      <div className="relative">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          className={inputCls}
          {...registration}
        />
        <button
          type="button"
          onClick={() => setShow(v => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          aria-label={show ? t('settings.password.hide') : t('settings.password.show')}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  )
}

export function ChangePasswordForm({ onSuccess }: { onSuccess?: () => void }) {
  const { t } = useLanguage()
  const [formError, setFormError] = useState('')

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  })

  const msg = (m?: string) => (m ? t(m as TranslationKey) : undefined)

  async function onSubmit(values: FormValues) {
    setFormError('')
    const supabase = createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) {
      const m = t('settings.password.errorGeneric')
      setFormError(m)
      toast.error(m)
      return
    }

    // Verify the current password against the session user's own email.
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: values.currentPassword,
    })
    if (verifyError) {
      const m = t('settings.password.errorWrongCurrent')
      setFormError(m)
      toast.error(m)
      return
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: values.newPassword })
    if (updateError) {
      const code = (updateError as { code?: string }).code
      const m =
        code === 'weak_password'
          ? t('settings.password.errorWeak')
          : code === 'same_password'
            ? t('settings.password.errSame')
            : t('settings.password.errorGeneric')
      setFormError(m)
      toast.error(m)
      return
    }

    reset()
    toast.success(t('settings.password.success'))
    onSuccess?.()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <PasswordField
        id="current-password"
        label={t('settings.password.current')}
        autoComplete="current-password"
        error={msg(errors.currentPassword?.message)}
        registration={register('currentPassword')}
      />
      <PasswordField
        id="new-password"
        label={t('settings.password.new')}
        autoComplete="new-password"
        error={msg(errors.newPassword?.message)}
        registration={register('newPassword')}
      />
      <PasswordField
        id="confirm-password"
        label={t('settings.password.confirm')}
        autoComplete="new-password"
        error={msg(errors.confirmPassword?.message)}
        registration={register('confirmPassword')}
      />

      {formError && <p className="text-sm text-red-500">{formError}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isSubmitting}
          className="flex h-9 items-center gap-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900 px-4 text-sm font-medium text-white transition-colors disabled:opacity-50"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('settings.password.submit')}
        </button>
      </div>
    </form>
  )
}
