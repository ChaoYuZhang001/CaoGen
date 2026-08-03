import { lstat, rm } from 'node:fs/promises'
import type { TaskSnapshotDatabase } from '../task/task-snapshot'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from '../task/task-snapshot'
import { artifactBlobPath } from '../task/artifact-lifecycle-content'
import { setupArtifactLifecycleSchema } from '../task/artifact-lifecycle-store'
import { verifyModelAttemptLedger } from '../task/model-attempt-store'
import { purgeModelAttemptsProject } from '../task/model-attempt-project-purge'
import { purgeTaskEvidenceProject, verifyTaskEvidence } from '../task/task-evidence-store'
import { setupTaskDagFinalizationSchema } from '../task/task-dag-finalization-store'
import { verifyWorkflowEvidence } from '../task/workflow-evidence-store'
import { purgeWorkflowEvidenceProject } from '../task/workflow-evidence-project-purge'
import { setupWorkflowArtifactGraphSchema } from '../task/workflow-ledger-artifact-graph-types'
import { verifyWorkflowArtifactGraph } from '../task/workflow-ledger-artifact-graph-query'
import {
  readAcceptances,
  readArtifacts,
  readEvidenceLinks,
  readGoals,
  readRuns,
  readWorkItems
} from '../task/workflow-ledger-query'
import {
  purgeWorkflowEventsProject,
  refreshWorkflowEvidenceEventProjections,
  setupWorkflowLedgerSchema,
  verifyWorkflowLedger
} from '../task/workflow-ledger-store'
import { setupWorkflowRecoverySchema, verifyWorkflowRecoveryProjection } from '../task/workflow-ledger-recovery'
import {
  recordWorkflowLedgerAuthorizedPurge,
  setupWorkflowLedgerAuthorizedPurgeSchema,
  verifyWorkflowLedgerAuthorizedPurges
} from '../task/workflow-ledger-authorized-purge'
import { setupConversationLedgerSchema } from '../task/conversation-ledger-schema'
import {
  countConversationLedgerProjectResiduals,
  purgeConversationLedgerProject,
  verifyConversationLedgerArchive
} from '../task/conversation-ledger-store'

const PROJECT_TABLES = [
  'workflow_goals',
  'workflow_work_items',
  'workflow_runs',
  'workflow_artifacts',
  'workflow_acceptances',
  'workflow_evidence_links',
  'workflow_artifact_edges',
  'workflow_artifact_locations',
  'workflow_artifact_lifecycles',
  'workflow_artifact_purges',
  'workflow_evidence',
  'task_evidence',
  'model_attempts'
] as const

export interface WorkflowProjectPurgeResult {
  projectId: string
  sessionIds: string[]
  removed: Record<string, number>
  deletedBlobDigests: string[]
  retainedSharedBlobDigests: string[]
  verification: {
    workflowEvents: number
    taskEvidence: number
    workflowEvidence: number
    modelAttempts: number
    recoverySessions: number
    conversationStreams: number
    conversationGenerations: number
    conversationEvents: number
  }
}

export interface WorkflowProjectResidualScan {
  projectId: string
  sessionIds: string[]
  counts: Record<string, number>
  total: number
}

interface DatabasePurgeResult extends Omit<WorkflowProjectPurgeResult, 'deletedBlobDigests'> {
  deletableBlobDigests: string[]
}

export async function purgeWorkflowProjectData(
  projectId: string,
  rootDir: string,
  operationId: string,
  knownSessionIds: readonly string[] = [],
  knownBlobDigests: readonly string[] = []
): Promise<WorkflowProjectPurgeResult> {
  const id = requiredId(projectId, 'projectId')
  const purgeOperationId = requiredId(operationId, 'operationId')
  const database = await mutateTaskSnapshotDatabase(rootDir, (db) =>
    purgeWorkflowProjectDatabase(db, id, purgeOperationId, knownSessionIds)
  )
  const remainingBlobDigests = await referencedBlobDigests(rootDir)
  const deletePlan = [...new Set([...database.deletableBlobDigests, ...knownBlobDigests.map(requiredBlobDigest)])]
    .filter((digest) => !remainingBlobDigests.has(digest))
    .sort()
  const deletedBlobDigests: string[] = []
  for (const digest of deletePlan) {
    const file = artifactBlobPath(rootDir, digest)
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`artifact blob is not a regular file: ${file}`)
      }
      await rm(file)
      deletedBlobDigests.push(digest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const { deletableBlobDigests: _deletable, ...result } = database
  return { ...result, deletedBlobDigests }
}

