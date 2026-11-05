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

const PAGE_SIZE = 1000

/**
 * Reads every row of a query in PAGE_SIZE chunks, since PostgREST silently
 * caps a single response at 1000 rows. `build(from, to)` must return the
 * query with a stable `.order()` and `.range(from, to)` applied.
 */
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) return { data: rows, error }
    const chunk = data ?? []
    rows.push(...chunk)
    if (chunk.length < PAGE_SIZE) return { data: rows, error: null }
  }
}
