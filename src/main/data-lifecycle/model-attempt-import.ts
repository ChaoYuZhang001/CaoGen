import type {
  ModelAttemptEventKind,
  ModelAttemptLedgerVerification,
  ModelAttemptRecord
} from '../../shared/model-attempt-types'
import {
  modelAttemptCorruption,
  modelAttemptError,
  rawDigest,
  requiredId
} from '../../shared/model-attempt-types'
import {
  appendModelAttemptEvent,
  deriveModelAttemptNext,
  findRawModelAttempt,
  insertModelAttempt,
  modelAttemptStartRecordVersion,
  modelAttemptWithoutDerived,
  readModelAttemptLedgerMeta,
  setupModelAttemptSchema,
  updateModelAttempt,
  updateModelAttemptLedgerMeta,
  type ModelAttemptLedgerMeta
} from '../task/model-attempt-schema'
import { verifyModelAttemptLedger } from '../task/model-attempt-store'
import type { WorkflowLedgerDatabase } from '../task/workflow-ledger-db'
import { canonicalJson, digest } from '../task/workflow-ledger-codec'
import { findWorkflowRun } from '../task/workflow-ledger-store'

export function importModelAttemptRecords(
  db: WorkflowLedgerDatabase,
  values: readonly ModelAttemptRecord[]
): ModelAttemptRecord[] {
  setupModelAttemptSchema(db)
  verifyModelAttemptLedger(db)
  const records = values.map(normalizePortableAttempt).sort(byAttempt)
  for (const source of records) importOneAttempt(db, source)
  verifyModelAttemptLedger(db)
  return records.map((record) => deriveModelAttemptNext(record, records))
}

function importOneAttempt(db: WorkflowLedgerDatabase, source: ModelAttemptRecord): void {
  const existing = findRawModelAttempt(db, source.id)
  if (existing) {
    assertSameAttempt(existing, source)
    return
  }
  assertCanonicalOwnership(db, source)
  const start = modelAttemptStartRecordVersion(source)
  const startMeta = currentMeta(db)
  insertModelAttempt(db, start)
  const startEvent = appendModelAttemptEvent(db, {
    commandId: start.startCommandId,
    attempt: start,
    kind: 'model_attempt.started',
    occurredAt: start.startedAt,
    inputDigest: rawDigest(start.startPayloadDigest, 'portable start payload digest')
  })
  const completionMeta = advanceMeta(db, startMeta, startEvent, 1)
  if (source.status === 'started') {
    assertSameAttempt(start, source)
    return
  }
  updateModelAttempt(db, source, 1)
  const completionEvent = appendModelAttemptEvent(db, {
    commandId: requiredId(source.completionCommandId, 'portable completion command id'),
    attempt: source,
    kind: eventKind(source.status),
    occurredAt: source.completedAt as number,
    inputDigest: rawDigest(source.completionPayloadDigest, 'portable completion payload digest')
  })
  advanceMeta(db, completionMeta, completionEvent, 0)
}

function normalizePortableAttempt(value: ModelAttemptRecord): ModelAttemptRecord {
  const { nextAttemptId: _nextAttemptId, ...record } = structuredClone(value)
  requiredId(record.id, 'portable Attempt id')
  requiredId(record.runId, 'portable Attempt run id')
  if (record.recordDigest !== digest(modelAttemptWithoutDerived(record))) {
    modelAttemptCorruption(`Portable Attempt ${record.id} record digest is invalid`)
  }
  modelAttemptStartRecordVersion(record)
  return record
}

function assertCanonicalOwnership(db: WorkflowLedgerDatabase, attempt: ModelAttemptRecord): void {
  const run = findWorkflowRun(db, attempt.runId)
  if (!run) throw modelAttemptError('MODEL_ATTEMPT_RUN_NOT_FOUND', `Portable Attempt Run is missing: ${attempt.runId}`)
  if (run.projectId !== attempt.projectId || run.goalId !== attempt.goalId || run.workItemId !== attempt.workItemId) {
    throw modelAttemptError(
      'MODEL_ATTEMPT_OWNERSHIP_MISMATCH',
      `Portable Attempt ${attempt.id} ownership differs from canonical Run ${run.id}`
    )
  }
}

function currentMeta(db: WorkflowLedgerDatabase): ModelAttemptLedgerMeta {
  const verification = verifyModelAttemptLedger(db)
  const stored = readModelAttemptLedgerMeta(db)
  assertMetaMatchesVerification(stored, verification)
  return stored
}

function assertMetaMatchesVerification(
  meta: ModelAttemptLedgerMeta,
  verification: ModelAttemptLedgerVerification
): void {
  if (!meta.initialized || meta.attemptCount !== verification.attempts ||
      meta.eventCount !== verification.events || meta.lastSeq !== verification.lastSeq ||
      meta.lastDigest !== verification.lastDigest) {
    modelAttemptCorruption('Portable Attempt import observed inconsistent ledger metadata')
  }
}

function advanceMeta(
  db: WorkflowLedgerDatabase,
  expected: ModelAttemptLedgerMeta,
  event: { seq: number; digest: string },
  attemptDelta: number
): ModelAttemptLedgerMeta {
  const next = {
    attemptCount: expected.attemptCount + attemptDelta,
    eventCount: expected.eventCount + 1,
    lastSeq: event.seq,
    lastDigest: event.digest
  }
  updateModelAttemptLedgerMeta(db, expected, next)
  return { initialized: true, ...next }
}

function assertSameAttempt(actual: ModelAttemptRecord, expected: ModelAttemptRecord): void {
  const { nextAttemptId: _actualNext, ...actualStored } = actual
  const { nextAttemptId: _expectedNext, ...expectedStored } = expected
  if (canonicalJson(actualStored) !== canonicalJson(expectedStored)) {
    throw modelAttemptError(
      'MODEL_ATTEMPT_ID_CONFLICT',
      `Imported Attempt ${expected.id} differs from its portable source`
    )
  }
}

function eventKind(status: ModelAttemptRecord['status']): ModelAttemptEventKind {
  if (status === 'succeeded') return 'model_attempt.succeeded'
  if (status === 'failed') return 'model_attempt.failed'
  if (status === 'cancelled') return 'model_attempt.cancelled'
  throw modelAttemptCorruption('Portable Attempt completion is not terminal')
}

function byAttempt(left: ModelAttemptRecord, right: ModelAttemptRecord): number {
  return left.startedAt - right.startedAt || left.ordinal - right.ordinal || left.id.localeCompare(right.id)
}
