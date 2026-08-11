import { createHash } from 'node:crypto'
import type {
  DigitalWorkerHistoryExport,
  DigitalWorkerHistoryRun,
  DigitalWorkerHistorySnapshot
} from '../../shared/digital-worker-types'
import type { ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
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

const HISTORY_FORMAT = 'caogen.digital-worker-history.v1' as const
const EXPORT_FORMAT = 'caogen.digital-worker-history.export.v1' as const

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

  const assignments = aggregate.assignments
    .filter((assignment) => assignment.assigneeKind === 'digital_worker' && assignment.assigneeId === worker.id)
    .sort(byId)
  const leases = aggregate.leases.filter((lease) => lease.workerId === worker.id).sort(byId)
  const runs = aggregate.workflow.runs
    .filter((run) => run.taskRun.digitalWorkerBinding?.kind === 'assigned' && run.taskRun.digitalWorkerBinding.workerId === worker.id)
    .sort(byId)
  const runIds = new Set(runs.map((run) => run.id))
  const historyRuns: DigitalWorkerHistoryRun[] = runs.map((run) => ({
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
  }))

  const artifacts = aggregate.workflow.artifacts
    .filter((artifact) => artifact.runId !== undefined && runIds.has(artifact.runId))
    .sort(byId)
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id))
  const taskEvidence = aggregate.workflow.taskEvidence
    .filter((evidence) => runIds.has(evidence.runId))
    .sort(byId)
  const workflowEvidence = aggregate.workflow.workflowEvidence
    .filter((evidence) => (evidence.runId !== undefined && runIds.has(evidence.runId)) ||
      (evidence.artifactId !== undefined && artifactIds.has(evidence.artifactId)))
    .sort(byEvidenceId)
  const evidence = [...taskEvidence, ...workflowEvidence] as Array<WorkflowEvidenceRecord | WorkflowLedgerExportTaskEvidenceRecord>
  const evidenceIds = new Set(evidence.map((entry) => entry.evidenceId))
  const acceptanceIds = new Set(
    runs.map((run) => run.acceptanceId).filter((id): id is string => Boolean(id))
  )
  const evidenceLinks = aggregate.workflow.evidenceLinks
    .filter((link) => (link.runId !== undefined && runIds.has(link.runId)) ||
      (link.artifactId !== undefined && artifactIds.has(link.artifactId)) ||
      evidenceIds.has(link.evidenceId) ||
      (link.acceptanceId !== undefined && acceptanceIds.has(link.acceptanceId)))
    .sort(byId)
  for (const link of evidenceLinks) {
    if (link.acceptanceId) acceptanceIds.add(link.acceptanceId)
  }
  const acceptances = aggregate.workflow.acceptances
    .filter((acceptance) => acceptanceIds.has(acceptance.id))
    .sort(byId)

  const withoutIntegrity = {
    schemaVersion: 1 as const,
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
    assignments,
    leases,
    runs: historyRuns,
    artifacts,
    evidence,
    evidenceLinks,
    acceptances,
    summary: {
      assignments: assignments.length,
      leases: leases.length,
      runs: historyRuns.length,
      artifacts: artifacts.length,
      evidence: evidence.length,
      evidenceLinks: evidenceLinks.length,
      acceptances: acceptances.length
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
    schemaVersion: 1 as const,
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

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id)
}

function byEvidenceId(left: WorkflowEvidenceRecord, right: WorkflowEvidenceRecord): number {
  return left.evidenceId.localeCompare(right.evidenceId)
}
