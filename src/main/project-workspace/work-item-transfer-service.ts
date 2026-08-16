import type {
  AssignmentInput,
  AssignmentOwnerCommitReceipt,
  AssignmentOwnerJournalEntry,
  DigitalWorkerAssignment,
  DigitalWorkerLease,
  DigitalWorkerStoreDocument,
  JsonObject
} from '../../shared/digital-worker-types'
import type {
  ProjectWorkspace,
  ProjectWorkspaceState,
  WorkItem,
  WorkItemActor,
  WorkItemOwner,
  WorkItemTransferContinuation,
  WorkItemTransferInput,
  WorkItemTransferResult
} from '../../shared/project-workspace-types'
import { openAssignmentOwnerCoordinator, type AssignmentOwnerCoordinator } from '../assignment-owner-coordinator'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { assertDigitalWorkerAssignmentPolicy } from '../digital-worker/relations'
import { ProjectWorkspaceError } from './errors'
import { ProjectWorkspaceStore } from './store'
import { assertWorkItemAuthorized, inspectWorkItemAuthorization } from './work-item-authorization'

interface TransferContext {
  state: ProjectWorkspaceState
  project: ProjectWorkspace
  workItem: WorkItem
  activeAssignment?: DigitalWorkerAssignment
}

export interface WorkItemTransferRuntimePreparation {
  pausedSessionIds: string[]
  pausedRunIds: string[]
  predecessorSessionId?: string
  predecessorRunId?: string
}

export interface WorkItemTransferRuntimePrepareInput {
  requestId: string
  projectId: string
  goalId?: string
  workItemId: string
  activeAssignment?: Pick<DigitalWorkerAssignment, 'id' | 'assigneeKind' | 'assigneeId'>
  activeWorkerLeases: Array<Pick<DigitalWorkerLease, 'id' | 'assignmentId' | 'workerId' | 'fencingToken'>>
}

export interface WorkItemTransferRuntimeContinueInput {
  requestId: string
  projectId: string
  goalId?: string
  workItemId: string
  workItemTitle: string
  target: WorkItemOwner
  assignmentId: string
  previousAssignmentId?: string
  preparation?: WorkItemTransferRuntimePreparation
}

export interface WorkItemTransferRuntime {
  prepare(input: WorkItemTransferRuntimePrepareInput): Promise<WorkItemTransferRuntimePreparation>
  continue(input: WorkItemTransferRuntimeContinueInput): Promise<WorkItemTransferContinuation>
}

export class WorkItemTransferService {
  private readonly projectStore: ProjectWorkspaceStore
  private readonly workerStore: DigitalWorkerStore

  constructor(
    private readonly rootDir: string,
    private readonly runtime?: WorkItemTransferRuntime
  ) {
    this.projectStore = new ProjectWorkspaceStore(rootDir)
    this.workerStore = new DigitalWorkerStore(rootDir)
  }

  async transfer(rawInput: WorkItemTransferInput | unknown, actor: WorkItemActor): Promise<WorkItemTransferResult> {
    const input = normalizeTransferInput(rawInput)
    await this.projectStore.open()
    const coordinator = await openAssignmentOwnerCoordinator(this.rootDir)
    const replay = await coordinator.getJournalEntry(input.requestId)
    if (replay) return this.replayResult(coordinator, replay, input, actor)

    let context = await this.preflight(input, actor)
    if (ownersEqual(context.workItem.owner, input.target)) {
      throw new ProjectWorkspaceError('owner_unchanged', `WorkItem ${input.workItemId} already has the requested owner`)
    }
    if (!context.activeAssignment && context.workItem.owner) {
      context = await this.bootstrapCurrentAssignment(coordinator, context, input, actor)
    }
    const preparation = await this.prepareRuntimeTransfer(context, input)
    const releasedWorkerLeaseIds = await this.releaseActiveWorkerLeases(context.activeAssignment)
    const receipt = context.activeAssignment
      ? await this.reassign(coordinator, context, input, actor)
      : await this.assign(coordinator, context, input, actor)
    return this.resultFromReceipt(
      coordinator,
      receipt,
      input,
      actor,
      false,
      preparation,
      releasedWorkerLeaseIds
    )
  }

