interface StatCardProps {
  title: string
  value: string | number
  icon?: React.ReactNode
  description?: string
}

export function StatCard({ title, value, icon, description }: StatCardProps) {
  return (
    <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm p-5 transition-all duration-200 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{title}</p>
          <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100 tabular-nums leading-none">{value}</p>
          {description && (
            <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">{description}</p>
          )}
        </div>
        {icon && (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-100 dark:border-gray-700">
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}
