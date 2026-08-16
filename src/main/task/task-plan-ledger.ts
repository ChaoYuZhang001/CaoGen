import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from './task-snapshot'
import { appendWorkflowEvent } from './workflow-ledger-store'
import { readWorkflowEventChain } from './workflow-ledger-query'
import { digest } from './workflow-ledger-codec'
import { insertEvent } from './workflow-ledger-sql'
import type { WorkflowEventRecord } from '../../shared/workflow-types'
import type { TaskPlanApprovalEvent, TaskPlanStateView, TaskPlanVersion } from '../../shared/task-plan-types'
import { TaskPlanContractStore } from './task-plan-contract-store'

/**
 * Projects the private TaskPlan contract into the append-only Workflow Ledger.
 * The JSON contract remains the validated write model for now; Ledger events
 * make history, export, and recovery observable through the canonical store.
 */
export async function syncTaskPlanLedger(
  rootDir: string,
  state: TaskPlanStateView
): Promise<void> {
  await mutateTaskSnapshotDatabase(rootDir, (db) => {
    const expected = syncState(db, state)
    assertNoOrphanEvents(readWorkflowEventChain(db), expected, state.sessionId)
  })
}

/** Replays all private plans after startup and repairs missing Ledger events. */
export async function reconcileTaskPlanLedger(
  rootDir: string,
  plans: readonly TaskPlanStateView[]
): Promise<void> {
  await mutateTaskSnapshotDatabase(rootDir, (db) => {
    // Force chain validation before adding repairs. A corrupt chain must remain
    // fail-closed rather than being hidden by a successful plan write.
    readWorkflowEventChain(db)
    const expected = new Set<string>()
    for (const state of plans) for (const eventId of syncState(db, state)) expected.add(eventId)
    assertNoOrphanEvents(readWorkflowEventChain(db), expected)
  })
}

export async function reconcileAllTaskPlans(rootDir: string): Promise<void> {
  const store = new TaskPlanContractStore(() => rootDir)
  await reconcileTaskPlanLedger(rootDir, store.listAll())
}

export async function purgeTaskPlanLedgerForSession(rootDir: string, sessionId: string): Promise<number> {
  const id = requiredId(sessionId)
  return mutateTaskSnapshotDatabase(rootDir, (db) => {
    const events = readWorkflowEventChain(db)
    const remaining = events.filter((event) => !isTaskPlanEvent(event) || event.sessionId !== id)
    if (remaining.length === events.length) return 0
    rebuildEventChain(db, remaining)
    return events.length - remaining.length
  })
}

export async function countTaskPlanLedgerForSession(rootDir: string, sessionId: string): Promise<number> {
  const id = requiredId(sessionId)
  return readTaskSnapshotDatabase(rootDir, (db) => readWorkflowEventChain(db).filter((event) =>
    isTaskPlanEvent(event) && event.sessionId === id).length)
}

function syncState(
  db: Parameters<typeof appendWorkflowEvent>[0],
  state: TaskPlanStateView
): Set<string> {
  const eventIds = new Set<string>()
  for (const version of state.versions) eventIds.add(appendVersionEvent(db, version))
  for (const approval of state.approvalEvents) {
    eventIds.add(appendApprovalEvent(db, approval, state.versions))
  }
  return eventIds
}

function appendVersionEvent(
  db: Parameters<typeof appendWorkflowEvent>[0],
  version: TaskPlanVersion
): string {
  const eventId = `workflow:task-plan:${version.binding.sessionId}:version:${version.version}:${version.digest}`
  appendWorkflowEvent(db, {
    eventId,
    streamId: `task-plan:${version.binding.sessionId}`,
    entityType: 'system',
    entityId: `task-plan:${version.binding.sessionId}`,
    kind: 'workflow.task_plan.version.created',
    payload: { type: 'version', version },
    occurredAt: version.createdAt,
    correlationId: version.binding.sessionId
  }, scope(version.binding))
  return eventId
}

function appendApprovalEvent(
  db: Parameters<typeof appendWorkflowEvent>[0],
  approval: TaskPlanApprovalEvent,
  versions: readonly TaskPlanVersion[]
): string {
  const version = versions.find((candidate) => candidate.version === approval.version)
  if (!version || version.digest !== approval.digest) {
    throw new Error(`TaskPlan approval ${approval.id} references a missing version`)
  }
  const eventId = `workflow:task-plan:${approval.sessionId}:approval:${approval.id}`
  appendWorkflowEvent(db, {
    eventId,
    streamId: `task-plan:${approval.sessionId}`,
    entityType: 'system',
    entityId: `task-plan:${approval.sessionId}`,
    kind: `workflow.task_plan.approval.${approval.kind}`,
    payload: { type: 'approval', approval },
    occurredAt: approval.occurredAt,
    correlationId: approval.sessionId
  }, scope(version.binding))
  return eventId
}

function scope(binding: TaskPlanVersion['binding']): {
  projectId?: string
  goalId?: string
  workItemId?: string
  sessionId?: string
} {
  return {
    ...(binding.workspaceId ? { projectId: binding.workspaceId } : {}),
    ...(binding.goalId ? { goalId: binding.goalId } : {}),
    ...(binding.workItemId ? { workItemId: binding.workItemId } : {}),
    sessionId: binding.sessionId
  }
}

function assertNoOrphanEvents(
  events: readonly WorkflowEventRecord[],
  expected: ReadonlySet<string>,
  sessionId?: string
): void {
  const orphan = events.find((event) => isTaskPlanEvent(event) &&
    (sessionId === undefined || event.sessionId === sessionId) && !expected.has(event.eventId))
  if (orphan) throw new Error(`Workflow Ledger contains orphan TaskPlan event ${orphan.eventId}`)
}

function isTaskPlanEvent(event: WorkflowEventRecord): boolean {
  return event.kind.startsWith('workflow.task_plan.') && event.entityType === 'system'
}

function rebuildEventChain(
  db: Parameters<typeof appendWorkflowEvent>[0],
  events: readonly WorkflowEventRecord[]
): void {
  db.run('DELETE FROM workflow_events')
  let previousDigest = '0'.repeat(64)
  for (let index = 0; index < events.length; index += 1) {
    const { digest: _digest, seq: _seq, prevDigest: _previous, ...immutable } = events[index]
    const withoutDigest = { ...immutable, seq: index + 1, prevDigest: previousDigest }
    const rebuilt: WorkflowEventRecord = { ...withoutDigest, digest: digest(withoutDigest) }
    insertEvent(db, rebuilt)
    previousDigest = rebuilt.digest
  }
  readWorkflowEventChain(db)
}

function requiredId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('TaskPlan sessionId is invalid')
  return id
}
