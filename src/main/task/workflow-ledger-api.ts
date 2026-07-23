import {
  mutateTaskSnapshotDatabase,
  readTaskSnapshotDatabase
} from './task-snapshot'
import { digest } from './workflow-ledger-codec'
import {
  findWorkflowAcceptance,
  findWorkflowArtifact,
  findWorkflowEvidenceLink,
  findWorkflowGoal,
  findWorkflowRun,
  findWorkflowWorkItem,
  appendWorkflowEvent,
  linkWorkflowEvidence,
  projectGoal,
  projectWorkflowAcceptance,
  projectWorkItem,
  registerWorkflowArtifact,
  selectWorkflowLedger,
  setupWorkflowLedgerSchema,
} from './workflow-ledger-store'
import {
  diagnosePersistedWorkflowLedger,
  exportPersistedWorkflowLedger,
  planPersistedWorkflowLedgerRepair,
  repairPersistedWorkflowLedger
} from './workflow-ledger-maintenance'
import {
  createPersistedWorkflowArtifactEdge,
  createPersistedWorkflowArtifactLocation,
  listPersistedWorkflowArtifactEdges,
  listPersistedWorkflowArtifactLocations,
  queryPersistedWorkflowArtifactGraph,
  verifyPersistedWorkflowArtifactGraph,
  verifyPersistedWorkflowLedgerWithArtifactGraph
} from './workflow-ledger-artifact-graph-api'
import type {
  WorkflowAcceptanceInput,
  WorkflowAcceptanceRecord,
  WorkflowArtifactInput,
  WorkflowArtifactRecord,
  WorkflowArtifactEdgeInput,
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactGraphScope,
  WorkflowArtifactGraphVerification,
  WorkflowArtifactLocationInput,
  WorkflowArtifactLocationRecord,
  WorkflowArtifactNeighborhood,
  WorkflowEvidenceInput,
  WorkflowEvidenceCreateInput,
  WorkflowEvidenceLinkInput,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceRecord,
  WorkflowEvidenceScope,
  WorkflowEvidenceVerification,
  WorkflowGoalProjectionInput,
  WorkflowGoalRecord,
  WorkflowGoalStatus,
  WorkflowLedgerScope,
  WorkflowLedgerExportOptions,
  WorkflowLedgerExportResult,
  WorkflowLedgerPage,
  WorkflowLedgerRepairPlan,
  WorkflowLedgerRendererSelection,
  WorkflowLedgerSelection,
  WorkflowLedgerVerification,
  WorkflowWorkItemProjectionInput,
  WorkflowWorkItemRecord,
  WorkflowWorkItemStatus
} from '../../shared/workflow-types'
import {
  appendWorkflowEvidence,
  type AppendWorkflowEvidenceOptions,
  listWorkflowEvidence as listWorkflowEvidenceRecords,
  readAllWorkflowEvidenceForIntegrity,
  selectWorkflowEvidence,
  setupWorkflowEvidenceSchema,
  verifyWorkflowEvidence as verifyWorkflowEvidenceRecords
} from './workflow-evidence-store'
import { readAndVerifyEvents } from './workflow-ledger-query'
import { assertWorkflowEvidenceEventCoverage } from './workflow-evidence-event-coverage'
import {
  toWorkflowAcceptanceError,
  WorkflowAcceptanceGateError,
  type WorkflowAcceptanceGateOptions
} from './workflow-acceptance-guard'

export type WorkflowLedgerWriteOptions = WorkflowAcceptanceGateOptions

// Keep the persisted/read-only names available from the main API facade for
// maintenance callers that do not use the renderer-facing aliases below.
export {
  exportPersistedWorkflowLedger,
  diagnosePersistedWorkflowLedger,
  planPersistedWorkflowLedgerRepair,
  repairPersistedWorkflowLedger
} from './workflow-ledger-maintenance'

export async function listPersistedWorkflowLedger(
  scope: WorkflowLedgerScope = {},
  rootDir?: string
): Promise<WorkflowLedgerSelection> {
  return readTaskSnapshotDatabase(rootDir, (db) => selectWorkflowLedger(db, scope))
}

