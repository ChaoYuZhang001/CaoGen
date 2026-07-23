import type {
  SubagentDispatchItem,
  TaskDag,
  TaskDagDispatchInput,
  TaskDagExecutionStatus,
  TaskDagExecutionTask,
  TaskDagExecutionView,
  TaskDagRuntimeSnapshot,
  TaskDagTask,
  TaskDagTaskStatus
} from '../../shared/types'

export interface TaskDagValidationResult {
  ok: boolean
  layers?: string[][]
  error?: string
}

export interface DagTaskDependencyResult {
  taskId: string
  status: TaskDagTaskStatus
  resultText?: string
  error?: string
}

export interface DagTaskRunContext {
  attempt: number
  dependencyResults: DagTaskDependencyResult[]
}

export interface DagTaskRunResult {
  sessionId: string
  dispatchItem: SubagentDispatchItem
  /** Invoked only after the scheduler has registered the new child session. */
  start?: () => void | Promise<void>
}

export interface DagTaskCompletion {
  ok: boolean
  resultText?: string
  error?: string
}

export interface TaskDagSchedulerCallbacks {
  runTask(task: TaskDagTask, context: DagTaskRunContext): DagTaskRunResult | Promise<DagTaskRunResult>
  onUpdate(execution: TaskDagExecutionView): void
  onTaskProvisioned?(execution: TaskDagExecutionView, sessionId: string): void | Promise<void>
  onComplete?(execution: TaskDagExecutionView): void | Promise<void>
  onTaskTimeout?(sessionId: string, taskId: string, error: string): void
}

interface TaskState extends TaskDagExecutionTask {
  runningSessionId?: string
}

interface DeferredTaskStart {
  state: TaskState
  sessionId: string
  start?: () => void | Promise<void>
}

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000

function normalizeMaxRetries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RETRIES
  return Math.min(5, Math.max(0, Math.floor(value)))
}

function normalizeTaskTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TASK_TIMEOUT_MS
  if (value <= 0) return 0
  return Math.min(24 * 60 * 60 * 1000, Math.max(100, Math.floor(value)))
}

function isNonRetryableTaskError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const tagged = error as { nonRetryable?: unknown; requiresReconciliation?: unknown }
  return tagged.nonRetryable === true || tagged.requiresReconciliation === true
}

function normalizeDependencies(task: TaskDagTask): string[] {
  return Array.isArray(task.dependencies)
    ? [...new Set(task.dependencies.map((id) => id.trim()).filter(Boolean))]
    : []
}

function cloneTaskState(state: TaskState): TaskDagExecutionTask {
  const { runningSessionId: _runningSessionId, ...view } = state
  return {
    ...view,
    sessionIds: [...view.sessionIds],
    task: {
      ...view.task,
      dependencies: [...view.task.dependencies]
    }
  }
}

function terminal(status: TaskDagTaskStatus): boolean {
  return status === 'success' || status === 'failed'
}

function executionStatus(states: TaskState[]): TaskDagExecutionStatus {
  if (states.some((state) => state.status === 'running')) return 'running'
  if (states.some((state) => state.status === 'waiting')) return 'waiting'
  return states.some((state) => state.status === 'failed') ? 'failed' : 'success'
}

function buildSummary(states: TaskState[]): string {
  const ok = states.filter((state) => state.status === 'success').length
  const failed = states.filter((state) => state.status === 'failed').length
  return `DAG 调度完成:${ok}/${states.length} 成功${failed > 0 ? `,${failed} 个失败已升级主 Agent` : ''}`
}

