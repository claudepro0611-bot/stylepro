'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { QRCodeSVG } from 'qrcode.react'
import { createClient } from '@/lib/supabase/client'

interface PaymentBlockScreenProps {
  status: 'grace' | 'blocked'
  monthlyFee: number
  penaltyDays: number
  totalPenalty: number
}

export function PaymentBlockScreen({ status, monthlyFee, penaltyDays, totalPenalty }: PaymentBlockScreenProps) {
  const [step, setStep] = useState<'main' | 'select' | 'card'>('main')
  const [provider, setProvider] = useState<'click' | 'payme' | null>(null)
  const [cardNumber, setCardNumber] = useState('')
  const [cardHolder, setCardHolder] = useState('')
  const [cardExpiry, setCardExpiry] = useState('')
  const [cardCvv, setCardCvv] = useState('')

  if (status === 'grace') {
    return (
      <div className="bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900 px-4 py-2 text-center text-sm font-medium text-red-700 dark:text-red-400">
        Shartnoma asosida ishlayapsiz. Jarima: {penaltyDays} kun — {totalPenalty.toLocaleString()} UZS
      </div>
    )
  }

  const totalAmount = monthlyFee + totalPenalty

  function handleCardPayment() {
    if (!cardNumber.trim() || !cardHolder.trim() || !cardExpiry.trim() || !cardCvv.trim()) {
      toast.error("Barcha maydonlarni to'ldiring")
      return
    }
    // TODO: Replace with real Click/Payme API
    toast.success("To'lov qabul qilindi (test rejim)")
    window.location.reload()
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-white dark:bg-gray-950 flex items-center justify-center">
      <div className={step === 'card' ? 'max-w-2xl w-full text-center p-8' : 'max-w-md text-center p-8'}>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Tizim bloklangan</h1>
        <p className="text-gray-500 dark:text-gray-400 mb-6">To&apos;lov muddati tugadi</p>

        <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 mb-3 text-left">
          <div className="flex justify-between mb-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">Oylik to&apos;lov</span>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{monthlyFee.toLocaleString()} UZS</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Jarima ({penaltyDays} kun)</span>
            <span className="text-sm font-semibold text-red-600 dark:text-red-400">+{totalPenalty.toLocaleString()} UZS</span>
          </div>
          <div className="border-t border-gray-100 dark:border-gray-800 mt-2 pt-2 flex justify-between">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Jami to&apos;lov</span>
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {totalAmount.toLocaleString()} UZS
            </span>
          </div>
        </div>

        {step === 'main' && (
          <>
            <p className="text-sm text-gray-400 dark:text-gray-500">Admin bilan bog&apos;laning</p>

            <button
              onClick={() => setStep('select')}
              className="mt-4 w-full bg-slate-900 hover:bg-slate-800 text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
            >
              To&apos;lov qilish
            </button>

            <button
              onClick={async () => {
                const supabase = createClient()
                await supabase.auth.signOut()
                window.location.href = '/login'
              }}
              className="mt-4 text-sm text-gray-400 hover:text-gray-600 underline"
            >
              Chiqish
            </button>
          </>
        )}

        {step === 'select' && (
          <div className="space-y-2 mt-4">
            <button
              onClick={() => { setProvider('click'); setStep('card') }}
              className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Click orqali to&apos;lash
            </button>
            <button
              onClick={() => { setProvider('payme'); setStep('card') }}
              className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Payme orqali to&apos;lash
            </button>
            <button onClick={() => setStep('main')} className="w-full text-sm text-gray-400 dark:text-gray-500 mt-2">
              Orqaga
            </button>
          </div>
        )}

        {step === 'card' && (
          <div className="mt-4 text-left">
            <div className="grid grid-cols-2 gap-4 items-start">
              {/* Left - card form */}
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Karta raqami</p>
                  <input
                    type="text"
                    maxLength={19}
                    placeholder="0000 0000 0000 0000"
                    value={cardNumber}
                    onChange={e => setCardNumber(e.target.value.replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim())}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 text-sm font-mono bg-transparent text-gray-800 dark:text-gray-200 focus:border-gray-400 dark:focus:border-gray-500 focus:outline-none"
                  />
                </div>

                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">F.I.O</p>
                  <input
                    type="text"
                    placeholder="ABDUKHALIL SOBIROV"
                    value={cardHolder}
                    onChange={e => setCardHolder(e.target.value.toUpperCase())}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 text-sm bg-transparent text-gray-800 dark:text-gray-200 focus:border-gray-400 dark:focus:border-gray-500 focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Amal qilish muddati</p>
                    <input
                      type="text"
                      maxLength={5}
                      placeholder="MM/YY"
                      value={cardExpiry}
                      onChange={e => {
                        const val = e.target.value.replace(/\D/g, '')
                        setCardExpiry(val.length >= 2 ? val.slice(0, 2) + '/' + val.slice(2) : val)
                      }}
                      className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 text-sm font-mono bg-transparent text-gray-800 dark:text-gray-200 focus:border-gray-400 dark:focus:border-gray-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">CVV</p>
                    <input
                      type="password"
                      maxLength={3}
                      placeholder="***"
                      value={cardCvv}
                      onChange={e => setCardCvv(e.target.value.replace(/\D/g, ''))}
                      className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 text-sm font-mono bg-transparent text-gray-800 dark:text-gray-200 focus:border-gray-400 dark:focus:border-gray-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Right - QR code */}
              <div className="flex flex-col items-center justify-start border border-gray-200 dark:border-gray-700 rounded-lg p-4 h-full">
                <QRCodeSVG
                  value={`${provider ?? 'click'}://pay?amount=${totalAmount}&merchant=stylepro`}
                  size={150}
                  level="M"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-3 text-center">
                  {provider === 'click' ? 'Click' : 'Payme'} ilovasida skanerlang
                </p>
              </div>
            </div>

            <button
              onClick={handleCardPayment}
              className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors mt-3"
            >
              To&apos;lash
            </button>

            <p className="text-xs text-center text-gray-400 dark:text-gray-500 mt-3">Test rejim — real pul yechilmaydi</p>

            <button
              onClick={() => setStep('select')}
              className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors mt-3"
            >
              Orqaga
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
