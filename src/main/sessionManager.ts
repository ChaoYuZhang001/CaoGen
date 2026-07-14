import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { newSessionMeta } from './agentSession'
import { createEngine } from './engine'
import type { Engine } from './engine'
import { registerBuiltinEngines } from './engines'
import { fixPathForGuiLaunch } from './pathFix'
import { configureModelStatsDir } from './modelStats'
import { configureProviderHealthDir } from './providerHealth'
import { upsertHistory, listHistory } from './history'
import { getSettings } from './settings'
import { decryptProviderToken, getProvider, listProviders, resolveProviderEngine } from './providers'
import { calculateMonthlyBudgetSnapshot } from './model/monthly-budget'
import {
  getCaoGenDrivePolicy,
  settingsForCaoGenDrive
} from './model/drive'
import { resolveSessionModelRoute } from './model/session-routing'
import { cleanupTranscripts, restoreTranscriptIfMissing } from './transcript'
import { getProject, touchProject } from './projects'
import { prepareWorktree } from './worktrees'
import { showDesktopNotification } from './desktopNotify'
import { scheduleAutoSkillReview } from './skill/auto-skill-review'
import { clearIdeDocumentContext } from './ide/ide-document-context'
import {
  buildTaskSnapshot,
  deleteTaskSnapshot,
  getTaskSnapshot,
  listTaskRuns as listPersistedTaskRuns,
  listTaskSnapshots,
  saveTaskSnapshot,
  supersedeToolExecution,
  flushTaskSnapshotMutations,
  TASK_SNAPSHOT_EVENT_INTERVAL
} from './task/task-snapshot'
import {
  createTaskRun,
  hasTaskRunAppliedEvent,
  isTaskRunTerminal,
  recordTaskRunEvent,
  reduceTaskRunEvent,
  transitionTaskRun
} from './task/task-run'
import {
  hasPendingTaskSteps,
  recoverTaskExecutionState,
  reduceTaskExecutionEvent
} from './task/task-execution'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import { isTaskLedgerEvent, reconcileSnapshotWithReceipts } from './task/task-recovery'
import {
  reconcilePersistedTaskSnapshot,
  resolvePersistedTaskEffect,
  runHasUnresolvedEffects,
  runHasWaitingEffects
} from './task/effect-runtime'
import { decomposeTask } from './agent/task-decomposer'
import { createModelDagDecomposer } from './agent/model-dag-decomposer'
import { buildDagTaskPrompt, TaskDagScheduler, type TaskDagSchedulerCallbacks } from './agent/dag-scheduler'
import { runTaskDagAutoMerge, type TaskDagAutoMergeSession } from './git/auto-merger'
import {
  arbitrationCrossValidationTarget,
  buildCrossValidationArbitrationPrompt,
  buildCrossValidationReviewPrompt,
  firstCrossValidationTarget,
  needsCrossValidationArbitration
} from './model/cross-validation'
import type {
  AgentEvent,
  AgentEventIdentity,
  CreateSessionOptions,
  DispatchSubagentsInput,
  ModelRoutePlanView,
  SubagentDispatchResult,
  TaskDagDispatchInput,
  TaskDagDispatchResult,
  TaskDagExecutionView,
  TaskDagRuntimeMergeSession,
  TaskDagRuntimeSnapshot,
  TaskDecomposeInput,
  TaskDecomposeResult,
  SessionEventPayload,
  SessionMeta,
  SdkAgentInfo,
  SendMessagePayload,
  TaskDagAutoMergeView,
  TaskSnapshotRecord,
  TaskSnapshotReason,
  TaskSnapshotSubtaskState,
  TranscriptEntry
} from '../shared/types'
import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../shared/types'

interface SessionNotificationState {
  turnActive: boolean
  permissionNotified: boolean
  terminalNotified: boolean
}

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

function cleanOneLine(text: string, fallback: string, max = 80): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return (clean || fallback).slice(0, max)
}

async function mapWithConcurrencyInOrder<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex++
        if (index >= items.length) return
        results[index] = await task(items[index], index)
      }
    }
  )
  await Promise.all(workers)
  return results
}

function normalizeTaskId(value: string | undefined, fallback: string): string {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (!clean) return fallback
  return clean.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80) || fallback
}

interface OrchestrationState {
  parentSessionId: string
  /** dispatchSubagents 仍在创建 child 时不触发最终汇总,避免极快 child 让编排过早收口。 */
  acceptingChildren: boolean
  /** 尚未完成首轮的 child session id */
  pending: Set<string>
  /** 已完成 child 的结果(按完成顺序) */
  results: Array<{
    taskId?: string
    role?: string
    sessionId: string
    ok: boolean
    resultText?: string
    costUsd?: number
    branch?: string
    worktreePath?: string
  }>
  startedAt: number
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
  private readonly recentEventIds = new Map<string, string[]>()
  /** 非 Claude 引擎由 SessionManager 统一托管防休眠;Claude AgentSession 内部已有同等保护。 */
  private readonly enginePowerBlockers = new Map<string, number>()
  /** P2-003 路由事件生成的复核计划，等待本轮 turn-result 成功后执行。 */
  private readonly routePlans = new Map<string, ModelRoutePlanView>()
  /** 防止同一轮 turn-result 重复派发第二模型复核。 */
  private readonly crossValidationStarted = new Set<string>()
  /** 记录复核 child 与主输出的关联，用于复核分歧时自动仲裁。 */
  private readonly crossValidationReviews = new Map<string, {
    parentSessionId: string
    parentMeta: SessionMeta
    routePlan: ModelRoutePlanView
    primaryResultText: string
    transcript: TranscriptEntry[]
    turnSeq: number
  }>()
  private preservingSnapshotsOnDispose = false
  private readonly effectRecoveryPreservedSessions = new Set<string>()
  private readonly closingSessions = new Map<string, Promise<void>>()

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