export function validateTaskDag(dag: TaskDag): TaskDagValidationResult {
  if (!dag || typeof dag !== 'object') return { ok: false, error: 'DAG 不能为空' }
  if (!Array.isArray(dag.tasks) || dag.tasks.length === 0) {
    return { ok: false, error: 'DAG 至少需要一个任务' }
  }
  if (dag.tasks.length > 33) return { ok: false, error: '一次 DAG 最多 33 个任务' }

  const ids = new Set<string>()
  for (const task of dag.tasks) {
    const id = typeof task.id === 'string' ? task.id.trim() : ''
    if (!id) return { ok: false, error: '任务 id 不能为空' }
    if (ids.has(id)) return { ok: false, error: `任务 id 重复:${id}` }
    ids.add(id)
  }

  for (const task of dag.tasks) {
    for (const dep of normalizeDependencies(task)) {
      if (dep === task.id) return { ok: false, error: `任务 ${task.id} 不能依赖自己` }
      if (!ids.has(dep)) return { ok: false, error: `任务 ${task.id} 依赖不存在:${dep}` }
    }
  }

  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const task of dag.tasks) {
    indegree.set(task.id, normalizeDependencies(task).length)
    outgoing.set(task.id, [])
  }
  for (const task of dag.tasks) {
    for (const dep of normalizeDependencies(task)) {
      outgoing.get(dep)?.push(task.id)
    }
  }

  const layers: string[][] = []
  let ready = dag.tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id)
  const visited = new Set<string>()
  while (ready.length > 0) {
    layers.push(ready)
    const next: string[] = []
    for (const id of ready) {
      visited.add(id)
      for (const target of outgoing.get(id) ?? []) {
        const value = (indegree.get(target) ?? 0) - 1
        indegree.set(target, value)
        if (value === 0) next.push(target)
      }
    }
    ready = next
  }

  if (visited.size !== dag.tasks.length) return { ok: false, error: 'DAG 存在循环依赖' }
  return { ok: true, layers }
}

export function dependencyContextText(results: DagTaskDependencyResult[]): string {
  if (results.length === 0) return '无上游依赖。'
  return results
    .map((result) => {
      const body = result.resultText || result.error || '无结果摘要'
      return `- ${result.taskId}: ${result.status}\n${body.slice(0, 1200)}`
    })
    .join('\n')
}

export function buildDagTaskPrompt(task: TaskDagTask, context: DagTaskRunContext): string {
  return [
    task.prompt,
    '',
    `当前尝试次数: ${context.attempt}`,
    '上游任务结果:',
    dependencyContextText(context.dependencyResults)
  ].join('\n')
}

export class TaskDagScheduler {
  private readonly states = new Map<string, TaskState>()
  private readonly sessionToTask = new Map<string, string>()
  private readonly layers: string[][]
  private completed = false
  private restoredCompletedAt: number | undefined
  private readonly maxRetries: number
  private readonly taskTimeoutMs: number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private scheduling: Promise<void> | null = null
  private scheduleRequested = false

  constructor(
    private readonly parentSessionId: string,
    private readonly input: TaskDagDispatchInput,
    private readonly callbacks: TaskDagSchedulerCallbacks
  ) {
    const validation = validateTaskDag(input.dag)
    if (!validation.ok || !validation.layers) throw new Error(validation.error ?? 'DAG 校验失败')
    this.layers = validation.layers
    this.maxRetries = normalizeMaxRetries(input.maxRetries)
    this.taskTimeoutMs = normalizeTaskTimeoutMs(input.taskTimeoutMs)
    for (const task of input.dag.tasks) {
      this.states.set(task.id, {
        task: { ...task, dependencies: normalizeDependencies(task) },
        status: 'waiting',
        attempts: 0,
        sessionIds: []
      })
    }
  }

  static fromRuntimeSnapshot(
    runtime: TaskDagRuntimeSnapshot,
    execution: TaskDagExecutionView,
    callbacks: TaskDagSchedulerCallbacks,
    activeSessionIds: Set<string> = new Set()
  ): TaskDagScheduler {
    if (runtime.executionId !== execution.id) {
      throw new Error(`DAG runtime snapshot mismatch: ${runtime.executionId} != ${execution.id}`)
    }
    const scheduler = new TaskDagScheduler(
      runtime.parentSessionId,
      {
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
      },
      callbacks
    )
    scheduler.deferCompletionNotification = true
    scheduler.restoreExecution(execution, runtime, activeSessionIds)
    return scheduler
  }

  async start(): Promise<SubagentDispatchItem[]> {
    const before = new Set(this.sessionToTask.keys())
    await this.scheduleReadyTasks()
    return this.newDispatchItemsSince(before)
  }

  async resume(): Promise<SubagentDispatchItem[]> {
    const before = new Set(this.sessionToTask.keys())
    this.deferCompletionNotification = false
    this.emitUpdate()
    await this.scheduleReadyTasks()
    await this.notifyCompletionOnce()
    return this.newDispatchItemsSince(before)
  }

  hasSession(sessionId: string): boolean {
    return this.sessionToTask.has(sessionId)
  }

