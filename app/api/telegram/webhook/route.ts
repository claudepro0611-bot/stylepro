import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'
import {
  answerCallbackQuery, editMessageText, sendContactRequest, sendMessage, sendMessageWithInlineKeyboard,
} from '@/lib/telegram'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Telegram sends the secret_token set on setWebhook back on every request via
// this header. It authenticates INBOUND calls from Telegram to us - a
// different secret from TELEGRAM_BOT_TOKEN, which authenticates OUTBOUND
// calls we make to Telegram's Bot API (see lib/telegram.ts).
const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

interface TelegramUser {
  id: number
  first_name?: string
}

interface TelegramContact {
  phone_number: string
  user_id?: number
}

interface TelegramMessage {
  message_id: number
  chat: { id: number }
  from?: TelegramUser
  text?: string
  contact?: TelegramContact
}

interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

// Two-mode classification (see handleTextMessage / handleCallbackQuery below).
// callback_data shape: "mode:shikoyat:<request-id>" | "mode:murojat:<request-id>"
// for a real, already-inserted request row - the literal is the exact
// requests.mode column value (see supabase/migrations/20260806000001_
// requests_mode_rename.sql - CHECK (mode IN ('shikoyat', 'murojat'))), so no
// separate literal->DB-value map is needed anymore. Persisted in
// handleCallbackQuery below, in addition to the cosmetic editMessageText.
//
// A second, distinct callback_data shape - "mode:info:shikoyat" |
// "mode:info:murojat", no request id - is used only for the onboarding
// buttons sent right after phone linking (see handleContact below), before
// any request row exists to classify. MODE_INFO_RE is matched first in
// handleCallbackQuery and never touches the DB; keep it separate from
// MODE_CALLBACK_RE's per-request flow.
//
// ═══════════════════════════════════════════════════════════════════════════
// MUROJAT THREADING STRATEGY (20260806000002_murojat_chat_history.sql)
// ═══════════════════════════════════════════════════════════════════════════
// The new schema assumes ONE `requests` row per ongoing murojat conversation,
// with many `murojat_messages` threaded under it via `request_id`. This
// webhook, however, still creates a brand-new `requests` row for EVERY
// incoming text message (unchanged classification UX - see handleTextMessage
// below). Reconciling the two, implemented exactly as follows (the
// "recommended approach" from the task brief - option (a), not deviated
// from):
//
// 1. First message of a NEW conversation: unchanged. handleTextMessage still
//    creates a `requests` row and asks the customer to classify it via the
//    Shikoyat/Murojat inline buttons, exactly as before.
//
// 2. Every SUBSEQUENT message from that same customer: handleTextMessage
//    first checks whether the customer already has an OPEN murojat thread
//    (a `requests` row with mode = 'murojat' AND status != 'resolved',
//    findOpenMurojatThread() below). If one exists, the incoming message is
//    a continuation of that thread - it is inserted straight into
//    `murojat_messages` (sender = 'customer') against that thread's
//    request_id, and NO new `requests` row is created and NO classification
//    buttons are (re-)sent. This is the only behavioral change from the old
//    "one requests row per message" flow.
//
// 3. When the customer taps "Murojat" on a first/unclassified message (see
//    handleCallbackQuery), that request row becomes the new open thread
//    going forward AND its own original message text is backfilled into
//    murojat_messages (sender = 'customer') at classification time, so the
//    thread's history is complete from message #1 - not just from the
//    second message onward. telegram_message_id is left null on this
//    backfilled row: requests does not store the original inbound
//    message_id anywhere, only its text (requests.message), so there is
//    nothing to backfill it with.
//
// 4. When the customer taps "Shikoyat" instead: no threading happens.
//    Shikoyat/complaint requests intentionally stay one-row-per-message,
//    same as before this migration - a complaint is a single, self-
//    contained report to be triaged and resolved on /requests, not a live
//    back-and-forth conversation the way a murojat thread is. Nothing about
//    the mode = 'shikoyat' branch needed to change.
//
// 5. Once a murojat thread's `requests.status` is set to 'resolved' (via
//    update_request() on /requests, or a future dedicated action), the next
//    message from that same customer will find no OPEN thread and falls
//    back to step 1 - a brand-new `requests` row + fresh classification
//    prompt. This is intentional: a resolved conversation should not
//    silently reopen and keep accumulating messages against a "closed"
//    ticket.
const MODE_CALLBACK_RE = /^mode:(shikoyat|murojat):([0-9a-f-]{36})$/i
const MODE_INFO_RE = /^mode:info:(shikoyat|murojat)$/i
const MODE_LABEL_UZ: Record<'shikoyat' | 'murojat', string> = {
  shikoyat: 'Shikoyat',
  murojat: 'Murojat',
}

