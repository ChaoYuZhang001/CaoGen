import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEventRecord,
  WorkflowGoalRecord,
  WorkflowRunRecord,
  WorkflowWorkItemRecord
} from '../../shared/workflow-types'
import { canonicalJson } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'

export function setupWorkflowLedgerSchema(db: WorkflowLedgerDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_goals (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      goal_id TEXT,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      current_run_id TEXT,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL,
      digest TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_acceptances (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_evidence_links (
      id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL,
      project_id TEXT,
      run_id TEXT,
      artifact_id TEXT,
      acceptance_id TEXT,
      relation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_events (
      seq INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      stream_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT,
      run_id TEXT,
      session_id TEXT,
      occurred_at INTEGER NOT NULL,
      causation_id TEXT,
      correlation_id TEXT,
      prev_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_goals_project ON workflow_goals(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_work_items_project ON workflow_work_items(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_work_items_goal ON workflow_work_items(goal_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_work_item ON workflow_runs(work_item_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_session ON workflow_runs(session_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_work_item ON workflow_artifacts(work_item_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run ON workflow_artifacts(run_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_acceptances_work_item ON workflow_acceptances(work_item_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_links_evidence ON workflow_evidence_links(evidence_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_links_acceptance ON workflow_evidence_links(acceptance_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_entity ON workflow_events(entity_type, entity_id, seq);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_project ON workflow_events(project_id, seq);
  `)
}

export function insertGoal(db: WorkflowLedgerDatabase, goal: WorkflowGoalRecord): void {
  db.run(
    `INSERT INTO workflow_goals(id, project_id, status, revision, updated_at, payload)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       revision = excluded.revision,
       updated_at = excluded.updated_at,
       payload = excluded.payload`,
    [goal.id, goal.projectId ?? null, goal.status, goal.revision, goal.updatedAt, canonicalJson(goal)]
  )
}

export function insertWorkItem(db: WorkflowLedgerDatabase, item: WorkflowWorkItemRecord): void {
  db.run(
    `INSERT INTO workflow_work_items(id, project_id, goal_id, status, revision, current_run_id, updated_at, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       goal_id = excluded.goal_id,
       status = excluded.status,
       revision = excluded.revision,
       current_run_id = excluded.current_run_id,
       updated_at = excluded.updated_at,
       payload = excluded.payload`,
    [
      item.id,
      item.projectId ?? null,
      item.goalId ?? null,
      item.status,
      item.revision,
      item.currentRunId ?? null,
      item.updatedAt,
      canonicalJson(item)
    ]
  )
}

export function insertRun(db: WorkflowLedgerDatabase, run: WorkflowRunRecord): void {
  db.run(
    `INSERT INTO workflow_runs(
       id, project_id, goal_id, work_item_id, session_id, task_id,
       status, revision, attempt, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       revision = excluded.revision,
       attempt = excluded.attempt,
       updated_at = excluded.updated_at,
       payload = excluded.payload`,
    [
      run.id,
      run.projectId ?? null,
      run.goalId ?? null,
      run.workItemId,
      run.sessionId,
      run.taskId,
      run.status,
      run.revision,
      run.attempt,
      run.updatedAt,
      canonicalJson(run)
    ]
  )
}

export function insertArtifact(db: WorkflowLedgerDatabase, artifact: WorkflowArtifactRecord): void {
  db.run(
    `INSERT INTO workflow_artifacts(
       id, project_id, goal_id, work_item_id, run_id, kind, digest, version, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      artifact.id,
      artifact.projectId ?? null,
      artifact.goalId ?? null,
      artifact.workItemId ?? null,
      artifact.runId ?? null,
      artifact.kind,
      artifact.digest,
      artifact.version,
      artifact.updatedAt,
      canonicalJson(artifact)
    ]
  )
}

export function insertAcceptance(db: WorkflowLedgerDatabase, acceptance: WorkflowAcceptanceRecord): void {
  db.run(
    `INSERT INTO workflow_acceptances(
       id, project_id, goal_id, work_item_id, status, revision, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       revision = excluded.revision,
       updated_at = excluded.updated_at,
       payload = excluded.payload`,
    [
      acceptance.id,
      acceptance.projectId ?? null,
      acceptance.goalId ?? null,
      acceptance.workItemId ?? null,
      acceptance.status,
      acceptance.revision,
      acceptance.updatedAt,
      canonicalJson(acceptance)
    ]
  )
}

export function insertEvidenceLink(db: WorkflowLedgerDatabase, link: WorkflowEvidenceLinkRecord): void {
  db.run(
    `INSERT INTO workflow_evidence_links(
       id, evidence_id, project_id, run_id, artifact_id, acceptance_id, relation, created_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      link.id,
      link.evidenceId,
      link.projectId ?? null,
      link.runId ?? null,
      link.artifactId ?? null,
      link.acceptanceId ?? null,
      link.relation,
      link.createdAt,
      canonicalJson(link)
    ]
  )
}

export function insertEvent(db: WorkflowLedgerDatabase, event: WorkflowEventRecord): void {
  db.run(
    `INSERT INTO workflow_events(
       seq, event_id, stream_id, entity_type, entity_id, kind,
       project_id, goal_id, work_item_id, run_id, session_id, occurred_at,
       causation_id, correlation_id, prev_digest, record_digest, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.seq,
      event.eventId,
      event.streamId,
      event.entityType,
      event.entityId,
      event.kind,
      optionalField(event, 'projectId'),
      optionalField(event, 'goalId'),
      optionalField(event, 'workItemId'),
      optionalField(event, 'runId'),
      optionalField(event, 'sessionId'),
      event.occurredAt,
      event.causationId ?? null,
      event.correlationId ?? null,
      event.prevDigest,
      event.digest,
      canonicalJson(event.payload)
    ]
  )
}

export function readRows(db: WorkflowLedgerDatabase, sql: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  const stmt = db.prepare(sql)
  try {
    while (stmt.step()) rows.push(stmt.getAsObject())
  } finally {
    stmt.free()
  }
  return rows
}

function optionalField(record: object, key: string): string | null {
  const value = (record as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}
