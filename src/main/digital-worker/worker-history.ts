import { createHash } from 'node:crypto'
import type {
  DigitalWorkerHistoryAcceptance,
  DigitalWorkerHistoryArtifact,
  DigitalWorkerHistoryAssignment,
  DigitalWorkerHistoryAuditEvent,
  DigitalWorkerHistoryEvidence,
  DigitalWorkerHistoryEvidenceLink,
  DigitalWorkerHistoryExport,
  DigitalWorkerHistoryLease,
  DigitalWorkerHistoryRun,
  DigitalWorkerHistorySnapshot
} from '../../shared/digital-worker-types'
import type { ProjectAggregateAuditRecord, ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowLedgerExportTaskEvidenceRecord
} from '../../shared/workflow-types'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'
import { createProductionProjectAggregateService } from '../project-aggregate/project-aggregate-factory'
import { DigitalWorkerStore } from './domain-store'

const HISTORY_FORMAT = 'caogen.digital-worker-history.v2' as const
const EXPORT_FORMAT = 'caogen.digital-worker-history.export.v2' as const

/**
 * Build the durable worker-owned history projection. Worker identity is taken
 * from the immutable TaskRun binding, never from the current WorkItem owner.
 */
export async function buildDigitalWorkerHistory(
  rootDir: string,
  workerId: string,
  generatedAt = Date.now()
): Promise<DigitalWorkerHistorySnapshot> {
  const store = new DigitalWorkerStore(rootDir)
  const worker = await store.getDigitalWorker(workerId)
  if (!worker) throw new Error(`DigitalWorker not found: ${workerId}`)
  const aggregate = await createProductionProjectAggregateService(rootDir).verifyLiveProject(worker.projectId)
  return buildHistoryProjection(worker, aggregate, generatedAt)
}

export function buildHistoryProjection(
  worker: DigitalWorkerHistorySnapshot['worker'],
  aggregate: ProjectAggregateSnapshot,
  generatedAt = Date.now()
): DigitalWorkerHistorySnapshot {
  if (worker.projectId !== aggregate.projectId) {
    throw new Error(`DigitalWorker ${worker.id} does not belong to Project ${aggregate.projectId}`)
  }
  const sourceWorker = aggregate.digitalWorkers.find((candidate) => candidate.id === worker.id)
  if (!sourceWorker) throw new Error(`DigitalWorker history is missing from Project aggregate: ${worker.id}`)
  const ownership = projectWorkerOwnership(worker.id, aggregate)
  const workflow = projectWorkerWorkflow(worker.id, aggregate)
  const audit = projectAuditHistory(aggregate.audit, {
    workerId: worker.id,
    assignments: ownership.assignmentRecords,
    assignmentIds: ownership.assignmentIds,
    leases: ownership.leaseRecords,
    leaseIds: ownership.leaseIds,
    runs: workflow.runs,
    runIds: workflow.runIds
  })

  const withoutIntegrity = {
    schemaVersion: 2 as const,
    format: HISTORY_FORMAT,
    generatedAt,
    worker: {
      id: sourceWorker.id,
      projectId: sourceWorker.projectId,
      roleTemplateId: sourceWorker.roleTemplateId,
      displayName: sourceWorker.displayName,
      status: sourceWorker.status,
      createdAt: sourceWorker.createdAt,
      updatedAt: sourceWorker.updatedAt,
      ...(sourceWorker.retiredAt === undefined ? {} : { retiredAt: sourceWorker.retiredAt }),
      revision: sourceWorker.revision
    },
    assignments: ownership.assignments,
    leases: ownership.leases,
    runs: workflow.historyRuns,
    artifacts: workflow.artifacts,
    evidence: workflow.evidence,
    evidenceLinks: workflow.evidenceLinks,
    acceptances: workflow.acceptances,
    audit,
    summary: {
      assignments: ownership.assignments.length,
      leases: ownership.leases.length,
      runs: workflow.historyRuns.length,
      artifacts: workflow.artifacts.length,
      evidence: workflow.evidence.length,
      evidenceLinks: workflow.evidenceLinks.length,
      acceptances: workflow.acceptances.length,
      audit: audit.length
    }
  }
  return {
    ...withoutIntegrity,
    integrity: {
      complete: true,
      sourceAggregateDigest: aggregate.aggregateDigest,
      historyDigest: sha256(withoutIntegrity)
    }
  }
}

