import type {
  AgentEvent,
  AgentEventIdentity,
  DispatchSubagentsInput,
  SessionMeta,
  TaskDagExecutionView,
  TaskDagRuntimeSnapshot,
  TaskRunRecord,
  TaskSnapshotReason,
  TaskSnapshotRecord,
  TaskSnapshotSubtaskState,
  TranscriptEntry
} from '../shared/types'
import { settingsForCaoGenDrive } from './model/drive'
import { getProvider } from './providers'
import { getSettings } from './settings'
import {
  recoverWorkflowTestFailureIngresses,
  WorkflowTestFailureRuntime
} from './task/workflow-test-failure-runtime'
import {
  bindWorkflowRunToCanonicalWorkItem,
  recoverWorkflowRunCanonicalBindings
} from './task/workflow-run-canonical-binding'
import {
  ensureSupervisorRunBinding,
  recoverSupervisorRunBindings
} from './task/supervisor-taskrun-bridge'
import { SupervisorStateStore } from './task/supervisor-state'
import { buildTaskSnapshot, saveTaskSnapshot } from './task/task-snapshot'

export interface SessionNotificationState {
  turnActive: boolean
  permissionNotified: boolean
  terminalNotified: boolean
}

export interface ManagedSessionCreationOptions { retainJournal?: boolean }

export interface OrchestrationState {
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

interface Lookup<T> { get(key: string): T | undefined }
type WorkflowSession = { meta: SessionMeta; getTranscript(): TranscriptEntry[] }
interface SessionWorkflowRuntimeDependencies {
  sessions: Lookup<WorkflowSession>
  runs: Lookup<TaskRunRecord>
  snapshotState(sessionId: string, seq: number): { total: number; lastSeq: number; lastEventId?: string }
  subtasks(sessionId: string): TaskSnapshotSubtaskState[]
  dagExecutions(sessionId: string): TaskDagExecutionView[]
  dagRuntimes(sessionId: string): TaskDagRuntimeSnapshot[]
}

export interface SessionWorkflowRuntimeOptions {
  /** Main-process userData root; omitted by isolated canonical-only callers. */
  userDataRoot?: string
}

export class SessionWorkflowRuntime {
  private readonly testFailure: WorkflowTestFailureRuntime
  private readonly blockedRecoveries = new Set<string>()
  private readonly userDataRoot?: string
  private readonly supervisorStore?: SupervisorStateStore

  constructor(
    private readonly dependencies: SessionWorkflowRuntimeDependencies,
    options: SessionWorkflowRuntimeOptions = {}
  ) {
    this.userDataRoot = options.userDataRoot
    this.supervisorStore = options.userDataRoot
      ? new SupervisorStateStore(options.userDataRoot)
      : undefined
    this.testFailure = new WorkflowTestFailureRuntime({
      context: (sessionId) => {
        const session = dependencies.sessions.get(sessionId)
        return session && {
          meta: { ...session.meta },
          run: dependencies.runs.get(sessionId),
          transcript: session.getTranscript()
        }
      },
      captureEventBarrier: (sessionId, identity) => this.captureSnapshot(
        sessionId, 'important-event', identity.seq, 'tool-result', identity.eventId, true)
    })
  }

  captureSnapshot(
    sessionId: string,
    reason: TaskSnapshotReason,
    seq: number,
    eventKind?: AgentEvent['kind'],
    eventId?: string,
    strict = false
  ): () => Promise<void> {
    const session = this.dependencies.sessions.get(sessionId)
    if (!session) return strict
      ? async () => { throw new Error(`strict task snapshot barrier lost active session: ${sessionId}`) }
      : async () => undefined
    const state = this.dependencies.snapshotState(sessionId, seq)
    const snapshot = buildTaskSnapshot({
      meta: session.meta,
      transcript: session.getTranscript(),
      lastSeq: Math.max(seq, state.lastSeq),
      lastEventId: eventId ?? state.lastEventId,
      lastEventKind: eventKind,
      eventCount: state.total,
      reason,
      run: this.dependencies.runs.get(sessionId),
      subtasks: this.dependencies.subtasks(sessionId),
      dagExecutions: this.dependencies.dagExecutions(sessionId),
      dagRuntimes: this.dependencies.dagRuntimes(sessionId)
    })
    return async () => this.bindSnapshot(await saveTaskSnapshot(snapshot))
  }

