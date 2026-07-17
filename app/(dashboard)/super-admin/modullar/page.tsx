import { getFeatureDefinitions } from '@/app/(dashboard)/super-admin/actions'
import { ModulesClient } from '@/components/super-admin/ModulesClient'

export default async function ModulesPage() {
  const modules = await getFeatureDefinitions()

  return <ModulesClient modules={modules} />
}
