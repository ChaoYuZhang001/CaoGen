import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import initSqlJs from 'sql.js'
import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkflowLedgerVerification, WorkflowRunRecord } from '../../shared/workflow-types'
import { selectTaskDagFinalizations } from './task-dag-finalization-store'
import { isTaskRunRecord } from './task-run'
import { isTaskSnapshotRecord } from './task-snapshot-validation'
import {
  selectTaskEvidence,
  verifyTaskEvidence,
  type TaskEvidenceRecord,
  type TaskEvidenceVerification
} from './task-evidence-store'
import { verifyWorkflowLedgerWithArtifactGraph } from './workflow-ledger-artifact-graph-query'
import { canonicalJson, digest } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { readRegularFile, sha256 } from './workflow-ledger-migration-storage'
import {
  WORKFLOW_LEDGER_READINESS_FORMAT,
  WorkflowLedgerMigrationError,
  type WorkflowLedgerCanonicalReadinessDiagnostic,
  type WorkflowLedgerCanonicalReadinessReport,
  type WorkflowLedgerMigrationSource
} from './workflow-ledger-migration-types'
import { readRuns } from './workflow-ledger-query'
import {
  readCanonicalRecoverySessions,
  verifyWorkflowRecoveryProjection,
  type WorkflowRecoveryVerification
} from './workflow-ledger-recovery'
import { assessWorkflowReadinessParity } from './workflow-ledger-readiness-parity'
import {
  readWorkflowLedgerStoreIdentity,
  WORKFLOW_LEDGER_STORE_IDENTITY_TABLE
} from './workflow-ledger-store-identity'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>

const nodeRequire = createRequire(__filename)
const REQUIRED_WORKFLOW_TABLES = [
  'workflow_goals',
  'workflow_work_items',
  'workflow_runs',
  'workflow_artifacts',
  'workflow_acceptances',
  'workflow_evidence_links',
  'workflow_evidence',
  'workflow_events',
  'task_evidence',
  'workflow_artifact_edges',
  'workflow_artifact_locations',
  'workflow_recovery_sessions'
] as const
const REQUIRED_TASK_SUPPORT_TABLES = ['effect_resource_fences', WORKFLOW_LEDGER_STORE_IDENTITY_TABLE] as const
const DAG_FINALIZERS_TABLE = 'dag_finalizers'

let sqlPromise: Promise<SqlJsStatic> | null = null

interface ReadinessRecords {
  taskRuns: TaskRunRecord[]
  snapshots: TaskSnapshotRecord[]
  workflowRuns: WorkflowRunRecord[]
  recoverySessions: TaskSnapshotRecord[]
}

interface ReadinessVerifications {
  workflow?: WorkflowLedgerVerification
  evidence?: TaskEvidenceVerification
  recovery?: WorkflowRecoveryVerification
}

type ReadinessParity = Pick<WorkflowLedgerCanonicalReadinessReport['counts'],
  'snapshotsWithoutRun' | 'activeRunsWithoutSnapshot' | 'terminalRunsWithoutSnapshot' | 'matchingRuns'>