  create(opts: CreateSessionOptions): SessionMeta {
    opts = { ...opts, cwd: assertUsableSessionCwd(opts.cwd) }
    const settings = getSettings()
    const resumeHistory = opts.resumeSdkSessionId
      ? listHistory().find((entry) => entry.sdkSessionId === opts.resumeSdkSessionId)
      : undefined
    const parentMeta = opts.parentSessionId ? this.sessions.get(opts.parentSessionId)?.meta : undefined
    const driveMode = opts.driveMode ?? resumeHistory?.driveMode ?? settings.driveMode
    const drivePolicy = getCaoGenDrivePolicy(driveMode)
    const routingScope =
      opts.routingScope ??
      resumeHistory?.routingScope ??
      parentMeta?.routingScope ??
      (opts.model === AUTO_MODEL ? 'provider' : 'fixed')
    let selectedProviderId = opts.providerId ?? ''
    const selectedModel = opts.model ?? ''
    if (selectedProviderId === AUTO_PROVIDER_ID) {
      const routeSettings = settingsForCaoGenDrive(settings, driveMode)
      const initialRoute = resolveSessionModelRoute({
        enabled: true,
        currentModel: AUTO_MODEL,
        providerId: '',
        providers: listProviders(),
        allowAnyEngine: true,
        driveMode,
        payload: { text: opts.initialPrompt?.trim() || opts.title?.trim() || '通用任务' },
        strategy: routeSettings.schedulerStrategy,
        sessionCostUsd: 0,
        settingsBudgetUsd: routeSettings.budgetUsdPerSession,
        fallbackProviderId: routeSettings.fallbackProviderId,
        fallbackModel: routeSettings.fallbackModel,
        lowCostProviderId: routeSettings.lowCostProviderId,
        lowCostModel: routeSettings.lowCostModel,
        strongReasoningProviderId: routeSettings.strongReasoningProviderId,
        strongReasoningModel: routeSettings.strongReasoningModel,
        reviewProviderId: routeSettings.reviewProviderId,
        reviewModel: routeSettings.reviewModel,
        researchProviderId: routeSettings.researchProviderId,
        researchModel: routeSettings.researchModel,
        planningProviderId: routeSettings.planningProviderId,
        planningModel: routeSettings.planningModel,
        codingProviderId: routeSettings.codingProviderId,
        codingModel: routeSettings.codingModel,
        testingProviderId: routeSettings.testingProviderId,
        testingModel: routeSettings.testingModel,
        documentationProviderId: routeSettings.documentationProviderId,
        documentationModel: routeSettings.documentationModel,
        modelRoutingRules: routeSettings.modelRoutingRules,
        projectPath: opts.cwd
      })
      if (initialRoute.kind !== 'routed') throw new Error('没有可用的跨厂商调度候选')
      selectedProviderId = initialRoute.providerId
    }
    const provider = this.assertExplicitSessionChoice(selectedProviderId, selectedModel)
    const selectedEngine = resolveProviderEngine(provider)
    const unassigned = opts.unassigned ?? resumeHistory?.unassigned ?? parentMeta?.unassigned ?? false
    let projectId = opts.projectId ?? resumeHistory?.projectId ?? parentMeta?.projectId
    if (projectId && !getProject(projectId)) throw new Error('关联项目不存在，请重新选择项目')
    if (!projectId && !unassigned) projectId = touchProject(opts.cwd).id
    const resumeSessionAt = opts.resumeSessionAt ?? resumeHistory?.resumeSessionAt
    const budgetUsd = normalizePositiveNumber(opts.budgetUsd)
    const permissionMode = opts.permissionMode ?? drivePolicy.defaultPermissionMode
    const baseMeta = newSessionMeta({
      cwd: opts.cwd,
      driveMode,
      parentSessionId: opts.parentSessionId,
      orchestrationId: opts.orchestrationId,
      childTaskId: opts.childTaskId,
      childRole: opts.childRole,
      projectId,
      unassigned,
      model: selectedModel,
      providerId: selectedProviderId,
      routingScope,
      budgetUsd,
      resumeSessionAt,
      engine: selectedEngine,
      permissionMode,
      title: opts.title
    })
    const worktree =
      opts.resumeSdkSessionId !== undefined
        ? { ok: true as const, isolated: false, cwd: opts.cwd }
        : prepareWorktree({ sessionId: baseMeta.id, cwd: opts.cwd, isolated: opts.isolated })
    if (!worktree.ok) throw new Error(worktree.error)
    const meta = newSessionMeta({
      cwd: worktree.cwd,
      driveMode,
      parentSessionId: opts.parentSessionId,
      orchestrationId: opts.orchestrationId,
      childTaskId: opts.childTaskId,
      childRole: opts.childRole,
      isolated: worktree.isolated,
      sourceCwd: worktree.record?.sourceCwd,
      projectId,
      unassigned,
      repoRoot: worktree.record?.repoRoot,
      worktreePath: worktree.record?.worktreePath,
      branch: worktree.record?.branch,
      baseBranch: worktree.record?.baseBranch,
      baseSha: worktree.record?.baseSha,
      worktreeState: worktree.record?.state,
      model: selectedModel,
      providerId: selectedProviderId,
      routingScope,
      budgetUsd,
      resumeSessionAt,
      engine: selectedEngine,
      permissionMode,
      title: opts.title
    })
    meta.id = baseMeta.id
    const session = createEngine(
      selectedEngine,
      meta,
      (event, seq, identity) => this.dispatch(meta.id, event, seq, identity),
      opts.resumeSdkSessionId
    )
    this.sessions.set(meta.id, session)
    void this.writeTaskSnapshot(meta.id, 'created', 0)
    void session.start()
    return { ...meta }
  }

  private assertExplicitSessionChoice(
    providerIdInput: string,
    model: string
  ): NonNullable<ReturnType<typeof getProvider>> {
    if (!model) throw new Error('请选择模型或显式选择自动调度')

    const providerId = providerIdInput.trim()
    if (!providerId) throw new Error('请选择已配置 API key 的 Provider')
    const provider = getProvider(providerId)
    if (!provider) throw new Error(`Provider 不存在:${providerId}`)
    if (!decryptProviderToken(provider)) {
      throw new Error(`请先在设置里为 ${provider.name} 填写 API key`)
    }
    return provider
  }

