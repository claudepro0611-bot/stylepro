'use client'

// Glossary tooltip: <Term k="somo" /> renders the term (or the children) with
// a small help icon (only the icon with `bare`); hover or tap shows a short
// explanation (prodOps.glossary.*).

import type { ReactNode } from 'react'
import { CircleHelp } from 'lucide-react'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export const GLOSSARY_KEYS = [
  'somo', 'fifo', 'partiya', 'obrat', 'separatsiya', 'tannarx', 'ustama', 'debitorlik', 'kreditorlik', 'qqs',
  'yogBalansi', 'shartliQabul', 'karantin', 'inventarizatsiya', 'aktSverka', 'marja',
] as const
export type GlossaryKey = typeof GLOSSARY_KEYS[number]

export function Term({ k, children, className, bare }: { k: GlossaryKey; children?: ReactNode; className?: string; bare?: boolean }) {
  const { t } = useLanguage()
  const title = t(`prodOps.glossary.${k}.term` as TranslationKey)
  const text = t(`prodOps.glossary.${k}.text` as TranslationKey)
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {!bare && (children ?? title)}
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={150}
          render={(
            <button
              type="button"
              aria-label={`${t('prodOps.glossary.what')}: ${title}`}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            />
          )}
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="max-w-72 p-3">
          <p className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">{title}</p>
          <p className="mt-1 text-[12.5px] font-normal leading-relaxed text-gray-600 dark:text-gray-400">{text}</p>
        </PopoverContent>
      </Popover>
    </span>
  )
}
