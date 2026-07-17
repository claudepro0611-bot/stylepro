import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/Providers'
import { Toaster } from '@/components/ui/sonner'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })

export const metadata: Metadata = {
  title: 'StylePro — Kiyim Do\'koni CRM',
  description: "O'zbek kiyim do'konlari uchun professional CRM tizimi",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz" className={`${inter.variable} h-full`} suppressHydrationWarning>
      <body className="min-h-full antialiased bg-gray-50 dark:bg-gray-950">
        <Providers>
          {children}
          <Toaster position="top-right" />
        </Providers>
      </body>
    </html>
  )
}
