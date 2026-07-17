'use server'

import { createClient, supabaseServer } from '@/lib/supabase/server'

const SUPER_ADMIN_EMAIL = 'admin@stylepro.local'
const LOGIN_DOMAIN = '@stylepro.local'

export interface CompanyRow {
  id: string
  name: string
  slug: string | null
  phone: string | null
  address: string | null
  status: 'active' | 'inactive'
  createdAt: string
  login: string | null
  usersCount: number
  userLimit: number
  warehousesCount: number
  warehouseLimit: number
}

export interface CompanyStats {
  total: number
  active: number
  addedToday: number
}

export interface CreateCompanyInput {
  name: string
  login: string
  password: string
  phone?: string
  address?: string
  status?: 'active' | 'inactive'
  warehouseLimit?: number
}

export interface UpdateCompanyInput {
  name: string
  phone?: string
  address?: string
  status: 'active' | 'inactive'
  userLimit: number
  warehouseLimit: number
}

async function requireSuperAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user || user.email?.toLowerCase() !== SUPER_ADMIN_EMAIL) {
    throw new Error('Unauthorized')
  }

  return user
}

export async function getCompanies(): Promise<{ companies: CompanyRow[]; stats: CompanyStats }> {
  await requireSuperAdmin()

  const { data: companies, error: companiesError } = await supabaseServer
    .from('companies')
    .select('*')
    .order('created_at', { ascending: false })

  if (companiesError) throw new Error(companiesError.message)

  const { data: users, error: usersError } = await supabaseServer
    .from('users')
    .select('id, company_id, email, role')

  if (usersError) throw new Error(usersError.message)

  const { data: warehouses, error: warehousesError } = await supabaseServer
    .from('warehouses')
    .select('id, company_id')

  if (warehousesError) throw new Error(warehousesError.message)

  const todayStr = new Date().toISOString().slice(0, 10)

  const rows: CompanyRow[] = (companies ?? []).map(c => {
    const companyUsers = (users ?? []).filter(u => u.company_id === c.id)
    const owner = companyUsers.find(u => u.role === 'owner') ?? companyUsers[0]
    const login = owner?.email?.endsWith(LOGIN_DOMAIN)
      ? owner.email.slice(0, -LOGIN_DOMAIN.length)
      : owner?.email ?? null

    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      phone: c.phone,
      address: c.address,
      status: c.status,
      createdAt: c.created_at,
      login,
      usersCount: companyUsers.length,
      userLimit: c.user_limit ?? 1,
      warehousesCount: (warehouses ?? []).filter(w => w.company_id === c.id).length,
      warehouseLimit: c.warehouse_limit ?? 2,
    }
  })

  const stats: CompanyStats = {
    total: rows.length,
    active: rows.filter(r => r.status === 'active').length,
    addedToday: rows.filter(r => r.createdAt.slice(0, 10) === todayStr).length,
  }

  return { companies: rows, stats }
}

export async function getCompany(id: string): Promise<CompanyRow | null> {
  const { companies } = await getCompanies()
  return companies.find(c => c.id === id) ?? null
}

export async function createCompany(data: CreateCompanyInput) {
  await requireSuperAdmin()

  const login = data.login.trim().toLowerCase()
  if (!/^[a-z0-9]+$/.test(login)) {
    return { error: "Login faqat harf va raqamlardan iborat bo'lishi kerak" }
  }
  if (data.password.length < 8) {
    return { error: "Parol kamida 8 belgidan iborat bo'lishi kerak" }
  }
  if (!data.name.trim()) {
    return { error: 'Firma nomi kiritilishi shart' }
  }

  const email = `${login}${LOGIN_DOMAIN}`

  const { data: authUser, error: authError } = await supabaseServer.auth.admin.createUser({
    email,
    password: data.password,
    email_confirm: true,
  })

  if (authError || !authUser.user) {
    return { error: authError?.message ?? 'Foydalanuvchi yaratilmadi' }
  }

  const { data: company, error: companyError } = await supabaseServer
    .from('companies')
    .insert({
      name: data.name.trim(),
      slug: login,
      phone: data.phone || null,
      address: data.address || null,
      status: data.status ?? 'active',
      warehouse_limit: Math.min(100, Math.max(1, data.warehouseLimit ?? 2)),
    })
    .select()
    .single()

  if (companyError || !company) {
    await supabaseServer.auth.admin.deleteUser(authUser.user.id)
    return { error: companyError?.message ?? 'Firma yaratilmadi' }
  }

  const { error: linkError } = await supabaseServer
    .from('users')
    .update({
      company_id: company.id,
      full_name: data.name.trim(),
      role: 'owner',
    })
    .eq('id', authUser.user.id)

  if (linkError) {
    return { error: linkError.message }
  }

  return {
    success: true,
    login,
    password: data.password,
  }
}

export async function updateCompany(id: string, data: UpdateCompanyInput) {
  await requireSuperAdmin()

  if (!data.name.trim()) {
    return { error: 'Firma nomi kiritilishi shart' }
  }

  const { error } = await supabaseServer
    .from('companies')
    .update({
      name: data.name.trim(),
      phone: data.phone || null,
      address: data.address || null,
      status: data.status,
      user_limit: Math.max(1, data.userLimit),
      warehouse_limit: Math.min(100, Math.max(1, data.warehouseLimit)),
    })
    .eq('id', id)

  if (error) return { error: error.message }
  return { success: true }
}

