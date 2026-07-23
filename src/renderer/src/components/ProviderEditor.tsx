import { useMemo, useState } from 'react'
import { PROVIDER_PRESETS, useStore } from '../store'
import { useT } from '../i18n'
import type {
  EngineKind,
  OpenAIProtocol,
  ProviderApiKeyInput,
  ProviderApiKeyUpdateInput,
  ProviderApiKeyView,
  ProviderCredentialStorage,
  ProviderView
} from '../../../shared/types'
import ProviderSavedKeys from './settings/ProviderSavedKeys'
import type { ProviderKeyDraft } from './settings/ProviderSavedKeys'

interface Props {
  /** null = 新建;否则编辑该 Provider */
  provider: ProviderView | null
  onClose: () => void
}
export default function ProviderEditor({ provider, onClose }: Props): React.JSX.Element {
  const t = useT()
  const createProvider = useStore((s) => s.createProvider)
  const updateProvider = useStore((s) => s.updateProvider)
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [modelsText, setModelsText] = useState((provider?.models ?? []).join('\n'))
  const [engine, setEngine] = useState<EngineKind>(provider?.engine ?? 'openai')
  const [customHeaders, setCustomHeaders] = useState(provider?.customHeaders ?? '')
  const [credentialHeaderNamesText, setCredentialHeaderNamesText] = useState(
    (provider?.credentialHeaderNames ?? []).join('\n')
  )
  const [budgetUsd, setBudgetUsd] = useState(provider?.budgetUsd ? String(provider.budgetUsd) : '')
  const [openaiProtocol, setOpenaiProtocol] = useState<OpenAIProtocol>(provider?.openaiProtocol ?? 'responses')
  const [note, setNote] = useState(provider?.note ?? '')
  const [token, setToken] = useState('')
  const [tokenLabel, setTokenLabel] = useState(provider?.activeKeyLabel ?? '')
  const [tokenTouched, setTokenTouched] = useState(false)
  const [additionalKeysText, setAdditionalKeysText] = useState('')
  const [activeKeyId, setActiveKeyId] = useState(provider?.activeKeyId ?? '')
  const [keyDrafts, setKeyDrafts] = useState<Record<string, ProviderKeyDraft>>(() =>
    Object.fromEntries(
      (provider?.apiKeys ?? []).map((key) => [
        key.id,
        { label: key.label, disabled: key.disabled, remove: false }
      ])
    )
  )
  const [presetHint, setPresetHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchNote, setFetchNote] = useState('')
  const [modelSourceKey, setModelSourceKey] = useState(() =>
    provider ? providerModelSourceKey(provider.id, provider.baseUrl, provider.openaiProtocol ?? 'responses') : ''
  )

  const isEdit = provider !== null
  const savedKeys = provider?.apiKeys ?? []

  const currentModelSourceKey = useMemo(
    () => providerModelSourceKey(provider?.id, baseUrl, openaiProtocol),
    [provider?.id, baseUrl, openaiProtocol]
  )
  const modelsStale = modelsText.trim().length > 0 && modelSourceKey !== '' && modelSourceKey !== currentModelSourceKey

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    setError('')
    setFetchNote('')
    try {
      const result = await window.agentDesk.fetchProviderModels({
        baseUrl: baseUrl.trim(),
        token: token.trim() || undefined,
        providerId: provider?.id,
        customHeaders: customHeaders.trim() || undefined,
        credentialHeaderNames: parseCredentialHeaderNames(credentialHeaderNamesText),
        openaiProtocol
      })
      if (!result.ok) {
        setModelSourceKey('')
        setFetchNote(t('modelListStaleAfterFailure', { baseUrl: result.baseUrl || baseUrl.trim() }))
        setError(result.error?.message ?? t('fetchModelsFailed'))
        return
      }
      setModelsText(result.models.join('\n'))
      setModelSourceKey(result.cacheKey)
      setFetchNote(t('fetchedModelsFrom', {
        n: result.models.length,
        baseUrl: result.baseUrl,
        latencyMs: result.latencyMs ?? 0
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setFetching(false)
    }
  }

  const applyPreset = (key: string): void => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === key)
    if (!preset) return
    setPresetHint(preset.hint)
    if (preset.key === 'custom') return
    if (!name.trim()) setName(preset.label)
    setBaseUrl(preset.baseUrl)
    setModelsText(preset.models.join('\n'))
    setEngine(preset.engine)
    setOpenaiProtocol(preset.openaiProtocol ?? 'responses')
    setModelSourceKey(providerModelSourceKey(provider?.id, preset.baseUrl, preset.openaiProtocol ?? 'responses'))
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError(t('errNameRequired'))
      return
    }
    const models = modelsText
      .split('\n')
      .map((m) => m.trim())
      .filter(Boolean)
    const budget = Number(budgetUsd)
    const additionalTokens = parseAdditionalKeys(additionalKeysText)
    const keyUpdates = buildKeyUpdates(savedKeys, keyDrafts)
    const removeKeyIds = savedKeys
      .filter((key) => keyDrafts[key.id]?.remove)
      .map((key) => key.id)
    const requestedActiveKeyId = activeKeyId && !removeKeyIds.includes(activeKeyId) ? activeKeyId : undefined
    const tokenLabelPatch = tokenLabel.trim()
    setBusy(true)
    setError('')
    try {
      if (isEdit) {
        await updateProvider(provider.id, {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          models,
          engine,
          customHeaders: customHeaders.trim(),
          credentialHeaderNames: parseCredentialHeaderNames(credentialHeaderNamesText),
          budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
          openaiProtocol,
          note: note.trim(),
          // token 未改动则不传,避免清空已存密钥
          ...(tokenTouched ? { token, tokenLabel: tokenLabelPatch } : tokenLabelPatch ? { tokenLabel: tokenLabelPatch } : {}),
          ...(additionalTokens.length > 0 ? { additionalTokens } : {}),
          ...(keyUpdates.length > 0 ? { keyUpdates } : {}),
          ...(removeKeyIds.length > 0 ? { removeKeyIds } : {}),
          ...(requestedActiveKeyId ? { activeKeyId: requestedActiveKeyId } : {})
        })
      } else {
        await createProvider({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          models,
          engine,
          customHeaders: customHeaders.trim(),
          credentialHeaderNames: parseCredentialHeaderNames(credentialHeaderNamesText),
          budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
          openaiProtocol,
          note: note.trim(),
          token,
          tokenLabel: tokenLabelPatch,
          ...(additionalTokens.length > 0 ? { additionalTokens } : {})
        })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <section className="provider-editor" aria-label={isEdit ? t('providerEditTitle') : t('providerAddTitle')}>
        <header className="provider-editor-header">
          <button
            type="button"
            className="provider-editor-back"
            aria-label={t('backToProviders')}
            title={t('backToProviders')}
            onClick={onClose}
          >
            ←
          </button>
          <h2 className="provider-editor-title">{isEdit ? t('providerEditTitle') : t('providerAddTitle')}</h2>
        </header>

        {!isEdit && (
          <>
            <label className="field-label">{t('quickTemplate')}</label>
            <select className="select select-block" defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
              <option value="" disabled>
                {t('pickTemplate')}
              </option>
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="provider-gateway-note">
              {t('gatewayNote1')}
              <b>{t('gatewayNoteBold')}</b>
              {t('gatewayNote2')}
            </p>
          </>
        )}

        {presetHint && <div className="notice notice-info">{presetHint}</div>}
        <ProviderCredentialMigrationNotice provider={provider} />

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input input-block"
          value={name}
          placeholder={t('namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('baseUrlLabel')}</label>
        <input
          className="input input-block"
          value={baseUrl}
          placeholder="https://your-gateway.example.com"
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <label className="field-label">{t('providerEngineLabel')}</label>
        <select
          className="select select-block"
          value={engine}
          onChange={(e) => setEngine(e.target.value as EngineKind)}
        >
          <option value="openai">{t('providerEngineOpenAI')}</option>
          <option value="anthropic">{t('providerEngineAnthropic')}</option>
          <option value="claude">{t('providerEngineClaude')}</option>
        </select>

        <ProviderCredentialStorageNotice storage={provider?.credentialStorage} />

        <label className="field-label">
          {t('apiKeyLabelPrimary')}
          {isEdit && provider.hasToken && !tokenTouched && (
            <span className="field-hint">{t('savedKeepEmpty')}</span>
          )}
        </label>
        <input
          className="input input-block"
          type="password"
          value={token}
          placeholder={isEdit && provider.hasToken ? t('tokenPlaceholderSaved') : '<your-api-key>'}
          onChange={(e) => {
            setToken(e.target.value)
            setTokenTouched(true)
          }}
        />

        <label className="field-label">{t('apiKeyNameLabel')}</label>
        <input
          className="input input-block"
          value={tokenLabel}
          placeholder={t('apiKeyNamePlaceholder')}
          onChange={(e) => setTokenLabel(e.target.value)}
        />

        <ProviderSavedKeys
          provider={provider}
          savedKeys={savedKeys}
          keyDrafts={keyDrafts}
          activeKeyId={activeKeyId}
          onActiveKeyChange={setActiveKeyId}
          onKeyDraftsChange={setKeyDrafts}
        />

        <label className="field-label">{t('additionalApiKeysLabel')}</label>
        <textarea
          className="input input-block textarea"
          value={additionalKeysText}
          rows={3}
          placeholder={t('additionalApiKeysPlaceholder')}
          onChange={(e) => setAdditionalKeysText(e.target.value)}
        />
        <div className="field-hint">{t('additionalApiKeysHint')}</div>

        <div className="field-label-row">
          <label className="field-label">{t('modelListLabel')}</label>
          <button
            className="btn btn-ghost btn-sm"
            disabled={fetching}
            onClick={() => void fetchModels()}
            title={t('fetchModelsTitle')}
          >
            {fetching ? t('fetching') : t('fetchWithKey')}
          </button>
        </div>
        <textarea
          className="input input-block textarea"
          value={modelsText}
          rows={4}
          placeholder={'gpt-4o\nclaude-3-5-sonnet\ngemini-1.5-pro'}
          onChange={(e) => {
            setModelsText(e.target.value)
            setModelSourceKey(currentModelSourceKey)
          }}
        />
        {fetchNote && <div className="field-hint field-hint-ok">{fetchNote}</div>}
        {modelsStale && <div className="field-hint field-hint-warning">{t('modelListStale')}</div>}

        <label className="field-label">
          {t('customHeadersLabel')} <span className="field-hint">{t('customHeadersHint')}</span>
        </label>
        <textarea
          className="input input-block textarea"
          value={customHeaders}
          rows={2}
          placeholder={'X-Gateway-Route: openai\nX-Trace-Id: request-label'}
          onChange={(e) => setCustomHeaders(e.target.value)}
        />

        <label className="field-label">
          {t('credentialHeaderNamesLabel')} <span className="field-hint">{t('credentialHeaderNamesHint')}</span>
        </label>
        <textarea
          className="input input-block textarea"
          value={credentialHeaderNamesText}
          rows={2}
          placeholder={'api-key\nOcp-Apim-Subscription-Key'}
          onChange={(e) => setCredentialHeaderNamesText(e.target.value)}
        />

        <label className="field-label">
          {t('openaiProtocolLabel')} <span className="field-hint">{t('openaiProtocolHint')}</span>
        </label>
        <select
          className="select select-block"
          value={openaiProtocol}
          onChange={(e) => setOpenaiProtocol(e.target.value as OpenAIProtocol)}
        >
          <option value="responses">{t('openaiProtocolResponses')}</option>
          <option value="chat">{t('openaiProtocolChat')}</option>
        </select>

        <label className="field-label">{t('noteOptional')}</label>
        <input
          className="input input-block"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <label className="field-label">Provider 预算上限 ($)</label>
        <input
          className="input input-block"
          type="number"
          min="0"
          step="0.01"
          value={budgetUsd}
          placeholder="0 = 继承全局设置"
          onChange={(e) => setBudgetUsd(e.target.value)}
        />

        {error && <div className="notice notice-error">{error}</div>}

        <div className="provider-editor-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </button>
        </div>
    </section>
  )
}

function providerCredentialNotice(
  storage: ProviderCredentialStorage
): { key: string; tone: 'notice-info' | 'notice-error' } | null {
  switch (storage) {
    case 'session':
      return { key: 'providerCredentialSessionNotice', tone: 'notice-info' }
    case 'legacy-b64':
      return { key: 'providerCredentialLegacyNotice', tone: 'notice-info' }
    case 'unavailable':
      return { key: 'providerCredentialUnavailableNotice', tone: 'notice-error' }
    case 'mixed':
      return { key: 'providerCredentialMixedNotice', tone: 'notice-info' }
    case 'none':
    case 'encrypted':
      return null
  }
}

function ProviderCredentialMigrationNotice({
  provider
}: {
  provider: ProviderView | null
}): React.JSX.Element | null {
  const t = useT()
  if (!provider?.credentialMigrationRequired) return null
  return <div className="notice notice-error">{t('providerCredentialMigrationNotice')}</div>
}

function ProviderCredentialStorageNotice({
  storage
}: {
  storage: ProviderCredentialStorage | undefined
}): React.JSX.Element | null {
  const t = useT()
  if (!storage) return null
  const notice = providerCredentialNotice(storage)
  if (!notice) return null
  return <div className={`notice ${notice.tone}`}>{t(notice.key)}</div>
}

function parseAdditionalKeys(value: string): ProviderApiKeyInput[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const eqIndex = line.indexOf('=')
      if (eqIndex <= 0) return [{ token: line }]
      const label = line.slice(0, eqIndex).trim()
      const token = line.slice(eqIndex + 1).trim()
      return token ? [{ label, token }] : []
    })
}

function parseCredentialHeaderNames(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildKeyUpdates(
  savedKeys: ProviderApiKeyView[],
  drafts: Record<string, ProviderKeyDraft>
): ProviderApiKeyUpdateInput[] {
  return savedKeys.flatMap((key) => {
    const draft = drafts[key.id]
    if (!draft || draft.remove) return []
    const label = draft.label.trim()
    const labelChanged = label !== key.label
    const disabledChanged = draft.disabled !== key.disabled
    if (!labelChanged && !disabledChanged) return []
    return [{
      id: key.id,
      ...(labelChanged ? { label } : {}),
      ...(disabledChanged ? { disabled: draft.disabled } : {})
    }]
  })
}

function providerModelSourceKey(providerId: string | undefined, baseUrl: string, protocol: OpenAIProtocol | undefined): string {
  const clean = normalizeProviderModelBaseUrl(baseUrl)
  return [providerId || 'new-provider', clean, protocol || 'default'].join('|')
}

function normalizeProviderModelBaseUrl(value: string): string {
  const clean = value.trim().replace(/\/+$/, '')
  try {
    const url = new URL(clean)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return clean
  }
}
