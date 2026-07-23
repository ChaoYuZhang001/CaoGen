import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import { resolve } from 'node:path'
import { isTaskRunRecord, isTaskRunTerminal } from './task-run'
import { taskSnapshotTaskIdMatchesRun } from './task-snapshot-identity'
import { isTaskSnapshotRecord } from './task-snapshot-validation'
import { canonicalJson, digest } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { readRuns } from './workflow-ledger-query'

export type WorkflowLedgerReadMode = 'legacy' | 'compare' | 'canonical'

export interface WorkflowRecoveryVerification {
  valid: true
  recoverySessions: number
  activeRuns: number
  historicalRuns: number
  digest: string
}

const READ_MODE_ENV = 'CAOGEN_WORKFLOW_LEDGER_READ_MODE'
const configuredReadModes = new Map<string, WorkflowLedgerReadMode>()

export function normalizeWorkflowLedgerReadMode(value: unknown): WorkflowLedgerReadMode {
  if (value === 'legacy' || value === 'compare' || value === 'canonical') return value
  throw new Error(`Workflow Ledger read mode must be legacy, compare, or canonical; received ${String(value)}`)
}

export function getWorkflowLedgerReadMode(databasePath?: string): WorkflowLedgerReadMode {
  if (databasePath) {
    const configured = configuredReadModes.get(resolve(databasePath))
    if (configured) return configured
  }
  const value = process.env[READ_MODE_ENV]
  return value === undefined || value.trim() === '' ? 'legacy' : normalizeWorkflowLedgerReadMode(value.trim())
}

/** Commit a mode only after the task-store facade has validated it against persisted state. */
export function commitWorkflowLedgerReadMode(databasePath: string, mode: WorkflowLedgerReadMode): void {
  configuredReadModes.set(resolve(databasePath), mode)
}

export function resetWorkflowLedgerReadModeForTests(): void {
  configuredReadModes.clear()
}

