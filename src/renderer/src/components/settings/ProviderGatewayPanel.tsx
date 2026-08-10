import { useEffect, useState } from 'react'
import { Check, Copy, KeyRound, Power, RefreshCw, Save } from 'lucide-react'
import type {
  ProviderGatewayModelView,
  ProviderGatewayStatusView
} from '../../../../shared/provider-gateway-types'
import { useT } from '../../i18n'

export default function ProviderGatewayPanel(): React.JSX.Element {
  const t = useT()
  const [status, setStatus] = useState<ProviderGatewayStatusView>()
  const [models, setModels] = useState<ProviderGatewayModelView[]>([])
  const [port, setPort] = useState('18457')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    setBusy('refresh'); setError('')
    try {
      const [nextStatus, nextModels] = await Promise.all([
        window.agentDesk.getProviderGatewayStatus(),
        window.agentDesk.listProviderGatewayModels()
      ])
      setStatus(nextStatus)
      setPort(String(nextStatus.port))
      setModels(nextModels)
    } catch (caught) {
      setError(errorText(caught, t('providerGatewayFailed')))
    } finally {
      setBusy('')
    }
  }

  useEffect(() => { void refresh() }, [])

  async function update(input: { enabled?: boolean; port?: number; regenerateToken?: boolean }, action: string): Promise<void> {
    setBusy(action); setError(''); setMessage('')
    try {
      const next = await window.agentDesk.updateProviderGateway(input)
      setStatus(next)
      setPort(String(next.port))
      if (input.regenerateToken) {
        await window.agentDesk.copyProviderGatewayToken()
        setMessage(t('providerGatewayCopied'))
      } else {
        setMessage(t('providerGatewayUpdated'))
      }
      setModels(await window.agentDesk.listProviderGatewayModels())
    } catch (caught) {
      setError(errorText(caught, t('providerGatewayFailed')))
    } finally {
      setBusy('')
    }
  }

  async function copyBaseUrl(value: string | undefined): Promise<void> {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setMessage(t('providerGatewayCopied')); setError('')
    } catch (caught) {
      setError(errorText(caught, t('providerGatewayFailed')))
    }
  }

  async function copyToken(): Promise<void> {
    setBusy('copy-token'); setError(''); setMessage('')
    try {
      await window.agentDesk.copyProviderGatewayToken()
      setMessage(t('providerGatewayCopied'))
    } catch (caught) {
      setError(errorText(caught, t('providerGatewayFailed')))
    } finally {
      setBusy('')
    }
  }

  const portNumber = Number(port)
  const validPort = Number.isSafeInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535
  const tokenLabel = status?.tokenStorage === 'encrypted'
    ? t('providerGatewayTokenReady')
    : status?.tokenStorage === 'session'
      ? t('providerGatewayTokenSession')
      : status?.tokenStorage === 'unavailable'
        ? t('providerGatewayTokenUnavailable')
        : t('providerGatewayTokenMissing')

  return (
    <section className="settings-section provider-gateway" data-provider-gateway>
      <div className="provider-gateway-head">
        <div>
          <h3 className="settings-h3">{t('providerGatewayTitle')}</h3>
          <div className="provider-gateway-state-line">
            <span className={`provider-gateway-state is-${status?.state ?? 'stopped'}`}>
              {t(`providerGatewayState_${status?.state ?? 'stopped'}`)}
            </span>
            <span>{t('providerGatewayActiveRequests')}: {status?.activeRequests ?? 0}</span>
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon-sm" disabled={Boolean(busy)} aria-label={t('providerGatewayRefresh')} title={t('providerGatewayRefresh')} onClick={() => void refresh()}>
          <RefreshCw size={15} className={busy === 'refresh' ? 'provider-gateway-spin' : ''} aria-hidden="true" />
        </button>
      </div>

      {status?.lastError && <div className="notice notice-error" role="alert">{status.lastError}</div>}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {message && <div className="notice notice-success" role="status"><Check size={14} aria-hidden="true" />{message}</div>}

      <div className="provider-gateway-controls">
        <label className="provider-gateway-toggle">
          <input type="checkbox" checked={status?.enabled ?? false} disabled={!status || Boolean(busy)} onChange={(event) => void update({ enabled: event.target.checked }, 'toggle')} />
          <Power size={15} aria-hidden="true" />
          <span>{t('providerGatewayEnabled')}</span>
        </label>

        <label className="provider-gateway-port">
          <span>{t('providerGatewayPort')}</span>
          <div>
            <input className="input" inputMode="numeric" value={port} disabled={!status || Boolean(busy)} onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))} />
            <button type="button" className="btn btn-secondary btn-icon-sm" disabled={!validPort || Boolean(busy) || portNumber === status?.port} aria-label={t('providerGatewayApplyPort')} title={t('providerGatewayApplyPort')} onClick={() => void update({ port: portNumber }, 'port')}>
              <Save size={14} aria-hidden="true" />
            </button>
          </div>
        </label>
      </div>

      <div className="provider-gateway-access">
        <label>
          <span>{t('providerGatewayOpenAiBaseUrl')}</span>
          <div>
            <code>{status?.baseUrl ?? '-'}</code>
            <button type="button" className="btn btn-ghost btn-icon-sm" disabled={!status} aria-label={t('providerGatewayCopyBaseUrl')} title={t('providerGatewayCopyBaseUrl')} onClick={() => void copyBaseUrl(status?.baseUrl)}><Copy size={14} aria-hidden="true" /></button>
          </div>
        </label>
        <label>
          <span>{t('providerGatewayGoogleBaseUrl')}</span>
          <div>
            <code>{status?.googleBaseUrl ?? '-'}</code>
            <button type="button" className="btn btn-ghost btn-icon-sm" disabled={!status} aria-label={t('providerGatewayCopyGoogleBaseUrl')} title={t('providerGatewayCopyGoogleBaseUrl')} onClick={() => void copyBaseUrl(status?.googleBaseUrl)}><Copy size={14} aria-hidden="true" /></button>
          </div>
        </label>
        <div className="provider-gateway-token-row">
          <div><span>{t('providerGatewayToken')}</span><strong>{tokenLabel}</strong></div>
          <div>
            <button type="button" className="btn btn-secondary" disabled={!status?.tokenConfigured || Boolean(busy)} onClick={() => void copyToken()}><Copy size={14} aria-hidden="true" />{t('providerGatewayCopyToken')}</button>
            <button type="button" className="btn btn-ghost" disabled={!status || Boolean(busy)} onClick={() => void update({ regenerateToken: true }, 'token')}><KeyRound size={14} aria-hidden="true" />{t('providerGatewayRegenerateToken')}</button>
          </div>
        </div>
      </div>

      <div className="provider-gateway-models">
        <div className="provider-gateway-models-head"><span>{t('providerGatewayModels')}</span><strong>{models.length}</strong></div>
        {models.length === 0 ? <div className="provider-gateway-empty">{t('providerGatewayNoModels')}</div> : (
          <div className="provider-gateway-table-wrap">
            <table>
              <thead><tr><th>{t('providerGatewayPublicId')}</th><th>{t('providerGatewayProtocol')}</th><th>{t('providerGatewayProvider')}</th><th>{t('providerGatewayModel')}</th></tr></thead>
              <tbody>{models.map((model) => <tr key={`${model.providerId}:${model.model}`}><td><code>{model.id}</code></td><td>{model.engine === 'gemini' ? 'Google' : 'OpenAI'}</td><td>{model.providerName}</td><td>{model.model}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