  private async prepareRuntimeTransfer(
    context: TransferContext,
    input: WorkItemTransferInput
  ): Promise<WorkItemTransferRuntimePreparation | undefined> {
    if (!this.runtime) return undefined
    const activeWorkerLeases = context.activeAssignment
      ? this.workerStore.read().leases.filter((lease) =>
        lease.assignmentId === context.activeAssignment!.id && lease.status === 'active')
      : []
    return this.runtime.prepare({
      requestId: input.requestId,
      projectId: context.project.id,
      ...(context.workItem.goalId ? { goalId: context.workItem.goalId } : {}),
      workItemId: context.workItem.id,
      ...(context.activeAssignment
        ? {
            activeAssignment: {
              id: context.activeAssignment.id,
              assigneeKind: context.activeAssignment.assigneeKind,
              assigneeId: context.activeAssignment.assigneeId
            }
          }
        : {}),
      activeWorkerLeases: activeWorkerLeases.map((lease) => ({
        id: lease.id,
        assignmentId: lease.assignmentId,
        workerId: lease.workerId,
        fencingToken: lease.fencingToken
      }))
    })
  }

  private async releaseActiveWorkerLeases(
    assignment: DigitalWorkerAssignment | undefined
  ): Promise<string[]> {
    if (!assignment || !this.runtime) return []
    const leases = this.workerStore.read().leases.filter((lease) =>
      lease.assignmentId === assignment.id && lease.status === 'active')
    const released: string[] = []
    for (const lease of leases) {
      await this.workerStore.releaseLease({ leaseId: lease.id, fencingToken: lease.fencingToken })
      released.push(lease.id)
    }
    return released
  }

  private async preflight(input: WorkItemTransferInput, actor: WorkItemActor): Promise<TransferContext> {
    const [state, workers] = await Promise.all([
      this.projectStore.getState(),
      Promise.resolve(this.workerStore.read())
    ])
    const workItem = state.workItems.find((candidate) => candidate.id === input.workItemId)
    if (!workItem) throw new ProjectWorkspaceError('not_found', `WorkItem ${input.workItemId} does not exist`)
    const project = state.workspaces.find((candidate) => candidate.id === workItem.projectId)
    if (!project || project.status !== 'active') {
      throw new ProjectWorkspaceError('project_inactive', `Project ${workItem.projectId} is not active`)
    }
    assertWorkItemAuthorized(project, workItem, actor, 'transfer', input.expectedRevision, state)
    const active = workers.assignments.filter(
      (assignment) => assignment.workItemId === workItem.id && assignment.status === 'active'
    )
    if (active.length > 1) {
      throw new ProjectWorkspaceError('assignment_conflict', `WorkItem ${workItem.id} has multiple active Assignments`)
    }
    if (active[0] && !ownerMatchesAssignment(workItem.owner, active[0])) {
      throw new ProjectWorkspaceError('assignment_owner_conflict', 'Active Assignment does not match the WorkItem owner')
    }
    assertTransferTarget(workers, workItem, active[0], input, actor)
    return { state, project, workItem, ...(active[0] ? { activeAssignment: active[0] } : {}) }
  }

  private async bootstrapCurrentAssignment(
    coordinator: AssignmentOwnerCoordinator,
    context: TransferContext,
    input: WorkItemTransferInput,
    actor: WorkItemActor
  ): Promise<TransferContext> {
    const owner = context.workItem.owner
    if (!owner) return context
    const workers = this.workerStore.read()
    const receipt = await coordinator.createAssignment({
      requestId: `${input.requestId}:source-owner`,
      input: assignmentInput(context.workItem, owner, actor, `Transfer source reconciliation: ${input.reason}`),
      expectedWorkItemRevision: context.workItem.revision,
      expectedProjectStoreRevision: context.state.revision,
      expectedDigitalWorkerStoreRevision: workers.revision,
      ownerDisplayName: owner.displayName
    })
    return {
      ...context,
      state: await this.projectStore.getState(),
      workItem: receipt.workItem,
      activeAssignment: receipt.assignment
    }
  }

  private async reassign(
    coordinator: AssignmentOwnerCoordinator,
    context: TransferContext,
    input: WorkItemTransferInput,
    actor: WorkItemActor
  ): Promise<AssignmentOwnerCommitReceipt> {
    const current = context.activeAssignment
    if (!current) throw new ProjectWorkspaceError('assignment_missing', 'Current Assignment is required for reassignment')
    const workers = this.workerStore.read()
    return coordinator.reassignAssignment({
      requestId: input.requestId,
      currentAssignmentId: current.id,
      nextInput: assignmentInput(context.workItem, input.target, actor, input.reason, current.scope),
      expectedRevision: current.revision,
      expectedWorkItemRevision: context.workItem.revision,
      expectedStoreRevision: workers.revision,
      reason: input.reason,
      ownerDisplayName: input.target.displayName
    })
  }