/** Strict, non-mutating assessment over the exact bytes used to open db. */
export function assessWorkflowLedgerCanonicalReadiness(
  db: WorkflowLedgerDatabase,
  source: Pick<WorkflowLedgerMigrationSource, 'sourceKind' | 'sourcePath' | 'sourceBytes'> & { assessedAt?: number }
): WorkflowLedgerCanonicalReadinessReport {
  const diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[] = []
  const tables = readTableNames(db)
  const storeVersion = readStoreVersion(db, diagnostics)
  verifySqliteIntegrity(db, diagnostics)
  verifyRequiredTables(db, tables, storeVersion, diagnostics)
  const records = readReadinessRecords(db, tables, diagnostics)
  const storeId = readStoreIdentity(db, tables, diagnostics)
  verifyReadinessSupportState(tables, records, diagnostics)
  const dagFinalizations = readDagFinalizationCount(db, tables, diagnostics)
  const verifications = collectReadinessVerifications(db, tables, records, diagnostics)
  const evidenceAssessment = verifyEvidenceProjection(db, tables, diagnostics)
  const parity = assessWorkflowReadinessParity({
    taskRuns: records.taskRuns,
    snapshots: records.snapshots,
    workflowRuns: records.workflowRuns,
    recoverySessions: records.recoverySessions,
    evidence: evidenceAssessment.records
  }, diagnostics)
  verifications.evidence = evidenceAssessment.verification
  return buildReadinessReport({
    source,
    storeId,
    storeVersion,
    records,
    verifications,
    parity,
    dagFinalizations,
    hasDagFinalizers: tables.has(DAG_FINALIZERS_TABLE),
    diagnostics
  })
}

function buildReadinessReport(input: {
  source: Pick<WorkflowLedgerMigrationSource, 'sourceKind' | 'sourcePath' | 'sourceBytes'> & { assessedAt?: number }
  storeId?: string
  storeVersion: number | null
  records: ReadinessRecords
  verifications: ReadinessVerifications
  parity: ReadinessParity
  dagFinalizations: number
  hasDagFinalizers: boolean
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
}): WorkflowLedgerCanonicalReadinessReport {
  const {
    source, storeId, storeVersion, records, verifications, parity, dagFinalizations, hasDagFinalizers, diagnostics
  } = input
  const corrupt = diagnostics.some((item) => item.category === 'corruption')
  const repairable = diagnostics.some((item) => item.category === 'additive_projection')
  const safeForShadowUse = !corrupt && !repairable
  const readyForCanonicalRead = !hasCanonicalBlocker(diagnostics) && verifications.recovery !== undefined
  const reportWithoutDigest = {
    schemaVersion: 1 as const,
    format: WORKFLOW_LEDGER_READINESS_FORMAT,
    mode: 'shadow' as const,
    status: (corrupt ? 'blocked' : repairable ? 'repairable' : 'ready') as WorkflowLedgerCanonicalReadinessReport['status'],
    safeForShadowUse,
    readyForCanonicalRead,
    repairableAdditiveProjection: !corrupt && repairable,
    sourceKind: source.sourceKind,
    sourcePath: resolve(source.sourcePath),
    sourceSha256: sha256(source.sourceBytes),
    sourceSizeBytes: source.sourceBytes.byteLength,
    ...(storeId ? { storeId } : {}),
    storeVersion,
    assessedAt: source.assessedAt ?? Date.now(),
    counts: {
      taskSnapshots: records.snapshots.length,
      taskRuns: records.taskRuns.length,
      workflowRuns: records.workflowRuns.length,
      workflowRecoverySessions: records.recoverySessions.length,
      dagFinalizations,
      ...parity
    },
    digests: {
      taskRuns: collectionDigest(records.taskRuns),
      workflowRuns: collectionDigest(records.workflowRuns.map((run) => run.taskRun)),
      taskSnapshots: collectionDigest(records.snapshots)
    },
    ...(verifications.workflow && verifications.evidence && verifications.recovery && hasDagFinalizers
      ? {
          verification: {
            workflowLedger: verifications.workflow,
            taskEvidence: verifications.evidence,
            taskDagFinalizations: { valid: true as const, count: dagFinalizations },
            workflowRecovery: verifications.recovery
          }
        }
      : {}),
    diagnostics
  }
  return { ...reportWithoutDigest, reportDigest: digest(reportWithoutDigest) }
}

function readStoreIdentity(
  db: WorkflowLedgerDatabase,
  tables: ReadonlySet<string>,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): string | undefined {
  if (!tables.has(WORKFLOW_LEDGER_STORE_IDENTITY_TABLE)) return undefined
  try {
    return readWorkflowLedgerStoreIdentity(db).storeId
  } catch (error) {
    addDiagnostic(diagnostics, 'workflow_store_identity_invalid', 'corruption', safeErrorMessage(error), {
      table: WORKFLOW_LEDGER_STORE_IDENTITY_TABLE,
      scope: 'shared'
    })
    return undefined
  }
}

