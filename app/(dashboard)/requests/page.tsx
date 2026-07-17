'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { MessageSquare, CheckCircle, Clock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { StatCard } from '@/components/ui/StatCard'
import { Pagination } from '@/components/ui/Pagination'
import { MiniBadge } from '@/components/ui/MiniBadge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { formatDate } from '@/lib/utils/formatters'
import { useLanguage } from '@/lib/i18n/LanguageContext'
import type { TranslationKey } from '@/lib/i18n/translations'
import type { Request } from '@/lib/types'

const ITEMS_PER_PAGE = 10

interface RequestRow {
  id: string
  customer_id: string | null
  customer_name: string | null
  type: Request['type']
  priority: Request['priority']
  status: Request['status']
  message: string | null
  notes: string | null
  created_at: string
}

function mapRequest(row: RequestRow): Request {
  return {
    id: row.id,
    customerId: row.customer_id ?? '',
    customerName: row.customer_name ?? '',
    type: row.type,
    priority: row.priority,
    status: row.status,
    message: row.message ?? '',
    createdAt: row.created_at,
    notes: row.notes ?? '',
  }
}

const TYPE_LABEL_KEY: Record<string, TranslationKey> = {
  complaint: 'requests.typeLabel.complaint',
  inquiry: 'requests.typeLabel.inquiry',
  return: 'requests.typeLabel.return',
}

const STATUS_LABEL_KEY: Record<string, TranslationKey> = {
  new: 'requests.statusLabel.new',
  'in-progress': 'requests.statusLabel.inProgress',
  resolved: 'requests.statusLabel.resolved',
}

