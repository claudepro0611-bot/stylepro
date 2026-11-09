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
  branchId: string | null
}

export interface TeamBranchOption {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
}

export interface TeamData {
  users: TeamUserRow[]
  userLimit: number
  isOwner: boolean
  /** All company branches (inactive too, for name lookup), default first. */
  branches: TeamBranchOption[]
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

// Returns an error CODE (translated client-side via branchErrorKey) when the
// branch is missing, not in the caller's company, or inactive.
async function validateBranch(companyId: string, branchId: string | undefined | null): Promise<string | null> {
  if (!branchId) return 'branch_required'
  const { data: branch, error } = await supabaseServer
    .from('branches')
    .select('id, company_id, is_active')
    .eq('id', branchId)
    .maybeSingle()
  if (error) return error.message
  if (!branch || branch.company_id !== companyId) return 'branch_not_found'
  if (!branch.is_active) return 'branch_inactive'
  return null
}

export async function getTeamData(): Promise<TeamData | { error: string }> {
  try {
    const { companyId } = await requireCompanyOwner()

    const [
      { data: company, error: companyError },
      { data: users, error: usersError },
      { data: branches, error: branchesError },
    ] = await Promise.all([
      supabaseServer.from('companies').select('user_limit').eq('id', companyId).single(),
      supabaseServer.from('users').select('id, full_name, email, role, status, permissions, branch_id').eq('company_id', companyId).order('created_at'),
      supabaseServer
        .from('branches')
        .select('id, name, is_default, is_active')
        .eq('company_id', companyId)
        .order('is_default', { ascending: false })
        .order('created_at'),
    ])

    if (companyError || usersError || branchesError) {
      console.error('[jamoa/getTeamData] failed to load team', companyError, usersError, branchesError)
      return { error: 'Failed to load team' }
    }

    const rows: TeamUserRow[] = (users ?? []).map(u => ({
      id: u.id,
      fullName: u.full_name,
      login: loginFromEmail(u.email),
      status: u.status,
      role: u.role,
      permissions: withDefaultPermissions(u.permissions as Partial<Permissions> | null),
      branchId: u.branch_id ?? null,
    }))

    return {
      users: rows,
      userLimit: company?.user_limit ?? 1,
      isOwner: true,
      branches: (branches ?? []).map(b => ({ id: b.id, name: b.name, isDefault: b.is_default, isActive: b.is_active })),
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
  branchId: string
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

  const branchError = await validateBranch(companyId, data.branchId)
  if (branchError) return { error: branchError }

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
      branch_id: data.branchId,
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
  branchId: string
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
    .select('id, company_id, role, branch_id')
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

  // Keeping the current branch is always allowed (it may have been
  // deactivated since); a change must target an active company branch.
  if (data.branchId !== target.branch_id) {
    const branchError = await validateBranch(companyId, data.branchId)
    if (branchError) return { error: branchError }
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
      branch_id: data.branchId,
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
