'use client'

// Ta'minot (supply agent cash): agents with balances, cash issue/return and
// spending moves. Writes go through supply_save_agent / supply_add_move only.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Banknote, Receipt, Search } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/helpers'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { formatDate } from '@/lib/utils/formatters'
import { localYmd } from '@/lib/utils/date'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { Pagination } from '@/components/ui/Pagination'
import { monthToDate } from '@/components/reports/ReportKit'
import {
  ColumnSettings, FilterBar, NoteField, PageHeader, Segmented, TableCard, useHiddenColumns,
  prodFieldCls, prodLabelCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { parseDecimal, round2 } from '@/lib/production'
import { AccountName, AccountSelect, useAccountChoice, useCashAccounts, useCashErrorText } from '@/components/production/CashKit'
import type { TranslationKey } from '@/lib/i18n/translations'

export type SupplyMoveKind = 'issue' | 'return' | 'expense'

export interface SupplyAgent {
  id: string
  name: string
  phone: string
  telegramId: string
  isActive: boolean
  createdAt: string
  issued: number
  returned: number
  spent: number
  balance: number
}

export function useSupplyAgents() {
  const [agents, setAgents] = useState<SupplyAgent[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    const supabase = createClient()
    const [agentsRes, balRes] = await Promise.all([
      supabase.from('supply_agents').select('id, name, phone, telegram_id, is_active, created_at').order('name'),
      supabase.from('supply_agent_balances').select('agent_id, issued, returned, spent, balance'),
    ])
    const bal = new Map((balRes.data ?? []).map(b => [b.agent_id, b]))
    setAgents((agentsRes.data ?? []).map(a => {
      const b = bal.get(a.id)
      return {
        id: a.id,
        name: a.name,
        phone: a.phone ?? '',
        telegramId: a.telegram_id ?? '',
        isActive: a.is_active,
        createdAt: a.created_at,
        issued: Number(b?.issued ?? 0),
        returned: Number(b?.returned ?? 0),
        spent: Number(b?.spent ?? 0),
        balance: Number(b?.balance ?? 0),
      }
    }))
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return { agents, loading, reload }
}

const KIND_KEY: Record<SupplyMoveKind, TranslationKey> = {
  issue: 'production.supply.kindIssue',
  return: 'production.supply.kindReturn',
  expense: 'production.supply.kindExpense',
}

interface MoveRow {
  id: string
  agent_id: string
  /** Cash & bank (migration 20261110000016); undefined before it. */
  account_id?: string | null
  kind: string
  amount: number
  purpose: string | null
  expense_category_id: string | null
  move_date: string
  note: string | null
  created_by_name: string | null
}

const PAGE_SIZE = 25

/** List page for either cash moves (issue/return) or spending (expense). */
export function SupplyMovesPage({ mode }: { mode: 'cash' | 'expense' }) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { agents, reload: reloadAgents } = useSupplyAgents()
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const { available: cashAvailable, accounts, reload: reloadAccounts } = useCashAccounts()
  const showAccount = mode === 'cash' && !!cashAvailable

  const [rows, setRows] = useState<MoveRow[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [agentId, setAgentId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialogOpen, setDialogOpen] = useState(false)

  const agentById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])
  const categoryById = useMemo(() => new Map(categories.map(c => [c.id, c.name])), [categories])

  useEffect(() => {
    if (mode !== 'expense') return
    createClient().from('expense_categories').select('id, name').order('name').then(({ data }) => setCategories(data ?? []))
  }, [mode])

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const kinds = mode === 'cash' ? ['issue', 'return'] : ['expense']
    const { data, error } = await fetchAllRows<MoveRow>((from, to) => {
      // select('*') so account_id comes along once migration 20261110000016 adds it.
      let q = supabase.from('supply_cash_moves').select('*').in('kind', kinds)
      if (range) q = q.gte('move_date', range.from).lte('move_date', range.to)
      if (agentId) q = q.eq('agent_id', agentId)
      return q.order('move_date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(from, to)
    })
    if (error) toast.error(t('productionErrors.unknown'))
    setRows(data)
    setPage(1)
    setLoading(false)
  }, [mode, range, agentId, t])

  useEffect(() => { load() }, [load])

  const { isVisible, toggle } = useHiddenColumns(mode === 'cash' ? 'taminot-pul' : 'taminot-sarf')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      (agentById.get(r.agent_id)?.name ?? '').toLowerCase().includes(q)
      || (r.purpose ?? '').toLowerCase().includes(q)
      || (r.note ?? '').toLowerCase().includes(q))
  }, [rows, search, agentById])

  const totals = useMemo(() => {
    const issued = filtered.filter(r => r.kind === 'issue').reduce((s, r) => s + Number(r.amount), 0)
    const returned = filtered.filter(r => r.kind === 'return').reduce((s, r) => s + Number(r.amount), 0)
    const spent = filtered.filter(r => r.kind === 'expense').reduce((s, r) => s + Number(r.amount), 0)
    return { issued, returned, spent, net: issued - returned }
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const columns = [
    ...(mode === 'cash' ? [{ key: 'kind', label: t('production.supply.kind') }] : [{ key: 'category', label: t('production.supply.category') }]),
    ...(showAccount ? [{ key: 'account', label: t('prodCash.common.account') }] : []),
    { key: 'purpose', label: t('production.supply.purpose') },
    { key: 'note', label: t('production.common.note') },
    { key: 'author', label: t('production.common.author') },
  ]

  function reset() {
    setRange(monthToDate())
    setAgentId('')
    setSearch('')
  }

  const colCount = 3 + columns.filter(c => isVisible(c.key)).length

  return (
    <div className="space-y-5">
      <PageHeader
        title={mode === 'cash' ? t('production.supply.cashTitle') : t('production.supply.expenseTitle')}
        subtitle={mode === 'cash' ? t('production.supply.cashSubtitle') : t('production.supply.expenseSubtitle')}
        actionLabel={mode === 'cash' ? t('production.supply.issueAction') : t('production.supply.expenseAction')}
        onAction={() => setDialogOpen(true)}
      />

      <FilterBar onReset={reset} columns={<ColumnSettings columns={columns} isVisible={isVisible} toggle={toggle} />}>
        <DateRangeFilter value={range} onChange={setRange} />
        <select value={agentId} onChange={e => setAgentId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
          <option value="">{t('production.supply.allAgents')}</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder={t('production.common.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.supply.movesEmpty')} emptyIcon={mode === 'cash' ? Banknote : Receipt}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.common.date')}</th>
              <th className={thCls}>{t('production.supply.agent')}</th>
              {mode === 'cash' && isVisible('kind') && <th className={thCls}>{t('production.supply.kind')}</th>}
              {mode === 'expense' && isVisible('category') && <th className={thCls}>{t('production.supply.category')}</th>}
              {showAccount && isVisible('account') && <th className={thCls}>{t('prodCash.common.account')}</th>}
              <th className={thRightCls}>{t('production.supply.amount')}</th>
              {isVisible('purpose') && <th className={thCls}>{t('production.supply.purpose')}</th>}
              {isVisible('note') && <th className={thCls}>{t('production.common.note')}</th>}
              {isVisible('author') && <th className={thCls}>{t('production.common.author')}</th>}
            </tr>
          </thead>
          <tbody>
            {paginated.map(r => (
              <tr key={r.id} className={trCls}>
                <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDate(r.move_date)}</td>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{agentById.get(r.agent_id)?.name ?? '—'}</td>
                {mode === 'cash' && isVisible('kind') && (
                  <td className={tdCls}>
                    <span className="inline-flex rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                      {t(KIND_KEY[r.kind as SupplyMoveKind] ?? KIND_KEY.issue)}
                    </span>
                  </td>
                )}
                {mode === 'expense' && isVisible('category') && (
                  <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{(r.expense_category_id && categoryById.get(r.expense_category_id)) || '—'}</td>
                )}
                {showAccount && isVisible('account') && <td className={tdCls}><AccountName accounts={accounts} id={r.account_id} /></td>}
                <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium', r.kind === 'return' ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100')}>
                  {r.kind === 'return' ? '−' : ''}{formatPrice(Number(r.amount))}
                </td>
                {isVisible('purpose') && <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>{r.purpose || '—'}</td>}
                {isVisible('note') && <td className={cn(tdCls, 'max-w-[220px] truncate text-gray-500 dark:text-gray-400')}>{r.note ?? ''}</td>}
                {isVisible('author') && <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{r.created_by_name ?? '—'}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            {mode === 'cash' ? (
              <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-900 dark:text-gray-100">
                <td colSpan={colCount} className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-x-6 gap-y-1">
                    <span>{t('production.supply.totalIssued')}: <b className="tabular-nums">{formatPrice(totals.issued)}</b></span>
                    <span>{t('production.supply.totalReturned')}: <b className="tabular-nums">{formatPrice(totals.returned)}</b></span>
                    <span>{t('production.supply.totalNet')}: <b className="tabular-nums">{formatPrice(totals.net)}</b></span>
                  </div>
                </td>
              </tr>
            ) : (
              <tr className="bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-900 dark:text-gray-100">
                <td colSpan={colCount} className="px-4 py-3 text-right">
                  {t('production.supply.totalSpent')}: <b className="tabular-nums">{formatPrice(totals.spent)}</b>
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </TableCard>
      {filtered.length > PAGE_SIZE && (
        <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} itemsPerPage={PAGE_SIZE} onPageChange={setPage} />
      )}

      <SupplyMoveDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={mode}
        agents={agents}
        categories={categories}
        onSaved={() => { setDialogOpen(false); load(); reloadAgents(); reloadAccounts() }}
      />
    </div>
  )
}

function SupplyMoveDialog({ open, onOpenChange, mode, agents, categories, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'cash' | 'expense'
  agents: SupplyAgent[]
  categories: { id: string; name: string }[]
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const [agentId, setAgentId] = useState('')
  const [kind, setKind] = useState<SupplyMoveKind>(mode === 'cash' ? 'issue' : 'expense')
  const [amount, setAmount] = useState('')
  const [purpose, setPurpose] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  // Cash & bank (migration 20261110000016): an issue takes money from, a return puts it into
  // an account (default: the cash desk). Spending is the agent's own cash: no account.
  const { available: cashAvailable, accounts, reload: reloadAccounts } = useCashAccounts()
  const [accountId, setAccountId] = useAccountChoice(open, accounts, 'cash')
  const errorText = useCashErrorText(accounts)
  const usesAccount = !!cashAvailable && kind !== 'expense'

  useEffect(() => { if (open && cashAvailable && mode === 'cash') reloadAccounts() }, [open, cashAvailable, mode, reloadAccounts])

  useEffect(() => {
    if (!open) return
    setAgentId('')
    setKind(mode === 'cash' ? 'issue' : 'expense')
    setAmount('')
    setPurpose('')
    setCategoryId('')
    setDate(localYmd())
    setNote('')
  }, [open, mode])

  const agent = agents.find(a => a.id === agentId)
  const value = round2(parseDecimal(amount))
  // 'return' and 'expense' may not take the balance below zero (RPC re-checks under a lock).
  const overBalance = kind !== 'issue' && !!agent && value > agent.balance

  async function save() {
    if (!agentId || value <= 0) { toast.error(t('productionErrors.invalid_input')); return }
    if (overBalance) { toast.error(t('productionErrors.negative_balance')); return }
    setSaving(true)
    const { error } = await createClient().rpc('supply_add_move', {
      p_data: {
        agent_id: agentId,
        kind,
        amount: value,
        purpose: purpose.trim() || null,
        expense_category_id: kind === 'expense' ? (categoryId || null) : null,
        move_date: date || localYmd(),
        note: note.trim() || null,
        ...(usesAccount && accountId ? { account_id: accountId } : {}),
      },
    })
    setSaving(false)
    if (error) { toast.error(errorText(error)); return }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'cash' ? t('production.supply.issueAction') : t('production.supply.expenseAction')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {mode === 'cash' && (
            <Segmented
              options={[
                { value: 'issue' as const, label: t('production.supply.kindIssue') },
                { value: 'return' as const, label: t('production.supply.kindReturn') },
              ]}
              value={kind === 'return' ? 'return' : 'issue'}
              onChange={setKind}
            />
          )}
          <label className="block">
            <span className={prodLabelCls}>{t('production.supply.agent')}</span>
            <select value={agentId} onChange={e => setAgentId(e.target.value)} className={prodFieldCls}>
              <option value="">{t('production.supply.selectAgent')}</option>
              {agents.filter(a => a.isActive).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {agent && (
              <span className="mt-1 block text-[12px] text-gray-500 dark:text-gray-400">
                {t('production.supply.balance')}: <span className="tabular-nums font-medium text-gray-900 dark:text-gray-100">{formatPrice(agent.balance)}</span>
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={prodLabelCls}>{t('production.supply.amount')}</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0"
                className={cn(prodFieldCls, 'tabular-nums', overBalance && 'border-red-300 dark:border-red-800')}
              />
            </label>
            <label className="block">
              <span className={prodLabelCls}>{t('production.common.date')}</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className={prodFieldCls} />
            </label>
          </div>
          {overBalance && <p className="text-[12px] text-red-600 dark:text-red-400">{t('productionErrors.negative_balance')}</p>}
          {usesAccount && (
            <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} outflow={kind === 'issue' ? value : undefined} />
          )}
          {kind === 'expense' && (
            <label className="block">
              <span className={prodLabelCls}>{t('production.supply.category')}</span>
              <select value={categoryId} onChange={e => setCategoryId(e.target.value)} className={prodFieldCls}>
                <option value="">{t('production.supply.noCategory')}</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label className="block">
            <span className={prodLabelCls}>{t('production.supply.purpose')}</span>
            <input value={purpose} onChange={e => setPurpose(e.target.value)} className={prodFieldCls} />
          </label>
          <NoteField value={note} onChange={setNote} />
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving || !agentId || value <= 0 || overBalance} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