  send(id: string, input: string | SendMessagePayload): void {
    const session = this.sessions.get(id)
    if (!session) return
    const currentRun = this.taskRuns.get(id)
    if (runHasUnresolvedEffects(currentRun)) {
      session.rejectSend('当前任务存在尚未完成真实状态对账的外部副作用，已阻止继续发送；请先完成效果对账。')
      return
    }
    const budgetError = this.budgetError(session)
    if (budgetError) {
      session.rejectSend(budgetError)
      return
    }
    if (!currentRun || isTaskRunTerminal(currentRun.status)) {
      this.taskRuns.set(
        id,
        createTaskRun({
          sessionId: id,
          taskId: session.meta.childTaskId ?? id
        })
      )
    }
    session.send(input)
  }

  async interrupt(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.effectRecoveryPreservedSessions.add(id)
    try {
      await session.interrupt()
      const run = this.taskRuns.get(id)
      const preserveEffectRecovery = runHasUnresolvedEffects(run)
      if (preserveEffectRecovery) {
        // 未知外部效果不能留在 active 会话里，否则恢复面板会过滤它且会话还能继续发工具。
        // 统一走 close 屏障：终止底层执行器、持久化 waiting_reconciliation、移出 active。
        await this.close(id)
        return
      }
      if (run && !isTaskRunTerminal(run.status)) {
        this.taskRuns.set(id, transitionTaskRun(run, 'cancelled', { lastEventKind: 'turn-result' }))
        this.snapshotCounts.delete(id)
        await deleteTaskSnapshot(id, undefined, this.taskRuns.get(id))
      } else {
        this.snapshotCounts.delete(id)
        await deleteTaskSnapshot(id, undefined, run)
      }
    } finally {
      this.effectRecoveryPreservedSessions.delete(id)
    }
  }

