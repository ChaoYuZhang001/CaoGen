import { createHash } from 'node:crypto'
import type {
  TaskDagAutoMergeView,
  TaskDagExecutionView,
  TaskDagFinalizationPhase,
  TaskDagFinalizationRecord,
  TaskDagFinalizationSummary,
  TaskDagFinalizationView,
  TaskDagRuntimeAutoMergeOptions,
  TaskDagRuntimeMergeSession,
  TranscriptEntry
} from '../../shared/types'

export interface CreateTaskDagFinalizationRecordInput {
  terminalExecution: TaskDagExecutionView
  autoMergeOptions?: TaskDagRuntimeAutoMergeOptions
  mergeSessions?: readonly TaskDagRuntimeMergeSession[]
  now?: number
}

export type TaskDagFinalizationTransitionPatch = Partial<
  Pick<
    TaskDagFinalizationRecord,
    | 'terminalExecution'
    | 'autoMergeOptions'
    | 'mergeSessions'
    | 'patchOperationIds'
    | 'rollbackOperationIds'
    | 'rollbackPatches'
    | 'verification'
    | 'autoMergeResult'
    | 'summary'
    | 'error'
  >
>

export interface TaskDagFinalizationSummaryReceipt {
  messageId: string
  digest: string
  eventId?: string
  seq: number
  occurredAt?: number
}

type TaskDagFinalizationState =
  | TaskDagFinalizationPhase
  | TaskDagFinalizationRecord
  | TaskDagFinalizationView

const PHASE_RANK: Readonly<Record<Exclude<TaskDagFinalizationPhase, 'waiting_reconciliation'>, number>> = {
  prepared: 0,
  merging: 1,
  verifying: 2,
  rollback_pending: 3,
  merge_settled: 4,
  summary_pending: 5,
  summary_delivered: 6,
  completed: 7
}

export function taskDagFinalizationExecutionId(execution: TaskDagExecutionView): string {
  return requireText(execution.id, 'execution.id')
}

export function taskDagFinalizationMessageId(parentSessionId: string, executionId: string): string {
  const identity = `${requireText(parentSessionId, 'parentSessionId')}\0${requireText(executionId, 'executionId')}`
  return `dag-finalization-${sha256(identity)}`
}

export function createTaskDagFinalizationRecord(
  input: CreateTaskDagFinalizationRecordInput
): TaskDagFinalizationRecord {
  assertTerminalExecution(input.terminalExecution)
  const terminalExecution = cloneExecution(input.terminalExecution)
  const executionId = taskDagFinalizationExecutionId(terminalExecution)
  const parentSessionId = requireText(terminalExecution.parentSessionId, 'parentSessionId')
  const now = finiteTimestamp(input.now ?? Date.now(), 'now')
  const autoMergeResult = terminalExecution.autoMerge
    ? cloneAutoMerge(terminalExecution.autoMerge)
    : undefined
  const summary = buildTaskDagFinalizationSummary({
    ...terminalExecution,
    ...(autoMergeResult ? { autoMerge: autoMergeResult } : {})
  })

  return {
    schemaVersion: 1,
    executionId,
    parentSessionId,
    revision: 1,
    phase: 'prepared',
    terminalExecution,
    ...(input.autoMergeOptions ? { autoMergeOptions: { ...input.autoMergeOptions } } : {}),
    mergeSessions: (input.mergeSessions ?? []).map(cloneMergeSession),
    patchOperationIds: [],
    rollbackOperationIds: [],
    rollbackPatches: [],
    verification: {
      status: 'not_started',
      ...(input.autoMergeOptions?.verificationCommand
        ? { command: input.autoMergeOptions.verificationCommand }
        : {})
    },
    ...(autoMergeResult ? { autoMergeResult } : {}),
    summary,
    createdAt: now,
    updatedAt: now
  }
}

export function transitionTaskDagFinalization(
  record: TaskDagFinalizationRecord,
  phase: TaskDagFinalizationPhase,
  patch: TaskDagFinalizationTransitionPatch = {},
  now = Date.now()
): TaskDagFinalizationRecord {
  assertPhaseTransition(record.phase, phase)
  const updatedAt = Math.max(record.updatedAt, finiteTimestamp(now, 'now'))
  const next = cloneRecord({ ...record, ...patch, phase })
  return {
    ...next,
    schemaVersion: 1,
    executionId: record.executionId,
    parentSessionId: record.parentSessionId,
    revision: record.revision + 1,
    phase,
    createdAt: record.createdAt,
    updatedAt
  }
}

