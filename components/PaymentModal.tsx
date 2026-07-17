'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { QRCodeSVG } from 'qrcode.react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface PaymentModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  monthlyFee: number
  onSuccess?: () => void
}

export function PaymentModal({ open, onOpenChange, monthlyFee, onSuccess }: PaymentModalProps) {
  const [paymentStep, setPaymentStep] = useState<'select' | 'card'>('select')
  const [paymentProvider, setPaymentProvider] = useState<'click' | 'payme'>('click')
  const [cardNumber, setCardNumber] = useState('')
  const [cardHolder, setCardHolder] = useState('')
  const [cardExpiry, setCardExpiry] = useState('')
  const [cardCvv, setCardCvv] = useState('')

  function handleOpenChange(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setPaymentStep('select')
      setPaymentProvider('click')
      setCardNumber('')
      setCardHolder('')
      setCardExpiry('')
      setCardCvv('')
    }
  }

  function handleCardPayment() {
    if (!cardNumber.trim() || !cardHolder.trim() || !cardExpiry.trim() || !cardCvv.trim()) {
      toast.error("Barcha maydonlarni to'ldiring")
      return
    }
    // TODO: Replace with real Click/Payme API
    toast.success("To'lov qabul qilindi (test rejim)")
    handleOpenChange(false)
    onSuccess?.()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>To&apos;lov</DialogTitle>
        </DialogHeader>
        {paymentStep === 'select' ? (
          <div className="space-y-3 mt-2">
            <div className="border border-gray-100 dark:border-gray-800 rounded-lg p-3 text-sm text-gray-500 dark:text-gray-400">
              Oylik to&apos;lov: <span className="font-semibold text-gray-800 dark:text-gray-200">{monthlyFee.toLocaleString()} UZS</span>
            </div>
            <button
              onClick={() => { setPaymentProvider('click'); setPaymentStep('card') }}
              className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Click orqali to&apos;lash
            </button>
            <button
              onClick={() => { setPaymentProvider('payme'); setPaymentStep('card') }}
              className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Payme orqali to&apos;lash
            </button>
          </div>
        ) : (
          <div className="mt-2">
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
                  value={`${paymentProvider}://pay?amount=${monthlyFee}&merchant=stylepro`}
                  size={150}
                  level="M"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-3 text-center">
                  {paymentProvider === 'click' ? 'Click' : 'Payme'} ilovasida skanerlang
                </p>
              </div>
            </div>

            <div className="space-y-3 mt-3">
              <div className="border border-gray-100 dark:border-gray-800 rounded-lg p-3 flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">To&apos;lov summasi</span>
                <span className="font-semibold text-gray-800 dark:text-gray-200">{monthlyFee.toLocaleString()} UZS</span>
              </div>

              <button
                onClick={handleCardPayment}
                className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-lg px-4 py-3 text-sm font-medium transition-colors"
              >
                To&apos;lash
              </button>

              <p className="text-xs text-center text-gray-400 dark:text-gray-500">Test rejim — real pul yechilmaydi</p>

              <button
                onClick={() => setPaymentStep('select')}
                className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Orqaga
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
