import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  FileText,
  Folder,
  FolderOpen,
  GitPullRequest,
  ListChecks,
  LoaderCircle,
  SearchCode,
  type LucideIcon
} from 'lucide-react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import { APP_ICON_URL, APP_NAME } from '../brand'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../shared/types'
import type {
  LocalComputeActivationResult,
  LocalComputeUnavailableReason,
  Project,
  TaskStrategy
} from '../../../shared/types'
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
  patchFirstTaskOnboardingRecord,
  runFirstTaskSubmissionExclusive
} from './experience/first-task-onboarding'

type WelcomeStoreState = ReturnType<typeof useStore.getState>
type WelcomeProjection = ReturnType<typeof useExperienceProjection>

function useLocalComputeActivation(
  projection: WelcomeProjection,
  providersLoaded: boolean,
  computeAvailable: boolean,
  activateLocalCompute: (options?: { startInstalled?: boolean }) => Promise<LocalComputeActivationResult>,
  updateWelcomeDraft: WelcomeStoreState['updateWelcomeDraft']
) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle')
  const ensure = useCallback(async (startInstalled = false): Promise<LocalComputeActivationResult> => {
    if (hasAvailableCompute(useStore.getState().providers)) {
      return { status: 'activated', checkedAt: Date.now() }
    }
    setStatus('checking')
    return activateLocalCompute({ startInstalled })
      .then((result) => {
        if (result.status !== 'activated' || !result.provider) {
          setStatus('unavailable')
          return result
        }
        updateWelcomeDraft({
          computeSelectionSource: 'default',
          providerId: result.provider.id,
          model: AUTO_MODEL
        })
        setStatus('ready')
        return result
      })
      .catch((): LocalComputeActivationResult => {
        setStatus('unavailable')
        return { status: 'unavailable', checkedAt: Date.now(), reason: 'runtime-stopped' }
      })
  }, [activateLocalCompute, updateWelcomeDraft])

  useEffect(() => {
    if (!providersLoaded || projection !== 'assistant' || computeAvailable || status !== 'idle') return
    void ensure(false)
  }, [computeAvailable, ensure, projection, providersLoaded, status])

  return { localComputeStatus: status, ensureLocalCompute: ensure }
}

interface WelcomeTool {
  key: string
  labelKey: string
  promptKey: string
  icon: LucideIcon
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
    icon: SearchCode,
    taskStrategy: 'view'
  },
  {
    key: 'review',
    labelKey: 'welcomeReviewChanges',
    promptKey: 'welcomeReviewChangesPrompt',
    icon: GitPullRequest,
    taskStrategy: 'view'
  },
  {
    key: 'report',
    labelKey: 'welcomeOrganizeReport',
    promptKey: 'welcomeOrganizeReportPrompt',
    icon: FileText,
    taskStrategy: 'execute'
  },
  {
    key: 'plan',
    labelKey: 'welcomePlanTask',
    promptKey: 'welcomePlanTaskPrompt',
    icon: ListChecks,
    taskStrategy: 'plan'
  }
]

interface WelcomeStartActionsInput {
  projection: WelcomeProjection
  sessionDraft: WelcomeSessionDraft
  text: string
  taskStrategy: TaskStrategy
  computeAvailable: boolean
  ensureLocalCompute: (startInstalled?: boolean) => Promise<LocalComputeActivationResult>
  startSessionWithPrompt: WelcomeStoreState['startSessionWithPrompt']
  refreshProviders: WelcomeStoreState['refreshProviders']
}

function localComputeValidationKey(reason: LocalComputeUnavailableReason | undefined):
  | 'assistantLocalRuntimeMissing'
  | 'assistantLocalRuntimeStartFailed'
  | 'assistantLocalModelMissing'
  | 'assistantComputeUnavailable' {
  if (reason === 'runtime-missing') return 'assistantLocalRuntimeMissing'
  if (reason === 'runtime-stopped') return 'assistantLocalRuntimeStartFailed'
  if (reason === 'model-missing') return 'assistantLocalModelMissing'
  return 'assistantComputeUnavailable'
}

