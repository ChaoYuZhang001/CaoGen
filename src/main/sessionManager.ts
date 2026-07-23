import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import { randomUUID } from 'node:crypto'
import { createEngine } from './engine'
import type { Engine } from './engine'
import { registerBuiltinEngines } from './engines'
import { fixPathForGuiLaunch } from './pathFix'
import { configureModelStatsDir } from './modelStats'
import { configureProviderHealthDir } from './providerHealth'
import { upsertHistory, listHistory } from './history'
import { getSettings } from './settings'
import { calculateMonthlyBudgetSnapshot } from './model/monthly-budget'
import { cleanupTranscripts, restoreTranscriptIfMissing } from './transcript'
import { touchProject } from './projects'
import { managedWorktreeRecordForSession } from './worktrees'
import {
  assertTaskSnapshotWorktreeProjection,
  managedSessionPlacement, prepareSessionCreationDraft,
  sessionMetaForPlacement, sessionMetaForRecovery, synchronousSessionPlacement,
  type SessionCreationDraft, type SessionWorktreePlacement
} from './session-create-lifecycle'
import { prepareSessionIdentityForActivation } from './session-domain-activation'
import { configureDigitalWorkerActionPolicyRoot } from './digital-worker/action-policy'
import { digitalWorkerSendPolicyError } from './digital-worker/session-action-policy'
import { bindAndValidateTaskRun, resolveDigitalWorkerSessionScope } from './digital-worker/session-binding'
import { deletePendingSessionCreation, listPendingSessionCreations, savePendingSessionCreation } from './session-creation-journal'
import {
  activeSessionRecoveryBlocks, managedSessionActivationRecoveryError, planPendingSessionCreations,
  requiresEffectReconciliation, sessionCreationResolutionBarrier,
  type PendingSessionRecoveryPlan
} from './session-creation-recovery'
import { restoreActiveSessionRegistry, updateActiveSessionRegistryWorktreeState, writeActiveSessionRegistry } from './session-active-registry'
import {
  buildTaskSnapshotReplayPrompts, canTrackCost, cleanOneLine, effectiveBudgetUsd, estimateTurnCostUsd,
  mapWithConcurrencyInOrder, normalizePositiveNumber, normalizeTaskId, requireDagPromptAccepted, shouldDispatchChildResult,
  shouldPersistActiveRegistry, shouldResumeDagFinalization, subagentCwd, subtaskStatusFromDag,
  subtaskStatusFromSession, withSessionCreationJournalBarrier, SessionWorkflowRuntime,
  type ManagedSessionCreationOptions, type OrchestrationState, type SessionNotificationState
} from './session-manager-support'
import { SessionSupervisorRuntime } from './session-supervisor-runtime'
import {
  handleSessionTaskRunEvent,
  isTaskSnapshotCountedEvent,
  shouldCleanupTaskSnapshot,
  taskSnapshotReason
} from './session-task-run-events'
import { showDesktopNotification } from './desktopNotify'
import { scheduleAutoSkillReview } from './skill/auto-skill-review'
import { clearIdeDocumentContext } from './ide/ide-document-context'
import {
  deleteTaskSnapshot, getTaskSnapshot, listTaskRuns as listPersistedTaskRuns, listTaskSnapshots,
  flushTaskSnapshotMutations
} from './task/task-snapshot'
import { ModelAttemptRecoveryGate } from './task/model-attempt-recovery-gate'
import {
  createTaskRun,
  isTaskRunTerminal,
  transitionTaskRun
} from './task/task-run'
import { recoverTaskExecutionState } from './task/task-execution'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import { reconcileSnapshotWithReceipts } from './task/task-recovery'
import {
  reconcilePersistedTaskSnapshot,
  resolvePersistedTaskEffect,
  runHasUnresolvedEffects
} from './task/effect-runtime'
import { prepareTaskSnapshotRecovery } from './task/task-snapshot-recovery-lifecycle'
import type { SupervisorSessionControlRequest, SupervisorSessionControlResult } from './task/supervisor-session-control'
import { SupervisorStateStore } from './task/supervisor-state'
import {
  executeInteractiveOperationEffect,
  isInteractiveOperationSnapshot
} from './task/operation-effect-gateway'
import { assertAgentRecoverySnapshot, reconcileInteractiveOperationSnapshot } from './ipc/operation-snapshot'
import { executeInteractiveOperationEffectRemoveWorktree } from './ipc/worktree-operation-handlers'
import { decomposeTask } from './agent/task-decomposer'
import { createModelDagDecomposer } from './agent/model-dag-decomposer'
import { buildDagTaskPrompt, TaskDagScheduler, type TaskDagSchedulerCallbacks } from './agent/dag-scheduler'
import { TaskDagFinalizationCoordinator } from './task/dag-finalization-coordinator'
import { ModelCrossValidationRuntime } from './model/cross-validation-runtime'
import type {
  AgentEvent,
  AgentEventIdentity,
  CreateSessionOptions,
  DispatchSubagentsInput,
  SubagentDispatchResult,
  TaskDagDispatchInput,
  TaskDagDispatchResult,
  TaskDagExecutionView,
  TaskDagFinalizationRecord,
  TaskDagFinalizationResolution,
  TaskDagRuntimeMergeSession,
  TaskDagRuntimeSnapshot,
  TaskDecomposeInput,
  TaskDecomposeResult,
  SessionEventPayload,
  SessionMeta,
  SdkAgentInfo,
  SendMessagePayload,
  TaskSnapshotRecord,
  TaskSnapshotReason,
  TaskSnapshotSubtaskState,
  TaskRunRecord,
  TranscriptEntry
} from '../shared/types'
import type { ModelAttemptReconciliationResolution } from '../shared/model-attempt-types'

const TASK_SNAPSHOT_RECONCILIATION_CONCURRENCY = 4

