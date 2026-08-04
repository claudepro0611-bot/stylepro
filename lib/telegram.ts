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
    text: "Iltimos, telefon raqamingizni ulashing.",
    reply_markup: {
      keyboard: [[{ text: 'Telefon raqamni ulashish', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  })
}