/**
 * Renderer-facing Ledger query.  Keep the full projection available to main
 * process recovery/effect code through listPersistedWorkflowLedger, while the
 * IPC contract receives only Run metadata and a digest of the omitted TaskRun.
 */
export async function listWorkflowLedger(
  scope: WorkflowLedgerScope = {},
  rootDir?: string
): Promise<WorkflowLedgerRendererSelection> {
  const selection = await listPersistedWorkflowLedger(scope, rootDir)
  return toRendererWorkflowLedger(selection)
}

export function toRendererWorkflowLedger(
  selection: WorkflowLedgerSelection
): WorkflowLedgerRendererSelection {
  return {
    ...selection,
    runs: {
      ...selection.runs,
      items: selection.runs.items.map(({ taskRun, error, ...metadata }) => ({
        ...metadata,
        taskRunDigest: digest(taskRun),
        ...(error === undefined ? {} : { errorDigest: digest(error) })
      }))
    }
  }
}

export async function verifyPersistedWorkflowLedger(
  rootDir?: string
): Promise<WorkflowLedgerVerification> {
  return verifyPersistedWorkflowLedgerWithArtifactGraph(rootDir)
}

/** Export the complete, sanitised Ledger snapshot for a scope. */
export async function exportWorkflowLedger(
  options: WorkflowLedgerExportOptions = {},
  rootDir?: string
): Promise<WorkflowLedgerExportResult> {
  return exportPersistedWorkflowLedger(options, rootDir)
}

/** Return a read-only repair plan; this never mutates the snapshot database. */
export async function diagnoseWorkflowLedger(
  rootDir?: string
): Promise<WorkflowLedgerRepairPlan> {
  return diagnosePersistedWorkflowLedger(rootDir)
}

export async function planWorkflowLedgerRepair(
  rootDir?: string
): Promise<WorkflowLedgerRepairPlan> {
  return planPersistedWorkflowLedgerRepair(rootDir)
}

export async function repairWorkflowLedger(
  rootDir?: string
): Promise<WorkflowLedgerRepairPlan> {
  return repairPersistedWorkflowLedger(rootDir)
}

export async function createWorkflowGoal(
  input: WorkflowGoalProjectionInput,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowGoalRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      projectGoal(db, { ...input, source: input.source ?? 'explicit' }, options)
      const page = selectWorkflowLedger(db, { projectId: input.projectId, limit: 500 }).goals.items
      const goal = page.find((candidate) => candidate.id === input.id.trim())
      if (!goal) throw new Error(`workflow goal ${input.id} was not persisted`)
      return goal
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'createWorkflowGoal',
      targetType: 'goal',
      targetId: input.id,
      projectId: input.projectId,
      toStatus: input.status
    })
  }
}

export async function createWorkflowWorkItem(
  input: WorkflowWorkItemProjectionInput,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowWorkItemRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      projectWorkItem(db, { ...input, source: input.source ?? 'explicit' }, options)
      const item = findWorkflowWorkItem(db, input.id.trim())
      if (!item) throw new Error(`workflow work item ${input.id} was not persisted`)
      return item
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'createWorkflowWorkItem',
      targetType: 'work_item',
      targetId: input.id,
      projectId: input.projectId,
      toStatus: input.status
    })
  }
}

export async function createWorkflowArtifact(
  input: WorkflowArtifactInput,
  rootDir?: string
): Promise<WorkflowArtifactRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    registerWorkflowArtifact(db, input)
    const artifact = findWorkflowArtifact(db, input.id.trim())
    if (!artifact) throw new Error(`workflow artifact ${input.id} was not persisted`)
    return artifact
  })
}

export async function createWorkflowArtifactEdge(
  input: WorkflowArtifactEdgeInput,
  rootDir?: string
): Promise<WorkflowArtifactEdgeRecord> {
  return createPersistedWorkflowArtifactEdge(input, rootDir)
}

