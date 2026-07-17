'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export interface CompanyFormValues {
  name: string
  login: string
  password: string
  phone: string
  address: string
  status: 'active' | 'inactive'
  userLimit: number
  warehouseLimit: number
}

export const emptyCompanyForm: CompanyFormValues = {
  name: '',
  login: '',
  password: '',
  phone: '',
  address: '',
  status: 'active',
  userLimit: 1,
  warehouseLimit: 2,
}

const inputCls = 'w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

interface CompanyFormFieldsProps {
  values: CompanyFormValues
  onChange: (values: CompanyFormValues) => void
  mode: 'create' | 'edit'
}

export function CompanyFormFields({ values, onChange, mode }: CompanyFormFieldsProps) {
  const [showPassword, setShowPassword] = useState(false)

  function set<K extends keyof CompanyFormValues>(key: K, value: CompanyFormValues[K]) {
    onChange({ ...values, [key]: value })
  }

  return (
    <div className="space-y-4 mt-2">
      <div>
        <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Firma nomi</label>
        <input
          value={values.name}
          onChange={e => set('name', e.target.value)}
          className={inputCls}
          placeholder="Masalan: Bahor Fashion"
        />
      </div>

      {mode === 'create' && (
        <>
          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Login</label>
            <input
              value={values.login}
              onChange={e => set('login', e.target.value.replace(/[^a-zA-Z0-9]/g, ''))}
              className={inputCls}
              placeholder="masalan: bahorfashion"
            />
            <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
              Email: {(values.login || 'login').toLowerCase()}@stylepro.local
            </p>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Parol</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={values.password}
                onChange={e => set('password', e.target.value)}
                className={`${inputCls} pr-9`}
                placeholder="Kamida 8 belgi"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                aria-label={showPassword ? 'Parolni yashirish' : "Parolni ko'rsatish"}
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </>
      )}

      <div>
        <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Telefon</label>
        <input
          value={values.phone}
          onChange={e => set('phone', e.target.value)}
          className={inputCls}
          placeholder="+998 90 123 45 67"
        />
      </div>

      <div>
        <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">Manzil</label>
        <input
          value={values.address}
          onChange={e => set('address', e.target.value)}
          className={inputCls}
          placeholder="Shahar, ko'cha, uy"
        />
      </div>

      {mode === 'create' && (
        <div>
          <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1">
            Firma nechta ombor yarata olsin
          </label>
          <input
            type="number"
            min={1}
            max={100}
            value={values.warehouseLimit}
            onChange={e => set('warehouseLimit', Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
            className={inputCls}
            placeholder="2"
          />
        </div>
      )}

      <div>
        <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-2">Status</label>
        <div className="flex gap-2">
          {(['active', 'inactive'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => set('status', s)}
              className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${
                values.status === s
                  ? 'bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {s === 'active' ? 'Faol' : 'Nofaol'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
