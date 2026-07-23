import type { WorkflowEventRecord } from '../../shared/workflow-types'
import {
  canonicalJson,
  digest,
  requiredId
} from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import {
  appendWorkflowEvent,
  findWorkflowArtifact,
  registerWorkflowArtifact,
  setupWorkflowLedgerSchema
} from './workflow-ledger-store'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  assertArtifactScopeCompatibility,
  assertEndpointProjectCompatibility,
  assertEndpointScopeCompatibility,
  assertScopeReferences,
  decodeEdgeRow,
  decodeLocationRow,
  normalizeEdgeInput,
  normalizeLocationInput,
  requireArtifact
} from './workflow-ledger-artifact-graph-codec'
import {
  setupWorkflowArtifactGraphSchema,
  type WorkflowArtifactEdgeInput,
  type WorkflowArtifactEdgeRecord,
  type WorkflowArtifactLocationInput,
  type WorkflowArtifactLocationRecord
} from './workflow-ledger-artifact-graph-types'

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
} from './workflow-ledger-artifact-graph-types'
export { setupWorkflowArtifactGraphSchema } from './workflow-ledger-artifact-graph-types'
export {
  getWorkflowArtifactNeighborhood,
  queryWorkflowArtifactGraph,
  readArtifactEdges,
  readArtifactLocations,
  selectWorkflowArtifactEdges,
  selectWorkflowArtifactLocations,
  verifyWorkflowArtifactGraph
} from './workflow-ledger-artifact-graph-query'
export {
  createPersistedWorkflowArtifactEdge,
  createPersistedWorkflowArtifactLocation,
  listPersistedWorkflowArtifactEdges,
  listPersistedWorkflowArtifactLocations,
  queryPersistedWorkflowArtifactGraph,
  verifyPersistedWorkflowArtifactGraph
} from './workflow-ledger-artifact-graph-api'
export { registerWorkflowArtifact }