export async function planWorkflowProjectPurgeBlobs(projectId: string, rootDir: string): Promise<string[]> {
  const id = requiredId(projectId, 'projectId')
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupSchemas(db)
    return projectBlobPlan(db, id).deletable
  })
}

export async function scanWorkflowProjectResiduals(
  projectId: string,
  rootDir: string,
  knownSessionIds: readonly string[] = []
): Promise<WorkflowProjectResidualScan> {
  const id = requiredId(projectId, 'projectId')
  return readTaskSnapshotDatabase(rootDir, (db) => scanDatabase(db, id, new Set(knownSessionIds)))
}

function purgeWorkflowProjectDatabase(
  db: TaskSnapshotDatabase,
  projectId: string,
  operationId: string,
  knownSessionIds: readonly string[]
): DatabasePurgeResult {
  setupSchemas(db)
  verifyBeforePurge(db)

  const goals = readGoals(db).filter((record) => record.projectId === projectId)
  const workItems = readWorkItems(db).filter((record) => record.projectId === projectId)
  const runs = readRuns(db).filter((record) => record.projectId === projectId)
  const artifacts = readArtifacts(db).filter((record) => record.projectId === projectId)
  const acceptances = readAcceptances(db).filter((record) => record.projectId === projectId)
  const evidenceLinks = readEvidenceLinks(db).filter((record) => record.projectId === projectId)
  const goalIds = new Set(goals.map((record) => record.id))
  const workItemIds = new Set(workItems.map((record) => record.id))
  const runIds = new Set(runs.map((record) => record.id))
  const sessionIds = new Set([...knownSessionIds.map((value) => requiredId(value, 'sessionId')), ...runs.map((record) => record.sessionId)])
  const blobPlan = projectBlobPlan(db, projectId)

  const removed: Record<string, number> = {}
  const attempts = purgeModelAttemptsProject(db, projectId, runIds)
  removed.model_attempts = attempts.removedAttempts
  removed.model_attempt_events = attempts.removedEvents
  removed.workflow_events = purgeWorkflowEventsProject(db, {
    projectId,
    goalIds,
    workItemIds,
    runIds,
    sessionIds
  }).removed
  removed.task_evidence = purgeTaskEvidenceProject(db, projectId, sessionIds).removed
  removed.workflow_evidence = purgeWorkflowEvidenceProject(db, projectId).removed
  refreshWorkflowEvidenceEventProjections(db)

  removed.workflow_evidence_links = deleteProjectRows(db, 'workflow_evidence_links', projectId)
  removed.workflow_artifact_edges = deleteProjectRows(db, 'workflow_artifact_edges', projectId)
  removed.workflow_artifact_locations = deleteProjectRows(db, 'workflow_artifact_locations', projectId)
  removed.workflow_artifact_purges = deleteProjectRows(db, 'workflow_artifact_purges', projectId)
  removed.workflow_artifact_lifecycles = deleteProjectRows(db, 'workflow_artifact_lifecycles', projectId)
  removed.workflow_acceptances = deleteProjectRows(db, 'workflow_acceptances', projectId)
  removed.workflow_artifacts = deleteProjectRows(db, 'workflow_artifacts', projectId)
  removed.workflow_runs = deleteProjectRows(db, 'workflow_runs', projectId)
  removed.workflow_work_items = deleteProjectRows(db, 'workflow_work_items', projectId)
  removed.workflow_goals = deleteProjectRows(db, 'workflow_goals', projectId)
  removed.workflow_recovery_sessions = deleteProjectOrSessionRows(
    db, 'workflow_recovery_sessions', projectId, sessionIds
  )
  removed.task_runs = deleteIdOrSessionRows(db, 'task_runs', runIds, sessionIds)
  removed.task_snapshots = deleteIdOrSessionRows(db, 'task_snapshots', new Set(), sessionIds)
  removed.dag_finalizers = deleteByIds(db, 'dag_finalizers', 'parent_session_id', sessionIds)
  const conversations = purgeConversationLedgerProject(db, projectId, sessionIds)
  removed.conversation_ledger_streams = conversations.streams
  removed.conversation_ledger_generations = conversations.generations
  removed.conversation_ledger_events = conversations.events

  recordWorkflowLedgerAuthorizedPurge(db, {
    operationId,
    projectId,
    removed: {
      taskRuns: removed.task_runs,
      workflowRuns: removed.workflow_runs,
      workflowEvents: removed.workflow_events,
      taskEvidence: removed.task_evidence,
      conversationStreams: conversations.streams,
      conversationGenerations: conversations.generations,
      conversationEvents: conversations.events
    }
  })

  const scan = scanDatabase(db, projectId, sessionIds)
  if (scan.total !== 0) {
    throw new Error(`workflow Project purge left ${scan.total} residual rows: ${JSON.stringify(scan.counts)}`)
  }
  const verification = verifyAfterPurge(db)
  return {
    projectId,
    sessionIds: [...sessionIds].sort(),
    removed,
    deletableBlobDigests: blobPlan.deletable,
    retainedSharedBlobDigests: blobPlan.shared,
    verification
  }
}

