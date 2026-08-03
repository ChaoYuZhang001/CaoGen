import type { TaskSnapshotDatabase } from './task-snapshot'
import { canonicalJson, digest, GENESIS_DIGEST } from './workflow-ledger-codec'

export const WORKFLOW_LEDGER_AUTHORIZED_PURGE_TABLE = 'workflow_authorized_project_purges'

export interface WorkflowLedgerAuthorizedPurgeCounts {
  taskRuns: number
  workflowRuns: number
  workflowEvents: number
  taskEvidence: number
  conversationStreams?: number
  conversationGenerations?: number
  conversationEvents?: number
}

export interface WorkflowLedgerAuthorizedPurgeVerification {
  valid: true
  operations: number
  removed: WorkflowLedgerAuthorizedPurgeCounts
  lastSeq: number
  lastDigest: string
}

export interface WorkflowLedgerAuthorizedPurgeRecord {
  schemaVersion: 1
  seq: number
  operationId: string
  projectId: string
  removed: WorkflowLedgerAuthorizedPurgeCounts
  prevDigest: string
  digest: string
}

const ZERO_COUNTS: WorkflowLedgerAuthorizedPurgeCounts = {
  taskRuns: 0,
  workflowRuns: 0,
  workflowEvents: 0,
  taskEvidence: 0,
  conversationStreams: 0,
  conversationGenerations: 0,
  conversationEvents: 0
}

export function setupWorkflowLedgerAuthorizedPurgeSchema(db: TaskSnapshotDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ${WORKFLOW_LEDGER_AUTHORIZED_PURGE_TABLE} (
      seq INTEGER PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      task_runs INTEGER NOT NULL CHECK(task_runs >= 0),
      workflow_runs INTEGER NOT NULL CHECK(workflow_runs >= 0),
      workflow_events INTEGER NOT NULL CHECK(workflow_events >= 0),
      task_evidence INTEGER NOT NULL CHECK(task_evidence >= 0),
      prev_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `)
}

export function recordWorkflowLedgerAuthorizedPurge(
  db: TaskSnapshotDatabase,
  input: {
    operationId: string
    projectId: string
    removed: WorkflowLedgerAuthorizedPurgeCounts
  }
): WorkflowLedgerAuthorizedPurgeVerification {
  setupWorkflowLedgerAuthorizedPurgeSchema(db)
  const verification = verifyWorkflowLedgerAuthorizedPurges(db)
  const operationId = requiredId(input.operationId, 'authorized purge operationId')
  const projectId = requiredId(input.projectId, 'authorized purge projectId')
  const removed = validCounts(input.removed)
  const existing = readRecords(db).find((record) => record.operationId === operationId)
  if (existing) {
    if (existing.projectId !== projectId || (!sameCounts(existing.removed, removed) && !isZeroCounts(removed))) {
      throw new Error(`authorized purge operation ${operationId} was replayed with different data`)
    }
    return verification
  }

  const withoutDigest = {
    schemaVersion: 1 as const,
    seq: verification.lastSeq + 1,
    operationId,
    projectId,
    removed,
    prevDigest: verification.lastDigest
  }
  const record: WorkflowLedgerAuthorizedPurgeRecord = {
    ...withoutDigest,
    digest: digest(withoutDigest)
  }
  db.run(`
    INSERT INTO ${WORKFLOW_LEDGER_AUTHORIZED_PURGE_TABLE}(
      seq, operation_id, project_id, task_runs, workflow_runs, workflow_events,
      task_evidence, prev_digest, record_digest, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.seq,
    record.operationId,
    record.projectId,
    record.removed.taskRuns,
    record.removed.workflowRuns,
    record.removed.workflowEvents,
    record.removed.taskEvidence,
    record.prevDigest,
    record.digest,
    canonicalJson(record)
  ])
  return verifyWorkflowLedgerAuthorizedPurges(db)
}

export function verifyWorkflowLedgerAuthorizedPurges(
  db: TaskSnapshotDatabase
): WorkflowLedgerAuthorizedPurgeVerification {
  if (!tableExists(db)) return emptyVerification()
  const records = readRecords(db)
  const removed = { ...ZERO_COUNTS }
  let previousDigest = GENESIS_DIGEST
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const expectedSeq = index + 1
    if (record.seq !== expectedSeq) throw corrupt(`non-contiguous seq ${record.seq}; expected ${expectedSeq}`)
    if (record.prevDigest !== previousDigest) throw corrupt(`prevDigest mismatch at seq ${record.seq}`)
    const { digest: recordDigest, ...withoutDigest } = record
    if (digest(withoutDigest) !== recordDigest) throw corrupt(`digest mismatch at seq ${record.seq}`)
    addCounts(removed, record.removed)
    previousDigest = recordDigest
  }
  return {
    valid: true,
    operations: records.length,
    removed,
    lastSeq: records.length,
    lastDigest: previousDigest
  }
}