export function registerWorkflowArtifactEdge(db: WorkflowLedgerDatabase, input: WorkflowArtifactEdgeInput): WorkflowArtifactEdgeRecord {
  setupWorkflowArtifactGraphSchema(db)
  const edge = normalizeEdgeInput(input)
  const from = requireArtifact(db, edge.fromArtifactId, `edge ${edge.id} source`)
  const to = requireArtifact(db, edge.toArtifactId, `edge ${edge.id} target`)
  assertEndpointProjectCompatibility(edge, from, to)
  assertScopeReferences(db, edge, edge.projectId, `edge ${edge.id}`)
  assertEndpointScopeCompatibility(edge, from, to)
  const existing = findWorkflowArtifactEdge(db, edge.id)
  if (existing) {
    if (digest(existing) !== digest(edge)) throw new WorkflowLedgerCorruptionError(`artifact edge ${edge.id} immutable content changed`)
    appendArtifactGraphEvent(db, edge, 'workflow.artifact.edge.created', `artifact-edge:${edge.id}`, edge.fromArtifactId)
    return existing
  }
  db.run(
    `INSERT INTO workflow_artifact_edges(
       id, from_artifact_id, to_artifact_id, relation, project_id, goal_id,
       work_item_id, run_id, created_at, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [edge.id, edge.fromArtifactId, edge.toArtifactId, edge.relation, edge.projectId ?? null,
      edge.goalId ?? null, edge.workItemId ?? null, edge.runId ?? null, edge.createdAt,
      edge.updatedAt, canonicalJson(edge)]
  )
  appendArtifactGraphEvent(db, edge, 'workflow.artifact.edge.created', `artifact-edge:${edge.id}`, edge.fromArtifactId)
  return edge
}

export function recordWorkflowArtifactLocation(db: WorkflowLedgerDatabase, input: WorkflowArtifactLocationInput): WorkflowArtifactLocationRecord {
  setupWorkflowArtifactGraphSchema(db)
  const location = normalizeLocationInput(input)
  const artifact = requireArtifact(db, location.artifactId, `location ${location.id} artifact`)
  assertLocationOwnership(db, location, artifact)
  const existing = findWorkflowArtifactLocation(db, location.id)
  if (existing) {
    if (digest(existing) !== digest(location)) throw new WorkflowLedgerCorruptionError(`artifact location ${location.id} immutable content changed`)
    appendArtifactGraphEvent(db, location, 'workflow.artifact.location.created', `artifact-location:${location.id}`, location.artifactId)
    return existing
  }
  db.run(
    `INSERT INTO workflow_artifact_locations(
       id, artifact_id, project_id, goal_id, work_item_id, run_id, kind,
       uri, path, availability, checksum, size_bytes, media_type,
       created_at, updated_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [location.id, location.artifactId, location.projectId ?? null, location.goalId ?? null,
      location.workItemId ?? null, location.runId ?? null, location.kind, location.uri ?? null,
      location.path ?? null, location.availability, location.checksum ?? null,
      location.sizeBytes ?? null, location.mediaType ?? null, location.createdAt,
      location.updatedAt, canonicalJson(location)]
  )
  appendArtifactGraphEvent(db, location, 'workflow.artifact.location.created', `artifact-location:${location.id}`, location.artifactId)
  return location
}

export function findWorkflowArtifactEdge(db: WorkflowLedgerDatabase, id: string): WorkflowArtifactEdgeRecord | null {
  setupWorkflowArtifactGraphSchema(db)
  const normalizedId = requiredId(id, 'artifact edge id')
  const stmt = db.prepare('SELECT * FROM workflow_artifact_edges WHERE id = ? LIMIT 1')
  try {
    stmt.bind([normalizedId])
    return stmt.step() ? decodeEdgeRow(stmt.getAsObject()) : null
  } finally {
    stmt.free()
  }
}

export function findWorkflowArtifactLocation(db: WorkflowLedgerDatabase, id: string): WorkflowArtifactLocationRecord | null {
  setupWorkflowArtifactGraphSchema(db)
  const normalizedId = requiredId(id, 'artifact location id')
  const stmt = db.prepare('SELECT * FROM workflow_artifact_locations WHERE id = ? LIMIT 1')
  try {
    stmt.bind([normalizedId])
    return stmt.step() ? decodeLocationRow(stmt.getAsObject()) : null
  } finally {
    stmt.free()
  }
}

function assertLocationOwnership(
  db: WorkflowLedgerDatabase,
  location: WorkflowArtifactLocationRecord,
  artifact: ReturnType<typeof findWorkflowArtifact> extends infer T ? Exclude<T, null> : never
): void {
  if (location.projectId !== artifact.projectId) {
    throw new WorkflowLedgerCorruptionError(`artifact location project ownership differs from artifact ${artifact.id}`)
  }
  assertScopeReferences(db, location, location.projectId, `location ${location.id}`)
  assertArtifactScopeCompatibility(location, artifact)
}

function appendArtifactGraphEvent(
  db: WorkflowLedgerDatabase,
  record: WorkflowArtifactEdgeRecord | WorkflowArtifactLocationRecord,
  kind: 'workflow.artifact.edge.created' | 'workflow.artifact.location.created',
  entityId: string,
  artifactStreamId: string
): WorkflowEventRecord {
  return appendWorkflowEvent(db, {
    eventId: `${kind}:${record.id}`,
    streamId: `artifact:${artifactStreamId}`,
    entityType: 'artifact',
    entityId,
    kind,
    payload: record as unknown as Record<string, unknown>,
    occurredAt: record.createdAt,
    correlationId: artifactStreamId
  }, {
    projectId: record.projectId,
    goalId: record.goalId,
    workItemId: record.workItemId,
    runId: record.runId
  })
}

// Keep the base schema export available to small consumers that previously imported it here.
export { setupWorkflowLedgerSchema }