export async function exportDigitalWorkerHistory(
  rootDir: string,
  workerId: string,
  generatedAt = Date.now()
): Promise<DigitalWorkerHistoryExport> {
  const snapshot = await buildDigitalWorkerHistory(rootDir, workerId, generatedAt)
  const payload = {
    schemaVersion: 2 as const,
    format: EXPORT_FORMAT,
    workerId: snapshot.worker.id,
    projectId: snapshot.worker.projectId,
    snapshot
  }
  const json = `${JSON.stringify(payload, null, 2)}\n`
  return {
    ...payload,
    json,
    exportDigest: sha256(payload)
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(projectAggregateCanonicalJson(value)).digest('hex')
}

function projectWorkerOwnership(workerId: string, aggregate: ProjectAggregateSnapshot) {
  const assignmentRecords = aggregate.assignments
    .filter((assignment) => assignment.assigneeKind === 'digital_worker' && assignment.assigneeId === workerId)
    .sort(byId)
  const assignments = assignmentRecords.map(projectAssignment)
  const leaseRecords = aggregate.leases.filter((lease) => lease.workerId === workerId).sort(byId)
  const leases = leaseRecords.map(projectLease)
  return {
    assignmentRecords,
    assignments,
    assignmentIds: new Set(assignments.map((assignment) => assignment.id)),
    leaseRecords,
    leases,
    leaseIds: new Set(leases.map((lease) => lease.id))
  }
}

function projectWorkerWorkflow(workerId: string, aggregate: ProjectAggregateSnapshot) {
  const runs = aggregate.workflow.runs
    .filter((run) => run.taskRun.digitalWorkerBinding?.kind === 'assigned' && run.taskRun.digitalWorkerBinding.workerId === workerId)
    .sort(byId)
  const runIds = new Set(runs.map((run) => run.id))
  const historyRuns = runs.map(projectRun)
  const artifacts = aggregate.workflow.artifacts
    .filter((artifact) => artifact.runId !== undefined && runIds.has(artifact.runId))
    .sort(byId)
    .map(projectArtifact)
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const taskEvidence = aggregate.workflow.taskEvidence.filter((item) => runIds.has(item.runId)).sort(byId)
  const workflowEvidence = aggregate.workflow.workflowEvidence
    .filter((item) => (item.runId !== undefined && runIds.has(item.runId)) ||
      (item.artifactId !== undefined && artifactIds.has(item.artifactId)))
    .sort(byEvidenceId)
  const evidence = [...taskEvidence.map(projectTaskEvidence), ...workflowEvidence.map(projectWorkflowEvidence)]
  const evidenceIds = new Set(evidence.map((entry) => entry.evidenceId))
  const acceptanceIds = new Set(runs.map((run) => run.acceptanceId).filter((id): id is string => Boolean(id)))
  const linkRecords = aggregate.workflow.evidenceLinks
    .filter((link) => historyLinkMatches(link, runIds, artifactIds, evidenceIds, acceptanceIds))
    .sort(byId)
  for (const link of linkRecords) if (link.acceptanceId) acceptanceIds.add(link.acceptanceId)
  const evidenceLinks = linkRecords.map(projectEvidenceLink)
  const acceptances = aggregate.workflow.acceptances
    .filter((acceptance) => acceptanceIds.has(acceptance.id))
    .sort(byId)
    .map(projectAcceptance)
  return { runs, runIds, historyRuns, artifacts, evidence, evidenceLinks, acceptances }
}

function projectRun(run: ProjectAggregateSnapshot['workflow']['runs'][number]): DigitalWorkerHistoryRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    taskId: run.taskId,
    workItemId: run.workItemId,
    status: run.status,
    attempt: run.attempt,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.acceptanceId === undefined ? {} : { acceptanceId: run.acceptanceId }),
    taskRunDigest: sha256(run.taskRun),
    ...(run.error === undefined ? {} : { errorDigest: sha256(run.error) })
  }
}

function historyLinkMatches(
  link: WorkflowEvidenceLinkRecord,
  runIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
  acceptanceIds: ReadonlySet<string>
): boolean {
  return (link.runId !== undefined && runIds.has(link.runId)) ||
    (link.artifactId !== undefined && artifactIds.has(link.artifactId)) ||
    evidenceIds.has(link.evidenceId) ||
    (link.acceptanceId !== undefined && acceptanceIds.has(link.acceptanceId))
}

function projectAssignment(record: ProjectAggregateSnapshot['assignments'][number]): DigitalWorkerHistoryAssignment {
  return {
    schemaVersion: 1,
    id: record.id,
    projectId: record.projectId,
    workItemId: record.workItemId,
    assigneeKind: record.assigneeKind,
    assigneeId: record.assigneeId,
    assignedAt: record.assignedAt,
    ...(record.releasedAt === undefined ? {} : { releasedAt: record.releasedAt }),
    status: record.status,
    revision: record.revision,
    assignedByDigest: sha256(record.assignedBy),
    scopeDigest: sha256(record.scope),
    ...(record.reason === undefined ? {} : { reasonDigest: sha256(record.reason) }),
    recordDigest: sha256(record)
  }
}

