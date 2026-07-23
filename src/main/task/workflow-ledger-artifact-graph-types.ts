import type {
  WorkflowArtifactEdgeRelation,
  WorkflowArtifactLocationAvailability,
  WorkflowArtifactLocationKind
} from '../../shared/workflow-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { setupWorkflowLedgerSchema } from './workflow-ledger-store'

export type {
  WorkflowArtifactEdgeInput,
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactEdgeRelation,
  WorkflowArtifactGraphScope,
  WorkflowArtifactGraphSelection,
  WorkflowArtifactGraphVerification,
  WorkflowArtifactLocationAvailability,
  WorkflowArtifactLocationInput,
  WorkflowArtifactLocationKind,
  WorkflowArtifactLocationRecord,
  WorkflowArtifactNeighborhood
} from '../../shared/workflow-types'

export const EDGE_RELATIONS: readonly WorkflowArtifactEdgeRelation[] = [
  'derived_from', 'produced_from', 'input_to', 'output_of', 'supports', 'verifies',
  'supersedes', 'annotates', 'references', 'depends_on', 'related_to', 'custom'
]

export const LOCATION_KINDS: readonly WorkflowArtifactLocationKind[] = [
  'blob', 'file', 'workspace', 'url', 'git', 'attachment', 'preview', 'external', 'custom'
]

export const LOCATION_AVAILABILITIES: readonly WorkflowArtifactLocationAvailability[] = [
  'available', 'pending', 'unavailable', 'deleted', 'unknown'
]

/** Graph tables remain additive and do not change the v7 task snapshot version. */
export function setupWorkflowArtifactGraphSchema(db: WorkflowLedgerDatabase): void {
  setupWorkflowLedgerSchema(db)
  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_artifact_edges (
      id TEXT PRIMARY KEY,
      from_artifact_id TEXT NOT NULL,
      to_artifact_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_artifact_locations (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      project_id TEXT,
      goal_id TEXT,
      work_item_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL,
      uri TEXT,
      path TEXT,
      availability TEXT NOT NULL,
      checksum TEXT,
      size_bytes INTEGER,
      media_type TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_edges_project
      ON workflow_artifact_edges(project_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_edges_from
      ON workflow_artifact_edges(from_artifact_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_edges_to
      ON workflow_artifact_edges(to_artifact_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_edges_relation
      ON workflow_artifact_edges(relation, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_locations_artifact
      ON workflow_artifact_locations(artifact_id, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_locations_project
      ON workflow_artifact_locations(project_id, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_artifact_locations_kind
      ON workflow_artifact_locations(kind, updated_at, id);
  `)
}