export async function createWorkflowArtifactLocation(
  input: WorkflowArtifactLocationInput,
  rootDir?: string
): Promise<WorkflowArtifactLocationRecord> {
  return createPersistedWorkflowArtifactLocation(input, rootDir)
}

export async function listWorkflowArtifactEdges(
  scope: WorkflowArtifactGraphScope = {},
  rootDir?: string
): Promise<WorkflowLedgerPage<WorkflowArtifactEdgeRecord>> {
  return listPersistedWorkflowArtifactEdges(scope, rootDir)
}

export async function listWorkflowArtifactLocations(
  scope: WorkflowArtifactGraphScope = {},
  rootDir?: string
): Promise<WorkflowLedgerPage<WorkflowArtifactLocationRecord>> {
  return listPersistedWorkflowArtifactLocations(scope, rootDir)
}

export async function queryWorkflowArtifactGraph(
  artifactId: string,
  rootDir?: string
): Promise<WorkflowArtifactNeighborhood> {
  return queryPersistedWorkflowArtifactGraph(artifactId, rootDir)
}

export async function verifyWorkflowArtifactGraph(
  rootDir?: string
): Promise<WorkflowArtifactGraphVerification> {
  return verifyPersistedWorkflowArtifactGraph(rootDir)
}

export async function createWorkflowEvidence(
  input: WorkflowEvidenceCreateInput,
  rootDir?: string,
  authority: Pick<AppendWorkflowEvidenceOptions, 'source' | 'verifier' | 'observedAt'> = {
    source: 'runtime',
    verifier: 'main-process'
  }
): Promise<WorkflowEvidenceRecord> {
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    setupWorkflowEvidenceSchema(db)
    assertWorkflowEvidenceReferences(db, input)
    const record = appendWorkflowEvidence(db, input as WorkflowEvidenceInput, authority)
    appendWorkflowEvent(db, {
      eventId: `workflow:evidence-record:${record.evidenceId}`,
      streamId: record.runId ? `run:${record.runId}` : `project:${record.projectId}`,
      entityType: 'system',
      entityId: record.evidenceId,
      kind: 'workflow.evidence.recorded',
      payload: { ...record },
      occurredAt: record.createdAt,
      correlationId: record.runId ?? record.workItemId ?? record.goalId ?? record.evidenceId
    }, {
      projectId: record.projectId,
      goalId: record.goalId,
      workItemId: record.workItemId,
      runId: record.runId
    })
    assertWorkflowEvidenceEventCoverage([record], readAndVerifyEvents(db))
    return record
  })
}

export async function listWorkflowEvidence(
  scope: WorkflowEvidenceScope = {},
  rootDir?: string
): Promise<WorkflowEvidenceRecord[]> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowEvidenceSchema(db)
    const records = listWorkflowEvidenceRecords(db, scope)
    assertWorkflowEvidenceEventCoverage(records, readAndVerifyEvents(db))
    return records
  })
}

export async function queryWorkflowEvidence(
  scope: WorkflowEvidenceScope = {},
  rootDir?: string
): Promise<WorkflowLedgerPage<WorkflowEvidenceRecord>> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowEvidenceSchema(db)
    const page = selectWorkflowEvidence(db, scope)
    assertWorkflowEvidenceEventCoverage(page.items, readAndVerifyEvents(db))
    return page
  })
}

export async function verifyWorkflowEvidence(
  rootDir?: string
): Promise<WorkflowEvidenceVerification> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowEvidenceSchema(db)
    const records = readAllWorkflowEvidenceForIntegrity(db)
    const verification = verifyWorkflowEvidenceRecords(db)
    assertWorkflowEvidenceEventCoverage(records, readAndVerifyEvents(db))
    return verification
  })
}

export async function saveWorkflowAcceptance(
  input: WorkflowAcceptanceInput,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowAcceptanceRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      projectWorkflowAcceptance(db, input, options)
      const acceptance = findWorkflowAcceptance(db, input.id.trim())
      if (!acceptance) throw new Error(`workflow acceptance ${input.id} was not persisted`)
      return acceptance
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'saveWorkflowAcceptance',
      targetType: 'acceptance',
      targetId: input.id,
      projectId: input.projectId,
      acceptanceId: input.id,
      toStatus: input.status,
      caller: options.caller as never,
      actorId: options.actorId
    })
  }
}

