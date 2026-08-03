import { useMemo, useState } from 'react'
import { PROVIDER_PRESETS, useStore } from '../store'
import { useT } from '../i18n'
import ProviderQuickSetup from './ProviderQuickSetup'
import type {
  EngineKind,
  OpenAIProtocol,
  ProviderAuthMode,
  ProviderApiKeyInput,
  ProviderApiKeyUpdateInput,
  ProviderApiKeyView,
  ProviderCredentialStorage,
  ProviderInput,
  ProviderView
} from '../../../shared/types'
import ProviderSavedKeys from './settings/ProviderSavedKeys'
import type { ProviderKeyDraft } from './settings/ProviderSavedKeys'

const DEFAULT_PROVIDER_BASE_URL = PROVIDER_PRESETS.find((preset) => preset.key === 'caogen-relay')?.baseUrl ?? ''

interface Props {
  /** null = 新建;否则编辑该 Provider */
  provider: ProviderView | null
  onClose: (result: ProviderEditorCloseResult) => void
}

export type ProviderEditorCloseResult =
  | { reason: 'cancelled' }
  | { reason: 'saved'; provider: ProviderView }

interface ProviderEditorSaveState {
  provider: ProviderView | null
  name: string
  baseUrl: string
  modelsText: string
  engine: EngineKind
  authMode: ProviderAuthMode
  customHeaders: string
  credentialHeaderNamesText: string
  budgetUsd: string
  openaiProtocol: OpenAIProtocol
  note: string
  token: string
  tokenLabel: string
  tokenTouched: boolean
  additionalKeysText: string
  savedKeys: ProviderApiKeyView[]
  keyDrafts: Record<string, ProviderKeyDraft>
  activeKeyId: string
}

export default function ProviderEditorEntry(props: Props): React.JSX.Element {
  return props.provider
    ? <ProviderEditor {...props} />
    : <NewProviderEditor onClose={props.onClose} />
}

function NewProviderEditor({ onClose }: Pick<Props, 'onClose'>): React.JSX.Element {
  const [advanced, setAdvanced] = useState(false)
  return advanced
    ? <ProviderEditor provider={null} onClose={onClose} />
    : (
        <ProviderQuickSetup
          onAdvanced={() => setAdvanced(true)}
          onCancel={() => onClose({ reason: 'cancelled' })}
          onSaved={(provider) => onClose({ reason: 'saved', provider })}
        />
      )
}

