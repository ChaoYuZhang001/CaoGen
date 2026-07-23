import type initSqlJs from 'sql.js'
import { setupTaskDagFinalizationSchema } from './task-dag-finalization-store'
import { setupTaskEvidenceSchema } from './task-evidence-store'
import { setupWorkflowArtifactGraphSchema } from './workflow-ledger-artifact-graph-types'
import { setupWorkflowEvidenceSchema } from './workflow-evidence-store'
import { setupWorkflowLedgerSchema } from './workflow-ledger-store'
import { setupWorkflowRecoverySchema } from './workflow-ledger-recovery'
import { setupWorkflowLedgerStoreIdentity } from './workflow-ledger-store-identity'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
type SqlDatabase = InstanceType<SqlJsStatic['Database']>

export function setupTaskSnapshotSchema(db: SqlDatabase, storeVersion: number): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS task_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_task_snapshots_session_id ON task_snapshots(session_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_task_snapshots_updated_at ON task_snapshots(updated_at);')
  db.run(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_task_runs_session_id ON task_runs(session_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_task_runs_updated_at ON task_runs(updated_at);')
  db.run(`
    CREATE TABLE IF NOT EXISTS effect_resource_fences (
      resource_key TEXT PRIMARY KEY,
      fencing_token INTEGER NOT NULL
    );
  `)
  setupTaskEvidenceSchema(db)
  setupTaskDagFinalizationSchema(db)
  setupWorkflowLedgerSchema(db)
  setupWorkflowEvidenceSchema(db)
  setupWorkflowArtifactGraphSchema(db)
  setupWorkflowRecoverySchema(db)
  setupWorkflowLedgerStoreIdentity(db)
  db.run(`PRAGMA user_version = ${storeVersion}`)
}