function setupSchemas(db: TaskSnapshotDatabase): void {
  setupWorkflowLedgerSchema(db)
  setupWorkflowArtifactGraphSchema(db)
  setupWorkflowRecoverySchema(db)
  setupTaskDagFinalizationSchema(db)
  setupArtifactLifecycleSchema(db)
  setupWorkflowLedgerAuthorizedPurgeSchema(db)
  setupConversationLedgerSchema(db)
}

function verifyBeforePurge(db: TaskSnapshotDatabase): void {
  verifyWorkflowLedger(db)
  verifyWorkflowArtifactGraph(db)
  verifyTaskEvidence(db)
  verifyWorkflowEvidence(db)
  verifyModelAttemptLedger(db)
  verifyWorkflowRecoveryProjection(db)
  verifyWorkflowLedgerAuthorizedPurges(db)
  verifyConversationLedgerArchive(db)
}

function verifyAfterPurge(db: TaskSnapshotDatabase): WorkflowProjectPurgeResult['verification'] {
  const ledger = verifyWorkflowLedger(db)
  verifyWorkflowArtifactGraph(db)
  const taskEvidence = verifyTaskEvidence(db)
  const workflowEvidence = verifyWorkflowEvidence(db)
  const modelAttempts = verifyModelAttemptLedger(db)
  const recovery = verifyWorkflowRecoveryProjection(db)
  const conversations = verifyConversationLedgerArchive(db)
  verifyWorkflowLedgerAuthorizedPurges(db)
  return {
    workflowEvents: ledger.events,
    taskEvidence: taskEvidence.count,
    workflowEvidence: workflowEvidence.count,
    modelAttempts: modelAttempts.attempts,
    recoverySessions: recovery.recoverySessions,
    conversationStreams: conversations.streams,
    conversationGenerations: conversations.generations,
    conversationEvents: conversations.events
  }
}

function projectBlobPlan(
  db: TaskSnapshotDatabase,
  projectId: string
): { deletable: string[]; shared: string[] } {
  const rows = rowsOf(db, 'SELECT project_id, blob_ref FROM workflow_artifact_lifecycles WHERE blob_ref IS NOT NULL')
  const targetRefs = new Set(rows
    .filter((row) => row.project_id === projectId)
    .map((row) => blobDigest(row.blob_ref)))
  const sharedRefs = new Set(rows
    .filter((row) => row.project_id !== projectId)
    .map((row) => blobDigest(row.blob_ref)))
  return {
    deletable: [...targetRefs].filter((digest) => !sharedRefs.has(digest)).sort(),
    shared: [...targetRefs].filter((digest) => sharedRefs.has(digest)).sort()
  }
}

function scanDatabase(
  db: TaskSnapshotDatabase,
  projectId: string,
  sessionIds: ReadonlySet<string>
): WorkflowProjectResidualScan {
  setupSchemas(db)
  const counts: Record<string, number> = {}
  for (const table of PROJECT_TABLES) {
    if (!tableExists(db, table)) continue
    counts[table] = count(db, `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`, [projectId])
  }
  counts.workflow_events = count(db, 'SELECT COUNT(*) AS count FROM workflow_events WHERE project_id = ?', [projectId])
  counts.workflow_recovery_sessions = countProjectOrSessions(db, 'workflow_recovery_sessions', projectId, sessionIds)
  counts.task_runs = countIdOrSessions(db, 'task_runs', new Set(), sessionIds)
  counts.task_snapshots = countIdOrSessions(db, 'task_snapshots', new Set(), sessionIds)
  counts.dag_finalizers = countByIds(db, 'dag_finalizers', 'parent_session_id', sessionIds)
  const conversations = countConversationLedgerProjectResiduals(db, projectId, sessionIds)
  counts.conversation_ledger_streams = conversations.streams
  counts.conversation_ledger_generations = conversations.generations
  counts.conversation_ledger_events = conversations.events
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return { projectId, sessionIds: [...sessionIds].sort(), counts, total }
}

