import type {
  AgentEvent,
  TaskRunRecord,
  TaskSnapshotRecord,
  TranscriptEntry
} from '../../shared/types'
import {
  readEventReceipts,
  readTranscriptEntries,
  type EventReceipt
} from '../transcript'
import {
  hasTaskRunAppliedEvent,
  recordTaskRunEvent,
  reduceTaskRunEvent
} from './task-run'
import {
  hasPendingTaskSteps,
  reduceTaskExecutionEvent
} from './task-execution'
import { hasUnresolvedEffects } from './effect-ledger'

export function reconcileSnapshotWithReceipts(snapshot: TaskSnapshotRecord): {
  snapshot: TaskSnapshotRecord
  terminalRun?: TaskRunRecord
} {
  const sdkSessionId = snapshot.execution.sdkSessionId ?? snapshot.meta.sdkSessionId
  if (!sdkSessionId) return { snapshot }
  const baseSeq = snapshot.execution.cursor?.seq ?? snapshot.execution.lastSeq
  const byEventId = new Map<string, EventReceipt>()
  const transcriptByEventId = new Map<string, TranscriptEntry>()
  for (const receipt of readEventReceipts(sdkSessionId)) {
    if (receipt.seq > baseSeq) byEventId.set(receipt.eventId, receipt)
  }
  const fullTranscript = readTranscriptEntries(sdkSessionId)
  for (const entry of fullTranscript) {
    if (entry.seq <= baseSeq || !entry.eventId || !entry.streamId) continue
    transcriptByEventId.set(entry.eventId, entry)
    const receipt = receiptFromTranscriptEntry(entry, snapshot.updatedAt)
    byEventId.set(receipt.eventId, { ...receipt, ...(byEventId.get(receipt.eventId) ?? {}) })
  }
  const receipts = [...byEventId.values()].sort((left, right) => left.seq - right.seq)
  if (receipts.length === 0) return { snapshot }

  let run = snapshot.run
  let successfulTerminal = false
  for (const receipt of receipts) {
    if (!run || hasTaskRunAppliedEvent(run, receipt)) continue
    let changed = false
    const transcriptEntry = transcriptByEventId.get(receipt.eventId)
    if (transcriptEntry) {
      const previous = run
      run = reduceTaskExecutionEvent(
        run,
        transcriptEntry.event,
        snapshot.meta.cwd,
        receipt.occurredAt,
        receipt
      )
      if (!(transcriptEntry.event.kind === 'turn-result' && hasPendingTaskSteps(run))) {
        run = reduceTaskRunEvent(run, transcriptEntry.event, receipt.occurredAt)
      }
      if (
        transcriptEntry.event.kind === 'turn-result' &&
        transcriptEntry.event.isError === false &&
        !hasPendingTaskSteps(run) &&
        !hasUnresolvedEffects(run)
      ) {
        successfulTerminal = true
      }
      changed = run !== previous
    } else {
      const reconciled = applyReceiptOnly(run, receipt)
      run = reconciled.run
      changed = reconciled.changed
      successfulTerminal ||= reconciled.successfulTerminal
    }
    run = recordTaskRunEvent(run, receipt, !changed)
  }

  const lastReceipt = receipts[receipts.length - 1]
  const nextSnapshot: TaskSnapshotRecord = {
    ...snapshot,
    updatedAt: Math.max(snapshot.updatedAt, lastReceipt.occurredAt),
    eventCount: snapshot.eventCount + receipts.length,
    execution: {
      ...snapshot.execution,
      lastSeq: lastReceipt.seq,
      cursor: { seq: lastReceipt.seq, eventId: lastReceipt.eventId },
      lastEventId: lastReceipt.eventId,
      lastEventKind: lastReceipt.kind,
      lastEventAt: lastReceipt.occurredAt
    },
    transcript: fullTranscript.length > 0 ? fullTranscript : snapshot.transcript,
    ...(run ? { run } : {})
  }
  return successfulTerminal && run ? { snapshot: nextSnapshot, terminalRun: run } : { snapshot: nextSnapshot }
}

function receiptFromTranscriptEntry(entry: TranscriptEntry, fallbackAt: number): EventReceipt {
  const event = entry.event
  const receipt: EventReceipt = {
    schemaVersion: 1,
    streamId: entry.streamId ?? 'legacy-stream',
    eventId: entry.eventId ?? `legacy-event:${entry.seq}`,
    seq: entry.seq,
    occurredAt: entry.occurredAt ?? fallbackAt,
    kind: event.kind,
    ...(entry.causationId ? { causationId: entry.causationId } : {}),
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {})
  }
  if (event.kind === 'tool-result') {
    receipt.toolUseId = event.toolUseId
    receipt.isError = event.isError
  } else if (event.kind === 'turn-result') {
    receipt.isError = event.isError
  } else if (event.kind === 'permission-resolved') {
    receipt.requestId = event.requestId
    receipt.behavior = event.behavior
  }
  return receipt
}

