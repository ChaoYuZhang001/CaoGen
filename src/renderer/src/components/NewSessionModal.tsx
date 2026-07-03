import { useMemo, useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import { AUTO_MODEL } from '../../../shared/types'
import type { PermissionModeId } from '../../../shared/types'

export default function NewSessionModal(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const createSession = useStore((s) => s.createSession)
  const setShowNewSession = useStore((s) => s.setShowNewSession)

  const [cwd, setCwd] = useState('')
  const [providerId, setProviderId] = useState(settings.defaultProviderId)
  const [model, setModel] = useState(settings.defaultModel)
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>(
    settings.defaultPermissionMode
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 选定 Provider 时,模型下拉用该 Provider 声明的模型列表;官方则用内置别名。
  // 无论如何都保留"自动调度",否则指定 Provider 就用不上调度器。
  const modelOptions = useMemo(() => {
    const provider = providers.find((p) => p.id === providerId)
    if (provider && provider.models.length > 0) {
      return [
        { value: AUTO_MODEL, label: '🧭 自动调度' },
        { value: '', label: '默认模型' },
        ...provider.models.map((m) => ({ value: m, label: m }))
      ]
    }
    return MODEL_OPTIONS
  }, [providers, providerId])

  const onProviderChange = (id: string): void => {
    setProviderId(id)
    // 切换 Provider 后旧的具体模型可能不在新列表里,重置为默认;但保留"自动"意图
    if (model !== AUTO_MODEL) setModel('')
  }

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (dir) setCwd(dir)
  }

  const create = async (): Promise<void> => {
    if (!cwd.trim()) {
      setError('请选择项目目录')
      return
    }
    setBusy(true)
    setError('')
    try {
      await createSession({ cwd: cwd.trim(), model, providerId, permissionMode })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setShowNewSession(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">新建会话</h2>

        {projects.length > 0 && (
          <>
            <label className="field-label">最近项目</label>
            <div className="project-chips">
              {projects.slice(0, 8).map((p) => (
                <button
                  key={p.id}
                  className={`project-chip ${cwd === p.path ? 'active' : ''}`}
                  title={p.path}
                  onClick={() => setCwd(p.path)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </>
        )}

        <label className="field-label">项目目录</label>
        <div className="field-row">
          <input
            className="input"
            value={cwd}
            placeholder="/path/to/project"
            onChange={(e) => setCwd(e.target.value)}
          />
          <button className="btn btn-ghost" onClick={() => void browse()}>
            浏览…
          </button>
        </div>

        <label className="field-label">厂商 / Provider</label>
        <select
          className="select select-block"
          value={providerId}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          <option value="">官方 Anthropic(默认登录)</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.hasToken ? '' : ' (未配置密钥)'}
            </option>
          ))}
        </select>

        <label className="field-label">模型</label>
        <select className="select select-block" value={model} onChange={(e) => setModel(e.target.value)}>
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label className="field-label">权限模式</label>
        <select
          className="select select-block"
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as PermissionModeId)}
        >
          {PERMISSION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setShowNewSession(false)}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
