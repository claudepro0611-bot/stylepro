import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Resolves the current user's company_id via the get_company_id() Postgres
 * function - required when inserting rows, since company_id is NOT NULL
 * and RLS only checks it after the row is built.
 */
export async function getCompanyId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_company_id')
  if (error) return null
  return (data as string | null) ?? null
}
