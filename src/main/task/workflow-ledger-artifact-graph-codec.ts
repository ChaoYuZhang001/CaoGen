import type { WorkflowArtifactRecord } from '../../shared/workflow-types'
import {
  canonicalJson,
  digest,
  finiteTimestamp,
  isRecord,
  normalizeOptionalId,
  optionalText,
  requiredId
} from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import {
  findWorkflowArtifact,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem
} from './workflow-ledger-store'
import {
  assertWorkflowArtifactLocationPathSafe,
  assertWorkflowArtifactLocationUriSafe,
  assertWorkflowArtifactMetadataSafe
} from './workflow-ledger-artifact-security'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  EDGE_RELATIONS,
  LOCATION_AVAILABILITIES,
  LOCATION_KINDS,
  type WorkflowArtifactEdgeInput,
  type WorkflowArtifactEdgeRecord,
  type WorkflowArtifactLocationInput,
  type WorkflowArtifactLocationRecord
} from './workflow-ledger-artifact-graph-types'

export type ScopedGraphRecord = {
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
}

export function normalizeEdgeInput(input: WorkflowArtifactEdgeInput): WorkflowArtifactEdgeRecord {
  if (!isRecord(input)) throw new WorkflowLedgerCorruptionError('artifact edge input must be an object')
  const candidate = input as WorkflowArtifactEdgeInput
  const id = requiredId(candidate.id, 'artifact edge id')
  const fromArtifactId = requiredId(candidate.fromArtifactId, 'artifact edge fromArtifactId')
  const toArtifactId = requiredId(candidate.toArtifactId, 'artifact edge toArtifactId')
  if (fromArtifactId === toArtifactId) {
    throw new WorkflowLedgerCorruptionError(`artifact edge ${id} cannot connect an artifact to itself`)
  }
  if (!EDGE_RELATIONS.includes(candidate.relation)) {
    throw new WorkflowLedgerCorruptionError(`artifact edge ${id} relation is invalid`)
  }
  if (candidate.metadata !== undefined && !isRecord(candidate.metadata)) {
    throw new WorkflowLedgerCorruptionError(`artifact edge ${id} metadata must be an object`)
  }
  assertWorkflowArtifactMetadataSafe(candidate.metadata, 'graph edge metadata')
  const createdAt = finiteTimestamp(candidate.createdAt ?? Date.now(), 'artifact edge createdAt')
  const updatedAt = finiteTimestamp(candidate.updatedAt ?? createdAt, 'artifact edge updatedAt')
  return {
    schemaVersion: 1,
    id,
    fromArtifactId,
    toArtifactId,
    relation: candidate.relation,
    ...optionalScope(candidate),
    ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    createdAt,
    updatedAt
  }
}

