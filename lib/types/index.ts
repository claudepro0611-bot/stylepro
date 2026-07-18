export interface Purchase {
  id: string
  date: string
  amount: number
  items: string[]
  paymentMethod: string
}

export interface Customer {
  id: string
  fullName: string
  phone: string
  email: string
  address: string
  status: 'VIP' | 'Regular' | 'New'
  totalPurchases: number
  lastPurchaseDate: string
  createdAt: string
  purchases: Purchase[]
  complaints: string[]
}

export interface Product {
  id: string
  name: string
  sku: string
  category: string
  price: number
  description: string
  colors: string[]
  minStock: number
  imageUrl: string
  status: 'active' | 'inactive'
  warehouseId: string
}

export interface Warehouse {
  id: string
  companyId: string
  name: string
  type: 'clothing' | 'footwear'
}

export interface ProductSize {
  id: string
  productId: string
  productName: string
  category: string
  size: string
  stock: number
  purchasePrice: number
  sellingPrice: number
  sku: string
}

export interface TransactionItem {
  productId: string
  productName: string
  quantity: number
  price: number
}

export interface Transaction {
  id: string
  customerId: string
  customerName: string
  products: TransactionItem[]
  totalAmount: number
  date: string
  createdAt?: string
  paymentMethod: string
  invoiceId: string
  status: 'completed' | 'pending' | 'cancelled'
}

export interface InvoiceItem {
  productId: string
  productName: string
  quantity: number
  price: number
  total: number
}

export interface Invoice {
  id: string
  customerId: string
  customerName: string
  items: InvoiceItem[]
  subtotal: number
  discount: number
  total: number
  status: 'paid' | 'pending' | 'overdue'
  createdAt: string
  dueDate: string
}

export interface StockInEntry {
  id: string
  productId: string
  productName: string
  category: string
  size: string
  color: string
  quantity: number
  unitPrice: number
  totalAmount: number
  purchasePrice: number
  sellingPrice: number
  supplier: string
  date: string
  note: string
  productSizeId?: string
}

export interface StockOutEntry {
  id: string
  productId: string
  productName: string
  category: string
  size: string
  color: string
  quantity: number
  sellPrice: number
  totalAmount: number
  customerId: string
  customerName: string
  paymentMethod: string
  date: string
  note: string
}

export interface Campaign {
  id: string
  name: string
  type: 'coupon' | 'discount' | 'promo'
  status: 'active' | 'inactive' | 'ended'
  discount: number
  startDate: string
  endDate: string
  usageCount: number
  usageLimit: number
}

export interface Coupon {
  id: string
  code: string
  discount: number
  usageLimit: number
  usedCount: number
  expiryDate: string
  status: 'active' | 'inactive' | 'expired'
}

export interface Promotion {
  id: string
  name: string
  discountPercent: number
  scopeType: 'product' | 'category' | 'store'
  category: string | null
  startsOn: string | null
  endsOn: string | null
  isActive: boolean
}

export interface Request {
  id: string
  customerId: string
  customerName: string
  type: 'complaint' | 'inquiry' | 'return'
  priority: 'high' | 'medium' | 'low'
  status: 'new' | 'in-progress' | 'resolved'
  message: string
  createdAt: string
  notes: string
}

export interface ProductGroup {
  id: string
  name: string
  description: string
  productsCount: number
  status: 'active' | 'inactive'
  sizeType: import('@/lib/sizes').SizeType
}

export interface Department {
  id: string
  name: string
  managerId: string
  managerName: string
  description: string
  employeesCount: number
  status: 'active' | 'inactive'
}

export interface Position {
  id: string
  name: string
  departmentId: string
  departmentName: string
  employeesCount: number
  description: string
  status: 'active' | 'inactive'
}

export interface PositionHistoryEntry {
  id: string
  date: string
  positionName: string
  departmentName: string
  salary: number
  note: string
}

export interface Employee {
  id: string
  firstName: string
  lastName: string
  phone: string
  birthDate: string
  address: string
  positionId: string
  positionName: string
  departmentId: string
  departmentName: string
  salary: number
  startDate: string
  photoUrl: string
  status: 'active' | 'on-leave' | 'terminated'
  history: PositionHistoryEntry[]
}

export type RewardPenaltyKind = 'fixed' | 'percent' | 'oneTime' | 'perOccurrence' | 'perDay'

export interface RewardPenaltyTypeDef {
  id: string
  name: string
  amount: number
  kind: RewardPenaltyKind
  description: string
}

export interface Shift {
  id: string
  company_id: string
  cashier_id: string | null
  cashier_name: string | null
  started_at: string
  ended_at: string | null
  initial_cash: number
  total_sales: number
  total_amount: number
  cash_amount: number
  card_amount: number
  click_amount: number
  payme_amount: number
  status: 'active' | 'closed'
  created_at: string
}

export interface RewardPenaltyEntry {
  id: string
  employeeId: string
  employeeName: string
  departmentName: string
  type: 'reward' | 'penalty'
  typeId: string
  typeName: string
  amount: number
  date: string
  note: string
}
