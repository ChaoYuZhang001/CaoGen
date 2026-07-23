import type { TaskRunRecord, TaskSnapshotRecord } from '../../shared/types'
import type { WorkflowRunRecord } from '../../shared/workflow-types'
import { isTaskRunTerminal } from './task-run'
import { taskSnapshotTaskIdMatchesRun } from './task-snapshot-identity'
import type { TaskEvidenceRecord } from './task-evidence-store'
import { digest } from './workflow-ledger-codec'
import type {
  WorkflowLedgerCanonicalReadinessDiagnostic,
  WorkflowLedgerCanonicalReadinessReport
} from './workflow-ledger-migration-types'

interface WorkflowReadinessParityInput {
  taskRuns: readonly TaskRunRecord[]
  snapshots: readonly TaskSnapshotRecord[]
  workflowRuns: readonly WorkflowRunRecord[]
  recoverySessions: readonly TaskSnapshotRecord[]
  evidence: readonly TaskEvidenceRecord[]
}

type CompatibilityCounts = Pick<WorkflowLedgerCanonicalReadinessReport['counts'],
  'snapshotsWithoutRun' | 'activeRunsWithoutSnapshot' | 'terminalRunsWithoutSnapshot'>

export function assessWorkflowReadinessParity(
  input: WorkflowReadinessParityInput,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): CompatibilityCounts & { matchingRuns: number } {
  const matchingRuns = compareRunParity(input.taskRuns, input.workflowRuns, diagnostics)
  compareSnapshotParity(input.snapshots, input.taskRuns, input.workflowRuns, diagnostics)
  compareRecoverySessionParity(input.snapshots, input.recoverySessions, diagnostics)
  compareProjectionOwnership(input.taskRuns, input.workflowRuns, input.evidence, diagnostics)
  return { matchingRuns, ...diagnoseSnapshotCoverage(input.snapshots, input.taskRuns, diagnostics) }
}

function diagnoseSnapshotCoverage(
  snapshots: readonly TaskSnapshotRecord[],
  taskRuns: readonly TaskRunRecord[],
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): CompatibilityCounts {
  const snapshotRunIds = new Set(snapshots.flatMap((snapshot) => snapshot.run ? [snapshot.run.id] : []))
  const runsWithoutSnapshot = taskRuns.filter((run) => !snapshotRunIds.has(run.id))
  const activeRuns = runsWithoutSnapshot.filter((run) => !isTaskRunTerminal(run.status))
  const terminalRuns = runsWithoutSnapshot.filter((run) => isTaskRunTerminal(run.status))
  const snapshotsWithoutRun = snapshots.filter((snapshot) => !snapshot.run).length
  addSnapshotCompatibilityDiagnostics(snapshotsWithoutRun, activeRuns, terminalRuns, diagnostics)
  return {
    snapshotsWithoutRun,
    activeRunsWithoutSnapshot: activeRuns.length,
    terminalRunsWithoutSnapshot: terminalRuns.length
  }
}

function addSnapshotCompatibilityDiagnostics(
  snapshotsWithoutRun: number,
  activeRuns: readonly TaskRunRecord[],
  terminalRuns: readonly TaskRunRecord[],
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (snapshotsWithoutRun > 0) {
    addDiagnostic(diagnostics, 'legacy_snapshot_without_run', 'canonical_compatibility',
      `${snapshotsWithoutRun} legacy Snapshot record(s) require the compatibility recovery reader`, {
        scope: 'legacy'
      })
  }
  for (const run of activeRuns) {
    addDiagnostic(diagnostics, 'active_run_without_snapshot', 'corruption',
      `Active TaskRun ${run.id} has no durable recovery Snapshot`, {
        entityId: run.id, table: 'task_runs', scope: 'legacy'
      })
  }
  for (const run of terminalRuns) {
    addDiagnostic(diagnostics, 'terminal_run_without_snapshot', 'canonical_compatibility',
      `Terminal TaskRun ${run.id} is retained after Snapshot deletion`, {
        entityId: run.id, table: 'task_runs', scope: 'legacy'
      })
  }
}

function compareRunParity(
  taskRuns: readonly TaskRunRecord[],
  workflowRuns: readonly WorkflowRunRecord[],
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): number {
  const legacy = new Map(taskRuns.map((run) => [run.id, run]))
  const projected = new Map(workflowRuns.map((run) => [run.id, run]))
  let matching = 0
  for (const run of taskRuns) {
    const projection = projected.get(run.id)
    if (!projection) addMissingRunDiagnostic(run, diagnostics)
    else if (!workflowRunMatchesTaskRun(projection, run)) addRunDriftDiagnostic(run, diagnostics)
    else matching += 1
  }
  for (const run of workflowRuns) {
    if (!legacy.has(run.id)) addCanonicalOnlyRunDiagnostic(run, diagnostics)
  }
  return matching
}

function addMissingRunDiagnostic(
  run: TaskRunRecord,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  addDiagnostic(diagnostics, 'workflow_run_missing', 'additive_projection',
    `Workflow Run ${run.id} is missing`, {
      entityId: run.id, table: 'workflow_runs', scope: 'canonical'
    })
}

