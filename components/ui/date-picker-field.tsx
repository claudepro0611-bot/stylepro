'use client'

import { useState } from 'react'
import { CalendarIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { cn } from '@/lib/utils'

// Drop-in replacement for the app's plain `<input type="date" />` filter
// inputs, built on the installed Calendar (Combobox Dropdown Month/Year
// variant, see captionLayout="dropdown" below). Keeps the same
// string-in/string-out ('YYYY-MM-DD') value API every call site already
// used, so parent state/logic doesn't need to change.

interface DatePickerFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

function parseDate(value: string): Date | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function DatePickerField({ value, onChange, placeholder, className }: DatePickerFieldProps) {
  const [open, setOpen] = useState(false)
  const selected = parseDate(value)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            className={cn(
              'flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 text-[13px] text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors',
              className,
            )}
            type="button"
          />
        }
      >
        <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span className={cn(!selected && 'text-gray-400 dark:text-gray-500')}>
          {selected ? formatDate(selected) : (placeholder ?? '')}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-2">
        <Calendar
          captionLayout="dropdown"
          mode="single"
          onSelect={(date) => {
            if (date) onChange(formatDate(date))
            setOpen(false)
          }}
          selected={selected}
        />
      </PopoverContent>
    </Popover>
  )
}
