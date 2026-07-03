import { useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import type { PermissionModeId } from '../../../shared/types'

export default function NewSessionModal(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const createSession = useStore((s) => s.createSession)
  const setShowNewSession = useStore((s) => s.setShowNewSession)

  const [cwd, setCwd] = useState('')
  const [model, setModel] = useState(settings.defaultModel)
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>(
    settings.defaultPermissionMode
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
      await createSession({ cwd: cwd.trim(), model, permissionMode })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setShowNewSession(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">新建会话</h2>

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

        <label className="field-label">模型</label>
        <select className="select select-block" value={model} onChange={(e) => setModel(e.target.value)}>
          {MODEL_OPTIONS.map((o) => (
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