export function normalizeLocationInput(input: WorkflowArtifactLocationInput): WorkflowArtifactLocationRecord {
  if (!isRecord(input)) throw new WorkflowLedgerCorruptionError('artifact location input must be an object')
  const candidate = input as WorkflowArtifactLocationInput
  const artifactId = requiredId(candidate.artifactId, 'artifact location artifactId')
  const explicitId = optionalLocationId(candidate.id)
  const locator = normalizeLocationLocator(candidate, explicitId ?? artifactId)
  const metadata = normalizeLocationMetadata(candidate, explicitId ?? artifactId)
  const checksum = optionalText(candidate.checksum, 'artifact location checksum')
  const mediaType = optionalText(candidate.mediaType, 'artifact location mediaType')
  const sizeBytes = normalizeSizeBytes(candidate.sizeBytes)
  const createdAt = finiteTimestamp(candidate.createdAt ?? Date.now(), 'artifact location createdAt')
  const updatedAt = finiteTimestamp(candidate.updatedAt ?? createdAt, 'artifact location updatedAt')
  const locatorDigest = digest({ artifactId, ...locator, checksum, sizeBytes, mediaType })
  const id = explicitId ?? `artifact-location:${artifactId}:${locatorDigest.slice(0, 32)}`
  return {
    schemaVersion: 1,
    id,
    artifactId,
    ...optionalScope(candidate),
    kind: locator.kind,
    ...(locator.uri ? { uri: locator.uri } : {}),
    ...(locator.path ? { path: locator.path } : {}),
    availability: locator.availability,
    ...(checksum ? { checksum } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(mediaType ? { mediaType } : {}),
    ...(metadata === undefined ? {} : { metadata }),
    createdAt,
    updatedAt
  }
}

function optionalLocationId(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredId(value, 'artifact location id')
}

function normalizeLocationLocator(
  candidate: WorkflowArtifactLocationInput,
  label: string
): {
  kind: WorkflowArtifactLocationRecord['kind']
  uri?: string
  path?: string
  availability: WorkflowArtifactLocationRecord['availability']
} {
  const kind = candidate.kind
  if (!LOCATION_KINDS.includes(kind)) throw new WorkflowLedgerCorruptionError('artifact location kind is invalid')
  const uri = optionalText(candidate.uri, 'artifact location uri')
  const path = optionalText(candidate.path, 'artifact location path')
  if (!uri && !path) throw new WorkflowLedgerCorruptionError(`artifact location ${label} requires uri or path`)
  const availability = candidate.availability ?? 'available'
  if (!LOCATION_AVAILABILITIES.includes(availability)) throw new WorkflowLedgerCorruptionError('artifact location availability is invalid')
  assertWorkflowArtifactLocationUriSafe(uri)
  assertWorkflowArtifactLocationPathSafe(path)
  return { kind, ...(uri ? { uri } : {}), ...(path ? { path } : {}), availability }
}

function normalizeLocationMetadata(
  candidate: WorkflowArtifactLocationInput,
  label: string
): Record<string, unknown> | undefined {
  if (candidate.metadata !== undefined && !isRecord(candidate.metadata)) {
    throw new WorkflowLedgerCorruptionError(`artifact location ${label} metadata must be an object`)
  }
  assertWorkflowArtifactMetadataSafe(candidate.metadata, 'graph location metadata')
  return candidate.metadata
}

export function optionalScope(input: Pick<WorkflowArtifactEdgeInput, 'projectId' | 'goalId' | 'workItemId' | 'runId'>): ScopedGraphRecord {
  const projectId = normalizeOptionalId(input.projectId)
  const goalId = normalizeOptionalId(input.goalId)
  const workItemId = normalizeOptionalId(input.workItemId)
  const runId = normalizeOptionalId(input.runId)
  return {
    ...(projectId ? { projectId } : {}),
    ...(goalId ? { goalId } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(runId ? { runId } : {})
  }
}

function normalizeSizeBytes(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WorkflowLedgerCorruptionError('artifact location sizeBytes must be a non-negative safe integer')
  }
  return value as number
}

export function requireArtifact(db: WorkflowLedgerDatabase, id: string, label: string): WorkflowArtifactRecord {
  const artifact = findWorkflowArtifact(db, id)
  if (!artifact) throw new WorkflowLedgerCorruptionError(`${label} references missing artifact ${id}`)
  return artifact
}

export function assertEndpointProjectCompatibility(record: ScopedGraphRecord, from: WorkflowArtifactRecord, to: WorkflowArtifactRecord): void {
  if (from.projectId !== to.projectId) throw new WorkflowLedgerCorruptionError('artifact edge crosses project boundary')
  if (record.projectId !== from.projectId) {
    throw new WorkflowLedgerCorruptionError('artifact edge project ownership differs from endpoint')
  }
}

export function assertLocationProjectCompatibility(location: ScopedGraphRecord, artifact: WorkflowArtifactRecord): void {
  if (location.projectId !== artifact.projectId) {
    throw new WorkflowLedgerCorruptionError(`artifact location project ownership differs from artifact ${artifact.id}`)
  }
}

export function assertEndpointScopeCompatibility(record: ScopedGraphRecord, from: WorkflowArtifactRecord, to: WorkflowArtifactRecord): void {
  for (const key of ['goalId', 'workItemId', 'runId'] as const) {
    const value = record[key]
    if (!value) continue
    if (from[key] && from[key] !== value) throw new WorkflowLedgerCorruptionError(`artifact edge ${key} differs from source artifact`)
    if (to[key] && to[key] !== value) throw new WorkflowLedgerCorruptionError(`artifact edge ${key} differs from target artifact`)
  }
}

export function assertArtifactScopeCompatibility(location: ScopedGraphRecord, artifact: WorkflowArtifactRecord): void {
  for (const key of ['goalId', 'workItemId', 'runId'] as const) {
    const value = location[key]
    if (value && artifact[key] && value !== artifact[key]) {
      throw new WorkflowLedgerCorruptionError(`artifact location ${key} differs from artifact ${artifact.id}`)
    }
  }
}

export function assertScopeReferences(db: WorkflowLedgerDatabase, record: ScopedGraphRecord, projectId: string | undefined, label: string): void {
  const references = resolveScopeReferences(db, record, label)
  assertScopeProject(references, projectId, label)
  if (references.goal && references.workItem?.goalId && references.goal.id !== references.workItem.goalId) {
    throw new WorkflowLedgerCorruptionError(`${label} goal/work item ownership differs`)
  }
  if (references.workItem && references.run && references.run.workItemId !== references.workItem.id) {
    throw new WorkflowLedgerCorruptionError(`${label} run/work item ownership differs`)
  }
}

function resolveScopeReferences(db: WorkflowLedgerDatabase, record: ScopedGraphRecord, label: string): {
  goal: ReturnType<typeof findWorkflowGoal>
  workItem: ReturnType<typeof findWorkflowWorkItem>
  run: ReturnType<typeof findWorkflowRun>
} {
  const goal = record.goalId ? findWorkflowGoal(db, record.goalId) : null
  const workItem = record.workItemId ? findWorkflowWorkItem(db, record.workItemId) : null
  const run = record.runId ? findWorkflowRun(db, record.runId) : null
  if (record.goalId && !goal) throw new WorkflowLedgerCorruptionError(`${label} references missing goal ${record.goalId}`)
  if (record.workItemId && !workItem) throw new WorkflowLedgerCorruptionError(`${label} references missing work item ${record.workItemId}`)
  if (record.runId && !run) throw new WorkflowLedgerCorruptionError(`${label} references missing run ${record.runId}`)
  return { goal, workItem, run }
}

function assertScopeProject(
  references: ReturnType<typeof resolveScopeReferences>,
  projectId: string | undefined,
  label: string
): void {
  for (const owner of [references.goal, references.workItem, references.run]) {
    if (owner && owner.projectId !== projectId) {
      throw new WorkflowLedgerCorruptionError(`${label} crosses project boundary through owner`)
    }
  }
}

export function parsePayload(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new WorkflowLedgerCorruptionError(`${label} payload is not text`)
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new WorkflowLedgerCorruptionError(`${label} payload is not valid JSON`)
  }
}

