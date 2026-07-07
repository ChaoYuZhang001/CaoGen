import { useEffect, useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, STRATEGY_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import type {
  AppLanguage,
  AppTheme,
  MigrationScan,
  PermissionModeId,
  ProviderHealthView,
  ProviderView,
  SandboxMode,
  SchedulerStrategy
} from '../../../shared/types'
import ProviderEditor from './ProviderEditor'
import ProjectSettings from '../pages/ProjectSettings'

type Tab = 'general' | 'permissions' | 'project' | 'persona' | 'office' | 'providers' | 'plugins' | 'migrate'

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
  // 迁移向导状态
  const activeSession = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const projects = useStore((s) => s.projects)
  const [migrateDir, setMigrateDir] = useState('')
  const [scan, setScan] = useState<MigrationScan | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [migrateBusy, setMigrateBusy] = useState(false)
  const [migrateResult, setMigrateResult] = useState('')

  useEffect(() => {
    void window.agentDesk.listProviderHealth().then(setHealth)
  }, [])

  // 打开迁移页时,默认用当前会话 cwd 或最近项目
  useEffect(() => {
    if (tab === 'migrate' && !migrateDir) {
      const dir = activeSession?.meta.cwd ?? projects[0]?.path ?? ''
      if (dir) setMigrateDir(dir)
    }
  }, [tab, migrateDir, activeSession, projects])

  const runScan = async (dir: string): Promise<void> => {
    if (!dir.trim()) return
    setMigrateBusy(true)
    setMigrateResult('')
    try {
      const result = await window.agentDesk.scanMigration(dir.trim())
      setScan(result)
      setPicked(new Set(result.assets.map((a) => a.path))) // 默认全选
    } catch (err) {
      setMigrateResult(err instanceof Error ? err.message : String(err))
      setScan(null)
    } finally {
      setMigrateBusy(false)
    }
  }

  const runImport = async (): Promise<void> => {
    if (!scan || picked.size === 0) return
    setMigrateBusy(true)
    try {
      const summary = await window.agentDesk.importMigrationAssets(scan.cwd, [...picked])
      setMigrateResult(summary)
      await runScan(scan.cwd) // 重扫,已导入项在下次导入时自动跳过
      setMigrateResult(summary)
    } catch (err) {
      setMigrateResult(err instanceof Error ? err.message : String(err))
    } finally {
      setMigrateBusy(false)
    }
  }

  const togglePick = (path: string): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const set = <K extends keyof typeof draft>(key: K, val: (typeof draft)[K]): void =>
    setDraft((d) => ({ ...d, [key]: val }))
  const setBudget = (value: string): void => {
    const budget = Number(value)
    set('budgetUsdPerSession', Number.isFinite(budget) && budget > 0 ? budget : 0)
  }
  const setMonthlyBudget = (value: string): void => {
    const budget = Number(value)
    set('budgetUsdPerMonth', Number.isFinite(budget) && budget > 0 ? budget : 0)
  }
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
    { id: 'project', label: t('tabProject') },
    { id: 'persona', label: t('tabPersona') },
    { id: 'office', label: t('tabOffice') },
    { id: 'providers', label: t('tabProviders') },
    { id: 'plugins', label: t('tabPlugins') },
    { id: 'migrate', label: t('tabMigrate') }
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
                  <option value="">{t('officialAnthropic')}</option>
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
                    checked={draft.smartModelRoutingEnabled}
                    onChange={(e) => set('smartModelRoutingEnabled', e.target.checked)}
                  />
                  P2-003 多模型智能混合调度
                </label>
                <p className="settings-hint">默认关闭。开启后仅 auto 会话会按任务类型、预算和手动覆盖选择 Provider/Model，并为关键代码任务生成复核计划。</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.modelCrossValidationAutoRunEnabled}
                    disabled={!draft.smartModelRoutingEnabled}
                    onChange={(e) => set('modelCrossValidationAutoRunEnabled', e.target.checked)}
                  />
                  P2-003 自动第二模型 Code Review
                </label>
                <p className="settings-hint">
                  默认关闭。仅在智能调度生成复核计划后启动 plan 权限子会话，不直接修改文件。
                </p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.failoverEnabled}
                    onChange={(e) => set('failoverEnabled', e.target.checked)}
                  />
                  {t('failoverEnabled')}
                </label>
                <p className="settings-hint">{t('failoverHint')}</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.notificationsEnabled}
                    onChange={(e) => set('notificationsEnabled', e.target.checked)}
                  />
                  {t('notificationsEnabled')}
                </label>
                <p className="settings-hint">{t('notificationsHint')}</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.chinaEcosystemMirrorEnabled}
                    onChange={(e) => set('chinaEcosystemMirrorEnabled', e.target.checked)}
                  />
                  {t('chinaMirrorEnabled')}
                </label>
                <p className="settings-hint">{t('chinaMirrorHint')}</p>
                <div className="settings-grid-2">
                  <label className="field-label">
                    {t('chinaNpmRegistry')}
                    <input
                      className="input input-block"
                      value={draft.chinaNpmRegistry}
                      disabled={!draft.chinaEcosystemMirrorEnabled}
                      placeholder="https://registry.npmmirror.com"
                      onChange={(e) => set('chinaNpmRegistry', e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    {t('chinaPipIndexUrl')}
                    <input
                      className="input input-block"
                      value={draft.chinaPipIndexUrl}
                      disabled={!draft.chinaEcosystemMirrorEnabled}
                      placeholder="https://pypi.tuna.tsinghua.edu.cn/simple"
                      onChange={(e) => set('chinaPipIndexUrl', e.target.value)}
                    />
                  </label>
                </div>
                <label className="field-label">
                  {t('chinaDockerRegistryMirror')}
                  <input
                    className="input input-block"
                    value={draft.chinaDockerRegistryMirror}
                    disabled={!draft.chinaEcosystemMirrorEnabled}
                    placeholder="https://docker.1ms.run"
                    onChange={(e) => set('chinaDockerRegistryMirror', e.target.value)}
                  />
                </label>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.preventDisplaySleep}
                    onChange={(e) => set('preventDisplaySleep', e.target.checked)}
                  />
                  {t('preventDisplaySleep')}
                </label>
                <p className="settings-hint">{t('preventDisplaySleepHint')}</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.autoSkillLearningEnabled}
                    onChange={(e) => set('autoSkillLearningEnabled', e.target.checked)}
                  />
                  P2-002 自动 Skill 沉淀与调用
                </label>
                <p className="settings-hint">
                  默认关闭。开启后成功任务会后台复盘并验证 Skill，下次同类任务会注入匹配 Skill。
                </p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.sdkAgentsEnabled}
                    onChange={(e) => set('sdkAgentsEnabled', e.target.checked)}
                  />
                  {t('sdkAgentsEnabled')}
                </label>
                <p className="settings-hint">{t('sdkAgentsHint')}</p>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.ideBridgeEnabled}
                    onChange={(e) => set('ideBridgeEnabled', e.target.checked)}
                  />
                  IDE Bridge
                </label>
                <p className="settings-hint">
                  默认关闭。开启后 VS Code/JetBrains 插件可连接本机 WebSocket。
                </p>
                <div className="settings-grid-2">
                  <label>
                    <span className="field-label">IDE Bridge Host</span>
                    <input
                      className="input input-block"
                      value={draft.ideBridgeHost}
                      placeholder="127.0.0.1"
                      onChange={(e) => set('ideBridgeHost', e.target.value)}
                    />
                  </label>
                  <label>
                    <span className="field-label">IDE Bridge Port</span>
                    <input
                      className="input input-block"
                      type="number"
                      min="0"
                      max="65535"
                      value={draft.ideBridgePort}
                      onChange={(e) => set('ideBridgePort', Number(e.target.value) || 17365)}
                    />
                  </label>
                </div>
                <label className="field-label">IDE Bridge Token</label>
                <input
                  className="input input-block"
                  value={draft.ideBridgeToken}
                  placeholder="可选；为空表示本机免 token"
                  onChange={(e) => set('ideBridgeToken', e.target.value)}
                />

                <label className="field-label">单会话预算上限 ($)</label>
                <input
                  className="input input-block"
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.budgetUsdPerSession || ''}
                  placeholder="0 = 不限制"
                  onChange={(e) => setBudget(e.target.value)}
                />
                <p className="settings-hint">达到预算后会拦截下一轮发送；0 表示不限制。</p>

                <label className="field-label">月度预算上限($)</label>
                <input
                  className="input input-block"
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.budgetUsdPerMonth || ''}
                  placeholder="0 = 不限制"
                  onChange={(e) => setMonthlyBudget(e.target.value)}
                />
                <p className="settings-hint">按当前自然月统计历史会话费用；达到上限后会拦截下一轮发送，auto 调度会优先降级到低成本模型。</p>

                <label className="field-label">{t('hookPostEdit')}</label>
                <input
                  className="input input-block"
                  value={draft.hookPostEditCommand}
                  placeholder="npx prettier --write . && npm test"
                  onChange={(e) => set('hookPostEditCommand', e.target.value)}
                />
                <p className="settings-hint">{t('hookPostEditHint')}</p>

                <label className="field-label">{t('hookTurnEnd')}</label>
                <input
                  className="input input-block"
                  value={draft.hookTurnEndCommand}
                  placeholder="npm run lint"
                  onChange={(e) => set('hookTurnEndCommand', e.target.value)}
                />
                <p className="settings-hint">{t('hookTurnEndHint')}</p>
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

                <label className="field-label">沙箱模式</label>
                <select
                  className="select select-block"
                  value={draft.sandboxMode}
                  onChange={(e) => set('sandboxMode', e.target.value as SandboxMode)}
                >
                  <option value="strictDocker">严格模式: Docker 容器</option>
                  <option value="standardSystem">标准模式: 系统沙箱</option>
                  <option value="loose">宽松模式: 路径牢笼</option>
                </select>
                <p className="settings-hint">
                  默认宽松以兼容旧会话；严格模式在 Docker 不可用时会自动降级并记录原因。
                </p>

                <label className="field-label">Docker 沙箱镜像</label>
                <input
                  className="input input-block"
                  value={draft.sandboxDockerImage}
                  placeholder="caogen-sandbox:latest 或 node:22-alpine"
                  onChange={(e) => set('sandboxDockerImage', e.target.value)}
                />

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

                <label className="field-label">权限白名单规则</label>
                <textarea
                  className="input input-block textarea"
                  rows={3}
                  value={draft.permissionAllowlist}
                  placeholder={'tool=read_file\nrisk<=low\ntool=write_file path=src/**'}
                  onChange={(e) => set('permissionAllowlist', e.target.value)}
                />

                <label className="field-label">权限黑名单规则</label>
                <textarea
                  className="input input-block textarea"
                  rows={3}
                  value={draft.permissionDenylist}
                  placeholder={'tool=bash risk>=high\npath=**/.ssh/**'}
                  onChange={(e) => set('permissionDenylist', e.target.value)}
                />

                <label className="field-label">临时允许规则</label>
                <textarea
                  className="input input-block textarea"
                  rows={3}
                  value={draft.permissionTemporaryAllowlist}
                  placeholder={`tool=bash risk<=low until=${Date.now() + 3600000}`}
                  onChange={(e) => set('permissionTemporaryAllowlist', e.target.value)}
                />

                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={draft.guiAutomationEnabled}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        guiAutomationEnabled: e.target.checked,
                        guiAutomationTemporaryGrantUntil: e.target.checked
                          ? d.guiAutomationTemporaryGrantUntil
                          : 0
                      }))
                    }
                  />
                  {t('guiAutomationEnabled')}
                </label>
                <p className="settings-hint">{t('guiAutomationHint')}</p>
              </>
            )}

            {tab === 'project' && <ProjectSettings />}

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
                    <div className="provider-empty">{t('providerEmpty')}</div>
                  )}
                  {providers.map((p) => {
                    const h = healthOf(p.id)
                    return (
                      <div key={p.id} className="provider-row">
                        <div className="provider-row-body">
                          <div className="provider-row-name">
                            {p.name}
                            {!p.hasToken && (
                              <span className="provider-tag-warn">{t('noKeyConfigured')}</span>
                            )}
                            {h && (
                              <span
                                className={`health-dot ${h.healthy ? 'health-ok' : 'health-bad'}`}
                                title={
                                  h.healthy
                                    ? t('healthOkTip', { s: h.successes, f: h.failures })
                                    : t('healthBadTip', { n: h.consecutiveFailures })
                                }
                              />
                            )}
                          </div>
                          <div className="provider-row-sub">
                            {p.baseUrl || t('officialEndpoint')} ·{' '}
                            {t('modelsCount', { n: p.models.length })}
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

            {tab === 'migrate' && (
              <>
                <h3 className="settings-h3">{t('migrateTitle')}</h3>
                <p className="settings-hint">{t('migrateHint')}</p>

                <label className="field-label">{t('projectDir')}</label>
                <div className="field-row">
                  <input
                    className="input"
                    value={migrateDir}
                    placeholder="/path/to/project"
                    onChange={(e) => setMigrateDir(e.target.value)}
                  />
                  <button
                    className="btn btn-ghost"
                    disabled={migrateBusy || !migrateDir.trim()}
                    onClick={() => void runScan(migrateDir)}
                  >
                    {migrateBusy ? t('migrateScanning') : t('migrateScan')}
                  </button>
                </div>

                {scan && (
                  <>
                    {scan.claudeNative && (
                      <p className="settings-hint">✓ {t('migrateClaudeNative')}</p>
                    )}
                    {scan.assets.length === 0 ? (
                      <div className="provider-empty">{t('migrateNothing')}</div>
                    ) : (
                      <div className="provider-list">
                        {scan.assets.map((a) => (
                          <label key={a.path} className="provider-row migrate-row" title={a.preview}>
                            <input
                              type="checkbox"
                              checked={picked.has(a.path)}
                              onChange={() => togglePick(a.path)}
                            />
                            <div className="provider-row-body">
                              <div className="provider-row-name">
                                {a.agent} · {a.name}
                                <span className="migrate-kind">
                                  {a.kind === 'rules'
                                    ? t('migrateKindRules')
                                    : a.kind === 'mcp'
                                      ? 'MCP'
                                      : t('migrateKindConfig')}
                                </span>
                              </div>
                              <div className="provider-row-sub">{a.path}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                    {scan.assets.length > 0 && (
                      <button
                        className="btn btn-primary"
                        disabled={migrateBusy || picked.size === 0}
                        onClick={() => void runImport()}
                      >
                        {migrateBusy
                          ? t('migrateImporting')
                          : t('migrateImport', { n: picked.size })}
                      </button>
                    )}
                  </>
                )}
                {migrateResult && (
                  <div className="notice notice-info migrate-result">{migrateResult}</div>
                )}
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
