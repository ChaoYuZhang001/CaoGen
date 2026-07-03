import { useState } from 'react'
import { PROVIDER_PRESETS, useStore } from '../store'
import type { ProviderView } from '../../../shared/types'

interface Props {
  /** null = 新建;否则编辑该 Provider */
  provider: ProviderView | null
  onClose: () => void
}

export default function ProviderEditor({ provider, onClose }: Props): React.JSX.Element {
  const createProvider = useStore((s) => s.createProvider)
  const updateProvider = useStore((s) => s.updateProvider)

  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [modelsText, setModelsText] = useState((provider?.models ?? []).join('\n'))
  const [customHeaders, setCustomHeaders] = useState(provider?.customHeaders ?? '')
  const [note, setNote] = useState(provider?.note ?? '')
  const [token, setToken] = useState('')
  const [tokenTouched, setTokenTouched] = useState(false)
  const [presetHint, setPresetHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isEdit = provider !== null

  const applyPreset = (key: string): void => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === key)
    if (!preset) return
    setPresetHint(preset.hint)
    if (preset.key === 'custom') return
    if (!name.trim()) setName(preset.label)
    setBaseUrl(preset.baseUrl)
    setModelsText(preset.models.join('\n'))
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('请填写名称')
      return
    }
    const models = modelsText
      .split('\n')
      .map((m) => m.trim())
      .filter(Boolean)
    setBusy(true)
    setError('')
    try {
      if (isEdit) {
        await updateProvider(provider.id, {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          models,
          customHeaders: customHeaders.trim(),
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
        <h2 className="modal-title">{isEdit ? '编辑 Provider' : '添加 Provider'}</h2>

        {!isEdit && (
          <>
            <label className="field-label">快速模板</label>
            <select className="select select-block" defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
              <option value="" disabled>
                选择一个模板…
              </option>
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="provider-gateway-note">
              底层引擎使用 Anthropic Messages API 协议。接入 <b>OpenAI / Gemini / 国产模型</b> 需经
              Anthropic 兼容网关(one-api、new-api、LiteLLM 等)转译,填入网关地址即可。
            </p>
          </>
        )}

        {presetHint && <div className="notice notice-info">{presetHint}</div>}

        <label className="field-label">名称</label>
        <input
          className="input input-block"
          value={name}
          placeholder="例如:公司网关 / OpenRouter"
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">Base URL(Anthropic 兼容端点)</label>
        <input
          className="input input-block"
          value={baseUrl}
          placeholder="https://your-gateway.example.com"
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <label className="field-label">
          API 密钥
          {isEdit && provider.hasToken && !tokenTouched && <span className="field-hint">(已保存,留空不改)</span>}
        </label>
        <input
          className="input input-block"
          type="password"
          value={token}
          placeholder={isEdit && provider.hasToken ? '••••••••(不改动请留空)' : 'sk-...'}
          onChange={(e) => {
            setToken(e.target.value)
            setTokenTouched(true)
          }}
        />

        <label className="field-label">模型列表(每行一个)</label>
        <textarea
          className="input input-block textarea"
          value={modelsText}
          rows={4}
          placeholder={'gpt-4o\nclaude-3-5-sonnet\ngemini-1.5-pro'}
          onChange={(e) => setModelsText(e.target.value)}
        />

        <label className="field-label">
          自定义请求头 <span className="field-hint">(可选,每行 Name: value)</span>
        </label>
        <textarea
          className="input input-block textarea"
          value={customHeaders}
          rows={2}
          placeholder={'X-Gateway-Route: openai\nX-Custom: value'}
          onChange={(e) => setCustomHeaders(e.target.value)}
        />

        <label className="field-label">备注(可选)</label>
        <input
          className="input input-block"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <div className="notice notice-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
