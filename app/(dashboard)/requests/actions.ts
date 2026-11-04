'use server'

import { createClient, supabaseServer } from '@/lib/supabase/server'
import { withDefaultPermissions, type Permissions } from '@/lib/permissions'
import { sendMessage } from '@/lib/telegram'

// Gated by the 'requests' permission key - the same key update_request()
// itself is gated on (see supabase/migrations/20260723000009_expenses_
// requests_hr_security.sql), matching this page's own access boundary
// rather than inventing a new one. Mirrors requireCustomersPermission() in
// app/(dashboard)/customers/actions.ts.
async function requireRequestsPermission() {
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
    if (!permissions.requests) {
      throw new Error('Unauthorized')
    }
  }

  return { companyId: me.company_id as string }
}

// Notifies a request's linked customer (if any) over Telegram whenever the
// store updates the request's notes/izoh - fire-and-forget from the
// caller's point of view. Never throws for a delivery failure: the notes
// save itself (update_request RPC) already succeeded by the time this runs,
// and a Telegram outage should not surface as a save error - it is only
// logged, consistent with lib/telegram.ts's own non-throwing convention.
export async function notifyCustomerRequestUpdate(requestId: string, notes: string) {
  try {
    return await notifyCustomerRequestUpdateInternal(requestId, notes)
  } catch (e) {
    console.error('[requests/actions] notifyCustomerRequestUpdate failed', e instanceof Error ? e.message : e)
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

async function notifyCustomerRequestUpdateInternal(requestId: string, notes: string) {
  const { companyId } = await requireRequestsPermission()

  const trimmed = notes.trim()
  if (!trimmed) {
    // Nothing to send - not an error, just a no-op.
    return { success: true }
  }

  const { data: request, error } = await supabaseServer
    .from('requests')
    .select('id, company_id, customer_id')
    .eq('id', requestId)
    .single()

  if (error || !request || request.company_id !== companyId) {
    return { error: 'request_not_found' }
  }

  if (!request.customer_id) {
    return { success: true }
  }

  const { data: customer, error: customerError } = await supabaseServer
    .from('customers')
    .select('id, telegram_id')
    .eq('id', request.customer_id)
    .single()

  if (customerError || !customer || !customer.telegram_id) {
    // Not linked to Telegram - nothing to deliver, not an error.
    return { success: true }
  }

  const result = await sendMessage(customer.telegram_id, trimmed)
  if (!result.ok) {
    console.error('[requests/actions] failed to notify customer via telegram', result.error)
  }

  return { success: true }
}