function trimForNotification(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

class SessionManager {
  private readonly sessions = new Map<string, Engine>()
  private readonly taskRuns = taskRuntimeRegistry
  private readonly sessionEventListeners = new Set<(payload: SessionEventPayload) => void>()
  private readonly notificationStates = new Map<string, SessionNotificationState>()
  /** 真编排事件总线:orchestrationId → 状态;全部 child 首轮完成后回灌父 Agent */
  private readonly orchestrations = new Map<string, OrchestrationState>()
  /** DAG 编排:executionId → 调度器;按依赖层释放 child sessions。 */
  private readonly dagSchedulers = new Map<string, TaskDagScheduler>()
  /** DAG 最新执行视图:用于恢复/快照保留已经完成或已从调度器移除的 DAG 状态。 */
  private readonly dagExecutionSnapshots = new Map<string, TaskDagExecutionView>()
  /** DAG 完成后执行的显式自动合并配置;默认不写主工作区。 */
  private readonly dagAutoMergeOptions = new Map<string, { enabled: boolean; verificationCommand?: string }>()
  private readonly dagRuntimeMergeSessions = new Map<string, TaskDagRuntimeMergeSession[]>()
  private readonly snapshotCounts = new Map<
    string,
    { total: number; sinceSave: number; lastSeq: number; lastEventId?: string }
  >()
  private readonly dagFinalizationCoordinator = new TaskDagFinalizationCoordinator({
    sessions: this.sessions,
    snapshotCursor: (sessionId) => this.snapshotCounts.get(sessionId),
    snapshotSubtasks: (sessionId) => this.snapshotSubtasksFor(sessionId),
    snapshotDagExecutions: (sessionId) => this.snapshotDagExecutionsFor(sessionId),
    snapshotDagRuntimes: (sessionId) => this.snapshotDagRuntimesFor(sessionId),
    send: (parentSessionId, payload) => this.send(parentSessionId, payload),
    emitParentEvent: (parentSessionId, event) => this.dispatch(parentSessionId, event, 0),
    updateExecution: (parentSessionId, execution, emit) => {
      if (emit) this.emitTaskDagUpdate(parentSessionId, execution)
      else this.dagExecutionSnapshots.set(execution.id, execution)
    },
    releaseScheduler: (executionId) => this.dagSchedulers.delete(executionId),
    cleanupExecution: (executionId) => {
      this.dagSchedulers.delete(executionId)
      this.dagAutoMergeOptions.delete(executionId)
      this.dagRuntimeMergeSessions.delete(executionId)
    },
    recoverParent: (parentSessionId) => this.recoverTaskSnapshot(parentSessionId)
  })
  private readonly recentEventIds = new Map<string, string[]>()
  private readonly modelCrossValidation = new ModelCrossValidationRuntime({
    create: (options) => this.create(options),
    getMeta: (sessionId) => this.sessions.get(sessionId)?.meta,
    getTranscript: (sessionId) => this.sessions.get(sessionId)?.getTranscript() ?? [], getRun: (sessionId) => this.taskRuns.get(sessionId),
    send: (sessionId, prompt) => this.send(sessionId, prompt),
    dispatch: (sessionId, event) => this.dispatch(sessionId, event, 0)
  })
  private readonly workflow = new SessionWorkflowRuntime({
    sessions: this.sessions,
    runs: this.taskRuns,
    snapshotState: (sessionId, seq) => this.snapshotCounts.get(sessionId) ?? { total: 0, lastSeq: seq },
    subtasks: (sessionId) => this.snapshotSubtasksFor(sessionId),
    dagExecutions: (sessionId) => this.snapshotDagExecutionsFor(sessionId),
    dagRuntimes: (sessionId) => this.snapshotDagRuntimesFor(sessionId)
  }, { userDataRoot: app.getPath('userData') })
  /** 非 Claude 引擎由 SessionManager 统一托管防休眠;Claude AgentSession 内部已有同等保护。 */
  private readonly enginePowerBlockers = new Map<string, number>()
  private preservingSnapshotsOnDispose = false
  private readonly effectRecoveryPreservedSessions = new Set<string>()
  private readonly closingSessions = new Map<string, Promise<void>>()
  private readonly recoveredPendingSessions = new Map<string, SessionCreationDraft>()
  private readonly blockedPendingDagSessions = new Map<string, SessionCreationDraft>()
  private readonly retainedSessionCreationJournals = new Set<string>()
  private readonly modelAttemptRecoveryGate = new ModelAttemptRecoveryGate()
  private readonly supervisor = new SessionSupervisorRuntime(
    () => app.getPath('userData'), this.sessions, this.taskRuns,
    (id, input, options) => this.send(id, input, options),
    (id) => this.interrupt(id), (id) => this.workflow.flush(id),
    (sessionId, reason, seq, eventKind, eventId, strict) =>
      this.writeTaskSnapshot(sessionId, reason, seq, eventKind, eventId, strict)
  )

  constructor() {
    configureDigitalWorkerActionPolicyRoot(app.getPath('userData'))
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }))
  }

  get(id: string): Engine | undefined {
    return this.sessions.get(id)
  }

  subscribe(listener: (payload: SessionEventPayload) => void): () => void {
    this.sessionEventListeners.add(listener)
    return () => {
      this.sessionEventListeners.delete(listener)
    }
  }

  /** Compatibility entrypoint for resume, non-Git and non-isolated sessions. */
  async create(opts: CreateSessionOptions): Promise<SessionMeta> {
    const draft = await this.validatedSessionCreationDraft(opts)
    return this.activateSessionCreation(draft, synchronousSessionPlacement(draft))
  }

  /** Creates a session only after any managed worktree effect is durably confirmed. */
  async createManaged(
    opts: CreateSessionOptions,
    lifecycle: ManagedSessionCreationOptions = {}
  ): Promise<SessionMeta> {
    const draft = await this.validatedSessionCreationDraft(opts)
    savePendingSessionCreation(draft)
    let placement: SessionWorktreePlacement
    try {
      placement = await managedSessionPlacement(draft)
    } catch (error) {
      if (!requiresEffectReconciliation(error)) deletePendingSessionCreation(draft.baseMeta.id)
      throw error
    }
    if (lifecycle.retainJournal) this.retainedSessionCreationJournals.add(draft.baseMeta.id)
    try {
      return await this.activateManagedSessionCreation(draft, placement)
    } catch (error) {
      this.retainedSessionCreationJournals.delete(draft.baseMeta.id)
      throw managedSessionActivationRecoveryError(error, draft.baseMeta.id)
    }
  }

  private sessionCreationDraft(opts: CreateSessionOptions): SessionCreationDraft {
    const parentMeta = opts.parentSessionId ? this.sessions.get(opts.parentSessionId)?.meta : undefined
    const draft = prepareSessionCreationDraft(opts, parentMeta)
    if (this.sessions.has(draft.baseMeta.id)) throw new Error(`会话已在运行:${draft.baseMeta.id}`)
    return draft
  }

  private async validatedSessionCreationDraft(opts: CreateSessionOptions): Promise<SessionCreationDraft> {
    const draft = this.sessionCreationDraft(opts)
    const baseMeta = await prepareSessionIdentityForActivation(
      draft.baseMeta, app.getPath('userData'), draft.opts.resumeSdkSessionId !== undefined)
    return { ...draft, baseMeta }
  }

  private activateSessionCreation(
    draft: SessionCreationDraft,
    worktree: SessionWorktreePlacement
  ): SessionMeta {
    const { meta, session } = this.prepareSessionEngine(draft, worktree)
    this.sessions.set(meta.id, session)
    void this.writeTaskSnapshot(meta.id, 'created', 0)
    void session.start()
    return { ...meta }
  }

  private async activateManagedSessionCreation(
    draft: SessionCreationDraft,
    worktree: SessionWorktreePlacement
  ): Promise<SessionMeta> {
    let prepared: { meta: SessionMeta; session: Engine } | undefined
    const meta = await withSessionCreationJournalBarrier(
      this.retainedSessionCreationJournals,
      draft.baseMeta.id,
      async () => {
        prepared = this.prepareSessionEngine(draft, worktree)
        this.sessions.set(prepared.meta.id, prepared.session)
        this.persistActiveSessions(true)
        await this.writeTaskSnapshot(prepared.meta.id, 'created', 0, undefined, undefined, true)
        return { ...prepared.meta }
      },
      () => this.acknowledgeSessionCreation(draft.baseMeta.id, true),
      async () => {
        if (!prepared) return
        if (this.sessions.get(prepared.meta.id) === prepared.session) {
          this.sessions.delete(prepared.meta.id)
          this.persistActiveSessions()
        }
        try {
          await prepared.session.dispose()
        } catch (error) {
          console.error('[caogen] managed session activation rollback dispose failed:', error)
        }
      }
    )
    void prepared?.session.start()
    return meta
  }

  private prepareSessionEngine(
    draft: SessionCreationDraft,
    worktree: SessionWorktreePlacement
  ): { meta: SessionMeta; session: Engine } {
    const meta = sessionMetaForPlacement(draft, worktree)
    resolveDigitalWorkerSessionScope(meta, app.getPath('userData'))
    const session = createEngine(
      meta.engine,
      meta,
      (event, seq, identity) => this.dispatch(meta.id, event, seq, identity),
      draft.opts.resumeSdkSessionId
    )
    return { meta, session }
  }

  private acknowledgeSessionCreation(sessionId: string, strict = false): void {
    try {
      deletePendingSessionCreation(sessionId)
      this.recoveredPendingSessions.delete(sessionId)
      this.blockedPendingDagSessions.delete(sessionId)
      this.retainedSessionCreationJournals.delete(sessionId)
    } catch (error) {
      if (strict) throw error
      console.error('[caogen] session activation journal cleanup failed:', error)
    }
  }

  private emitRecoveredSessionCreation(sessionId: string): void {
    const detail = 'Worktree creation was recovered, but the original prompt was not stored in the crash journal. ' +
      'Review the worktree and send the request again.'
    const event: AgentEvent = { kind: 'hook-event', event: 'session-create-recovered', detail }
    const session = this.sessions.get(sessionId)
    if (session?.emitSyntheticEvent) session.emitSyntheticEvent(event)
    else this.dispatch(sessionId, event, 0)
  }

  send(
    id: string,
    input: string | SendMessagePayload,
    options: { modelAttemptRecoveryReplay?: boolean; supervisorControlReplay?: boolean } = {}
  ): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    const currentRun = this.taskRuns.get(id)
    if (this.supervisor.blocksSend(id, currentRun, options.supervisorControlReplay === true)) {
      session.rejectSend('Supervisor 已暂停或仅授权重试；必须通过受信控制路径恢复后才能继续执行。')
      return false
    }
    const workerPolicyError = digitalWorkerSendPolicyError({
      rootDir: app.getPath('userData'),
      meta: session.meta,
      run: currentRun,
      supervisorControlReplay: options.supervisorControlReplay,
      activeSessions: [...this.sessions.values()].map((candidate) => candidate.meta)
    })
    if (workerPolicyError) {
      session.rejectSend(workerPolicyError)
      return false
    }
    const modelAttemptDecision = this.modelAttemptRecoveryGate
      .decideSend(id, currentRun, Boolean(options.modelAttemptRecoveryReplay))
    if (!modelAttemptDecision.allowed) {
      session.rejectSend(modelAttemptDecision.error ?? 'ModelAttempt 恢复门禁拒绝发送')
      return false
    }
    if (session.meta.workspaceId && !session.meta.workItemId) {
      session.rejectSend('当前会话已关联 Workspace，但未指定 WorkItem；已阻止创建脱离业务任务的 Run。')
      return false
    }
    if (runHasUnresolvedEffects(currentRun)) {
      session.rejectSend('当前任务存在尚未完成真实状态对账的外部副作用，已阻止继续发送；请先完成效果对账。')
      return false
    }
    const budgetError = this.budgetError(session)
    if (budgetError) {
      session.rejectSend(budgetError)
      return false
    }
    if (!currentRun || isTaskRunTerminal(currentRun.status)) {
      this.taskRuns.set(
        id,
        createTaskRun({
          sessionId: id, taskId: session.meta.childTaskId ?? id,
          digitalWorkerBinding: session.meta.digitalWorkerBinding
        })
      )
    }
    session.send(input)
    this.modelAttemptRecoveryGate.acceptedSend(id, modelAttemptDecision)
    return true
  }

  async controlSupervisorRun(
    store: SupervisorStateStore,
    request: SupervisorSessionControlRequest
  ): Promise<SupervisorSessionControlResult | null> {
    return this.supervisor.control(store, request)
  }

  async interrupt(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.effectRecoveryPreservedSessions.add(id)
    try {
      await session.interrupt()
      await this.workflow.flush(id)
      const run = this.taskRuns.get(id)
      const preserveRecovery = runHasUnresolvedEffects(run) || await this.modelAttemptRecoveryGate.shouldPreserveAfterRefresh(id, 'interrupt')
      const preserveDagFinalization = this.dagFinalizationCoordinator.hasIncomplete(id)
      if (preserveRecovery) {
        // 未知外部效果不能留在 active 会话里，否则恢复面板会过滤它且会话还能继续发工具。
        // 统一走 close 屏障：终止底层执行器、持久化 waiting_reconciliation、移出 active。
        await this.close(id)
        return
      }
      if (run && !isTaskRunTerminal(run.status)) {
        this.taskRuns.set(id, transitionTaskRun(run, 'cancelled', { lastEventKind: 'turn-result' }))
        if (preserveDagFinalization) {
          await this.writeTaskSnapshot(id, 'shutdown', 0, 'status', undefined, true)
        } else {
          this.snapshotCounts.delete(id)
          await this.persistBindAndDeleteActiveTaskSnapshot(id, 'shutdown', 0, 'status')
        }
      } else if (!preserveDagFinalization) {
        this.snapshotCounts.delete(id)
        await this.persistBindAndDeleteActiveTaskSnapshot(id, 'shutdown', 0, 'status')
      }
    } finally {
      this.effectRecoveryPreservedSessions.delete(id)
    }
  }

  async dispatchSubagents(
    parentSessionId: string,
    input: DispatchSubagentsInput
  ): Promise<SubagentDispatchResult> {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    const tasks = Array.isArray(input?.tasks) ? input.tasks : []
    if (tasks.length === 0) throw new Error('至少需要一个子代理任务')
    if (tasks.length > 33) throw new Error('一次最多派发 33 个子代理')

    const orchestrationId = randomUUID()
    const children: SubagentDispatchResult['children'] = []
    const usedTaskIds = new Set<string>()
    const plannedTasks = tasks.map((task, index) => {
      const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
      if (!prompt) throw new Error(`子代理任务 ${index + 1} 缺少 prompt`)
      let taskId = normalizeTaskId(task.id, `task-${index + 1}`)
      while (usedTaskIds.has(taskId)) taskId = `${taskId}-${index + 1}`
      usedTaskIds.add(taskId)
      const role = cleanOneLine(task.role ?? '', '', 40) || undefined
      const title = cleanOneLine(task.title ?? role ?? prompt, `子代理 ${index + 1}`, 42)
      return { task, taskId, prompt, role, title }
    })

    const state: OrchestrationState = {
      parentSessionId,
      acceptingChildren: true,
      pending: new Set(),
      results: [],
      startedAt: Date.now()
    }
    this.orchestrations.set(orchestrationId, state)

    try {
      for (const { task, taskId, prompt, role, title } of plannedTasks) {
        const meta = await this.createManaged({
          cwd: subagentCwd(task, input, parent.meta),
          isolated: task.isolated ?? input.isolated ?? true,
          driveMode: task.driveMode ?? input.driveMode ?? parent.meta.driveMode,
          model: task.model ?? input.model ?? parent.meta.model,
          providerId: task.providerId ?? input.providerId ?? parent.meta.providerId,
          engine: task.engine ?? input.engine ?? parent.meta.engine,
          permissionMode: task.permissionMode ?? input.permissionMode ?? parent.meta.permissionMode,
          title,
          parentSessionId,
          orchestrationId,
          childTaskId: taskId,
          childRole: role
        })
        state.pending.add(meta.id)
        children.push({ taskId, prompt, meta })
      }
    } catch (error) {
      state.acceptingChildren = false
      this.orchestrations.delete(orchestrationId)
      await this.rollbackProvisionedSubagents(children)
      throw error
    }
    state.acceptingChildren = false
    for (const child of children) this.send(child.meta.id, child.prompt)
    this.completeOrchestrationIfReady(orchestrationId, state)

    return { orchestrationId, parentSessionId, children }
  }

  private async rollbackProvisionedSubagents(children: SubagentDispatchResult['children']): Promise<void> {
    for (const child of [...children].reverse()) {
      try {
        await this.close(child.meta.id)
        if (!child.meta.isolated) continue
        const removed = await executeInteractiveOperationEffectRemoveWorktree(
          child.meta.id,
          { force: true, deleteBranch: true },
          executeInteractiveOperationEffect
        )
        if (!removed.ok) console.error('[caogen] rollback provisioned subagent worktree failed:', removed)
      } catch (error) {
        console.error('[caogen] rollback provisioned subagent failed:', error)
      }
    }
  }

  async decomposeTask(parentSessionId: string, input: TaskDecomposeInput): Promise<TaskDecomposeResult> {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    const request: TaskDecomposeInput = {
      ...input,
      cwd: input.cwd ?? parent.meta.sourceCwd ?? parent.meta.cwd,
      providerId: input.providerId ?? parent.meta.providerId,
      model: input.model ?? parent.meta.model
    }
    const run = this.taskRuns.get(parentSessionId)
    const activeStep = [...(run?.steps ?? [])].reverse().find((step) => !step.finishedAt)
    const attemptContext = run
      ? {
          runId: run.id,
          requestId: `model-request:${run.id}:dag:${randomUUID()}`,
          stepId: activeStep?.id
        }
      : undefined
    return decomposeTask(request, {
      modelDecomposer: createModelDagDecomposer(request, attemptContext)
    })
  }

  async dispatchTaskDag(
    parentSessionId: string,
    input: TaskDagDispatchInput
  ): Promise<TaskDagDispatchResult> {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    const children: SubagentDispatchResult['children'] = []
    const scheduler = new TaskDagScheduler(parentSessionId, input, {
      runTask: async (task, context) => {
        const prompt = buildDagTaskPrompt(task, context)
        const meta = await this.createManaged({
          cwd: input.cwd ?? parent.meta.sourceCwd ?? parent.meta.cwd,
          isolated: input.isolated ?? true,
          driveMode: input.driveMode ?? parent.meta.driveMode,
          model: input.model ?? parent.meta.model,
          providerId: input.providerId ?? parent.meta.providerId,
          engine: input.engine ?? parent.meta.engine,
          permissionMode: input.permissionMode ?? parent.meta.permissionMode,
          title: `${task.title}${context.attempt > 1 ? ` · 重试 ${context.attempt - 1}` : ''}`,
          parentSessionId,
          orchestrationId: input.dag.id,
          childTaskId: task.id,
          childRole: task.role
        }, { retainJournal: true })
        const item = { taskId: task.id, prompt, meta }
        children.push(item)
        return {
          sessionId: meta.id,
          dispatchItem: item,
          start: () => requireDagPromptAccepted(this.send(meta.id, prompt))
        }
      },
      onUpdate: (execution) => this.emitTaskDagUpdate(parentSessionId, execution),
      onTaskProvisioned: async (_execution, sessionId) => {
        await this.persistDagProvisioning(parentSessionId)
        this.acknowledgeSessionCreation(sessionId, true)
      },
      onComplete: (execution) => this.finishTaskDag(parentSessionId, execution),
      onTaskTimeout: (sessionId, taskId, error) => this.handleDagTaskTimeout(parentSessionId, sessionId, taskId, error)
    })
    this.dagExecutionSnapshots.delete(input.dag.id)
    this.dagSchedulers.set(input.dag.id, scheduler)
    this.dagAutoMergeOptions.set(input.dag.id, {
      enabled: input.autoMerge === true,
      verificationCommand: input.verificationCommand
    })
    const launched = await scheduler.start()
    if (launched.length > 0) {
      const known = new Set(children.map((child) => child.meta.id))
      for (const item of launched) {
        if (!known.has(item.meta.id)) children.push(item)
      }
    }
    const execution = scheduler.view()
    this.emitTaskDagUpdate(parentSessionId, execution)
    return { execution, children }
  }

  private createTaskDagSchedulerCallbacks(
    parentSessionId: string,
    input: TaskDagDispatchInput,
    children?: SubagentDispatchResult['children']
  ): TaskDagSchedulerCallbacks {
    return {
      runTask: async (task, context) => {
        const parent = this.sessions.get(parentSessionId)
        if (!parent) throw new Error('Parent session no longer exists for recovered DAG')
        const prompt = buildDagTaskPrompt(task, context)
        const meta = await this.createManaged({
          cwd: input.cwd ?? parent.meta.sourceCwd ?? parent.meta.cwd,
          isolated: input.isolated ?? true,
          driveMode: input.driveMode ?? parent.meta.driveMode,
          model: input.model ?? parent.meta.model,
          providerId: input.providerId ?? parent.meta.providerId,
          engine: input.engine ?? parent.meta.engine,
          permissionMode: input.permissionMode ?? parent.meta.permissionMode,
          title: `${task.title}${context.attempt > 1 ? ` retry ${context.attempt - 1}` : ''}`,
          parentSessionId,
          orchestrationId: input.dag.id,
          childTaskId: task.id,
          childRole: task.role
        }, { retainJournal: true })
        const item = { taskId: task.id, prompt, meta }
        children?.push(item)
        return {
          sessionId: meta.id,
          dispatchItem: item,
          start: () => requireDagPromptAccepted(this.send(meta.id, prompt))
        }
      },
      onUpdate: (execution) => this.emitTaskDagUpdate(parentSessionId, execution),
      onTaskProvisioned: async (_execution, sessionId) => {
        await this.persistDagProvisioning(parentSessionId)
        this.acknowledgeSessionCreation(sessionId, true)
      },
      onComplete: (execution) => this.finishTaskDag(parentSessionId, execution),
      onTaskTimeout: (sessionId, taskId, error) =>
        this.handleDagTaskTimeout(parentSessionId, sessionId, taskId, error)
    }
  }

  async supportedAgents(sessionId: string): Promise<SdkAgentInfo[]> {
    const session = this.sessions.get(sessionId)
    if (!session?.supportedAgents) return []
    return session.supportedAgents()
  }

  private emitTaskDagUpdate(parentSessionId: string, execution: TaskDagExecutionView): void {
    this.dagExecutionSnapshots.set(execution.id, execution)
    const event: AgentEvent = { kind: 'task-dag-update', execution }
    const parent = this.sessions.get(parentSessionId)
    if (parent?.emitSyntheticEvent) {
      parent.emitSyntheticEvent(event)
    } else {
      this.dispatch(parentSessionId, event, 0)
    }
  }

  private persistDagProvisioning(parentSessionId: string): Promise<void> {
    return this.writeTaskSnapshot(parentSessionId, 'important-event', 0, 'task-dag-update', undefined, true)
  }

  private handleDagTaskTimeout(parentSessionId: string, childSessionId: string, taskId: string, error: string): void {
    const child = this.sessions.get(childSessionId)
    if (child) {
      void child.interrupt().catch((err) => {
        console.error('[caogen] DAG 子任务超时后中断 child session 失败:', err)
      })
    }
    this.dispatch(
      parentSessionId,
      {
        kind: 'hook-event',
        event: 'task-dag-timeout',
        detail: `${taskId}: ${error}`
      },
      0
    )
  }

  private finishTaskDag(_parentSessionId: string, execution: TaskDagExecutionView): Promise<void> {
    return this.dagFinalizationCoordinator.finish(
      execution,
      this.dagAutoMergeOptions.get(execution.id),
      this.snapshotDagMergeSessionsFor(execution)
    )
  }

  /**
   * 真编排回灌:child 首轮 turn-result 到达时记录;全部完成后把
   * 汇总(任务/状态/产物 worktree/分支/结果摘要)作为一条用户消息
   * 发给父 Agent,让父 Agent 真正"知道"子任务结果并能继续编排
   * (审查 diff、合并、追加任务)。此前结果只进 UI,父 Agent 全盲。
   */
  private recordOrchestrationResult(childMeta: SessionMeta, event: AgentEvent & { kind: 'turn-result' }): void {
    const orchestrationId = childMeta.orchestrationId
    if (!orchestrationId) return
    const state = this.orchestrations.get(orchestrationId)
    if (!state || !state.pending.has(childMeta.id)) return
    state.pending.delete(childMeta.id)
    state.results.push({
      taskId: childMeta.childTaskId,
      role: childMeta.childRole,
      sessionId: childMeta.id,
      ok: !event.isError,
      resultText: event.resultText,
      costUsd: childMeta.costUsd,
      branch: childMeta.branch,
      worktreePath: childMeta.worktreePath
    })
    this.acknowledgeSessionCreation(childMeta.id)
    if (state.pending.size > 0) return
    this.completeOrchestrationIfReady(orchestrationId, state)
  }

  private completeOrchestrationIfReady(orchestrationId: string, state: OrchestrationState): void {
    if (state.acceptingChildren || state.pending.size > 0) return

    this.orchestrations.delete(orchestrationId)
    const parent = this.sessions.get(state.parentSessionId)
    if (!parent || parent.meta.status === 'closed') return

    const okCount = state.results.filter((r) => r.ok).length
    const lines: string[] = [
      `[子代理编排完成] ${okCount}/${state.results.length} 成功,耗时 ${Math.round((Date.now() - state.startedAt) / 1000)}s。各任务结果:`,
      ''
    ]
    for (const r of state.results) {
      lines.push(
        `## ${r.taskId ?? r.sessionId}${r.role ? `(${r.role})` : ''} — ${r.ok ? '成功' : '失败'}`
      )
      if (r.branch) lines.push(`分支: ${r.branch}`)
      if (r.worktreePath) lines.push(`worktree: ${r.worktreePath}`)
      if (r.resultText) lines.push(`结果摘要:\n${r.resultText.slice(0, 1500)}`)
      lines.push('')
    }
    lines.push(
      '请汇总以上子任务结果:指出成功/失败与冲突风险,给出合并顺序建议;如需修复失败项或追加任务,说明具体做法。'
    )
    // 回灌走 send:预算闸门照常生效,防止编排递归烧穿预算
    this.send(state.parentSessionId, lines.join('\n'))
  }

  close(id: string): Promise<void> {
    const existing = this.closingSessions.get(id)
    if (existing) return existing
    const session = this.sessions.get(id)
    if (!session) return Promise.resolve()
    this.effectRecoveryPreservedSessions.add(id)
    const closing = this.closeAfterExecutorStops(id, session).finally(() => {
      this.effectRecoveryPreservedSessions.delete(id)
      this.closingSessions.delete(id)
    })
    this.closingSessions.set(id, closing)
    return closing
  }

  private async closeAfterExecutorStops(id: string, session: Engine): Promise<void> {
    await session.dispose()
    await this.workflow.flush(id)
    let run = this.taskRuns.get(id)
    const preserveRecovery = runHasUnresolvedEffects(run) || await this.modelAttemptRecoveryGate.shouldPreserveAfterRefresh(id, 'close')
    const preserveDagFinalization = this.dagFinalizationCoordinator.hasIncomplete(id)
    if (run && !isTaskRunTerminal(run.status)) {
      if (preserveRecovery) {
        run = recoverTaskExecutionState(run)
        if (run.status !== 'waiting_reconciliation') {
          run = transitionTaskRun(run, 'waiting_reconciliation', { lastEventKind: 'status' })
        }
        this.taskRuns.set(id, run)
        await this.writeTaskSnapshot(id, 'shutdown', 0, 'status')
      } else {
        this.taskRuns.set(id, transitionTaskRun(run, 'cancelled', { lastEventKind: 'status' }))
      }
    }
    // 编排中的 child 被手动关闭:按"失败"记账,避免整组编排永远等不齐
    const orchestrationId = session.meta.orchestrationId
    const dag = orchestrationId ? this.dagSchedulers.get(orchestrationId) : undefined
    if (dag?.hasSession(id)) {
      await dag.completeSession(id, {
        ok: false,
        resultText: '子会话被手动关闭,任务未完成',
        error: '子会话被手动关闭'
      })
    }
    if (orchestrationId && this.orchestrations.get(orchestrationId)?.pending.has(id)) {
      this.recordOrchestrationResult(session.meta, {
        kind: 'turn-result',
        subtype: 'closed',
        isError: true,
        resultText: '子会话被手动关闭,任务未完成'
      })
    }
    if (preserveDagFinalization && !preserveRecovery) {
      await this.writeTaskSnapshot(id, 'shutdown', 0, 'status', undefined, true)
    }
    if (!preserveRecovery && !preserveDagFinalization) {
      await this.persistBindAndDeleteActiveTaskSnapshot(id, 'shutdown', 0, 'status')
      this.taskRuns.delete(id)
    }
    this.supervisor.releaseSession(id, run?.id)
    this.stopEnginePowerBlocker(id)
    this.sessions.delete(id)
    this.snapshotCounts.delete(id)
    this.recentEventIds.delete(id)
    this.persistActiveSessions()
    this.notificationStates.delete(id)
    clearIdeDocumentContext(id)
    this.modelAttemptRecoveryGate.clearSession(id)
    this.acknowledgeSessionCreation(id)
  }

  updateWorktreeState(id: string, state: SessionMeta['worktreeState']): void {
    const session = this.sessions.get(id)
    if (session) {
      session.meta.worktreeState = state
      this.persist(id)
      this.persistActiveSessions()
      return
    }
    updateActiveSessionRegistryWorktreeState(id, state)
  }

  async disposeAll(): Promise<void> {
    this.persistActiveSessions()
    // dispose 后 provider 仍可能异步发出尾事件。关机期间保持保护，避免晚到的
    // turn-result/status 把刚写好的恢复快照删掉。
    this.preservingSnapshotsOnDispose = true
    const pendingDisposals: Array<Promise<void>> = []
    for (const session of this.sessions.values()) {
      pendingDisposals.push(session.dispose())
      this.stopEnginePowerBlocker(session.meta.id)
      clearIdeDocumentContext(session.meta.id)
    }
    const disposalResults = await Promise.allSettled(pendingDisposals)
    for (const result of disposalResults) {
      if (result.status === 'rejected') {
        console.error('[caogen] 关闭执行器时发生错误，保留恢复快照:', result.reason)
      }
    }
    await this.dagFinalizationCoordinator.flushPending()
    await Promise.all([...this.sessions.keys()].map((id) =>
      this.workflow.persistShutdownSnapshot(id, this.workflow.captureSnapshot(id, 'shutdown', 0, 'status'))))
    await flushTaskSnapshotMutations()
    this.sessions.clear()
    this.notificationStates.clear()
    this.taskRuns.clear()
    this.recentEventIds.clear()
    this.modelAttemptRecoveryGate.clear()
    this.supervisor.clear()
  }

  getTranscript(id: string): TranscriptEntry[] {
    return this.sessions.get(id)?.getTranscript() ?? []
  }

  async listModelAttemptReconciliations() { return (await this.modelAttemptRecoveryGate.list()).filter((view) => !this.sessions.has(view.sessionId)) }

  async resolveModelAttemptReconciliation(attemptId: string, expectedRevision: number, resolution: ModelAttemptReconciliationResolution) {
    const resolved = await this.modelAttemptRecoveryGate.resolve(
      attemptId, expectedRevision, resolution, app.getPath('userData'),
      (sessionId) => this.sessions.has(sessionId))
    this.taskRuns.set(resolved.run.sessionId, resolved.run)
    return resolved.view
  }

  async listTaskSnapshots(): Promise<TaskSnapshotRecord[]> {
    return this.reconcileTaskSnapshots(await listTaskSnapshots(), this.workflow.recoveryBlocks())
  }

  private async reconcileTaskSnapshots(
    snapshots: TaskSnapshotRecord[],
    blockedSessionIds: ReadonlySet<string> = new Set()
  ): Promise<TaskSnapshotRecord[]> {
    const reconciled = await mapWithConcurrencyInOrder(
      snapshots,
      TASK_SNAPSHOT_RECONCILIATION_CONCURRENCY,
      async (snapshot): Promise<TaskSnapshotRecord | null> => {
        if (blockedSessionIds.has(snapshot.sessionId)) return snapshot
        // Helper 内部执行 isInteractiveOperationActive(snapshot)，并保持“交互操作快照只能进行效果对账”恢复边界。
        if (isInteractiveOperationSnapshot(snapshot)) return this.reconcileOperationSnapshot(snapshot)
        if (this.sessions.has(snapshot.sessionId)) {
          return snapshot
        }
        const reconciled = reconcileSnapshotWithReceipts(snapshot)
        if (reconciled.terminalRun) {
          if (this.dagFinalizationCoordinator.hasIncomplete(snapshot.sessionId)) {
            return reconcilePersistedTaskSnapshot(reconciled.snapshot)
          }
          const persisted = await reconcilePersistedTaskSnapshot(reconciled.snapshot)
          await this.workflow.bindSnapshot(persisted)
          await deleteTaskSnapshot(snapshot.id, undefined, persisted.run)
          return null
        }
        return reconcilePersistedTaskSnapshot(reconciled.snapshot)
      }
    )
    return reconciled.filter((snapshot): snapshot is TaskSnapshotRecord => snapshot !== null)
  }

  private async reconcileOperationSnapshot(snapshot: TaskSnapshotRecord): Promise<TaskSnapshotRecord | null> {
    const reconciled = await reconcileInteractiveOperationSnapshot(snapshot)
    for (const effect of snapshot.run?.effects ?? []) {
      const target = effect.target
      if (target.kind !== 'git_worktree_create' && target.kind !== 'git_worktree_remove') continue
      const record = managedWorktreeRecordForSession(target.sessionId)
      if (record) this.updateWorktreeState(target.sessionId, record.state)
    }
    const operationId = snapshot.run?.operation?.operationId
    if (operationId) await this.dagFinalizationCoordinator.resumeForOperation(operationId)
    return reconciled
  }

  private async restorePendingSessionCreations(snapshots: TaskSnapshotRecord[]): Promise<void> {
    for (const plan of planPendingSessionCreations(snapshots)) {
      if (plan.kind === 'acknowledge') {
        this.acknowledgeSessionCreation(plan.draft.baseMeta.id)
      } else if (plan.kind === 'block') {
        this.blockedPendingDagSessions.set(plan.draft.baseMeta.id, plan.draft)
        console.error(
          `[caogen] blocked managed child recovery (${plan.reason}): ${plan.draft.baseMeta.id}`
        )
      } else if (plan.kind === 'restore') {
        await this.restorePendingSessionCreation(plan)
      }
    }
  }

  private async restorePendingSessionCreation(
    plan: Extract<PendingSessionRecoveryPlan, { kind: 'restore' }>
  ): Promise<void> {
    const { draft: persistedDraft, recoveredDag, record } = plan
    let draft = persistedDraft
    try {
      const baseMeta = await prepareSessionIdentityForActivation(draft.baseMeta, app.getPath('userData'), true)
      draft = { ...draft, baseMeta }
    } catch (error) {
      console.error('[caogen] pending managed session ownership recovery failed:', error)
      return
    }
    const sessionId = draft.baseMeta.id
    if (this.sessions.has(sessionId)) return this.acknowledgeSessionCreation(sessionId)
    if (recoveredDag) this.retainedSessionCreationJournals.add(sessionId)
    let placement: SessionWorktreePlacement
    try {
      placement = record
        ? { isolated: true, cwd: record.cwd, record }
        : await managedSessionPlacement(draft)
    } catch (error) {
      this.retainedSessionCreationJournals.delete(sessionId)
      if (!requiresEffectReconciliation(error)) this.acknowledgeSessionCreation(sessionId)
      console.error('[caogen] pending managed session placement recovery failed:', error)
      return
    }
    try {
      await this.activateManagedSessionCreation(draft, placement)
      if (recoveredDag) this.recoveredPendingSessions.set(sessionId, draft)
      else this.emitRecoveredSessionCreation(sessionId)
    } catch (error) {
      this.retainedSessionCreationJournals.delete(sessionId)
      console.error('[caogen] pending managed session activation recovery failed:', error)
    }
  }

  async deleteTaskSnapshot(id: string): Promise<boolean> {
    if (this.sessions.has(id)) throw new Error('活动会话的恢复快照不能手动删除；请先关闭会话。')
    await this.workflow.flush(id)
    this.workflow.assertRecoveryResolved(id)
    const snapshot = await getTaskSnapshot(id)
    if (snapshot) await this.modelAttemptRecoveryGate.assertSnapshotDeletable(snapshot, app.getPath('userData'))
    const operationWaiting = snapshot?.run?.operation && snapshot.run.status === 'waiting_reconciliation'
    if (runHasUnresolvedEffects(snapshot?.run) || operationWaiting) {
      throw new Error('waiting_reconciliation 效果尚未处置，不能删除恢复入口；请先确认已执行或未执行。')
    }
    if (this.dagFinalizationCoordinator.hasIncomplete(snapshot?.sessionId ?? id)) {
      throw new Error('DAG finalizer 尚未完成，不能删除父任务恢复入口。')
    }
    if (snapshot) await this.workflow.bindSnapshot(snapshot)
    this.snapshotCounts.delete(id)
    if (!this.sessions.has(id)) this.recentEventIds.delete(id)
    this.taskRuns.delete(id)
    return deleteTaskSnapshot(id)
  }

  async recoverTaskSnapshot(id: string): Promise<SessionMeta> {
    const stored = await getTaskSnapshot(id)
    if (!stored) throw new Error('未找到可恢复的任务快照')
    await this.supervisor.hydrateSendGate(stored.run)
    this.workflow.assertRecoveryResolved(stored.sessionId)
    assertAgentRecoverySnapshot(stored)
    await this.modelAttemptRecoveryGate.prepareRecovery(stored, app.getPath('userData'))
    const active = this.sessions.get(stored.sessionId)
    if (active) {
      this.modelAttemptRecoveryGate.clearReplayAllowance(stored.sessionId)
      return { ...active.meta }
    }
    const prepared = await prepareTaskSnapshotRecovery(
      stored,
      app.getPath('userData'),
      (sessionId) => this.dagFinalizationCoordinator.hasIncomplete(sessionId)
    )
    return this.activateRecoveredTaskSnapshot(prepared.snapshot, prepared.recoveredRun)
  }

  private async activateRecoveredTaskSnapshot(
    snapshot: TaskSnapshotRecord,
    recoveredRun: TaskRunRecord
  ): Promise<SessionMeta> {
    const { lastError: _lastError, ...restMeta } = snapshot.meta
    assertTaskSnapshotWorktreeProjection(restMeta, snapshot.worktree)
    const meta: SessionMeta = {
      ...sessionMetaForRecovery(restMeta),
      status: 'starting',
      sdkSessionId: snapshot.execution.sdkSessionId,
      resumeSessionAt: snapshot.execution.resumeSessionAt
    }
    if (!meta.unassigned && !meta.projectId) meta.projectId = touchProject(meta.sourceCwd ?? meta.cwd).id
    resolveDigitalWorkerSessionScope(meta, app.getPath('userData'))
    bindAndValidateTaskRun(meta, recoveredRun)
    restoreTranscriptIfMissing(snapshot.execution.sdkSessionId, snapshot.transcript)
    this.taskRuns.set(snapshot.sessionId, recoveredRun)
    this.snapshotCounts.set(meta.id, {
      total: snapshot.eventCount,
      sinceSave: 0,
      lastSeq: snapshot.execution.cursor?.seq ?? snapshot.execution.lastSeq,
      lastEventId: snapshot.execution.cursor?.eventId ?? snapshot.execution.lastEventId
    })
    this.recentEventIds.set(meta.id, [...(recoveredRun.recentEventIds ?? [])].slice(-256))
    const session = createEngine(
      meta.engine,
      meta,
      (event, seq, identity) => this.dispatch(meta.id, event, seq, identity),
      snapshot.execution.sdkSessionId,
      snapshot.execution.cursor?.seq ?? snapshot.execution.lastSeq
    )
    this.sessions.set(meta.id, session)
    this.persistActiveSessions()
    const recoveredSnapshot = { ...snapshot, run: recoveredRun }
    const restoredDagRuntimeCount = await this.restoreDagRuntimesFromSnapshot(meta.id, recoveredSnapshot)
    await this.writeTaskSnapshot(
      meta.id,
      'recovered',
      snapshot.execution.cursor?.seq ?? snapshot.execution.lastSeq,
      snapshot.execution.lastEventKind,
      snapshot.execution.cursor?.eventId ?? snapshot.execution.lastEventId
    )
    this.startRecoveredSession(session, recoveredSnapshot, restoredDagRuntimeCount > 0)
    return { ...meta }
  }

  async resolveTaskEffect(
    snapshotId: string,
    effectId: string,
    expectedRevision: number,
    resolution: 'confirmed_applied' | 'confirmed_not_applied'
  ): Promise<{ snapshot: TaskSnapshotRecord; resumedSession?: SessionMeta }> {
    const beforePersist = sessionCreationResolutionBarrier(resolution, (id) => this.acknowledgeSessionCreation(id, true))
    const snapshot = await resolvePersistedTaskEffect(snapshotId, effectId, expectedRevision, resolution, { beforePersist })
    const effect = snapshot.run?.effects?.find((candidate) => candidate.id === effectId)
    let resumedSession: SessionMeta | undefined
    if (effect?.target.kind === 'git_worktree_create') {
      if (resolution === 'confirmed_applied') {
        resumedSession = await this.resumeResolvedTopLevelSessionCreation(effect.target.sessionId)
      }
    }
    const operationId = snapshot.run?.operation?.operationId
    if (operationId) await this.dagFinalizationCoordinator.resumeForOperation(operationId)
    return { snapshot, ...(resumedSession ? { resumedSession } : {}) }
  }

  resolveTaskDagFinalization(
    executionId: string,
    expectedRevision: number,
    resolution: TaskDagFinalizationResolution
  ): Promise<TaskDagFinalizationRecord> {
    return this.dagFinalizationCoordinator.resolve(executionId, expectedRevision, resolution)
  }

  private async resumeResolvedTopLevelSessionCreation(sessionId: string): Promise<SessionMeta | undefined> {
    const active = this.sessions.get(sessionId)
    if (active) return { ...active.meta }
    const draft = listPendingSessionCreations().find((candidate) => candidate.baseMeta.id === sessionId)
    if (!draft) return undefined
    const record = managedWorktreeRecordForSession(sessionId)
    if (!record || record.state !== 'active') return undefined
    try {
      const meta = await this.activateManagedSessionCreation(draft, { isolated: true, cwd: record.cwd, record })
      this.emitRecoveredSessionCreation(sessionId)
      return meta
    } catch (error) {
      throw managedSessionActivationRecoveryError(error, sessionId)
    }
  }

  private startRecoveredSession(
    session: Engine,
    snapshot: TaskSnapshotRecord,
    resumeDagRuntime = false
  ): void {
    void session
      .start()
      .then(async () => {
        const replayPrompts = buildTaskSnapshotReplayPrompts(snapshot)
        const active = this.sessions.get(snapshot.sessionId)
        if (active !== session) return
        const waitingFinalization = this.dagFinalizationCoordinator.waitingForParent(snapshot.sessionId)
        if (waitingFinalization) {
          this.dagFinalizationCoordinator.notifyRecoveryBlock(waitingFinalization)
          return
        }
        const run = this.taskRuns.get(snapshot.sessionId)
        if (this.supervisor.blocksSend(snapshot.sessionId, run)) {
          this.dispatch(
            snapshot.sessionId,
            {
              kind: 'hook-event',
              event: 'supervisor-recovery-gated',
              detail: 'Recovered session is waiting for an explicit Supervisor resume command.'
            },
            0
          )
          return
        }
        const mustReplayInterruptedRun = replayPrompts.length > 0 && Boolean(run && !isTaskRunTerminal(run.status))
        if (!mustReplayInterruptedRun) {
          const resumedFinalization = await this.dagFinalizationCoordinator.resumeForParent(snapshot.sessionId)
          if (resumedFinalization) return
        }
        if (resumeDagRuntime) {
          this.dispatch(
            snapshot.sessionId,
            {
              kind: 'hook-event',
              event: 'task-dag-recovered',
              detail: 'Recovered DAG scheduler runtime from task snapshot; continuing dependency scheduling.'
            },
            0
          )
          await this.resumeRecoveredDagRuntimes(snapshot.sessionId)
          return
        }
        if (replayPrompts.length === 0) return
        if (active.meta.status === 'error' || active.meta.status === 'closed') return
        this.dispatch(
          snapshot.sessionId,
          {
            kind: 'hook-event',
            event: 'task-snapshot-replay',
            detail: `已从快照恢复,准备按顺序续跑 ${replayPrompts.length} 个未完成步骤。`
          },
          0
        )
        for (const prompt of replayPrompts) this.send(snapshot.sessionId, prompt, { modelAttemptRecoveryReplay: true })
      })
      .catch((err) => {
        console.error('[caogen] 恢复任务快照启动失败:', err)
      })
  }

  /** 启动时:补全 GUI 启动缺失的 PATH → 注册内置引擎 → 清理不可达转录文件 */
  async init(): Promise<void> {
    // Dock 启动的应用 PATH 极简,先补全以便后续工具调用找到用户安装的 CLI。
    fixPathForGuiLaunch()
    configureModelStatsDir(app.getPath('userData'))
    configureProviderHealthDir(app.getPath('userData'))
    registerBuiltinEngines()
    await this.modelAttemptRecoveryGate.initialize(app.getPath('userData'))
    await this.dagFinalizationCoordinator.load()
    const persistedTaskRuns = await listPersistedTaskRuns()
    this.taskRuns.hydrateHistory(persistedTaskRuns)
    await this.supervisor.hydrateSendGates(persistedTaskRuns)
    await this.dagFinalizationCoordinator.migrateLegacyRecords()
    const imported = await listTaskSnapshots()
    const workflowRecoveryBlocks = await this.workflow.recover(imported)
    const recoverable = await this.reconcileTaskSnapshots(imported, workflowRecoveryBlocks)
    const activeRecoveryBlocks = activeSessionRecoveryBlocks(recoverable)
    this.modelAttemptRecoveryGate.blockActiveSessions(activeRecoveryBlocks)
    this.restoreActiveSessions(activeRecoveryBlocks)
    await this.restorePendingSessionCreations(recoverable)
    await this.dagFinalizationCoordinator.autoRecoverParents(recoverable)
    for (const session of this.sessions.values()) {
      await this.dagFinalizationCoordinator.resumeForParent(session.meta.id)
    }
    const keep = new Set(listHistory().map((h) => h.sdkSessionId))
    for (const snapshot of recoverable) {
      const sdkSessionId = snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
      if (sdkSessionId) keep.add(sdkSessionId)
    }
    for (const session of this.sessions.values()) {
      if (session.meta.sdkSessionId) keep.add(session.meta.sdkSessionId)
    }
    cleanupTranscripts(keep)
    const recoverableCount = this.modelAttemptRecoveryGate
      .recoverableSessionCount(recoverable.map((snapshot) => snapshot.sessionId))
    if (recoverableCount > 0 && getSettings().notificationsEnabled) {
      showDesktopNotification({
        title: 'CaoGen: 检测到未完成任务',
        body: `发现 ${recoverableCount} 个未完成任务或模型对账项，可从恢复入口继续。`,
        sessionId: 'task-snapshot'
      })
    }
  }

  private async restoreDagRuntimesFromSnapshot(
    parentSessionId: string,
    snapshot: TaskSnapshotRecord
  ): Promise<number> {
    const executionById = new Map(snapshot.dagExecutions.map((execution) => [execution.id, execution]))
    for (const execution of snapshot.dagExecutions) {
      if (execution.parentSessionId === parentSessionId) this.dagExecutionSnapshots.set(execution.id, execution)
    }

    let restored = 0
    for (const runtime of snapshot.dagRuntimes ?? []) {
      if (runtime.parentSessionId !== parentSessionId) continue
      const execution = executionById.get(runtime.executionId)
      if (!execution) continue
      this.dagExecutionSnapshots.set(execution.id, execution)
      if (runtime.mergeSessions) this.dagRuntimeMergeSessions.set(execution.id, runtime.mergeSessions)
      if (execution.completedAt !== undefined && (execution.status === 'success' || execution.status === 'failed')) {
        await this.dagFinalizationCoordinator.restoreTerminalExecution(
          execution,
          runtime.autoMerge,
          runtime.mergeSessions
        )
        continue
      }

      const input = this.taskDagDispatchInputFromRuntime(runtime, execution)
      try {
        const scheduler = TaskDagScheduler.fromRuntimeSnapshot(
          runtime,
          execution,
          this.createTaskDagSchedulerCallbacks(parentSessionId, input),
          new Set(this.sessions.keys())
        )
        this.dagSchedulers.set(execution.id, scheduler)
        if (runtime.autoMerge) {
          this.dagAutoMergeOptions.set(execution.id, {
            enabled: runtime.autoMerge.enabled,
            verificationCommand: runtime.autoMerge.verificationCommand
          })
        }
        await this.blockRecoveredPendingDagSessions(scheduler, execution)
        await this.adoptRecoveredPendingDagSessions(scheduler, execution)
        restored += 1
      } catch (err) {
        console.error('[caogen] restore DAG runtime snapshot failed:', err)
      }
    }
    return restored
  }

  private async adoptRecoveredPendingDagSessions(
    scheduler: TaskDagScheduler,
    execution: TaskDagExecutionView
  ): Promise<void> {
    for (const [sessionId, draft] of this.recoveredPendingSessions) {
      const meta = this.sessions.get(sessionId)?.meta
      if (!meta || meta.parentSessionId !== execution.parentSessionId) continue
      if (meta.orchestrationId !== execution.id || !meta.childTaskId) continue
      const item = await scheduler.adoptProvisionedSession(meta.childTaskId, { ...meta })
      if (item) {
        await scheduler.startProvisionedSession(item.meta.id, () => requireDagPromptAccepted(this.send(item.meta.id, item.prompt)))
        continue
      }
      const task = execution.tasks.find((candidate) => candidate.task.id === meta.childTaskId)
      if (!scheduler.hasSession(sessionId) && task && (task.status === 'success' || task.status === 'failed')) {
        this.acknowledgeSessionCreation(sessionId)
      }
    }
  }

  private async blockRecoveredPendingDagSessions(
    scheduler: TaskDagScheduler,
    execution: TaskDagExecutionView
  ): Promise<void> {
    for (const [sessionId, draft] of this.blockedPendingDagSessions) {
      const meta = draft.baseMeta
      if (meta.parentSessionId !== execution.parentSessionId) continue
      if (meta.orchestrationId !== execution.id || !meta.childTaskId) continue
      await scheduler.blockRecoveryTask(
        meta.childTaskId,
        sessionId,
        `DAG child ${sessionId} has a recoverable task snapshot and pending creation journal; ` +
        'prompt delivery state is unknown, so automatic replacement is blocked. Recover or reconcile the original child.'
      )
    }
  }

  private taskDagDispatchInputFromRuntime(
    runtime: TaskDagRuntimeSnapshot,
    execution: TaskDagExecutionView
  ): TaskDagDispatchInput {
    return {
      dag: execution.dag,
      cwd: runtime.dispatchOptions.cwd,
      isolated: runtime.dispatchOptions.isolated,
      driveMode: runtime.dispatchOptions.driveMode,
      model: runtime.dispatchOptions.model,
      providerId: runtime.dispatchOptions.providerId,
      engine: runtime.dispatchOptions.engine,
      permissionMode: runtime.dispatchOptions.permissionMode,
      maxRetries: execution.maxRetries,
      taskTimeoutMs: runtime.dispatchOptions.taskTimeoutMs,
      autoMerge: runtime.autoMerge?.enabled,
      verificationCommand: runtime.autoMerge?.verificationCommand
    }
  }

  private async resumeRecoveredDagRuntimes(parentSessionId: string): Promise<void> {
    for (const scheduler of this.dagSchedulers.values()) {
      const execution = scheduler.view()
      if (execution.parentSessionId !== parentSessionId) continue
      await scheduler.resume()
    }
  }

  private dispatch(
    sessionId: string,
    rawEvent: AgentEvent,
    seq: number,
    sourceIdentity?: AgentEventIdentity
  ): void {
    const identity = this.normalizeEventIdentity(sessionId, seq, sourceIdentity)
    if (!identity) return
    const session = this.sessions.get(sessionId)
    const event = session ? this.normalizeTurnResultCost(session, rawEvent) : rawEvent
    handleSessionTaskRunEvent(this.taskRuns, sessionId, event, identity, {
      cwd: session?.meta.cwd ?? '',
      supervisorPauseIntent: this.supervisor.isPauseIntent(sessionId),
      preserveClosedRun: this.preservingSnapshotsOnDispose ||
        this.effectRecoveryPreservedSessions.has(sessionId)
    })
    this.modelAttemptRecoveryGate.refreshAfterEvent(sessionId, event)
    const payload: SessionEventPayload = { sessionId, ...identity, event }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session:event', payload)
    }
    this.emitToSubscribers(payload)
    this.dispatchChildResult(sessionId, session, event)
    this.handleEnginePowerBlocker(sessionId, event)
    this.handleNotification(sessionId, event)
    this.handleAutoSkillReview(sessionId, event)
    this.workflow.handleEvent(sessionId, event, identity)
    void this.modelCrossValidation.handleEvent(sessionId, event, identity).catch((error) => {
      console.error('[caogen] model cross-validation runtime failed:', error)
    })
    this.handleTaskSnapshot(sessionId, event, identity)
    if (event.kind === 'init' || event.kind === 'turn-result' || event.kind === 'meta') {
      this.persist(sessionId)
    }
    if (!this.preservingSnapshotsOnDispose && shouldPersistActiveRegistry(event)) {
      this.persistActiveSessions()
    }
    if (event.kind === 'init' && !this.retainedSessionCreationJournals.has(sessionId)) {
      this.acknowledgeSessionCreation(sessionId)
    }
    if (shouldResumeDagFinalization(event)) {
      void this.dagFinalizationCoordinator.resumeForParent(sessionId).catch((error) => {
        console.error('[caogen] resume DAG finalization after parent event failed:', error)
      })
    }
  }

  private dispatchChildResult(sessionId: string, session: Engine | undefined, event: AgentEvent): void {
    if (!shouldDispatchChildResult(session?.meta, event, (id) => this.sessions.has(id))) return
    const childSession = session!
    const parentSessionId = childSession.meta.parentSessionId!
    const childResult: AgentEvent = {
      kind: 'subagent-result',
      orchestrationId: childSession.meta.orchestrationId,
      childTaskId: childSession.meta.childTaskId,
      childSessionId: sessionId,
      childRole: childSession.meta.childRole,
      status: event.isError ? 'error' : 'done',
      resultText: event.resultText,
      costUsd: event.costUsd,
      durationMs: event.durationMs
    }
    const parent = this.sessions.get(parentSessionId)
    if (parent?.emitSyntheticEvent) parent.emitSyntheticEvent(childResult)
    else this.dispatch(parentSessionId, childResult, 0)
    this.recordOrchestrationResult(childSession.meta, event)
    const dag = childSession.meta.orchestrationId
      ? this.dagSchedulers.get(childSession.meta.orchestrationId)
      : undefined
    if (!dag?.hasSession(sessionId)) return
    void dag.completeSession(sessionId, {
      ok: !event.isError,
      resultText: event.resultText,
      error: event.isError ? event.resultText ?? event.subtype : undefined
    }).catch((error) => {
      console.error('[caogen] DAG child completion scheduling failed:', error)
    })
  }

  private normalizeEventIdentity(
    sessionId: string,
    sourceSeq: number,
    source?: AgentEventIdentity
  ): AgentEventIdentity | null {
    const eventId = source?.eventId?.trim() || randomUUID()
    const recent = this.recentEventIds.get(sessionId) ?? []
    if (recent.includes(eventId)) return null
    const state = this.snapshotCounts.get(sessionId) ?? {
      total: 0,
      sinceSave: 0,
      lastSeq: 0
    }
    const candidate = Number.isInteger(source?.seq) && (source?.seq ?? 0) > 0
      ? source!.seq
      : Number.isInteger(sourceSeq) && sourceSeq > 0
        ? sourceSeq
        : state.lastSeq + 1
    const normalizedSeq = candidate > state.lastSeq ? candidate : state.lastSeq + 1
    const identity: AgentEventIdentity = {
      schemaVersion: 1,
      streamId: source?.streamId?.trim() || `session:${sessionId}`,
      eventId,
      seq: normalizedSeq,
      occurredAt: source?.occurredAt ?? Date.now(),
      ...(source?.causationId ? { causationId: source.causationId } : {}),
      ...(source?.correlationId ? { correlationId: source.correlationId } : {})
    }
    recent.push(eventId)
    this.recentEventIds.set(sessionId, recent.slice(-256))
    this.snapshotCounts.set(sessionId, {
      ...state,
      lastSeq: normalizedSeq,
      lastEventId: eventId
    })
    return identity
  }

  private handleAutoSkillReview(sessionId: string, event: AgentEvent): void {
    if (event.kind !== 'turn-result' || event.isError) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.meta.parentSessionId || session.meta.childRole) return
    scheduleAutoSkillReview(
      {
        meta: { ...session.meta },
        transcript: session.getTranscript(),
        event
      },
      { enabled: getSettings().autoSkillLearningEnabled }
    )
  }

  private handleEnginePowerBlocker(sessionId: string, event: AgentEvent): void {
    if (event.kind !== 'status') return
    const engine = this.sessions.get(sessionId)?.meta.engine
    if (!engine || engine === 'claude') return
    if (event.status === 'running') {
      this.startEnginePowerBlocker(sessionId)
    } else if (event.status === 'idle' || event.status === 'error' || event.status === 'closed') {
      this.stopEnginePowerBlocker(sessionId)
    }
  }

  private startEnginePowerBlocker(sessionId: string): void {
    if (this.enginePowerBlockers.has(sessionId)) return
    if (!getSettings().preventDisplaySleep) return
    try {
      const blockerId = powerSaveBlocker.start('prevent-display-sleep')
      this.enginePowerBlockers.set(sessionId, blockerId)
    } catch (err) {
      console.error('[caogen] 启动非 Claude 引擎防休眠失败:', err)
    }
  }

  private stopEnginePowerBlocker(sessionId: string): void {
    const blockerId = this.enginePowerBlockers.get(sessionId)
    if (blockerId === undefined) return
    this.enginePowerBlockers.delete(sessionId)
    try {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    } catch (err) {
      console.error('[caogen] 释放非 Claude 引擎防休眠失败:', err)
    }
  }

  private handleTaskSnapshot(
    sessionId: string,
    event: AgentEvent,
    identity: AgentEventIdentity
  ): void {
    if (shouldCleanupTaskSnapshot(
      event,
      this.taskRuns.get(sessionId),
      this.effectRecoveryPreservedSessions.has(sessionId),
      this.dagFinalizationCoordinator.hasIncomplete(sessionId)
    )) {
      if (!this.preservingSnapshotsOnDispose) {
        this.snapshotCounts.delete(sessionId)
        if (event.kind === 'status' && event.status === 'closed') {
          this.recentEventIds.delete(sessionId)
        }
        void this.persistBindAndDeleteActiveTaskSnapshot(
          sessionId,
          'important-event',
          identity.seq,
          event.kind,
          identity.eventId
        ).catch((error) => {
          console.error('[caogen] terminal TaskRun persistence/binding failed:', error)
        })
      }
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    const state = this.snapshotCounts.get(sessionId) ?? { total: 0, sinceSave: 0, lastSeq: 0 }
    if (isTaskSnapshotCountedEvent(event)) {
      state.total += 1
      state.sinceSave += 1
      state.lastSeq = Math.max(state.lastSeq, identity.seq)
      state.lastEventId = identity.eventId
    }
    const reason = taskSnapshotReason(event, state.sinceSave)
    if (reason) {
      this.snapshotCounts.set(sessionId, { ...state, sinceSave: 0 })
      void this.writeTaskSnapshot(sessionId, reason, identity.seq, event.kind, identity.eventId)
      return
    }
    this.snapshotCounts.set(sessionId, state)
  }

  private async writeTaskSnapshot(
    sessionId: string,
    reason: TaskSnapshotReason,
    seq: number,
    eventKind?: AgentEvent['kind'],
    eventId?: string,
    strict = false
  ): Promise<void> {
    const persist = this.workflow.captureSnapshot(sessionId, reason, seq, eventKind, eventId, strict)
    await this.workflow.flush(sessionId)
    try {
      await persist()
    } catch (err) {
      if (strict) throw err
      console.error('[caogen] 写入任务快照失败:', err)
    }
  }

  private async persistBindAndDeleteActiveTaskSnapshot(
    sessionId: string,
    reason: TaskSnapshotReason,
    seq: number,
    eventKind?: AgentEvent['kind'],
    eventId?: string
  ): Promise<void> {
    await this.writeTaskSnapshot(sessionId, reason, seq, eventKind, eventId, true)
    await deleteTaskSnapshot(sessionId, undefined, this.taskRuns.get(sessionId))
  }

  private snapshotSubtasksFor(sessionId: string): TaskSnapshotSubtaskState[] {
    const subtasks: TaskSnapshotSubtaskState[] = []
    for (const state of this.orchestrations.values()) {
      if (state.parentSessionId !== sessionId) continue
      for (const childSessionId of state.pending) {
        const child = this.sessions.get(childSessionId)?.meta
        subtasks.push({
          taskId: child?.childTaskId,
          role: child?.childRole,
          sessionId: childSessionId,
          status: subtaskStatusFromSession(child?.status),
          branch: child?.branch,
          worktreePath: child?.worktreePath,
          costUsd: child?.costUsd
        })
      }
      for (const result of state.results) {
        subtasks.push({
          taskId: result.taskId,
          role: result.role,
          sessionId: result.sessionId,
          status: result.ok ? 'success' : 'failed',
          resultText: result.resultText,
          costUsd: result.costUsd,
          branch: result.branch,
          worktreePath: result.worktreePath
        })
      }
    }
    for (const execution of this.snapshotDagExecutionsFor(sessionId)) {
      if (execution.parentSessionId !== sessionId) continue
      for (const task of execution.tasks) {
        subtasks.push({
          taskId: task.task.id,
          role: task.task.role,
          sessionId: task.sessionIds[task.sessionIds.length - 1] ?? `${execution.id}:${task.task.id}`,
          status: subtaskStatusFromDag(task.status),
          resultText: task.resultText,
          branch: undefined,
          worktreePath: undefined
        })
      }
    }
    return subtasks
  }

  private snapshotDagExecutionsFor(sessionId: string): TaskDagExecutionView[] {
    const executions = new Map<string, TaskDagExecutionView>()
    for (const scheduler of this.dagSchedulers.values()) {
      const execution = scheduler.view()
      executions.set(execution.id, execution)
    }
    for (const execution of this.dagExecutionSnapshots.values()) {
      executions.set(execution.id, execution)
    }
    return [...executions.values()].filter(
      (execution) =>
        execution.parentSessionId === sessionId ||
        execution.tasks.some((task) => task.sessionIds.includes(sessionId))
    )
  }

  private snapshotDagRuntimesFor(sessionId: string): TaskDagRuntimeSnapshot[] {
    const runtimes: TaskDagRuntimeSnapshot[] = []
    for (const [executionId, scheduler] of this.dagSchedulers.entries()) {
      const execution = scheduler.view()
      if (
        execution.parentSessionId !== sessionId &&
        !execution.tasks.some((task) => task.sessionIds.includes(sessionId))
      ) {
        continue
      }
      runtimes.push(
        scheduler.runtimeSnapshot({
          autoMerge: this.dagAutoMergeOptions.get(executionId),
          mergeSessions: this.snapshotDagMergeSessionsFor(execution)
        })
      )
    }
    return runtimes
  }

  private snapshotDagMergeSessionsFor(execution: TaskDagExecutionView): TaskDagRuntimeMergeSession[] {
    const fallback = new Map(
      (this.dagRuntimeMergeSessions.get(execution.id) ?? []).map((session) => [session.sessionId, session])
    )
    const sessions: TaskDagRuntimeMergeSession[] = []
    for (const task of execution.tasks) {
      for (const sessionId of task.sessionIds) {
        const meta = this.sessions.get(sessionId)?.meta
        if (meta) {
          sessions.push({
            sessionId,
            taskId: task.task.id,
            repoRoot: meta.repoRoot,
            worktreePath: meta.worktreePath,
            baseSha: meta.baseSha,
            branch: meta.branch,
            resultText: task.resultText
          })
          continue
        }
        const restored = fallback.get(sessionId)
        if (restored) {
          sessions.push({
            ...restored,
            taskId: restored.taskId ?? task.task.id,
            resultText: task.resultText ?? restored.resultText
          })
        }
      }
    }
    return sessions
  }

  private budgetError(session: Engine): string | null {
    const budget = effectiveBudgetUsd(session.meta)
    const monthlyBudget = calculateMonthlyBudgetSnapshot({
      settings: getSettings(),
      history: listHistory(),
      currentSession: session.meta
    })
    if (budget <= 0 && monthlyBudget.limitUsd <= 0) return null
    if (!canTrackCost(session.meta)) {
      return '当前引擎不提供费用回传,无法保证预算闸门;请关闭预算或切换到支持费用统计的引擎后继续。'
    }
    if (monthlyBudget.exceeded) {
      return `已达本月预算上限 $${monthlyBudget.limitUsd.toFixed(2)} (${monthlyBudget.monthKey}),请调高月度预算后继续`
    }
    if (budget > 0 && session.meta.costUsd >= budget) {
      return `已达预算上限 $${budget.toFixed(2)},请调高预算后继续`
    }
    return null
  }

  private normalizeTurnResultCost(session: Engine, event: AgentEvent): AgentEvent {
    if (event.kind !== 'turn-result') return event
    const reportedCost = normalizePositiveNumber(event.costUsd)
    const estimatedCost = reportedCost === undefined ? estimateTurnCostUsd(session.meta, event) : undefined
    const turnCost = reportedCost ?? estimatedCost
    if (turnCost === undefined) return event

    const current = normalizePositiveNumber(session.meta.costUsd) ?? 0
    const nextCost = reportedCost !== undefined && reportedCost >= current ? reportedCost : current + turnCost
    session.meta.costUsd = nextCost
    return { ...event, costUsd: nextCost }
  }

  private notificationState(sessionId: string): SessionNotificationState {
    let state = this.notificationStates.get(sessionId)
    if (!state) {
      state = {
        turnActive: false,
        permissionNotified: false,
        terminalNotified: false
      }
      this.notificationStates.set(sessionId, state)
    }
    return state
  }

  private sessionNotificationLabel(meta: SessionMeta | undefined): string {
    if (!meta) return '未知会话'
    if (meta.title && meta.title !== '新会话') return trimForNotification(meta.title, 80)
    return trimForNotification(meta.cwd, 100)
  }

  private notify(sessionId: string, title: string, body: string): void {
    // 读取当前设置(而非缓存),用户随时可关闭桌面通知
    if (!getSettings().notificationsEnabled) return
    showDesktopNotification({ title, body, sessionId })
  }

  private handleNotification(sessionId: string, event: AgentEvent): void {
    if (!this.sessions.has(sessionId) && !this.notificationStates.has(sessionId)) return
    const state = this.notificationState(sessionId)
    const meta = this.sessions.get(sessionId)?.meta
    const label = this.sessionNotificationLabel(meta)

    if (event.kind === 'user-message') {
      state.turnActive = true
      state.permissionNotified = false
      state.terminalNotified = false
      return
    }

    if (event.kind === 'status') {
      if (event.status === 'running' && !state.turnActive) {
        state.turnActive = true
        state.permissionNotified = false
        state.terminalNotified = false
      } else if (event.status === 'error') {
        if (!state.terminalNotified) {
          const error = event.error || meta?.lastError || '未知错误'
          this.notify(sessionId, 'CaoGen: 任务失败', `${label} · ${trimForNotification(error)}`)
          state.terminalNotified = true
        }
        state.turnActive = false
      } else if (event.status === 'idle' || event.status === 'closed') {
        state.turnActive = false
        if (event.status === 'closed') this.notificationStates.delete(sessionId)
      }
      return
    }

    if (event.kind === 'permission-request') {
      if (!state.permissionNotified) {
        const tool = trimForNotification(event.request.toolName, 60)
        this.notify(sessionId, 'CaoGen: 等待权限', `${label} · ${tool}`)
        state.permissionNotified = true
      }
      return
    }

    if (event.kind === 'turn-result') {
      if (!state.terminalNotified) {
        const bits = [label]
        const duration = formatDuration(event.durationMs)
        if (duration) bits.push(duration)
        if (typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)) {
          bits.push(`$${event.costUsd.toFixed(4)}`)
        }
        if (event.isError && event.resultText) {
          bits.push(trimForNotification(event.resultText))
        }
        this.notify(sessionId, event.isError ? 'CaoGen: 任务失败' : 'CaoGen: 任务完成', bits.join(' · '))
        state.terminalNotified = true
      }
      state.turnActive = false
    }
  }

  private persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const meta = session.meta
    if (!meta.sdkSessionId) return
    upsertHistory({
      id: meta.id,
      title: meta.title,
      cwd: meta.cwd,
      driveMode: meta.driveMode,
      parentSessionId: meta.parentSessionId,
      orchestrationId: meta.orchestrationId,
      childTaskId: meta.childTaskId,
      childRole: meta.childRole,
      isolated: meta.isolated,
      sourceCwd: meta.sourceCwd,
      projectId: meta.projectId,
      workspaceId: meta.workspaceId,
      goalId: meta.goalId,
      workItemId: meta.workItemId, digitalWorkerBinding: meta.digitalWorkerBinding,
      unassigned: meta.unassigned,
      repoRoot: meta.repoRoot,
      worktreePath: meta.worktreePath,
      branch: meta.branch,
      baseBranch: meta.baseBranch,
      baseSha: meta.baseSha,
      worktreeState: meta.worktreeState,
      model: meta.model,
      providerId: meta.providerId,
      routingScope: meta.routingScope,
      engine: meta.engine,
      permissionMode: meta.permissionMode,
      sdkSessionId: meta.sdkSessionId,
      createdAt: meta.createdAt,
      updatedAt: Date.now(),
      costUsd: meta.costUsd,
      resumeSessionAt: meta.resumeSessionAt
    })
  }

  private restoreActiveSessions(snapshotSessionIds: ReadonlySet<string> = new Set()): void {
    const changed = restoreActiveSessionRegistry(
      snapshotSessionIds,
      this.sessions,
      this.snapshotCounts,
      (sessionId, event, seq, identity) => this.dispatch(sessionId, event, seq, identity)
    )
    if (changed) this.persistActiveSessions()
  }

  private persistActiveSessions(strict = false): void {
    const active = [...this.sessions.values()]
      .map((session) => session.meta)
      .filter((meta) => meta.status !== 'closed' && (strict || Boolean(meta.sdkSessionId)))
      .map((meta) => ({ ...meta }))
    writeActiveSessionRegistry(active, strict)
  }

  private emitToSubscribers(payload: SessionEventPayload): void {
    for (const listener of this.sessionEventListeners) {
      try {
        listener(payload)
      } catch (error) {
        console.error('[caogen] session event subscriber failed:', error)
      }
    }
  }
}

export const sessionManager = new SessionManager()
