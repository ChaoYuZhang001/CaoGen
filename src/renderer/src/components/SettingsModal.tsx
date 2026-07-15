import { useEffect, useMemo, useRef, useState } from 'react'
import { DRIVE_MODE_OPTIONS, modelOptionsForProvider, PERMISSION_OPTIONS, STRATEGY_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { AUTO_MODEL } from '../../../shared/types'
import type {
  AppLanguage,
  AppTheme,
  CaoGenDriveMode,
  EngineInfo,
  McpProbeResult,
  MigrationScan,
  ModelRoutingRule,
  ModelRoutingTaskKind,
  OfficeQualityMode,
  PermissionModeId,
  PluginRegistryItem,
  PluginRegistryView,
  ProviderHealthView,
  ProviderView,
  SchedulerStrategy,
  SessionMeta
} from '../../../shared/types'
import ProviderEditor from './ProviderEditor'
import ControlCenter from './ControlCenter'
import ProjectSettings from '../pages/ProjectSettings'

type Tab = 'control' | 'general' | 'permissions' | 'project' | 'persona' | 'office' | 'providers' | 'plugins' | 'migrate'
const DEFAULT_OFFICE_SETTINGS = { qualityMode: 'auto' as const, showBadges: true, liveliness: 1, catEars: false }
const OFFICE_QUALITY_OPTIONS: Array<{ value: OfficeQualityMode; labelKey: string }> = [
  { value: 'auto', labelKey: 'officeQualityAuto' },
  { value: 'high', labelKey: 'officeQualityHigh' },
  { value: 'balanced', labelKey: 'officeQualityBalanced' },
  { value: 'low', labelKey: 'officeQualityLow' }
]
const ROUTING_RULE_TASK_OPTIONS: Array<{ value: ModelRoutingTaskKind; labelKey: string }> = [
  { value: 'research', labelKey: 'routingTaskResearch' },
  { value: 'planning', labelKey: 'routingTaskPlanning' },
  { value: 'coding', labelKey: 'routingTaskCoding' },
  { value: 'testing', labelKey: 'routingTaskTesting' },
  { value: 'documentation', labelKey: 'routingTaskDocumentation' },
  { value: 'reasoning', labelKey: 'routingTaskReasoning' },
  { value: 'review', labelKey: 'routingTaskReview' },
  { value: 'summarization', labelKey: 'routingTaskSummarization' },
  { value: 'vision', labelKey: 'routingTaskVision' },
  { value: 'longContext', labelKey: 'routingTaskLongContext' }
]

const TASK_MODEL_ROLE_OPTIONS = [
  { labelKey: 'modelRoleResearch', providerKey: 'researchProviderId', modelKey: 'researchModel' },
  { labelKey: 'modelRolePlanning', providerKey: 'planningProviderId', modelKey: 'planningModel' },
  { labelKey: 'modelRoleCoding', providerKey: 'codingProviderId', modelKey: 'codingModel' },
  { labelKey: 'modelRoleTesting', providerKey: 'testingProviderId', modelKey: 'testingModel' },
  { labelKey: 'modelRoleDocumentation', providerKey: 'documentationProviderId', modelKey: 'documentationModel' }
] as const

function createRoutingRule(): ModelRoutingRule {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id: `route-${suffix}`,
    enabled: true,
    name: '',
    match: '',
    keywordMode: 'any',
    taskKinds: [],
    providerId: '',
    model: ''
  }
}

function uniqueModelOptions(
  providers: ProviderView[],
  providerId: string,
  currentModel: string
): Array<{ value: string; label: string }> {
  const seen = new Set<string>()
  const options: Array<{ value: string; label: string }> = []
  const add = (value: string, label = value): void => {
    const clean = value.trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    options.push({ value: clean, label })
  }
  const scopedProviders = providerId ? providers.filter((provider) => provider.id === providerId) : providers
  for (const provider of scopedProviders) {
    for (const model of provider.models) add(model)
  }
  add(currentModel)
  return options
}

