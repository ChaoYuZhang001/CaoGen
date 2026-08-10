import { CheckCircle2, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type {
  ProviderBillingReconciliationView,
  ProviderBillingStatementSource
} from '../../../../shared/provider-billing-types'
import type { ProviderBillingQueryCapabilityView } from '../../../../shared/provider-billing-query-types'
import type { ProviderView } from '../../../../shared/types'
import { formatCost } from '../../format'
import { useT } from '../../i18n'

export default function ProviderBillingReconciliation({
  providerId,
  providers,
  period
}: {
  providerId: string
  providers: Array<Pick<ProviderView, 'id' | 'name'>>
  period: { from: number; to: number }
}): React.JSX.Element {
  const t = useT()
  const [rows, setRows] = useState<ProviderBillingReconciliationView[]>([])
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [capability, setCapability] = useState<ProviderBillingQueryCapabilityView | null>(null)
  const [periodStart, setPeriodStart] = useState(toLocalInput(period.from))
  const [periodEnd, setPeriodEnd] = useState(toLocalInput(Math.min(period.to, Date.now())))
  const [amount, setAmount] = useState('')
  const [source, setSource] = useState<ProviderBillingStatementSource>('provider-console')
  const providerName = providers.find((provider) => provider.id === providerId)?.name ?? providerId

  const reload = useCallback(async (): Promise<void> => {
    if (!providerId) {
      setRows([])
      return
    }
    setLoading(true)
    setError('')
    try {
      setRows(await window.agentDesk.reconcileProviderBilling(providerId))
    } catch {
      setError(t('providerBillingUnavailable'))
    } finally {
      setLoading(false)
    }
  }, [providerId, t])

  const inspectCapability = useCallback(async (): Promise<void> => {
    if (!providerId) {
      setCapability(null)
      return
    }
    try {
      setCapability(await window.agentDesk.inspectProviderBillingQuery(providerId))
    } catch {
      setCapability({ providerId, supported: false })
    }
  }, [providerId])

  useEffect(() => { void Promise.all([reload(), inspectCapability()]) }, [inspectCapability, reload])
  useEffect(() => {
    if (editing) return
    setPeriodStart(toLocalInput(period.from))
    setPeriodEnd(toLocalInput(Math.min(period.to, Date.now())))
  }, [editing, period.from, period.to])

  const save = async (): Promise<void> => {
    const billedCostUsd = Number(amount)
    setLoading(true)
    setError('')
    setNotice('')
    try {
      await window.agentDesk.saveProviderBillingStatement({
        providerId,
        periodStart: new Date(periodStart).getTime(),
        periodEnd: new Date(periodEnd).getTime(),
        billedCostUsd,
        source
      })
      setEditing(false)
      setAmount('')
      await reload()
    } catch {
      setError(t('providerBillingSaveFailed'))
    } finally {
      setLoading(false)
    }
  }

  const remove = async (statementId: string): Promise<void> => {
    if (!window.confirm(t('providerBillingRemoveConfirm'))) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      await window.agentDesk.removeProviderBillingStatement(providerId, statementId)
      await reload()
    } catch {
      setError(t('providerBillingRemoveFailed'))
    } finally {
      setLoading(false)
    }
  }

  const syncOfficialBill = async (): Promise<void> => {
    const syncStart = period.from
    const syncEnd = Math.min(period.to, Date.now())
    if (!providerId || syncEnd <= syncStart) return
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const result = await window.agentDesk.syncProviderBillingStatement({
        providerId,
        periodStart: syncStart,
        periodEnd: syncEnd
      })
      if (result.status === 'ready') {
        setNotice(t('providerBillingSyncReady'))
        await reload()
      } else if (result.status === 'expired') {
        setError(t('providerBillingSyncExpired'))
      } else {
        setError(syncErrorMessage(result.errorCode, t))
      }
    } catch {
      setError(t('providerBillingSyncUnavailable'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="provider-billing-reconciliation" data-provider-billing-reconciliation aria-label={t('providerBillingTitle')}>
      <div className="provider-billing-head">
        <div>
          <h4>{t('providerBillingTitle')}</h4>
          <p>{providerId ? providerName : t('providerBillingSelectProvider')}</p>
        </div>
        <div className="provider-billing-actions">
          {capability?.supported && (
            <button
              type="button"
              className="btn btn-secondary btn-sm provider-billing-sync"
              disabled={!providerId || loading || Math.min(period.to, Date.now()) <= period.from}
              onClick={() => void syncOfficialBill()}
            >
              <RefreshCw size={14} aria-hidden="true" className={loading ? 'provider-usage-spin' : ''} />
              {loading ? t('providerBillingSyncing') : t('providerBillingSync')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon-sm"
            aria-label={t('providerBillingRefresh')}
            title={t('providerBillingRefresh')}
            disabled={!providerId || loading}
            onClick={() => void reload()}
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'provider-usage-spin' : ''} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon-sm"
            aria-label={t('providerBillingAdd')}
            title={t('providerBillingAdd')}
            disabled={!providerId || loading}
            onClick={() => setEditing((value) => !value)}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {editing && providerId && (
        <div className="provider-billing-form">
          <label>
            <span>{t('providerBillingPeriodStart')}</span>
            <input className="input" type="datetime-local" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
          </label>
          <label>
            <span>{t('providerBillingPeriodEnd')}</span>
            <input className="input" type="datetime-local" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
          </label>
          <label>
            <span>{t('providerBillingAmount')}</span>
            <input className="input" type="number" min="0" max="1000000000" step="0.000001" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>
          <label>
            <span>{t('providerBillingSource')}</span>
            <select className="select" value={source} onChange={(event) => setSource(event.target.value as ProviderBillingStatementSource)}>
              {(['provider-api', 'provider-console', 'invoice', 'balance-export', 'other'] as const).map((value) => (
                <option key={value} value={value} disabled={value === 'provider-api'}>{t(`providerBillingSource_${value}`)}</option>
              ))}
            </select>
          </label>
          <div className="provider-billing-form-actions">
            <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => setEditing(false)}>{t('cancel')}</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={loading || !amount || !periodStart || !periodEnd} onClick={() => void save()}>{t('save')}</button>
          </div>
        </div>
      )}

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {notice && <div className="notice notice-success" role="status">{notice}</div>}
      {providerId && capability && !capability.supported && !editing && (
        <div className="field-hint">{t('providerBillingSyncNotConfigured')}</div>
      )}
      {providerId && !editing && rows.length === 0 && !loading && (
        <div className="provider-billing-empty">{t('providerBillingEmpty')}</div>
      )}
      {rows.length > 0 && (
        <div className="provider-billing-list">
          {rows.map((row) => (
            <BillingReconciliationRow key={row.statement.id} row={row} disabled={loading} onRemove={remove} />
          ))}
        </div>
      )}
    </section>
  )
}

function BillingReconciliationRow({
  row,
  disabled,
  onRemove
}: {
  row: ProviderBillingReconciliationView
  disabled: boolean
  onRemove: (statementId: string) => Promise<void>
}): React.JSX.Element {
  const t = useT()
  const StatusIcon = row.status === 'matched' ? CheckCircle2 : TriangleAlert
  return (
    <article className={`provider-billing-row is-${row.status}`} data-provider-billing-status={row.status}>
      <div className="provider-billing-row-status">
        <StatusIcon size={15} aria-hidden="true" />
        <strong>{t(`providerBillingStatus_${row.status}`)}</strong>
        <span>{t(`providerBillingSource_${row.statement.source}`)}</span>
      </div>
      <div className="provider-billing-period">
        {formatDateTime(row.statement.periodStart)} - {formatDateTime(row.statement.periodEnd)}
      </div>
      <div className="provider-billing-values">
        <BillingValue label={t('providerBillingOfficial')} value={formatCost(row.statement.billedCostUsd)} />
        <BillingValue label={t('providerBillingLocal')} value={formatCost(row.localCostUsd)} />
        <BillingValue label={t('providerBillingDifference')} value={signedCost(row.differenceUsd)} />
        <BillingValue label={t('providerBillingRequests')} value={String(row.localRequests)} />
      </div>
      {row.incompleteReasons.length > 0 && (
        <div className="provider-billing-reasons">
          {row.incompleteReasons.map((reason) => <span key={reason}>{t(`providerBillingReason_${reason}`)}</span>)}
        </div>
      )}
      <button
        type="button"
        className="icon-btn provider-billing-remove"
        aria-label={t('providerBillingRemove')}
        title={t('providerBillingRemove')}
        disabled={disabled}
        onClick={() => void onRemove(row.statement.id)}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </article>
  )
}

function BillingValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function toLocalInput(value: number): string {
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

function signedCost(value: number): string {
  if (value === 0) return formatCost(0)
  return `${value > 0 ? '+' : '-'}${formatCost(Math.abs(value))}`
}

function syncErrorMessage(errorCode: string | undefined, t: ReturnType<typeof useT>): string {
  if (errorCode === 'billing_query_not_configured') return t('providerBillingSyncNotConfigured')
  if (errorCode === 'authorization_expired' || errorCode === 'credential_unavailable'
    || errorCode === 'billing_key_not_found') return t('providerBillingSyncExpired')
  if (errorCode === 'invalid_response') return t('providerBillingSyncInvalidResponse')
  if (errorCode === 'billing_endpoint_untrusted' || errorCode === 'cross_origin_response_blocked'
    || errorCode === 'redirect_blocked') return t('providerBillingSyncBlocked')
  if (errorCode === 'response_too_large' || errorCode === 'invalid_json') {
    return t('providerBillingSyncInvalidPayload')
  }
  return t('providerBillingSyncUnavailable')
}
