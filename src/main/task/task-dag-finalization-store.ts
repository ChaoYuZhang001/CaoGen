import type initSqlJs from 'sql.js'
import type { TaskDagFinalizationRecord } from '../../shared/types'
import { isTaskDagFinalizationRecord } from './task-snapshot-validation'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
type SqlDatabase = InstanceType<SqlJsStatic['Database']>

export class TaskDagFinalizationCorruptionError extends Error {
  readonly code = 'DAG_FINALIZATION_CORRUPTION'
  readonly executionId: string
  readonly parentSessionId: string
  readonly revision: number | undefined

  constructor(input: {
    executionId: unknown
    parentSessionId: unknown
    revision: unknown
    reason: string
  }) {
    const executionId = typeof input.executionId === 'string' ? input.executionId : '<unknown>'
    const parentSessionId = typeof input.parentSessionId === 'string' ? input.parentSessionId : '<unknown>'
    const revision = typeof input.revision === 'number' && Number.isFinite(input.revision)
      ? input.revision
      : undefined
    super(
      `DAG finalizer corruption: execution=${executionId} parent=${parentSessionId}` +
      `${revision === undefined ? '' : ` revision=${revision}`} (${input.reason})`
    )
    this.name = 'TaskDagFinalizationCorruptionError'
    this.executionId = executionId
    this.parentSessionId = parentSessionId
    this.revision = revision
  }
}

export function setupTaskDagFinalizationSchema(db: SqlDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS dag_finalizers (
      execution_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_dag_finalizers_parent ON dag_finalizers(parent_session_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_dag_finalizers_updated_at ON dag_finalizers(updated_at);')
}

export function selectTaskDagFinalizations(
  db: SqlDatabase,
  parentSessionId?: string
): TaskDagFinalizationRecord[] {
  const records: TaskDagFinalizationRecord[] = []
  // Decode every row before filtering. Filtering by a mutable SQL metadata
  // column first would let a row whose parent_session_id was tampered with
  // evade the snapshot deletion guard.
  const stmt = db.prepare(
    'SELECT execution_id, parent_session_id, revision, updated_at, payload ' +
    'FROM dag_finalizers ORDER BY updated_at DESC'
  )
  try {
    while (stmt.step()) {
      const record = decodeTaskDagFinalizationRow(stmt.getAsObject())
      if (parentSessionId === undefined || record.parentSessionId === parentSessionId) {
        records.push(record)
      }
    }
  } finally {
    stmt.free()
  }
  return records
}

export function findTaskDagFinalization(
  db: SqlDatabase,
  executionId: string
): TaskDagFinalizationRecord | null {
  const stmt = db.prepare(
    'SELECT execution_id, parent_session_id, revision, updated_at, payload ' +
    'FROM dag_finalizers ORDER BY updated_at DESC'
  )
  try {
    let found: TaskDagFinalizationRecord | null = null
    while (stmt.step()) {
      const record = decodeTaskDagFinalizationRow(stmt.getAsObject())
      if (record.executionId === executionId) found = record
    }
    return found
  } finally {
    stmt.free()
  }
}

export function assertTaskDagFinalizationParentDeletable(
  db: SqlDatabase,
  parentSessionId: string
): void {
  const records = selectTaskDagFinalizations(db, parentSessionId)
  const incomplete = records.find((record) => record.phase !== 'completed')
  if (incomplete) {
    throw new Error(
      `DAG finalizer ${incomplete.executionId} 尚未完成，不能删除父任务恢复快照`
    )
  }
}

function decodeTaskDagFinalizationRow(row: Record<string, unknown>): TaskDagFinalizationRecord {
  if (
    typeof row.execution_id !== 'string' ||
    typeof row.parent_session_id !== 'string' ||
    typeof row.revision !== 'number' ||
    !Number.isInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.updated_at !== 'number' ||
    !Number.isFinite(row.updated_at)
  ) {
    throw new TaskDagFinalizationCorruptionError({
      executionId: row.execution_id,
      parentSessionId: row.parent_session_id,
      revision: row.revision,
      reason: 'SQL metadata has an invalid type or value'
    })
  }
  const payload = row.payload
  if (typeof payload !== 'string') {
    throw new TaskDagFinalizationCorruptionError({
      executionId: row.execution_id,
      parentSessionId: row.parent_session_id,
      revision: row.revision,
      reason: 'payload is not text'
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch {
    throw new TaskDagFinalizationCorruptionError({
      executionId: row.execution_id,
      parentSessionId: row.parent_session_id,
      revision: row.revision,
      reason: 'payload is not valid JSON'
    })
  }
  if (!isTaskDagFinalizationRecord(parsed)) {
    throw new TaskDagFinalizationCorruptionError({
      executionId: row.execution_id,
      parentSessionId: row.parent_session_id,
      revision: row.revision,
      reason: 'payload schema validation failed'
    })
  }
  if (
    parsed.executionId !== row.execution_id ||
    parsed.parentSessionId !== row.parent_session_id ||
    parsed.revision !== row.revision ||
    parsed.updatedAt !== row.updated_at
  ) {
    throw new TaskDagFinalizationCorruptionError({
      executionId: row.execution_id,
      parentSessionId: row.parent_session_id,
      revision: row.revision,
      reason: 'payload metadata does not match SQL columns'
    })
  }
  return parsed
}

export function upsertTaskDagFinalization(
  db: SqlDatabase,
  finalization: TaskDagFinalizationRecord
): void {
  db.run(
    `
      INSERT INTO dag_finalizers(execution_id, parent_session_id, revision, updated_at, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        parent_session_id = excluded.parent_session_id,
        revision = excluded.revision,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `,
    [
      finalization.executionId,
      finalization.parentSessionId,
      finalization.revision,
      finalization.updatedAt,
      JSON.stringify(finalization)
    ]
  )
}