export function assertCanonicalPayload(value: Record<string, unknown>, label: string): void {
  if (JSON.stringify(value) !== canonicalJson(value)) {
    throw new WorkflowLedgerCorruptionError(`${label} payload is not canonical JSON`)
  }
}

export function assertColumn(expected: unknown, actual: unknown, column: string): void {
  if (expected !== actual) throw new WorkflowLedgerCorruptionError(`artifact graph payload does not match ${column} column`)
}

export function assertNullableColumn(expected: unknown, actual: unknown, column: string): void {
  const normalizedActual = actual === null || actual === undefined ? undefined : actual
  if (expected !== normalizedActual) throw new WorkflowLedgerCorruptionError(`artifact graph payload does not match ${column} column`)
}

export function decodeEdgeRow(row: Record<string, unknown>): WorkflowArtifactEdgeRecord {
  const payload = parsePayload(row.payload, 'artifact edge')
  const record = normalizeEdgeInput(payload as unknown as WorkflowArtifactEdgeInput)
  assertColumn(record.id, row.id, 'id')
  assertColumn(record.fromArtifactId, row.from_artifact_id, 'from_artifact_id')
  assertColumn(record.toArtifactId, row.to_artifact_id, 'to_artifact_id')
  assertColumn(record.relation, row.relation, 'relation')
  assertNullableColumn(record.projectId, row.project_id, 'project_id')
  assertNullableColumn(record.goalId, row.goal_id, 'goal_id')
  assertNullableColumn(record.workItemId, row.work_item_id, 'work_item_id')
  assertNullableColumn(record.runId, row.run_id, 'run_id')
  assertColumn(record.createdAt, row.created_at, 'created_at')
  assertColumn(record.updatedAt, row.updated_at, 'updated_at')
  assertCanonicalPayload(payload, 'artifact edge')
  return record
}

export function decodeLocationRow(row: Record<string, unknown>): WorkflowArtifactLocationRecord {
  const payload = parsePayload(row.payload, 'artifact location')
  const record = normalizeLocationInput(payload as unknown as WorkflowArtifactLocationInput)
  assertColumn(record.id, row.id, 'id')
  assertColumn(record.artifactId, row.artifact_id, 'artifact_id')
  assertNullableColumn(record.projectId, row.project_id, 'project_id')
  assertNullableColumn(record.goalId, row.goal_id, 'goal_id')
  assertNullableColumn(record.workItemId, row.work_item_id, 'work_item_id')
  assertNullableColumn(record.runId, row.run_id, 'run_id')
  assertColumn(record.kind, row.kind, 'kind')
  assertNullableColumn(record.uri, row.uri, 'uri')
  assertNullableColumn(record.path, row.path, 'path')
  assertColumn(record.availability, row.availability, 'availability')
  assertNullableColumn(record.checksum, row.checksum, 'checksum')
  assertNullableColumn(record.sizeBytes, row.size_bytes, 'size_bytes')
  assertNullableColumn(record.mediaType, row.media_type, 'media_type')
  assertColumn(record.createdAt, row.created_at, 'created_at')
  assertColumn(record.updatedAt, row.updated_at, 'updated_at')
  assertCanonicalPayload(payload, 'artifact location')
  return record
}
