import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventIdentity, TaskRunRecord, TaskRunStatus } from '../../shared/types'
import { isTaskStepRecord, isToolExecutionRecord } from './task-execution'

const TERMINAL_STATUSES = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled'])
const RECENT_EVENT_IDS_LIMIT = 128

const ALLOWED_TRANSITIONS: Record<TaskRunStatus, ReadonlySet<TaskRunStatus>> = {
  queued: new Set(['planning', 'executing', 'recovering', 'completed', 'failed', 'cancelled']),
  planning: new Set(['executing', 'waiting_approval', 'recovering', 'completed', 'failed', 'cancelled']),
  executing: new Set(['waiting_approval', 'verifying', 'recovering', 'completed', 'failed', 'cancelled']),
  waiting_approval: new Set(['executing', 'recovering', 'failed', 'cancelled']),
  verifying: new Set(['executing', 'waiting_approval', 'recovering', 'completed', 'failed', 'cancelled']),
  recovering: new Set(['planning', 'executing', 'waiting_approval', 'verifying', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(['recovering']),
  cancelled: new Set()
}

export interface CreateTaskRunInput {
  sessionId: string
  taskId: string
  now?: number
  id?: string
}

export interface TaskRunTransitionOptions {
  now?: number
  lastEventKind?: AgentEvent['kind']
  messageId?: string
  pendingPermissionRequestId?: string
  error?: string
}

export function createTaskRun(input: CreateTaskRunInput): TaskRunRecord {
  const now = input.now ?? Date.now()
  return {
    schemaVersion: 1,
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    status: 'queued',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now,
    steps: [],
    toolExecutions: []
  }
}

export function isTaskRunTerminal(status: TaskRunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function hasTaskRunAppliedEvent(current: TaskRunRecord, identity: AgentEventIdentity): boolean {
  if (current.recentEventIds?.includes(identity.eventId)) return true
  return typeof current.lastAppliedEventSeq === 'number' && identity.seq <= current.lastAppliedEventSeq
}

export function recordTaskRunEvent(
  current: TaskRunRecord,
  identity: AgentEventIdentity,
  bumpRevision = false
): TaskRunRecord {
  const recentEventIds = [...(current.recentEventIds ?? []), identity.eventId].slice(-RECENT_EVENT_IDS_LIMIT)
  return {
    ...current,
    revision: bumpRevision ? current.revision + 1 : current.revision,
    lastAppliedEventId: identity.eventId,
    lastAppliedEventSeq: identity.seq,
    recentEventIds
  }
}

export function transitionTaskRun(
  current: TaskRunRecord,
  status: TaskRunStatus,
  options: TaskRunTransitionOptions = {}
): TaskRunRecord {
  const now = options.now ?? Date.now()
  if (status !== current.status && !ALLOWED_TRANSITIONS[current.status].has(status)) {
    throw new Error(`非法 TaskRun 状态转换:${current.status} -> ${status}`)
  }
  const recoveringAgain = status === 'recovering' && current.status !== 'recovering'
  const terminal = isTaskRunTerminal(status)
  return {
    ...current,
    status,
    revision: current.revision + 1,
    attempt: recoveringAgain ? current.attempt + 1 : current.attempt,
    recoveryCount: recoveringAgain ? current.recoveryCount + 1 : current.recoveryCount,
    updatedAt: now,
    startedAt: current.startedAt ?? (status === 'planning' || status === 'executing' ? now : undefined),
    finishedAt: terminal ? now : undefined,
    lastEventKind: options.lastEventKind ?? current.lastEventKind,
    messageId: options.messageId ?? current.messageId,
    pendingPermissionRequestId:
      status === 'waiting_approval'
        ? options.pendingPermissionRequestId ?? current.pendingPermissionRequestId
        : undefined,
    error: status === 'failed' ? options.error ?? current.error ?? '任务执行失败' : undefined
  }
}

export function reduceTaskRunEvent(current: TaskRunRecord, event: AgentEvent, now = Date.now()): TaskRunRecord {
  if (event.kind === 'user-message' && current.status === 'queued') {
    return transitionTaskRun(current, 'planning', {
      now,
      lastEventKind: event.kind,
      messageId: event.messageId
    })
  }
  if (
    event.kind === 'status' &&
    event.status === 'running' &&
    (current.status === 'queued' || current.status === 'planning' || current.status === 'recovering')
  ) {
    return transitionTaskRun(current, 'executing', { now, lastEventKind: event.kind })
  }
  if (
    event.kind === 'tool-start' &&
    (current.status === 'queued' || current.status === 'planning' || current.status === 'recovering')
  ) {
    return transitionTaskRun(current, 'executing', { now, lastEventKind: event.kind })
  }
  if (event.kind === 'permission-request' && !isTaskRunTerminal(current.status)) {
    return transitionTaskRun(current, 'waiting_approval', {
      now,
      lastEventKind: event.kind,
      pendingPermissionRequestId: event.request.requestId
    })
  }
  if (event.kind === 'permission-resolved' && current.status === 'waiting_approval') {
    const pending = current.toolExecutions?.find((execution) => execution.status === 'waiting_approval')
    if (pending) {
      return transitionTaskRun(current, 'waiting_approval', {
        now,
        lastEventKind: event.kind,
        pendingPermissionRequestId: pending.requestId
      })
    }
    return transitionTaskRun(current, 'executing', { now, lastEventKind: event.kind })
  }
  if (event.kind === 'turn-result' && !isTaskRunTerminal(current.status)) {
    const interrupted = event.isError && /interrupt|cancel/i.test(event.subtype ?? '')
    return transitionTaskRun(current, interrupted ? 'cancelled' : event.isError ? 'failed' : 'completed', {
      now,
      lastEventKind: event.kind,
      error: event.isError ? event.resultText ?? event.subtype : undefined
    })
  }
  if (event.kind === 'status' && event.status === 'error' && !isTaskRunTerminal(current.status)) {
    return transitionTaskRun(current, 'failed', {
      now,
      lastEventKind: event.kind,
      error: event.error
    })
  }
  return current
}

export function isTaskRunRecord(value: unknown): value is TaskRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === 1 &&
    typeof record.id === 'string' &&
    typeof record.sessionId === 'string' &&
    typeof record.taskId === 'string' &&
    typeof record.status === 'string' &&
    Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, record.status) &&
    typeof record.revision === 'number' && Number.isInteger(record.revision) && record.revision > 0 &&
    typeof record.attempt === 'number' && Number.isInteger(record.attempt) && record.attempt > 0 &&
    typeof record.recoveryCount === 'number' && Number.isInteger(record.recoveryCount) && record.recoveryCount >= 0 &&
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) &&
    (record.startedAt === undefined || (typeof record.startedAt === 'number' && Number.isFinite(record.startedAt))) &&
    (record.finishedAt === undefined || (typeof record.finishedAt === 'number' && Number.isFinite(record.finishedAt))) &&
    (record.messageId === undefined || typeof record.messageId === 'string') &&
    (record.pendingPermissionRequestId === undefined || typeof record.pendingPermissionRequestId === 'string') &&
    (record.lastAppliedEventId === undefined || typeof record.lastAppliedEventId === 'string') &&
    (record.lastAppliedEventSeq === undefined ||
      (typeof record.lastAppliedEventSeq === 'number' &&
        Number.isInteger(record.lastAppliedEventSeq) &&
        record.lastAppliedEventSeq >= 0)) &&
    (record.recentEventIds === undefined ||
      (Array.isArray(record.recentEventIds) &&
        record.recentEventIds.length <= RECENT_EVENT_IDS_LIMIT &&
        record.recentEventIds.every((eventId) => typeof eventId === 'string'))) &&
    (record.lastEventKind === undefined || typeof record.lastEventKind === 'string') &&
    (record.error === undefined || typeof record.error === 'string') &&
    (record.steps === undefined || (Array.isArray(record.steps) && record.steps.every(isTaskStepRecord))) &&
    (record.toolExecutions === undefined ||
      (Array.isArray(record.toolExecutions) && record.toolExecutions.every(isToolExecutionRecord)))
  )
}