export default function SettingsPage(): React.JSX.Element {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const history = useStore((s) => s.history)
  const sessionOrder = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const updateSettings = useStore((s) => s.updateSettings)
  const updateProvider = useStore((s) => s.updateProvider)
  const deleteProvider = useStore((s) => s.deleteProvider)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const setShowSettings = useStore((s) => s.setShowSettings)

  const [tab, setTab] = useState<Tab>('control')
  const tabsRef = useRef<HTMLElement>(null)
  // 本地草稿,保存时统一提交
  const [draft, setDraft] = useState(settings)
  const [editing, setEditing] = useState<ProviderView | 'new' | null>(null)
  const [health, setHealth] = useState<ProviderHealthView[]>([])
  const [checkingProviderId, setCheckingProviderId] = useState('')
  const [providerProbe, setProviderProbe] = useState<{ providerId: string; ok: boolean; message: string } | null>(null)
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [pluginRegistry, setPluginRegistry] = useState<PluginRegistryView | undefined>(undefined)
  const [mcpProbeResults, setMcpProbeResults] = useState<Record<string, McpProbeResult>>({})
  const [controlLoading, setControlLoading] = useState(false)
  const [controlMcpProbing, setControlMcpProbing] = useState(false)
  const [controlError, setControlError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  // 迁移向导状态
  const activeSession = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const activeId = useStore((s) => s.activeId)
  const projects = useStore((s) => s.projects)
  const [migrateDir, setMigrateDir] = useState('')
  const [scan, setScan] = useState<MigrationScan | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [migrateBusy, setMigrateBusy] = useState(false)
  const [migrateResult, setMigrateResult] = useState('')
  const selectedDrive = DRIVE_MODE_OPTIONS.find((option) => option.value === draft.driveMode) ?? DRIVE_MODE_OPTIONS[1]
  const draftOffice = draft.office ?? DEFAULT_OFFICE_SETTINGS
  const activeSessions = useMemo<SessionMeta[]>(
    () => sessionOrder.flatMap((sessionId) => {
      const session = sessions[sessionId]
      return session ? [session.meta] : []
    }),
    [sessionOrder, sessions]
  )

  useEffect(() => {
    void window.agentDesk.listProviderHealth().then(setHealth)
  }, [])

  useEffect(() => {
    if (tab === 'control') void refreshControlCenter()
  }, [tab, activeId])

  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>(`[data-settings-tab="${tab}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])

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
  const patchDraft = (patch: Partial<typeof draft>): void =>
    setDraft((d) => ({ ...d, ...patch }))
  const setBudget = (value: string): void => {
    const budget = Number(value)
    set('budgetUsdPerSession', Number.isFinite(budget) && budget > 0 ? budget : 0)
  }
  const setMonthlyBudget = (value: string): void => {
    const budget = Number(value)
    set('budgetUsdPerMonth', Number.isFinite(budget) && budget > 0 ? budget : 0)
  }
  const setOffice = (patch: Partial<typeof draftOffice>): void =>
    setDraft((d) => ({ ...d, office: { ...(d.office ?? DEFAULT_OFFICE_SETTINGS), ...patch } }))
  const setLayout = (patch: Partial<typeof draft.layout>): void =>
    setDraft((d) => ({ ...d, layout: { ...d.layout, ...patch } }))
  const updateRoutingRule = (id: string, patch: Partial<ModelRoutingRule>): void =>
    setDraft((d) => ({
      ...d,
      modelRoutingRules: (d.modelRoutingRules ?? []).map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule
      )
    }))
  const setRoutingRuleTaskKind = (id: string, taskKind: ModelRoutingTaskKind, enabled: boolean): void =>
    setDraft((d) => ({
      ...d,
      modelRoutingRules: (d.modelRoutingRules ?? []).map((rule) => {
        if (rule.id !== id) return rule
        const taskKinds = enabled
          ? [...new Set([...(rule.taskKinds ?? []), taskKind])]
          : (rule.taskKinds ?? []).filter((item) => item !== taskKind)
        return { ...rule, taskKinds }
      })
    }))
  const addRoutingRule = (): void =>
    setDraft((d) => ({
      ...d,
      modelRoutingRules: [...(d.modelRoutingRules ?? []), createRoutingRule()]
    }))
  const deleteRoutingRule = (id: string): void =>
    setDraft((d) => ({
      ...d,
      modelRoutingRules: (d.modelRoutingRules ?? []).filter((rule) => rule.id !== id)
    }))

  const healthOf = (pid: string): ProviderHealthView | undefined =>
    health.find((h) => h.providerId === (pid || 'local-login'))

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError('')
    try {
      await updateSettings(draft)
      setShowSettings(false)
    } catch {
      setSaveError(t('settingsSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const refreshControlCenter = async (): Promise<void> => {
    setControlLoading(true)
    setControlError('')
    try {
      await refreshProviders()
      const [nextHealth, nextEngines, nextPluginRegistry] = await Promise.all([
        window.agentDesk.listProviderHealth(),
        window.agentDesk.listEngines(),
        window.agentDesk.scanPluginRegistry(activeId ?? undefined)
      ])
      setHealth(nextHealth)
      setEngines(nextEngines)
      setPluginRegistry(nextPluginRegistry)
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlLoading(false)
    }
  }

  const probeControlMcp = async (items: PluginRegistryItem[]): Promise<void> => {
    setControlMcpProbing(true)
    setControlError('')
    try {
      const results = await window.agentDesk.probeMcpServers(items, activeId ?? undefined)
      setMcpProbeResults((prev) => {
        const merged = { ...prev }
        for (const result of results) merged[result.id] = result
        return merged
      })
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err))
    } finally {
      setControlMcpProbing(false)
    }
  }

  const remove = async (p: ProviderView): Promise<void> => {
    await deleteProvider(p.id)
  }

  const openProviderEditor = (target: ProviderView | 'new'): void => {
    setTab('providers')
    setEditing(target)
  }

  const probeProvider = async (p: ProviderView): Promise<void> => {
    setCheckingProviderId(p.id)
    setProviderProbe(null)
    try {
      const result = await window.agentDesk.fetchProviderModels({
        baseUrl: p.baseUrl,
        providerId: p.id,
        openaiProtocol: p.openaiProtocol
      })
      if (result.ok) {
        await updateProvider(p.id, { models: result.models })
        const nextHealth = await window.agentDesk.listProviderHealth()
        setHealth(nextHealth)
        setProviderProbe({
          providerId: p.id,
          ok: true,
          message: t('providerProbeOk', {
            n: result.models.length,
            latencyMs: result.latencyMs ?? 0
          })
        })
      } else {
        const nextHealth = await window.agentDesk.listProviderHealth()
        setHealth(nextHealth)
        setProviderProbe({
          providerId: p.id,
          ok: false,
          message: t('providerProbeFailed', { message: result.error?.message ?? t('fetchModelsFailed') })
        })
      }
    } catch (err) {
      const nextHealth = await window.agentDesk.listProviderHealth().catch(() => health)
      setHealth(nextHealth)
      setProviderProbe({
        providerId: p.id,
        ok: false,
        message: t('providerProbeFailed', { message: err instanceof Error ? err.message : String(err) })
      })
    } finally {
      setCheckingProviderId('')
    }
  }

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'control', label: t('tabControlCenter') },
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
    <section className="settings-page" aria-label={t('settingsTitle')}>
      <header className="settings-page-header drag-region">
        <button
          type="button"
          className="settings-page-back no-drag"
          aria-label={t('backToWorkspace')}
          title={t('backToWorkspace')}
          onClick={() => setShowSettings(false)}
        >
          ←
        </button>
        <h1 className="settings-page-title">{t('settingsTitle')}</h1>
      </header>

      <div className="settings-body">
          <nav ref={tabsRef} className="settings-tabs" aria-label={t('settingsNavigation')}>
            {TABS.map((tb) => (
              <button
                type="button"
                key={tb.id}
                data-settings-tab={tb.id}
                className={`settings-tab ${tab === tb.id ? 'active' : ''}`}
                aria-current={tab === tb.id ? 'page' : undefined}
                onClick={() => {
                  setEditing(null)
                  setTab(tb.id)
                }}
              >
                {tb.label}
              </button>
            ))}
          </nav>

          <main className="settings-pane">
            <div className="settings-pane-content">
            {editing ? (
              <ProviderEditor
                provider={editing === 'new' ? null : editing}
                onClose={() => setEditing(null)}
              />
            ) : (
              <>
            {tab === 'control' && (
              <ControlCenter
                settings={draft}
                providers={providers}
                history={history}
                activeSessions={activeSessions}
                health={health}
                engines={engines}
                pluginRegistry={pluginRegistry}
                mcpProbeResults={mcpProbeResults}
                loading={controlLoading}
                mcpProbing={controlMcpProbing}
                error={controlError}
                onRefresh={() => void refreshControlCenter()}
                onProbeMcp={(items) => void probeControlMcp(items)}
                onSettingsPatch={patchDraft}
                onAddProvider={() => openProviderEditor('new')}
                onEditProvider={(provider) => openProviderEditor(provider)}
              />
            )}

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
                    setSaveError('')
                    void updateSettings({ theme: v }).catch(() => setSaveError(t('settingsSaveFailed')))
                  }}
                >
                  <option value="light">{t('themeLight')}</option>
                  <option value="dark">{t('themeDark')}</option>
                  <option value="system">{t('themeSystem')}</option>
                </select>

                <label className="field-label">{t('driveMode')}</label>
                <select
                  className="select select-block"
                  value={draft.driveMode}
                  onChange={(e) => set('driveMode', e.target.value as CaoGenDriveMode)}
                >
                  {DRIVE_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="settings-hint">
                  {selectedDrive.summary} · ${selectedDrive.budgetUsd}/session · {selectedDrive.toolPolicySummary}
                </p>

                <label className="field-label">{t('defaultProvider')}</label>
                <select
                  className="select select-block"
                  value={draft.defaultProviderId}
                  onChange={(e) => {
                    const defaultProviderId = e.target.value
                    patchDraft({ defaultProviderId, defaultModel: defaultProviderId ? AUTO_MODEL : '' })
                  }}
                >
                  <option value="">{t('noDefaultProvider')}</option>
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
                  <option value="">{t('noDefaultModel')}</option>
                  {modelOptionsForProvider(
                    providers,
                    draft.defaultProviderId,
                    t('autoRoute'),
                    draft.defaultModel
                  ).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                <div className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-h3">{t('modelRolesSection')}</h3>
                  </div>
                  <p className="settings-hint">{t('modelRolesHint')}</p>
                  <div className="model-task-role-list">
                    {TASK_MODEL_ROLE_OPTIONS.map((role) => {
                      const providerId = draft[role.providerKey]
                      const model = draft[role.modelKey]
                      return (
                        <div key={role.providerKey} className="settings-grid-2 model-task-role-row">
                          <label className="field-label">
                            {t(role.labelKey)} · {t('modelRoleProvider')}
                            <select
                              className="select select-block"
                              value={providerId}
                              onChange={(e) =>
                                patchDraft({
                                  [role.providerKey]: e.target.value,
                                  [role.modelKey]: ''
                                })
                              }
                            >
                              <option value="">{t('noRoleProvider')}</option>
                              {providers.map((provider) => (
                                <option key={provider.id} value={provider.id}>
                                  {provider.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field-label">
                            {t(role.labelKey)} · {t('modelRoleModel')}
                            <select
                              className="select select-block"
                              value={model}
                              onChange={(e) => patchDraft({ [role.modelKey]: e.target.value })}
                            >
                              <option value="">{t('noRoleModel')}</option>
                              {uniqueModelOptions(providers, providerId, model).map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                  <h4 className="settings-h4 model-role-advanced-title">{t('modelRolesAdvanced')}</h4>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleLowCost')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.lowCostProviderId}
                        onChange={(e) => patchDraft({ lowCostProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleLowCost')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.lowCostModel}
                        onChange={(e) => patchDraft({ lowCostModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.lowCostProviderId, draft.lowCostModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleStrongReasoning')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.strongReasoningProviderId}
                        onChange={(e) => patchDraft({ strongReasoningProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleStrongReasoning')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.strongReasoningModel}
                        onChange={(e) => patchDraft({ strongReasoningModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.strongReasoningProviderId, draft.strongReasoningModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleReview')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.reviewProviderId}
                        onChange={(e) => patchDraft({ reviewProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleReview')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.reviewModel}
                        onChange={(e) => patchDraft({ reviewModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.reviewProviderId, draft.reviewModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('modelRoleFallback')} · {t('modelRoleProvider')}
                      <select
                        className="select select-block"
                        value={draft.fallbackProviderId}
                        onChange={(e) => patchDraft({ fallbackProviderId: e.target.value })}
                      >
                        <option value="">{t('noRoleProvider')}</option>
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      {t('modelRoleFallback')} · {t('modelRoleModel')}
                      <select
                        className="select select-block"
                        value={draft.fallbackModel}
                        onChange={(e) => patchDraft({ fallbackModel: e.target.value })}
                      >
                        <option value="">{t('noRoleModel')}</option>
                        {uniqueModelOptions(providers, draft.fallbackProviderId, draft.fallbackModel).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-h3">{t('customRoutingRules')}</h3>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={addRoutingRule}>
                      {t('addRoutingRule')}
                    </button>
                  </div>
                  <p className="settings-hint">{t('customRoutingRulesHint')}</p>
                  {(draft.modelRoutingRules ?? []).map((rule, index) => (
                    <div key={rule.id} className="routing-rule-card">
                      <div className="routing-rule-head">
                        <label className="settings-check routing-rule-toggle">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(e) => updateRoutingRule(rule.id, { enabled: e.target.checked })}
                          />
                          {t('routingRuleEnabled')}
                        </label>
                        <span className="routing-rule-order">#{index + 1}</span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => deleteRoutingRule(rule.id)}
                        >
                          {t('delete')}
                        </button>
                      </div>
                      <label className="field-label">
                        {t('routingRuleName')}
                        <input
                          className="input"
                          value={rule.name}
                          placeholder={t('routingRuleNamePlaceholder')}
                          onChange={(e) => updateRoutingRule(rule.id, { name: e.target.value })}
                        />
                      </label>
                      <label className="field-label">
                        {t('routingRuleMatch')}
                        <textarea
                          className="input textarea"
                          value={rule.match}
                          placeholder={t('routingRuleMatchPlaceholder')}
                          rows={2}
                          onChange={(e) => updateRoutingRule(rule.id, { match: e.target.value })}
                        />
                      </label>
                      <div className="settings-grid-2">
                        <label className="field-label">
                          {t('routingRuleProvider')}
                          <select
                            className="select select-block"
                            value={rule.providerId}
                            onChange={(e) => updateRoutingRule(rule.id, { providerId: e.target.value })}
                          >
                            <option value="">{t('noRoleProvider')}</option>
                            {providers.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field-label">
                          {t('routingRuleModel')}
                          <select
                            className="select select-block"
                            value={rule.model}
                            onChange={(e) => updateRoutingRule(rule.id, { model: e.target.value })}
                          >
                            <option value="">{t('noRoleModel')}</option>
                            {uniqueModelOptions(providers, rule.providerId, rule.model).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="routing-rule-condition-grid">
                        <label className="field-label">
                          {t('routingRuleKeywordMode')}
                          <select
                            className="select select-block"
                            value={rule.keywordMode ?? 'any'}
                            onChange={(e) => updateRoutingRule(rule.id, { keywordMode: e.target.value === 'all' ? 'all' : 'any' })}
                          >
                            <option value="any">{t('routingRuleKeywordAny')}</option>
                            <option value="all">{t('routingRuleKeywordAll')}</option>
                          </select>
                        </label>
                        <label className="field-label">
                          {t('routingRuleWhenStrategy')}
                          <select
                            className="select select-block"
                            value={rule.whenStrategy ?? ''}
                            onChange={(e) => updateRoutingRule(rule.id, {
                              whenStrategy: e.target.value ? e.target.value as SchedulerStrategy : undefined
                            })}
                          >
                            <option value="">{t('routingRuleAnyStrategy')}</option>
                            {STRATEGY_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field-label">
                          {t('routingRuleMinRisk')}
                          <select
                            className="select select-block"
                            value={rule.minRiskLevel ?? ''}
                            onChange={(e) => updateRoutingRule(rule.id, {
                              minRiskLevel:
                                e.target.value === 'low' || e.target.value === 'medium' || e.target.value === 'high'
                                  ? e.target.value
                                  : undefined
                            })}
                          >
                            <option value="">{t('routingRuleAnyRisk')}</option>
                            <option value="low">{t('routingRiskLow')}</option>
                            <option value="medium">{t('routingRiskMedium')}</option>
                            <option value="high">{t('routingRiskHigh')}</option>
                          </select>
                        </label>
                      </div>
                      <fieldset className="routing-rule-task-field">
                        <legend>{t('routingRuleTaskKinds')}</legend>
                        <div className="routing-rule-task-grid">
                          {ROUTING_RULE_TASK_OPTIONS.map((option) => (
                            <label key={option.value} className="routing-rule-task-option">
                              <input
                                type="checkbox"
                                checked={(rule.taskKinds ?? []).includes(option.value)}
                                onChange={(e) => setRoutingRuleTaskKind(rule.id, option.value, e.target.checked)}
                              />
                              <span>{t(option.labelKey)}</span>
                            </label>
                          ))}
                        </div>
                        <small>{t('routingRuleTaskKindsHint')}</small>
                      </fieldset>
                    </div>
                  ))}
                </div>

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

                <label className="field-label">{t('localExecutionLabel')}</label>
                {draft.sandboxMode === 'disabled' ? (
                  <div className="notice notice-error">
                    <p>{t('legacyDockerMigrationWarning')}</p>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => set('sandboxMode', 'restrictedLocal')}
                    >
                      {t('enableLocalExecution')}
                    </button>
                  </div>
                ) : (
                  <p className="settings-hint">{t('localExecutionHint')}</p>
                )}

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
                <div className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-h3">{t('layoutSection')}</h3>
                  </div>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={draft.layout.sidebarCollapsed}
                      onChange={(e) => setLayout({ sidebarCollapsed: e.target.checked })}
                    />
                    {t('layoutSidebarCollapsed')}
                  </label>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('layoutSidebarWidth')} · {draft.layout.sidebarWidth}px
                      <input
                        type="range"
                        className="input-block"
                        min={220}
                        max={420}
                        step={4}
                        value={draft.layout.sidebarWidth}
                        onChange={(e) => setLayout({ sidebarWidth: Number(e.target.value) })}
                      />
                    </label>
                    <label className="field-label">
                      {t('layoutToolPanelWidth')} · {draft.layout.workbenchSideWidth}px
                      <input
                        type="range"
                        className="input-block"
                        min={360}
                        max={900}
                        step={8}
                        value={draft.layout.workbenchSideWidth}
                        onChange={(e) => setLayout({ workbenchSideWidth: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <div className="settings-grid-2">
                    <label className="field-label">
                      {t('layoutChatScale')} · {Math.round(draft.layout.chatScale * 100)}%
                      <input
                        type="range"
                        className="input-block"
                        min={0.85}
                        max={1.25}
                        step={0.05}
                        value={draft.layout.chatScale}
                        onChange={(e) => setLayout({ chatScale: Number(e.target.value) })}
                      />
                    </label>
                    <label className="field-label">
                      {t('layoutChatDensity')}
                      <select
                        className="select select-block"
                        value={draft.layout.chatDensity}
                        onChange={(e) =>
                          setLayout({ chatDensity: e.target.value as typeof draft.layout.chatDensity })
                        }
                      >
                        <option value="comfortable">{t('chatDensityComfortable')}</option>
                        <option value="compact">{t('chatDensityCompact')}</option>
                      </select>
                    </label>
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-h3">{t('officeTitle')}</h3>
                  </div>
                  <div className="office-quality-control">
                    <div className="field-label">{t('officeQualityMode')}</div>
                    <div className="office-quality-options" role="group" aria-label={t('officeQualityMode')}>
                      {OFFICE_QUALITY_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`office-quality-option ${draftOffice.qualityMode === option.value ? 'active' : ''}`}
                          aria-pressed={draftOffice.qualityMode === option.value}
                          data-office-quality-option={option.value}
                          onClick={() => setOffice({ qualityMode: option.value })}
                        >
                          {t(option.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={draftOffice.showBadges}
                      onChange={(e) => setOffice({ showBadges: e.target.checked })}
                    />
                    {t('officeShowBadges')}
                  </label>
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={draftOffice.catEars}
                      onChange={(e) => setOffice({ catEars: e.target.checked })}
                    />
                    {t('officeCatEars')}
                  </label>
                  <label className="field-label">
                    {t('officeLiveliness')} · {draftOffice.liveliness.toFixed(1)}×
                  </label>
                  <input
                    type="range"
                    className="input-block"
                    min={0.2}
                    max={1.2}
                    step={0.1}
                    value={draftOffice.liveliness}
                    onChange={(e) => setOffice({ liveliness: Number(e.target.value) })}
                  />
                </div>
              </>
            )}

            {tab === 'providers' && (
              <>
                <div className="settings-section-head">
                  <h3 className="settings-h3">{t('tabProviders')}</h3>
                  <button className="btn btn-ghost btn-sm" onClick={() => openProviderEditor('new')}>
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
                                    ? t('healthOkTip', {
                                        s: h.successes,
                                        f: h.failures,
                                        latencyMs: h.latencyEmaMs ?? h.lastLatencyMs ?? '-'
                                      })
                                    : t('healthBadTip', {
                                        n: h.consecutiveFailures,
                                        error: h.recentFailures?.[0]?.message ?? h.lastError ?? '-'
                                      })
                                }
                              />
                            )}
                          </div>
                          <div className="provider-row-sub">
                            {p.baseUrl || t('officialEndpoint')} ·{' '}
                            {t('modelsCount', { n: p.models.length })} ·{' '}
                            {p.hasToken
                              ? `${t('apiKeyCountLabel', { n: p.keyCount ?? 1 })}${p.activeKeyLabel ? ` · ${p.activeKeyLabel}` : ''}`
                              : t('noKeyConfigured')}
                          </div>
                          {providerProbe?.providerId === p.id && (
                            <div className={`provider-probe-message ${providerProbe.ok ? 'provider-probe-ok' : 'provider-probe-bad'}`}>
                              {providerProbe.message}
                            </div>
                          )}
                        </div>
                        <div className="provider-row-actions">
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={checkingProviderId === p.id}
                            onClick={() => void probeProvider(p)}
                          >
                            {checkingProviderId === p.id ? t('providerProbing') : t('providerProbe')}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => openProviderEditor(p)}>
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
              </>
            )}
            </div>
          </main>
      </div>

        {!editing && <footer className="settings-page-actions">
          {saveError && (
            <div className="settings-save-error" role="alert" data-settings-save-error>
              {saveError}
            </div>
          )}
          <button className="btn btn-ghost" disabled={saving} onClick={() => setShowSettings(false)}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? t('saving') : t('save')}
          </button>
        </footer>}
    </section>
  )
}
