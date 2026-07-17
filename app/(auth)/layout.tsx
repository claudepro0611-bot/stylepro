export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F9FAFB] dark:bg-gray-950 px-4 transition-colors duration-200">
      {children}
    </div>
  )
}