  dispatchSubagents(parentSessionId: string, input: DispatchSubagentsInput): SubagentDispatchResult {
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

    for (const { task, taskId, prompt, role, title } of plannedTasks) {
      const meta = this.create({
        cwd: task.cwd ?? input.cwd ?? parent.meta.sourceCwd ?? parent.meta.cwd,
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
      this.send(meta.id, prompt)
    }
    state.acceptingChildren = false
    this.completeOrchestrationIfReady(orchestrationId, state)

    return { orchestrationId, parentSessionId, children }
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
    return decomposeTask(request, { modelDecomposer: createModelDagDecomposer(request) })
  }

  dispatchTaskDag(parentSessionId: string, input: TaskDagDispatchInput): TaskDagDispatchResult {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    const children: SubagentDispatchResult['children'] = []
    const scheduler = new TaskDagScheduler(parentSessionId, input, {
      runTask: (task, context) => {
        const prompt = buildDagTaskPrompt(task, context)
        const meta = this.create({
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
        })
        this.send(meta.id, prompt)
        const item = { taskId: task.id, prompt, meta }
        children.push(item)
        return { sessionId: meta.id, dispatchItem: item }
      },
      onUpdate: (execution) => this.emitTaskDagUpdate(parentSessionId, execution),
      onComplete: (execution) => this.finishTaskDag(parentSessionId, execution),
      onTaskTimeout: (sessionId, taskId, error) => this.handleDagTaskTimeout(parentSessionId, sessionId, taskId, error)
    })
    this.dagExecutionSnapshots.delete(input.dag.id)
    this.dagSchedulers.set(input.dag.id, scheduler)
    this.dagAutoMergeOptions.set(input.dag.id, {
      enabled: input.autoMerge === true,
      verificationCommand: input.verificationCommand
    })
    const launched = scheduler.start()
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
      runTask: (task, context) => {
        const parent = this.sessions.get(parentSessionId)
        if (!parent) throw new Error('Parent session no longer exists for recovered DAG')
        const prompt = buildDagTaskPrompt(task, context)
        const meta = this.create({
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
        })
        this.send(meta.id, prompt)
        const item = { taskId: task.id, prompt, meta }
        children?.push(item)
        return { sessionId: meta.id, dispatchItem: item }
      },
      onUpdate: (execution) => this.emitTaskDagUpdate(parentSessionId, execution),
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

  private finishTaskDag(parentSessionId: string, execution: TaskDagExecutionView): void {
    this.dagSchedulers.delete(execution.id)
    const parent = this.sessions.get(parentSessionId)
    if (!parent || parent.meta.status === 'closed') {
      this.dagAutoMergeOptions.delete(execution.id)
      this.dagRuntimeMergeSessions.delete(execution.id)
      return
    }
    const finalExecution = this.applyDagAutoMerge(parentSessionId, execution)
    this.dagRuntimeMergeSessions.delete(execution.id)
    const lines = [
      `[DAG 编排完成] ${finalExecution.summary ?? finalExecution.status}`,
      '',
      `需求: ${finalExecution.dag.source}`,
      '',
      ...finalExecution.tasks.map((task) =>
        [
          `## ${task.task.id}(${task.task.role}) — ${task.status}`,
          `尝试次数: ${task.attempts}`,
          task.sessionIds.length > 0 ? `子会话: ${task.sessionIds.join(', ')}` : '',
          task.error ? `错误: ${task.error}` : '',
          task.resultText ? `结果摘要:\n${task.resultText.slice(0, 1500)}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      ),
      ...this.dagAutoMergeLines(finalExecution.autoMerge),
      '',
      '请接管 DAG 汇总:确认成功项、处理失败项,并给出下一步合并/验证顺序。'
    ]
    this.send(parentSessionId, lines.join('\n\n'))
  }

  private applyDagAutoMerge(parentSessionId: string, execution: TaskDagExecutionView): TaskDagExecutionView {
    const options = this.dagAutoMergeOptions.get(execution.id)
    this.dagAutoMergeOptions.delete(execution.id)
    if (!options?.enabled) return execution
    const autoMerge =
      execution.status === 'success'
        ? runTaskDagAutoMerge({
            execution,
            sessions: this.collectDagAutoMergeSessions(execution),
            verificationCommand: options.verificationCommand
          })
        : this.skippedDagAutoMerge('DAG 存在失败任务,自动合并已跳过。')
    const next = { ...execution, autoMerge }
    this.emitTaskDagUpdate(parentSessionId, next)
    return next
  }

  private collectDagAutoMergeSessions(execution: TaskDagExecutionView): TaskDagAutoMergeSession[] {
    const fallback = new Map(
      (this.dagRuntimeMergeSessions.get(execution.id) ?? []).map((session) => [session.sessionId, session])
    )
    return execution.tasks.flatMap((task) =>
      task.sessionIds
        .map((sessionId): TaskDagAutoMergeSession | null => {
          const meta = this.sessions.get(sessionId)?.meta
          if (meta) {
            return {
              sessionId,
              taskId: task.task.id,
              repoRoot: meta.repoRoot,
              worktreePath: meta.worktreePath,
              baseSha: meta.baseSha,
              branch: meta.branch,
              resultText: task.resultText
            }
          }
          const restored = fallback.get(sessionId)
          if (!restored) return null
          return {
            ...restored,
            taskId: restored.taskId ?? task.task.id,
            resultText: task.resultText ?? restored.resultText
          }
        })
        .filter((session): session is TaskDagAutoMergeSession => session !== null)
    )
  }

  private skippedDagAutoMerge(error: string): TaskDagAutoMergeView {
    const now = Date.now()
    return {
      enabled: true,
      status: 'failed',
      startedAt: now,
      completedAt: now,
      entries: [],
      mergedCount: 0,
      blockedCount: 0,
      skippedCount: 0,
      verification: { status: 'not-run', error },
      summary: error,
      error
    }
  }

  private dagAutoMergeLines(autoMerge: TaskDagAutoMergeView | undefined): string[] {
    if (!autoMerge) return []
    return [
      '',
      '## DAG 自动合并',
      autoMerge.summary ?? autoMerge.status,
      autoMerge.verification?.command ? `验收命令: ${autoMerge.verification.command}` : '',
      autoMerge.error ? `错误: ${autoMerge.error}` : ''
    ].filter(Boolean)
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
    let run = this.taskRuns.get(id)
    const preserveEffectRecovery = runHasUnresolvedEffects(run)
    if (run && !isTaskRunTerminal(run.status)) {
      if (preserveEffectRecovery) {
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
      dag.completeSession(id, {
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
    this.stopEnginePowerBlocker(id)
    this.sessions.delete(id)
    this.snapshotCounts.delete(id)
    this.recentEventIds.delete(id)
    this.persistActiveSessions()
    this.notificationStates.delete(id)
    clearIdeDocumentContext(id)
    if (!preserveEffectRecovery) {
      await deleteTaskSnapshot(id, undefined, this.taskRuns.get(id))
      this.taskRuns.delete(id)
    }
  }

  updateWorktreeState(id: string, state: SessionMeta['worktreeState']): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.meta.worktreeState = state
    this.persist(id)
  }

  async disposeAll(): Promise<void> {
    this.persistActiveSessions()
    // dispose 后 provider 仍可能异步发出尾事件。关机期间保持保护，避免晚到的
    // turn-result/status 把刚写好的恢复快照删掉。
    this.preservingSnapshotsOnDispose = true
    const pendingWrites: Array<Promise<void>> = []
    const pendingDisposals: Array<Promise<void>> = []
    for (const session of this.sessions.values()) {
      pendingWrites.push(this.writeTaskSnapshot(session.meta.id, 'shutdown', 0, 'status'))
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
    await Promise.all(pendingWrites)
    await flushTaskSnapshotMutations()
    this.sessions.clear()
    this.notificationStates.clear()
    this.taskRuns.clear()
    this.recentEventIds.clear()
  }

  getTranscript(id: string): TranscriptEntry[] {
    return this.sessions.get(id)?.getTranscript() ?? []
  }

  async listTaskSnapshots(): Promise<TaskSnapshotRecord[]> {
    const snapshots = await listTaskSnapshots()
    const reconciled = await mapWithConcurrencyInOrder(
      snapshots,
      TASK_SNAPSHOT_RECONCILIATION_CONCURRENCY,
      async (snapshot): Promise<TaskSnapshotRecord | null> => {
        if (this.sessions.has(snapshot.sessionId)) {
          return snapshot
        }
        const reconciled = reconcileSnapshotWithReceipts(snapshot)
        if (reconciled.terminalRun) {
          await deleteTaskSnapshot(snapshot.id, undefined, reconciled.terminalRun)
          return null
        }
        return reconcilePersistedTaskSnapshot(reconciled.snapshot)
      }
    )
    return reconciled.filter((snapshot): snapshot is TaskSnapshotRecord => snapshot !== null)
  }

  async deleteTaskSnapshot(id: string): Promise<boolean> {
    const snapshot = await getTaskSnapshot(id)
    if (runHasUnresolvedEffects(snapshot?.run)) {
      throw new Error('waiting_reconciliation 效果尚未处置，不能删除恢复入口；请先确认已执行或未执行。')
    }
    this.snapshotCounts.delete(id)
    if (!this.sessions.has(id)) this.recentEventIds.delete(id)
    this.taskRuns.delete(id)
    return deleteTaskSnapshot(id)
  }

  async recoverTaskSnapshot(id: string): Promise<SessionMeta> {
    const storedSnapshot = await getTaskSnapshot(id)
    if (!storedSnapshot) throw new Error('未找到可恢复的任务快照')
    const active = this.sessions.get(storedSnapshot.sessionId)
    if (active) return { ...active.meta }
    const reconciled = reconcileSnapshotWithReceipts(storedSnapshot)
    if (reconciled.terminalRun) {
      await deleteTaskSnapshot(storedSnapshot.id, undefined, reconciled.terminalRun)
      throw new Error('任务已完成，恢复入口已自动收敛')
    }
    const snapshot = await reconcilePersistedTaskSnapshot(reconciled.snapshot)
    if (runHasWaitingEffects(snapshot.run)) {
      throw new Error('任务包含 waiting_reconciliation 外部副作用，已阻止自动续跑；请先在恢复面板完成专用对账处置。')
    }
    if (snapshot.run && (snapshot.run.status === 'completed' || snapshot.run.status === 'cancelled')) {
      throw new Error(`任务已处于终态，不能恢复:${snapshot.run.status}`)
    }
    const recoveredRunBase = snapshot.run
      ? transitionTaskRun(snapshot.run, 'recovering', { lastEventKind: snapshot.execution.lastEventKind })
      : transitionTaskRun(
          createTaskRun({
            id: `legacy-${snapshot.sessionId}`,
            sessionId: snapshot.sessionId,
            taskId: snapshot.taskId,
            now: snapshot.createdAt
          }),
          'recovering',
          { now: Date.now(), lastEventKind: snapshot.execution.lastEventKind }
        )
    const recoveredRun = recoverTaskExecutionState(recoveredRunBase)
    const { lastError: _lastError, ...restMeta } = snapshot.meta
    const cwd = assertUsableSessionCwd(restMeta.cwd)
    const meta: SessionMeta = {
      ...restMeta,
      cwd,
      status: 'starting',
      sdkSessionId: snapshot.execution.sdkSessionId,
      resumeSessionAt: snapshot.execution.resumeSessionAt
    }
    if (!meta.unassigned && !meta.projectId) meta.projectId = touchProject(meta.sourceCwd ?? meta.cwd).id
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
    const restoredDagRuntimeCount = this.restoreDagRuntimesFromSnapshot(meta.id, recoveredSnapshot)
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
  ): Promise<TaskSnapshotRecord> {
    return resolvePersistedTaskEffect(snapshotId, effectId, expectedRevision, resolution)
  }

  private startRecoveredSession(
    session: Engine,
    snapshot: TaskSnapshotRecord,
    resumeDagRuntime = false
  ): void {
    void session
      .start()
      .then(() => {
        const replayPrompts = buildTaskSnapshotReplayPrompts(snapshot)
        const active = this.sessions.get(snapshot.sessionId)
        if (active !== session) return
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
          this.resumeRecoveredDagRuntimes(snapshot.sessionId)
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
        for (const prompt of replayPrompts) this.send(snapshot.sessionId, prompt)
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
    const recoverable = await this.listTaskSnapshots()
    this.taskRuns.hydrateHistory(await listPersistedTaskRuns())
    this.restoreActiveSessions(new Set(recoverable.map((snapshot) => snapshot.sessionId)))
    const keep = new Set(listHistory().map((h) => h.sdkSessionId))
    for (const snapshot of recoverable) {
      const sdkSessionId = snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
      if (sdkSessionId) keep.add(sdkSessionId)
    }
    for (const session of this.sessions.values()) {
      if (session.meta.sdkSessionId) keep.add(session.meta.sdkSessionId)
    }
    cleanupTranscripts(keep)
    if (recoverable.length > 0 && getSettings().notificationsEnabled) {
      showDesktopNotification({
        title: 'CaoGen: 检测到未完成任务',
        body: `发现 ${recoverable.length} 个任务快照，可从恢复入口继续。`,
        sessionId: 'task-snapshot'
      })
    }
  }

  private restoreDagRuntimesFromSnapshot(parentSessionId: string, snapshot: TaskSnapshotRecord): number {
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
      if (execution.status === 'success' || execution.status === 'failed') continue

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
        restored += 1
      } catch (err) {
        console.error('[caogen] restore DAG runtime snapshot failed:', err)
      }
    }
    return restored
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

  private resumeRecoveredDagRuntimes(parentSessionId: string): void {
    for (const scheduler of this.dagSchedulers.values()) {
      const execution = scheduler.view()
      if (execution.parentSessionId !== parentSessionId) continue
      if (execution.status === 'success' || execution.status === 'failed') continue
      scheduler.resume()
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
    this.handleTaskRunEvent(sessionId, event, identity)
    const payload: SessionEventPayload = { sessionId, ...identity, event }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session:event', payload)
    }
    this.emitToSubscribers(payload)
    this.handleModelRoutePlan(sessionId, event)
    const parentSessionId = session?.meta.parentSessionId
    if (event.kind === 'turn-result' && parentSessionId && this.sessions.has(parentSessionId)) {
      const childResult: AgentEvent = {
        kind: 'subagent-result',
        orchestrationId: session.meta.orchestrationId,
        childTaskId: session.meta.childTaskId,
        childSessionId: sessionId,
        childRole: session.meta.childRole,
        status: event.isError ? 'error' : 'done',
        resultText: event.resultText,
        costUsd: event.costUsd,
        durationMs: event.durationMs
      }
      const parent = this.sessions.get(parentSessionId)
      if (parent?.emitSyntheticEvent) {
        parent.emitSyntheticEvent(childResult)
      } else {
        this.dispatch(parentSessionId, childResult, 0)
      }
      // 真编排:记录该 child 结果;整组完成后汇总回灌父 Agent
      this.recordOrchestrationResult(session.meta, event)
      const dag = session.meta.orchestrationId
        ? this.dagSchedulers.get(session.meta.orchestrationId)
        : undefined
      if (dag?.hasSession(sessionId)) {
        dag.completeSession(sessionId, {
          ok: !event.isError,
          resultText: event.resultText,
          error: event.isError ? event.resultText ?? event.subtype : undefined
        })
      }
    }
    this.handleEnginePowerBlocker(sessionId, event)
    this.handleNotification(sessionId, event)
    this.handleAutoSkillReview(sessionId, event)
    this.handleModelCrossValidation(sessionId, event, identity.seq)
    this.handleModelReviewArbitration(sessionId, event, identity.seq)
    this.handleTaskSnapshot(sessionId, event, identity)
    if (event.kind === 'init' || event.kind === 'turn-result' || event.kind === 'meta') {
      this.persist(sessionId)
    }
    if (!this.preservingSnapshotsOnDispose && shouldPersistActiveRegistry(event)) {
      this.persistActiveSessions()
    }
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

  private handleModelRoutePlan(sessionId: string, event: AgentEvent): void {
    if (event.kind === 'status' && event.status === 'closed') {
      this.routePlans.delete(sessionId)
      this.deleteCrossValidationKeys(sessionId)
      this.crossValidationReviews.delete(sessionId)
      return
    }
    if (event.kind !== 'routing') return
    const plan = event.crossValidationPlan
    if (plan?.enabled) {
      this.routePlans.set(sessionId, plan)
    } else {
      this.routePlans.delete(sessionId)
    }
  }

  private handleModelCrossValidation(sessionId: string, event: AgentEvent, seq: number): void {
    if (event.kind !== 'turn-result' || event.isError) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    const settings = settingsForCaoGenDrive(getSettings(), session.meta.driveMode)
    if (!settings.smartModelRoutingEnabled || !settings.modelCrossValidationAutoRunEnabled) return
    if (session.meta.parentSessionId || session.meta.childRole === 'model-review') return
    const routePlan = this.routePlans.get(sessionId)
    if (!routePlan?.enabled) return
    const validator = firstCrossValidationTarget(routePlan)
    const resultText = event.resultText?.trim()
    if (!validator || !resultText) return

    const key = `${sessionId}:${seq}:${validator.providerId}:${validator.model}`
    if (this.crossValidationStarted.has(key)) return
    this.crossValidationStarted.add(key)

    const reviewMeta = this.create({
      cwd: session.meta.sourceCwd ?? session.meta.cwd,
      isolated: false,
      model: validator.model,
      providerId: validator.providerId,
      engine: session.meta.engine,
      permissionMode: 'plan',
      parentSessionId: sessionId,
      childTaskId: `cross-validation-${seq}`,
      childRole: 'model-review',
      title: `模型复核: ${cleanOneLine(session.meta.title, session.meta.id, 48)}`
    })
    this.crossValidationReviews.set(reviewMeta.id, {
      parentSessionId: sessionId,
      parentMeta: { ...session.meta },
      routePlan,
      primaryResultText: resultText,
      transcript: session.getTranscript(),
      turnSeq: seq
    })
    const reviewer = `${validator.providerName ?? validator.providerId}/${validator.model}`
    this.dispatch(
      sessionId,
      {
        kind: 'hook-event',
        event: 'model-cross-validation',
        detail: `已启动第二模型复核: ${reviewer}`
      },
      0
    )
    this.send(
      reviewMeta.id,
      buildCrossValidationReviewPrompt({
        parentMeta: { ...session.meta },
        routePlan,
        resultText,
        transcript: session.getTranscript(),
        turnSeq: seq
      })
    )
  }

  private deleteCrossValidationKeys(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.crossValidationStarted) {
      if (key.startsWith(prefix)) this.crossValidationStarted.delete(key)
    }
  }

  private handleModelReviewArbitration(sessionId: string, event: AgentEvent, seq: number): void {
    if (event.kind !== 'turn-result') return
    const review = this.crossValidationReviews.get(sessionId)
    if (!review) return
    this.crossValidationReviews.delete(sessionId)
    const parent = this.sessions.get(review.parentSessionId)
    const reviewerResultText = event.resultText?.trim() ?? ''
    if (event.isError || !needsCrossValidationArbitration(reviewerResultText)) return
    const target = arbitrationCrossValidationTarget(review.routePlan)
    if (!parent || !target) {
      this.dispatch(
        review.parentSessionId,
        {
          kind: 'hook-event',
          event: 'model-cross-validation-arbitration-required',
          detail: '第二模型复核要求仲裁，但当前复核计划没有可用第三模型；需要人工仲裁。'
        },
        0
      )
      return
    }
    const arbitrationMeta = this.create({
      cwd: parent.meta.sourceCwd ?? parent.meta.cwd,
      isolated: false,
      model: target.model,
      providerId: target.providerId,
      engine: parent.meta.engine,
      permissionMode: 'plan',
      parentSessionId: review.parentSessionId,
      childTaskId: `cross-validation-arbitration-${review.turnSeq}`,
      childRole: 'model-arbitration',
      title: `模型仲裁: ${cleanOneLine(parent.meta.title, parent.meta.id, 48)}`
    })
    const arbitrator = `${target.providerName ?? target.providerId}/${target.model}`
    this.dispatch(
      review.parentSessionId,
      {
        kind: 'hook-event',
        event: 'model-cross-validation-arbitration',
        detail: `第二模型复核存在分歧，已启动仲裁模型: ${arbitrator}`
      },
      0
    )
    this.send(
      arbitrationMeta.id,
      buildCrossValidationArbitrationPrompt({
        parentMeta: review.parentMeta,
        routePlan: review.routePlan,
        primaryResultText: review.primaryResultText,
        reviewerResultText,
        transcript: review.transcript,
        turnSeq: seq
      })
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
    if (this.isSnapshotCleanupEvent(sessionId, event)) {
      if (!this.preservingSnapshotsOnDispose) {
        this.snapshotCounts.delete(sessionId)
        if (event.kind === 'status' && event.status === 'closed') {
          this.recentEventIds.delete(sessionId)
        }
        void deleteTaskSnapshot(sessionId, undefined, this.taskRuns.get(sessionId))
      }
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    const state = this.snapshotCounts.get(sessionId) ?? { total: 0, sinceSave: 0, lastSeq: 0 }
    if (this.isSnapshotCountedEvent(event)) {
      state.total += 1
      state.sinceSave += 1
      state.lastSeq = Math.max(state.lastSeq, identity.seq)
      state.lastEventId = identity.eventId
    }
    const reason = this.snapshotReason(event, state.sinceSave)
    if (reason) {
      this.snapshotCounts.set(sessionId, { ...state, sinceSave: 0 })
      void this.writeTaskSnapshot(sessionId, reason, identity.seq, event.kind, identity.eventId)
      return
    }
    this.snapshotCounts.set(sessionId, state)
  }

  private handleTaskRunEvent(
    sessionId: string,
    event: AgentEvent,
    identity: AgentEventIdentity
  ): void {
    const current = this.taskRuns.get(sessionId)
    if (!current) return
    if (hasTaskRunAppliedEvent(current, identity)) return
    const cwd = this.sessions.get(sessionId)?.meta.cwd ?? ''
    let next = reduceTaskExecutionEvent(current, event, cwd, Date.now(), identity)
    if (event.kind === 'status' && event.status === 'closed') {
      if (
        !this.preservingSnapshotsOnDispose &&
        !this.effectRecoveryPreservedSessions.has(sessionId) &&
        !isTaskRunTerminal(next.status) &&
        !runHasUnresolvedEffects(next)
      ) {
        next = transitionTaskRun(next, 'cancelled', { lastEventKind: event.kind })
      }
    } else if (!(event.kind === 'turn-result' && hasPendingTaskSteps(next))) {
      next = reduceTaskRunEvent(next, event)
    }
    if (isTaskLedgerEvent(event)) {
      next = recordTaskRunEvent(next, identity, next === current)
    }
    if (event.kind === 'tool-result' && !event.isError) {
      const completed = next.toolExecutions?.find((execution) => execution.toolUseId === event.toolUseId)
      const duplicateExecutionId = completed?.duplicateOfExecutionId
      if (completed && duplicateExecutionId && duplicateExecutionId !== completed.id) {
        this.taskRuns.supersedeArchivedExecution(
          sessionId,
          duplicateExecutionId,
          completed.id,
          completed.updatedAt
        )
        void supersedeToolExecution(
          duplicateExecutionId,
          completed.id,
          completed.updatedAt
        ).catch((err) => {
          console.error('[caogen] 更新被成功重试取代的工具记录失败:', err)
        })
      }
    }
    if (next !== current) this.taskRuns.set(sessionId, next)
  }

  private snapshotReason(event: AgentEvent, sinceSave: number): TaskSnapshotReason | null {
    if (event.kind === 'turn-result' && event.isError) return 'important-event'
    if (event.kind === 'turn-result') return 'important-event'
    if (event.kind === 'status' && event.status === 'error') return 'important-event'
    if (
      event.kind === 'init' ||
      event.kind === 'meta' ||
      event.kind === 'user-message' ||
      event.kind === 'checkpoint' ||
      event.kind === 'checkpoint-restore' ||
      event.kind === 'permission-request' ||
      event.kind === 'permission-resolved' ||
      event.kind === 'tool-start' ||
      event.kind === 'tool-result' ||
      event.kind === 'subagent-result' ||
      event.kind === 'task-dag-update'
    ) {
      return 'important-event'
    }
    if (event.kind === 'assistant-message' && event.blocks.some((block) => block.type === 'tool_use')) {
      return 'important-event'
    }
    if (event.kind === 'status' && event.status === 'running') return 'important-event'
    return sinceSave >= TASK_SNAPSHOT_EVENT_INTERVAL ? 'event-batch' : null
  }

  private isSnapshotCountedEvent(event: AgentEvent): boolean {
    return event.kind !== 'text-delta' && event.kind !== 'thinking-delta'
  }

  private isSnapshotCleanupEvent(sessionId: string, event: AgentEvent): boolean {
    const run = this.taskRuns.get(sessionId)
    if (this.effectRecoveryPreservedSessions.has(sessionId)) return false
    return (
      (event.kind === 'turn-result' &&
        event.isError === false &&
        (!run || (!hasPendingTaskSteps(run) && !runHasUnresolvedEffects(run)))) ||
      (event.kind === 'status' &&
        event.status === 'closed' &&
        !runHasUnresolvedEffects(run))
    )
  }

  private async writeTaskSnapshot(
    sessionId: string,
    reason: TaskSnapshotReason,
    seq: number,
    eventKind?: AgentEvent['kind'],
    eventId?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const state = this.snapshotCounts.get(sessionId) ?? { total: 0, sinceSave: 0, lastSeq: seq }
    try {
      await saveTaskSnapshot(
        buildTaskSnapshot({
          meta: session.meta,
          transcript: session.getTranscript(),
          lastSeq: Math.max(seq, state.lastSeq),
          lastEventId: eventId ?? state.lastEventId,
          lastEventKind: eventKind,
          eventCount: state.total,
          reason,
          run: this.taskRuns.get(sessionId),
          subtasks: this.snapshotSubtasksFor(sessionId),
          dagExecutions: this.snapshotDagExecutionsFor(sessionId),
          dagRuntimes: this.snapshotDagRuntimesFor(sessionId)
        })
      )
    } catch (err) {
      console.error('[caogen] 写入任务快照失败:', err)
    }
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
    const records = readActiveSessionRegistry()
    if (records.length === 0) return
    let restored = 0
    for (const record of records) {
      if (!record?.id || this.sessions.has(record.id) || snapshotSessionIds.has(record.id) || !record.sdkSessionId) continue
      let cwd: string
      try {
        cwd = assertUsableSessionCwd(record.cwd)
      } catch (err) {
        console.error('[caogen] 跳过不可恢复 active session:', errText(err))
        continue
      }
      const meta: SessionMeta = {
        ...record,
        cwd,
        status: 'starting',
        lastError:
          record.status === 'running' || record.status === 'starting'
            ? '应用上次退出时该任务尚未完成；会话已恢复，请确认当前文件状态后继续。'
            : record.lastError
      }
      if (!meta.unassigned && !meta.projectId) meta.projectId = touchProject(meta.sourceCwd ?? meta.cwd).id
      try {
        this.snapshotCounts.set(meta.id, { total: 0, sinceSave: 0, lastSeq: 0 })
        const session = createEngine(
          meta.engine,
          meta,
          (event, seq, identity) => this.dispatch(meta.id, event, seq, identity),
          record.sdkSessionId
        )
        this.sessions.set(meta.id, session)
        void session.start()
        restored += 1
      } catch (err) {
        console.error('[caogen] 恢复 active session 失败:', err)
      }
    }
    if (restored > 0) this.persistActiveSessions()
  }

  private persistActiveSessions(): void {
    const active = [...this.sessions.values()]
      .map((session) => session.meta)
      .filter((meta) => meta.status !== 'closed' && typeof meta.sdkSessionId === 'string' && meta.sdkSessionId.length > 0)
      .map((meta) => ({ ...meta }))
    writeActiveSessionRegistry(active)
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

function subtaskStatusFromSession(
  status: SessionMeta['status'] | undefined
): TaskSnapshotSubtaskState['status'] {
  if (status === 'starting' || status === 'running') return 'running'
  if (status === 'error') return 'failed'
  if (status === 'closed') return 'closed'
  return 'pending'
}

function activeSessionsFile(): string {
  return join(app.getPath('userData'), 'active-sessions.json')
}

function readActiveSessionRegistry(): SessionMeta[] {
  const file = activeSessionsFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSessionMetaRecord) as SessionMeta[]
  } catch (err) {
    console.error('[caogen] 读取 active session registry 失败:', err)
    return []
  }
}

function writeActiveSessionRegistry(records: SessionMeta[]): void {
  try {
    const file = activeSessionsFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(records, null, 2))
  } catch (err) {
    console.error('[caogen] 写入 active session registry 失败:', err)
  }
}

function assertUsableSessionCwd(rawCwd: string): string {
  const raw = typeof rawCwd === 'string' ? rawCwd.trim() : ''
  if (!raw) throw new Error('项目路径不能为空')
  const cwd = resolve(raw)
  let stat
  try {
    stat = statSync(cwd)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`项目路径不存在:${cwd}`)
    }
    throw new Error(`项目路径不可访问:${cwd}`)
  }
  if (!stat.isDirectory()) throw new Error(`项目路径不是目录:${cwd}`)
  return cwd
}

function shouldPersistActiveRegistry(event: AgentEvent): boolean {
  return (
    event.kind === 'init' ||
    event.kind === 'meta' ||
    event.kind === 'turn-result' ||
    event.kind === 'status'
  )
}

function isSessionMetaRecord(value: unknown): value is SessionMeta {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.cwd === 'string' &&
    typeof record.model === 'string' &&
    typeof record.providerId === 'string' &&
    typeof record.permissionMode === 'string' &&
    typeof record.status === 'string' &&
    typeof record.costUsd === 'number' &&
    typeof record.createdAt === 'number'
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function buildTaskSnapshotReplayPrompts(snapshot: TaskSnapshotRecord): string[] {
  const pendingSteps = (snapshot.run?.steps ?? [])
    .filter((step) => step.status !== 'completed' && step.status !== 'failed' && step.status !== 'cancelled')
    .filter((step) => typeof step.requestText === 'string' && step.requestText.trim())
    .sort((a, b) => a.sequence - b.sequence)
  if (pendingSteps.length > 0) {
    return pendingSteps.map((step) => buildTaskStepReplayPrompt(snapshot, step.requestText ?? '', step.messageId, step.sequence))
  }
  const replay = snapshot.replayCandidate
  if (!replay) return []
  return [buildTaskStepReplayPrompt(snapshot, replay.text, replay.messageId, replay.seq)]
}

function buildTaskStepReplayPrompt(
  snapshot: TaskSnapshotRecord,
  requestText: string,
  messageId: string | undefined,
  sequence: number
): string {
  const unknownTools = (snapshot.run?.toolExecutions ?? [])
    .filter((execution) => execution.status === 'unknown_outcome')
    .map((execution) =>
      `- ${execution.toolName}${execution.idempotencyKey ? ` (${execution.idempotencyKey})` : ''}`
    )
  return [
    '【CaoGen 断点续跑】程序从任务快照恢复。请继续完成上一条未完成的用户请求。',
    '',
    `原始用户请求(messageId=${messageId ?? 'unknown'}, step=${sequence}):`,
    requestText,
    ...(unknownTools.length > 0
      ? ['', '以下工具在退出时结果未知，重复执行前必须先核对实际状态:', ...unknownTools]
      : []),
    '',
    '续跑要求:',
    '1. 先检查当前文件状态、git diff 和已有工具结果,判断哪些步骤已经完成。',
    '2. 不要重复执行已经完成且可能产生副作用的文件修改、依赖安装、提交、推送或外部调用。',
    '3. 如果发现外部修改、冲突或无法确认的状态,先停止并向用户说明需要确认的点。',
    '4. 只继续执行原始请求剩余部分,不要扩大任务范围。'
  ].join('\n')
}

function subtaskStatusFromDag(
  status: TaskDagExecutionView['tasks'][number]['status']
): TaskSnapshotSubtaskState['status'] {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'running'
  return 'pending'
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function effectiveBudgetUsd(meta: SessionMeta): number {
  const sessionBudget = normalizePositiveNumber(meta.budgetUsd)
  if (sessionBudget !== undefined) return sessionBudget
  const providerBudget = meta.providerId ? normalizePositiveNumber(getProvider(meta.providerId)?.budgetUsd) : undefined
  if (providerBudget !== undefined) return providerBudget
  return normalizePositiveNumber(settingsForCaoGenDrive(getSettings(), meta.driveMode).budgetUsdPerSession) ?? 0
}

function canTrackCost(meta: SessionMeta): boolean {
  return meta.engine === 'claude' || meta.engine === 'openai'
}

function estimateTurnCostUsd(meta: SessionMeta, event: Extract<AgentEvent, { kind: 'turn-result' }>): number | undefined {
  if (meta.engine !== 'openai' || !event.usage) return undefined
  const price = openAiPriceFor(meta.model)
  const inputTokens = event.usage.input + event.usage.cacheCreation
  const cachedInputTokens = event.usage.cacheRead
  const outputTokens = event.usage.output
  const cost =
    (inputTokens * price.inputPerMillion +
      cachedInputTokens * price.cachedInputPerMillion +
      outputTokens * price.outputPerMillion) /
    1_000_000
  return cost > 0 ? cost : undefined
}

function openAiPriceFor(model: string | undefined): {
  inputPerMillion: number
  cachedInputPerMillion: number
  outputPerMillion: number
} {
  const normalized = (model || '').toLowerCase()
  if (normalized.includes('gpt-4o-mini')) {
    return { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 }
  }
  if (normalized.includes('gpt-4o')) {
    return { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10 }
  }
  if (normalized.includes('gpt-4.1-mini')) {
    return { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 }
  }
  if (normalized.includes('gpt-4.1-nano')) {
    return { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 }
  }
  if (normalized.includes('gpt-4.1')) {
    return { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }
  }
  return { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }
}

export const sessionManager = new SessionManager()
