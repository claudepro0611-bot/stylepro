import { tashkentYmd } from '@/lib/utils/date'

// Free USD→UZS sources, no API key:
// 1. Central Bank of Uzbekistan (official). For a date with no fixing
//    (weekend/holiday) it returns the latest earlier rate with its own Date.
//    It times out from servers outside Uzbekistan (e.g. Vercel), so:
// 2. open.er-api.com — daily mid-market rate, reachable worldwide. Latest
//    only, so it's used just for "today", and stored as source 'market'.
const CBU_USD_URL = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/'
const MARKET_USD_URL = 'https://open.er-api.com/v6/latest/USD'
const CBU_TIMEOUT_MS = 5000
const MARKET_TIMEOUT_MS = 8000

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DMY_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/

export type RateSource = 'cbu' | 'market'

export interface FetchedRate {
  rate: number
  date: string // YYYY-MM-DD, the rate's own effective date
  source: RateSource
}

export function isRealYmd(value: string): boolean {
  const m = YMD_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function fetchCbuUsdRate(date?: string): Promise<FetchedRate> {
  const res = await fetch(date ? `${CBU_USD_URL}${date}/` : CBU_USD_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(CBU_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`CBU responded with ${res.status}`)

  const body: unknown = await res.json()
  const row = (Array.isArray(body) ? body[0] : null) as { Ccy?: unknown; Rate?: unknown; Date?: unknown } | null
  if (!row || row.Ccy !== 'USD' || typeof row.Rate !== 'string' || typeof row.Date !== 'string') {
    throw new Error('Unexpected CBU response')
  }

  const rate = Number(row.Rate.replace(',', '.'))
  const dm = DMY_RE.exec(row.Date)
  if (!Number.isFinite(rate) || rate <= 0 || !dm) throw new Error('Unexpected CBU response')

  return { rate: round2(rate), date: `${dm[3]}-${dm[2]}-${dm[1]}`, source: 'cbu' }
}

export async function fetchMarketUsdRate(): Promise<FetchedRate> {
  const res = await fetch(MARKET_USD_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(MARKET_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Market source responded with ${res.status}`)

  const body = (await res.json()) as { result?: unknown; time_last_update_unix?: unknown; rates?: Record<string, unknown> }
  const rate = body.rates?.UZS
  if (body.result !== 'success' || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Unexpected market source response')
  }
  const updated = typeof body.time_last_update_unix === 'number'
    ? new Date(body.time_last_update_unix * 1000)
    : new Date()

  return { rate: round2(rate), date: tashkentYmd(updated), source: 'market' }
}

// CBU first; if it's unreachable and the request is for today (or no date),
// fall back to the market rate. Throws only when every usable source fails.
export async function fetchUsdRate(date?: string): Promise<FetchedRate> {
  try {
    return await fetchCbuUsdRate(date)
  } catch (cbuError) {
    if (date && date !== tashkentYmd()) throw cbuError
    return fetchMarketUsdRate()
  }
}