function deleteProjectRows(db: TaskSnapshotDatabase, table: string, projectId: string): number {
  db.run(`DELETE FROM ${table} WHERE project_id = ?`, [projectId])
  return db.getRowsModified()
}

function deleteProjectOrSessionRows(
  db: TaskSnapshotDatabase,
  table: string,
  projectId: string,
  sessionIds: ReadonlySet<string>
): number {
  const sessionClause = placeholders(sessionIds)
  const sql = `DELETE FROM ${table} WHERE project_id = ?${sessionClause ? ` OR session_id IN (${sessionClause})` : ''}`
  db.run(sql, [projectId, ...sessionIds])
  return db.getRowsModified()
}

function deleteIdOrSessionRows(
  db: TaskSnapshotDatabase,
  table: string,
  ids: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>
): number {
  const clauses: string[] = []
  const values: string[] = []
  if (ids.size > 0) {
    clauses.push(`id IN (${placeholders(ids)})`)
    values.push(...ids)
  }
  if (sessionIds.size > 0) {
    clauses.push(`session_id IN (${placeholders(sessionIds)})`)
    values.push(...sessionIds)
  }
  if (clauses.length === 0) return 0
  db.run(`DELETE FROM ${table} WHERE ${clauses.join(' OR ')}`, values)
  return db.getRowsModified()
}

function deleteByIds(
  db: TaskSnapshotDatabase,
  table: string,
  column: string,
  ids: ReadonlySet<string>
): number {
  if (ids.size === 0) return 0
  db.run(`DELETE FROM ${table} WHERE ${column} IN (${placeholders(ids)})`, [...ids])
  return db.getRowsModified()
}

function countProjectOrSessions(
  db: TaskSnapshotDatabase,
  table: string,
  projectId: string,
  sessionIds: ReadonlySet<string>
): number {
  const sessionClause = placeholders(sessionIds)
  const sql = `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?${sessionClause ? ` OR session_id IN (${sessionClause})` : ''}`
  return count(db, sql, [projectId, ...sessionIds])
}

function countIdOrSessions(
  db: TaskSnapshotDatabase,
  table: string,
  ids: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>
): number {
  const clauses: string[] = []
  const values: string[] = []
  if (ids.size > 0) {
    clauses.push(`id IN (${placeholders(ids)})`)
    values.push(...ids)
  }
  if (sessionIds.size > 0) {
    clauses.push(`session_id IN (${placeholders(sessionIds)})`)
    values.push(...sessionIds)
  }
  return clauses.length === 0 ? 0 : count(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${clauses.join(' OR ')}`, values)
}

function countByIds(
  db: TaskSnapshotDatabase,
  table: string,
  column: string,
  ids: ReadonlySet<string>
): number {
  return ids.size === 0 ? 0 : count(
    db,
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders(ids)})`,
    [...ids]
  )
}

function count(db: TaskSnapshotDatabase, sql: string, values: readonly string[]): number {
  const stmt = db.prepare(sql)
  try {
    stmt.bind([...values])
    if (!stmt.step()) return 0
    const value = stmt.getAsObject().count
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid residual count for ${sql}`)
    }
    return value
  } finally {
    stmt.free()
  }
}

function rowsOf(db: TaskSnapshotDatabase, sql: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  const stmt = db.prepare(sql)
  try {
    while (stmt.step()) rows.push(stmt.getAsObject())
  } finally {
    stmt.free()
  }
  return rows
}

function tableExists(db: TaskSnapshotDatabase, table: string): boolean {
  const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
  try {
    stmt.bind([table])
    return stmt.step()
  } finally {
    stmt.free()
  }
}

function placeholders(values: ReadonlySet<string>): string {
  return [...values].map(() => '?').join(', ')
}

function blobDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256\/[a-f0-9]{64}$/.test(value)) {
    throw new Error('artifact lifecycle blob_ref is invalid')
  }
  return `sha256:${value.slice('sha256/'.length)}`
}

async function referencedBlobDigests(rootDir: string): Promise<Set<string>> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupSchemas(db)
    return new Set(rowsOf(db,
      'SELECT blob_ref FROM workflow_artifact_lifecycles WHERE blob_ref IS NOT NULL')
      .map((row) => blobDigest(row.blob_ref)))
  })
}

function requiredBlobDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('artifact blob digest is invalid')
  }
  return value
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
}
