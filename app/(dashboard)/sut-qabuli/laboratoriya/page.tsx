'use client'

// Lab tablet: queue of weighed intakes as big cards, then the touch lab entry
// (keypad, antibiotic Yo'q / Bor, decision). Route access: '/sut-qabuli'
// prefix (prod_milk) in proxy.ts; the lab itself needs prod_lab (checked in
// TabletLab and in prod_record_milk_lab). ?id=<intake> opens one directly.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TabletLab } from '@/components/production/MilkTablet'

export default function MilkLabTabletPage() {
  const router = useRouter()
  const [id, setId] = useState<string | null | undefined>(undefined)
  useEffect(() => { setId(new URLSearchParams(window.location.search).get('id')) }, [])
  if (id === undefined) return null
  return <TabletLab initialId={id} onExit={() => router.push('/sut-qabuli')} />
}