  async adoptProvisionedSession(taskId: string, meta: SubagentDispatchItem['meta']): Promise<SubagentDispatchItem | null> {
    if (this.completed || this.recoveryBlockedError || this.sessionToTask.has(meta.id)) return null
    const state = this.states.get(taskId)
    if (!state || state.status !== 'waiting' || state.runningSessionId) return null
    if (!this.dependenciesComplete(state.task)) return null
    const context = {
      attempt: state.attempts + 1,
      dependencyResults: this.dependencyResults(state.task)
    }
    const item = { taskId, prompt: buildDagTaskPrompt(state.task, context), meta }
    state.status = 'running'
    state.attempts += 1
    state.startedAt = Date.now()
    state.runningSessionId = meta.id
    state.sessionIds.push(meta.id)
    this.sessionToTask.set(meta.id, taskId)
    this.dispatchItems.set(meta.id, item)
    this.emitUpdate()
    await this.callbacks.onTaskProvisioned?.(this.view(), meta.id)
    return item
  }

  async startProvisionedSession(
    sessionId: string,
    start: () => void | Promise<void>
  ): Promise<boolean> {
    const taskId = this.sessionToTask.get(sessionId)
    const state = taskId ? this.states.get(taskId) : undefined
    if (!state) return false
    return this.startDeferredTask({ state, sessionId, start }, [])
  }

  async blockRecoveryTask(taskId: string, sessionId: string, error: string): Promise<boolean> {
    if (this.completed && !this.recoveryBlockedError) return false
    const state = this.states.get(taskId)
    if (!state || terminal(state.status)) return false
    const now = Date.now()
    this.clearTaskTimer(sessionId)
    state.status = 'failed'
    state.attempts = Math.max(1, state.attempts)
    state.startedAt ??= now
    state.completedAt = now
    state.error = error
    state.runningSessionId = undefined
    if (!state.sessionIds.includes(sessionId)) state.sessionIds.push(sessionId)
    this.sessionToTask.set(sessionId, taskId)
    this.setRecoveryBlock(error, now)
    this.emitUpdate()
    await this.notifyCompletionOnce()
    return true
  }

  runtimeSnapshot(options?: {
    autoMerge?: { enabled: boolean; verificationCommand?: string }
    mergeSessions?: TaskDagRuntimeSnapshot['mergeSessions']
  }): TaskDagRuntimeSnapshot {
    const runningTasks = [...this.states.values()]
      .map((state) =>
        state.runningSessionId ? { taskId: state.task.id, sessionId: state.runningSessionId } : undefined
      )
      .filter((task): task is { taskId: string; sessionId: string } => Boolean(task))
    return {
      executionId: this.input.dag.id,
      parentSessionId: this.parentSessionId,
      capturedAt: Date.now(),
      dispatchOptions: {
        cwd: this.input.cwd,
        isolated: this.input.isolated,
        driveMode: this.input.driveMode,
        model: this.input.model,
        providerId: this.input.providerId,
        engine: this.input.engine,
        permissionMode: this.input.permissionMode,
        taskTimeoutMs: this.taskTimeoutMs
      },
      runningTasks,
      ...(this.recoveryBlockedError ? { recoveryBlockedError: this.recoveryBlockedError } : {}),
      ...(options?.mergeSessions ? { mergeSessions: options.mergeSessions } : {}),
      ...(options?.autoMerge ? { autoMerge: options.autoMerge } : {})
    }
  }

  async completeSession(sessionId: string, completion: DagTaskCompletion): Promise<void> {
    const taskId = this.sessionToTask.get(sessionId)
    if (!taskId || this.completed) return
    const state = this.states.get(taskId)
    if (!state || state.runningSessionId !== sessionId) return

    this.clearTaskTimer(sessionId)
    state.runningSessionId = undefined
    const recoveryBlocked = Boolean(this.recoveryBlockedError)
    if (completion.ok) {
      state.status = 'success'
      state.resultText = completion.resultText
      state.error = undefined
      state.completedAt = Date.now()
      if (recoveryBlocked) {
        this.finishRecoveryBlockIfSettled(state.completedAt)
        this.emitUpdate()
        await this.notifyCompletionOnce()
        return
      }
      this.emitUpdate()
      await this.scheduleReadyTasks()
      return
    }

    if (recoveryBlocked) {
      state.status = 'failed'
      state.error = completion.error || completion.resultText || '子任务失败'
      state.resultText = completion.resultText
      state.completedAt = Date.now()
      this.finishRecoveryBlockIfSettled(state.completedAt)
      this.emitUpdate()
      await this.notifyCompletionOnce()
      return
    }

    if (state.attempts <= this.maxRetries) {
      state.status = 'waiting'
      state.error = completion.error || completion.resultText || '子任务失败,准备重试'
      this.emitUpdate()
      await this.scheduleReadyTasks()
      return
    }

    // 失败任务到达重试上限后进入终态;下游任务仍可拿到失败摘要继续执行。
    state.status = 'failed'
    state.error = completion.error || completion.resultText || '子任务失败'
    state.resultText = completion.resultText
    state.completedAt = Date.now()
    this.emitUpdate()
    await this.scheduleReadyTasks()
  }

