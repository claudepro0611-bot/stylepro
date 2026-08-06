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

async function handleTextMessage(chatId: number, fromId: number, text: string) {
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

  const { error: updateError } = await supabaseServer
    .from('requests')
    .update({ mode })
    .eq('id', requestId)
  if (updateError) {
    console.error('[telegram/webhook] failed to persist request mode', updateError.message)
  }

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
      await handleTextMessage(chatId, fromId, message.text)
    }
    // Other update/message shapes (stickers, photos, etc.) are ignored.
  } catch (e) {
    // Always ack Telegram with 200 even on unexpected errors - a non-2xx
    // response makes Telegram retry-storm this endpoint.
    console.error('[telegram/webhook] unexpected error', e instanceof Error ? e.message : e)
  }

  return NextResponse.json({ ok: true })
}
