'use client'

// "Audit jurnali": prod_audit_log (migration 20261110000017), append-only.
// Owner / admin only (proxy.ts redirects others; RLS returns 0 rows to them).
// Filters run server-side; each row expands into an old -> new diff and links
// to the document / master-data row it belongs to.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, History, ShieldAlert } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import { formatDateTime } from '@/lib/utils/formatters'
import { cn } from '@/lib/utils'
import { DateRangeFilter, type DateRangeValue } from '@/components/ui/date-range-filter'
import { monthToDate } from '@/components/reports/ReportKit'
import { FilterBar, PageHeader, TableCard, prodCardCls, prodFieldCls, tdCls, thCls, trCls } from '@/components/production/ProdKit'
import { ExpandChevron, ExportButton } from '@/components/production/ReportKit'
import { useControls, useRole } from '@/components/production/ControlKit'
import { downloadXlsx } from '@/lib/production-reports'
import { rangeToIsoBounds } from '@/lib/production'
import {
  AUDIT_ACTIONS, AUDIT_ENTITIES, AUDIT_PAGE, RULE_CODES, auditActionKey, auditDiffKeys, auditEntityHref, auditEntityKey,
  auditValue, fetchAuditLog, fillText, isOwnerAdminRole, ruleLabelKey, type AuditRow,
} from '@/lib/production-controls'

const actionTone = (a: string) =>
  a === 'override' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
    : a === 'cancel' || a === 'delete' ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
      : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'