  handleEvent(sessionId: string, event: AgentEvent, identity: AgentEventIdentity): void {
    void this.testFailure.handleEvent(sessionId, event, identity).catch((error) => {
      console.error('[caogen] structured test failure ingress rejected:', error)
    })
  }

  flush(sessionId: string): Promise<void> {
    return this.testFailure.flush(sessionId)
  }

  recoveryBlocks(): ReadonlySet<string> {
    return this.blockedRecoveries
  }

  assertRecoveryResolved(sessionId: string): void {
    if (this.blockedRecoveries.has(sessionId)) {
      throw new Error(`workflow recovery is unresolved; snapshot deletion blocked:${sessionId}`)
    }
  }

  async persistShutdownSnapshot(sessionId: string, persist: () => Promise<void>): Promise<void> {
    try {
      await this.flush(sessionId)
      await persist()
    } catch (error) {
      console.error('[caogen] workflow ingress flush failed; preserving existing recovery snapshot:', error)
    }
  }

  async bindSnapshot(snapshot: Pick<TaskSnapshotRecord, 'meta' | 'run'>): Promise<void> {
    if (!snapshot.run) return
    if (this.userDataRoot && this.supervisorStore) {
      await ensureSupervisorRunBinding(snapshot.meta, snapshot.run, {
        rootDir: this.userDataRoot,
        store: this.supervisorStore
      })
      return
    }
    await bindWorkflowRunToCanonicalWorkItem(snapshot.meta, snapshot.run)
  }

  async recover(snapshots: readonly TaskSnapshotRecord[]): Promise<Set<string>> {
    const runBindings = this.userDataRoot && this.supervisorStore
      ? await recoverSupervisorRunBindings(snapshots, {
          rootDir: this.userDataRoot,
          store: this.supervisorStore
        })
      : await recoverWorkflowRunCanonicalBindings(snapshots)
    if (runBindings.failures.length > 0) {
      console.error(`[caogen] ${runBindings.failures.length} canonical Run binding(s) need manual reconciliation`)
    }
    const testFailures = await recoverWorkflowTestFailureIngresses(snapshots)
    if (testFailures.failures.length > 0) {
      console.error(`[caogen] ${testFailures.failures.length} structured test failure(s) need manual reconciliation`)
    }
    const failedRunIds = new Set(runBindings.failures.map((failure) => failure.runId))
    const failedEventIds = new Set(testFailures.failures.map((failure) => failure.sourceEventId))
    this.blockedRecoveries.clear()
    for (const sessionId of snapshots
      .filter((snapshot) =>
        (snapshot.run !== undefined && failedRunIds.has(snapshot.run.id)) ||
        snapshot.transcript.some((entry) => entry.eventId !== undefined && failedEventIds.has(entry.eventId)))
      .map((snapshot) => snapshot.sessionId)) this.blockedRecoveries.add(sessionId)
    return new Set(this.blockedRecoveries)
  }
}

export function subagentCwd(
  task: DispatchSubagentsInput['tasks'][number],
  input: DispatchSubagentsInput,
  parentMeta: SessionMeta
): string {
  return task.cwd ?? input.cwd ?? parentMeta.sourceCwd ?? parentMeta.cwd
}

export function shouldResumeDagFinalization(event: AgentEvent): boolean {
  return event.kind === 'init' ||
    event.kind === 'turn-result' ||
    (event.kind === 'status' && event.status === 'idle')
}

export function subtaskStatusFromSession(
  status: SessionMeta['status'] | undefined
): TaskSnapshotSubtaskState['status'] {
  if (status === 'starting' || status === 'running') return 'running'
  if (status === 'error') return 'failed'
  if (status === 'closed') return 'closed'
  return 'pending'
}

export function shouldPersistActiveRegistry(event: AgentEvent): boolean {
  return event.kind === 'init' ||
    event.kind === 'meta' ||
    event.kind === 'turn-result' ||
    event.kind === 'status'
}

export function shouldDispatchChildResult(
  meta: SessionMeta | undefined,
  event: AgentEvent,
  parentIsActive: (sessionId: string) => boolean
): event is Extract<AgentEvent, { kind: 'turn-result' }> {
  return event.kind === 'turn-result' &&
    Boolean(meta?.parentSessionId) &&
    parentIsActive(meta!.parentSessionId!)
}

export function requireDagPromptAccepted(accepted: boolean): void {
  if (!accepted) throw new Error('DAG child prompt was rejected before execution started')
}

export function buildTaskSnapshotReplayPrompts(snapshot: TaskSnapshotRecord): string[] {
  const pendingSteps = (snapshot.run?.steps ?? [])
    .filter((step) => step.status !== 'completed' && step.status !== 'failed' && step.status !== 'cancelled')
    .filter((step) => typeof step.requestText === 'string' && step.requestText.trim())
    .sort((a, b) => a.sequence - b.sequence)
  if (pendingSteps.length > 0) {
    return pendingSteps.map((step) =>
      buildTaskStepReplayPrompt(snapshot, step.requestText ?? '', step.messageId, step.sequence)
    )
  }
  const replay = snapshot.replayCandidate
  return replay ? [buildTaskStepReplayPrompt(snapshot, replay.text, replay.messageId, replay.seq)] : []
}

export function subtaskStatusFromDag(
  status: TaskDagExecutionView['tasks'][number]['status']
): TaskSnapshotSubtaskState['status'] {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'running'
  return 'pending'
}

export function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function cleanOneLine(text: string, fallback: string, max = 80): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return (clean || fallback).slice(0, max)
}

