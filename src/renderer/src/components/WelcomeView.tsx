import { useMemo, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import { APP_ICON_URL, APP_NAME } from '../brand'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../shared/types'
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
import {
  NEW_PROJECT,
  UNASSIGNED,
  useWelcomeDraftController
} from './experience/useWelcomeDraft'

interface WelcomeTool {
  key: string
  labelKey: string
  promptKey: string
  icon: HeaderIconName
}

type WelcomeRecoveryKind = 'compute' | 'provider'

function welcomeRecoveryKind(validationKey: string): WelcomeRecoveryKind | null {
  if (validationKey === 'assistantComputeUnavailable') return 'compute'
  return validationKey === 'explicitProviderRequired' ? 'provider' : null
}

const WELCOME_TOOLS: WelcomeTool[] = [
  {
    key: 'quick_start_project_read_only_v1',
    labelKey: 'welcomeFirstReadOnly',
    promptKey: 'welcomeFirstReadOnlyPrompt',
    icon: 'files'
  },
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
  const welcome = useWelcomeDraftController({ projects, providers, requestedProjectId, settings })
  const {
    availableProjects, cwd, driveMode, model, permissionMode, projectChoice,
    providerId, routingMode, text
  } = welcome
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKind, setRecoveryKind] = useState<WelcomeRecoveryKind | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const computeAvailable = hasAvailableCompute(providers)

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
    welcome.setRoutingMode(mode, fixedModelOptions[0]?.value ?? '')
  }

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (dir) {
      welcome.setPickedDirectory(dir)
      setError('')
      setRecoveryKind(null)
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
      setRecoveryKind(welcomeRecoveryKind(validationKey))
      return
    }
    setBusy(true)
    setError('')
    setRecoveryKind(null)
    try {
      await startSessionWithPrompt(welcomeSessionOptions(projection, draft, prompt), prompt)
      welcome.clear()
    } catch (err) {
      const safeKey = assistantSafeStartError(projection, err)
      setError(safeKey ? t(safeKey) : err instanceof Error ? err.message : String(err))
      setRecoveryKind(safeKey ? 'compute' : null)
      setBusy(false)
    }
  }

  const retryCompute = async (): Promise<void> => {
    setBusy(true)
    try {
      await refreshProviders()
      setError('')
      setRecoveryKind(null)
    } catch {
      const nextRecovery = recoveryKind ?? (projection === 'assistant' ? 'compute' : 'provider')
      setError(t(nextRecovery === 'provider' ? 'welcomeProviderRefreshFailed' : 'assistantComputeCheckFailed'))
      setRecoveryKind(nextRecovery)
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
                data-welcome-suggestion={tool.key}
                onClick={() => {
                  welcome.update({ text: t(tool.promptKey) })
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
              onChange={(e) => welcome.setProject(e.target.value)}
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
                  onChange={(event) => welcome.update({ cwd: event.target.value })}
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
              onChange={(e) => welcome.update({ text: e.target.value })}
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
                  onDriveChange={welcome.setDriveMode}
                  onModelChange={(nextModel) => welcome.update({ model: nextModel })}
                  onPermissionChange={(nextPermissionMode) => welcome.update({ permissionMode: nextPermissionMode })}
                  onProviderChange={welcome.setProvider}
                  onRoutingModeChange={onRoutingModeChange}
                />
              )}
              <button className="welcome-send" disabled={busy || !text.trim()} onClick={() => void submit()}>
                {busy ? '···' : '↑'}
              </button>
            </div>
          </div>
          <AssistantStartNotice
            busy={busy}
            error={error}
            recoveryKind={recoveryKind}
            onOpenSettings={() => setShowSettings(true, 'providers', 'welcome-provider-recovery')}
            onRetry={() => void retryCompute()}
          />
        </div>
      </div>
    </div>
  )
}