function isValidSecret(request: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!expected) {
    console.error('[telegram/webhook] TELEGRAM_WEBHOOK_SECRET is not configured')
    return false
  }

  const received = request.headers.get(SECRET_HEADER) ?? ''
  const expectedBuf = Buffer.from(expected)
  const receivedBuf = Buffer.from(received)

  // timingSafeEqual throws on length mismatch, so compare lengths first
  // (this length check is not constant-time, but header length alone is not
  // sensitive information - only the secret's contents must be).
  if (expectedBuf.length !== receivedBuf.length) return false

  return timingSafeEqual(expectedBuf, receivedBuf)
}

/** Strips everything but digits, e.g. "+998 90 123-45-67" -> "998901234567". */
function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '')
}

/**
 * Core Uzbek mobile number (9 digits, no country code) used as a loose
 * matching key, since customers.phone is free-text entered by staff and may
 * or may not include the "998" country code, spaces or dashes (see
 * app/(dashboard)/customers/page.tsx's addCustomer - the value is only
 * trim()-ed, not normalized, before being stored via create_customer).
 */
function last9Digits(phone: string): string {
  return digitsOnly(phone).slice(-9)
}

async function handleStart(chatId: number) {
  const result = await sendContactRequest(chatId)
  if (!result.ok) {
    console.error('[telegram/webhook] failed to send contact request', result.error)
  }
}

async function handleContact(chatId: number, fromId: number, contact: TelegramContact) {
  const key = last9Digits(contact.phone_number)
  if (key.length < 9) {
    await sendMessage(chatId, "Telefon raqam noto'g'ri. Iltimos, qaytadan urinib ko'ring.")
    return
  }

  // Narrow candidates in the DB with a substring match, then confirm exact
  // digit equality in JS (phone formatting varies row to row - see
  // digitsOnly()/last9Digits() above).
  const { data: candidates, error } = await supabaseServer
    .from('customers')
    .select('id, company_id, full_name, phone')
    .not('phone', 'is', null)
    .ilike('phone', `%${key}%`)

  if (error) {
    console.error('[telegram/webhook] customer lookup by phone failed', error.message)
    await sendMessage(chatId, 'Xatolik yuz berdi. Keyinroq qayta urinib ko\'ring.')
    return
  }

  const matches = (candidates ?? []).filter(c => c.phone && last9Digits(c.phone) === key)

  if (matches.length === 0) {
    await sendMessage(chatId, 'Ushbu telefon raqami bo\'yicha mijoz topilmadi.')
    return
  }

  if (matches.length > 1) {
    // Same phone number exists on customers in more than one company - the
    // webhook has no session/company context to disambiguate with, and
    // customers is company-scoped (see supabase/migrations/20260612090005_
    // customers.sql), so we deliberately do NOT guess which company this
    // Telegram user belongs to. Flagged in the final report as an ambiguity.
    console.error(`[telegram/webhook] phone ${key} matches ${matches.length} customers across companies - skipping link`)
    await sendMessage(chatId, "Sizning raqamingiz bo'yicha bir nechta mijoz topildi. Iltimos, do'kon administratoriga murojaat qiling.")
    return
  }

  const customer = matches[0]
  const { error: updateError } = await supabaseServer
    .from('customers')
    .update({ telegram_id: fromId })
    .eq('id', customer.id)

  if (updateError) {
    console.error('[telegram/webhook] failed to link telegram_id', updateError.message)
    await sendMessage(chatId, 'Xatolik yuz berdi. Keyinroq qayta urinib ko\'ring.')
    return
  }

  await sendMessage(chatId, `Rahmat! Hisobingiz ulandi: ${customer.full_name}.`)

  // Onboarding/informational message only - no request row exists yet at
  // this point, so these buttons must not attempt to update any row. Uses
  // the "mode:info:*" callback_data shape (MODE_INFO_RE), handled as a
  // distinct branch in handleCallbackQuery before the per-request
  // MODE_CALLBACK_RE match, so it can never be confused with a real
  // classification tap.
  const onboardingResult = await sendMessageWithInlineKeyboard(
    chatId,
    "Botga yozgan har bir xabaringizni \"Shikoyat\" yoki \"Murojat\" turida belgilashingiz mumkin. Xabaringizni yozing, so'ng paydo bo'ladigan tugmalardan turini tanlang.",
    [[
      { text: '📋 Shikoyat', callbackData: 'mode:info:shikoyat' },
      { text: '💬 Murojat', callbackData: 'mode:info:murojat' },
    ]],
  )
  if (!onboardingResult.ok) {
    console.error('[telegram/webhook] failed to send onboarding mode buttons')
  }
}

