import { useEffect, useMemo, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import { APP_ICON_URL, APP_NAME } from '../brand'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../shared/types'
import type { CaoGenDriveMode, PermissionModeId } from '../../../shared/types'
import { useExperienceProjection } from './experience/ExperienceProjection'
import AssistantStartNotice from './experience/AssistantStartNotice'
import WelcomeRoutingControls, {
  AssistantComputeIndicator
} from './experience/WelcomeRoutingControls'
import {
  assistantSafeStartError,
  hasAvailableCompute,
  welcomeSessionOptions,
  welcomeValidationKey,
  type WelcomeRoutingMode
} from './experience/welcome-session-projection'

const NEW_PROJECT = '__new_project__'
const UNASSIGNED = '__unassigned__'

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
  const projection = useExperienceProjection()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const requestedProjectId = useStore((s) => s.newSessionProjectId)
  const startSessionWithPrompt = useStore((s) => s.startSessionWithPrompt)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const setShowSettings = useStore((s) => s.setShowSettings)

  const availableProjects = useMemo(() => projects.filter((project) => !project.archived), [projects])
  const initialProject = availableProjects.find((project) => project.id === requestedProjectId) ?? availableProjects[0]
  const initialProvider = providers.find((provider) => provider.id === settings.defaultProviderId && provider.hasToken)
  const [text, setText] = useState('')
  const [projectChoice, setProjectChoice] = useState(initialProject?.id ?? NEW_PROJECT)
  const [cwd, setCwd] = useState(initialProject?.path ?? '')
  const [driveMode, setDriveMode] = useState<CaoGenDriveMode>(settings.driveMode)
  const [routingMode, setRoutingMode] = useState<WelcomeRoutingMode>('global')
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
  const [computeRecovery, setComputeRecovery] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const computeAvailable = hasAvailableCompute(providers)

  useEffect(() => {
    if (projectChoice !== NEW_PROJECT || cwd || availableProjects.length === 0) return
    setProjectChoice(availableProjects[0].id)
    setCwd(availableProjects[0].path)
  }, [availableProjects, cwd, projectChoice])

  useEffect(() => {
    if (!requestedProjectId) return
    const requested = availableProjects.find((project) => project.id === requestedProjectId)
    if (!requested) return
    setProjectChoice(requested.id)
    setCwd(requested.path)
  }, [availableProjects, requestedProjectId])

  useEffect(() => {
    if (projectChoice === NEW_PROJECT || projectChoice === UNASSIGNED) return
    if (availableProjects.some((project) => project.id === projectChoice)) return
    setProjectChoice(UNASSIGNED)
    setCwd('')
  }, [availableProjects, projectChoice])

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

  const onRoutingModeChange = (mode: WelcomeRoutingMode): void => {
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
      setComputeRecovery(false)
    }
  }

  const submit = async (): Promise<void> => {
    const prompt = text.trim()
    if (!prompt || busy) return
    const draft = {
      cwd,
      driveMode,
      model,
      permissionMode,
      projectId: availableProjects.some((project) => project.id === projectChoice) ? projectChoice : undefined,
      providerId,
      routingMode,
      unassigned: projectChoice === UNASSIGNED
    }
    const validationKey = welcomeValidationKey(projection, draft, computeAvailable)
    if (validationKey) {
      setError(t(validationKey))
      setComputeRecovery(projection === 'assistant' && validationKey === 'assistantComputeUnavailable')
      return
    }
    setBusy(true)
    setError('')
    setComputeRecovery(false)
    try {
      await startSessionWithPrompt(welcomeSessionOptions(projection, draft, prompt), prompt)
    } catch (err) {
      const safeKey = assistantSafeStartError(projection, err)
      setError(safeKey ? t(safeKey) : err instanceof Error ? err.message : String(err))
      setComputeRecovery(Boolean(safeKey))
      setBusy(false)
    }
  }

  const retryCompute = async (): Promise<void> => {
    setBusy(true)
    try {
      await refreshProviders()
      setError('')
      setComputeRecovery(false)
    } catch {
      setError(t('assistantComputeCheckFailed'))
      setComputeRecovery(true)
    } finally {
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
              {availableProjects.map((project) => (
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
              {projection === 'assistant' ? (
                <AssistantComputeIndicator available={computeAvailable} />
              ) : (
                <WelcomeRoutingControls
                  driveMode={driveMode}
                  fixedModelOptions={fixedModelOptions}
                  model={model}
                  permissionMode={permissionMode}
                  providerId={providerId}
                  providers={providers}
                  routingMode={routingMode}
                  routingStrategyLabel={routingStrategyLabel}
                  onDriveChange={onDriveChange}
                  onModelChange={setModel}
                  onPermissionChange={setPermissionMode}
                  onProviderChange={onProviderChange}
                  onRoutingModeChange={onRoutingModeChange}
                />
              )}
              <button className="welcome-send" disabled={busy || !text.trim()} onClick={() => void submit()}>
                {busy ? '···' : '↑'}
              </button>
            </div>
          </div>
          {projection === 'assistant' ? (
            <AssistantStartNotice
              busy={busy}
              error={error}
              recoverable={computeRecovery}
              onOpenSettings={() => setShowSettings(true)}
              onRetry={() => void retryCompute()}
            />
          ) : error ? <div className="notice notice-error welcome-error">{error}</div> : null}
        </div>
      </div>
    </div>
  )
}