export default function AuditLogPage() {
  const { t } = useLanguage()
  const role = useRole()
  const controls = useControls()
  const allowed = isOwnerAdminRole(role)

  const [range, setRange] = useState<DateRangeValue | null>(monthToDate)
  const [userId, setUserId] = useState('')
  const [entity, setEntity] = useState('')
  const [action, setAction] = useState('')
  const [rule, setRule] = useState('')
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  // Every user seen in any loaded page (the filter must not lose its options).
  const [users, setUsers] = useState<Map<string, string>>(() => new Map())

  const load = useCallback(async () => {
    setLoading(true)
    const bounds = range ? rangeToIsoBounds(range) : null
    const data = await fetchAuditLog(createClient(), {
      fromIso: bounds?.fromIso, toIso: bounds?.toIso,
      userId: userId || undefined, entity: entity || undefined, action: action || undefined, rule: rule || undefined,
    })
    const list = data ?? []
    setRows(list)
    setUsers(prev => {
      const next = new Map(prev)
      for (const r of list) if (r.userId && !next.has(r.userId)) next.set(r.userId, r.userName || '—')
      return next
    })
    setOpen(new Set())
    setLoading(false)
  }, [range, userId, entity, action, rule])

  useEffect(() => { if (allowed && controls.available) load() }, [allowed, controls.available, load])

  const userOptions = useMemo(() => [...users].sort((a, b) => a[1].localeCompare(b[1])), [users])

  function reset() {
    setRange(monthToDate())
    setUserId('')
    setEntity('')
    setAction('')
    setRule('')
  }

  function toggle(id: string) {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exportXlsx() {
    downloadXlsx('zavod_audit', [
      t('prodControls.audit.at'), t('prodControls.audit.user'), t('prodControls.audit.entity'), 'ID',
      t('prodControls.audit.action'), t('prodControls.audit.rule'), t('prodControls.audit.note'), t('prodControls.audit.changes'),
    ], rows.map(r => [
      formatDateTime(r.at), r.userName, t(auditEntityKey(r.entity)), r.entityId ?? '', t(auditActionKey(r.action)),
      r.rule ? t(ruleLabelKey(r.rule)) : '', r.note,
      auditDiffKeys(r).map(k => `${k}: ${auditValue(r.old?.[k])} → ${auditValue(r.new?.[k])}`).join('; '),
    ]), 'Audit')
  }

  if (!controls.loading && (!allowed || !controls.available)) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('prodControls.audit.title')} />
        <div className={cn(prodCardCls, 'flex items-center gap-3 p-6 text-sm text-gray-500 dark:text-gray-400')}>
          <ShieldAlert className="h-4 w-4 shrink-0 text-gray-400" />
          {!allowed ? t('prodControls.ownerAdminOnly') : t('prodControls.notAvailable')}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t('prodControls.audit.title')} subtitle={t('prodControls.audit.subtitle')} />

      <FilterBar onReset={reset} columns={<ExportButton onClick={exportXlsx} disabled={rows.length === 0} />}>
        <DateRangeFilter value={range} onChange={setRange} />
        <select value={userId} onChange={e => setUserId(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
          <option value="">{t('prodControls.audit.allUsers')}</option>
          {userOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={entity} onChange={e => setEntity(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
          <option value="">{t('prodControls.audit.allEntities')}</option>
          {AUDIT_ENTITIES.map(e => <option key={e} value={e}>{t(auditEntityKey(e))}</option>)}
        </select>
        <select value={action} onChange={e => setAction(e.target.value)} className={cn(prodFieldCls, 'w-44')}>
          <option value="">{t('prodControls.audit.allActions')}</option>
          {AUDIT_ACTIONS.map(a => <option key={a} value={a}>{t(auditActionKey(a))}</option>)}
        </select>
        <select value={rule} onChange={e => setRule(e.target.value)} className={cn(prodFieldCls, 'w-48')}>
          <option value="">{t('prodControls.audit.allRules')}</option>
          {RULE_CODES.map(r => <option key={r} value={r}>{t(ruleLabelKey(r))}</option>)}
        </select>
      </FilterBar>

      <TableCard loading={loading || controls.loading} empty={rows.length === 0} emptyText={t('prodControls.audit.empty')} emptyIcon={History}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
              <th className={cn(thCls, 'w-8')} />
              <th className={thCls}>{t('prodControls.audit.at')}</th>
              <th className={thCls}>{t('prodControls.audit.user')}</th>
              <th className={thCls}>{t('prodControls.audit.entity')}</th>
              <th className={thCls}>{t('prodControls.audit.action')}</th>
              <th className={thCls}>{t('prodControls.audit.rule')}</th>
              <th className={thCls}>{t('prodControls.audit.note')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const href = auditEntityHref(r.entity, r.entityId)
              const keys = auditDiffKeys(r)
              const isOpen = open.has(r.id)
              return (
                <Fragment key={r.id}>
                  <tr className={cn(trCls, keys.length > 0 && 'cursor-pointer')} onClick={() => keys.length > 0 && toggle(r.id)}>
                    <td className={tdCls}>
                      {keys.length > 0 && <ExpandChevron open={isOpen} onClick={() => toggle(r.id)} label={t('prodControls.audit.details')} />}
                    </td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{formatDateTime(r.at)}</td>
                    <td className={cn(tdCls, 'text-gray-900 dark:text-gray-100')}>{r.userName || '—'}</td>
                    <td className={tdCls}>
                      {href ? (
                        <Link
                          href={href}
                          onClick={e => e.stopPropagation()}
                          title={t('prodControls.audit.open')}
                          className="inline-flex items-center gap-1 font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                        >
                          {t(auditEntityKey(r.entity))} <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : (
                        <span className="text-gray-700 dark:text-gray-300">{t(auditEntityKey(r.entity))}</span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', actionTone(r.action))}>{t(auditActionKey(r.action))}</span>
                    </td>
                    <td className={cn(tdCls, 'whitespace-nowrap text-gray-500 dark:text-gray-400')}>{r.rule ? t(ruleLabelKey(r.rule)) : '—'}</td>
                    <td className={cn(tdCls, 'max-w-[320px] truncate text-gray-500 dark:text-gray-400')} title={r.note || undefined}>{r.note || '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-gray-50 dark:border-gray-800/60 bg-gray-50/60 dark:bg-gray-800/30">
                      <td />
                      <td colSpan={6} className="px-4 py-3">
                        <table className="w-full max-w-3xl text-[13px]">
                          <thead>
                            <tr className="text-gray-500 dark:text-gray-400">
                              <th className="py-1 pr-4 text-left font-medium">{t('prodControls.audit.field')}</th>
                              <th className="py-1 pr-4 text-left font-medium">{t('prodControls.audit.oldValue')}</th>
                              <th className="py-1 text-left font-medium">{t('prodControls.audit.newValue')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {keys.map(k => (
                              <tr key={k} className="align-top">
                                <td className="py-1 pr-4 font-mono text-[12px] text-gray-500 dark:text-gray-400">{k}</td>
                                <td className="py-1 pr-4 break-all text-red-700 dark:text-red-400">{auditValue(r.old?.[k])}</td>
                                <td className="py-1 break-all text-emerald-700 dark:text-emerald-400">{auditValue(r.new?.[k])}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </TableCard>
      {rows.length >= AUDIT_PAGE && (
        <p className="text-[12px] text-gray-400 dark:text-gray-500">{fillText(t('prodControls.audit.limitHint'), { n: AUDIT_PAGE })}</p>
      )}
    </div>
  )
}