function hasCanonicalBlocker(
  diagnostics: readonly WorkflowLedgerCanonicalReadinessDiagnostic[]
): boolean {
  return diagnostics.some((item) =>
    isBlockingDiagnostic(item) && !isAllowedCanonicalSupersetDiagnostic(item)
  )
}

function isBlockingDiagnostic(item: WorkflowLedgerCanonicalReadinessDiagnostic): boolean {
  return item.category === 'corruption' || item.category === 'additive_projection'
}

function isAllowedCanonicalSupersetDiagnostic(item: WorkflowLedgerCanonicalReadinessDiagnostic): boolean {
  return item.code === 'workflow_run_without_legacy_source' ||
    item.code === 'workflow_recovery_without_legacy_source' ||
    item.code === 'task_evidence_without_legacy_run'
}

function readReadinessRecords(
  db: WorkflowLedgerDatabase,
  tables: ReadonlySet<string>,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): ReadinessRecords {
  const recovery = readWorkflowRecovery(db, tables.has('workflow_recovery_sessions'), diagnostics)
  return {
    taskRuns: tables.has('task_runs') ? readTaskRuns(db, diagnostics) : [],
    snapshots: tables.has('task_snapshots') ? readTaskSnapshots(db, diagnostics) : [],
    workflowRuns: tables.has('workflow_runs') ? readWorkflowRuns(db, diagnostics) : [],
    recoverySessions: recovery.records
  }
}

function verifyReadinessSupportState(
  tables: ReadonlySet<string>,
  records: ReadinessRecords,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  const taskRuns = records.taskRuns.length > 0
    ? records.taskRuns
    : records.workflowRuns.map((run) => run.taskRun)
  const snapshots = records.snapshots.length > 0 ? records.snapshots : records.recoverySessions
  verifyMissingSupportState(tables, taskRuns, snapshots, diagnostics)
}

function collectReadinessVerifications(
  db: WorkflowLedgerDatabase,
  tables: ReadonlySet<string>,
  records: ReadinessRecords,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): ReadinessVerifications {
  const missingWorkflowTables = REQUIRED_WORKFLOW_TABLES.some((table) => !tables.has(table))
  const projectionEmpty = records.taskRuns.length > 0 && records.workflowRuns.length === 0 &&
    workflowProjectionRowCount(db, tables) === 0
  return {
    workflow: verifyWorkflowProjection(db, !missingWorkflowTables, projectionEmpty, diagnostics),
    recovery: verifyRecoveryProjection(db, tables.has('workflow_recovery_sessions'), diagnostics)
  }
}

function verifyMissingSupportState(
  tables: ReadonlySet<string>,
  taskRuns: readonly TaskRunRecord[],
  snapshots: readonly TaskSnapshotRecord[],
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (!tables.has('effect_resource_fences') && hasLeasedEffect([...taskRuns, ...snapshots.flatMap((item) => item.run ? [item.run] : [])])) {
    addDiagnostic(diagnostics, 'fence_table_missing_with_leases', 'corruption',
      'effect_resource_fences is missing while persisted TaskRuns retain lease fencing state',
      { table: 'effect_resource_fences' })
  }
  if (!tables.has(DAG_FINALIZERS_TABLE) && snapshots.some((snapshot) =>
    snapshot.dagExecutions.some((execution) => execution.finalization !== undefined)
  )) {
    addDiagnostic(diagnostics, 'dag_finalizer_table_missing_with_state', 'corruption',
      'dag_finalizers is missing while a Snapshot retains DAG finalization state',
      { table: DAG_FINALIZERS_TABLE })
  }
}

