const UZBEK_MONTHS = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr',
]

export function formatUZS(amount: number): string {
  return new Intl.NumberFormat('ru-RU').format(amount) + ' UZS'
}

export function formatShortUZS(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)}K`
  return String(amount)
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return `${date.getDate()} ${UZBEK_MONTHS[date.getMonth()]}, ${date.getFullYear()}`
}

export function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day}.${month}.${date.getFullYear()} ${hours}:${minutes}`
}

export function formatDuration(startIso: string, endIso?: string | null): string {
  const start = new Date(startIso).getTime()
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '')
  if (d.length === 12) {
    return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)}-${d.slice(8, 10)}-${d.slice(10, 12)}`
  }
  return phone
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'VIP': return 'bg-purple-100 text-purple-700'
    case 'Regular': return 'bg-blue-100 text-blue-700'
    case 'New': return 'bg-green-100 text-green-700'
    case 'paid': return 'bg-green-100 text-green-700'
    case 'pending': return 'bg-yellow-100 text-yellow-700'
    case 'overdue': return 'bg-red-100 text-red-700'
    case 'active': return 'bg-green-100 text-green-700'
    case 'inactive': return 'bg-gray-100 text-gray-600'
    case 'ended': return 'bg-red-100 text-red-700'
    case 'completed': return 'bg-green-100 text-green-700'
    case 'cancelled': return 'bg-red-100 text-red-700'
    case 'new': return 'bg-blue-100 text-blue-700'
    case 'in-progress': return 'bg-yellow-100 text-yellow-700'
    case 'resolved': return 'bg-green-100 text-green-700'
    case 'expired': return 'bg-red-100 text-red-700'
    default: return 'bg-gray-100 text-gray-600'
  }
}

export function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'high': return 'bg-red-100 text-red-700'
    case 'medium': return 'bg-yellow-100 text-yellow-700'
    case 'low': return 'bg-green-100 text-green-700'
    default: return 'bg-gray-100 text-gray-600'
  }
}

export function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    VIP: 'VIP', Regular: 'Regular', New: 'Yangi',
    paid: "To'langan", pending: 'Kutilmoqda', overdue: "Muddati o'tgan",
    active: 'Faol', inactive: 'Nofaol', ended: 'Tugagan',
    completed: 'Bajarildi', cancelled: 'Bekor', new: 'Yangi',
    'in-progress': 'Jarayonda', resolved: 'Hal etildi', expired: 'Muddati o\'tgan',
    in: 'Kirim', out: 'Chiqim',
    complaint: 'Shikoyat', inquiry: "So'rov", return: 'Qaytarish',
    high: 'Yuqori', medium: "O'rta", low: 'Past',
  }
  return labels[status] ?? status
}
