import type { TranslationKey } from '@/lib/i18n/translations'

export type WarehouseType = 'clothing' | 'footwear' | 'accessory' | 'general' | 'other'

export const WAREHOUSE_TYPE_LABEL_KEYS: Record<WarehouseType, TranslationKey> = {
  clothing: 'warehouseTypes.clothing',
  footwear: 'warehouseTypes.footwear',
  accessory: 'warehouseTypes.accessory',
  general: 'warehouseTypes.general',
  other: 'warehouseTypes.other',
}

// Offered when creating a new warehouse. 'other' is deliberately excluded
// here (but stays a valid, already-stored value for backward compatibility)
// since 'general' now covers the same intent with a clearer name.
export const CREATABLE_WAREHOUSE_TYPES: WarehouseType[] = ['clothing', 'footwear', 'accessory', 'general']