export function setupWorkflowRecoverySchema(db: WorkflowLedgerDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_recovery_sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      project_id TEXT,
      run_id TEXT,
      updated_at INTEGER NOT NULL,
      payload_digest TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_recovery_sessions_updated
      ON workflow_recovery_sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_recovery_sessions_run
      ON workflow_recovery_sessions(run_id);
  `)
}

export function upsertWorkflowRecoverySession(
  db: WorkflowLedgerDatabase,
  snapshot: TaskSnapshotRecord
): void {
  const existing = findCanonicalRecoverySession(db, snapshot.id, snapshot.sessionId)
  if (existing && (existing.id !== snapshot.id || existing.sessionId !== snapshot.sessionId)) {
    throw new WorkflowLedgerCorruptionError(
      `recovery session ${snapshot.sessionId} identity differs from its canonical projection`
    )
  }
  const payload = canonicalJson(snapshot)
  db.run(
    `INSERT INTO workflow_recovery_sessions(
       id, session_id, task_id, project_id, run_id, updated_at, payload_digest, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       task_id = excluded.task_id,
       project_id = excluded.project_id,
       run_id = excluded.run_id,
       updated_at = excluded.updated_at,
       payload_digest = excluded.payload_digest,
       payload = excluded.payload`,
    [
      snapshot.id,
      snapshot.sessionId,
      snapshot.taskId,
      snapshot.meta.projectId ?? null,
      snapshot.run?.id ?? null,
      snapshot.updatedAt,
      digest(snapshot),
      payload
    ]
  )
}

export function deleteWorkflowRecoverySession(
  db: WorkflowLedgerDatabase,
  idOrSessionId: string
): boolean {
  db.run('DELETE FROM workflow_recovery_sessions WHERE id = ? OR session_id = ?', [idOrSessionId, idOrSessionId])
  return db.getRowsModified() > 0
}

export function backfillWorkflowRecoverySessions(
  db: WorkflowLedgerDatabase,
  snapshots: readonly TaskSnapshotRecord[]
): void {
  for (const snapshot of snapshots) upsertWorkflowRecoverySession(db, snapshot)
}

export function selectRecoverySnapshots(
  db: WorkflowLedgerDatabase,
  mode: WorkflowLedgerReadMode
): TaskSnapshotRecord[] {
  if (mode === 'legacy') return readLegacySnapshots(db)
  const canonical = readCanonicalRecoverySessions(db)
  if (mode === 'canonical') return canonical
  const legacy = readLegacySnapshots(db)
  assertRecordParity('recovery session', legacy, canonical, (item) => item.id)
  return legacy
}

export function findRecoverySnapshot(
  db: WorkflowLedgerDatabase,
  id: string,
  sessionId: string,
  mode: WorkflowLedgerReadMode
): TaskSnapshotRecord | null {
  return selectRecoverySnapshots(db, mode).find((item) => item.id === id || item.sessionId === sessionId) ?? null
}

export function selectRecoveryTaskRuns(
  db: WorkflowLedgerDatabase,
  mode: WorkflowLedgerReadMode,
  sessionId?: string
): TaskRunRecord[] {
  const filter = (run: TaskRunRecord): boolean => sessionId === undefined || run.sessionId === sessionId
  if (mode === 'legacy') return readLegacyTaskRuns(db).filter(filter)
  const canonical = readCanonicalTaskRuns(db).filter(filter)
  if (mode === 'canonical') return canonical
  const legacy = readLegacyTaskRuns(db).filter(filter)
  assertRecordParity('task run', legacy, canonical, (item) => item.id)
  return legacy
}

export function findRecoveryTaskRun(
  db: WorkflowLedgerDatabase,
  id: string,
  mode: WorkflowLedgerReadMode
): TaskRunRecord | null {
  return selectRecoveryTaskRuns(db, mode).find((item) => item.id === id) ?? null
}

export function readCanonicalRecoverySessions(db: WorkflowLedgerDatabase): TaskSnapshotRecord[] {
  const snapshots: TaskSnapshotRecord[] = []
  const seenSessions = new Set<string>()
  const stmt = db.prepare(
    `SELECT id, session_id, task_id, project_id, run_id, updated_at, payload_digest, payload
       FROM workflow_recovery_sessions ORDER BY updated_at DESC, id ASC`
  )
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const snapshot = parseSnapshot(row.payload, 'canonical recovery session')
      assertColumn(row.id, snapshot.id, 'recovery session id')
      assertColumn(row.session_id, snapshot.sessionId, 'recovery session session_id')
      assertColumn(row.task_id, snapshot.taskId, 'recovery session task_id')
      assertOptionalColumn(row.project_id, snapshot.meta.projectId, 'recovery session project_id')
      assertOptionalColumn(row.run_id, snapshot.run?.id, 'recovery session run_id')
      assertColumn(row.updated_at, snapshot.updatedAt, 'recovery session updated_at')
      assertColumn(row.payload_digest, digest(snapshot), 'recovery session payload_digest')
      if (seenSessions.has(snapshot.sessionId)) {
        throw new WorkflowLedgerCorruptionError(`recovery session ${snapshot.sessionId} is duplicated`)
      }
      seenSessions.add(snapshot.sessionId)
      snapshots.push(snapshot)
    }
  } finally {
    stmt.free()
  }
  return snapshots
}

export function readCanonicalTaskRuns(db: WorkflowLedgerDatabase): TaskRunRecord[] {
  return readRuns(db)
    .map((run) => run.taskRun)
    .sort(compareUpdatedDescending)
}

export function verifyWorkflowRecoveryProjection(
  db: WorkflowLedgerDatabase
): WorkflowRecoveryVerification {
  const snapshots = readCanonicalRecoverySessions(db)
  const runs = readCanonicalTaskRuns(db)
  const runsById = new Map(runs.map((run) => [run.id, run]))
  const recoveredRunIds = new Set<string>()

  for (const snapshot of snapshots) {
    if (!snapshot.run) continue
    const run = runsById.get(snapshot.run.id)
    if (
      !run ||
      run.sessionId !== snapshot.sessionId ||
      !taskSnapshotTaskIdMatchesRun(snapshot.taskId, run) ||
      !taskSnapshotTaskIdMatchesRun(snapshot.taskId, snapshot.run) ||
      digest(run) !== digest(snapshot.run)
    ) {
      throw new WorkflowLedgerCorruptionError(
        `recovery session ${snapshot.id} does not match canonical Run ${snapshot.run.id}`
      )
    }
    recoveredRunIds.add(run.id)
  }

  const activeRuns = runs.filter((run) => !isTaskRunTerminal(run.status))
  for (const run of activeRuns) {
    if (!recoveredRunIds.has(run.id)) {
      throw new WorkflowLedgerCorruptionError(`active canonical Run ${run.id} has no recovery session`)
    }
  }

  return {
    valid: true,
    recoverySessions: snapshots.length,
    activeRuns: activeRuns.length,
    historicalRuns: runs.length - activeRuns.length,
    digest: digest({ snapshots, runs })
  }
}

function readLegacySnapshots(db: WorkflowLedgerDatabase): TaskSnapshotRecord[] {
  const snapshots: TaskSnapshotRecord[] = []
  const stmt = db.prepare(
    'SELECT id, session_id, updated_at, payload FROM task_snapshots ORDER BY updated_at DESC, id ASC'
  )
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const snapshot = parseSnapshot(row.payload, 'legacy recovery session')
      assertColumn(row.id, snapshot.id, 'legacy recovery id')
      assertColumn(row.session_id, snapshot.sessionId, 'legacy recovery session_id')
      assertColumn(row.updated_at, snapshot.updatedAt, 'legacy recovery updated_at')
      snapshots.push(snapshot)
    }
  } finally {
    stmt.free()
  }
  return snapshots
}

function readLegacyTaskRuns(db: WorkflowLedgerDatabase): TaskRunRecord[] {
  const runs: TaskRunRecord[] = []
  const stmt = db.prepare(
    'SELECT id, session_id, updated_at, payload FROM task_runs ORDER BY updated_at DESC, id ASC'
  )
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const run = parseTaskRun(row.payload, 'legacy task run')
      assertColumn(row.id, run.id, 'legacy task run id')
      assertColumn(row.session_id, run.sessionId, 'legacy task run session_id')
      assertColumn(row.updated_at, run.updatedAt, 'legacy task run updated_at')
      runs.push(run)
    }
  } finally {
    stmt.free()
  }
  return runs
}

function findCanonicalRecoverySession(
  db: WorkflowLedgerDatabase,
  id: string,
  sessionId: string
): TaskSnapshotRecord | null {
  const stmt = db.prepare(
    `SELECT id, session_id, task_id, project_id, run_id, updated_at, payload_digest, payload
       FROM workflow_recovery_sessions WHERE id = ? OR session_id = ? LIMIT 1`
  )
  try {
    stmt.bind([id, sessionId])
    if (!stmt.step()) return null
    const row = stmt.getAsObject()
    const snapshot = parseSnapshot(row.payload, 'canonical recovery session')
    assertColumn(row.id, snapshot.id, 'recovery session id')
    assertColumn(row.session_id, snapshot.sessionId, 'recovery session session_id')
    assertColumn(row.task_id, snapshot.taskId, 'recovery session task_id')
    assertOptionalColumn(row.project_id, snapshot.meta.projectId, 'recovery session project_id')
    assertOptionalColumn(row.run_id, snapshot.run?.id, 'recovery session run_id')
    assertColumn(row.updated_at, snapshot.updatedAt, 'recovery session updated_at')
    assertColumn(row.payload_digest, digest(snapshot), 'recovery session payload_digest')
    return snapshot
  } finally {
    stmt.free()
  }
}

function assertRecordParity<T>(
  label: string,
  legacy: readonly T[],
  canonical: readonly T[],
  idFor: (item: T) => string
): void {
  const legacyById = new Map(legacy.map((item) => [idFor(item), item]))
  const canonicalById = new Map(canonical.map((item) => [idFor(item), item]))
  if (legacyById.size !== legacy.length || canonicalById.size !== canonical.length) {
    throw new WorkflowLedgerCorruptionError(`${label} read-source contains duplicate identities`)
  }
  for (const [id, legacyRecord] of legacyById) {
    const canonicalRecord = canonicalById.get(id)
    if (!canonicalRecord || digest(legacyRecord) !== digest(canonicalRecord)) {
      throw new WorkflowLedgerCorruptionError(`${label} ${id} differs between legacy and canonical read sources`)
    }
  }
  for (const id of canonicalById.keys()) {
    if (!legacyById.has(id)) {
      throw new WorkflowLedgerCorruptionError(`${label} ${id} exists only in canonical read source`)
    }
  }
}

function parseSnapshot(value: unknown, label: string): TaskSnapshotRecord {
  const parsed = parsePayload(value, label)
  if (!isTaskSnapshotRecord(parsed)) throw new WorkflowLedgerCorruptionError(`${label} failed schema validation`)
  return parsed
}

function parseTaskRun(value: unknown, label: string): TaskRunRecord {
  const parsed = parsePayload(value, label)
  if (!isTaskRunRecord(parsed)) throw new WorkflowLedgerCorruptionError(`${label} failed schema validation`)
  return parsed
}

function parsePayload(value: unknown, label: string): unknown {
  if (typeof value !== 'string') throw new WorkflowLedgerCorruptionError(`${label} payload is not text`)
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new WorkflowLedgerCorruptionError(`${label} payload is invalid JSON`)
  }
}

function assertColumn(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new WorkflowLedgerCorruptionError(`${label} does not match payload`)
}

function assertOptionalColumn(actual: unknown, expected: unknown, label: string): void {
  if ((actual ?? undefined) !== expected) throw new WorkflowLedgerCorruptionError(`${label} does not match payload`)
}

function compareUpdatedDescending(left: TaskRunRecord, right: TaskRunRecord): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}