function hasLeasedEffect(runs: readonly TaskRunRecord[]): boolean {
  return runs.some((run) => run.effects?.some((effect) => effect.lease !== undefined) ?? false)
}

/** Read a database file directly without invoking task-store setup/backfill. */
export async function assessWorkflowLedgerCanonicalReadinessFile(
  databasePath: string,
  options: { assessedAt?: number } = {}
): Promise<WorkflowLedgerCanonicalReadinessReport> {
  const path = resolve(databasePath)
  const bytes = await readRegularFile(path, 'Workflow Ledger database')
  const db = await openWorkflowLedgerDatabase(bytes)
  try {
    return assessWorkflowLedgerCanonicalReadiness(db, {
      sourceKind: 'sqlite',
      sourcePath: path,
      sourceBytes: bytes,
      assessedAt: options.assessedAt
    })
  } finally {
    db.close()
  }
}

/** Legacy migration must not inherit the production reader's skip-invalid behavior. */
export function validateLegacyJsonMigrationSource(sourceBytes: Uint8Array): readonly TaskSnapshotRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(sourceBytes).toString('utf8')) as unknown
  } catch (error) {
    throw new WorkflowLedgerMigrationError('LEGACY_JSON_INVALID', `Legacy task snapshot JSON is invalid: ${safeErrorMessage(error)}`)
  }
  const snapshots = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' &&
        (parsed as { version?: unknown }).version === 1 && Array.isArray((parsed as { snapshots?: unknown }).snapshots)
      ? (parsed as { snapshots: unknown[] }).snapshots
      : null
  if (!snapshots) {
    throw new WorkflowLedgerMigrationError('LEGACY_JSON_INVALID', 'Legacy task snapshot JSON has an unsupported root shape')
  }
  const seen = new Set<string>()
  const seenSessions = new Set<string>()
  const seenRuns = new Set<string>()
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index]
    if (!isTaskSnapshotRecord(snapshot)) {
      throw new WorkflowLedgerMigrationError('LEGACY_JSON_INVALID', `Legacy task snapshot row ${index} failed schema validation`)
    }
    if (seen.has(snapshot.id)) {
      throw new WorkflowLedgerMigrationError('LEGACY_JSON_INVALID', `Legacy task snapshot id ${snapshot.id} is duplicated`)
    }
    if (seenSessions.has(snapshot.sessionId)) {
      throw new WorkflowLedgerMigrationError(
        'LEGACY_JSON_INVALID',
        `Legacy task snapshot session ${snapshot.sessionId} is duplicated`
      )
    }
    if (snapshot.run && seenRuns.has(snapshot.run.id)) {
      throw new WorkflowLedgerMigrationError('LEGACY_JSON_INVALID', `Legacy TaskRun id ${snapshot.run.id} is duplicated`)
    }
    seen.add(snapshot.id)
    seenSessions.add(snapshot.sessionId)
    if (snapshot.run) seenRuns.add(snapshot.run.id)
  }
  return snapshots as TaskSnapshotRecord[]
}

export async function openWorkflowLedgerDatabase(bytes: Uint8Array): Promise<WorkflowLedgerDatabase> {
  const SQL = await loadSql()
  try {
    return new SQL.Database(bytes)
  } catch (error) {
    throw new WorkflowLedgerMigrationError('DATABASE_OPEN_FAILED', safeErrorMessage(error))
  }
}

export function readWorkflowLedgerStoreVersionStrict(db: WorkflowLedgerDatabase): number {
  const value = db.exec('PRAGMA user_version')[0]?.values[0]?.[0]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowLedgerMigrationError('STORE_VERSION_INVALID', 'Task snapshot database user_version is invalid')
  }
  return value
}

