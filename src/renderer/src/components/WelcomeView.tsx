import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import { APP_ICON_URL, APP_NAME } from '../brand'
import { HeaderIcon, type HeaderIconName } from './ChatHeaderIcons'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../shared/types'
import type { LocalComputeActivationResult, Project, TaskStrategy } from '../../../shared/types'
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
  type WelcomeRoutingMode,
  type WelcomeSessionDraft
} from './experience/welcome-session-projection'
import {
  UNASSIGNED,
  useWelcomeDraftController
} from './experience/useWelcomeDraft'
import {
  deriveFirstTaskOnboardingStatus,
  deriveFirstTaskProgress,
  patchFirstTaskOnboardingRecord,
  runFirstTaskSubmissionExclusive,
  useFirstTaskOnboardingRecord
} from './experience/first-task-onboarding'

type WelcomeStoreState = ReturnType<typeof useStore.getState>
type WelcomeProjection = ReturnType<typeof useExperienceProjection>

function useLocalComputeActivation(
  projection: WelcomeProjection,
  providersLoaded: boolean,
  computeAvailable: boolean,
  activateLocalCompute: () => Promise<LocalComputeActivationResult>,
  updateWelcomeDraft: WelcomeStoreState['updateWelcomeDraft']
) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle')
  const activation = useRef<Promise<boolean> | null>(null)
  const ensure = useCallback(async (): Promise<boolean> => {
    if (hasAvailableCompute(useStore.getState().providers)) return true
    if (activation.current) return activation.current
    setStatus('checking')
    const pending = activateLocalCompute()
      .then((result) => {
        if (result.status !== 'activated' || !result.provider) {
          setStatus('unavailable')
          return false
        }
        updateWelcomeDraft({ providerId: result.provider.id, model: AUTO_MODEL })
        setStatus('ready')
        return true
      })
      .catch(() => {
        setStatus('unavailable')
        return false
      })
      .finally(() => {
        activation.current = null
      })
    activation.current = pending
    return pending
  }, [activateLocalCompute, updateWelcomeDraft])

  useEffect(() => {
    if (!providersLoaded || projection !== 'assistant' || computeAvailable || status !== 'idle') return
    void ensure()
  }, [computeAvailable, ensure, projection, providersLoaded, status])

  return { localComputeStatus: status, ensureLocalCompute: ensure }
}

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

interface WelcomeStartActionsInput {
  projection: WelcomeProjection
  sessionDraft: WelcomeSessionDraft
  text: string
  taskStrategy: TaskStrategy
  computeAvailable: boolean
  ensureLocalCompute: () => Promise<boolean>
  startSessionWithPrompt: WelcomeStoreState['startSessionWithPrompt']
  refreshProviders: WelcomeStoreState['refreshProviders']
}

function useWelcomeStartActions(input: WelcomeStartActionsInput) {
  const t = useT()
  const startSessionWithPrompt = input.startSessionWithPrompt
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKind, setRecoveryKind] = useState<WelcomeRecoveryKind | null>(null)

  const submit = async (
    promptInput = input.text,
    selectedStrategy = input.taskStrategy,
    title?: string
  ): Promise<void> => {
    const prompt = promptInput.trim()
    if (!prompt || busy) return
    await runFirstTaskSubmissionExclusive(async () => {
      setBusy(true)
      const draft = { ...input.sessionDraft, taskStrategy: selectedStrategy }
      try {
        let available = input.computeAvailable
        if (input.projection === 'assistant' && !available) available = await input.ensureLocalCompute()
        const validationKey = welcomeValidationKey(input.projection, draft, available)
        if (validationKey) {
          setError(t(validationKey))
          setRecoveryKind(welcomeRecoveryKind(validationKey))
          return
        }
        setError('')
        setRecoveryKind(null)
        const options = welcomeSessionOptions(input.projection, draft, prompt)
        const candidateSessionId = await startSessionWithPrompt(
          title ? { ...options, title } : options,
          prompt
        )
        patchFirstTaskOnboardingRecord({
          candidateSessionId,
          presetKey: title
            ? WELCOME_TOOLS.find((tool) => t(tool.labelKey) === title)?.key ?? 'custom'
            : 'custom',
          startedAt: Date.now()
        })
        useStore.getState().clearWelcomeDraft()
      } catch (err) {
        const safeKey = assistantSafeStartError(input.projection, err)
        setError(safeKey ? t(safeKey) : err instanceof Error ? err.message : String(err))
        setRecoveryKind(safeKey ? 'compute' : null)
      } finally {
        setBusy(false)
      }
    })
  }

  const retryCompute = async (): Promise<void> => {
    setBusy(true)
    try {
      const nextRecovery = recoveryKind ?? (input.projection === 'assistant' ? 'compute' : 'provider')
      if (nextRecovery === 'compute') {
        const activated = await input.ensureLocalCompute()
        if (!activated) await input.refreshProviders()
      } else {
        await input.refreshProviders()
      }
      const available = hasAvailableCompute(useStore.getState().providers)
      setError(available ? '' : t(
        nextRecovery === 'provider' ? 'explicitProviderRequired' : 'assistantComputeUnavailable'
      ))
      setRecoveryKind(available ? null : nextRecovery)
    } catch {
      const nextRecovery = recoveryKind ?? (input.projection === 'assistant' ? 'compute' : 'provider')
      setError(t(
        nextRecovery === 'provider' ? 'welcomeProviderRefreshFailed' : 'assistantComputeCheckFailed'
      ))
      setRecoveryKind(nextRecovery)
    } finally {
      setBusy(false)
    }
  }

  const clearError = (): void => {
    setError('')
    setRecoveryKind(null)
  }

  return { busy, clearError, error, recoveryKind, retryCompute, submit }
}

