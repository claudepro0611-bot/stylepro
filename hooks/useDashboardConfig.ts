'use client'

import { useLocalStorage } from '@/hooks/useLocalStorage'

export interface DashboardConfig {
  showMonthlyRevenue: boolean
  showTotalSales: boolean
  showLowStock: boolean
  showMonthlyGoal: boolean
  showTodaySales: boolean
  showDailyChart: boolean
  showTopProducts: boolean
  showRecentSales: boolean
}

export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  showMonthlyRevenue: true,
  showTotalSales: true,
  showLowStock: true,
  showMonthlyGoal: true,
  showTodaySales: true,
  showDailyChart: true,
  showTopProducts: true,
  showRecentSales: true,
}

export function useDashboardConfig() {
  return useLocalStorage<DashboardConfig>('stylepro-dashboard-config', DEFAULT_DASHBOARD_CONFIG)
}