export async function createWorkflowEvidenceLink(
  input: WorkflowEvidenceLinkInput,
  rootDir?: string
): Promise<WorkflowEvidenceLinkRecord> {
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      linkWorkflowEvidence(db, input)
      const link = findWorkflowEvidenceLink(db, input.id.trim())
      if (!link) throw new Error(`workflow evidence link ${input.id} was not persisted`)
      return link
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'createWorkflowEvidenceLink',
      targetType: 'evidence_link',
      targetId: input.id,
      projectId: input.projectId,
      acceptanceId: input.acceptanceId,
      evidenceId: input.evidenceId
    })
  }
}

function assertWorkflowEvidenceReferences(
  db: Parameters<typeof appendWorkflowEvidence>[0],
  input: WorkflowEvidenceCreateInput
): void {
  const refs = resolveWorkflowEvidenceReferences(db, input)
  assertWorkflowEvidenceProjectBoundary(input, refs)
  assertWorkflowEvidenceHierarchy(input, refs)
}

interface WorkflowEvidenceReferences {
  goal: ReturnType<typeof findWorkflowGoal>
  workItem: ReturnType<typeof findWorkflowWorkItem>
  run: ReturnType<typeof findWorkflowRun>
  artifact: ReturnType<typeof findWorkflowArtifact>
}

function resolveWorkflowEvidenceReferences(
  db: Parameters<typeof appendWorkflowEvidence>[0],
  input: WorkflowEvidenceCreateInput
): WorkflowEvidenceReferences {
  const refs: WorkflowEvidenceReferences = {
    goal: input.goalId ? findWorkflowGoal(db, input.goalId.trim()) : null,
    workItem: input.workItemId ? findWorkflowWorkItem(db, input.workItemId.trim()) : null,
    run: input.runId ? findWorkflowRun(db, input.runId.trim()) : null,
    artifact: input.artifactId ? findWorkflowArtifact(db, input.artifactId.trim()) : null
  }
  for (const [label, id, record] of [
    ['goal', input.goalId, refs.goal],
    ['work item', input.workItemId, refs.workItem],
    ['run', input.runId, refs.run],
    ['artifact', input.artifactId, refs.artifact]
  ] as const) {
    if (id && !record) throw new Error(`workflow evidence ${input.evidenceId} references missing ${label} ${id}`)
  }
  return refs
}

function assertWorkflowEvidenceProjectBoundary(
  input: WorkflowEvidenceCreateInput,
  refs: WorkflowEvidenceReferences
): void {
  for (const record of Object.values(refs)) {
    if (record && record.projectId !== input.projectId) {
      throw new Error(`workflow evidence ${input.evidenceId} crosses project boundary`)
    }
  }
}

function assertWorkflowEvidenceHierarchy(
  input: WorkflowEvidenceCreateInput,
  refs: WorkflowEvidenceReferences
): void {
  if (refs.workItem && input.goalId && refs.workItem.goalId !== input.goalId) {
    throw new Error(`workflow evidence ${input.evidenceId} goal/work item ownership differs`)
  }
  assertWorkflowEvidenceRunHierarchy(input, refs.run)
  assertWorkflowEvidenceArtifactHierarchy(input, refs.artifact)
}

function assertWorkflowEvidenceRunHierarchy(
  input: WorkflowEvidenceCreateInput,
  run: WorkflowEvidenceReferences['run']
): void {
  if (!run) return
  if (input.workItemId && run.workItemId !== input.workItemId) {
    throw new Error(`workflow evidence ${input.evidenceId} run/work item ownership differs`)
  }
  if (input.goalId && run.goalId !== input.goalId) {
    throw new Error(`workflow evidence ${input.evidenceId} run/goal ownership differs`)
  }
}

