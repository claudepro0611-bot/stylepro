import { NextResponse, type NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'
import { fetchUsdRate } from '@/lib/exchange-rates/cbu'

export const dynamic = 'force-dynamic'

// Daily Vercel Cron: stores today's USD rate (CBU, or the market fallback) for every company. Existing rows
// for that date are left untouched, so a rate someone entered by hand wins.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let fetched
  try {
    fetched = await fetchUsdRate()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Rate request failed' }, { status: 502 })
  }

  const { data: companies, error: companiesError } = await supabaseServer.from('companies').select('id')
  if (companiesError) return NextResponse.json({ error: companiesError.message }, { status: 500 })

  const rows = (companies ?? []).map(c => ({
    company_id: c.id,
    currency: 'USD',
    rate: fetched.rate,
    rate_date: fetched.date,
    source: fetched.source,
  }))

  if (rows.length > 0) {
    const { error } = await supabaseServer
      .from('exchange_rates')
      .upsert(rows, { onConflict: 'company_id,currency,rate_date', ignoreDuplicates: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ...fetched, companies: rows.length })
}