interface WelcomeFirstTaskProgressProps {
  providersLoaded: boolean
  computeAvailable: boolean
  activatingLocal: boolean
}

function WelcomeFirstTaskProgress({
  providersLoaded,
  computeAvailable,
  activatingLocal
}: WelcomeFirstTaskProgressProps): React.JSX.Element | null {
  const t = useT()
  const sessions = useStore((state) => state.sessions)
  const onboardingRecord = useFirstTaskOnboardingRecord()
  const candidateStatus = onboardingRecord.candidateSessionId
    ? sessions[onboardingRecord.candidateSessionId]?.meta.status
    : undefined
  const onboardingStatus = deriveFirstTaskOnboardingStatus({
    record: onboardingRecord,
    providersHydrated: providersLoaded,
    computeAvailable,
    activatingLocal,
    sessionStatus: candidateStatus
  })
  const onboardingProgress = deriveFirstTaskProgress(onboardingStatus, onboardingRecord)
  if (onboardingStatus === 'completed') return null
  return (
    <div
      className="first-task-progress"
      aria-label={t('firstTaskProgressRun')}
      data-first-task-status={onboardingStatus}
    >
      <span className={onboardingProgress.compute}>{t('firstTaskProgressCompute')}</span>
      <span className={onboardingProgress.task}>{t('firstTaskProgressRun')}</span>
      <span className={onboardingProgress.result}>{t('firstTaskProgressResult')}</span>
      <span className={onboardingProgress.acceptance}>{t('firstTaskProgressAcceptance')}</span>
    </div>
  )
}

interface WelcomeProjectSelectorProps {
  availableProjects: Project[]
  cwd: string
  projectChoice: string
  onBrowse: () => void
  onCwdChange: (cwd: string) => void
  onProjectChange: (choice: string) => void
}

function WelcomeProjectSelector({
  availableProjects,
  cwd,
  projectChoice,
  onBrowse,
  onCwdChange,
  onProjectChange
}: WelcomeProjectSelectorProps): React.JSX.Element {
  const t = useT()
  return (
    <div className="welcome-project-bar">
      <select
        className="welcome-project-select"
        aria-label={t('project')}
        title={cwd || t('welcomePickProject')}
        value={projectChoice}
        onChange={(event) => onProjectChange(event.target.value)}
      >
        <option value={UNASSIGNED}>{t('directStartNoProject')}</option>
        {availableProjects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
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
            onChange={(event) => onCwdChange(event.target.value)}
          />
          <button className="welcome-project-browse" onClick={onBrowse}>{t('browse')}</button>
        </>
      ) : projectChoice !== UNASSIGNED ? (
        <span className="welcome-project-current" title={cwd}>{cwd}</span>
      ) : null}
    </div>
  )
}

