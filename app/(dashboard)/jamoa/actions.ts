'use server'

import { createClient, supabaseServer } from '@/lib/supabase/server'
import { DEFAULT_PERMISSIONS, withDefaultPermissions, type Permissions } from '@/lib/permissions'

const LOGIN_DOMAIN_SUFFIX = '@stylepro.local'
const COMPANY_NOT_FOUND_MESSAGE = 'Firma topilmadi. Iltimos qayta kiring.'

export interface TeamUserRow {
  id: string
  fullName: string
  login: string
  status: 'active' | 'inactive'
  role: string
  permissions: Permissions
}

export interface TeamData {
  users: TeamUserRow[]
  userLimit: number
  isOwner: boolean
}

function loginFromEmail(email: string) {
  const atIndex = email.indexOf('@')
  return atIndex === -1 ? email : email.slice(0, atIndex)
}

async function requireCompanyOwner() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const { data: me, error } = await supabaseServer
    .from('users')
    .select('id, company_id, role')
    .eq('id', user.id)
    .single()

  if (error || !me) {
    throw new Error('Unauthorized')
  }

  if (me.role !== 'owner') {
    throw new Error('Unauthorized')
  }

  if (!me.company_id) {
    throw new Error(COMPANY_NOT_FOUND_MESSAGE)
  }

  return { userId: user.id, companyId: me.company_id as string }
}

export async function getTeamData(): Promise<TeamData | { error: string }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'Unauthorized' }

    const { data: companyId, error: companyIdError } = await supabase.rpc('get_company_id')

    if (companyIdError || !companyId) {
      console.error('[jamoa/getTeamData] get_company_id() failed', companyIdError)
      return { error: COMPANY_NOT_FOUND_MESSAGE }
    }

    const { data: me, error: meError } = await supabaseServer
      .from('users')
      .select('id, role')
      .eq('id', user.id)
      .single()

    if (meError || !me) {
      console.error('[jamoa/getTeamData] failed to load current user', meError)
      return { error: 'Unauthorized' }
    }

    const [{ data: company, error: companyError }, { data: users, error: usersError }] = await Promise.all([
      supabaseServer.from('companies').select('user_limit').eq('id', companyId).single(),
      supabaseServer.from('users').select('id, full_name, email, role, status, permissions').eq('company_id', companyId).order('created_at'),
    ])

    if (companyError || usersError) {
      console.error('[jamoa/getTeamData] failed to load team', companyError, usersError)
      return { error: 'Failed to load team' }
    }

    const rows: TeamUserRow[] = (users ?? []).map(u => ({
      id: u.id,
      fullName: u.full_name,
      login: loginFromEmail(u.email),
      status: u.status,
      role: u.role,
      permissions: withDefaultPermissions(u.permissions as Partial<Permissions> | null),
    }))

    return {
      users: rows,
      userLimit: company?.user_limit ?? 1,
      isOwner: me.role === 'owner',
    }
  } catch (e) {
    console.error('[jamoa/getTeamData] unexpected error', e)
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export interface CreateTeamUserInput {
  fullName: string
  login: string
  password: string
  status: 'active' | 'inactive'
}

export async function createTeamUser(data: CreateTeamUserInput) {
  try {
    return await createTeamUserInternal(data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

async function createTeamUserInternal(data: CreateTeamUserInput) {
  const { companyId } = await requireCompanyOwner()

  const login = data.login.trim().toLowerCase()
  if (!/^[a-z0-9]+$/.test(login)) {
    return { error: "Login faqat harf va raqamlardan iborat bo'lishi kerak" }
  }
  if (data.password.length < 8) {
    return { error: "Parol kamida 8 belgidan iborat bo'lishi kerak" }
  }
  if (!data.fullName.trim()) {
    return { error: "Ism familiya kiritilishi shart" }
  }

  const { data: company, error: companyError } = await supabaseServer
    .from('companies')
    .select('user_limit')
    .eq('id', companyId)
    .single()

  if (companyError || !company) {
    return { error: 'Firma topilmadi' }
  }

  const { count, error: countError } = await supabaseServer
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .neq('role', 'owner')

  if (countError) return { error: countError.message }

  if ((count ?? 0) >= (company.user_limit ?? 1)) {
    return { error: "Limit tugadi! Qo'shimcha foydalanuvchi uchun administratorga murojaat qiling" }
  }

  const email = `${login}${LOGIN_DOMAIN_SUFFIX}`

  const { data: existing } = await supabaseServer
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (existing) {
    return { error: 'Bu login band, boshqasini tanlang' }
  }

  const { data: authUser, error: authError } = await supabaseServer.auth.admin.createUser({
    email,
    password: data.password,
    email_confirm: true,
  })

  if (authError || !authUser.user) {
    return { error: authError?.message ?? 'Foydalanuvchi yaratilmadi' }
  }

  const { error: linkError } = await supabaseServer
    .from('users')
    .update({
      company_id: companyId,
      full_name: data.fullName.trim(),
      role: 'staff',
      status: data.status,
      permissions: DEFAULT_PERMISSIONS,
    })
    .eq('id', authUser.user.id)

  if (linkError) {
    await supabaseServer.auth.admin.deleteUser(authUser.user.id)
    return { error: linkError.message }
  }

  return { success: true }
}

export interface UpdateTeamUserInput {
  fullName: string
  password?: string
  status: 'active' | 'inactive'
  permissions: Permissions
}

export async function updateTeamUser(id: string, data: UpdateTeamUserInput) {
  try {
    return await updateTeamUserInternal(id, data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

async function updateTeamUserInternal(id: string, data: UpdateTeamUserInput) {
  const { companyId } = await requireCompanyOwner()

  const { data: target, error: targetError } = await supabaseServer
    .from('users')
    .select('id, company_id, role')
    .eq('id', id)
    .single()

  if (targetError || !target || target.company_id !== companyId) {
    return { error: 'Foydalanuvchi topilmadi' }
  }

  if (target.role === 'owner') {
    return { error: "Firma egasini o'zgartirib bo'lmaydi" }
  }

  if (!data.fullName.trim()) {
    return { error: "Ism familiya kiritilishi shart" }
  }

  if (data.password) {
    if (data.password.length < 8) {
      return { error: "Parol kamida 8 belgidan iborat bo'lishi kerak" }
    }
    const { error: pwError } = await supabaseServer.auth.admin.updateUserById(id, { password: data.password })
    if (pwError) return { error: pwError.message }
  }

  const { error } = await supabaseServer
    .from('users')
    .update({
      full_name: data.fullName.trim(),
      status: data.status,
      permissions: data.permissions,
    })
    .eq('id', id)

  if (error) return { error: error.message }
  return { success: true }
}

export async function deleteTeamUser(id: string) {
  try {
    return await deleteTeamUserInternal(id)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

async function deleteTeamUserInternal(id: string) {
  const { companyId, userId } = await requireCompanyOwner()

  if (id === userId) {
    return { error: "O'zingizni o'chira olmaysiz" }
  }

  const { data: target, error: targetError } = await supabaseServer
    .from('users')
    .select('id, company_id, role')
    .eq('id', id)
    .single()

  if (targetError || !target || target.company_id !== companyId) {
    return { error: 'Foydalanuvchi topilmadi' }
  }

  if (target.role === 'owner') {
    return { error: "Firma egasini o'chirib bo'lmaydi" }
  }

  const { error } = await supabaseServer.auth.admin.deleteUser(id)
  if (error) return { error: error.message }

  return { success: true }
}
