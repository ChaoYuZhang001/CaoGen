import type { AgentEvent, AgentEventIdentity, TaskRunRecord, TaskSnapshotReason } from '../shared/types'
import { runHasUnresolvedEffects } from './task/effect-runtime'
import { hasPendingTaskSteps, reduceTaskExecutionEvent } from './task/task-execution'
import { isTaskLedgerEvent } from './task/task-recovery'
import {
  hasTaskRunAppliedEvent,
  isTaskRunTerminal,
  recordTaskRunEvent,
  reduceTaskRunEvent,
  transitionTaskRun
} from './task/task-run'
import { supersedeToolExecution, TASK_SNAPSHOT_EVENT_INTERVAL } from './task/task-snapshot'

export interface TaskRunEventRegistry {
  get(sessionId: string): TaskRunRecord | undefined
  set(sessionId: string, run: TaskRunRecord): void
  supersedeArchivedExecution(
    sessionId: string,
    executionId: string,
    replacementExecutionId: string,
    now?: number
  ): boolean
}

export interface TaskRunEventOptions {
  cwd: string
  supervisorPauseIntent: boolean
  preserveClosedRun: boolean
}

export function handleSessionTaskRunEvent(
  registry: TaskRunEventRegistry,
  sessionId: string,
  event: AgentEvent,
  identity: AgentEventIdentity,
  options: TaskRunEventOptions
): void {
  const current = registry.get(sessionId)
  if (!current || hasTaskRunAppliedEvent(current, identity)) return
  const preserveForPause = options.supervisorPauseIntent && isCooperativeInterruptionEvent(event)
  let next = reduceSessionTaskRunEvent(current, event, identity, options, preserveForPause)
  if (isTaskLedgerEvent(event)) next = recordTaskRunEvent(next, identity, next === current)
  supersedeSuccessfulRetry(registry, sessionId, next, event)
  if (next !== current) registry.set(sessionId, next)
}

export function taskSnapshotReason(event: AgentEvent, sinceSave: number): TaskSnapshotReason | null {
  if (event.kind === 'turn-result' || (event.kind === 'status' && event.status === 'error')) {
    return 'important-event'
  }
  if (IMPORTANT_SNAPSHOT_EVENTS.has(event.kind)) return 'important-event'
  if (event.kind === 'assistant-message' && event.blocks.some((block) => block.type === 'tool_use')) {
    return 'important-event'
  }
  if (event.kind === 'status' && event.status === 'running') return 'important-event'
  return sinceSave >= TASK_SNAPSHOT_EVENT_INTERVAL ? 'event-batch' : null
}

export function isTaskSnapshotCountedEvent(event: AgentEvent): boolean {
  return event.kind !== 'text-delta' && event.kind !== 'thinking-delta'
}

export function shouldCleanupTaskSnapshot(
  event: AgentEvent,
  run: TaskRunRecord | undefined,
  blockedByEffectRecovery: boolean,
  blockedByDagFinalization: boolean
): boolean {
  if (blockedByEffectRecovery || blockedByDagFinalization) return false
  if (event.kind === 'turn-result' && !event.isError) {
    return !run || (!hasPendingTaskSteps(run) && !runHasUnresolvedEffects(run))
  }
  return event.kind === 'status' && event.status === 'closed' && !runHasUnresolvedEffects(run)
}

const IMPORTANT_SNAPSHOT_EVENTS = new Set<AgentEvent['kind']>([
  'init',
  'meta',
  'user-message',
  'checkpoint',
  'checkpoint-restore',
  'permission-request',
  'permission-resolved',
  'tool-start',
  'tool-result',
  'subagent-result',
  'task-dag-update'
])

function reduceSessionTaskRunEvent(
  current: TaskRunRecord,
  event: AgentEvent,
  identity: AgentEventIdentity,
  options: TaskRunEventOptions,
  preserveForPause: boolean
): TaskRunRecord {
  if (preserveForPause) return current
  const next = reduceTaskExecutionEvent(current, event, options.cwd, Date.now(), identity)
  if (event.kind === 'status' && event.status === 'closed') {
    return maybeCancelClosedRun(next, event, options.preserveClosedRun)
  }
  if (event.kind === 'turn-result' && hasPendingTaskSteps(next)) return next
  return reduceTaskRunEvent(next, event)
}

function maybeCancelClosedRun(
  run: TaskRunRecord,
  event: Extract<AgentEvent, { kind: 'status' }>,
  preserveClosedRun: boolean
): TaskRunRecord {
  if (preserveClosedRun || isTaskRunTerminal(run.status) || runHasUnresolvedEffects(run)) return run
  return transitionTaskRun(run, 'cancelled', { lastEventKind: event.kind })
}

function supersedeSuccessfulRetry(
  registry: TaskRunEventRegistry,
  sessionId: string,
  run: TaskRunRecord,
  event: AgentEvent
): void {
  if (event.kind !== 'tool-result' || event.isError) return
  const completed = run.toolExecutions?.find((execution) => execution.toolUseId === event.toolUseId)
  const duplicateExecutionId = completed?.duplicateOfExecutionId
  if (!completed || !duplicateExecutionId || duplicateExecutionId === completed.id) return
  registry.supersedeArchivedExecution(sessionId, duplicateExecutionId, completed.id, completed.updatedAt)
  void supersedeToolExecution(duplicateExecutionId, completed.id, completed.updatedAt).catch((error) => {
    console.error('[caogen] 更新被成功重试取代的工具记录失败:', error)
  })
}

function isCooperativeInterruptionEvent(event: AgentEvent): boolean {
  if (event.kind === 'turn-result') {
    return /interrupt|cancel|中断|取消/i.test(`${event.subtype} ${event.resultText ?? ''}`)
  }
  return event.kind === 'status' && event.status === 'error' &&
    /interrupt|cancel|中断|取消/i.test(event.error ?? '')
}
