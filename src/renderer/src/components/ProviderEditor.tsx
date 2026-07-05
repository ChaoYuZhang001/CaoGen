import { useState } from 'react'
import { PROVIDER_PRESETS, useStore } from '../store'
import { useT } from '../i18n'
import type { OpenAIProtocol, ProviderView } from '../../../shared/types'

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
  const [customHeaders, setCustomHeaders] = useState(provider?.customHeaders ?? '')
  const [budgetUsd, setBudgetUsd] = useState(provider?.budgetUsd ? String(provider.budgetUsd) : '')
  const [openaiProtocol, setOpenaiProtocol] = useState<OpenAIProtocol>(provider?.openaiProtocol ?? 'responses')
  const [note, setNote] = useState(provider?.note ?? '')
  const [token, setToken] = useState('')
  const [tokenTouched, setTokenTouched] = useState(false)
  const [presetHint, setPresetHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchNote, setFetchNote] = useState('')

  const isEdit = provider !== null

  const fetchModels = async (): Promise<void> => {
    setFetching(true)
    setError('')
    setFetchNote('')
    try {
      const models = await window.agentDesk.fetchProviderModels({
        baseUrl: baseUrl.trim(),
        token: token.trim() || undefined,
        providerId: provider?.id
      })
      setModelsText(models.join('\n'))
      setFetchNote(t('fetchedModels', { n: models.length }))
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
    setOpenaiProtocol(preset.openaiProtocol ?? 'responses')
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
    setBusy(true)
    setError('')
    try {
      if (isEdit) {
        await updateProvider(provider.id, {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          models,
          customHeaders: customHeaders.trim(),
          budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
          openaiProtocol,
          note: note.trim(),
          // token 未改动则不传,避免清空已存密钥
          ...(tokenTouched ? { token } : {})
        })
      } else {
        await createProvider({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          models,
          customHeaders: customHeaders.trim(),
          budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
          openaiProtocol,
          note: note.trim(),
          token
        })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop modal-backdrop-nested" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{isEdit ? t('providerEditTitle') : t('providerAddTitle')}</h2>

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

        <label className="field-label">
          {t('apiKeyLabel')}
          {isEdit && provider.hasToken && !tokenTouched && (
            <span className="field-hint">{t('savedKeepEmpty')}</span>
          )}
        </label>
        <input
          className="input input-block"
          type="password"
          value={token}
          placeholder={isEdit && provider.hasToken ? t('tokenPlaceholderSaved') : 'sk-...'}
          onChange={(e) => {
            setToken(e.target.value)
            setTokenTouched(true)
          }}
        />

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
          onChange={(e) => setModelsText(e.target.value)}
        />
        {fetchNote && <div className="field-hint field-hint-ok">{fetchNote}</div>}

        <label className="field-label">
          {t('customHeadersLabel')} <span className="field-hint">{t('customHeadersHint')}</span>
        </label>
        <textarea
          className="input input-block textarea"
          value={customHeaders}
          rows={2}
          placeholder={'X-Gateway-Route: openai\nX-Custom: value'}
          onChange={(e) => setCustomHeaders(e.target.value)}
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

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
