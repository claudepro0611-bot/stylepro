'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { translations, type Language, type TranslationKey } from './translations'

interface LanguageContextValue {
  language: Language
  setLanguage: (language: Language) => void
  t: (key: TranslationKey) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

const STORAGE_KEY = 'stylepro-language'

function resolve(dict: unknown, path: string): string | undefined {
  let node: unknown = dict
  for (const segment of path.split('.')) {
    if (!node || typeof node !== 'object' || !(segment in node)) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return typeof node === 'string' ? node : undefined
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>('uz')

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'uz' || stored === 'ru' || stored === 'en') setLanguageState(stored as Language)
  }, [])

  function setLanguage(next: Language) {
    setLanguageState(next)
    window.localStorage.setItem(STORAGE_KEY, next)
  }

  function t(key: TranslationKey): string {
    return resolve(translations[language], key) ?? key
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')
  return ctx
}
