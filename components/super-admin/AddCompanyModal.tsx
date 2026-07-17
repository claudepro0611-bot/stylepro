'use client'

import { useState } from 'react'
import { CheckCircle2, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CompanyFormFields, emptyCompanyForm, type CompanyFormValues } from '@/components/super-admin/CompanyFormFields'
import { createCompany } from '@/app/(dashboard)/super-admin/actions'

interface AddCompanyModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

export function AddCompanyModal({ open, onOpenChange, onCreated }: AddCompanyModalProps) {
  const [form, setForm] = useState<CompanyFormValues>(emptyCompanyForm)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState<{ login: string; password: string } | null>(null)

  function reset() {
    setForm(emptyCompanyForm)
    setSuccess(null)
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      const wasSuccess = !!success
      reset()
      onOpenChange(false)
      if (wasSuccess) onCreated()
    } else {
      onOpenChange(true)
    }
  }

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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {success ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Firma muvaffaqiyatli qo&apos;shildi!
              </DialogTitle>
            </DialogHeader>
            <div className="mt-2 space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-4 text-sm">
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
            <p className="mt-2 text-[12px] text-gray-400 dark:text-gray-500">
              Ushbu ma&apos;lumotlarni firma egasiga yetkazing. Parol qayta ko&apos;rsatilmaydi.
            </p>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={copyCredentials}>
                <Copy className="h-3.5 w-3.5" />
                Nusxalash
              </Button>
              <Button onClick={() => handleOpenChange(false)}>Yopish</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Firma qo&apos;shish</DialogTitle>
            </DialogHeader>
            <CompanyFormFields values={form} onChange={setForm} mode="create" />
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>Bekor qilish</Button>
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saqlanmoqda...' : "Qo'shish"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