  view(): TaskDagExecutionView {
    const states = [...this.states.values()]
    const status = this.recoveryBlockedError ? 'failed' : executionStatus(states)
    return {
      id: this.input.dag.id,
      parentSessionId: this.parentSessionId,
      dag: this.input.dag,
      status,
      maxRetries: this.maxRetries,
      startedAt: this.input.dag.createdAt,
      completedAt: this.completed ? this.restoredCompletedAt ?? Date.now() : undefined,
      layers: this.layers.map((layer) => [...layer]),
      tasks: states.map(cloneTaskState),
      summary: this.completed ? buildSummary(states) : undefined,
      error: this.recoveryBlockedError ??
        (status === 'failed' ? '存在失败任务,已升级主 Agent 汇总处理' : undefined)
    }
  }

  private readonly dispatchItems = new Map<string, SubagentDispatchItem>()
  private recoveryBlockedError?: string
  private completionNotified = false
  private completionNotification: Promise<void> | null = null
  private deferCompletionNotification = false

  private findDispatchItem(sessionId: string): SubagentDispatchItem | undefined {
    return this.dispatchItems.get(sessionId)
  }

  private newDispatchItemsSince(before: Set<string>): SubagentDispatchItem[] {
    return [...this.sessionToTask.keys()]
      .filter((id) => !before.has(id))
      .map((id) => {
        const taskId = this.sessionToTask.get(id)
        const state = taskId ? this.states.get(taskId) : undefined
        const meta = state?.sessionIds.includes(id)
        return meta ? this.findDispatchItem(id) : undefined
      })
      .filter((item): item is SubagentDispatchItem => Boolean(item))
  }

  private emitUpdate(): void {
    this.callbacks.onUpdate(this.view())
  }

  private restoreExecution(
    execution: TaskDagExecutionView,
    runtime: TaskDagRuntimeSnapshot,
    activeSessionIds: Set<string>
  ): void {
    const runningByTask = new Map(runtime.runningTasks.map((task) => [task.taskId, task.sessionId]))
    this.sessionToTask.clear()
    this.dispatchItems.clear()
    this.clearAllTimers()
    const recoveryBlocks: string[] = []
    for (const taskView of execution.tasks) {
      this.restoreTaskState(taskView, runningByTask, activeSessionIds, recoveryBlocks)
    }

    this.completed = execution.completedAt !== undefined &&
      (execution.status === 'success' || execution.status === 'failed')
    this.restoredCompletedAt = execution.completedAt
    const persistedBlock = runtime.recoveryBlockedError ??
      (execution.status === 'failed' && execution.completedAt === undefined ? execution.error : undefined)
    if (persistedBlock) recoveryBlocks.unshift(persistedBlock)
    if (recoveryBlocks.length > 0) {
      this.completed = false
      this.restoredCompletedAt = undefined
      this.setRecoveryBlock(`DAG recovery blocked: ${recoveryBlocks.join('; ')}`)
    }
  }

  private restoreTaskState(
    taskView: TaskDagExecutionView['tasks'][number],
    runningByTask: ReadonlyMap<string, string>,
    activeSessionIds: ReadonlySet<string>,
    recoveryBlocks: string[]
  ): void {
    const state = this.states.get(taskView.task.id)
    if (!state) return
    const runningSessionId = runningByTask.get(taskView.task.id)
    const canReuseRunningSession = taskView.status === 'running' &&
      typeof runningSessionId === 'string' &&
      taskView.sessionIds.includes(runningSessionId) &&
      activeSessionIds.has(runningSessionId)
    Object.assign(state, {
      task: { ...taskView.task, dependencies: normalizeDependencies(taskView.task) },
      status: taskView.status,
      attempts: Math.max(0, Math.floor(taskView.attempts)),
      sessionIds: [...taskView.sessionIds],
      startedAt: taskView.startedAt,
      completedAt: taskView.completedAt,
      resultText: taskView.resultText,
      error: taskView.error,
      runningSessionId: undefined
    })
    for (const sessionId of state.sessionIds) this.sessionToTask.set(sessionId, state.task.id)
    if (canReuseRunningSession) {
      state.status = 'running'
      state.runningSessionId = runningSessionId
      this.armTaskTimer(runningSessionId, state.task.id)
    } else if (taskView.status === 'running') {
      state.status = 'failed'
      state.completedAt = Date.now()
      state.error = taskView.error ||
        `DAG child ${runningSessionId ?? 'unknown'} was not active after snapshot recovery; ` +
        'automatic replacement is blocked to preserve its snapshot and worktree evidence.'
      recoveryBlocks.push(`${state.task.id}: ${state.error}`)
    }
  }

