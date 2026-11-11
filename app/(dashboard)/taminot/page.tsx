'use client'

import { useEffect, useMemo, useState } from 'react'
import { Banknote, Contact, Pencil, Search, Users, Wallet } from 'lucide-react'
import { toast } from '@/lib/toast'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { useCurrency } from '@/lib/currency/CurrencyContext'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { KpiGrid } from '@/components/reports/ReportKit'
import {
  ActiveBadge, FilterBar, PageHeader, TableCard, prodFieldCls, prodLabelCls, tdCls, thCls, thRightCls, trCls,
} from '@/components/production/ProdKit'
import { useSupplyAgents, type SupplyAgent } from '@/components/production/SupplyKit'
import { prodErrorKey } from '@/lib/production'

export default function SupplyAgentsPage() {
  const { t } = useLanguage()
  const { formatPrice } = useCurrency()
  const { agents, loading, reload } = useSupplyAgents()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SupplyAgent | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return agents
      .filter(a => !q || a.name.toLowerCase().includes(q) || a.phone.includes(q) || a.telegramId.includes(q))
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name))
  }, [agents, search])

  const totals = useMemo(() => ({
    balance: agents.reduce((s, a) => s + a.balance, 0),
    issued: agents.reduce((s, a) => s + a.issued, 0),
    active: agents.filter(a => a.isActive).length,
  }), [agents])

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('production.supply.agentsTitle')}
        subtitle={t('production.supply.agentsSubtitle')}
        actionLabel={t('production.supply.newAgent')}
        onAction={() => { setEditing(null); setFormOpen(true) }}
      />

      <KpiGrid items={[
        { label: t('production.supply.totalBalance'), value: formatPrice(totals.balance), icon: Wallet },
        { label: t('production.supply.totalIssued'), value: formatPrice(totals.issued), icon: Banknote },
        { label: t('production.supply.activeAgents'), value: String(totals.active), icon: Users },
      ]} />

      <FilterBar onReset={search ? () => setSearch('') : undefined}>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('production.common.search')} className={cn(prodFieldCls, 'pl-9')} />
        </div>
      </FilterBar>

      <TableCard loading={loading} empty={filtered.length === 0} emptyText={t('production.supply.agentsEmpty')} emptyIcon={Contact}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={thCls}>{t('production.supply.name')}</th>
              <th className={thCls}>{t('production.supply.phone')}</th>
              <th className={thCls}>{t('production.supply.telegramId')}</th>
              <th className={thRightCls}>{t('production.supply.balance')}</th>
              <th className={thCls}>{t('production.common.status')}</th>
              <th className={thRightCls}>{t('production.common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id} className={cn(trCls, !a.isActive && 'opacity-60')}>
                <td className={cn(tdCls, 'font-medium text-gray-900 dark:text-gray-100')}>{a.name}</td>
                <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{a.phone || '—'}</td>
                <td className={cn(tdCls, 'text-gray-500 dark:text-gray-400')}>{a.telegramId || '—'}</td>
                <td className={cn(tdCls, 'text-right tabular-nums whitespace-nowrap font-medium text-gray-900 dark:text-gray-100')}>{formatPrice(a.balance)}</td>
                <td className={tdCls}><ActiveBadge active={a.isActive} /></td>
                <td className={tdCls}>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => { setEditing(a); setFormOpen(true) }}
                      aria-label={t('production.common.edit')}
                      title={t('production.common.edit')}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>

      <AgentFormDialog open={formOpen} onOpenChange={setFormOpen} agent={editing} onSaved={() => { setFormOpen(false); reload() }} />
    </div>
  )
}

function AgentFormDialog({ open, onOpenChange, agent, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agent: SupplyAgent | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [telegramId, setTelegramId] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(agent?.name ?? '')
    setPhone(agent?.phone ?? '')
    setTelegramId(agent?.telegramId ?? '')
    setIsActive(agent?.isActive ?? true)
  }, [open, agent])

  async function save() {
    if (!name.trim()) { toast.error(t('production.common.nameRequired')); return }
    setSaving(true)
    const { error } = await createClient().rpc('supply_save_agent', {
      p_id: agent?.id ?? null,
      p_name: name.trim(),
      p_phone: phone.trim() || null,
      p_telegram_id: telegramId.trim() || null,
      p_is_active: isActive,
    })
    setSaving(false)
    if (error) { toast.error(t(prodErrorKey(error))); return }
    toast.success(t('production.common.saved'))
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{agent ? t('production.supply.editAgent') : t('production.supply.newAgent')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className={prodLabelCls}>{t('production.supply.name')}</span>
            <input value={name} onChange={e => setName(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.supply.phone')}</span>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+998 90 123 45 67" className={prodFieldCls} />
          </label>
          <label className="block">
            <span className={prodLabelCls}>{t('production.supply.telegramId')}</span>
            <input value={telegramId} onChange={e => setTelegramId(e.target.value)} className={prodFieldCls} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2.5">
            <span className="text-sm text-gray-700 dark:text-gray-300">{t('production.common.active')}</span>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </label>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('production.common.cancel')}</Button>
          <Button onClick={save} disabled={saving} loading={saving}>{t('production.common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