function projectLease(record: ProjectAggregateSnapshot['leases'][number]): DigitalWorkerHistoryLease {
  return {
    schemaVersion: 1,
    id: record.id,
    projectId: record.projectId,
    workItemId: record.workItemId,
    assignmentId: record.assignmentId,
    workerId: record.workerId,
    fencingToken: record.fencingToken,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
    ...(record.releasedAt === undefined ? {} : { releasedAt: record.releasedAt }),
    status: record.status,
    revision: record.revision,
    recordDigest: sha256(record)
  }
}

function projectArtifact(record: WorkflowArtifactRecord): DigitalWorkerHistoryArtifact {
  return {
    schemaVersion: 1,
    id: record.id,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    ...(record.goalId === undefined ? {} : { goalId: record.goalId }),
    ...(record.workItemId === undefined ? {} : { workItemId: record.workItemId }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    kind: record.kind,
    version: record.version,
    digest: record.digest,
    provenance: record.provenance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.supersedesId === undefined ? {} : { supersedesId: record.supersedesId }),
    titleDigest: sha256(record.title),
    recordDigest: sha256(record)
  }
}

function projectWorkflowEvidence(record: WorkflowEvidenceRecord): DigitalWorkerHistoryEvidence {
  return {
    schemaVersion: 1,
    origin: 'workflow',
    id: record.id,
    evidenceId: record.evidenceId,
    projectId: record.projectId,
    ...(record.goalId === undefined ? {} : { goalId: record.goalId }),
    ...(record.workItemId === undefined ? {} : { workItemId: record.workItemId }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.artifactId === undefined ? {} : { artifactId: record.artifactId }),
    kind: record.kind,
    source: record.source,
    observedAt: record.observedAt,
    createdAt: record.createdAt,
    contentDigest: record.contentDigest,
    recordDigest: sha256(record)
  }
}

function projectTaskEvidence(record: WorkflowLedgerExportTaskEvidenceRecord): DigitalWorkerHistoryEvidence {
  return {
    schemaVersion: 1,
    origin: 'task_effect',
    id: record.id,
    evidenceId: record.evidenceId,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    runId: record.runId,
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    observedAt: record.observedAt,
    evidenceDigest: record.evidenceDigest,
    recordDigest: sha256(record)
  }
}

function projectEvidenceLink(record: WorkflowEvidenceLinkRecord): DigitalWorkerHistoryEvidenceLink {
  return {
    schemaVersion: 1,
    id: record.id,
    evidenceId: record.evidenceId,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.artifactId === undefined ? {} : { artifactId: record.artifactId }),
    ...(record.acceptanceId === undefined ? {} : { acceptanceId: record.acceptanceId }),
    ...(record.criterionId === undefined ? {} : { criterionId: record.criterionId }),
    ...(record.evidenceOrigin === undefined ? {} : { evidenceOrigin: record.evidenceOrigin }),
    relation: record.relation,
    createdAt: record.createdAt,
    recordDigest: sha256(record)
  }
}

function projectAcceptance(record: WorkflowAcceptanceRecord): DigitalWorkerHistoryAcceptance {
  return {
    schemaVersion: 1,
    id: record.id,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    ...(record.goalId === undefined ? {} : { goalId: record.goalId }),
    ...(record.workItemId === undefined ? {} : { workItemId: record.workItemId }),
    status: record.status,
    evidenceRefs: [...record.evidenceRefs],
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.verifiedAt === undefined ? {} : { verifiedAt: record.verifiedAt }),
    criterionCount: record.criteria.length,
    criteriaDigest: sha256(record.criteria),
    ...(record.criterionPolicies === undefined ? {} : { criterionPoliciesDigest: sha256(record.criterionPolicies) }),
    ...(record.criterionEvidence === undefined ? {} : { criterionEvidenceDigest: sha256(record.criterionEvidence) }),
    recordDigest: sha256(record)
  }
}

interface AuditProjectionScope {
  workerId: string
  assignments: ProjectAggregateSnapshot['assignments']
  assignmentIds: ReadonlySet<string>
  leases: ProjectAggregateSnapshot['leases']
  leaseIds: ReadonlySet<string>
  runs: ProjectAggregateSnapshot['workflow']['runs']
  runIds: ReadonlySet<string>
}

