'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CompanyFormFields, type CompanyFormValues } from '@/components/super-admin/CompanyFormFields'
import { updateCompany, type CompanyRow } from '@/app/(dashboard)/super-admin/actions'

export function EditFirmPageClient({ company }: { company: CompanyRow }) {
  const router = useRouter()
  const [form, setForm] = useState<CompanyFormValues>({
    name: company.name,
    login: company.login ?? '',
    password: '',
    phone: company.phone ?? '',
    address: company.address ?? '',
    status: company.status,
    userLimit: company.userLimit,
    warehouseLimit: company.warehouseLimit,
  })
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    setSubmitting(true)
    const result = await updateCompany(company.id, {
      name: form.name,
      phone: form.phone,
      address: form.address,
      status: form.status,
      userLimit: form.userLimit,
      warehouseLimit: form.warehouseLimit,
    })
    setSubmitting(false)

    if ('error' in result && result.error) {
      toast.error(result.error)
      return
    }

    toast.success('Firma yangilandi')
    router.push('/super-admin/firms')
    router.refresh()
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
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Firmani tahrirlash</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">{company.name}</p>
        <CompanyFormFields values={form} onChange={setForm} mode="edit" />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.push('/super-admin/firms')}>Bekor qilish</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saqlanmoqda...' : 'Saqlash'}
          </Button>
        </div>
      </div>
    </div>
  )
}
