import type {
  WorkflowArtifactRecord,
  WorkflowEventRecord,
  WorkflowRunRecord
} from '../../shared/workflow-types'
import { canonicalJson } from './workflow-ledger-codec'
import type { TaskEvidenceRecord } from './task-evidence-store'
import { selectTaskEvidence } from './task-evidence-store'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { readRows } from './workflow-ledger-sql'
import type { WorkflowEventReferenceIndex } from './workflow-ledger-query'

type ArtifactGraphEventDescriptor = {
  table: 'workflow_artifact_edges' | 'workflow_artifact_locations'
  prefix: 'artifact-edge:' | 'artifact-location:'
  kind: 'edge' | 'location'
}

export function resolveArtifactGraphEntity(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex
): WorkflowArtifactRecord | null {
  const descriptor = artifactGraphEventDescriptor(event)
  if (!descriptor) return null
  const recordId = event.entityId.slice(descriptor.prefix.length)
  const payload = readArtifactGraphEventPayload(db, event, descriptor, recordId)
  return resolveArtifactGraphOwner(event, descriptor, recordId, payload, index)
}

function readArtifactGraphEventPayload(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventRecord,
  descriptor: ArtifactGraphEventDescriptor,
  recordId: string
): Record<string, unknown> {
  const row = readArtifactGraphEventRow(db, event, descriptor, recordId)
  if (typeof row.payload !== 'string') {
    integrityConflict(event, `artifact ${descriptor.kind} ${recordId} payload is not text`)
  }
  const payload = parseArtifactGraphEventPayload(event, descriptor.kind, recordId, row.payload)
  if (canonicalJson(payload) !== canonicalJson(event.payload)) {
    integrityConflict(event, `artifact ${descriptor.kind} ${recordId} event payload differs from projection`)
  }
  return payload
}

function readArtifactGraphEventRow(
  db: WorkflowLedgerDatabase,
  event: WorkflowEventRecord,
  descriptor: ArtifactGraphEventDescriptor,
  recordId: string
): Record<string, unknown> {
  let rows: Array<Record<string, unknown>>
  try {
    rows = readRows(
      db,
      `SELECT * FROM ${descriptor.table} WHERE id = ${quoteSqlValue(recordId)} LIMIT 1`
    )
  } catch {
    integrityConflict(event, `${descriptor.kind} graph table is unavailable`)
  }
  const row = rows[0]
  if (!row) integrityConflict(event, `event references missing artifact ${descriptor.kind} ${recordId}`)
  return row
}

function parseArtifactGraphEventPayload(
  event: WorkflowEventRecord,
  kind: ArtifactGraphEventDescriptor['kind'],
  recordId: string,
  value: string
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    integrityConflict(event, `artifact ${kind} ${recordId} payload is invalid`)
  }
}

function resolveArtifactGraphOwner(
  event: WorkflowEventRecord,
  descriptor: ArtifactGraphEventDescriptor,
  recordId: string,
  payload: Record<string, unknown>,
  index: WorkflowEventReferenceIndex
): WorkflowArtifactRecord {
  const artifactId = descriptor.kind === 'edge' ? payload.fromArtifactId : payload.artifactId
  if (typeof artifactId !== 'string' || !artifactId) {
    integrityConflict(event, `artifact ${descriptor.kind} ${recordId} has no owning Artifact`)
  }
  const artifact = index.artifacts.get(artifactId)
  if (!artifact) {
    integrityConflict(event, `artifact ${descriptor.kind} ${recordId} references missing Artifact ${artifactId}`)
  }
  if (descriptor.kind === 'edge' &&
      (typeof payload.toArtifactId !== 'string' || !index.artifacts.has(payload.toArtifactId))) {
    integrityConflict(event, `artifact edge ${recordId} references missing target Artifact`)
  }
  return artifact
}

function artifactGraphEventDescriptor(event: WorkflowEventRecord): ArtifactGraphEventDescriptor | null {
  if (event.kind === 'workflow.artifact.edge.created') {
    if (!event.entityId.startsWith('artifact-edge:')) integrityConflict(event, 'artifact edge event identity is invalid')
    return { table: 'workflow_artifact_edges', prefix: 'artifact-edge:', kind: 'edge' }
  }
  if (event.kind === 'workflow.artifact.location.created') {
    if (!event.entityId.startsWith('artifact-location:')) integrityConflict(event, 'artifact location event identity is invalid')
    return { table: 'workflow_artifact_locations', prefix: 'artifact-location:', kind: 'location' }
  }
  return null
}

function quoteSqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function assertTaskEvidenceEvent(
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex
): void {
  if (event.kind !== 'workflow.effect.evidence') return
  const evidenceId = taskEvidenceEventId(event)
  const evidence = taskEvidenceEventSource(event, index, evidenceId)
  const run = taskEvidenceEventRun(event, index, evidence)
  assertTaskEvidenceRunSource(event, evidence, run)
  assertTaskEvidenceEventIdentity(event, evidence, run)
  assertTaskEvidenceEventPayload(event, evidence, evidenceId)
}

