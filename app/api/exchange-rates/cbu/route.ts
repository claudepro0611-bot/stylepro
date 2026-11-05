import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchUsdRate, isRealYmd } from '@/lib/exchange-rates/cbu'

export const dynamic = 'force-dynamic'

function errorJson(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return errorJson('Unauthorized', 401)

  const date = request.nextUrl.searchParams.get('date')
  if (date !== null && !isRealYmd(date)) return errorJson('Invalid date', 400)

  try {
    const result = await fetchUsdRate(date ?? undefined)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return errorJson(e instanceof Error ? e.message : 'CBU request failed', 502)
  }
}