export async function mapWithConcurrencyInOrder<T, R>(
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

export function normalizeTaskId(value: string | undefined, fallback: string): string {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (!clean) return fallback
  return clean.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80) || fallback
}

export function effectiveBudgetUsd(meta: SessionMeta): number {
  const sessionBudget = normalizePositiveNumber(meta.budgetUsd)
  if (sessionBudget !== undefined) return sessionBudget
  const providerBudget = meta.providerId ? normalizePositiveNumber(getProvider(meta.providerId)?.budgetUsd) : undefined
  if (providerBudget !== undefined) return providerBudget
  return normalizePositiveNumber(settingsForCaoGenDrive(getSettings(), meta.driveMode).budgetUsdPerSession) ?? 0
}

export function canTrackCost(meta: SessionMeta): boolean {
  // Anthropic Messages reports token usage but not monetary cost. Keep budget enforcement fail-closed.
  if (meta.engine === 'anthropic') return false
  return meta.engine === 'claude' || meta.engine === 'openai'
}

export async function withSessionCreationJournalBarrier<T>(
  retained: Set<string>,
  sessionId: string,
  activate: () => Promise<T>,
  acknowledge: () => void,
  rollback: () => Promise<void>
): Promise<T> {
  const retainAfterActivation = retained.has(sessionId)
  retained.add(sessionId)
  try {
    const result = await activate()
    if (!retainAfterActivation) {
      acknowledge()
      retained.delete(sessionId)
    }
    return result
  } catch (error) {
    await rollback()
    if (!retainAfterActivation) retained.delete(sessionId)
    throw error
  }
}

export function estimateTurnCostUsd(
  meta: SessionMeta,
  event: Extract<AgentEvent, { kind: 'turn-result' }>
): number | undefined {
  if (meta.engine !== 'openai' || !event.usage) return undefined
  const price = openAiPriceFor(meta.model)
  const inputTokens = event.usage.input + event.usage.cacheCreation
  const cost = (
    inputTokens * price.inputPerMillion +
    event.usage.cacheRead * price.cachedInputPerMillion +
    event.usage.output * price.outputPerMillion
  ) / 1_000_000
  return cost > 0 ? cost : undefined
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
  return normalized.includes('gpt-4.1')
    ? { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }
    : { inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }
}
