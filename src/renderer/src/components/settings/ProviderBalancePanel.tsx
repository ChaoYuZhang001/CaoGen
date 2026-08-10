import { useCallback, useEffect, useState } from 'react'
import type {
  ProviderBalanceCapabilityView,
  ProviderBalanceItemView,
  ProviderBalanceView
} from '../../../../shared/provider-balance-types'
import type { ProviderView } from '../../../../shared/types'
import { useT } from '../../i18n'

export default function ProviderBalancePanel({ provider }: { provider: ProviderView }): React.JSX.Element {
  const t = useT()
  const [capability, setCapability] = useState<ProviderBalanceCapabilityView | null>(null)
  const [balance, setBalance] = useState<ProviderBalanceView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadCapability = useCallback(async (): Promise<void> => {
    try {
      setCapability(await window.agentDesk.inspectProviderBalance(provider.id))
    } catch {
      setCapability({ providerId: provider.id, supported: false })
    }
  }, [provider.id])

  const query = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.agentDesk.queryProviderBalance(provider.id)
      setBalance(result)
      if (result.status === 'unavailable' && result.errorCode) setError(balanceError(result.errorCode, t))
    } catch {
      setError(t('providerBalanceUnavailable'))
    } finally {
      setLoading(false)
    }
  }, [provider.id, t])

  useEffect(() => {
    void loadCapability()
  }, [loadCapability, provider.advancedConfig?.balanceQuery])

  useEffect(() => {
    if (capability?.supported) void query()
  }, [capability?.supported, query])

  return (
    <section className="provider-balance" aria-label={t('providerBalanceTitle')}>
      <div className="settings-section-head">
        <div>
          <h3 className="settings-h3">{t('providerBalanceTitle')}</h3>
          <p className="settings-hint">
            {capability?.supported
              ? `${capability.label ?? t('providerBalanceSupported')} - ${sourceLabel(capability, t)}${capability.keyLabel ? ` - ${capability.keyLabel}` : ''}`
              : t('providerBalanceUnsupported')}
          </p>
        </div>
        {capability?.supported && (
          <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void query()}>
            {loading ? t('providerBalanceLoading') : t('providerBalanceRefresh')}
          </button>
        )}
      </div>
      {!capability?.supported && <div className="provider-balance-state">{t('providerBalanceConfigureHint')}</div>}
      {capability?.supported && loading && !balance && <div className="provider-balance-state">{t('providerBalanceLoading')}</div>}
      {capability?.supported && balance?.status === 'ready' && balance.items.length > 0 && (
        <div className="provider-balance-items">
          {balance.items.map((item, index) => <BalanceItem key={`${item.label ?? 'balance'}:${index}`} item={item} t={t} />)}
        </div>
      )}
      {balance?.status === 'expired' && <div className="provider-balance-state is-warning">{t('providerBalanceExpired')}</div>}
      {balance?.status === 'unavailable' && !loading && !error && (
        <div className="provider-balance-state">{t('providerBalanceUnavailable')}</div>
      )}
      {error && <div className="provider-balance-state is-error">{error}</div>}
    </section>
  )
}

function BalanceItem({ item, t }: { item: ProviderBalanceItemView; t: (key: string, params?: Record<string, string | number>) => string }): React.JSX.Element {
  const value = item.remaining ?? item.total ?? item.used
  const amount = value === undefined ? t('providerBalanceNoValue') : `${formatNumber(value)}${item.unit ? ` ${item.unit}` : ''}`
  const detail = item.total !== undefined && item.used !== undefined
    ? `${t('providerBalanceUsed')}: ${formatNumber(item.used)}${item.unit ? ` ${item.unit}` : ''} / ${formatNumber(item.total)}${item.unit ? ` ${item.unit}` : ''}`
    : item.valid === false ? t('providerBalanceInvalid') : ''
  return (
    <div className="provider-balance-item">
      <div className="provider-balance-item-label">{item.label ?? t('providerBalanceDefaultLabel')}</div>
      <strong>{amount}</strong>
      {detail && <span>{detail}</span>}
    </div>
  )
}

function sourceLabel(capability: ProviderBalanceCapabilityView, t: (key: string, params?: Record<string, string | number>) => string): string {
  return capability.source === 'builtin' ? t('providerBalanceBuiltin') : t('providerBalanceCustom')
}

function balanceError(code: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (code === 'authorization_expired') return t('providerBalanceExpired')
  if (code === 'balance_key_not_found') return t('providerBalanceKeyMissing')
  if (code === 'unsupported_provider' || code === 'balance_endpoint_untrusted') return t('providerBalanceUnsupported')
  return t('providerBalanceUnavailable')
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value)
}
