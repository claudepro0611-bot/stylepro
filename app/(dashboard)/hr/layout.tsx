'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useFeatures } from '@/lib/features'

export default function HrLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { features, loading } = useFeatures()

  useEffect(() => {
    if (!loading && !features.hr) router.push('/dashboard')
  }, [loading, features, router])

  if (loading || !features.hr) return null

  return <>{children}</>
}