function assertWorkflowEvidenceArtifactHierarchy(
  input: WorkflowEvidenceCreateInput,
  artifact: WorkflowEvidenceReferences['artifact']
): void {
  if (!artifact) return
  if (input.runId && artifact.runId !== input.runId) {
    throw new Error(`workflow evidence ${input.evidenceId} artifact/run ownership differs`)
  }
  if (input.workItemId && artifact.workItemId !== input.workItemId) {
    throw new Error(`workflow evidence ${input.evidenceId} artifact/work item ownership differs`)
  }
  if (input.goalId && artifact.goalId !== input.goalId) {
    throw new Error(`workflow evidence ${input.evidenceId} artifact/goal ownership differs`)
  }
}

export async function transitionWorkflowWorkItem(
  id: string,
  status: WorkflowWorkItemStatus,
  expectedRevision: number,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowWorkItemRecord> {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error('workflow work item id is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error('workflow work item expectedRevision must be a positive integer')
  }
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      const current = findWorkflowWorkItem(db, normalizedId)
      if (!current) throw new Error(`workflow work item ${normalizedId} not found`)
      if (current.revision !== expectedRevision) {
        throw new WorkflowAcceptanceGateError(
          'WORKFLOW_REVISION_CONFLICT',
          `stale_revision: workflow work item ${normalizedId} is at ${current.revision}`,
          {
            operation: 'transitionWorkflowWorkItem',
            targetType: 'work_item',
            targetId: normalizedId,
            projectId: current.projectId,
            expectedRevision,
            actualRevision: current.revision,
            fromStatus: current.status,
            toStatus: status,
            caller: options.caller as never,
            actorId: options.actorId
          }
        )
      }
      projectWorkItem(db, {
        ...current,
        status,
        revision: current.revision + 1,
        updatedAt: Date.now()
      }, options)
      const updated = findWorkflowWorkItem(db, normalizedId)
      if (!updated) throw new Error(`workflow work item ${normalizedId} disappeared after transition`)
      return updated
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'transitionWorkflowWorkItem',
      targetType: 'work_item',
      targetId: normalizedId,
      toStatus: status,
      expectedRevision,
      caller: options.caller as never,
      actorId: options.actorId
    })
  }
}

/** Goal transition counterpart to the existing WorkItem CAS API. */
export async function transitionWorkflowGoal(
  id: string,
  status: WorkflowGoalStatus,
  expectedRevision: number,
  rootDir?: string,
  options: WorkflowLedgerWriteOptions = {}
): Promise<WorkflowGoalRecord> {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error('workflow goal id is required')
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error('workflow goal expectedRevision must be a positive integer')
  }
  try {
    return await mutateTaskSnapshotDatabase(rootDir, (db) => {
      setupWorkflowLedgerSchema(db)
      const current = findWorkflowGoal(db, normalizedId)
      if (!current) throw new Error(`workflow goal ${normalizedId} not found`)
      if (current.revision !== expectedRevision) {
        throw new WorkflowAcceptanceGateError(
          'WORKFLOW_REVISION_CONFLICT',
          `stale_revision: workflow goal ${normalizedId} is at ${current.revision}`,
          {
            operation: 'transitionWorkflowGoal',
            targetType: 'goal',
            targetId: normalizedId,
            projectId: current.projectId,
            expectedRevision,
            actualRevision: current.revision,
            fromStatus: current.status,
            toStatus: status,
            caller: options.caller as never,
            actorId: options.actorId
          }
        )
      }
      projectGoal(db, {
        ...current,
        status,
        revision: current.revision + 1,
        updatedAt: Date.now()
      }, options)
      const updated = findWorkflowGoal(db, normalizedId)
      if (!updated) throw new Error(`workflow goal ${normalizedId} disappeared after transition`)
      return updated
    })
  } catch (error) {
    throw toWorkflowAcceptanceError(error, {
      operation: 'transitionWorkflowGoal',
      targetType: 'goal',
      targetId: normalizedId,
      toStatus: status,
      expectedRevision,
      caller: options.caller as never,
      actorId: options.actorId
    })
  }
}
