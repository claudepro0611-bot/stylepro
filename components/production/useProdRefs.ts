'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  fetchProdGroups, fetchProdItems, fetchProdStock, fetchProdWarehouses,
  type ProdItem, type ProdItemGroup, type ProdStockRow, type ProdWarehouse,
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
