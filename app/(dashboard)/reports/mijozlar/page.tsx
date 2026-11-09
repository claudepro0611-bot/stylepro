import { redirect } from 'next/navigation'

// The customers hub (list, filters, add-customer, customer drawer) lives at
// /customers — Mijozlar → Mijozlar in the sidebar. Old links land there.
export default function CustomersReportRedirect() {
  redirect('/customers')
}