function applyReceiptOnly(
  run: TaskRunRecord,
  receipt: EventReceipt
): { run: TaskRunRecord; changed: boolean; successfulTerminal: boolean } {
  if (receipt.kind === 'permission-resolved' && receipt.requestId) {
    return {
      run: {
        ...run,
        revision: run.revision + 1,
        updatedAt: Math.max(run.updatedAt, receipt.occurredAt),
        toolExecutions: (run.toolExecutions ?? []).map((execution) =>
          execution.requestId === receipt.requestId
            ? {
                ...execution,
                status: receipt.behavior === 'deny' ? 'cancelled' : 'approved',
                permissionDecision: receipt.behavior,
                approvalResolvedEventId: receipt.eventId,
                lastEventId: receipt.eventId,
                lastEventSeq: receipt.seq,
                updatedAt: receipt.occurredAt,
                finishedAt: receipt.behavior === 'deny' ? receipt.occurredAt : execution.finishedAt
              }
            : execution
        )
      },
      changed: true,
      successfulTerminal: false
    }
  }
  if (receipt.kind === 'tool-result' && receipt.toolUseId) {
    return {
      run: {
        ...run,
        revision: run.revision + 1,
        updatedAt: Math.max(run.updatedAt, receipt.occurredAt),
        toolExecutions: (run.toolExecutions ?? []).map((execution) =>
          execution.toolUseId === receipt.toolUseId
            ? {
                ...execution,
                status: receipt.isError ? 'failed' : 'succeeded',
                resultEventId: receipt.eventId,
                lastEventId: receipt.eventId,
                lastEventSeq: receipt.seq,
                updatedAt: receipt.occurredAt,
                finishedAt: receipt.occurredAt,
                error: receipt.isError ? '工具执行失败，详情见转录记录' : undefined
              }
            : execution
        )
      },
      changed: true,
      successfulTerminal: false
    }
  }
  if (receipt.kind !== 'turn-result') {
    return { run, changed: false, successfulTerminal: false }
  }

  const status: TaskRunRecord['status'] = receipt.isError ? 'failed' : 'completed'
  let finishedOne = false
  const steps: NonNullable<TaskRunRecord['steps']> = (run.steps ?? []).map((step) => {
    if (
      finishedOne ||
      step.status === 'completed' ||
      step.status === 'failed' ||
      step.status === 'cancelled'
    ) {
      return step
    }
    finishedOne = true
    return {
      ...step,
      status,
      updatedAt: receipt.occurredAt,
      finishedAt: receipt.occurredAt,
      pendingPermissionRequestId: undefined,
      lastEventId: receipt.eventId,
      lastEventSeq: receipt.seq,
      lastEventKind: 'turn-result' as const
    }
  })
  const pending = steps.some((step) => !isTerminalStepStatus(step.status))
  const unresolvedEffects = hasUnresolvedEffects(run)
  const nextStatus: TaskRunRecord['status'] = pending
    ? 'executing'
    : unresolvedEffects
      ? 'waiting_reconciliation'
      : status
  const next: TaskRunRecord = {
    ...run,
    status: nextStatus,
    revision: run.revision + 1,
    updatedAt: Math.max(run.updatedAt, receipt.occurredAt),
    finishedAt: pending || unresolvedEffects ? undefined : receipt.occurredAt,
    pendingPermissionRequestId: undefined,
    lastEventKind: 'turn-result',
    error: receipt.isError ? run.error ?? '恢复时发现已落盘的失败轮次' : undefined,
    steps
  }
  return {
    run: next,
    changed: true,
    successfulTerminal: !receipt.isError && !pending && !unresolvedEffects
  }
}

function isTerminalStepStatus(status: TaskRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function isTaskLedgerEvent(event: AgentEvent): boolean {
  if (event.kind === 'assistant-message') {
    return event.blocks.some((block) => block.type === 'tool_use')
  }
  return (
    event.kind === 'user-message' ||
    event.kind === 'status' ||
    event.kind === 'permission-request' ||
    event.kind === 'permission-resolved' ||
    event.kind === 'tool-start' ||
    event.kind === 'tool-result' ||
    event.kind === 'turn-result'
  )
}
