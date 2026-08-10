import type {
  ProviderAuthorizationQuotaTierView,
  ProviderAuthorizationQuotaView
} from '../../../../shared/provider-authorization-types'
import { useT } from '../../i18n'

export default function ProviderAuthorizationQuota({
  authorized,
  quota,
  loading,
  error,
  onRefresh
}: {
  authorized: boolean
  quota: ProviderAuthorizationQuotaView | null
  loading: boolean
  error: string
  onRefresh: () => Promise<void>
}): React.JSX.Element | null {
  const t = useT()
  if (!authorized && quota?.status !== 'expired') return null
  return (
    <div className="provider-authorization-quota">
      <div className="provider-authorization-quota-head">
        <span>{t('providerAuthorizationQuotaTitle')}</span>
        <button
          type="button"
          className="icon-btn"
          disabled={loading || !authorized}
          aria-label={t('providerAuthorizationQuotaRefresh')}
          title={t('providerAuthorizationQuotaRefresh')}
          onClick={() => void onRefresh()}
        >
          <span className={loading ? 'provider-quota-refresh spin' : 'provider-quota-refresh'} aria-hidden="true">
            &#8635;
          </span>
        </button>
      </div>
      <QuotaStatus quota={quota} loading={loading} error={error} />
    </div>
  )
}

function QuotaStatus({
  quota,
  loading,
  error
}: {
  quota: ProviderAuthorizationQuotaView | null
  loading: boolean
  error: string
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      {loading && !quota && (
        <div className="provider-authorization-quota-state">{t('providerAuthorizationQuotaLoading')}</div>
      )}
      {(error || quota?.status === 'unavailable') && !loading && (
        <div className="provider-authorization-quota-state is-error">
          {error || t('providerAuthorizationQuotaUnavailable')}
        </div>
      )}
      {quota?.status === 'expired' && (
        <div className="provider-authorization-quota-state is-warning">
          {t('providerAuthorizationQuotaExpired')}
        </div>
      )}
      {quota?.status === 'ready' && quota.tiers.length === 0 && !loading && (
        <div className="provider-authorization-quota-state">{t('providerAuthorizationQuotaUnavailable')}</div>
      )}
      {quota?.status === 'ready' && quota.tiers.length > 0 && (
        <div className="provider-authorization-quota-tiers">
          {quota.tiers.map((tier) => <QuotaTier key={`${tier.name}:${tier.windowSeconds ?? 0}`} tier={tier} />)}
        </div>
      )}
    </>
  )
}

function QuotaTier({ tier }: { tier: ProviderAuthorizationQuotaTierView }): React.JSX.Element {
  const t = useT()
  const utilization = Math.round(Math.max(0, Math.min(100, tier.utilization)))
  const reset = quotaCountdown(tier.resetsAt)
  const labelKey = tier.name === 'five_hour'
    ? 'providerAuthorizationQuotaFiveHour'
    : tier.name === 'seven_day'
      ? 'providerAuthorizationQuotaSevenDay'
      : tier.name === 'thirty_day'
        ? 'providerAuthorizationQuotaThirtyDay'
        : 'providerAuthorizationQuotaWindow'
  return (
    <div className="provider-authorization-quota-tier">
      <div className="provider-authorization-quota-meta">
        <span>{t(labelKey, { name: tier.name })}</span>
        <span>{utilization}%{reset ? ` - ${t('providerAuthorizationQuotaResetsIn', { time: reset })}` : ''}</span>
      </div>
      <div className="provider-authorization-quota-track" aria-hidden="true">
        <span
          className={utilization >= 90 ? 'is-critical' : utilization >= 70 ? 'is-warning' : ''}
          style={{ width: `${utilization}%` }}
        />
      </div>
    </div>
  )
}

function quotaCountdown(resetsAt: number | undefined): string {
  if (!resetsAt) return ''
  const minutes = Math.floor((resetsAt - Date.now()) / 60_000)
  if (minutes <= 0) return ''
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
