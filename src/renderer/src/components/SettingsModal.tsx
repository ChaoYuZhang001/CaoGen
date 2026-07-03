import { useEffect, useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, STRATEGY_OPTIONS, useStore } from '../store'
import type {
  PermissionModeId,
  ProviderHealthView,
  ProviderView,
  SchedulerStrategy
} from '../../../shared/types'
import ProviderEditor from './ProviderEditor'

export default function SettingsModal(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const updateSettings = useStore((s) => s.updateSettings)
  const deleteProvider = useStore((s) => s.deleteProvider)
  const setShowSettings = useStore((s) => s.setShowSettings)

  const [model, setModel] = useState(settings.defaultModel)
  const [mode, setMode] = useState<PermissionModeId>(settings.defaultPermissionMode)
  const [providerId, setProviderId] = useState(settings.defaultProviderId)
  const [strategy, setStrategy] = useState<SchedulerStrategy>(settings.schedulerStrategy)
  const [editing, setEditing] = useState<ProviderView | 'new' | null>(null)
  const [health, setHealth] = useState<ProviderHealthView[]>([])

  useEffect(() => {
    void window.agentDesk.listProviderHealth().then(setHealth)
  }, [])

  const healthOf = (pid: string): ProviderHealthView | undefined =>
    health.find((h) => h.providerId === (pid || 'official'))

  const save = async (): Promise<void> => {
    await updateSettings({
      defaultModel: model,
      defaultPermissionMode: mode,
      defaultProviderId: providerId,
      schedulerStrategy: strategy
    })
    setShowSettings(false)
  }

  const remove = async (p: ProviderView): Promise<void> => {
    await deleteProvider(p.id)
    if (providerId === p.id) setProviderId('')
  }

  return (
    <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">设置</h2>

        <section className="settings-section">
          <div className="settings-section-head">
            <h3 className="settings-h3">厂商 / Providers</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing('new')}>
              + 添加
            </button>
          </div>
          <p className="settings-hint">
            配置 Anthropic 兼容端点(官方或第三方网关)。密钥经系统加密后本地存储,不明文落盘。
          </p>

          <div className="provider-list">
            {providers.length === 0 && (
              <div className="provider-empty">尚未配置额外 Provider,当前使用官方 Anthropic 登录。</div>
            )}
            {providers.map((p) => {
              const h = healthOf(p.id)
              return (
                <div key={p.id} className="provider-row">
                  <div className="provider-row-body">
                    <div className="provider-row-name">
                      {p.name}
                      {!p.hasToken && <span className="provider-tag-warn">未配置密钥</span>}
                      {h && (
                        <span
                          className={`health-dot ${h.healthy ? 'health-ok' : 'health-bad'}`}
                          title={
                            h.healthy
                              ? `健康 · 成功 ${h.successes} 失败 ${h.failures}${h.lastLatencyMs ? ` · ${h.lastLatencyMs}ms` : ''}`
                              : `异常 · 连续失败 ${h.consecutiveFailures}${h.lastError ? ` · ${h.lastError}` : ''}`
                          }
                        />
                      )}
                    </div>
                    <div className="provider-row-sub">
                      {p.baseUrl || '官方端点'} · {p.models.length} 个模型
                      {h && ` · 成功 ${h.successes}/失败 ${h.failures}`}
                    </div>
                  </div>
                  <div className="provider-row-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>
                      编辑
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void remove(p)}>
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h3">新会话默认</h3>

          <label className="field-label">默认 Provider</label>
          <select
            className="select select-block"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          >
            <option value="">官方 Anthropic(默认登录)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <label className="field-label">默认模型</label>
          <select className="select select-block" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <label className="field-label">
            自动调度策略 <span className="field-hint">(模型选"自动调度"时生效)</span>
          </label>
          <select
            className="select select-block"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as SchedulerStrategy)}
          >
            {STRATEGY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <label className="field-label">默认权限模式</label>
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
        </section>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setShowSettings(false)}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>

      {editing && (
        <ProviderEditor
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
