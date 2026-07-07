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
}

export interface DagTaskCompletion {
  ok: boolean
  resultText?: string
  error?: string
}

export interface TaskDagSchedulerCallbacks {
  runTask(task: TaskDagTask, context: DagTaskRunContext): DagTaskRunResult
  onUpdate(execution: TaskDagExecutionView): void
  onComplete?(execution: TaskDagExecutionView): void
  onTaskTimeout?(sessionId: string, taskId: string, error: string): void
}

interface TaskState extends TaskDagExecutionTask {
  runningSessionId?: string
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
    scheduler.restoreExecution(execution, runtime, activeSessionIds)
    return scheduler
  }

  start(): SubagentDispatchItem[] {
    const before = new Set(this.sessionToTask.keys())
    this.scheduleReadyTasks()
    return this.newDispatchItemsSince(before)
  }

  resume(): SubagentDispatchItem[] {
    const before = new Set(this.sessionToTask.keys())
    this.emitUpdate()
    this.scheduleReadyTasks()
    return this.newDispatchItemsSince(before)
  }

  hasSession(sessionId: string): boolean {
    return this.sessionToTask.has(sessionId)
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
        model: this.input.model,
        providerId: this.input.providerId,
        engine: this.input.engine,
        permissionMode: this.input.permissionMode,
        taskTimeoutMs: this.taskTimeoutMs
      },
      runningTasks,
      ...(options?.mergeSessions ? { mergeSessions: options.mergeSessions } : {}),
      ...(options?.autoMerge ? { autoMerge: options.autoMerge } : {})
    }
  }

  completeSession(sessionId: string, completion: DagTaskCompletion): void {
    const taskId = this.sessionToTask.get(sessionId)
    if (!taskId || this.completed) return
    const state = this.states.get(taskId)
    if (!state || state.runningSessionId !== sessionId) return

    this.clearTaskTimer(sessionId)
    state.runningSessionId = undefined
    if (completion.ok) {
      state.status = 'success'
      state.resultText = completion.resultText
      state.error = undefined
      state.completedAt = Date.now()
      this.emitUpdate()
      this.scheduleReadyTasks()
      return
    }

    if (state.attempts <= this.maxRetries) {
      state.status = 'waiting'
      state.error = completion.error || completion.resultText || '子任务失败,准备重试'
      this.emitUpdate()
      this.startTask(state)
      return
    }

    // 失败任务到达重试上限后进入终态;下游任务仍可拿到失败摘要继续执行。
    state.status = 'failed'
    state.error = completion.error || completion.resultText || '子任务失败'
    state.resultText = completion.resultText
    state.completedAt = Date.now()
    this.emitUpdate()
    this.scheduleReadyTasks()
  }

  view(): TaskDagExecutionView {
    const states = [...this.states.values()]
    const status = executionStatus(states)
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
      error: status === 'failed' ? '存在失败任务,已升级主 Agent 汇总处理' : undefined
    }
  }

  private readonly dispatchItems = new Map<string, SubagentDispatchItem>()

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
    for (const taskView of execution.tasks) {
      const state = this.states.get(taskView.task.id)
      if (!state) continue
      const runningSessionId = runningByTask.get(taskView.task.id)
      const canReuseRunningSession =
        taskView.status === 'running' &&
        typeof runningSessionId === 'string' &&
        taskView.sessionIds.includes(runningSessionId) &&
        activeSessionIds.has(runningSessionId)

      state.task = { ...taskView.task, dependencies: normalizeDependencies(taskView.task) }
      state.status = taskView.status
      state.attempts = Math.max(0, Math.floor(taskView.attempts))
      state.sessionIds = [...taskView.sessionIds]
      state.startedAt = taskView.startedAt
      state.completedAt = taskView.completedAt
      state.resultText = taskView.resultText
      state.error = taskView.error
      state.runningSessionId = undefined

      for (const sessionId of state.sessionIds) {
        this.sessionToTask.set(sessionId, state.task.id)
      }

      if (canReuseRunningSession) {
        state.status = 'running'
        state.runningSessionId = runningSessionId
        this.armTaskTimer(runningSessionId, state.task.id)
      } else if (taskView.status === 'running') {
        state.status = 'waiting'
        state.error =
          taskView.error ||
          'DAG child session was not active after snapshot recovery; scheduling a fresh attempt.'
      }
    }

    this.completed = execution.status === 'success' || execution.status === 'failed'
    this.restoredCompletedAt = execution.completedAt
  }

  private scheduleReadyTasks(): void {
    if (this.completed) return
    let launched = false
    for (const state of this.states.values()) {
      if (state.status !== 'waiting' || state.runningSessionId) continue
      if (!this.dependenciesComplete(state.task)) continue
      this.startTask(state)
      launched = true
    }
    if (!launched) this.maybeComplete()
  }

  private startTask(state: TaskState): void {
    const context: DagTaskRunContext = {
      attempt: state.attempts + 1,
      dependencyResults: this.dependencyResults(state.task)
    }
    state.status = 'running'
    state.attempts += 1
    state.startedAt = Date.now()
    try {
      const run = this.callbacks.runTask(state.task, context)
      state.runningSessionId = run.sessionId
      state.sessionIds.push(run.sessionId)
      this.sessionToTask.set(run.sessionId, state.task.id)
      this.dispatchItems.set(run.sessionId, run.dispatchItem)
      this.armTaskTimer(run.sessionId, state.task.id)
      this.emitUpdate()
    } catch (err) {
      state.runningSessionId = undefined
      state.status = 'waiting'
      state.error = err instanceof Error ? err.message : String(err)
      if (state.attempts <= this.maxRetries) {
        this.emitUpdate()
        this.startTask(state)
      } else {
        state.status = 'failed'
        state.completedAt = Date.now()
        this.emitUpdate()
        this.scheduleReadyTasks()
      }
    }
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

  private maybeComplete(): void {
    if ([...this.states.values()].some((state) => !terminal(state.status))) return
    this.completed = true
    this.clearAllTimers()
    const finalView = this.view()
    this.callbacks.onUpdate(finalView)
    this.callbacks.onComplete?.(finalView)
  }

  private armTaskTimer(sessionId: string, taskId: string): void {
    if (this.taskTimeoutMs <= 0) return
    this.clearTaskTimer(sessionId)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      if (this.completed) return
      const error = `DAG 子任务 ${taskId} 超时(${this.taskTimeoutMs}ms), 已按失败重试或升级`
      this.callbacks.onTaskTimeout?.(sessionId, taskId, error)
      this.completeSession(sessionId, { ok: false, error })
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