/**
 * Finds this customer's OPEN murojat thread, if any - a `requests` row with
 * mode = 'murojat' AND status != 'resolved'. Returns null if none exists
 * (either the customer has never had a murojat conversation, or their most
 * recent one is already resolved - see the threading strategy comment
 * above). Uses supabaseServer like every other DB write/read in this file.
 */
async function findOpenMurojatThread(customerId: string): Promise<string | null> {
  const { data, error } = await supabaseServer
    .from('requests')
    .select('id')
    .eq('customer_id', customerId)
    .eq('mode', 'murojat')
    .neq('status', 'resolved')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[telegram/webhook] failed to look up open murojat thread', error.message)
    return null
  }

  return data?.id ?? null
}

/** Inserts a customer-authored message into murojat_messages against an
 * existing request thread. Used both for live continuations of an open
 * thread (handleTextMessage) and for backfilling message #1 at
 * classification time (handleCallbackQuery). */
async function insertMurojatMessage(params: {
  companyId: string
  requestId: string
  customerId: string | null
  message: string
  telegramMessageId?: number | null
}) {
  const { error } = await supabaseServer.from('murojat_messages').insert({
    company_id: params.companyId,
    request_id: params.requestId,
    customer_id: params.customerId,
    sender: 'customer',
    message: params.message,
    telegram_message_id: params.telegramMessageId ?? null,
  })

  if (error) {
    console.error('[telegram/webhook] failed to insert murojat_messages row', error.message)
  }
}

