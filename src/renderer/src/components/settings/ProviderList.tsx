import { useT } from '../../i18n'
import type {
  ProviderCredentialStorage,
  ProviderHealthView,
  ProviderView
} from '../../../../shared/types'

interface ProviderProbe {
  providerId: string
  ok: boolean
  message: string
}

interface Props {
  providers: ProviderView[]
  health: ProviderHealthView[]
  providerProbe: ProviderProbe | null
  checkingProviderId: string
  onAdd: () => void
  onProbe: (provider: ProviderView) => void
  onEdit: (provider: ProviderView) => void
  onRemove: (provider: ProviderView) => void
}

export default function ProviderList({
  providers,
  health,
  providerProbe,
  checkingProviderId,
  onAdd,
  onProbe,
  onEdit,
  onRemove
}: Props): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="settings-section-head">
        <h3 className="settings-h3">{t('tabProviders')}</h3>
        <button className="btn btn-ghost btn-sm" onClick={onAdd}>
          {t('addProvider')}
        </button>
      </div>
      <div className="provider-list">
        {providers.length === 0 && <div className="provider-empty">{t('providerEmpty')}</div>}
        {providers.map((provider) => (
          <ProviderListRow
            key={provider.id}
            provider={provider}
            health={health.find((item) => item.providerId === (provider.id || 'local-login'))}
            providerProbe={providerProbe}
            checking={checkingProviderId === provider.id}
            onProbe={onProbe}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        ))}
      </div>
    </>
  )
}

function ProviderListRow({
  provider,
  health,
  providerProbe,
  checking,
  onProbe,
  onEdit,
  onRemove
}: {
  provider: ProviderView
  health: ProviderHealthView | undefined
  providerProbe: ProviderProbe | null
  checking: boolean
  onProbe: (provider: ProviderView) => void
  onEdit: (provider: ProviderView) => void
  onRemove: (provider: ProviderView) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="provider-row">
      <div className="provider-row-body">
        <div className="provider-row-name">
          {provider.name}
          <ProviderCredentialTag provider={provider} />
          <ProviderHealthDot health={health} />
        </div>
        <div className="provider-row-sub">
          {provider.baseUrl || t('officialEndpoint')} · {t('modelsCount', { n: provider.models.length })} ·{' '}
          {providerCredentialSummary(provider, t)}
        </div>
        {provider.credentialMigrationRequired && (
          <div className="provider-probe-message provider-probe-bad">
            {t('providerCredentialMigrationNotice')}
          </div>
        )}
        {providerProbe?.providerId === provider.id && (
          <div
            className={`provider-probe-message ${providerProbe.ok ? 'provider-probe-ok' : 'provider-probe-bad'}`}
          >
            {providerProbe.message}
          </div>
        )}
      </div>
      <div className="provider-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={checking} onClick={() => onProbe(provider)}>
          {checking ? t('providerProbing') : t('providerProbe')}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onEdit(provider)}>
          {t('rename')}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => onRemove(provider)}>
          {t('delete')}
        </button>
      </div>
    </div>
  )
}

function ProviderCredentialTag({ provider }: { provider: ProviderView }): React.JSX.Element | null {
  const t = useT()
  const tagKey = providerCredentialTagKey(provider.credentialStorage)
  if (tagKey) return <span className="provider-tag-warn">{t(tagKey)}</span>
  if (!provider.hasToken) return <span className="provider-tag-warn">{t('noKeyConfigured')}</span>
  return null
}

function ProviderHealthDot({ health }: { health: ProviderHealthView | undefined }): React.JSX.Element | null {
  const t = useT()
  if (!health) return null
  const title = health.healthy
    ? t('healthOkTip', {
        s: health.successes,
        f: health.failures,
        latencyMs: health.latencyEmaMs ?? health.lastLatencyMs ?? '-'
      })
    : t('healthBadTip', {
        n: health.consecutiveFailures,
        error: health.recentFailures?.[0]?.message ?? health.lastError ?? '-'
      })
  return (
    <span
      className={`health-dot ${health.healthy ? 'health-ok' : 'health-bad'}`}
      title={title}
    />
  )
}

function providerCredentialSummary(provider: ProviderView, t: ReturnType<typeof useT>): string {
  if (provider.hasToken) {
    const activeLabel = provider.activeKeyLabel ? ` · ${provider.activeKeyLabel}` : ''
    return `${t('apiKeyCountLabel', { n: provider.keyCount ?? 1 })}${activeLabel}`
  }
  const tagKey = providerCredentialTagKey(provider.credentialStorage)
  return t(tagKey ?? 'noKeyConfigured')
}

function providerCredentialTagKey(storage: ProviderCredentialStorage): string | null {
  switch (storage) {
    case 'session':
      return 'providerCredentialSessionTag'
    case 'legacy-b64':
      return 'providerCredentialLegacyTag'
    case 'unavailable':
      return 'providerCredentialUnavailableTag'
    case 'mixed':
      return 'providerCredentialMixedTag'
    case 'none':
    case 'encrypted':
      return null
  }
}
