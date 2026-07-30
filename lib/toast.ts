// Drop-in replacement for the old `sonner` `toast(...)` API, backed by the
// installed @coss/toast primitives (see components/ui/toast.tsx). Every call
// site in the app used a plain-string `toast.success(msg)` /
// `toast.error(msg)` / `toast.info(msg)` / `toast.warning(msg)` /
// `toast.loading(msg)`, optionally with a sonner-style `{ description,
// duration }` second argument (no toast.promise), so this thin wrapper maps
// 1:1 onto `toastManager.add`.
import type React from 'react'
import { toastManager } from '@/components/ui/toast'

type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading'

interface ToastOptions {
  description?: React.ReactNode
  duration?: number
}

function show(type: ToastType | undefined, message: React.ReactNode, options?: ToastOptions) {
  return toastManager.add({
    title: message,
    type,
    description: options?.description,
    timeout: options?.duration,
  })
}

export const toast = Object.assign(
  (message: React.ReactNode, options?: ToastOptions) => show(undefined, message, options),
  {
    success: (message: React.ReactNode, options?: ToastOptions) => show('success', message, options),
    error: (message: React.ReactNode, options?: ToastOptions) => show('error', message, options),
    info: (message: React.ReactNode, options?: ToastOptions) => show('info', message, options),
    warning: (message: React.ReactNode, options?: ToastOptions) => show('warning', message, options),
    loading: (message: React.ReactNode, options?: ToastOptions) => show('loading', message, options),
    dismiss: (id?: string) => toastManager.close(id),
  },
)
