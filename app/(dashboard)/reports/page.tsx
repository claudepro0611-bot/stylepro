import { redirect } from 'next/navigation'

// The Hisobotlar sidebar group now points at two dedicated report pages
// (moliya/inventar). This route has no content of its own anymore — same
// bare server-side redirect() convention as app/page.tsx.
export default function ReportsPage() {
  redirect('/reports/moliya')
}