  private async assign(
    coordinator: AssignmentOwnerCoordinator,
    context: TransferContext,
    input: WorkItemTransferInput,
    actor: WorkItemActor
  ): Promise<AssignmentOwnerCommitReceipt> {
    const workers = this.workerStore.read()
    return coordinator.createAssignment({
      requestId: input.requestId,
      input: assignmentInput(context.workItem, input.target, actor, input.reason),
      expectedWorkItemRevision: context.workItem.revision,
      expectedProjectStoreRevision: context.state.revision,
      expectedDigitalWorkerStoreRevision: workers.revision,
      ownerDisplayName: input.target.displayName
    })
  }

  private async replayResult(
    coordinator: AssignmentOwnerCoordinator,
    entry: AssignmentOwnerJournalEntry,
    input: WorkItemTransferInput,
    actor: WorkItemActor
  ): Promise<WorkItemTransferResult> {
    const worker = input.target.type === 'digital_worker'
      ? this.workerStore.read().workers.find((candidate) => candidate.id === input.target.id)
      : undefined
    assertReplayMatches(entry, input, actor, input.target.displayName ?? worker?.displayName ?? input.target.id)
    if (entry.phase !== 'committed' || !entry.receipt) {
      throw new ProjectWorkspaceError('transfer_recovery_pending', `Transfer ${input.requestId} is not committed`)
    }
    return this.resultFromReceipt(coordinator, entry.receipt, input, actor, true)
  }

  private async resultFromReceipt(
    coordinator: AssignmentOwnerCoordinator,
    receipt: AssignmentOwnerCommitReceipt,
    input: WorkItemTransferInput,
    actor: WorkItemActor,
    idempotentReplay: boolean,
    preparation?: WorkItemTransferRuntimePreparation,
    releasedWorkerLeaseIds: string[] = []
  ): Promise<WorkItemTransferResult> {
    const state = await this.projectStore.getState()
    const workItem = state.workItems.find((candidate) => candidate.id === receipt.workItemId)
    if (!workItem || !ownersEqual(workItem.owner, input.target)) {
      throw new ProjectWorkspaceError('transfer_projection_conflict', 'Committed transfer owner is not visible in ProjectWorkspace')
    }
    const project = state.workspaces.find((candidate) => candidate.id === workItem.projectId)
    if (!project) throw new ProjectWorkspaceError('not_found', `Project ${workItem.projectId} does not exist`)
    const events = await coordinator.listAudit(input.requestId)
    const continuation = this.runtime
      ? await this.runtime.continue({
          requestId: input.requestId,
          projectId: project.id,
          ...(workItem.goalId ? { goalId: workItem.goalId } : {}),
          workItemId: workItem.id,
          workItemTitle: workItem.title,
          target: { ...input.target },
          assignmentId: receipt.assignmentId,
          ...(receipt.previousAssignmentId ? { previousAssignmentId: receipt.previousAssignmentId } : {}),
          ...(preparation ? { preparation } : {})
        }).catch((error): WorkItemTransferContinuation => ({
          status: 'successor_failed',
          pausedSessionIds: preparation?.pausedSessionIds ?? [],
          pausedRunIds: preparation?.pausedRunIds ?? [],
          releasedWorkerLeaseIds,
          ...(preparation?.predecessorSessionId
            ? { predecessorSessionId: preparation.predecessorSessionId }
            : {}),
          ...(preparation?.predecessorRunId ? { predecessorRunId: preparation.predecessorRunId } : {}),
          error: boundedError(error)
        }))
      : undefined
    return {
      requestId: input.requestId,
      projectId: project.id,
      workItemId: workItem.id,
      ...(receipt.released ? { previousOwner: ownerFromAssignment(receipt.released) } : {}),
      owner: { ...input.target },
      ...(receipt.previousAssignmentId ? { previousAssignmentId: receipt.previousAssignmentId } : {}),
      assignmentId: receipt.assignmentId,
      workItem,
      authorization: inspectWorkItemAuthorization(project, workItem, ownerActor(input.target), state),
      auditEventIds: events.map((event) => event.id),
      idempotentReplay,
      ...(continuation
        ? {
            continuation: {
              ...continuation,
              releasedWorkerLeaseIds: [
                ...new Set([...continuation.releasedWorkerLeaseIds, ...releasedWorkerLeaseIds])
              ]
            }
          }
        : {})
    }
  }
}

export function createWorkItemTransferService(
  rootDir: string,
  runtime?: WorkItemTransferRuntime
): WorkItemTransferService {
  return new WorkItemTransferService(rootDir, runtime)
}