  private scheduleReadyTasks(): Promise<void> {
    if (this.completed || this.recoveryBlockedError) return Promise.resolve()
    this.scheduleRequested = true
    if (!this.scheduling) {
      this.scheduling = this.drainReadyTasks().finally(() => {
        this.scheduling = null
      })
    }
    return this.scheduling
  }

  private async drainReadyTasks(): Promise<void> {
    while (this.scheduleRequested && !this.completed && !this.recoveryBlockedError) {
      this.scheduleRequested = false
      const ready = [...this.states.values()].filter(
        (state) => state.status === 'waiting' &&
          !state.runningSessionId &&
          this.dependenciesComplete(state.task)
      )
      if (ready.length === 0) {
        await this.maybeComplete()
        continue
      }
      const deferredStarts: DeferredTaskStart[] = []
      for (const state of ready) {
        const deferred = await this.provisionTask(state)
        if (deferred) deferredStarts.push(deferred)
        if (this.completed || this.recoveryBlockedError) {
          await this.abortDeferredStarts(deferredStarts)
          return
        }
      }
      for (const [index, deferred] of deferredStarts.entries()) {
        const started = await this.startDeferredTask(deferred, deferredStarts.slice(index + 1))
        if (!started) return
      }
    }
  }

  private async provisionTask(state: TaskState): Promise<DeferredTaskStart | undefined> {
    while (!this.completed && !this.recoveryBlockedError && state.status === 'waiting' && !state.runningSessionId) {
      const context: DagTaskRunContext = {
        attempt: state.attempts + 1,
        dependencyResults: this.dependencyResults(state.task)
      }
      state.status = 'running'
      state.attempts += 1
      state.startedAt = Date.now()
      let provisionedSessionId: string | undefined
      try {
        const run = await this.callbacks.runTask(state.task, context)
        provisionedSessionId = run.sessionId
        state.runningSessionId = run.sessionId
        state.sessionIds.push(run.sessionId)
        this.sessionToTask.set(run.sessionId, state.task.id)
        this.dispatchItems.set(run.sessionId, run.dispatchItem)
        this.emitUpdate()
        await this.callbacks.onTaskProvisioned?.(this.view(), run.sessionId)
        return { state, sessionId: run.sessionId, start: run.start }
      } catch (err) {
        state.runningSessionId = undefined
        state.status = 'waiting'
        state.error = err instanceof Error ? err.message : String(err)
        if (provisionedSessionId) this.clearTaskTimer(provisionedSessionId)
        const recoveryBlocked = Boolean(provisionedSessionId) || isNonRetryableTaskError(err)
        if (!recoveryBlocked && state.attempts <= this.maxRetries) {
          this.emitUpdate()
          continue
        }
        state.status = 'failed'
        state.completedAt = Date.now()
        if (recoveryBlocked) {
          const blockError =
            `DAG provisioning blocked at ${state.task.id}: ${state.error}. ` +
            'Automatic downstream scheduling is disabled until the original lifecycle evidence is reconciled.'
          this.setRecoveryBlock(blockError, state.completedAt)
          this.emitUpdate()
          await this.notifyCompletionOnce()
          return undefined
        }
        this.emitUpdate()
        this.scheduleRequested = true
        return undefined
      }
    }
    return undefined
  }

  private async startDeferredTask(
    deferred: DeferredTaskStart,
    notStarted: DeferredTaskStart[]
  ): Promise<boolean> {
    if (deferred.state.status !== 'running' || deferred.state.runningSessionId !== deferred.sessionId) {
      await this.abortDeferredStarts([deferred, ...notStarted])
      return false
    }
    try {
      await deferred.start?.()
    } catch (error) {
      await this.blockProvisionedStart(deferred, notStarted, error)
      return false
    }
    if (deferred.state.status === 'running' && deferred.state.runningSessionId === deferred.sessionId) {
      this.armTaskTimer(deferred.sessionId, deferred.state.task.id)
    }
    return true
  }

