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

type WelcomeDraftController = ReturnType<typeof useWelcomeDraftController>
type WelcomeModelOptions = ReturnType<typeof modelOptionsForProvider>
type WelcomeStartActions = ReturnType<typeof useWelcomeStartActions>

function buildWelcomeSessionDraft(
  welcome: WelcomeDraftController,
  welcomeDraft: WelcomeStoreState['welcomeDraft'],
  taskStrategy: TaskStrategy
): WelcomeSessionDraft {
  return {
    cwd: welcome.cwd,
    driveMode: welcome.driveMode,
    model: welcome.model,
    taskStrategy,
    projectId: welcome.availableProjects.some((project) => project.id === welcome.projectChoice)
      ? welcome.projectChoice
      : undefined,
    providerId: welcome.providerId,
    routingMode: welcome.routingMode,
    unassigned: welcome.projectChoice === UNASSIGNED,
    forkFromSdkSessionId: welcomeDraft.forkFromSdkSessionId,
    forkCheckpointId: welcomeDraft.forkCheckpointId
  }
}

function useWelcomeModelOptions(
  welcome: WelcomeDraftController,
  providers: WelcomeStoreState['providers'],
  schedulerStrategy: WelcomeStoreState['settings']['schedulerStrategy']
): { fixedModelOptions: WelcomeModelOptions; routingStrategyLabel: string } {
  const t = useT()
  const routingStrategy = welcome.driveMode === 'core'
    ? schedulerStrategy
    : caogenDrivePolicyView(welcome.driveMode).schedulerStrategy
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
    welcome.providerId,
    `${t('autoRoute')} · ${routingStrategyLabel}`,
    welcome.model
  ), [providers, routingStrategyLabel, t, welcome.model, welcome.providerId])
  return {
    fixedModelOptions: modelOptions.filter((option) => option.value !== AUTO_MODEL),
    routingStrategyLabel
  }
}

function WelcomePresetGrid({
  busy,
  onSelect
}: {
  busy: boolean
  onSelect: (tool: WelcomeTool) => void
}): React.JSX.Element {
  const t = useT()
  return (
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
            onClick={() => onSelect(tool)}
          >
            <ToolIcon size={17} strokeWidth={1.8} aria-hidden="true" />
            <span>{t(tool.labelKey)}</span>
          </button>
        )
      })}
    </div>
  )
}

