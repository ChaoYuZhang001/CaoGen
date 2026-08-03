import {
  modelAttemptCorruption,
  requiredId,
  type ModelAttemptEventRecord,
  type ModelAttemptRecord
} from '../../shared/model-attempt-types'
import {
  insertModelAttempt,
  modelAttemptSchemaExists,
  readModelAttemptEvents,
  readModelAttemptLedgerMeta,
  readRawModelAttempts
} from './model-attempt-schema'
import { verifyModelAttemptLedger } from './model-attempt-store'
import { canonicalJson, digest, GENESIS_DIGEST } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'

const ATTEMPTS_TABLE = 'model_attempts'
const EVENTS_TABLE = 'model_attempt_events'
const META_TABLE = 'model_attempt_meta'

export interface ModelAttemptProjectPurgeResult {
  removedAttempts: number
  removedEvents: number
  remainingAttempts: number
  remainingEvents: number
}

export function purgeModelAttemptsProject(
  db: WorkflowLedgerDatabase,
  projectId: string,
  runIds: ReadonlySet<string> = new Set()
): ModelAttemptProjectPurgeResult {
  const id = requiredId(projectId, 'project purge projectId')
  const before = verifyModelAttemptLedger(db)
  if (!modelAttemptSchemaExists(db)) {
    return { removedAttempts: 0, removedEvents: 0, remainingAttempts: 0, remainingEvents: 0 }
  }
  const attempts = readRawModelAttempts(db)
  const removedIds = new Set(attempts
    .filter((attempt) => attempt.projectId === id || runIds.has(attempt.runId))
    .map((attempt) => attempt.id))
  const remainingAttempts = attempts.filter((attempt) => !removedIds.has(attempt.id))
  assertFailoverSourcesRemain(remainingAttempts, removedIds)
  const events = readModelAttemptEvents(db)
  const remainingEvents = events.filter((event) => !removedIds.has(event.attemptId) && !runIds.has(event.runId))
  if (removedIds.size > 0 || remainingEvents.length !== events.length) {
    rewriteModelAttemptLedger(db, remainingAttempts, remainingEvents)
  }
  const after = verifyModelAttemptLedger(db)
  return {
    removedAttempts: before.attempts - after.attempts,
    removedEvents: before.events - after.events,
    remainingAttempts: after.attempts,
    remainingEvents: after.events
  }
}

function assertFailoverSourcesRemain(
  attempts: readonly ModelAttemptRecord[],
  removedIds: ReadonlySet<string>
): void {
  for (const attempt of attempts) {
    if (attempt.failoverFromAttemptId && removedIds.has(attempt.failoverFromAttemptId)) {
      modelAttemptCorruption(`Project purge would leave Attempt ${attempt.id} with a deleted failover source`)
    }
  }
}

function rewriteModelAttemptLedger(
  db: WorkflowLedgerDatabase,
  attempts: readonly ModelAttemptRecord[],
  events: readonly ModelAttemptEventRecord[]
): void {
  if (!modelAttemptSchemaExists(db)) return
  db.run(`DELETE FROM ${EVENTS_TABLE}`)
  const existing = readRawModelAttempts(db).sort((left, right) =>
    right.ordinal - left.ordinal || right.startedAt - left.startedAt || right.id.localeCompare(left.id))
  for (const attempt of existing) db.run(`DELETE FROM ${ATTEMPTS_TABLE} WHERE id = ?`, [attempt.id])
  for (const attempt of attempts) insertModelAttempt(db, attempt)
  const lastDigest = rewriteEvents(db, events)
  db.run(
    `UPDATE ${META_TABLE} SET attempt_count = ?, event_count = ?, last_seq = ?, last_digest = ? WHERE id = 1`,
    [attempts.length, events.length, events.length, lastDigest]
  )
  readModelAttemptLedgerMeta(db)
  readRawModelAttempts(db)
  readModelAttemptEvents(db)
}

function rewriteEvents(db: WorkflowLedgerDatabase, events: readonly ModelAttemptEventRecord[]): string {
  let previousDigest = GENESIS_DIGEST
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index]
    const withoutDigest = {
      schemaVersion: 1 as const,
      seq: index + 1,
      eventId: current.eventId,
      commandId: current.commandId,
      attemptId: current.attemptId,
      runId: current.runId,
      kind: current.kind,
      revision: current.revision,
      occurredAt: current.occurredAt,
      prevDigest: previousDigest,
      payload: current.payload
    }
    const rebuilt: ModelAttemptEventRecord = { ...withoutDigest, digest: digest(withoutDigest) }
    db.run(
      `INSERT INTO ${EVENTS_TABLE}(
         seq, event_id, command_id, attempt_id, run_id, kind, revision,
         occurred_at, prev_digest, record_digest, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rebuilt.seq, rebuilt.eventId, rebuilt.commandId, rebuilt.attemptId, rebuilt.runId,
        rebuilt.kind, rebuilt.revision, rebuilt.occurredAt, rebuilt.prevDigest,
        rebuilt.digest, canonicalJson(rebuilt.payload)
      ]
    )
    previousDigest = rebuilt.digest
  }
  return previousDigest
}
