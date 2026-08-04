'use server'

import { createClient, supabaseServer } from '@/lib/supabase/server'
import { withDefaultPermissions, type Permissions } from '@/lib/permissions'
import { sendMessage } from '@/lib/telegram'

// Gated by the 'customers' permission key (not 'requests') because this
// action is only reachable from the /customers page's Murojaatlar tab, which
// is itself gated by 'customers' at the route level (see ROUTE_PERMISSIONS
// in lib/supabase/middleware.ts) - matching the page's own access boundary
// rather than the separate /requests page's permission.
async function requireCustomersPermission() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const { data: me, error } = await supabaseServer
    .from('users')
    .select('id, company_id, role, permissions')
    .eq('id', user.id)
    .single()

  if (error || !me || !me.company_id) {
    throw new Error('Unauthorized')
  }

  if (me.role !== 'owner') {
    const permissions = withDefaultPermissions(me.permissions as Partial<Permissions> | null)
    if (!permissions.customers) {
      throw new Error('Unauthorized')
    }
  }

  return { companyId: me.company_id as string }
}

export async function replyToCustomerTelegram(customerId: string, text: string) {
  try {
    return await replyToCustomerTelegramInternal(customerId, text)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

async function replyToCustomerTelegramInternal(customerId: string, text: string) {
  const { companyId } = await requireCustomersPermission()

  const trimmed = text.trim()
  if (!trimmed) {
    return { error: 'empty_message' }
  }

  const { data: customer, error } = await supabaseServer
    .from('customers')
    .select('id, company_id, telegram_id')
    .eq('id', customerId)
    .single()

  if (error || !customer || customer.company_id !== companyId) {
    return { error: 'customer_not_found' }
  }

  if (!customer.telegram_id) {
    return { error: 'not_linked' }
  }

  const result = await sendMessage(customer.telegram_id, trimmed)
  if (!result.ok) {
    return { error: 'send_failed' }
  }

  return { success: true }
}