function taskEvidenceEventId(event: WorkflowEventRecord): string {
  const evidenceId = event.payload.evidenceId
  if (typeof evidenceId !== 'string' || !evidenceId) {
    integrityConflict(event, 'Task evidence event has no evidenceId')
  }
  return evidenceId
}

function taskEvidenceEventSource(
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex,
  evidenceId: string
): TaskEvidenceRecord {
  const evidence = index.taskEvidence?.get(evidenceId)
  if (!evidence) integrityConflict(event, `references missing Task evidence ${evidenceId}`)
  return evidence
}

function taskEvidenceEventRun(
  event: WorkflowEventRecord,
  index: WorkflowEventReferenceIndex,
  evidence: TaskEvidenceRecord
): WorkflowRunRecord {
  const run = index.runs.get(evidence.runId)
  if (!run) integrityConflict(event, `Task evidence ${evidence.evidenceId} references missing Run ${evidence.runId}`)
  return run
}

function assertTaskEvidenceRunSource(
  event: WorkflowEventRecord,
  evidence: TaskEvidenceRecord,
  run: WorkflowRunRecord
): void {
  if (evidence.sessionId !== run.sessionId || evidence.taskId !== run.taskId ||
      (evidence.projectId !== undefined && evidence.projectId !== run.projectId)) {
    integrityConflict(event, 'Task evidence ownership differs from Run ' + run.id)
  }
  const effect = (run.taskRun.effects ?? []).find((candidate) => candidate.id === evidence.effectId)
  const sourceEvidence = effect?.evidence.find((candidate) => candidate.id === evidence.evidenceId)
  if (!effect || !sourceEvidence || effect.generation !== evidence.generation ||
      sourceEvidence.generation !== evidence.generation || sourceEvidence.digest !== evidence.evidenceDigest ||
      effect.effectKey !== evidence.effectKey || effect.targetDigest !== evidence.targetDigest) {
    integrityConflict(event, 'Task evidence no longer matches Effect ' + evidence.effectId)
  }
}

function assertTaskEvidenceEventPayload(
  event: WorkflowEventRecord,
  evidence: TaskEvidenceRecord,
  evidenceId: string
): void {
  if (canonicalJson(event.payload) !== canonicalJson(taskEvidenceEventPayload(evidence))) {
    integrityConflict(event, `Task evidence ${evidenceId} payload differs from source`)
  }
}

function assertTaskEvidenceEventIdentity(
  event: WorkflowEventRecord,
  evidence: TaskEvidenceRecord,
  run: WorkflowRunRecord
): void {
  const expected: Record<string, unknown> = {
    eventId: `workflow:evidence:${evidence.evidenceId}`,
    streamId: `run:${evidence.runId}`,
    entityType: 'run',
    entityId: evidence.runId,
    projectId: evidence.projectId ?? run.projectId,
    goalId: run.goalId,
    workItemId: run.workItemId,
    runId: run.id,
    sessionId: run.sessionId,
    occurredAt: evidence.observedAt,
    causationId: evidence.id,
    correlationId: evidence.operationId ?? evidence.runId
  }
  const actual = event as unknown as Record<string, unknown>
  for (const [field, value] of Object.entries(expected)) {
    if (actual[field] !== value) integrityConflict(event, `Task evidence ${evidence.evidenceId} ${field} differs from source`)
  }
}

function taskEvidenceEventPayload(evidence: TaskEvidenceRecord): Record<string, unknown> {
  return {
    evidenceId: evidence.evidenceId,
    evidenceSeq: evidence.seq,
    effectId: evidence.effectId,
    kind: evidence.kind,
    generation: evidence.generation,
    observedAt: evidence.observedAt,
    verifier: evidence.verifier,
    evidenceDigest: evidence.evidenceDigest,
    effectKey: evidence.effectKey,
    targetDigest: evidence.targetDigest,
    taskEvidenceRecordDigest: evidence.digest,
    taskEvidencePrevDigest: evidence.prevDigest,
    ...(evidence.operationId ? { operationId: evidence.operationId } : {}),
    ...(evidence.projectId ? { projectId: evidence.projectId } : {})
  }
}

export function assertTaskEvidenceEventCoverage(
  events: readonly WorkflowEventRecord[],
  index: WorkflowEventReferenceIndex
): void {
  const evidence = index.taskEvidence
  if (!evidence || evidence.size === 0) return
  const eventIds = new Set(
    events.filter((event) => event.kind === 'workflow.effect.evidence').map((event) => event.eventId)
  )
  for (const record of evidence.values()) {
    if (!eventIds.has(`workflow:evidence:${record.evidenceId}`)) {
      throw new WorkflowLedgerCorruptionError(`Task evidence ${record.evidenceId} has no Workflow event`)
    }
  }
}

function integrityConflict(event: WorkflowEventRecord, reason: string): never {
  throw new WorkflowLedgerCorruptionError(`event ${event.eventId} ${reason}`, event.seq)
}
