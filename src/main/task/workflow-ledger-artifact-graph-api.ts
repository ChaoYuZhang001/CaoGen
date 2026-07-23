import {
  mutateTaskSnapshotDatabase,
  readTaskSnapshotDatabase
} from './task-snapshot'
import {
  recordWorkflowArtifactLocation,
  registerWorkflowArtifactEdge
} from './workflow-ledger-artifact-graph'
import {
  queryWorkflowArtifactGraph,
  selectWorkflowArtifactEdges,
  selectWorkflowArtifactLocations,
  verifyWorkflowArtifactGraph,
  verifyWorkflowLedgerWithArtifactGraph
} from './workflow-ledger-artifact-graph-query'
import type {
  WorkflowArtifactEdgeInput,
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactGraphScope,
  WorkflowArtifactGraphVerification,
  WorkflowArtifactLocationInput,
  WorkflowArtifactLocationRecord,
  WorkflowArtifactNeighborhood
} from './workflow-ledger-artifact-graph-types'
import type { WorkflowLedgerPage, WorkflowLedgerVerification } from '../../shared/workflow-types'

export async function createPersistedWorkflowArtifactEdge(input: WorkflowArtifactEdgeInput, rootDir?: string): Promise<WorkflowArtifactEdgeRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => registerWorkflowArtifactEdge(db, input))
}

export async function createPersistedWorkflowArtifactLocation(input: WorkflowArtifactLocationInput, rootDir?: string): Promise<WorkflowArtifactLocationRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => recordWorkflowArtifactLocation(db, input))
}

export async function listPersistedWorkflowArtifactEdges(scope: WorkflowArtifactGraphScope = {}, rootDir?: string): Promise<WorkflowLedgerPage<WorkflowArtifactEdgeRecord>> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    verifyWorkflowArtifactGraph(db)
    return selectWorkflowArtifactEdges(db, scope)
  })
}

export async function listPersistedWorkflowArtifactLocations(scope: WorkflowArtifactGraphScope = {}, rootDir?: string): Promise<WorkflowLedgerPage<WorkflowArtifactLocationRecord>> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    verifyWorkflowArtifactGraph(db)
    return selectWorkflowArtifactLocations(db, scope)
  })
}

export async function queryPersistedWorkflowArtifactGraph(artifactId: string, rootDir?: string): Promise<WorkflowArtifactNeighborhood> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    verifyWorkflowArtifactGraph(db)
    return queryWorkflowArtifactGraph(db, artifactId)
  })
}

export async function verifyPersistedWorkflowArtifactGraph(rootDir?: string): Promise<WorkflowArtifactGraphVerification> {
  return readTaskSnapshotDatabase(rootDir, (db) => verifyWorkflowArtifactGraph(db))
}

export async function verifyPersistedWorkflowLedgerWithArtifactGraph(
  rootDir?: string
): Promise<WorkflowLedgerVerification> {
  return readTaskSnapshotDatabase(rootDir, (db) => verifyWorkflowLedgerWithArtifactGraph(db))
}
