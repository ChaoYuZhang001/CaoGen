import { useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import type { PermissionModeId } from '../../../shared/types'

export default function SettingsModal(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)

  const [model, setModel] = useState(settings.defaultModel)
  const [mode, setMode] = useState<PermissionModeId>(settings.defaultPermissionMode)

  const save = async (): Promise<void> => {
    await updateSettings({ defaultModel: model, defaultPermissionMode: mode })
    setShowSettings(false)
  }

  return (
    <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">设置</h2>

        <label className="field-label">新会话默认模型</label>
        <select className="select select-block" value={model} onChange={(e) => setModel(e.target.value)}>
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label className="field-label">新会话默认权限模式</label>
        <select
          className="select select-block"
          value={mode}
          onChange={(e) => setMode(e.target.value as PermissionModeId)}
        >
          {PERMISSION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setShowSettings(false)}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