function verifyRequiredTables(
  db: WorkflowLedgerDatabase,
  tables: ReadonlySet<string>,
  storeVersion: number | null,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (!tables.has('task_snapshots')) {
    const category = storeVersion !== null && storeVersion < 1 ? 'additive_projection' : 'corruption'
    addDiagnostic(diagnostics, 'legacy_snapshot_table_missing', category,
      'Required table task_snapshots is missing', { table: 'task_snapshots', scope: 'legacy' })
  }
  if (!tables.has('task_runs')) {
    const category = storeVersion !== null && storeVersion < 4 ? 'additive_projection' : 'corruption'
    addDiagnostic(diagnostics, 'legacy_task_run_table_missing', category,
      'Required table task_runs is missing', { table: 'task_runs', scope: 'legacy' })
  }
  for (const table of REQUIRED_WORKFLOW_TABLES) {
    if (!tables.has(table)) {
      addDiagnostic(diagnostics, 'additive_projection_table_missing', 'additive_projection',
        `Additive Workflow Ledger table ${table} is missing`, { table, scope: 'canonical' })
    }
  }
  for (const table of REQUIRED_TASK_SUPPORT_TABLES) {
    if (!tables.has(table)) {
      addDiagnostic(diagnostics, 'additive_task_support_table_missing', 'additive_projection',
        `Additive task support table ${table} is missing`, { table, scope: 'shared' })
    }
  }
  if (!tables.has(DAG_FINALIZERS_TABLE)) {
    addDiagnostic(diagnostics, 'additive_dag_finalizer_table_missing', 'additive_projection',
      'Additive DAG finalizer table dag_finalizers is missing', {
        table: DAG_FINALIZERS_TABLE,
        scope: 'shared'
      })
  }
  if (tables.has('effect_resource_fences')) verifyFenceTable(db, diagnostics)
}

function verifyFenceTable(
  db: WorkflowLedgerDatabase,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  const columns = readFenceColumns(db)
  if (!columns || !isFenceSchemaCompatible(columns)) {
    addFenceDiagnostic(diagnostics, 'fence_schema_invalid',
      'effect_resource_fences schema is incompatible with resource fencing')
    return
  }
  if (hasInvalidFenceRow(db)) {
    addFenceDiagnostic(diagnostics, 'fence_row_invalid',
      'effect_resource_fences contains an invalid resource token')
  }
}

type FenceColumn = { type: string; notNull: number; primaryKey: number }

function readFenceColumns(db: WorkflowLedgerDatabase): Map<string, FenceColumn> | null {
  const columns = new Map<string, FenceColumn>()
  const pragma = db.prepare('PRAGMA table_info("effect_resource_fences")')
  try {
    while (pragma.step()) {
      const row = pragma.getAsObject()
      if (typeof row.name !== 'string' || typeof row.type !== 'string' ||
          typeof row.notnull !== 'number' || typeof row.pk !== 'number') {
        return null
      }
      columns.set(row.name, { type: row.type.toUpperCase(), notNull: row.notnull, primaryKey: row.pk })
    }
  } finally {
    pragma.free()
  }
  return columns
}

function isFenceSchemaCompatible(columns: ReadonlyMap<string, FenceColumn>): boolean {
  const key = columns.get('resource_key')
  const token = columns.get('fencing_token')
  return Boolean(key && token && key.type.includes('TEXT') && token.type.includes('INT') &&
    key.primaryKey === 1 && token.notNull === 1)
}

function hasInvalidFenceRow(db: WorkflowLedgerDatabase): boolean {
  const rows = db.prepare('SELECT resource_key, fencing_token FROM effect_resource_fences')
  try {
    while (rows.step()) {
      const row = rows.getAsObject()
      if (typeof row.resource_key !== 'string' || !row.resource_key.trim() ||
          typeof row.fencing_token !== 'number' || !Number.isSafeInteger(row.fencing_token) || row.fencing_token < 0) {
        return true
      }
    }
  } finally {
    rows.free()
  }
  return false
}

function addFenceDiagnostic(
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[],
  code: string,
  message: string
): void {
  addDiagnostic(diagnostics, code, 'corruption', message, {
    table: 'effect_resource_fences',
    scope: 'shared'
  })
}

