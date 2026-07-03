import { useState } from 'react'
import { useStore } from '../store'
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
  const [note, setNote] = useState(provider?.note ?? '')
  const [token, setToken] = useState('')
  const [tokenTouched, setTokenTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isEdit = provider !== null

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
        // token 未改动则不传,避免清空已存密钥
        await updateProvider(provider.id, {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          models,
          note: note.trim(),
          ...(tokenTouched ? { token } : {})
        })
      } else {
        await createProvider({ name: name.trim(), baseUrl: baseUrl.trim(), models, note: note.trim(), token })
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
          placeholder={'claude-sonnet-4\nclaude-opus-4\ngpt-4o'}
          onChange={(e) => setModelsText(e.target.value)}
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