function WelcomeComposer({
  actions,
  computeAvailable,
  fixedModelOptions,
  localComputeStatus,
  onBrowse,
  onKeyDown,
  onOpenSettings,
  onProjectChange,
  onRoutingModeChange,
  projection,
  providers,
  routingStrategyLabel,
  taskStrategy,
  textareaRef,
  welcome,
  welcomeDraft
}: {
  actions: WelcomeStartActions
  computeAvailable: boolean
  fixedModelOptions: WelcomeModelOptions
  localComputeStatus: ReturnType<typeof useLocalComputeActivation>['localComputeStatus']
  onBrowse: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onOpenSettings: () => void
  onProjectChange: (choice: string) => void
  onRoutingModeChange: (mode: WelcomeRoutingMode) => void
  projection: WelcomeProjection
  providers: WelcomeStoreState['providers']
  routingStrategyLabel: string
  taskStrategy: TaskStrategy
  textareaRef: React.RefObject<HTMLTextAreaElement>
  welcome: WelcomeDraftController
  welcomeDraft: WelcomeStoreState['welcomeDraft']
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="welcome-compose-dock">
      <div className="welcome-composer">
        {welcomeDraft.forkFromSdkSessionId ? (
          <div className="welcome-fork-source">
            {t('conversationForkSource', { title: welcomeDraft.forkSourceTitle ?? t('conversation') })}
          </div>
        ) : (
          <WelcomeProjectSelector
            availableProjects={welcome.availableProjects}
            cwd={welcome.cwd}
            projectChoice={welcome.projectChoice}
            onBrowse={onBrowse}
            onCwdChange={(cwd) => welcome.update({ cwd })}
            onProjectChange={onProjectChange}
          />
        )}
        <textarea
          ref={textareaRef}
          className="welcome-composer-input"
          placeholder={t('welcomeInputPlaceholder')}
          value={welcome.text}
          rows={1}
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
          {projection === 'assistant' && !welcomeDraft.forkFromSdkSessionId ? (
            <AssistantComputeIndicator
              available={computeAvailable || localComputeStatus === 'ready'}
              checking={localComputeStatus === 'checking'}
            />
          ) : (
            <WelcomeRoutingControls
              driveMode={welcome.driveMode}
              fixedModelOptions={fixedModelOptions}
              model={welcome.model}
              providerId={welcome.providerId}
              providers={providers}
              routingMode={welcome.routingMode}
              routingStrategyLabel={routingStrategyLabel}
              onDriveChange={welcome.setDriveMode}
              onModelChange={(model) => welcome.update({ computeSelectionSource: 'user', model })}
              onProviderChange={welcome.setProvider}
              onRoutingModeChange={onRoutingModeChange}
            />
          )}
          <button
            type="button"
            className="welcome-send"
            aria-label={t('send')}
            title={t('send')}
            disabled={actions.busy || !welcome.text.trim()}
            onClick={() => void actions.submit()}
          >
            {actions.busy
              ? <LoaderCircle className="welcome-send-spinner" size={17} aria-hidden="true" />
              : <ArrowUp size={17} strokeWidth={2.2} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <AssistantStartNotice
        busy={actions.busy}
        computeReason={actions.computeReason}
        error={actions.error}
        recoveryKind={actions.recoveryKind}
        onOpenSettings={onOpenSettings}
        onRetry={() => void actions.retryCompute()}
      />
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
  const { text } = welcome
  const taskStrategy = welcomeDraft.taskStrategy ?? settings.defaultTaskStrategy
  const taRef = useRef<HTMLTextAreaElement>(null)
  const computeAvailable = hasAvailableCompute(providers)
  const { localComputeStatus, ensureLocalCompute } = useLocalComputeActivation(
    projection,
    providersLoaded,
    computeAvailable,
    activateLocalCompute,
    welcome.update
  )
  const sessionDraft = buildWelcomeSessionDraft(
    welcome,
    welcomeDraft,
    taskStrategy
  )
  const actions = useWelcomeStartActions({
    projection,
    sessionDraft,
    text,
    taskStrategy,
    computeAvailable,
    ensureLocalCompute,
    startSessionWithPrompt,
    refreshProviders
  })
  const { fixedModelOptions, routingStrategyLabel } = useWelcomeModelOptions(
    welcome,
    providers,
    settings.schedulerStrategy
  )

  const onRoutingModeChange = (mode: WelcomeRoutingMode): void => {
    welcome.setRoutingMode(mode, fixedModelOptions[0]?.value ?? '')
  }

  const onProjectChange = (choice: string): void => {
    welcome.setProject(choice)
    actions.clearError()
  }

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (!dir) return
    welcome.setPickedDirectory(dir)
    actions.clearError()
  }

  const startPreset = (tool: WelcomeTool): void => {
    const prompt = t(tool.promptKey)
    welcome.update({ text: prompt, taskStrategy: tool.taskStrategy })
    if (tool.key !== 'understand') void actions.submit(prompt, tool.taskStrategy, t(tool.labelKey))
    else taRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void actions.submit()
  }

  return (
    <div className="welcome welcome-hero">
      <div className="welcome-stage">
        <div className="welcome-hero-inner">
          <img className="welcome-logo" src={APP_ICON_URL} alt={APP_NAME} />
          <h1 className="welcome-ask">{t('welcomeAsk')}</h1>
          <WelcomePresetGrid busy={actions.busy} onSelect={startPreset} />
        </div>
        <WelcomeComposer
          actions={actions}
          computeAvailable={computeAvailable}
          fixedModelOptions={fixedModelOptions}
          localComputeStatus={localComputeStatus}
          onBrowse={() => void browse()}
          onKeyDown={onKeyDown}
          onOpenSettings={() => setShowSettings(true, 'providers', 'welcome-provider-recovery')}
          onProjectChange={onProjectChange}
          onRoutingModeChange={onRoutingModeChange}
          projection={projection}
          providers={providers}
          routingStrategyLabel={routingStrategyLabel}
          taskStrategy={taskStrategy}
          textareaRef={taRef}
          welcome={welcome}
          welcomeDraft={welcomeDraft}
        />
      </div>
    </div>
  )
}