export default function RequestsPage() {
  const { t } = useLanguage()
  const [requests, setRequests] = useState<Request[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [statusFilter, setStatusFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [selectedRequest, setSelectedRequest] = useState<Request | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [newStatus, setNewStatus] = useState<Request['status']>('new')

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error } = await supabase
      .from('requests')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) {
      toast.error(t('common.error'))
    } else {
      setRequests((data as RequestRow[]).map(mapRequest))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  const filtered = useMemo(() => {
    let list = requests
    if (statusFilter !== 'all') list = list.filter(r => r.status === statusFilter)
    if (priorityFilter !== 'all') list = list.filter(r => r.priority === priorityFilter)
    if (typeFilter !== 'all') list = list.filter(r => r.type === typeFilter)
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [requests, statusFilter, priorityFilter, typeFilter])

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE)
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const totalCount = requests.length
  const resolvedToday = requests.filter(r => r.status === 'resolved' && r.createdAt.slice(0, 10) === today).length
  const pendingCount = requests.filter(r => r.status !== 'resolved').length

  function openDetail(r: Request) {
    setSelectedRequest(r)
    setNotes(r.notes)
    setNewStatus(r.status)
    setIsDetailOpen(true)
  }

  async function saveRequest() {
    if (!selectedRequest) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('requests')
      .update({ notes, status: newStatus })
      .eq('id', selectedRequest.id)
    setSaving(false)
    if (error) {
      toast.error(t('common.error'))
      return
    }
    setIsDetailOpen(false)
    toast.success(t('requests.toasts.updateSuccess'))
    fetchRequests()
  }

  const selectCls = 'h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-gray-700 dark:text-gray-300 outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors'

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('requests.title')}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t('requests.subtitle')}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title={t('requests.stats.total')} value={totalCount} icon={<MessageSquare className="h-4 w-4" />} />
        <StatCard title={t('requests.stats.resolvedToday')} value={resolvedToday} icon={<CheckCircle className="h-4 w-4" />} description={formatDate(today)} />
        <StatCard title={t('requests.stats.pending')} value={pendingCount} icon={<Clock className="h-4 w-4" />} description={t('requests.stats.pendingDesc')} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
          className={selectCls}
        >
          <option value="all">{t('requests.filters.allStatus')}</option>
          <option value="new">{t('requests.statusLabel.new')}</option>
          <option value="in-progress">{t('requests.statusLabel.inProgress')}</option>
          <option value="resolved">{t('requests.statusLabel.resolved')}</option>
        </select>
        <select
          value={priorityFilter}
          onChange={e => { setPriorityFilter(e.target.value); setPage(1) }}
          className={selectCls}
        >
          <option value="all">{t('requests.filters.allPriority')}</option>
          <option value="high">{t('requests.priorityLabel.high')}</option>
          <option value="medium">{t('requests.priorityLabel.medium')}</option>
          <option value="low">{t('requests.priorityLabel.low')}</option>
        </select>
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1) }}
          className={selectCls}
        >
          <option value="all">{t('requests.filters.allType')}</option>
          <option value="complaint">{t('requests.typeLabel.complaint')}</option>
          <option value="inquiry">{t('requests.typeLabel.inquiry')}</option>
          <option value="return">{t('requests.typeLabel.return')}</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-colors duration-200">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800/50">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="w-10 px-4 py-3">
                  <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('requests.table.id')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('requests.table.customer')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('requests.table.type')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('requests.table.priority')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('requests.table.status')}</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">{t('requests.table.date')}</th>
                <th className="px-4 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400">{t('requests.table.action')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                    {t('common.loading')}
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                    {t('requests.notFound')}
                  </td>
                </tr>
              ) : paginated.map((r, i) => (
                <tr
                  key={r.id}
                  onClick={() => openDetail(r)}
                  className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors ${i % 2 !== 0 ? 'bg-gray-50/50 dark:bg-gray-800/50' : ''}`}
                >
                  <td className="w-10 px-4 py-3" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" className="rounded border-gray-300 dark:border-gray-600 h-3.5 w-3.5" />
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px] font-semibold text-gray-600 dark:text-gray-300">{r.id}</td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{r.customerName}</td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t(TYPE_LABEL_KEY[r.type])}</td>
                  <td className="px-4 py-3"><MiniBadge status={r.priority} /></td>
                  <td className="px-4 py-3"><MiniBadge status={r.status} /></td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{formatDate(r.createdAt)}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={e => { e.stopPropagation(); openDetail(r) }}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    >
                      {t('requests.view')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          totalItems={filtered.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setPage}
        />
      </div>

      {/* Request Detail Modal */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="sm:max-w-md">
          {selectedRequest && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between gap-3">
                  <DialogTitle className="font-mono text-sm text-gray-700 dark:text-gray-300">
                    {selectedRequest.id}
                  </DialogTitle>
                  <MiniBadge status={selectedRequest.priority} />
                </div>
              </DialogHeader>

              <div className="mt-4 space-y-4">
                {/* Customer info */}
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 px-4 py-3 space-y-2">
                  {[
                    [t('requests.modal.customer'), selectedRequest.customerName],
                    [t('requests.modal.type'), t(TYPE_LABEL_KEY[selectedRequest.type])],
                    [t('requests.modal.date'), formatDate(selectedRequest.createdAt)],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-sm text-gray-400 dark:text-gray-500">{label}</span>
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{value}</span>
                    </div>
                  ))}
                </div>

                {/* Message */}
                <div>
                  <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('requests.modal.messageLabel')}</p>
                  <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm px-4 py-3 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                    {selectedRequest.message}
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('requests.modal.notesLabel')}</label>
                  <textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    rows={3}
                    placeholder={t('requests.modal.notesPlaceholder')}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none focus:border-gray-400 dark:focus:border-gray-500 bg-white dark:bg-gray-900 resize-none transition-colors"
                  />
                </div>

                {/* Status workflow */}
                <div>
                  <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t('requests.modal.statusChangeLabel')}</p>
                  <div className="flex gap-2">
                    {(['new', 'in-progress', 'resolved'] as Request['status'][]).map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setNewStatus(s)}
                        className={`flex-1 rounded-lg py-2 text-[12px] font-medium border transition-colors ${
                          newStatus === s
                            ? 'bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100'
                            : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                        }`}
                      >
                        {t(STATUS_LABEL_KEY[s])}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <DialogFooter className="mt-4">
                <Button onClick={saveRequest} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
