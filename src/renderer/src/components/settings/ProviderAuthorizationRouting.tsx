import { useEffect, useState } from 'react'
import type {
  ProviderAuthorizationAccountPolicy,
  ProviderAuthorizationAccountView,
  ProviderAuthorizationQuotaView
} from '../../../../shared/provider-authorization-types'
import type { ProviderCredentialRoutingMode, ProviderView } from '../../../../shared/types'
import { useT } from '../../i18n'

interface ProviderAuthorizationRoutingProps {
  providerId: string
  accounts: ProviderAuthorizationAccountView[]
  mode: ProviderCredentialRoutingMode
  boundAccountId?: string
  disabled: boolean
  onAccountsChanged: (accounts: ProviderAuthorizationAccountView[]) => void
  onProviderChanged: (provider: ProviderView) => Promise<void>
  onQuotaLoaded: (accountId: string, quota: ProviderAuthorizationQuotaView) => void
}

export default function ProviderAuthorizationRouting({
  providerId,
  accounts,
  mode,
  boundAccountId,
  disabled,
  onAccountsChanged,
  onProviderChanged,
  onQuotaLoaded
}: ProviderAuthorizationRoutingProps): React.JSX.Element {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reloadAccounts = async (): Promise<void> => {
    onAccountsChanged(await window.agentDesk.listProviderAuthorizationAccounts(providerId))
  }

  const changeMode = async (nextMode: ProviderCredentialRoutingMode): Promise<void> => {
    await runMutation('', { kind: 'routing-mode', mode: nextMode })
  }

  const savePolicy = async (
    accountId: string,
    policy: Partial<ProviderAuthorizationAccountPolicy>
  ): Promise<void> => {
    await runMutation(accountId, { kind: 'account-policy', policy })
  }

  const runMutation = async (
    accountId: string,
    mutation: Parameters<typeof window.agentDesk.bindProviderAuthorizationAccount>[2]
  ): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const updated = await window.agentDesk.bindProviderAuthorizationAccount(providerId, accountId, mutation)
      await Promise.all([reloadAccounts(), onProviderChanged(updated)])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const refreshQuota = async (accountId: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const quota = await window.agentDesk.queryProviderAuthorizationQuota(providerId, accountId)
      onQuotaLoaded(accountId, quota)
      await reloadAccounts()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const controlsDisabled = disabled || busy
  return (
    <div className="provider-authorization-routing" data-provider-authorization-routing>
      <div className="provider-authorization-routing-head">
        <span>{t('providerAuthorizationRoutingMode')}</span>
        <div className="segmented-control" role="group" aria-label={t('providerAuthorizationRoutingMode')}>
          {(['manual', 'preferred', 'automatic'] as const).map((candidate) => (
            <button
              type="button"
              key={candidate}
              className={mode === candidate ? 'is-active' : ''}
              aria-pressed={mode === candidate}
              disabled={controlsDisabled}
              onClick={() => void changeMode(candidate)}
            >
              {t(`providerAuthorizationRoutingMode_${candidate}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="provider-authorization-routing-accounts">
        {accounts.map((account) => (
          <AuthorizationAccountPolicyRow
            key={account.id}
            account={account}
            busy={controlsDisabled}
            onSave={savePolicy}
            onRefreshQuota={refreshQuota}
            t={t}
          />
        ))}
      </div>
      {error && <div className="notice notice-error">{error}</div>}
    </div>
  )
}

function AuthorizationAccountPolicyRow({
  account,
  busy,
  onSave,
  onRefreshQuota,
  t
}: {
  account: ProviderAuthorizationAccountView
  busy: boolean
  onSave: (accountId: string, policy: Partial<ProviderAuthorizationAccountPolicy>) => Promise<void>
  onRefreshQuota: (accountId: string) => Promise<void>
  t: (key: string, params?: Record<string, string | number>) => string
}): React.JSX.Element {
  const [policy, setPolicy] = useState(account.policy)
  useEffect(() => setPolicy(account.policy), [account.policy])
  const persist = (): void => { void onSave(account.id, policy) }
  const remaining = account.quota?.status === 'ready' && account.quota.tiers.length > 0
    ? Math.max(0, 100 - Math.max(...account.quota.tiers.map((tier) => tier.utilization)))
    : undefined
  return (
    <div className={`provider-authorization-routing-account is-${account.routingState ?? 'available'}`}>
      <div className="provider-authorization-routing-identity">
        <label>
          <input
            type="checkbox"
            checked={policy.enabled}
            disabled={busy}
            onChange={(event) => {
              const next = { ...policy, enabled: event.target.checked }
              setPolicy(next)
              void onSave(account.id, next)
            }}
          />
          <strong>{account.label}</strong>
        </label>
        <span>{remaining === undefined
          ? t('providerAuthorizationQuotaUnknown')
          : t('providerAuthorizationQuotaRemaining', { value: Math.round(remaining) })}</span>
        <button
          type="button"
          className="icon-btn"
          disabled={busy || account.requiresReauth}
          aria-label={t('providerAuthorizationQuotaRefresh')}
          title={t('providerAuthorizationQuotaRefresh')}
          onClick={() => void onRefreshQuota(account.id)}
        >
          <span aria-hidden="true">&#8635;</span>
        </button>
      </div>
      <div className="provider-authorization-routing-policy">
        <label>
          <span>{t('providerAuthorizationPriority')}</span>
          <input
            className="input"
            type="number"
            min="1"
            max="100"
            value={policy.priority}
            disabled={busy}
            onChange={(event) => setPolicy({ ...policy, priority: Number(event.target.value) })}
            onBlur={persist}
          />
        </label>
        <label>
          <span>{t('providerAuthorizationQuotaReserve')}</span>
          <input
            className="input"
            type="number"
            min="0"
            max="100"
            value={policy.minimumQuotaRemainingPercent}
            disabled={busy}
            onChange={(event) => setPolicy({ ...policy, minimumQuotaRemainingPercent: Number(event.target.value) })}
            onBlur={persist}
          />
        </label>
        <label>
          <span>{t('providerAuthorizationCooldown')}</span>
          <input
            className="input"
            type="number"
            min="1"
            max="1440"
            value={policy.failureCooldownMinutes}
            disabled={busy}
            onChange={(event) => setPolicy({ ...policy, failureCooldownMinutes: Number(event.target.value) })}
            onBlur={persist}
          />
        </label>
        <label className="provider-authorization-known-quota">
          <input
            type="checkbox"
            checked={policy.requireKnownQuota}
            disabled={busy}
            onChange={(event) => {
              const next = { ...policy, requireKnownQuota: event.target.checked }
              setPolicy(next)
              void onSave(account.id, next)
            }}
          />
          <span>{t('providerAuthorizationRequireKnownQuota')}</span>
        </label>
      </div>
      <div className="provider-authorization-routing-reason">
        <span>{account.routingReason}</span>
        {account.quota && (
          <time dateTime={new Date(account.quota.queriedAt).toISOString()}>
            {t('providerAuthorizationLastVerified', { time: new Date(account.quota.queriedAt).toLocaleString() })}
          </time>
        )}
      </div>
    </div>
  )
}