  private async abortDeferredStarts(deferredStarts: DeferredTaskStart[]): Promise<void> {
    const now = Date.now()
    for (const deferred of deferredStarts) {
      const { state, sessionId } = deferred
      if (state.runningSessionId !== sessionId) continue
      this.clearTaskTimer(sessionId)
      state.runningSessionId = undefined
      state.status = 'failed'
      state.completedAt = now
      state.error =
        `DAG ready-batch provisioning was blocked before prompt delivery; ` +
        `session ${sessionId} is frozen for reconciliation.`
    }
    const blockError = `${this.recoveryBlockedError ?? 'DAG provisioning blocked.'} ` +
      'No prompt was sent to earlier sessions in the ready batch.'
    this.setRecoveryBlock(blockError, now)
    this.emitUpdate()
    await this.notifyCompletionOnce()
  }

  private async blockProvisionedStart(
    deferred: DeferredTaskStart,
    notStarted: DeferredTaskStart[],
    error: unknown
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    const now = Date.now()
    this.clearTaskTimer(deferred.sessionId)
    deferred.state.runningSessionId = undefined
    deferred.state.status = 'failed'
    deferred.state.completedAt = now
    deferred.state.error = `Prompt delivery failed for frozen session ${deferred.sessionId}: ${detail}`
    for (const pending of notStarted) {
      this.clearTaskTimer(pending.sessionId)
      pending.state.runningSessionId = undefined
      pending.state.status = 'failed'
      pending.state.completedAt = now
      pending.state.error =
        `DAG prompt delivery was blocked before session ${pending.sessionId} started; ` +
        'the frozen session is retained for reconciliation.'
    }
    this.setRecoveryBlock(
      `DAG prompt delivery blocked at ${deferred.state.task.id}; automatic downstream scheduling is disabled.`,
      now
    )
    this.emitUpdate()
    await this.notifyCompletionOnce()
  }

  private setRecoveryBlock(error: string, now = Date.now()): void {
    this.recoveryBlockedError = error
    this.scheduleRequested = false
    this.finishRecoveryBlockIfSettled(now)
  }

  private finishRecoveryBlockIfSettled(now = Date.now()): void {
    if (!this.recoveryBlockedError) return
    const hasRunningSessions = [...this.states.values()].some(
      (state) => state.status === 'running' && Boolean(state.runningSessionId)
    )
    if (hasRunningSessions) {
      this.completed = false
      this.restoredCompletedAt = undefined
      return
    }
    this.completed = true
    this.restoredCompletedAt = now
    this.clearAllTimers()
  }

  private dependenciesComplete(task: TaskDagTask): boolean {
    return task.dependencies.every((dep) => {
      const state = this.states.get(dep)
      return state ? terminal(state.status) : false
    })
  }

  private dependencyResults(task: TaskDagTask): DagTaskDependencyResult[] {
    return task.dependencies.map((dep) => {
      const state = this.states.get(dep)
      return {
        taskId: dep,
        status: state?.status ?? 'failed',
        resultText: state?.resultText,
        error: state?.error
      }
    })
  }

  private async maybeComplete(): Promise<void> {
    if ([...this.states.values()].some((state) => !terminal(state.status))) return
    this.completed = true
    this.clearAllTimers()
    const finalView = this.view()
    this.callbacks.onUpdate(finalView)
    await this.notifyCompletionOnce(finalView)
  }

  private async notifyCompletionOnce(view = this.view()): Promise<void> {
    if (!this.completed || this.deferCompletionNotification || this.completionNotified) return
    if (this.completionNotification) return this.completionNotification
    const notification = Promise.resolve(this.callbacks.onComplete?.(view))
    this.completionNotification = notification
    try {
      await notification
      this.completionNotified = true
    } finally {
      if (this.completionNotification === notification) this.completionNotification = null
    }
  }

  private armTaskTimer(sessionId: string, taskId: string): void {
    if (this.taskTimeoutMs <= 0) return
    this.clearTaskTimer(sessionId)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      if (this.completed) return
      const error = `DAG 子任务 ${taskId} 超时(${this.taskTimeoutMs}ms), 已按失败重试或升级`
      this.callbacks.onTaskTimeout?.(sessionId, taskId, error)
      void this.completeSession(sessionId, { ok: false, error }).catch((err) => {
        console.error('[caogen] DAG timeout scheduling failed:', err)
      })
    }, this.taskTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.set(sessionId, timer)
  }

  private clearTaskTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(sessionId)
  }

  private clearAllTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
