'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShoppingBag, User, Lock, Eye, EyeOff, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const email = `${username.trim().toLowerCase()}@stylepro.local`
    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    if (signInError) {
      setError("Login yoki parol noto'g'ri")
      setLoading(false)
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-8 shadow-sm">
      {/* Logo */}
      <div className="flex flex-col items-center gap-2.5">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-900 dark:bg-gray-100">
          <ShoppingBag className="h-5 w-5 text-white dark:text-gray-900" />
        </div>
        <div className="text-center">
          <p className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">StylePro</p>
          <p className="text-[12.5px] text-gray-400 dark:text-gray-500">Tizimga kirish</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-3.5">
        {/* Login field */}
        <div className="space-y-1.5">
          <label htmlFor="username" className="text-[12.5px] font-medium text-gray-700 dark:text-gray-300">
            Login
          </label>
          <div className="relative">
            <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
            <input
              id="username"
              type="text"
              placeholder="Login kiriting"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              className="h-10 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent pl-9 pr-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
            />
          </div>
        </div>

        {/* Password field */}
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-[12.5px] font-medium text-gray-700 dark:text-gray-300">
            Parol
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-10 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent pl-9 pr-10 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              aria-label={showPassword ? "Parolni yashirish" : "Parolni ko'rsatish"}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-sm font-medium text-white dark:text-gray-900 transition-colors hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Kirilmoqda...
            </>
          ) : (
            'Kirish'
          )}
        </button>

        {error && (
          <p className="text-center text-sm text-red-500">{error}</p>
        )}
      </form>
    </div>
  )
}