function addRunDriftDiagnostic(
  run: TaskRunRecord,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  addDiagnostic(diagnostics, 'workflow_run_digest_mismatch', 'corruption',
    `Workflow Run ${run.id} differs from TaskRun`, {
      entityId: run.id, table: 'workflow_runs', scope: 'parity'
    })
}

function addCanonicalOnlyRunDiagnostic(
  run: WorkflowRunRecord,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  addDiagnostic(diagnostics, 'workflow_run_without_legacy_source', 'corruption',
    `Workflow Run ${run.id} has no legacy TaskRun`, {
      entityId: run.id, table: 'workflow_runs', scope: 'parity'
    })
}

function compareSnapshotParity(
  snapshots: readonly TaskSnapshotRecord[],
  taskRuns: readonly TaskRunRecord[],
  workflowRuns: readonly WorkflowRunRecord[],
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  const legacy = new Map(taskRuns.map((run) => [run.id, run]))
  const projected = new Map(workflowRuns.map((run) => [run.id, run]))
  for (const snapshot of snapshots) {
    const run = snapshot.run
    if (run) compareSnapshotRun({ ...snapshot, run }, legacy.get(run.id), projected.get(run.id), diagnostics)
  }
}

function compareSnapshotRun(
  snapshot: TaskSnapshotRecord & { run: TaskRunRecord },
  taskRun: TaskRunRecord | undefined,
  workflowRun: WorkflowRunRecord | undefined,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (
    !taskRun ||
    snapshot.run.sessionId !== snapshot.sessionId ||
    !taskSnapshotTaskIdMatchesRun(snapshot.taskId, snapshot.run) ||
    digest(snapshot.run) !== digest(taskRun)
  ) {
    addDiagnostic(diagnostics, 'snapshot_run_mismatch', 'corruption',
      `Snapshot ${snapshot.id} Run differs from task_runs`, {
        entityId: snapshot.id, table: 'task_snapshots', scope: 'parity'
      })
  }
  if (!workflowRun) return
  compareSnapshotWorkflowBinding(snapshot, workflowRun, diagnostics)
}

function compareSnapshotWorkflowBinding(
  snapshot: TaskSnapshotRecord & { run: TaskRunRecord },
  workflowRun: WorkflowRunRecord,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (digest(snapshot.run) !== digest(workflowRun.taskRun)) {
    addDiagnostic(diagnostics, 'snapshot_workflow_run_mismatch', 'corruption',
      `Snapshot ${snapshot.id} Run differs from Workflow Run`, {
        entityId: snapshot.id, table: 'workflow_runs', scope: 'parity'
      })
  }
  const snapshotProjectId = snapshot.meta.workspaceId ?? snapshot.meta.projectId
  if (snapshotProjectId !== workflowRun.projectId) {
    addDiagnostic(diagnostics, 'snapshot_workflow_project_mismatch', 'corruption',
      `Snapshot ${snapshot.id} project differs from Workflow Run`, {
        entityId: snapshot.id, table: 'workflow_runs', scope: 'parity'
      })
  }
  const workItemId = snapshot.meta.workItemId ?? (
    snapshot.meta.orchestrationId && snapshot.meta.childTaskId
      ? `work-item:dag:${snapshot.meta.orchestrationId}:${snapshot.meta.childTaskId}`
      : undefined
  )
  if (workItemId && workItemId !== workflowRun.workItemId) {
    addDiagnostic(diagnostics, 'snapshot_workflow_work_item_mismatch', 'corruption',
      `Snapshot ${snapshot.id} work item differs from Workflow Run`, {
        entityId: snapshot.id, table: 'workflow_runs', scope: 'parity'
      })
  }
}

function compareRecoverySessionParity(
  legacySnapshots: readonly TaskSnapshotRecord[],
  recoverySessions: readonly TaskSnapshotRecord[],
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  const legacy = new Map(legacySnapshots.map((snapshot) => [snapshot.id, snapshot]))
  const canonical = new Map(recoverySessions.map((snapshot) => [snapshot.id, snapshot]))
  for (const snapshot of legacySnapshots) compareRecoverySession(snapshot, canonical.get(snapshot.id), diagnostics)
  for (const recovery of recoverySessions) {
    if (!legacy.has(recovery.id)) {
      addDiagnostic(diagnostics, 'workflow_recovery_without_legacy_source', 'corruption',
        `Recovery session ${recovery.id} has no legacy Snapshot`, {
          entityId: recovery.id, table: 'workflow_recovery_sessions', scope: 'parity'
        })
    }
  }
}

function compareRecoverySession(
  snapshot: TaskSnapshotRecord,
  recovery: TaskSnapshotRecord | undefined,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (!recovery) {
    addDiagnostic(diagnostics, 'workflow_recovery_missing', 'additive_projection',
      `Recovery session ${snapshot.id} is missing from canonical projection`, {
        entityId: snapshot.id, table: 'workflow_recovery_sessions', scope: 'canonical'
      })
  } else if (digest(recovery) !== digest(snapshot)) {
    addDiagnostic(diagnostics, 'workflow_recovery_digest_mismatch', 'corruption',
      `Recovery session ${snapshot.id} differs from legacy Snapshot`, {
        entityId: snapshot.id, table: 'workflow_recovery_sessions', scope: 'parity'
      })
  }
}

