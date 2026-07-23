import type { TaskEvidenceRecord } from './task-evidence-store'
import { selectTaskEvidence } from './task-evidence-store'
import type { WorkflowRunRecord } from '../../shared/workflow-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { findEventById, readAndVerifyEvents } from './workflow-ledger-query'
import {
  appendWorkflowEvent,
  findWorkflowRun
} from './workflow-ledger-store'

/**
 * Projects the durable Effect evidence chain into the Workflow event stream.
 * Only identifiers, digests, and verification metadata cross the boundary;
 * raw tool input/output never enters the Workflow Ledger.
 */
export function projectTaskEvidenceIntoWorkflow(
  db: WorkflowLedgerDatabase,
  scope: { runId?: string } = {}
): boolean {
  const records = selectTaskEvidence(db, scope).sort((left, right) => left.seq - right.seq)
  if (records.length === 0) return false
  const projections = records.map((record) => ({
    record,
    eventId: `workflow:evidence:${record.evidenceId}`,
    run: validateEvidenceSource(db, record)
  }))
  const existingEventIds = new Set(
    readAndVerifyEvents(db, {
      requireTaskEvidenceCoverage: false,
      requireProjectionBinding: false
    })
      .filter((event) => event.kind === 'workflow.effect.evidence')
      .map((event) => event.eventId)
  )
  let changed = false
  for (const { record, eventId, run } of projections) {
    if (existingEventIds.has(eventId)) continue
    changed = projectEvidenceRecord(db, record, run) || changed
    existingEventIds.add(eventId)
  }
  return changed
}

function projectEvidenceRecord(
  db: WorkflowLedgerDatabase,
  record: TaskEvidenceRecord,
  run: WorkflowRunRecord
): boolean {
  const eventId = `workflow:evidence:${record.evidenceId}`
  const wasMissing = !findEventById(db, eventId)
  appendWorkflowEvent(db, {
    eventId,
    streamId: `run:${record.runId}`,
    entityType: 'run',
    entityId: record.runId,
    kind: 'workflow.effect.evidence',
    payload: evidenceEventPayload(record),
    occurredAt: record.observedAt,
    causationId: record.id,
    correlationId: record.operationId ?? record.runId
  }, {
    projectId: record.projectId ?? run.projectId,
    goalId: run.goalId,
    workItemId: run.workItemId,
    runId: run.id,
    sessionId: run.sessionId
  })
  return wasMissing
}

function validateEvidenceSource(
  db: WorkflowLedgerDatabase,
  record: TaskEvidenceRecord
): WorkflowRunRecord {
  const run = findWorkflowRun(db, record.runId)
  if (!run) {
    throw new WorkflowLedgerCorruptionError(
      `evidence ${record.evidenceId} references missing Workflow Run ${record.runId}`
    )
  }
  assertEvidenceRunOwnership(record, run)
  assertEvidenceEffectMatch(record, run)
  return run
}

function assertEvidenceRunOwnership(record: TaskEvidenceRecord, run: WorkflowRunRecord): void {
  if (record.sessionId === run.sessionId && record.taskId === run.taskRun.taskId &&
      (record.projectId === undefined || record.projectId === run.projectId)) return
  if (record.sessionId !== run.sessionId || record.taskId !== run.taskRun.taskId) {
    throw new WorkflowLedgerCorruptionError(
      `evidence ${record.evidenceId} session/task ownership differs from Workflow Run ${run.id}`
    )
  }
  throw new WorkflowLedgerCorruptionError(
    `evidence ${record.evidenceId} crosses project boundary from ${run.projectId} to ${record.projectId}`
  )
}

function assertEvidenceEffectMatch(record: TaskEvidenceRecord, run: WorkflowRunRecord): void {
  const effect = (run.taskRun.effects ?? []).find((candidate) => candidate.id === record.effectId)
  const sourceEvidence = effect?.evidence.find((candidate) => candidate.id === record.evidenceId)
  const matches = effect && sourceEvidence && effect.generation === record.generation &&
    sourceEvidence.generation === record.generation && sourceEvidence.digest === record.evidenceDigest &&
    effect.effectKey === record.effectKey && effect.targetDigest === record.targetDigest
  if (matches) return
  throw new WorkflowLedgerCorruptionError(
    `evidence ${record.evidenceId} no longer matches Effect ${record.effectId} in Workflow Run ${run.id}`
  )
}

function evidenceEventPayload(record: TaskEvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: record.evidenceId,
    evidenceSeq: record.seq,
    effectId: record.effectId,
    kind: record.kind,
    generation: record.generation,
    observedAt: record.observedAt,
    verifier: record.verifier,
    evidenceDigest: record.evidenceDigest,
    effectKey: record.effectKey,
    targetDigest: record.targetDigest,
    taskEvidenceRecordDigest: record.digest,
    taskEvidencePrevDigest: record.prevDigest,
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {})
  }
}