function verifyWorkflowProjection(
  db: WorkflowLedgerDatabase,
  hasAllTables: boolean,
  projectionEmpty: boolean,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): WorkflowLedgerVerification | undefined {
  if (hasAllTables && !projectionEmpty) {
    try {
      return verifyWorkflowLedgerWithArtifactGraph(db)
    } catch (error) {
      addDiagnostic(diagnostics, 'workflow_verification_failed', 'corruption', safeErrorMessage(error), {
        scope: 'canonical'
      })
    }
  } else if (projectionEmpty) {
    addDiagnostic(diagnostics, 'additive_projection_empty', 'additive_projection',
      'Workflow projection is empty while legacy TaskRuns remain available', { scope: 'canonical' })
  }
  return undefined
}

function verifyEvidenceProjection(
  db: WorkflowLedgerDatabase,
  tables: ReadonlySet<string>,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): { verification?: TaskEvidenceVerification; records: TaskEvidenceRecord[] } {
  if (!tables.has('task_evidence')) return { records: [] }
  try {
    return { verification: verifyTaskEvidence(db), records: selectTaskEvidence(db) }
  } catch (error) {
    addDiagnostic(diagnostics, 'task_evidence_verification_failed', 'corruption', safeErrorMessage(error), {
      scope: 'canonical'
    })
    return { records: [] }
  }
}

function readDagFinalizationCount(
  db: WorkflowLedgerDatabase,
  tables: ReadonlySet<string>,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): number {
  if (!tables.has(DAG_FINALIZERS_TABLE)) return 0
  try {
    return selectTaskDagFinalizations(db).length
  } catch (error) {
    addDiagnostic(diagnostics, 'dag_finalizer_verification_failed', 'corruption', safeErrorMessage(error), {
      table: DAG_FINALIZERS_TABLE,
      scope: 'shared'
    })
    return 0
  }
}

function readTaskRuns(
  db: WorkflowLedgerDatabase,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): TaskRunRecord[] {
  const runs: TaskRunRecord[] = []
  const stmt = db.prepare('SELECT id, session_id, updated_at, payload FROM task_runs ORDER BY id ASC')
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      try {
        const parsed = JSON.parse(requiredText(row.payload, 'TaskRun payload')) as unknown
        if (!isTaskRunRecord(parsed)) throw new Error('schema validation failed')
        if (row.id !== parsed.id || row.session_id !== parsed.sessionId || row.updated_at !== parsed.updatedAt) {
          throw new Error('payload does not match SQL metadata')
        }
        runs.push(parsed)
      } catch (error) {
        addDiagnostic(diagnostics, 'task_run_invalid', 'corruption', safeErrorMessage(error), {
          entityId: typeof row.id === 'string' ? row.id : undefined,
          table: 'task_runs',
          scope: 'legacy'
        })
      }
    }
  } finally {
    stmt.free()
  }
  return runs
}

function readTaskSnapshots(
  db: WorkflowLedgerDatabase,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): TaskSnapshotRecord[] {
  const snapshots: TaskSnapshotRecord[] = []
  const stmt = db.prepare('SELECT id, session_id, updated_at, payload FROM task_snapshots ORDER BY id ASC')
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      try {
        const parsed = JSON.parse(requiredText(row.payload, 'TaskSnapshot payload')) as unknown
        if (!isTaskSnapshotRecord(parsed)) throw new Error('schema validation failed')
        if (row.id !== parsed.id || row.session_id !== parsed.sessionId || row.updated_at !== parsed.updatedAt) {
          throw new Error('payload does not match SQL metadata')
        }
        snapshots.push(parsed)
      } catch (error) {
        addDiagnostic(diagnostics, 'task_snapshot_invalid', 'corruption', safeErrorMessage(error), {
          entityId: typeof row.id === 'string' ? row.id : undefined,
          table: 'task_snapshots',
          scope: 'legacy'
        })
      }
    }
  } finally {
    stmt.free()
  }
  return snapshots
}

