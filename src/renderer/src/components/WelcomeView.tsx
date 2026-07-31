import { useEffect, useMemo, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import { APP_ICON_URL, APP_NAME } from '../brand'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../shared/types'
import type { TaskStrategy } from '../../../shared/types'
import { useExperienceProjection } from './experience/ExperienceProjection'
import AssistantStartNotice from './experience/AssistantStartNotice'
import TaskStrategyControl from './experience/TaskStrategyControl'
import WelcomeRoutingControls, {
  AssistantComputeIndicator
} from './experience/WelcomeRoutingControls'
import {
  assistantSafeStartError,
  hasAvailableCompute,
  NEW_PROJECT_SESSION_CHOICE,
  welcomeSessionOptions,
  welcomeValidationKey,
  type WelcomeRoutingMode
} from './experience/welcome-session-projection'
import {
  UNASSIGNED,
  useWelcomeDraftController
} from './experience/useWelcomeDraft'

interface WelcomeTool {
  key: string
  labelKey: string
  promptKey: string
  icon: HeaderIconName
  taskStrategy: TaskStrategy
}

type WelcomeRecoveryKind = 'compute' | 'provider'

function welcomeRecoveryKind(validationKey: string): WelcomeRecoveryKind | null {
  if (validationKey === 'assistantComputeUnavailable') return 'compute'
  return validationKey === 'explicitProviderRequired' ? 'provider' : null
}

const WELCOME_TOOLS: WelcomeTool[] = [
  {
    key: 'understand',
    labelKey: 'welcomeUnderstandProject',
    promptKey: 'welcomeUnderstandProjectPrompt',
    icon: 'summary',
    taskStrategy: 'view'
  },
  {
    key: 'review',
    labelKey: 'welcomeReviewChanges',
    promptKey: 'welcomeReviewChangesPrompt',
    icon: 'review',
    taskStrategy: 'view'
  },
  {
    key: 'report',
    labelKey: 'welcomeOrganizeReport',
    promptKey: 'welcomeOrganizeReportPrompt',
    icon: 'files',
    taskStrategy: 'execute'
  },
  {
    key: 'plan',
    labelKey: 'welcomePlanTask',
    promptKey: 'welcomePlanTaskPrompt',
    icon: 'subagents',
    taskStrategy: 'plan'
  }
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
  const activateLocalCompute = useStore((s) => s.activateLocalCompute)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const welcome = useWelcomeDraftController({ projects, providers, requestedProjectId, settings })
  const {
    availableProjects, cwd, driveMode, model, projectChoice,
    providerId, routingMode, text
  } = welcome
  const [taskStrategy, setTaskStrategy] = useState<TaskStrategy>('execute')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKind, setRecoveryKind] = useState<WelcomeRecoveryKind | null>(null)
  const [localComputeStatus, setLocalComputeStatus] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle')
  const localComputeActivation = useRef<Promise<boolean> | null>(null)
  const submitPending = useRef(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const computeAvailable = hasAvailableCompute(providers)

  const ensureLocalCompute = async (): Promise<boolean> => {
    if (hasAvailableCompute(useStore.getState().providers)) return true
    if (localComputeActivation.current) return localComputeActivation.current
    setLocalComputeStatus('checking')
    const pending = activateLocalCompute()
      .then((result) => {
        if (result.status !== 'activated' || !result.provider) {
          setLocalComputeStatus('unavailable')
          return false
        }
        welcome.update({ providerId: result.provider.id, model: AUTO_MODEL })
        setLocalComputeStatus('ready')
        return true
      })
      .catch(() => {
        setLocalComputeStatus('unavailable')
        return false
      })
      .finally(() => {
        localComputeActivation.current = null
      })
    localComputeActivation.current = pending
    return pending
  }

  useEffect(() => {
    if (projection !== 'assistant' || computeAvailable || localComputeStatus !== 'idle') return
    void ensureLocalCompute()
  }, [computeAvailable, localComputeStatus, projection])

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

  const submit = async (
    promptInput = text,
    selectedStrategy = taskStrategy,
    title?: string
  ): Promise<void> => {
    const prompt = promptInput.trim()
    if (!prompt || busy || submitPending.current) return
    submitPending.current = true
    setBusy(true)
    const draft = {
      cwd,
      driveMode,
      model,
      taskStrategy: selectedStrategy,
      projectId: availableProjects.some((project) => project.id === projectChoice) ? projectChoice : undefined,
      providerId,
      routingMode,
      unassigned: projectChoice === UNASSIGNED
    }
    try {
      let available = computeAvailable
      if (projection === 'assistant' && !available) available = await ensureLocalCompute()
      const validationKey = welcomeValidationKey(projection, draft, available)
      if (validationKey) {
        setError(t(validationKey))
        setRecoveryKind(welcomeRecoveryKind(validationKey))
        return
      }
      setError('')
      setRecoveryKind(null)
      const options = welcomeSessionOptions(projection, draft, prompt)
      await startSessionWithPrompt(title ? { ...options, title } : options, prompt)
      welcome.clear()
    } catch (err) {
      const safeKey = assistantSafeStartError(projection, err)
      setError(safeKey ? t(safeKey) : err instanceof Error ? err.message : String(err))
      setRecoveryKind(safeKey ? 'compute' : null)
    } finally {
      submitPending.current = false
      setBusy(false)
    }
  }

  const startPreset = (tool: WelcomeTool): void => {
    const prompt = t(tool.promptKey)
    const title = t(tool.labelKey)
    welcome.update({ text: prompt })
    setTaskStrategy(tool.taskStrategy)
    void submit(prompt, tool.taskStrategy, title)
  }

  const retryCompute = async (): Promise<void> => {
    setBusy(true)
    try {
      const nextRecovery = recoveryKind ?? (projection === 'assistant' ? 'compute' : 'provider')
      if (nextRecovery === 'compute') {
        const activated = await ensureLocalCompute()
        if (!activated) await refreshProviders()
      } else {
        await refreshProviders()
      }
      const available = hasAvailableCompute(useStore.getState().providers)
      setError(available ? '' : t(nextRecovery === 'provider' ? 'explicitProviderRequired' : 'assistantComputeUnavailable'))
      setRecoveryKind(available ? null : nextRecovery)
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
                data-welcome-preset={tool.key}
                data-preset-strategy={tool.taskStrategy}
                disabled={busy}
                title={t('welcomePresetStartsNow')}
                onClick={() => startPreset(tool)}
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
              <option value={UNASSIGNED}>{t('directStartNoProject')}</option>
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
              <option value={NEW_PROJECT_SESSION_CHOICE}>{t('newProjectDirectory')}</option>
            </select>
            {projectChoice === NEW_PROJECT_SESSION_CHOICE ? (
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
            ) : projectChoice !== UNASSIGNED ? (
              <span className="welcome-project-current" title={cwd}>
                {cwd}
              </span>
            ) : null}
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
              <TaskStrategyControl value={taskStrategy} onChange={setTaskStrategy} compact />
              {projection === 'assistant' ? (
                <AssistantComputeIndicator
                  available={computeAvailable || localComputeStatus === 'ready'}
                  checking={localComputeStatus === 'checking'}
                />
              ) : (
                <WelcomeRoutingControls
                  driveMode={driveMode}
                  fixedModelOptions={fixedModelOptions}
                  model={model}
                  providerId={providerId}
                  providers={providers}
                  routingMode={routingMode}
                  routingStrategyLabel={routingStrategyLabel}
                  onDriveChange={welcome.setDriveMode}
                  onModelChange={(nextModel) => welcome.update({ model: nextModel })}
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