export function buildTaskDagFinalizationSummary(
  execution: TaskDagExecutionView,
  messageId = taskDagFinalizationMessageId(execution.parentSessionId, execution.id)
): TaskDagFinalizationSummary {
  const text = buildParentSummaryText(execution)
  return {
    messageId: requireText(messageId, 'messageId'),
    text,
    digest: sha256(text),
    deliveryAttempts: 0
  }
}

export function buildTaskDagFinalizationSummaryForRecord(
  record: TaskDagFinalizationRecord
): TaskDagFinalizationSummary {
  const execution = cloneExecution(record.terminalExecution)
  if (record.autoMergeResult) execution.autoMerge = cloneAutoMerge(record.autoMergeResult)
  return buildTaskDagFinalizationSummary(
    execution,
    record.summary?.messageId ?? taskDagFinalizationMessageId(record.parentSessionId, record.executionId)
  )
}

export function taskDagFinalizationView(record: TaskDagFinalizationRecord): TaskDagFinalizationView {
  return {
    executionId: record.executionId,
    phase: record.phase,
    revision: record.revision,
    updatedAt: record.updatedAt,
    ...(record.summary?.messageId ? { summaryMessageId: record.summary.messageId } : {}),
    ...(record.summary?.deliveredAt !== undefined ? { deliveredAt: record.summary.deliveredAt } : {}),
    ...(record.error ? { error: record.error } : {})
  }
}

export const projectTaskDagFinalizationView = taskDagFinalizationView

export function findTaskDagFinalizationSummaryReceipt(
  transcript: readonly TranscriptEntry[],
  expected: TaskDagFinalizationSummary | TaskDagFinalizationRecord
): TaskDagFinalizationSummaryReceipt | undefined {
  const summary = isFinalizationRecord(expected) ? expected.summary : expected
  if (!summary) return undefined

  let receipt: TaskDagFinalizationSummaryReceipt | undefined
  for (const entry of transcript) {
    const event = entry.event
    if (event.kind !== 'user-message' || event.messageId !== summary.messageId) continue
    const digest = sha256(event.text)
    if (event.text !== summary.text || digest !== summary.digest) continue
    const candidate: TaskDagFinalizationSummaryReceipt = {
      messageId: summary.messageId,
      digest,
      ...(entry.eventId ? { eventId: entry.eventId } : {}),
      seq: entry.seq,
      ...(entry.occurredAt !== undefined ? { occurredAt: entry.occurredAt } : {})
    }
    if (!receipt || candidate.seq < receipt.seq) receipt = candidate
  }
  return receipt
}

/**
 * Legacy DAG summaries were sent without a stable message id. During the
 * one-time migration, accept the exact durable text/digest as the receipt,
 * while requiring it to occur at or after terminal execution completion.
 */
export function findLegacyTaskDagFinalizationSummaryReceipt(
  transcript: readonly TranscriptEntry[],
  expected: TaskDagFinalizationSummary,
  completedAt?: number
): TaskDagFinalizationSummaryReceipt | undefined {
  let receipt: TaskDagFinalizationSummaryReceipt | undefined
  for (const entry of transcript) {
    const event = entry.event
    if (event.kind !== 'user-message' || !event.messageId || event.text !== expected.text) continue
    if (sha256(event.text) !== expected.digest) continue
    // Legacy entries may omit occurredAt. Without a temporal receipt we
    // cannot prove this message was sent after terminal completion, so do not
    // infer delivery from matching text alone.
    if (entry.occurredAt === undefined) continue
    if (completedAt !== undefined && entry.occurredAt < completedAt) continue
    const candidate: TaskDagFinalizationSummaryReceipt = {
      messageId: event.messageId,
      digest: expected.digest,
      ...(entry.eventId ? { eventId: entry.eventId } : {}),
      seq: entry.seq,
      ...(entry.occurredAt !== undefined ? { occurredAt: entry.occurredAt } : {})
    }
    // More than one exact legacy match is ambiguous; migration must not guess
    // and must not fall through to a new automatic delivery.
    if (receipt) throw new Error('legacy DAG summary receipt is ambiguous')
    receipt = candidate
  }
  return receipt
}

export const findTaskDagFinalizationReceipt = findTaskDagFinalizationSummaryReceipt

export function isTaskDagFinalizationPending(state: TaskDagFinalizationState): boolean {
  const phase = finalizationPhase(state)
  return phase !== 'waiting_reconciliation' && phase !== 'completed'
}

export function isTaskDagFinalizationWaiting(state: TaskDagFinalizationState): boolean {
  return finalizationPhase(state) === 'waiting_reconciliation'
}

export function isTaskDagFinalizationCompleted(state: TaskDagFinalizationState): boolean {
  return finalizationPhase(state) === 'completed'
}

