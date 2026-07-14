import { useEffect, useMemo, useRef, useState } from 'react'
import { DRIVE_MODE_OPTIONS, modelOptionsForProvider, PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { APP_ICON_URL, APP_NAME } from '../brand'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import { AUTO_MODEL, AUTO_PROVIDER_ID, caogenDrivePolicyView } from '../../../shared/types'
import type { CaoGenDriveMode, PermissionModeId } from '../../../shared/types'

const NEW_PROJECT = '__new_project__'
const UNASSIGNED = '__unassigned__'
type RoutingMode = 'fixed' | 'provider' | 'global'

interface WelcomeTool {
  key: string
  labelKey: string
  promptKey: string
  icon: HeaderIconName
}

const WELCOME_TOOLS: WelcomeTool[] = [
  { key: 'explore', labelKey: 'welcomeExploreCode', promptKey: 'welcomeExploreCodePrompt', icon: 'files' },
  { key: 'build', labelKey: 'welcomeBuildFeature', promptKey: 'welcomeBuildFeaturePrompt', icon: 'terminal' },
  { key: 'review', labelKey: 'welcomeReviewCode', promptKey: 'welcomeReviewCodePrompt', icon: 'review' },
  { key: 'fix', labelKey: 'welcomeFixIssue', promptKey: 'welcomeFixIssuePrompt', icon: 'subagents' }
]

/**
 * 首屏"打开即输入":居中引导语 + 中央大输入框,
 * 内嵌项目选择 / Provider / 模型 / 权限,回车直接建会话并发送首条消息。
 */
export default function WelcomeView(): React.JSX.Element {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const requestedProjectId = useStore((s) => s.newSessionProjectId)
  const startSessionWithPrompt = useStore((s) => s.startSessionWithPrompt)

  const initialProject = projects.find((project) => project.id === requestedProjectId) ?? projects[0]
  const initialProvider = providers.find((provider) => provider.id === settings.defaultProviderId && provider.hasToken)
  const [text, setText] = useState('')
  const [projectChoice, setProjectChoice] = useState(initialProject?.id ?? NEW_PROJECT)
  const [cwd, setCwd] = useState(initialProject?.path ?? '')
  const [driveMode, setDriveMode] = useState<CaoGenDriveMode>(settings.driveMode)
  const [routingMode, setRoutingMode] = useState<RoutingMode>('global')
  const [providerId, setProviderId] = useState(initialProvider?.id ?? '')
  const [model, setModel] = useState(
    initialProvider
      ? settings.defaultModel && initialProvider.models.includes(settings.defaultModel)
        ? settings.defaultModel
        : AUTO_MODEL
      : ''
  )
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>(
    caogenDrivePolicyView(settings.driveMode).defaultPermissionMode
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (projectChoice !== NEW_PROJECT || cwd || projects.length === 0) return
    setProjectChoice(projects[0].id)
    setCwd(projects[0].path)
  }, [cwd, projectChoice, projects])

  useEffect(() => {
    if (!requestedProjectId) return
    const requested = projects.find((project) => project.id === requestedProjectId)
    if (!requested) return
    setProjectChoice(requested.id)
    setCwd(requested.path)
  }, [projects, requestedProjectId])

  useEffect(() => {
    if (providerId) return
    const preferred = providers.find(
      (provider) => provider.id === settings.defaultProviderId && provider.hasToken
    )
    if (!preferred) return
    setProviderId(preferred.id)
    setModel(
      settings.defaultModel && preferred.models.includes(settings.defaultModel)
        ? settings.defaultModel
        : AUTO_MODEL
    )
  }, [providerId, providers, settings.defaultModel, settings.defaultProviderId])

  const routingStrategy = driveMode === 'core'
    ? settings.schedulerStrategy
    : caogenDrivePolicyView(driveMode).schedulerStrategy
  const routingStrategyLabel = t(
    routingStrategy === 'quality'
      ? 'routingStrategyQuality'
      : routingStrategy === 'cost'
        ? 'routingStrategyCost'
        : routingStrategy === 'speed'
          ? 'routingStrategySpeed'
          : 'routingStrategyBalanced'
  )

  const modelOptions = useMemo(() => {
    return modelOptionsForProvider(
      providers,
      providerId,
      `${t('autoRoute')} · ${routingStrategyLabel}`,
      model
    )
  }, [model, providerId, providers, routingStrategyLabel, t])

  const fixedModelOptions = modelOptions.filter((option) => option.value !== AUTO_MODEL)

  const onRoutingModeChange = (mode: RoutingMode): void => {
    setRoutingMode(mode)
    if (mode === 'fixed') {
      setModel(fixedModelOptions[0]?.value ?? '')
      return
    }
    setModel(AUTO_MODEL)
  }

  const onProviderChange = (id: string): void => {
    setProviderId(id)
    const provider = providers.find((item) => item.id === id)
    setModel(routingMode === 'fixed' ? provider?.models[0] ?? '' : AUTO_MODEL)
  }

  const onDriveChange = (mode: CaoGenDriveMode): void => {
    const policy = caogenDrivePolicyView(mode)
    setDriveMode(mode)
    setModel(providerId ? AUTO_MODEL : '')
    setPermissionMode(policy.defaultPermissionMode)
  }

  const onProjectChange = (choice: string): void => {
    setProjectChoice(choice)
    const project = projects.find((item) => item.id === choice)
    setCwd(project?.path ?? '')
  }

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (dir) {
      setProjectChoice(projectChoice === UNASSIGNED ? UNASSIGNED : NEW_PROJECT)
      setCwd(dir)
      setError('')
    }
  }

  const submit = async (): Promise<void> => {
    const prompt = text.trim()
    if (!prompt || busy) return
    if (!cwd.trim()) {
      setError(t('errNeedProjectDir'))
      return
    }
    if (routingMode === 'global' && !providers.some((provider) => provider.hasToken && provider.models.length > 0)) {
      setError(t('explicitProviderRequired'))
      return
    }
    if (routingMode !== 'global' && !providerId) {
      setError(t('explicitProviderRequired'))
      return
    }
    if (routingMode === 'fixed' && (!model || model === AUTO_MODEL)) {
      setError(t('explicitModelRequired'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await startSessionWithPrompt(
        {
          cwd: cwd.trim(),
          projectId: projects.some((project) => project.id === projectChoice) ? projectChoice : undefined,
          unassigned: projectChoice === UNASSIGNED,
          driveMode,
          model: routingMode === 'fixed' ? model : AUTO_MODEL,
          providerId: routingMode === 'global' ? AUTO_PROVIDER_ID : providerId,
          routingScope: routingMode,
          initialPrompt: prompt,
          permissionMode
        },
        prompt
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="welcome welcome-hero">
      <div className="welcome-stage">
        <div className="welcome-hero-inner">
          <img className="welcome-logo" src={APP_ICON_URL} alt={APP_NAME} />
          <h1 className="welcome-ask">{t('welcomeAsk')}</h1>
          <div className="welcome-suggestion-grid">
            {WELCOME_TOOLS.map((tool) => (
              <button
                key={tool.key}
                type="button"
                className="welcome-suggestion"
                onClick={() => {
                  setText(t(tool.promptKey))
                  requestAnimationFrame(() => taRef.current?.focus())
                }}
              >
                <HeaderIcon name={tool.icon} />
                <span>{t(tool.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="welcome-compose-dock">
          <div className="welcome-project-bar">
            <select
              className="welcome-project-select"
              aria-label={t('project')}
              title={cwd || t('welcomePickProject')}
              value={projectChoice}
              onChange={(e) => onProjectChange(e.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
              <option value={NEW_PROJECT}>{t('newProjectDirectory')}</option>
              <option value={UNASSIGNED}>{t('unassignedSessions')}</option>
            </select>
            {projectChoice === NEW_PROJECT || projectChoice === UNASSIGNED ? (
              <>
                <input
                  className="welcome-project-path"
                  value={cwd}
                  placeholder="/path/to/project"
                  aria-label={t('projectDir')}
                  onChange={(event) => setCwd(event.target.value)}
                />
                <button className="welcome-project-browse" onClick={() => void browse()}>
                  {t('browse')}
                </button>
              </>
            ) : (
              <span className="welcome-project-current" title={cwd}>
                {cwd}
              </span>
            )}
          </div>
          <div className="welcome-composer">
            <textarea
              ref={taRef}
              className="welcome-composer-input"
              placeholder={t('welcomeInputPlaceholder')}
              value={text}
              rows={2}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              autoFocus
            />
            <div className="welcome-composer-bar">
              <div className="welcome-routing-modes" role="group" aria-label={t('routingMode')}>
                {(['fixed', 'provider', 'global'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={routingMode === mode ? 'active' : ''}
                    onClick={() => onRoutingModeChange(mode)}
                  >
                    {t(
                      mode === 'fixed'
                        ? 'routingModeFixed'
                        : mode === 'provider'
                          ? 'routingModeProvider'
                          : 'routingModeGlobal'
                    )}
                  </button>
                ))}
              </div>
              {routingMode !== 'global' && (
                <select
                  className="welcome-mini-select"
                  value={providerId}
                  onChange={(e) => onProviderChange(e.target.value)}
                >
                  <option value="" disabled>
                    {t('selectProviderPlaceholder')}
                  </option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.hasToken}>
                      {p.name}
                      {p.hasToken ? '' : ` (${t('noKeyConfigured')})`}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="welcome-mini-select"
                value={driveMode}
                onChange={(e) => onDriveChange(e.target.value as CaoGenDriveMode)}
              >
                {DRIVE_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {routingMode === 'fixed' ? (
                <select className="welcome-mini-select" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="" disabled>
                    {t('selectModelPlaceholder')}
                  </option>
                  {fixedModelOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="welcome-routing-summary">
                  {routingMode === 'global' ? t('routingModeGlobalSummary') : t('routingModeProviderSummary')}
                  {' · '}
                  {routingStrategyLabel}
                </span>
              )}
              <select
                className="welcome-mini-select"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as PermissionModeId)}
              >
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button className="welcome-send" disabled={busy || !text.trim()} onClick={() => void submit()}>
                {busy ? '···' : '↑'}
              </button>
            </div>
          </div>
          {error && <div className="notice notice-error welcome-error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
