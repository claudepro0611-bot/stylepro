import { notFound } from 'next/navigation'
import { getCompany } from '@/app/(dashboard)/super-admin/actions'
import { EditFirmPageClient } from '@/components/super-admin/EditFirmPageClient'

export default async function EditFirmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const company = await getCompany(id)

  if (!company) notFound()

  return <EditFirmPageClient company={company} />
}
