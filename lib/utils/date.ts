// Calendar-date helpers. Every business date in this app (sale date, stock
// movement date, expense date, "today" filters) means the shop's local day.
// Never derive one with toISOString().slice(0, 10): that is the UTC day, which
// in Tashkent (UTC+5) is still yesterday until 05:00.

export const APP_TIME_ZONE = 'Asia/Tashkent'

// YYYY-MM-DD in the browser's local time zone. Use on the client.
export function localYmd(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// YYYY-MM-DD in Tashkent time. Use on the server, where the process runs in UTC.
export function tashkentYmd(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE }).format(date)
}