export function findWorkflowLedgerAuthorizedPurge(
  db: TaskSnapshotDatabase,
  operationId: string
): WorkflowLedgerAuthorizedPurgeRecord | undefined {
  verifyWorkflowLedgerAuthorizedPurges(db)
  const id = requiredId(operationId, 'authorized purge operationId')
  const record = readRecords(db).find((candidate) => candidate.operationId === id)
  return record ? structuredClone(record) : undefined
}

function readRecords(db: TaskSnapshotDatabase): WorkflowLedgerAuthorizedPurgeRecord[] {
  const records: WorkflowLedgerAuthorizedPurgeRecord[] = []
  const stmt = db.prepare(`
    SELECT seq, operation_id, project_id, task_runs, workflow_runs, workflow_events,
      task_evidence, prev_digest, record_digest, payload
    FROM ${WORKFLOW_LEDGER_AUTHORIZED_PURGE_TABLE}
    ORDER BY seq ASC
  `)
  try {
    while (stmt.step()) records.push(decodeRow(stmt.getAsObject()))
  } finally {
    stmt.free()
  }
  return records
}

function decodeRow(row: Record<string, unknown>): WorkflowLedgerAuthorizedPurgeRecord {
  let parsed: unknown
  try {
    parsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : undefined
  } catch {
    throw corrupt('payload is not valid JSON')
  }
  if (!isRecord(parsed)) throw corrupt('payload schema is invalid')
  const record = parsed
  const columnsMatch = row.seq === record.seq && row.operation_id === record.operationId &&
    row.project_id === record.projectId && row.task_runs === record.removed.taskRuns &&
    row.workflow_runs === record.removed.workflowRuns && row.workflow_events === record.removed.workflowEvents &&
    row.task_evidence === record.removed.taskEvidence && row.prev_digest === record.prevDigest &&
    row.record_digest === record.digest && row.payload === canonicalJson(record)
  if (!columnsMatch) throw corrupt(`column/payload mismatch at seq ${record.seq}`)
  return record
}

function isRecord(value: unknown): value is WorkflowLedgerAuthorizedPurgeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<WorkflowLedgerAuthorizedPurgeRecord>
  return item.schemaVersion === 1 && positiveInteger(item.seq) && isId(item.operationId) &&
    isId(item.projectId) && isCounts(item.removed) && isDigest(item.prevDigest) && isDigest(item.digest)
}

function validCounts(value: WorkflowLedgerAuthorizedPurgeCounts): WorkflowLedgerAuthorizedPurgeCounts {
  if (!isCounts(value)) throw new Error('authorized purge removed counts are invalid')
  return { ...value }
}

function isCounts(value: unknown): value is WorkflowLedgerAuthorizedPurgeCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<WorkflowLedgerAuthorizedPurgeCounts>
  return nonNegativeInteger(item.taskRuns) && nonNegativeInteger(item.workflowRuns) &&
    nonNegativeInteger(item.workflowEvents) && nonNegativeInteger(item.taskEvidence) &&
    optionalNonNegativeInteger(item.conversationStreams) &&
    optionalNonNegativeInteger(item.conversationGenerations) &&
    optionalNonNegativeInteger(item.conversationEvents)
}

function addCounts(target: WorkflowLedgerAuthorizedPurgeCounts, addition: WorkflowLedgerAuthorizedPurgeCounts): void {
  for (const key of Object.keys(target) as Array<keyof WorkflowLedgerAuthorizedPurgeCounts>) {
    const next = (target[key] ?? 0) + (addition[key] ?? 0)
    if (!Number.isSafeInteger(next)) throw corrupt(`${key} cumulative count overflow`)
    target[key] = next
  }
}

function sameCounts(left: WorkflowLedgerAuthorizedPurgeCounts, right: WorkflowLedgerAuthorizedPurgeCounts): boolean {
  return left.taskRuns === right.taskRuns && left.workflowRuns === right.workflowRuns &&
    left.workflowEvents === right.workflowEvents && left.taskEvidence === right.taskEvidence &&
    (left.conversationStreams ?? 0) === (right.conversationStreams ?? 0) &&
    (left.conversationGenerations ?? 0) === (right.conversationGenerations ?? 0) &&
    (left.conversationEvents ?? 0) === (right.conversationEvents ?? 0)
}

function isZeroCounts(value: WorkflowLedgerAuthorizedPurgeCounts): boolean {
  return sameCounts(value, ZERO_COUNTS)
}

function emptyVerification(): WorkflowLedgerAuthorizedPurgeVerification {
  return { valid: true, operations: 0, removed: { ...ZERO_COUNTS }, lastSeq: 0, lastDigest: GENESIS_DIGEST }
}

function tableExists(db: TaskSnapshotDatabase): boolean {
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
  try {
    stmt.bind([WORKFLOW_LEDGER_AUTHORIZED_PURGE_TABLE])
    return stmt.step()
  } finally {
    stmt.free()
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\0-\x1f\x7f]/.test(value)
}

function requiredId(value: unknown, label: string): string {
  if (!isId(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function corrupt(reason: string): Error {
  return new Error(`authorized Project purge ledger corruption: ${reason}`)
}