export interface UpdateCompanyBillingInput {
  user_limit?: number
  warehouse_limit?: number
  balance?: number
  payment_due_date?: string | null
  monthly_fee?: number
  has_contract?: boolean
  daily_penalty?: number
  max_grace_days?: number
  penalty_days?: number
  total_penalty?: number
  grace_period_start?: string | null
}

export async function updateCompanyBilling(id: string, data: UpdateCompanyBillingInput) {
  await requireSuperAdmin()

  const { error } = await supabaseServer
    .from('companies')
    .update(data)
    .eq('id', id)

  if (error) return { error: error.message }
  return { success: true }
}

export async function deleteCompany(id: string) {
  await requireSuperAdmin()

  const { data: users } = await supabaseServer
    .from('users')
    .select('id')
    .eq('company_id', id)

  const { error } = await supabaseServer
    .from('companies')
    .delete()
    .eq('id', id)

  if (error) return { error: error.message }

  for (const u of users ?? []) {
    await supabaseServer.auth.admin.deleteUser(u.id)
  }

  return { success: true }
}

export interface FeatureDefinitionRow {
  key: string
  name: string
  description: string | null
  priceUsd: number
  isCore: boolean
  companiesUsing: number
}

export async function getFeatureDefinitions(): Promise<FeatureDefinitionRow[]> {
  await requireSuperAdmin()

  const { data: defs, error: defsError } = await supabaseServer
    .from('feature_definitions')
    .select('key, name, description, price_usd, is_core')
    .order('is_core', { ascending: false })
    .order('name')

  if (defsError) throw new Error(defsError.message)

  const { data: usage, error: usageError } = await supabaseServer
    .from('company_features')
    .select('feature_key')

  if (usageError) throw new Error(usageError.message)

  const usageCounts = new Map<string, number>()
  ;(usage ?? []).forEach(row => {
    usageCounts.set(row.feature_key, (usageCounts.get(row.feature_key) ?? 0) + 1)
  })

  return (defs ?? []).map(d => ({
    key: d.key,
    name: d.name,
    description: d.description,
    priceUsd: Number(d.price_usd),
    isCore: d.is_core,
    companiesUsing: usageCounts.get(d.key) ?? 0,
  }))
}

export interface CreateFeatureDefinitionInput {
  key: string
  name: string
  description?: string
  priceUsd: number
}

export async function createFeatureDefinition(data: CreateFeatureDefinitionInput) {
  await requireSuperAdmin()

  const key = data.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (!key) return { error: "Kalit (key) kiritilishi shart" }
  if (!data.name.trim()) return { error: 'Modul nomi kiritilishi shart' }
  if (data.priceUsd < 0) return { error: "Narx manfiy bo'lishi mumkin emas" }

  const { error } = await supabaseServer
    .from('feature_definitions')
    .insert({
      key,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      price_usd: data.priceUsd,
      is_core: false,
    })

  if (error) {
    if (error.code === '23505') return { error: 'Bu kalit bilan modul allaqachon mavjud' }
    return { error: error.message }
  }
  return { success: true }
}

export interface UpdateFeatureDefinitionInput {
  name: string
  description?: string
  priceUsd: number
  isCore: boolean
}

export async function updateFeatureDefinition(key: string, data: UpdateFeatureDefinitionInput) {
  await requireSuperAdmin()

  if (!data.name.trim()) return { error: 'Modul nomi kiritilishi shart' }
  if (data.priceUsd < 0) return { error: "Narx manfiy bo'lishi mumkin emas" }

  const { error } = await supabaseServer
    .from('feature_definitions')
    .update({
      name: data.name.trim(),
      description: data.description?.trim() || null,
      price_usd: data.priceUsd,
      is_core: data.isCore,
    })
    .eq('key', key)

  if (error) return { error: error.message }
  return { success: true }
}

export async function deleteFeatureDefinition(key: string) {
  await requireSuperAdmin()

  const { count, error: countError } = await supabaseServer
    .from('company_features')
    .select('id', { count: 'exact', head: true })
    .eq('feature_key', key)

  if (countError) return { error: countError.message }
  if ((count ?? 0) > 0) {
    return { error: `Bu modulni ${count} ta firma ishlatmoqda, o'chirib bo'lmaydi` }
  }

  const { error } = await supabaseServer
    .from('feature_definitions')
    .delete()
    .eq('key', key)

  if (error) return { error: error.message }
  return { success: true }
}

export async function impersonateCompany(id: string) {
  await requireSuperAdmin()

  const { data: users, error: usersError } = await supabaseServer
    .from('users')
    .select('id, email, role')
    .eq('company_id', id)

  if (usersError) return { error: usersError.message }

  const owner = (users ?? []).find(u => u.role === 'owner') ?? (users ?? [])[0]
  if (!owner?.email) {
    return { error: "Firma uchun foydalanuvchi topilmadi" }
  }

  const { data: link, error: linkError } = await supabaseServer.auth.admin.generateLink({
    type: 'magiclink',
    email: owner.email,
  })

  if (linkError || !link) {
    return { error: linkError?.message ?? 'Havola yaratilmadi' }
  }

  return {
    success: true,
    email: owner.email,
    tokenHash: link.properties.hashed_token,
  }
}