function readWorkflowRuns(
  db: WorkflowLedgerDatabase,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): WorkflowRunRecord[] {
  try {
    return readRuns(db)
  } catch (error) {
    addDiagnostic(diagnostics, 'workflow_run_invalid', 'corruption', safeErrorMessage(error), {
      table: 'workflow_runs',
      scope: 'canonical'
    })
    return []
  }
}

function readWorkflowRecovery(
  db: WorkflowLedgerDatabase,
  hasTable: boolean,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): { records: TaskSnapshotRecord[] } {
  if (!hasTable) return { records: [] }
  try {
    return { records: readCanonicalRecoverySessions(db) }
  } catch (error) {
    addDiagnostic(diagnostics, 'workflow_recovery_invalid', 'corruption', safeErrorMessage(error), {
      table: 'workflow_recovery_sessions',
      scope: 'canonical'
    })
    return { records: [] }
  }
}

function verifyRecoveryProjection(
  db: WorkflowLedgerDatabase,
  hasTable: boolean,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): WorkflowRecoveryVerification | undefined {
  if (!hasTable) return undefined
  try {
    return verifyWorkflowRecoveryProjection(db)
  } catch (error) {
    addDiagnostic(diagnostics, 'workflow_recovery_verification_failed', 'corruption', safeErrorMessage(error), {
      table: 'workflow_recovery_sessions',
      scope: 'canonical'
    })
    return undefined
  }
}

function readTableNames(db: WorkflowLedgerDatabase): Set<string> {
  const names = new Set<string>()
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  try {
    while (stmt.step()) {
      const name = stmt.getAsObject().name
      if (typeof name === 'string') names.add(name)
    }
  } finally {
    stmt.free()
  }
  return names
}

function workflowProjectionRowCount(db: WorkflowLedgerDatabase, tables: ReadonlySet<string>): number {
  let total = 0
  for (const table of REQUIRED_WORKFLOW_TABLES.filter((name) => name.startsWith('workflow_'))) {
    if (!tables.has(table)) continue
    const count = db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0]
    if (typeof count === 'number') total += count
  }
  return total
}

function verifySqliteIntegrity(
  db: WorkflowLedgerDatabase,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  try {
    const value = db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0]
    if (value !== 'ok') {
      addDiagnostic(diagnostics, 'sqlite_integrity_failed', 'corruption', `SQLite integrity_check: ${String(value)}`)
    }
  } catch (error) {
    addDiagnostic(diagnostics, 'sqlite_integrity_failed', 'corruption', safeErrorMessage(error))
  }
}

function readStoreVersion(
  db: WorkflowLedgerDatabase,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): number | null {
  try {
    return readWorkflowLedgerStoreVersionStrict(db)
  } catch (error) {
    addDiagnostic(diagnostics, 'store_version_invalid', 'corruption', safeErrorMessage(error))
    return null
  }
}

function addDiagnostic(
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[],
  code: string,
  category: WorkflowLedgerCanonicalReadinessDiagnostic['category'],
  message: string,
  extra: Pick<WorkflowLedgerCanonicalReadinessDiagnostic, 'entityId' | 'table' | 'scope'> = {}
): void {
  if (diagnostics.some((item) => item.code === code && item.entityId === extra.entityId && item.table === extra.table)) return
  diagnostics.push({ code, category, message, ...extra })
}

function collectionDigest(records: readonly unknown[]): string {
  return digest([...records].sort((left, right) => recordId(left).localeCompare(recordId(right))))
}

function recordId(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : canonicalJson(value)
}

function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => file.endsWith('.wasm') ? nodeRequire.resolve('sql.js/dist/sql-wasm.wasm') : file
    })
  }
  return sqlPromise
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not text`)
  return value
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