function compareProjectionOwnership(
  taskRuns: readonly TaskRunRecord[],
  workflowRuns: readonly WorkflowRunRecord[],
  evidence: readonly TaskEvidenceRecord[],
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  const legacyRuns = new Map(taskRuns.map((run) => [run.id, run]))
  const canonicalRuns = new Map(workflowRuns.map((run) => [run.id, run]))
  const evidenceProjects = new Map<string, string>()
  for (const run of workflowRuns) compareOperationOwnership(run, diagnostics)
  for (const record of evidence) {
    compareEvidenceOwnership(record, legacyRuns.get(record.runId), canonicalRuns.get(record.runId), diagnostics)
    compareEvidenceProject(record, canonicalRuns.get(record.runId), evidenceProjects, diagnostics)
  }
}

function compareOperationOwnership(
  workflowRun: WorkflowRunRecord,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  const projectId = workflowRun.taskRun.operation?.projectId
  if (projectId !== undefined && projectId !== workflowRun.projectId) {
    addDiagnostic(diagnostics, 'operation_workflow_project_mismatch', 'corruption',
      `Canonical Run ${workflowRun.id} operation project differs from Workflow Run`, {
        entityId: workflowRun.id, table: 'workflow_runs', scope: 'canonical'
      })
  }
}

function compareEvidenceOwnership(
  record: TaskEvidenceRecord,
  legacyRun: TaskRunRecord | undefined,
  workflowRun: WorkflowRunRecord | undefined,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (!legacyRun) {
    addDiagnostic(diagnostics, 'task_evidence_without_legacy_run', 'corruption',
      `Task evidence ${record.evidenceId} has no legacy TaskRun`, {
        entityId: record.evidenceId, table: 'task_evidence', scope: 'parity'
      })
  } else if (record.sessionId !== legacyRun.sessionId || record.taskId !== legacyRun.taskId) {
    addDiagnostic(diagnostics, 'task_evidence_run_ownership_mismatch', 'corruption',
      `Task evidence ${record.evidenceId} ownership differs from TaskRun`, {
        entityId: record.evidenceId, table: 'task_evidence', scope: 'parity'
      })
  }
  if (workflowRun && (record.sessionId !== workflowRun.sessionId || record.taskId !== workflowRun.taskId)) {
    addDiagnostic(diagnostics, 'task_evidence_canonical_run_ownership_mismatch', 'corruption',
      `Task evidence ${record.evidenceId} ownership differs from canonical Run`, {
        entityId: record.evidenceId, table: 'task_evidence', scope: 'canonical'
      })
  }
}

function compareEvidenceProject(
  record: TaskEvidenceRecord,
  workflowRun: WorkflowRunRecord | undefined,
  evidenceProjects: Map<string, string>,
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[]
): void {
  if (!record.projectId) return
  const prior = evidenceProjects.get(record.runId)
  if (prior && prior !== record.projectId) {
    addDiagnostic(diagnostics, 'task_evidence_project_conflict', 'corruption',
      `Task evidence for Run ${record.runId} has conflicting projects`, {
        entityId: record.runId, table: 'task_evidence', scope: 'canonical'
      })
  } else {
    evidenceProjects.set(record.runId, record.projectId)
  }
  if (workflowRun && workflowRun.projectId !== record.projectId) {
    addDiagnostic(diagnostics, 'task_evidence_workflow_project_mismatch', 'corruption',
      `Task evidence ${record.evidenceId} project differs from Workflow Run`, {
        entityId: record.evidenceId, table: 'workflow_runs', scope: 'canonical'
      })
  }
}

function workflowRunMatchesTaskRun(projection: WorkflowRunRecord, run: TaskRunRecord): boolean {
  return projection.id === run.id && projection.sessionId === run.sessionId && projection.taskId === run.taskId &&
    projection.status === run.status && projection.revision === run.revision && projection.attempt === run.attempt &&
    projection.createdAt === run.createdAt && projection.updatedAt === run.updatedAt &&
    projection.startedAt === run.startedAt && projection.finishedAt === run.finishedAt &&
    projection.error === run.error && digest(projection.taskRun) === digest(run)
}

function addDiagnostic(
  diagnostics: WorkflowLedgerCanonicalReadinessDiagnostic[],
  code: string,
  category: WorkflowLedgerCanonicalReadinessDiagnostic['category'],
  message: string,
  extra: Pick<WorkflowLedgerCanonicalReadinessDiagnostic, 'entityId' | 'table' | 'scope'> = {}
): void {
  if (diagnostics.some((item) => item.code === code && item.entityId === extra.entityId && item.table === extra.table)) return
  diagnostics.push({ code, category, message, ...extra })
}