function normalizeTransferInput(value: WorkItemTransferInput | unknown): WorkItemTransferInput {
  const record = requiredRecord(value, 'WorkItem transfer')
  assertExactKeys(record, ['requestId', 'workItemId', 'target', 'reason', 'expectedRevision'])
  const targetRecord = requiredRecord(record.target, 'WorkItem transfer target')
  assertExactKeys(targetRecord, ['type', 'id', 'displayName'])
  if (targetRecord.type !== 'human' && targetRecord.type !== 'digital_worker') {
    throw new ProjectWorkspaceError('invalid_input', 'WorkItem transfer target type is invalid')
  }
  const target: WorkItemOwner = {
    type: targetRecord.type,
    id: requiredText(targetRecord.id, 'target id', 512),
    ...(targetRecord.displayName === undefined
      ? {}
      : { displayName: requiredText(targetRecord.displayName, 'target display name', 2_048) })
  }
  return {
    requestId: requiredText(record.requestId, 'requestId', 512),
    workItemId: requiredText(record.workItemId, 'workItemId', 512),
    target,
    reason: requiredText(record.reason, 'transfer reason', 8_192),
    expectedRevision: positiveInteger(record.expectedRevision, 'expectedRevision')
  }
}

function assignmentInput(
  workItem: WorkItem,
  owner: WorkItemOwner,
  actor: WorkItemActor,
  reason: string,
  scope: JsonObject = {}
): AssignmentInput {
  return {
    projectId: workItem.projectId,
    workItemId: workItem.id,
    assigneeKind: owner.type,
    assigneeId: owner.id,
    scope,
    assignedBy: actor.id,
    reason
  }
}

function assertTransferTarget(
  workers: DigitalWorkerStoreDocument,
  workItem: WorkItem,
  activeAssignment: DigitalWorkerAssignment | undefined,
  input: WorkItemTransferInput,
  actor: WorkItemActor
): void {
  if (input.target.type !== 'digital_worker') return
  const worker = workers.workers.find((candidate) => candidate.id === input.target.id)
  if (!worker) {
    throw new ProjectWorkspaceError('target_not_found', `DigitalWorker ${input.target.id} does not exist`)
  }
  if (worker.projectId !== workItem.projectId) {
    throw new ProjectWorkspaceError(
      'project_scope_conflict',
      `DigitalWorker ${worker.id} does not belong to Project ${workItem.projectId}`
    )
  }
  if (worker.status !== 'active') {
    throw new ProjectWorkspaceError('target_inactive', `DigitalWorker ${worker.id} is ${worker.status}`)
  }
  const candidate = assignmentInput(workItem, input.target, actor, input.reason, activeAssignment?.scope)
  assertDigitalWorkerAssignmentPolicy(worker, {
    schemaVersion: 1,
    id: `transfer-preflight:${input.requestId}`,
    projectId: candidate.projectId,
    workItemId: candidate.workItemId,
    assigneeKind: candidate.assigneeKind,
    assigneeId: candidate.assigneeId,
    scope: candidate.scope ?? {},
    assignedBy: candidate.assignedBy,
    assignedAt: Date.now(),
    reason: candidate.reason,
    status: 'active',
    revision: 1
  })
}

function assertReplayMatches(
  entry: AssignmentOwnerJournalEntry,
  input: WorkItemTransferInput,
  actor: WorkItemActor,
  targetDisplayName: string
): void {
  const reason = entry.operation === 'reassign' ? entry.releaseReason : entry.reason
  if (
    entry.workItemId !== input.workItemId ||
    entry.assigneeKind !== input.target.type ||
    entry.assigneeId !== input.target.id ||
    entry.owner?.displayName !== targetDisplayName ||
    entry.assignedBy !== actor.id ||
    reason !== input.reason ||
    entry.expectedWorkItemRevision !== input.expectedRevision
  ) {
    throw new ProjectWorkspaceError('request_conflict', `requestId ${input.requestId} was reused with a different transfer`)
  }
}

function ownerMatchesAssignment(owner: WorkItemOwner | undefined, assignment: DigitalWorkerAssignment): boolean {
  return owner?.type === assignment.assigneeKind && owner.id === assignment.assigneeId
}

function ownerFromAssignment(assignment: DigitalWorkerAssignment): WorkItemOwner {
  return { type: assignment.assigneeKind, id: assignment.assigneeId }
}

function ownerActor(owner: WorkItemOwner): WorkItemActor {
  return { type: owner.type, id: owner.id, ...(owner.displayName ? { displayName: owner.displayName } : {}) }
}

function ownersEqual(left: WorkItemOwner | undefined, right: WorkItemOwner | undefined): boolean {
  if (!left || !right) return left === right
  return left.type === right.type && left.id === right.id
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new ProjectWorkspaceError('invalid_input', `WorkItem transfer contains unknown field ${key}`)
  }
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maximum || /[\0-\x1F\x7F]/.test(value)) {
    throw new ProjectWorkspaceError('invalid_input', `${label} is invalid`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be a positive integer`)
  }
  return value as number
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 1_000) || 'Successor session creation failed'
}
