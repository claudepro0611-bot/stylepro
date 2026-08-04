/**
 * Minimal Telegram Bot API helpers used by the webhook route
 * (app/api/telegram/webhook/route.ts). Server-only.
 *
 * TELEGRAM_BOT_TOKEN authenticates OUTBOUND calls to Telegram's Bot API here.
 * It is a different secret from TELEGRAM_WEBHOOK_SECRET, which authenticates
 * INBOUND calls from Telegram to our webhook route - do not conflate them.
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org'

export interface TelegramCallResult {
  ok: boolean
  error?: string
}

/**
 * Reads TELEGRAM_BOT_TOKEN inside the function body (not at module load
 * time) so the module can be imported without throwing during build steps
 * that don't have the env var set - same pattern as lib/supabase/server.ts
 * reading its Supabase env vars inside createClient()/at call time.
 */
function getBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN ?? null
}

async function callTelegramApi(method: string, body: unknown): Promise<TelegramCallResult> {
  const token = getBotToken()
  if (!token) {
    console.error(`[telegram] ${method} failed: TELEGRAM_BOT_TOKEN is not configured`)
    return { ok: false, error: 'missing_bot_token' }
  }

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      // Never log response body verbatim with the token - the token lives
      // only in the URL, but keep this defensive and log status only.
      console.error(`[telegram] ${method} failed with status ${res.status}`)
      return { ok: false, error: `http_${res.status}` }
    }

    const json = await res.json().catch(() => null)
    if (!json?.ok) {
      console.error(`[telegram] ${method} returned ok:false`, json?.description ?? '')
      return { ok: false, error: json?.description ?? 'telegram_api_error' }
    }

    return { ok: true }
  } catch (e) {
    console.error(`[telegram] ${method} threw`, e instanceof Error ? e.message : e)
    return { ok: false, error: 'network_error' }
  }
}

/** Sends a plain text message to a Telegram chat. */
export async function sendMessage(chatId: number | string, text: string): Promise<TelegramCallResult> {
  return callTelegramApi('sendMessage', { chat_id: chatId, text })
}

/**
 * Sends a message with a reply keyboard containing a single "share phone
 * number" button. Tapping it triggers Telegram's native contact-share UI
 * (request_contact: true), which then arrives on the webhook as
 * message.contact.
 */
export async function sendContactRequest(chatId: number | string): Promise<TelegramCallResult> {
  return callTelegramApi('sendMessage', {
    chat_id: chatId,
    text: 'Salom! Telefon raqamingizni ulashing — tizimda sizni topamiz.',
    reply_markup: {
      keyboard: [[{ text: '📱 Telefon raqamimni ulashish', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  })
}

/** A single inline-keyboard button. `callbackData` becomes `callback_data`,
 * which is echoed back on `update.callback_query.data` when tapped. */
export interface InlineKeyboardButton {
  text: string
  callbackData: string
}

/**
 * Sends a message with an inline keyboard attached (buttons live on the
 * message itself, not the user's keyboard area). Taps arrive on the webhook
 * as `update.callback_query`, distinct from `update.message` used by the
 * reply keyboard above (sendContactRequest).
 */
export async function sendMessageWithInlineKeyboard(
  chatId: number | string,
  text: string,
  buttons: InlineKeyboardButton[][],
): Promise<TelegramCallResult> {
  return callTelegramApi('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.callbackData }))),
    },
  })
}

/**
 * Edits the text (and optionally the inline keyboard) of a previously-sent
 * message. Used to acknowledge a callback_query tap in place, e.g. replacing
 * the classification buttons with a confirmation line. Passing an empty
 * `buttons` array (the default) clears the inline keyboard.
 */
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  buttons: InlineKeyboardButton[][] = [],
): Promise<TelegramCallResult> {
  return callTelegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: {
      inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.callbackData }))),
    },
  })
}

/**
 * Acknowledges a callback_query so Telegram stops showing the loading
 * spinner on the tapped inline-keyboard button. `text` (optional) shows as a
 * small toast/alert in the client - keep it short.
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramCallResult> {
  return callTelegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
}
