import { getCompanies } from '@/app/(dashboard)/super-admin/actions'
import { FirmsClient } from '@/components/super-admin/FirmsClient'

export default async function FirmsPage() {
  const { companies, stats } = await getCompanies()

  return <FirmsClient companies={companies} stats={stats} />
}
