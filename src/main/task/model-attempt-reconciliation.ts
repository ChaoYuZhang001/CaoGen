import {
  isRetryAuthorizedModelAttempt,
  modelAttemptCorruption,
  modelAttemptError,
  optionalId,
  positiveInteger,
  requiredId,
  type ModelAttemptReconciliationQuery,
  type ModelAttemptReconciliationResolution,
  type ModelAttemptReconciliationView,
  type ModelAttemptRecord
} from '../../shared/model-attempt-types'
import { digest } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import {
  completeReconciledModelAttempt,
  getModelAttempt,
  verifyModelAttemptLedger
} from './model-attempt-store'
import {
  deriveModelAttemptNext,
  modelAttemptSchemaExists,
  readRawModelAttempts
} from './model-attempt-schema'

const MAX_RECONCILIATION_LIMIT = 500

interface NormalizedReconciliationQuery {
  runId?: string
  sessionId?: string
  requestId?: string
  stepId?: string
  limit?: number
}

export function listModelAttemptReconciliations(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptReconciliationQuery = {}
): ModelAttemptReconciliationView[] {
  return listMatchingAttempts(db, query, (attempt) => attempt.status === 'started')
}

export function getModelAttemptReconciliation(
  db: WorkflowLedgerDatabase,
  attemptId: string
): ModelAttemptReconciliationView | null {
  const attempt = getModelAttempt(db, requiredId(attemptId, 'attempt id'))
  return attempt?.status === 'started' ? reconciliationView(db, attempt) : null
}

export function hasModelAttemptReconciliation(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptReconciliationQuery
): boolean {
  return listModelAttemptReconciliations(db, { ...query, limit: 1 }).length > 0
}

export function listModelAttemptRetryAuthorizations(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptReconciliationQuery = {}
): ModelAttemptReconciliationView[] {
  return listMatchingAttempts(
    db,
    query,
    (attempt) => isRetryAuthorizedModelAttempt(attempt) && attempt.nextAttemptId === undefined
  )
}

export function getModelAttemptRetryAuthorization(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptReconciliationQuery
): ModelAttemptReconciliationView | null {
  const matches = listModelAttemptRetryAuthorizations(db, { ...query, limit: undefined })
  if (matches.length > 1) {
    throw modelAttemptError(
      'MODEL_ATTEMPT_RECONCILIATION_AMBIGUOUS',
      'Retry authorization query matches multiple unconsumed Attempts'
    )
  }
  return matches[0] ?? null
}

export function hasModelAttemptRetryAuthorization(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptReconciliationQuery
): boolean {
  return getModelAttemptRetryAuthorization(db, query) !== null
}

export function resolveModelAttemptReconciliation(
  db: WorkflowLedgerDatabase,
  attemptId: string,
  expectedRevision: number,
  resolution: ModelAttemptReconciliationResolution
): ModelAttemptReconciliationView {
  const id = requiredId(attemptId, 'attempt id')
  const revision = positiveInteger(expectedRevision, 'expected revision')
  const normalizedResolution = reconciliationResolution(resolution)
  const current = getModelAttempt(db, id)
  if (current?.status === 'started' && normalizedResolution === 'retry_authorized') {
    assertRetryAuthorizationIsUnambiguous(db, current)
  }
  const commandId = `model-attempt-reconciliation:${digest({ id, revision, resolution: normalizedResolution })}`
  const attempt = completeReconciledModelAttempt(db, id, normalizedResolution === 'retry_authorized'
    ? {
        commandId,
        expectedRevision: revision,
        status: 'failed',
        outcome: 'unknown',
        errorClass: 'runtime_result_unknown'
      }
    : {
        commandId,
        expectedRevision: revision,
        status: 'cancelled',
        outcome: 'cancelled'
      })
  return reconciliationView(db, attempt)
}

function listMatchingAttempts(
  db: WorkflowLedgerDatabase,
  query: ModelAttemptReconciliationQuery,
  predicate: (attempt: ModelAttemptRecord) => boolean
): ModelAttemptReconciliationView[] {
  if (!modelAttemptSchemaExists(db)) return []
  verifyModelAttemptLedger(db)
  const normalized = normalizeReconciliationQuery(query)
  const attempts = readRawModelAttempts(db)
  const matches = attempts
    .map((attempt) => deriveModelAttemptNext(attempt, attempts))
    .filter((attempt) => predicate(attempt) && matchesQuery(db, attempt, normalized))
    .map((attempt) => reconciliationView(db, attempt))
  return normalized.limit === undefined ? matches : matches.slice(0, normalized.limit)
}

function matchesQuery(
  db: WorkflowLedgerDatabase,
  attempt: ModelAttemptRecord,
  query: NormalizedReconciliationQuery
): boolean {
  return (!query.runId || attempt.runId === query.runId) &&
    (!query.requestId || attempt.requestId === query.requestId) &&
    (!query.stepId || attempt.stepId === query.stepId) &&
    (!query.sessionId || runSessionId(db, attempt.runId) === query.sessionId)
}

function normalizeReconciliationQuery(query: ModelAttemptReconciliationQuery): NormalizedReconciliationQuery {
  const limit = query.limit === undefined ? undefined : positiveInteger(query.limit, 'reconciliation limit')
  if (limit !== undefined && limit > MAX_RECONCILIATION_LIMIT) {
    throw modelAttemptError(
      'MODEL_ATTEMPT_INVALID_INPUT',
      `reconciliation limit exceeds ${MAX_RECONCILIATION_LIMIT}`
    )
  }
  return {
    runId: optionalId(query.runId, 'reconciliation run id'),
    sessionId: optionalId(query.sessionId, 'reconciliation session id'),
    requestId: optionalId(query.requestId, 'reconciliation request id'),
    stepId: optionalId(query.stepId, 'reconciliation step id'),
    limit
  }
}

function reconciliationResolution(value: unknown): ModelAttemptReconciliationResolution {
  if (value === 'retry_authorized' || value === 'cancelled_by_user') return value
  throw modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', 'reconciliation resolution is invalid')
}

function assertRetryAuthorizationIsUnambiguous(
  db: WorkflowLedgerDatabase,
  attempt: ModelAttemptRecord
): void {
  const chain = readRawModelAttempts(db).filter(
    (candidate) => candidate.runId === attempt.runId && candidate.requestId === attempt.requestId
  )
  if (chain.some((candidate) => candidate.ordinal > attempt.ordinal)) {
    throw modelAttemptError(
      'MODEL_ATTEMPT_RECONCILIATION_AMBIGUOUS',
      `Attempt ${attempt.id} is not the latest Attempt in its request chain`
    )
  }
}

function reconciliationView(
  db: WorkflowLedgerDatabase,
  attempt: ModelAttemptRecord
): ModelAttemptReconciliationView {
  return {
    attempt,
    runId: attempt.runId,
    sessionId: runSessionId(db, attempt.runId),
    requestId: attempt.requestId
  }
}

function runSessionId(db: WorkflowLedgerDatabase, runId: string): string {
  const stmt = db.prepare('SELECT session_id FROM workflow_runs WHERE id = ? LIMIT 1')
  try {
    stmt.bind([runId])
    if (!stmt.step()) modelAttemptCorruption(`Attempt references missing canonical Run ${runId}`)
    const value = stmt.getAsObject().session_id
    if (typeof value !== 'string' || !value) modelAttemptCorruption(`Canonical Run ${runId} session id is invalid`)
    return value
  } finally {
    stmt.free()
  }
}