/** 首屏打开即输入，任务策略决定后端派生的权限模式。 */
export default function WelcomeView(): React.JSX.Element {
  const t = useT()
  const projection = useExperienceProjection()
  const settings = useStore((state) => state.settings)
  const providers = useStore((state) => state.providers)
  const providersLoaded = useStore((state) => state.providersLoaded)
  const projects = useStore((state) => state.projects)
  const welcomeDraft = useStore((state) => state.welcomeDraft)
  const requestedProjectId = useStore((state) => state.newSessionProjectId)
  const startSessionWithPrompt = useStore((state) => state.startSessionWithPrompt)
  const refreshProviders = useStore((state) => state.refreshProviders)
  const activateLocalCompute = useStore((state) => state.activateLocalCompute)
  const setShowSettings = useStore((state) => state.setShowSettings)
  const welcome = useWelcomeDraftController({ projects, providers, requestedProjectId, settings })
  const {
    availableProjects,
    cwd,
    driveMode,
    model,
    projectChoice,
    providerId,
    routingMode,
    text
  } = welcome
  const taskStrategy = welcomeDraft.taskStrategy ?? 'execute'
  const taRef = useRef<HTMLTextAreaElement>(null)
  const computeAvailable = hasAvailableCompute(providers)
  const { localComputeStatus, ensureLocalCompute } = useLocalComputeActivation(
    projection,
    providersLoaded,
    computeAvailable,
    activateLocalCompute,
    welcome.update
  )
  const sessionDraft: WelcomeSessionDraft = {
    cwd,
    driveMode,
    model,
    taskStrategy,
    projectId: availableProjects.some((project) => project.id === projectChoice)
      ? projectChoice
      : undefined,
    providerId,
    routingMode,
    unassigned: projectChoice === UNASSIGNED,
    forkFromSdkSessionId: welcomeDraft.forkFromSdkSessionId
  }
  const {
    busy,
    clearError,
    error,
    recoveryKind,
    retryCompute,
    submit
  } = useWelcomeStartActions({
    projection,
    sessionDraft,
    text,
    taskStrategy,
    computeAvailable,
    ensureLocalCompute,
    startSessionWithPrompt,
    refreshProviders
  })

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
  const modelOptions = useMemo(() => modelOptionsForProvider(
    providers,
    providerId,
    `${t('autoRoute')} · ${routingStrategyLabel}`,
    model
  ), [model, providerId, providers, routingStrategyLabel, t])
  const fixedModelOptions = modelOptions.filter((option) => option.value !== AUTO_MODEL)

  const onRoutingModeChange = (mode: WelcomeRoutingMode): void => {
    welcome.setRoutingMode(mode, fixedModelOptions[0]?.value ?? '')
  }

  const onProjectChange = (choice: string): void => {
    welcome.setProject(choice)
    clearError()
  }

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (!dir) return
    welcome.setPickedDirectory(dir)
    clearError()
  }

  const startPreset = (tool: WelcomeTool): void => {
    const prompt = t(tool.promptKey)
    welcome.update({ text: prompt, taskStrategy: tool.taskStrategy })
    if (tool.key !== 'understand') void submit(prompt, tool.taskStrategy, t(tool.labelKey))
    else taRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  return (
    <div className="welcome welcome-hero">
      <div className="welcome-stage">
        <div className="welcome-hero-inner">
          <img className="welcome-logo" src={APP_ICON_URL} alt={APP_NAME} />
          <h1 className="welcome-ask">{t('welcomeAsk')}</h1>
          <WelcomeFirstTaskProgress
            providersLoaded={providersLoaded}
            computeAvailable={computeAvailable || localComputeStatus === 'ready'}
            activatingLocal={localComputeStatus === 'checking'}
          />
          <div className="welcome-suggestion-grid">
            {WELCOME_TOOLS.map((tool) => (
              <button
                key={tool.key}
                type="button"
                className={`welcome-suggestion ${tool.key === 'understand' ? 'welcome-suggestion-recommended' : ''}`}
                data-welcome-preset={tool.key}
                data-preset-strategy={tool.taskStrategy}
                disabled={busy}
                title={t('welcomePresetStartsNow')}
                onClick={() => startPreset(tool)}
              >
                <HeaderIcon name={tool.icon} />
                <span>{t(tool.labelKey)}</span>
                {tool.key === 'understand' && <small>{t('firstTaskRecommended')}</small>}
              </button>
            ))}
          </div>
        </div>

        <div className="welcome-compose-dock">
          {welcomeDraft.forkFromSdkSessionId ? (
            <div className="welcome-fork-source">
              {t('conversationForkSource', {
                title: welcomeDraft.forkSourceTitle ?? t('conversation')
              })}
            </div>
          ) : (
            <WelcomeProjectSelector
              availableProjects={availableProjects}
              cwd={cwd}
              projectChoice={projectChoice}
              onBrowse={() => void browse()}
              onCwdChange={(nextCwd) => welcome.update({ cwd: nextCwd })}
              onProjectChange={onProjectChange}
            />
          )}
          <div className="welcome-composer">
            <textarea
              ref={taRef}
              className="welcome-composer-input"
              placeholder={t('welcomeInputPlaceholder')}
              value={text}
              rows={2}
              onChange={(event) => welcome.update({ text: event.target.value })}
              onKeyDown={onKeyDown}
              autoFocus
            />
            <div className="welcome-composer-bar">
              <TaskStrategyControl
                value={taskStrategy}
                onChange={(nextStrategy) => welcome.update({ taskStrategy: nextStrategy })}
                compact
              />
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
              <button
                className="welcome-send"
                disabled={busy || !text.trim()}
                onClick={() => void submit()}
              >
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