function useWelcomeStartActions(input: WelcomeStartActionsInput) {
  const t = useT()
  const startSessionWithPrompt = input.startSessionWithPrompt
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKind, setRecoveryKind] = useState<WelcomeRecoveryKind | null>(null)
  const [computeReason, setComputeReason] = useState<LocalComputeUnavailableReason | null>(null)

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
        let localResult: LocalComputeActivationResult | undefined
        if (input.projection === 'assistant' && !available) {
          localResult = await input.ensureLocalCompute(true)
          available = localResult.status === 'activated'
        }
        const validationKey = welcomeValidationKey(input.projection, draft, available)
        if (validationKey) {
          setError(t(localResult ? localComputeValidationKey(localResult.reason) : validationKey))
          setRecoveryKind(welcomeRecoveryKind(validationKey))
          setComputeReason(localResult?.reason ?? null)
          return
        }
        setError('')
        setRecoveryKind(null)
        setComputeReason(null)
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
        setComputeReason(null)
      } finally {
        setBusy(false)
      }
    })
  }

  const retryLocalCompute = async (): Promise<void> => {
    const result = await input.ensureLocalCompute(true)
    if (result.status !== 'activated') await input.refreshProviders()
    const available = hasAvailableCompute(useStore.getState().providers)
    setError(available ? '' : t(localComputeValidationKey(result.reason)))
    setRecoveryKind(available ? null : 'compute')
    setComputeReason(available ? null : result.reason ?? null)
  }

  const retryProviderCompute = async (): Promise<void> => {
    await input.refreshProviders()
    const available = hasAvailableCompute(useStore.getState().providers)
    setError(available ? '' : t('explicitProviderRequired'))
    setRecoveryKind(available ? null : 'provider')
    setComputeReason(null)
  }

  const retryCompute = async (): Promise<void> => {
    const nextRecovery = recoveryKind ?? (input.projection === 'assistant' ? 'compute' : 'provider')
    setBusy(true)
    try {
      if (nextRecovery === 'compute') await retryLocalCompute()
      else await retryProviderCompute()
    } catch {
      setError(t(
        nextRecovery === 'provider' ? 'welcomeProviderRefreshFailed' : 'assistantComputeCheckFailed'
      ))
      setRecoveryKind(nextRecovery)
      setComputeReason(null)
    } finally {
      setBusy(false)
    }
  }

  const clearError = (): void => {
    setError('')
    setRecoveryKind(null)
    setComputeReason(null)
  }

  return { busy, clearError, computeReason, error, recoveryKind, retryCompute, submit }
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
      <Folder size={15} strokeWidth={1.8} aria-hidden="true" />
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
          <button
            type="button"
            className="welcome-project-browse"
            aria-label={t('browse')}
            title={t('browse')}
            onClick={onBrowse}
          >
            <FolderOpen size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
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
  const taskStrategy = welcomeDraft.taskStrategy ?? settings.defaultTaskStrategy
  const taskExperienceMode = welcomeDraft.experienceModeOverride ?? projection
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
    experienceModeOverride: taskExperienceMode,
    projectId: availableProjects.some((project) => project.id === projectChoice)
      ? projectChoice
      : undefined,
    providerId,
    routingMode,
    unassigned: projectChoice === UNASSIGNED,
    forkFromSdkSessionId: welcomeDraft.forkFromSdkSessionId,
    forkCheckpointId: welcomeDraft.forkCheckpointId
  }
  const { busy, clearError, computeReason, error, recoveryKind, retryCompute, submit } = useWelcomeStartActions({
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
          <div className="welcome-suggestion-grid">
            {WELCOME_TOOLS.map((tool) => {
              const ToolIcon = tool.icon
              return (
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
                  <ToolIcon size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span>{t(tool.labelKey)}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="welcome-compose-dock">
          <div className="welcome-composer">
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
            <textarea
              ref={taRef}
              className="welcome-composer-input"
              placeholder={t('welcomeInputPlaceholder')}
              value={text}
              rows={1}
              onChange={(event) => welcome.update({ text: event.target.value })}
              onKeyDown={onKeyDown}
              autoFocus
            />
            <div className="welcome-composer-bar">
              <div
                className="welcome-experience-override"
                role="group"
                aria-label={t('taskExperienceMode')}
                data-task-experience-mode={taskExperienceMode}
              >
                {(['assistant', 'studio'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={taskExperienceMode === mode}
                    className={taskExperienceMode === mode ? 'active' : ''}
                    title={t(mode === 'assistant' ? 'taskExperienceAssistantHint' : 'taskExperienceStudioHint')}
                    onClick={() => welcome.update({ experienceModeOverride: mode })}
                  >
                    {t(mode === 'assistant' ? 'taskExperienceAssistant' : 'taskExperienceStudio')}
                  </button>
                ))}
              </div>
              <TaskStrategyControl
                value={taskStrategy}
                onChange={(nextStrategy) => welcome.update({ taskStrategy: nextStrategy })}
                compact
              />
              {projection === 'assistant' && !welcomeDraft.forkFromSdkSessionId ? (
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
                  onModelChange={(nextModel) => welcome.update({
                    computeSelectionSource: 'user',
                    model: nextModel
                  })}
                  onProviderChange={welcome.setProvider}
                  onRoutingModeChange={onRoutingModeChange}
                />
              )}
              <button
                type="button"
                className="welcome-send"
                aria-label={t('send')}
                title={t('send')}
                disabled={busy || !text.trim()}
                onClick={() => void submit()}
              >
                {busy
                  ? <LoaderCircle className="welcome-send-spinner" size={17} aria-hidden="true" />
                  : <ArrowUp size={17} strokeWidth={2.2} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <AssistantStartNotice
            busy={busy}
            computeReason={computeReason}
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
