import { redirect } from 'next/navigation'

// The old "Tovarlar → Ombor" page duplicated Omborlar (warehouse CRUD and
// per-variant stock), so it was removed; keep old links/bookmarks working.
export default function InventoryRedirect() {
  redirect('/omborlar')
}
