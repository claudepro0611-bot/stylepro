'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CompanyFormFields, emptyCompanyForm, type CompanyFormValues } from '@/components/super-admin/CompanyFormFields'
import { updateCompany, type CompanyRow } from '@/app/(dashboard)/super-admin/actions'

interface EditCompanyModalProps {
  company: CompanyRow | null
  onOpenChange: (open: boolean) => void
  onUpdated: () => void
}

export function EditCompanyModal({ company, onOpenChange, onUpdated }: EditCompanyModalProps) {
  const [form, setForm] = useState<CompanyFormValues>(emptyCompanyForm)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (company) {
      setForm({
        name: company.name,
        login: company.login ?? '',
        password: '',
        phone: company.phone ?? '',
        address: company.address ?? '',
        status: company.status,
        userLimit: company.userLimit,
        warehouseLimit: company.warehouseLimit,
      })
    }
  }, [company])

  async function handleSubmit() {
    if (!company) return
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
    onOpenChange(false)
    onUpdated()
  }

  return (
    <Dialog open={!!company} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Firmani tahrirlash</DialogTitle>
        </DialogHeader>
        <CompanyFormFields values={form} onChange={setForm} mode="edit" />
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Bekor qilish</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saqlanmoqda...' : 'Saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