function ProviderEditor({ provider, onClose }: Props): React.JSX.Element {
  const t = useT()
  const createProvider = useStore((s) => s.createProvider)
  const updateProvider = useStore((s) => s.updateProvider)
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? DEFAULT_PROVIDER_BASE_URL)
  const [modelsText, setModelsText] = useState((provider?.models ?? []).join('\n'))
  const [engine, setEngine] = useState<EngineKind>(provider?.engine ?? 'openai')
  const [authMode, setAuthMode] = useState<ProviderAuthMode>(provider?.authMode ?? 'api-key')
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
  const existingCredentialCount = countExistingProviderCredentials(provider)
  const currentModelSourceKey = useMemo(
    () => providerModelSourceKey(provider?.id, baseUrl, openaiProtocol),
    [provider?.id, baseUrl, openaiProtocol]
  )
  const modelsStale = isProviderModelListStale(modelsText, modelSourceKey, currentModelSourceKey)

  const handleAuthModeChange = (mode: ProviderAuthMode): void => {
    setAuthMode(mode)
    setError('')
    if (mode !== 'none') return
    setToken('')
    setTokenTouched(false)
    setTokenLabel('')
    setAdditionalKeysText('')
    setActiveKeyId('')
    setKeyDrafts(Object.fromEntries(savedKeys.map((key) => [
      key.id,
      { label: key.label, disabled: key.disabled, remove: false }
    ])))
  }

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
        openaiProtocol,
        authMode
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
    handleAuthModeChange(preset.key === 'local-openai' ? 'none' : 'api-key')
    setOpenaiProtocol(preset.openaiProtocol ?? 'responses')
    setModelSourceKey(providerModelSourceKey(provider?.id, preset.baseUrl, preset.openaiProtocol ?? 'responses'))
  }

  const save = async (): Promise<void> => {
    const additionalTokens = parseAdditionalKeys(additionalKeysText)
    const validationKey = providerEditorValidationKey(
      name,
      provider,
      authMode,
      token,
      additionalTokens,
      modelsText.split('\n').map((model) => model.trim()).filter(Boolean)
    )
    if (validationKey) {
      setError(t(validationKey))
      return
    }
    if (requiresCredentialDeletionConfirmation(provider, authMode, existingCredentialCount)
      && !window.confirm(t('providerAuthModeNoneDeleteKeysConfirm', { n: existingCredentialCount }))) {
      return
    }
    const input = buildProviderSaveInput({
      provider, name, baseUrl, modelsText, engine, authMode, customHeaders,
      credentialHeaderNamesText, budgetUsd, openaiProtocol, note, token, tokenLabel,
      tokenTouched, additionalKeysText, savedKeys, keyDrafts, activeKeyId
    })
    setBusy(true)
    setError('')
    try {
      const savedProvider = provider
        ? await updateProvider(provider.id, input)
        : await createProvider(input)
      onClose({ reason: 'saved', provider: savedProvider })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <section className="provider-editor" aria-label={isEdit ? t('providerEditTitle') : t('providerAddTitle')} data-provider-editor="form">
        <header className="provider-editor-header">
          <button
            type="button"
            className="provider-editor-back" data-provider-editor-action="back"
            aria-label={t('backToProviders')}
            title={t('backToProviders')}
            onClick={() => onClose({ reason: 'cancelled' })}
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
          className="input input-block" data-provider-field="name"
          value={name}
          placeholder={t('namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('baseUrlLabel')}</label>
        <input
          className="input input-block" data-provider-field="base-url"
          value={baseUrl}
          placeholder="https://your-gateway.example.com"
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <label className="field-label">{t('providerEngineLabel')}</label>
        <select
          className="select select-block" data-provider-field="engine"
          value={engine}
          onChange={(e) => setEngine(e.target.value as EngineKind)}
        >
          <option value="openai">{t('providerEngineOpenAI')}</option>
          <option value="anthropic">{t('providerEngineAnthropic')}</option>
        </select>

        <ProviderCredentialFields
          authMode={authMode}
          onAuthModeChange={handleAuthModeChange}
          existingCredentialCount={existingCredentialCount}
          provider={provider}
          isEdit={isEdit}
          token={token}
          tokenTouched={tokenTouched}
          onTokenChange={(value) => { setToken(value); setTokenTouched(true) }}
          tokenLabel={tokenLabel}
          onTokenLabelChange={setTokenLabel}
          savedKeys={savedKeys}
          keyDrafts={keyDrafts}
          activeKeyId={activeKeyId}
          onActiveKeyChange={setActiveKeyId}
          onKeyDraftsChange={setKeyDrafts}
          additionalKeysText={additionalKeysText}
          onAdditionalKeysTextChange={setAdditionalKeysText}
        />

        <div className="field-label-row">
          <label className="field-label">{t('modelListLabel')}</label>
          <button
            className="btn btn-ghost btn-sm"
            disabled={fetching}
            onClick={() => void fetchModels()}
            title={t('fetchModelsTitle')}
          >
            {fetching ? t('fetching') : t(authMode === 'none' ? 'fetchModelsNoKey' : 'fetchWithKey')}
          </button>
        </div>
        <textarea
          className="input input-block textarea" data-provider-field="models"
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
          className="select select-block" data-provider-field="openai-protocol"
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

        {error && <div className="notice notice-error" data-provider-editor-error>{error}</div>}

        <div className="provider-editor-actions">
          <button className="btn btn-ghost" data-provider-editor-action="cancel" onClick={() => onClose({ reason: 'cancelled' })}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" data-provider-editor-action="save" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </button>
        </div>
    </section>
  )
}

function providerEditorValidationKey(
  name: string,
  provider: ProviderView | null,
  authMode: ProviderAuthMode,
  token: string,
  additionalTokens: ProviderApiKeyInput[],
  models: string[]
): string | null {
  if (!name.trim()) return 'errNameRequired'
  if (useStore.getState().settingsContext !== 'welcome-provider-recovery') return null
  if (authMode !== 'none' && !provider?.hasToken && !token.trim() && additionalTokens.length === 0) {
    return 'errProviderKeyRequired'
  }
  return models.length === 0 ? 'errProviderModelRequired' : null
}

function requiresCredentialDeletionConfirmation(
  provider: ProviderView | null,
  authMode: ProviderAuthMode,
  existingCredentialCount: number
): boolean {
  return Boolean(provider && provider.authMode !== 'none' && authMode === 'none' && existingCredentialCount > 0)
}

function countExistingProviderCredentials(provider: ProviderView | null): number {
  return Math.max(
    provider?.apiKeys?.length ?? 0,
    provider?.keyCount ?? 0,
    provider?.hasToken ? 1 : 0
  )
}

function isProviderModelListStale(modelsText: string, sourceKey: string, currentSourceKey: string): boolean {
  return modelsText.trim().length > 0 && sourceKey !== '' && sourceKey !== currentSourceKey
}

function buildProviderSaveInput(state: ProviderEditorSaveState): ProviderInput {
  const budget = Number(state.budgetUsd)
  return {
    name: state.name.trim(),
    baseUrl: state.baseUrl.trim(),
    models: state.modelsText.split('\n').map((model) => model.trim()).filter(Boolean),
    engine: state.engine,
    authMode: state.authMode,
    customHeaders: state.customHeaders.trim(),
    credentialHeaderNames: parseCredentialHeaderNames(state.credentialHeaderNamesText),
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
    openaiProtocol: state.openaiProtocol,
    note: state.note.trim(),
    ...buildProviderCredentialPatch(state)
  }
}

function buildProviderCredentialPatch(state: ProviderEditorSaveState): Partial<ProviderInput> {
  if (state.authMode === 'none') return {}
  const additionalTokens = parseAdditionalKeys(state.additionalKeysText)
  const keyUpdates = buildKeyUpdates(state.savedKeys, state.keyDrafts)
  const removeKeyIds = state.savedKeys
    .filter((key) => state.keyDrafts[key.id]?.remove)
    .map((key) => key.id)
  const activeKeyId = state.activeKeyId && !removeKeyIds.includes(state.activeKeyId)
    ? state.activeKeyId
    : undefined
  const patch: Partial<ProviderInput> = {}

  if (!state.provider || state.tokenTouched) {
    patch.token = state.token
    patch.tokenLabel = state.tokenLabel.trim()
  } else if (state.tokenLabel.trim()) {
    patch.tokenLabel = state.tokenLabel.trim()
  }
  if (additionalTokens.length > 0) patch.additionalTokens = additionalTokens
  if (keyUpdates.length > 0) patch.keyUpdates = keyUpdates
  if (removeKeyIds.length > 0) patch.removeKeyIds = removeKeyIds
  if (activeKeyId) patch.activeKeyId = activeKeyId
  return patch
}

function ProviderCredentialFields({
  authMode,
  onAuthModeChange,
  existingCredentialCount,
  provider,
  isEdit,
  token,
  tokenTouched,
  onTokenChange,
  tokenLabel,
  onTokenLabelChange,
  savedKeys,
  keyDrafts,
  activeKeyId,
  onActiveKeyChange,
  onKeyDraftsChange,
  additionalKeysText,
  onAdditionalKeysTextChange
}: {
  authMode: ProviderAuthMode
  onAuthModeChange: (mode: ProviderAuthMode) => void
  existingCredentialCount: number
  provider: ProviderView | null
  isEdit: boolean
  token: string
  tokenTouched: boolean
  onTokenChange: (value: string) => void
  tokenLabel: string
  onTokenLabelChange: (value: string) => void
  savedKeys: ProviderApiKeyView[]
  keyDrafts: Record<string, ProviderKeyDraft>
  activeKeyId: string
  onActiveKeyChange: (id: string) => void
  onKeyDraftsChange: React.Dispatch<React.SetStateAction<Record<string, ProviderKeyDraft>>>
  additionalKeysText: string
  onAdditionalKeysTextChange: (value: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <label className="field-label">{t('providerAuthModeLabel')}</label>
      <select className="select select-block" value={authMode} onChange={(event) => onAuthModeChange(event.target.value as ProviderAuthMode)}>
        <option value="api-key">{t('providerAuthModeApiKey')}</option>
        <option value="none">{t('providerAuthModeNone')}</option>
      </select>
      {authMode === 'none' ? (
        <div className={`notice ${existingCredentialCount > 0 ? 'notice-error' : 'notice-info'}`}>
          {t(existingCredentialCount > 0
            ? 'providerAuthModeNoneDeletesKeysHint'
            : 'providerAuthModeNoneHint', { n: existingCredentialCount })}
        </div>
      ) : (
        <>
          <ProviderCredentialStorageNotice storage={provider?.credentialStorage} />
          <label className="field-label">
            {t('apiKeyLabelPrimary')}
            {isEdit && provider?.hasToken && !tokenTouched && <span className="field-hint">{t('savedKeepEmpty')}</span>}
          </label>
          <input
            className="input input-block" data-provider-field="api-key"
            type="password"
            value={token}
            placeholder={isEdit && provider?.hasToken ? t('tokenPlaceholderSaved') : '<your-api-key>'}
            onChange={(event) => onTokenChange(event.target.value)}
          />
          <label className="field-label">{t('apiKeyNameLabel')}</label>
          <input
            className="input input-block"
            value={tokenLabel}
            placeholder={t('apiKeyNamePlaceholder')}
            onChange={(event) => onTokenLabelChange(event.target.value)}
          />
          <ProviderSavedKeys
            provider={provider}
            savedKeys={savedKeys}
            keyDrafts={keyDrafts}
            activeKeyId={activeKeyId}
            onActiveKeyChange={onActiveKeyChange}
            onKeyDraftsChange={onKeyDraftsChange}
          />
          <label className="field-label">{t('additionalApiKeysLabel')}</label>
          <textarea
            className="input input-block textarea" data-provider-field="additional-api-keys"
            value={additionalKeysText}
            rows={3}
            placeholder={t('additionalApiKeysPlaceholder')}
            onChange={(event) => onAdditionalKeysTextChange(event.target.value)}
          />
          <div className="field-hint">{t('additionalApiKeysHint')}</div>
        </>
      )}
    </>
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
