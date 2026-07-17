'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CheckCircle2, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CompanyFormFields, emptyCompanyForm, type CompanyFormValues } from '@/components/super-admin/CompanyFormFields'
import { createCompany } from '@/app/(dashboard)/super-admin/actions'

export default function NewFirmPage() {
  const router = useRouter()
  const [form, setForm] = useState<CompanyFormValues>(emptyCompanyForm)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState<{ login: string; password: string } | null>(null)

  async function handleSubmit() {
    setSubmitting(true)
    const result = await createCompany({
      name: form.name,
      login: form.login,
      password: form.password,
      phone: form.phone,
      address: form.address,
      status: form.status,
      warehouseLimit: form.warehouseLimit,
    })
    setSubmitting(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }

    if ('success' in result) {
      setSuccess({ login: result.login!, password: result.password! })
    }
  }

  function copyCredentials() {
    if (!success) return
    const text = `Login: ${success.login}\nParol: ${success.password}\nURL: localhost:3000/login`
    navigator.clipboard.writeText(text)
    toast.success('Nusxalandi')
  }

  if (success) {
    return (
      <div className="max-w-md mx-auto space-y-6">
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-6 transition-colors">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Firma muvaffaqiyatli qo&apos;shildi!
            </h1>
          </div>
          <div className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-4 text-sm">
            <p className="text-gray-600 dark:text-gray-400">
              Login: <span className="font-medium text-gray-900 dark:text-gray-100">{success.login}</span>
            </p>
            <p className="text-gray-600 dark:text-gray-400">
              Parol: <span className="font-medium text-gray-900 dark:text-gray-100">{success.password}</span>
            </p>
            <p className="text-gray-600 dark:text-gray-400">
              URL: <span className="font-medium text-gray-900 dark:text-gray-100">localhost:3000/login</span>
            </p>
          </div>
          <p className="mt-3 text-[12px] text-gray-400 dark:text-gray-500">
            Ushbu ma&apos;lumotlarni firma egasiga yetkazing. Parol qayta ko&apos;rsatilmaydi.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={copyCredentials}>
              <Copy className="h-3.5 w-3.5" />
              Nusxalash
            </Button>
            <Button onClick={() => router.push('/super-admin/firms')}>Firmalar ro&apos;yxati</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <button
        onClick={() => router.push('/super-admin/firms')}
        className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Firmalar
      </button>

      <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm p-6 transition-colors">
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Firma qo&apos;shish</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Yangi firma va uning login ma&apos;lumotlarini yarating</p>
        <CompanyFormFields values={form} onChange={setForm} mode="create" />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.push('/super-admin/firms')}>Bekor qilish</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saqlanmoqda...' : "Qo'shish"}
          </Button>
        </div>
      </div>
    </div>
  )
}
