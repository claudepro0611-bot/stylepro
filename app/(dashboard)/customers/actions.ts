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

// Persists a store reply to a murojat thread AND delivers it over Telegram.
//
// Replaces the old replyToCustomerTelegram (send-only, no persistence) that
// used to live here. That helper predated public.murojat_messages - it just
// called sendMessage() and returned success/failure, with the UI faking a
// non-persisted "optimistic" bubble that vanished on reload (see the old
// comment block above TelegramRequestRow/OptimisticReply in
// customers/page.tsx). Now that a real chat-history table + RPC exist
// (20260806000002_murojat_chat_history.sql), there is no reason to keep two
// divergent reply paths - this action supersedes it entirely: persistence
// via send_murojat_reply() first, then the same Telegram delivery step as
// before.
export async function sendMurojatReply(requestId: string, customerId: string, message: string) {
  try {
    return await sendMurojatReplyInternal(requestId, customerId, message)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

async function sendMurojatReplyInternal(requestId: string, customerId: string, message: string) {
  const { companyId } = await requireCustomersPermission()

  const trimmed = message.trim()
  if (!trimmed) {
    return { error: 'empty_message' }
  }

  const { data: customer, error: customerError } = await supabaseServer
    .from('customers')
    .select('id, company_id, telegram_id')
    .eq('id', customerId)
    .single()

  if (customerError || !customer || customer.company_id !== companyId) {
    return { error: 'customer_not_found' }
  }

  // send_murojat_reply() is a SECURITY DEFINER RPC gated on
  // has_permission('requests') and company-scoped via get_company_id() -
  // both resolve from auth.uid(), so it must be called through the
  // session-aware server client (createClient()), not supabaseServer/
  // service-role, which has no auth.uid() and would make get_company_id()
  // raise "No company for current user". This is the first server-action
  // RPC call in the codebase (every other RPC call happens from the browser
  // client) - needed here specifically because delivering the reply over
  // Telegram in the same action requires supabaseServer to read
  // customers.telegram_id server-side.
  const supabase = await createClient()

  // Branches: the customer row above is read with the service role, so bind
  // it to the request through the session (RLS, branch-scoped) client - a
  // manager/staff can only reply to a thread of their own branch, and the
  // Telegram delivery can only reach that thread's customer.
  const { data: visibleRequest } = await supabase
    .from('requests')
    .select('id')
    .eq('id', requestId)
    .eq('customer_id', customerId)
    .maybeSingle()
  if (!visibleRequest) {
    return { error: 'customer_not_found' }
  }

  const { data: inserted, error: rpcError } = await supabase.rpc('send_murojat_reply', {
    p_request_id: requestId,
    p_message: trimmed,
  })

  if (rpcError || !inserted) {
    return { error: rpcError?.message ?? 'send_failed' }
  }

  if (!customer.telegram_id) {
    // Persisted, but nothing to deliver - the customer isn't Telegram-linked.
    return { success: true, message: inserted }
  }

  const result = await sendMessage(customer.telegram_id, trimmed)
  if (!result.ok) {
    console.error('[customers/actions] failed to deliver murojat reply via telegram', result.error)
    return { success: true, message: inserted, deliveryFailed: true }
  }

  return { success: true, message: inserted }
}
