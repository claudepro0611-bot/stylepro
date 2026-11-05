import { Loader2 } from 'lucide-react'

// Shown instantly on navigation while the next page's route segment loads,
// so clicking a sidebar link gives immediate feedback instead of a pause.
export default function DashboardLoading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-gray-400 dark:text-gray-500" />
    </div>
  )
}
