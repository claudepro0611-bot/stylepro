'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  fetchProdGroups, fetchProdItems, fetchProdLots, fetchProdStock, fetchProdWarehouses,
  type ProdItem, type ProdItemGroup, type ProdLot, type ProdStockRow, type ProdWarehouse,
} from '@/lib/production'

/** Items, warehouses and groups of the company (reference data for every production page). */
export function useProdRefs() {
  const [items, setItems] = useState<ProdItem[]>([])
  const [warehouses, setWarehouses] = useState<ProdWarehouse[]>([])
  const [groups, setGroups] = useState<ProdItemGroup[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const supabase = createClient()
    const [i, w, g] = await Promise.all([fetchProdItems(supabase), fetchProdWarehouses(supabase), fetchProdGroups(supabase)])
    setItems(i)
    setWarehouses(w)
    setGroups(g)
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const warehouseById = useMemo(() => new Map(warehouses.map(w => [w.id, w])), [warehouses])
  const groupById = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups])

  return { items, warehouses, groups, itemById, warehouseById, groupById, loading, reload }
}

/** Positive stock of one warehouse, keyed by item id. Empty until a warehouse is chosen. */
export function useWarehouseStock(warehouseId: string) {
  const [stock, setStock] = useState<Map<string, ProdStockRow>>(new Map())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!warehouseId) { setStock(new Map()); return }
    let cancelled = false
    setLoading(true)
    fetchProdStock(createClient(), { warehouseId, positiveOnly: true }).then(rows => {
      if (cancelled) return
      setStock(new Map(rows.map(r => [r.itemId, r])))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [warehouseId])

  return { stock, loading }
}

/**
 * FEFO-ordered lots with stock of one warehouse, keyed by item id.
 * available = false while prod_lot_stock does not exist (or the read failed):
 * forms then hide the lot picker and price lines at avg_cost as before.
 */
export function useWarehouseLots(warehouseId: string) {
  const [lotsByItem, setLotsByItem] = useState<Map<string, ProdLot[]>>(new Map())
  const [available, setAvailable] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!warehouseId) { setLotsByItem(new Map()); setAvailable(false); return }
    let cancelled = false
    setLoading(true)
    fetchProdLots(createClient(), { warehouseId }).then(lots => {
      if (cancelled) return
      const map = new Map<string, ProdLot[]>()
      for (const l of lots ?? []) {
        const arr = map.get(l.itemId)
        if (arr) arr.push(l)
        else map.set(l.itemId, [l])
      }
      setLotsByItem(map)
      setAvailable(lots !== null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [warehouseId])

  /** Lots of one item; null when lots are not available (avg-cost fallback). */
  const lotsOf = useCallback((itemId: string): ProdLot[] | null => (available ? lotsByItem.get(itemId) ?? [] : null), [available, lotsByItem])

  return { lotsOf, available, loading }
}