function buildParentSummaryText(execution: TaskDagExecutionView): string {
  const lines = [
    `[DAG 编排完成] ${execution.summary ?? execution.status}`,
    '',
    `需求: ${execution.dag.source}`,
    '',
    ...execution.tasks.map((task) =>
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
    ...autoMergeLines(execution.autoMerge),
    '',
    '请接管 DAG 汇总:确认成功项、处理失败项,并给出下一步合并/验证顺序。'
  ]
  return lines.join('\n\n')
}

function autoMergeLines(autoMerge: TaskDagAutoMergeView | undefined): string[] {
  if (!autoMerge) return []
  return [
    '',
    '## DAG 自动合并',
    autoMerge.summary ?? autoMerge.status,
    autoMerge.verification?.command ? `验收命令: ${autoMerge.verification.command}` : '',
    autoMerge.error ? `错误: ${autoMerge.error}` : ''
  ].filter(Boolean)
}

function assertTerminalExecution(execution: TaskDagExecutionView): void {
  if (execution.status !== 'success' && execution.status !== 'failed') {
    throw new Error(`DAG finalization requires a terminal execution: ${execution.status}`)
  }
  finiteTimestamp(execution.completedAt, 'terminalExecution.completedAt')
}

function assertPhaseTransition(current: TaskDagFinalizationPhase, next: TaskDagFinalizationPhase): void {
  if (current === next) return
  if (current === 'completed') throw new Error('Completed DAG finalization records are immutable')
  if (next === 'waiting_reconciliation') return
  if (current === 'waiting_reconciliation') {
    if (next === 'prepared') throw new Error('DAG finalization cannot return to prepared')
    return
  }
  if (next === 'completed' || PHASE_RANK[next] >= PHASE_RANK[current]) return
  throw new Error(`DAG finalization phase cannot move backward: ${current} -> ${next}`)
}

function cloneRecord(record: TaskDagFinalizationRecord): TaskDagFinalizationRecord {
  return {
    ...record,
    terminalExecution: cloneExecution(record.terminalExecution),
    ...(record.autoMergeOptions ? { autoMergeOptions: { ...record.autoMergeOptions } } : {}),
    mergeSessions: record.mergeSessions.map(cloneMergeSession),
    patchOperationIds: [...record.patchOperationIds],
    rollbackOperationIds: [...record.rollbackOperationIds],
    ...(record.rollbackPatches
      ? { rollbackPatches: record.rollbackPatches.map((patch) => ({ ...patch })) }
      : {}),
    verification: {
      ...record.verification,
      ...(record.verification.result ? { result: { ...record.verification.result } } : {})
    },
    ...(record.autoMergeResult ? { autoMergeResult: cloneAutoMerge(record.autoMergeResult) } : {}),
    ...(record.summary ? { summary: { ...record.summary } } : {})
  }
}

function cloneExecution(execution: TaskDagExecutionView): TaskDagExecutionView {
  const { finalization: _finalization, ...rest } = execution
  return {
    ...rest,
    dag: {
      ...execution.dag,
      tasks: execution.dag.tasks.map((task) => ({
        ...task,
        dependencies: [...task.dependencies]
      }))
    },
    layers: execution.layers.map((layer) => [...layer]),
    tasks: execution.tasks.map((task) => ({
      ...task,
      task: { ...task.task, dependencies: [...task.task.dependencies] },
      sessionIds: [...task.sessionIds]
    })),
    ...(execution.autoMerge ? { autoMerge: cloneAutoMerge(execution.autoMerge) } : {})
  }
}

function cloneAutoMerge(autoMerge: TaskDagAutoMergeView): TaskDagAutoMergeView {
  return {
    ...autoMerge,
    entries: autoMerge.entries.map((entry) => ({
      ...entry,
      ...(entry.conflicts ? { conflicts: entry.conflicts.map((conflict) => ({ ...conflict })) } : {})
    })),
    ...(autoMerge.verification ? { verification: { ...autoMerge.verification } } : {}),
    ...(autoMerge.rollback
      ? {
          rollback: {
            ...autoMerge.rollback,
            ...(autoMerge.rollback.entries
              ? { entries: autoMerge.rollback.entries.map((entry) => ({ ...entry })) }
              : {})
          }
        }
      : {})
  }
}

function cloneMergeSession(session: TaskDagRuntimeMergeSession): TaskDagRuntimeMergeSession {
  return { ...session }
}

function finalizationPhase(state: TaskDagFinalizationState): TaskDagFinalizationPhase {
  return typeof state === 'string' ? state : state.phase
}

function isFinalizationRecord(
  value: TaskDagFinalizationSummary | TaskDagFinalizationRecord
): value is TaskDagFinalizationRecord {
  return 'schemaVersion' in value && 'terminalExecution' in value
}

function finiteTimestamp(value: number | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  return value
}

function requireText(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must not be empty`)
  return normalized
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