async function handleTextMessage(chatId: number, fromId: number, text: string, messageId: number) {
  const { data: customer, error } = await supabaseServer
    .from('customers')
    .select('id, company_id, full_name')
    .eq('telegram_id', fromId)
    .maybeSingle()

  if (error) {
    console.error('[telegram/webhook] customer lookup by telegram_id failed', error.message)
    await sendMessage(chatId, 'Xatolik yuz berdi. Keyinroq qayta urinib ko\'ring.')
    return
  }

  if (!customer) {
    // No company_id can be attributed to an unlinked Telegram user, and
    // requests.company_id is NOT NULL (supabase/migrations/20260612090011_
    // requests.sql) - so unlinked messages cannot be recorded as a request.
    // Ask the user to link first instead of guessing/fabricating a company.
    await handleStart(chatId)
    return
  }

  // Threading: if this customer already has an OPEN murojat thread, this
  // message is a continuation of it - persist straight into
  // murojat_messages and skip creating a new requests row / re-classifying.
  // See the threading strategy comment block above MODE_CALLBACK_RE for the
  // full rationale.
  const openThreadId = await findOpenMurojatThread(customer.id)
  if (openThreadId) {
    await insertMurojatMessage({
      companyId: customer.company_id,
      requestId: openThreadId,
      customerId: customer.id,
      message: text,
      telegramMessageId: messageId,
    })
    await sendMessage(chatId, 'Xabaringiz qabul qilindi. Tez orada siz bilan bog\'lanamiz.')
    return
  }

  const { data: inserted, error: insertError } = await supabaseServer
    .from('requests')
    .insert({
      company_id: customer.company_id,
      customer_id: customer.id,
      customer_name: customer.full_name,
      type: 'inquiry',
      priority: 'medium',
      status: 'new',
      message: text,
      source: 'telegram',
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('[telegram/webhook] failed to create request', insertError.message)
    await sendMessage(chatId, 'Xatolik yuz berdi. Keyinroq qayta urinib ko\'ring.')
    return
  }

  const confirmationText = 'Xabaringiz qabul qilindi. Tez orada siz bilan bog\'lanamiz.'

  // Ask the customer to classify what they just sent. No pending state is
  // needed for this since the request row already exists by this point - the
  // callback_data simply carries its id (see MODE_CALLBACK_RE above).
  if (inserted?.id) {
    const result = await sendMessageWithInlineKeyboard(chatId, confirmationText, [[
      { text: '📋 Shikoyat', callbackData: `mode:shikoyat:${inserted.id}` },
      { text: '💬 Murojat', callbackData: `mode:murojat:${inserted.id}` },
    ]])
    if (result.ok) return
    // Fall through to a plain confirmation if the keyboard send failed, so
    // the customer still gets acknowledged.
  }

  await sendMessage(chatId, confirmationText)
}

async function handleCallbackQuery(cb: TelegramCallbackQuery) {
  const data = cb.data ?? ''

  // Onboarding taps ("mode:info:*", sent from handleContact right after
  // phone linking) never correspond to a real request row - checked first,
  // separately from the per-request flow below, so a malformed/onboarding
  // callback can never fall through into the MODE_CALLBACK_RE branch and
  // attempt a DB write.
  const infoMatch = data.match(MODE_INFO_RE)
  if (infoMatch) {
    await answerCallbackQuery(cb.id, "Xabar yozing, so'ng turini tanlaysiz")
    return
  }

  const match = data.match(MODE_CALLBACK_RE)

  if (!match || !cb.message) {
    await answerCallbackQuery(cb.id)
    return
  }

  const mode = match[1] as 'shikoyat' | 'murojat'
  const requestId = match[2]
  const chatId = cb.message.chat.id
  const messageId = cb.message.message_id
  const label = MODE_LABEL_UZ[mode]

  await answerCallbackQuery(cb.id, `${label} sifatida qayd etildi`)

  const { data: updatedRequest, error: updateError } = await supabaseServer
    .from('requests')
    .update({ mode })
    .eq('id', requestId)
    .select('id, company_id, customer_id, message')
    .single()

  if (updateError || !updatedRequest) {
    console.error('[telegram/webhook] failed to persist request mode', updateError?.message)
  } else if (mode === 'murojat' && updatedRequest.message) {
    // Backfill message #1 into murojat_messages so this thread's history is
    // complete from the start, not just from the second message onward -
    // see step 3 of the threading strategy comment above MODE_CALLBACK_RE.
    // telegram_message_id is left null: requests never stored the original
    // inbound message_id, only its text.
    await insertMurojatMessage({
      companyId: updatedRequest.company_id,
      requestId: updatedRequest.id,
      customerId: updatedRequest.customer_id,
      message: updatedRequest.message,
    })
  }
  // mode === 'shikoyat': no threading needed - Shikoyat requests stay
  // one-row-per-message, see step 4 of the strategy comment above.

  const baseText = cb.message.text ?? 'Xabaringiz qabul qilindi. Tez orada siz bilan bog\'lanamiz.'
  const result = await editMessageText(chatId, messageId, `${baseText}\n\nTuri: ${label}`)
  if (!result.ok) {
    console.error('[telegram/webhook] failed to edit message after classification tap')
  }
}

export async function POST(request: NextRequest) {
  if (!isValidSecret(request)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  try {
    const update = (await request.json()) as TelegramUpdate

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query)
      return NextResponse.json({ ok: true })
    }

    const message = update.message

    if (!message || !message.from) {
      return NextResponse.json({ ok: true })
    }

    const chatId = message.chat.id
    const fromId = message.from.id

    if (message.contact) {
      await handleContact(chatId, fromId, message.contact)
    } else if (message.text?.startsWith('/start')) {
      await handleStart(chatId)
    } else if (message.text) {
      await handleTextMessage(chatId, fromId, message.text, message.message_id)
    }
    // Other update/message shapes (stickers, photos, etc.) are ignored.
  } catch (e) {
    // Always ack Telegram with 200 even on unexpected errors - a non-2xx
    // response makes Telegram retry-storm this endpoint.
    console.error('[telegram/webhook] unexpected error', e instanceof Error ? e.message : e)
  }

  return NextResponse.json({ ok: true })
}
