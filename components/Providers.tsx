'use client'

import { ThemeProvider } from 'next-themes'
import { LanguageProvider } from '@/lib/i18n/LanguageContext'
import { CurrencyProvider } from '@/lib/currency/CurrencyContext'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" themes={['dark', 'light']} enableSystem={false} storageKey="stylepro-theme">
      <LanguageProvider>
        <CurrencyProvider>
          {children}
        </CurrencyProvider>
      </LanguageProvider>
    </ThemeProvider>
  )
}
