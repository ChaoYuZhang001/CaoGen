import { useEffect, useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, STRATEGY_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import type {
  AppLanguage,
  AppTheme,
  PermissionModeId,
  ProviderHealthView,
  ProviderView,
  SchedulerStrategy
} from '../../../shared/types'
import ProviderEditor from './ProviderEditor'

type Tab = 'general' | 'permissions' | 'persona' | 'office' | 'providers' | 'plugins'

export default function SettingsModal(): React.JSX.Element {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const updateSettings = useStore((s) => s.updateSettings)
  const deleteProvider = useStore((s) => s.deleteProvider)
  const setShowSettings = useStore((s) => s.setShowSettings)

  const [tab, setTab] = useState<Tab>('general')
  // 本地草稿,保存时统一提交
  const [draft, setDraft] = useState(settings)
  const [editing, setEditing] = useState<ProviderView | 'new' | null>(null)
  const [health, setHealth] = useState<ProviderHealthView[]>([])

  useEffect(() => {
    void window.agentDesk.listProviderHealth().then(setHealth)
  }, [])

  const set = <K extends keyof typeof draft>(key: K, val: (typeof draft)[K]): void =>
    setDraft((d) => ({ ...d, [key]: val }))
  const setOffice = (patch: Partial<typeof draft.office>): void =>
    setDraft((d) => ({ ...d, office: { ...d.office, ...patch } }))

  const healthOf = (pid: string): ProviderHealthView | undefined =>
    health.find((h) => h.providerId === (pid || 'official'))

  const save = async (): Promise<void> => {
    await updateSettings(draft)
    setShowSettings(false)
  }

  const remove = async (p: ProviderView): Promise<void> => {
    await deleteProvider(p.id)
  }

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'general', label: t('tabGeneral') },
    { id: 'permissions', label: t('tabPermissions') },
    { id: 'persona', label: t('tabPersona') },
    { id: 'office', label: t('tabOffice') },
    { id: 'providers', label: t('tabProviders') },
    { id: 'plugins', label: t('tabPlugins') }
  ]

  return (
    <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
      <div className="modal modal-wide settings-center" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{t('settingsTitle')}</h2>

        <div className="settings-body">
          <nav className="settings-tabs">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                className={`settings-tab ${tab === tb.id ? 'active' : ''}`}
                onClick={() => setTab(tb.id)}
              >
                {tb.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {tab === 'general' && (
              <>
                <label className="field-label">{t('language')}</label>
                <select
                  className="select select-block"
                  value={draft.language}
                  onChange={(e) => set('language', e.target.value as AppLanguage)}
                >
                  <option value="zh">简体中文</option>
                  <option value="en">English</option>
                </select>

                <label className="field-label">{t('theme')}</label>
                <select
                  className="select select-block"
                  value={draft.theme}
                  onChange={(e) => {
                    const v = e.target.value as AppTheme
                    set('theme', v)
                    void updateSettings({ theme: v }) // 立即应用 + 持久化(即时预览)
                  }}
                >
                  <option value="light">{t('themeLight')}</option>
                  <option value="dark">{t('themeDark')}</option>
                  <option value="system">{t('themeSystem')}</option>
                </select>

                <label className="field-label">{t('defaultProvider')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultProviderId}
                  onChange={(e) => set('defaultProviderId', e.target.value)}
                >
                  <option value="">官方 Anthropic</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <label className="field-label">{t('defaultModel')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultModel}
                  onChange={(e) => set('defaultModel', e.target.value)}
                >
                  {MODEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="field-label">{t('schedulerStrategy')}</label>
                <select
                  className="select select-block"
                  value={draft.schedulerStrategy}
                  onChange={(e) => set('schedulerStrategy', e.target.value as SchedulerStrategy)}
                >
                  {STRATEGY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.failoverEnabled}
                    onChange={(e) => set('failoverEnabled', e.target.checked)}
                  />
                  {t('failoverEnabled')}
                </label>
                <p className="settings-hint">{t('failoverHint')}</p>
              </>
            )}

            {tab === 'permissions' && (
              <>
                <label className="field-label">{t('defaultPermMode')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultPermissionMode}
                  onChange={(e) => set('defaultPermissionMode', e.target.value as PermissionModeId)}
                >
                  {PERMISSION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <label className="field-label">{t('allowedTools')}</label>
                <textarea
                  className="input input-block textarea"
                  rows={3}
                  value={draft.allowedTools}
                  placeholder={'Read\nGlob\nGrep'}
                  onChange={(e) => set('allowedTools', e.target.value)}
                />

                <label className="field-label">{t('disallowedTools')}</label>
                <textarea
                  className="input input-block textarea"
                  rows={3}
                  value={draft.disallowedTools}
                  placeholder={'Bash\nWrite'}
                  onChange={(e) => set('disallowedTools', e.target.value)}
                />
              </>
            )}

            {tab === 'persona' && (
              <>
                <label className="field-label">{t('personaLabel')}</label>
                <p className="settings-hint">{t('personaHint')}</p>
                <textarea
                  className="input input-block textarea"
                  rows={8}
                  value={draft.persona}
                  placeholder={t('personaPlaceholder')}
                  onChange={(e) => set('persona', e.target.value)}
                />
              </>
            )}

            {tab === 'office' && (
              <>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.office.showBadges}
                    onChange={(e) => setOffice({ showBadges: e.target.checked })}
                  />
                  {t('officeShowBadges')}
                </label>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.office.catEars}
                    onChange={(e) => setOffice({ catEars: e.target.checked })}
                  />
                  {t('officeCatEars')}
                </label>
                <label className="field-label">
                  {t('officeLiveliness')} · {draft.office.liveliness.toFixed(1)}×
                </label>
                <input
                  type="range"
                  className="input-block"
                  min={0.5}
                  max={1.5}
                  step={0.1}
                  value={draft.office.liveliness}
                  onChange={(e) => setOffice({ liveliness: Number(e.target.value) })}
                />
              </>
            )}

            {tab === 'providers' && (
              <>
                <div className="settings-section-head">
                  <h3 className="settings-h3">{t('tabProviders')}</h3>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing('new')}>
                    {t('addProvider')}
                  </button>
                </div>
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
                                    ? `健康 · 成功 ${h.successes} 失败 ${h.failures}`
                                    : `异常 · 连续失败 ${h.consecutiveFailures}`
                                }
                              />
                            )}
                          </div>
                          <div className="provider-row-sub">
                            {p.baseUrl || '官方端点'} · {p.models.length} 个模型
                          </div>
                        </div>
                        <div className="provider-row-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>
                            {t('rename')}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => void remove(p)}>
                            {t('delete')}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {tab === 'plugins' && (
              <>
                <h3 className="settings-h3">{t('tabPlugins')}</h3>
                <p className="settings-hint">{t('pluginsInfo')}</p>
                <div className="plugins-paths">
                  <code>~/.claude/skills/</code>
                  <code>~/.claude/agents/</code>
                  <code>.claude/settings.json → mcpServers</code>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setShowSettings(false)}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => void save()}>
            {t('save')}
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
