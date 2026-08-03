import { useState } from 'react'
import { AUTO_MODEL } from '../../../shared/types'
import type { ProviderView } from '../../../shared/types'
import { useT } from '../i18n'
import { PROVIDER_PRESETS, useStore } from '../store'

interface ProviderQuickSetupProps {
  onAdvanced: () => void
  onCancel: () => void
  onSaved: (provider: ProviderView) => void
}

export default function ProviderQuickSetup({ onAdvanced, onCancel, onSaved }: ProviderQuickSetupProps): React.JSX.Element {
  const t = useT()
  const createProvider = useStore((state) => state.createProvider)
  const activateLocalCompute = useStore((state) => state.activateLocalCompute)
  const updateSettings = useStore((state) => state.updateSettings)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [localBusy, setLocalBusy] = useState(false)
  const preset = PROVIDER_PRESETS.find((item) => item.key === 'caogen-relay')

  const connectLocal = async (): Promise<void> => {
    setLocalBusy(true)
    setError('')
    try {
      const result = await activateLocalCompute()
      if (result.status !== 'activated') {
        setError(t('providerQuickLocalUnavailable'))
        return
      }
      if (!result.provider) throw new Error(t('providerQuickLocalUnavailable'))
      onSaved(result.provider)
    } catch {
      setError(t('providerQuickLocalUnavailable'))
    } finally {
      setLocalBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    const nextToken = token.trim()
    if (!nextToken) {
      setError(t('providerQuickKeyRequired'))
      return
    }
    if (!preset) {
      setError(t('providerQuickUnavailable'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const discovery = await window.agentDesk.fetchProviderModels({
        baseUrl: preset.baseUrl,
        token: nextToken,
        openaiProtocol: preset.openaiProtocol ?? 'chat'
      })
      if (!discovery.ok || discovery.models.length === 0) {
        throw new Error(discovery.error?.message ?? t('providerQuickUnavailable'))
      }
      const created = await createProvider({
        name: t('providerQuickName'),
        baseUrl: preset.baseUrl,
        models: discovery.models,
        engine: preset.engine,
        openaiProtocol: preset.openaiProtocol ?? 'chat',
        token: nextToken,
        tokenLabel: t('providerQuickKeyLabel')
      })
      await updateSettings({
        defaultProviderId: created.id,
        defaultModel: AUTO_MODEL,
        smartModelRoutingEnabled: true
      })
      onSaved(created)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="provider-editor" aria-label={t('providerQuickTitle')} data-provider-quick-setup>
      <header className="provider-editor-header">
        <button type="button" className="provider-editor-back" aria-label={t('backToProviders')} title={t('backToProviders')} onClick={onCancel}>←</button>
        <h2 className="provider-editor-title">{t('providerQuickTitle')}</h2>
      </header>
      <div className="provider-quick-setup">
        <button
          type="button"
          className="btn btn-ghost provider-quick-local"
          disabled={localBusy || busy}
          onClick={() => void connectLocal()}
        >
          {localBusy ? t('assistantComputeCheckingLocal') : t('providerQuickUseLocal')}
        </button>
        <div className="provider-quick-divider"><span>{t('providerQuickOrKey')}</span></div>
        <div className="provider-quick-heading">
          <span className="provider-quick-badge">{t('providerQuickRecommended')}</span>
          <strong>{t('providerQuickName')}</strong>
        </div>
        <div className="provider-quick-endpoint">{preset?.baseUrl.replace(/^https?:\/\//, '')}</div>
        <label className="field-label" htmlFor="provider-quick-key">{t('apiKeyLabel')}</label>
        <input
          id="provider-quick-key"
          className="input input-block"
          type="password"
          autoComplete="off"
          value={token}
          placeholder={t('providerQuickKeyPlaceholder')}
          onChange={(event) => { setToken(event.target.value); setError('') }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void connect()
          }}
        />
        <a className="provider-quick-link" href={preset?.baseUrl} target="_blank" rel="noreferrer">{t('providerQuickGetKey')}</a>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
      </div>
      <div className="provider-editor-actions">
        <button
          className="btn btn-ghost"
          data-provider-quick-action="advanced"
          onClick={onAdvanced}
        >
          {t('providerQuickAdvanced')}
        </button>
        <button className="btn btn-primary" disabled={busy || localBusy} onClick={() => void connect()}>
          {busy ? t('providerQuickConnecting') : t('providerQuickConnect')}
        </button>
      </div>
    </section>
  )
}
