'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

const LOCAL_STORAGE_EVENT = 'stylepro-local-storage'

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(initialValue)
  const hydratedRef = useRef(false)

  // Hydrate from localStorage after mount
  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key)
      if (item !== null) setStoredValue(JSON.parse(item) as T)
    } catch {}
    hydratedRef.current = true
  }, [key])

  // Cross-tab / cross-component sync
  useEffect(() => {
    const handleChange = (e: Event) => {
      if (e instanceof StorageEvent && e.key !== null && e.key !== key) return
      try {
        const item = window.localStorage.getItem(key)
        if (item !== null) {
          const parsed = JSON.parse(item) as T
          // Return prev if serialised value unchanged — prevents self-triggered loops
          setStoredValue(prev => (JSON.stringify(prev) === item ? prev : parsed))
        }
      } catch {}
    }
    window.addEventListener('storage', handleChange)
    window.addEventListener(LOCAL_STORAGE_EVENT, handleChange)
    return () => {
      window.removeEventListener('storage', handleChange)
      window.removeEventListener(LOCAL_STORAGE_EVENT, handleChange)
    }
  }, [key])

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue(prev => {
        const next = value instanceof Function ? value(prev) : value
        // Defer side-effects so they never fire during React's render phase
        queueMicrotask(() => {
          if (!hydratedRef.current) return
          try {
            window.localStorage.setItem(key, JSON.stringify(next))
            window.dispatchEvent(new Event(LOCAL_STORAGE_EVENT))
          } catch {}
        })
        return next
      })
    },
    [key],
  )

  return [storedValue, setValue]
}