function projectAuditHistory(
  records: ProjectAggregateAuditRecord[],
  scope: AuditProjectionScope
): DigitalWorkerHistoryAuditEvent[] {
  return records
    .map((record) => projectAuditEvent(record, scope))
    .filter((event): event is DigitalWorkerHistoryAuditEvent => event !== undefined)
    .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
}

function projectAuditEvent(
  record: ProjectAggregateAuditRecord,
  scope: AuditProjectionScope
): DigitalWorkerHistoryAuditEvent | undefined {
  if (record.source === 'workflow_ledger') return projectWorkflowAudit(record, scope)
  if (record.source === 'digital_worker') return projectDigitalWorkerAudit(record, scope)
  return undefined
}

function projectWorkflowAudit(
  record: ProjectAggregateAuditRecord,
  scope: AuditProjectionScope
): DigitalWorkerHistoryAuditEvent | undefined {
  const value = auditRecordValue(record)
  const runId = stringField(value, 'runId') ?? (value.entityType === 'run' ? stringField(value, 'entityId') : undefined)
  if (!runId || !scope.runIds.has(runId)) return undefined
  const run = scope.runs.find((candidate) => candidate.id === runId)
  return {
    schemaVersion: 1,
    id: record.id,
    source: 'workflow_ledger',
    kind: requiredStringField(value, 'kind', record.id),
    entityType: requiredStringField(value, 'entityType', record.id),
    entityId: requiredStringField(value, 'entityId', record.id),
    workerId: scope.workerId,
    occurredAt: requiredTimestamp(value.occurredAt, record.id),
    ...(run === undefined ? {} : { workItemId: run.workItemId }),
    runId,
    eventDigest: sha256(value)
  }
}

function projectDigitalWorkerAudit(
  record: ProjectAggregateAuditRecord,
  scope: AuditProjectionScope
): DigitalWorkerHistoryAuditEvent | undefined {
  const value = auditRecordValue(record)
  const entityId = requiredStringField(value, 'entityId', record.id)
  const kind = requiredStringField(value, 'kind', record.id)
  const details = auditDetails(value)
  if (kind.startsWith('worker.') && entityId === scope.workerId) {
    return projectDomainAudit(record, value, kind, 'digital_worker', entityId, scope.workerId)
  }
  const assignment = scope.assignments.find((candidate) => candidate.id === entityId)
  if (kind.startsWith('assignment.') && (scope.assignmentIds.has(entityId) || details.assigneeId === scope.workerId)) {
    return projectDomainAudit(record, value, kind, 'assignment', entityId, scope.workerId, {
      assignmentId: entityId,
      ...(assignment === undefined ? {} : { workItemId: assignment.workItemId })
    })
  }
  const lease = scope.leases.find((candidate) => candidate.id === entityId)
  if (!kind.startsWith('lease.') || (!scope.leaseIds.has(entityId) && details.workerId !== scope.workerId)) return undefined
  return projectDomainAudit(record, value, kind, 'lease', entityId, scope.workerId, {
    leaseId: entityId,
    ...(lease === undefined ? {} : { assignmentId: lease.assignmentId, workItemId: lease.workItemId })
  })
}

function projectDomainAudit(
  record: ProjectAggregateAuditRecord,
  value: Record<string, unknown>,
  kind: string,
  entityType: string,
  entityId: string,
  workerId: string,
  relation: Pick<DigitalWorkerHistoryAuditEvent, 'assignmentId' | 'leaseId' | 'workItemId'> = {}
): DigitalWorkerHistoryAuditEvent {
  return {
    schemaVersion: 1,
    id: record.id,
    source: 'digital_worker',
    kind,
    entityType,
    entityId,
    workerId,
    occurredAt: requiredTimestamp(value.occurredAt, record.id),
    ...relation,
    eventDigest: sha256(value)
  }
}

function auditRecordValue(record: ProjectAggregateAuditRecord): Record<string, unknown> {
  if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
    throw new Error(`Audit ${record.id} has an invalid value`)
  }
  return record.value as Record<string, unknown>
}

function auditDetails(value: Record<string, unknown>): Record<string, unknown> {
  return value.details && typeof value.details === 'object' && !Array.isArray(value.details)
    ? value.details as Record<string, unknown>
    : {}
}

function requiredStringField(value: Record<string, unknown>, key: string, auditId: string): string {
  const field = stringField(value, key)
  if (!field) throw new Error(`Audit ${auditId} is missing ${key}`)
  return field
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function requiredTimestamp(value: unknown, auditId: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Audit ${auditId} has an invalid occurredAt`)
  return Number(value)
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id)
}

function byEvidenceId(left: { evidenceId: string }, right: { evidenceId: string }): number {
  return left.evidenceId.localeCompare(right.evidenceId)
}
