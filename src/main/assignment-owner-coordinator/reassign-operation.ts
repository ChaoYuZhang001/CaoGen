import { randomUUID } from 'node:crypto'
import type {
  AssignmentInput,
  AssignmentOwnerCommitReceipt,
  AssignmentOwnerJournalEntry,
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerStoreDocument
} from '../../shared/digital-worker-types'
import type { ProjectWorkspaceState, WorkItem } from '../../shared/project-workspace-types'
import { normalizeAssignmentInput } from '../digital-worker/codec'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { assertDigitalWorkerAssignmentPolicy } from '../digital-worker/relations'
import type { ProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { ProjectWorkspaceStore } from '../project-workspace/store'
import type {
  AssignmentOwnerCoordinatorOptions,
  AssignmentOwnerReassignRequest
} from './contracts'
import {
  AssignmentOwnerCoordinatorError,
  AssignmentOwnerCrashSimulationError,
  type AssignmentOwnerCrashPoint
} from './errors'
import {
  AssignmentOwnerJournal,
  type AssignmentOwnerJournalSession
} from './journal'
import {
  assignmentMatches,
  clone,
  coordinatorRequestDigest,
  errorText,
  normalizeReassignRequest,
  ownerMatchesAssignment,
  ownersEqual,
  readErrorCode
} from './validation'

interface ReassignPreflight {
  project: ProjectWorkspaceState
  workers: DigitalWorkerStoreDocument
  workItem: WorkItem
  current: DigitalWorkerAssignment
  nextWorker?: DigitalWorker
}

export class AssignmentReassignOperation {
  constructor(
    private readonly projectStore: ProjectWorkspaceStore,
    private readonly projectCommands: ProjectWorkspaceCommandService,
    private readonly workerStore: DigitalWorkerStore,
    private readonly journal: AssignmentOwnerJournal,
    private readonly options: AssignmentOwnerCoordinatorOptions
  ) {}

  async coordinate(rawRequest: AssignmentOwnerReassignRequest | unknown): Promise<AssignmentOwnerCommitReceipt> {
    const request = normalizeReassignRequest(rawRequest)
    const digest = coordinatorRequestDigest(request)
    return this.journal.withExclusive(async (session) => {
      let entry = session.document.entries.find((candidate) => candidate.requestId === request.requestId)
      if (entry) {
        assertReplay(entry, digest)
        if (entry.phase === 'committed' && entry.receipt) return clone(entry.receipt)
        if (isTerminal(entry)) throw terminalError(entry)
      } else {
        entry = this.prepare(request, digest, await this.preflight(request))
        session.document.entries.push(entry)
        session.appendAudit(entry, 'coordinator.prepared', {
          previousAssignmentId: entry.previousAssignmentId ?? '',
          expectedWorkItemRevision: entry.expectedWorkItemRevision,
          expectedProjectStoreRevision: entry.expectedProjectStoreRevision,
          expectedDigitalWorkerStoreRevision: entry.expectedDigitalWorkerStoreRevision
        })
        session.persist()
        await this.checkpoint('after_prepare', entry)
      }
      return this.advance(session, entry)
    })
  }

  recover(session: AssignmentOwnerJournalSession, entry: AssignmentOwnerJournalEntry): Promise<AssignmentOwnerCommitReceipt> {
    return this.advance(session, entry)
  }

  private async preflight(request: AssignmentOwnerReassignRequest): Promise<ReassignPreflight> {
    const [project, workers] = await Promise.all([
      this.projectStore.getState(),
      Promise.resolve(this.workerStore.read())
    ])
    const current = workers.assignments.find((candidate) => candidate.id === request.currentAssignmentId)
    if (!current) notFound(`Assignment not found: ${request.currentAssignmentId}`)
    if (current.status !== 'active') invariant(`Assignment is already released: ${current.id}`)
    assertNoActiveLease(workers, current)
    assertRevision(current.revision, request.expectedRevision, `Assignment ${current.id}`)
    assertRevision(workers.revision, request.expectedStoreRevision, 'DigitalWorker store')
    const next = request.nextInput
    if (next.projectId !== current.projectId || next.workItemId !== current.workItemId) {
      throw new AssignmentOwnerCoordinatorError(
        'PROJECT_SCOPE_CONFLICT',
        'Reassignment must stay within the same Project and WorkItem'
      )
    }
    const workspace = project.workspaces.find((candidate) => candidate.id === current.projectId)
    if (!workspace || workspace.status !== 'active') invariant(`ProjectWorkspace is not active: ${current.projectId}`)
    const workItem = project.workItems.find((candidate) => candidate.id === current.workItemId)
    if (!workItem || workItem.projectId !== current.projectId) {
      invariant(`Assignment WorkItem is outside its Project: ${current.workItemId}`)
    }
    if (!ownerMatchesAssignment(workItem, current)) {
      invariant(`WorkItem owner no longer matches Assignment ${current.id}`)
    }
    const nextWorker = next.assigneeKind === 'digital_worker'
      ? workers.workers.find((candidate) => candidate.id === next.assigneeId)
      : undefined
    if (next.assigneeKind === 'digital_worker') {
      validateWorker(nextWorker, current.projectId, next.assigneeId)
      assertDigitalWorkerAssignmentPolicy(nextWorker, normalizeAssignmentInput(next))
    }
    return {
      project,
      workers,
      workItem: clone(workItem),
      current: clone(current),
      ...(nextWorker === undefined ? {} : { nextWorker: clone(nextWorker) })
    }
  }

  private prepare(
    request: AssignmentOwnerReassignRequest,
    requestDigest: string,
    preflight: ReassignPreflight
  ): AssignmentOwnerJournalEntry {
    const next = request.nextInput
    const now = Date.now()
    const nextId = next.id ?? randomUUID()
    if (nextId === preflight.current.id) invariant('Reassignment must use a new Assignment id')
    return {
      schemaVersion: 1,
      operation: 'reassign',
      id: randomUUID(),
      requestId: request.requestId,
      requestDigest,
      projectId: preflight.current.projectId,
      workItemId: preflight.current.workItemId,
      assigneeKind: next.assigneeKind,
      assigneeId: next.assigneeId,
      ...(next.assigneeKind === 'digital_worker' ? { workerId: next.assigneeId } : {}),
      assignmentId: nextId,
      previousAssignmentId: preflight.current.id,
      assignedBy: next.assignedBy,
      assignedAt: next.assignedAt ?? now,
      owner: {
        type: next.assigneeKind,
        id: next.assigneeId,
        displayName: request.ownerDisplayName ?? preflight.nextWorker?.displayName ?? next.assigneeId
      },
      previousOwner: clone(preflight.workItem.owner),
      scope: clone(next.scope ?? {}),
      reason: next.reason,
      releaseReason: request.reason,
      releasedAt: request.now ?? now,
      expectedWorkItemRevision: preflight.workItem.revision,
      expectedProjectStoreRevision: preflight.project.revision,
      expectedDigitalWorkerStoreRevision: request.expectedStoreRevision ?? preflight.workers.revision,
      assignmentRevision: preflight.current.revision,
      phase: 'prepared',
      createdAt: now,
      updatedAt: now
    }
  }

  private async advance(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry
  ): Promise<AssignmentOwnerCommitReceipt> {
    try {
      if (entry.phase === 'compensation_pending') return await this.finishCompensation(session, entry)
      const state = this.assignmentState(entry)
      let workItem = await this.requiredWorkItem(entry.workItemId)
      if (state.current?.status === 'released' && state.next?.status === 'active') {
        assertNextMatches(state.next, entry)
        workItem = await this.finishNewOwner(entry, workItem)
        return this.commit(session, entry, state.current, state.next, workItem)
      }
      if (!state.current || state.current.status !== 'active' || state.next) {
        pending(`Reassignment ${entry.requestId} has an ambiguous Assignment state`)
      }
      workItem = await this.writeNewOwner(entry, workItem)
      if (entry.phase === 'prepared') {
        markPhase(entry, 'owner_written')
        entry.ownerRevision = workItem.revision
        session.appendAudit(entry, 'coordinator.owner_written', { ownerRevision: workItem.revision })
        session.persist()
      }
      const result = await this.workerStore.reassignAssignment(
        state.current.id,
        nextAssignmentInput(entry),
        {
          expectedRevision: entry.assignmentRevision,
          expectedStoreRevision: entry.expectedDigitalWorkerStoreRevision
        },
        { now: entry.releasedAt, reason: entry.releaseReason }
      )
      await this.checkpoint('after_reassignment_write', entry)
      markPhase(entry, 'reassignment_written')
      entry.assignmentRevision = result.assigned.revision
      session.appendAudit(entry, 'coordinator.reassignment_written', {
        previousAssignmentId: result.released.id,
        assignmentRevision: result.assigned.revision
      })
      session.persist()
      return this.commit(session, entry, result.released, result.assigned, workItem)
    } catch (error) {
      if (error instanceof AssignmentOwnerCrashSimulationError) throw error
      return this.resolveFailure(session, entry, error)
    }
  }

  private assignmentState(entry: AssignmentOwnerJournalEntry): {
    current?: DigitalWorkerAssignment
    next?: DigitalWorkerAssignment
  } {
    const document = this.workerStore.read()
    return {
      current: document.assignments.find((candidate) => candidate.id === entry.previousAssignmentId),
      next: document.assignments.find((candidate) => candidate.id === entry.assignmentId)
    }
  }

  private async writeNewOwner(entry: AssignmentOwnerJournalEntry, workItem: WorkItem): Promise<WorkItem> {
    if (ownerMatchesEntry(workItem, entry)) return workItem
    if (!ownersEqual(workItem.owner, entry.previousOwner)) {
      pending(`Reassignment ${entry.requestId} cannot overwrite a conflicting owner`)
    }
    const updated = await this.projectCommands.updateWorkItem(workItem.id, { owner: clone(entry.owner) }, {
      expectedRevision: entry.expectedWorkItemRevision,
      expectedStoreRevision: entry.expectedProjectStoreRevision
    })
    await this.checkpoint('after_owner_write', entry)
    return updated
  }

  private async finishNewOwner(entry: AssignmentOwnerJournalEntry, workItem: WorkItem): Promise<WorkItem> {
    if (ownerMatchesEntry(workItem, entry)) return workItem
    if (workItem.owner && !ownersEqual(workItem.owner, entry.previousOwner)) {
      pending(`Committed reassignment ${entry.requestId} has a conflicting owner`)
    }
    const storeRevision = await this.projectStore.getRevision()
    return this.projectCommands.updateWorkItem(workItem.id, { owner: clone(entry.owner) }, {
      expectedRevision: workItem.revision,
      expectedStoreRevision: storeRevision
    })
  }

  private async resolveFailure(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    cause: unknown
  ): Promise<AssignmentOwnerCommitReceipt> {
    const state = this.assignmentState(entry)
    const workItem = await this.projectStore.getWorkItem(entry.workItemId)
    if (!workItem) pending(`Reassignment ${entry.requestId} lost its WorkItem`)
    if (state.current?.status === 'released' && state.next?.status === 'active') {
      assertNextMatches(state.next, entry)
      const updated = await this.finishNewOwner(entry, workItem)
      return this.commit(session, entry, state.current, state.next, updated)
    }
    if (state.current?.status !== 'active' || state.next) {
      pending(`Reassignment ${entry.requestId} cannot determine a safe recovery outcome`)
    }
    if (entry.phase === 'prepared' && ownersEqual(workItem.owner, entry.previousOwner)) {
      markPhase(entry, 'failed', errorText(cause))
      session.appendAudit(entry, 'coordinator.failed', { error: errorText(cause) })
      session.persist()
      throw mapError(cause)
    }
    return this.compensate(session, entry, workItem, cause)
  }

  private async compensate(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    workItem: WorkItem,
    cause: unknown
  ): Promise<never> {
    markPhase(entry, 'compensation_pending', errorText(cause))
    session.appendAudit(entry, 'coordinator.compensation_pending', { error: errorText(cause) })
    session.persist()
    await this.checkpoint('before_compensation', entry)
    await this.restoreOldOwner(entry, workItem)
    markPhase(entry, 'compensated', errorText(cause))
    session.appendAudit(entry, 'coordinator.compensated', { error: errorText(cause) })
    session.persist()
    throw compensated(entry, cause)
  }

  private async finishCompensation(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry
  ): Promise<never> {
    const state = this.assignmentState(entry)
    if (state.current?.status !== 'active' || state.next) {
      pending(`Reassignment ${entry.requestId} no longer has its original active Assignment`)
    }
    await this.restoreOldOwner(entry, await this.requiredWorkItem(entry.workItemId))
    markPhase(entry, 'compensated', entry.lastError)
    session.appendAudit(entry, 'coordinator.compensated', { recovery: true, error: entry.lastError ?? '' })
    session.persist()
    throw compensated(entry, entry.lastError)
  }

  private async restoreOldOwner(entry: AssignmentOwnerJournalEntry, workItem: WorkItem): Promise<void> {
    if (!entry.previousOwner) pending(`Reassignment ${entry.requestId} has no original owner`)
    if (ownersEqual(workItem.owner, entry.previousOwner)) return
    if (workItem.owner && !ownerMatchesEntry(workItem, entry)) {
      pending(`Reassignment ${entry.requestId} cannot overwrite a conflicting owner`)
    }
    const storeRevision = await this.projectStore.getRevision()
    try {
      await this.projectCommands.updateWorkItem(workItem.id, { owner: clone(entry.previousOwner) }, {
        expectedRevision: workItem.revision,
        expectedStoreRevision: storeRevision
      })
    } catch (error) {
      pending(`Reassignment owner restoration remains pending: ${errorText(error)}`)
    }
  }

  private commit(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    released: DigitalWorkerAssignment,
    assigned: DigitalWorkerAssignment,
    workItem: WorkItem
  ): AssignmentOwnerCommitReceipt {
    const receipt: AssignmentOwnerCommitReceipt = {
      operation: 'reassign',
      requestId: entry.requestId,
      journalId: entry.id,
      assignmentId: assigned.id,
      previousAssignmentId: released.id,
      workItemId: workItem.id,
      assignment: clone(assigned),
      released: clone(released),
      assigned: clone(assigned),
      workItem: clone(workItem),
      committedAt: Date.now()
    }
    markPhase(entry, 'committed')
    entry.assignmentRevision = assigned.revision
    entry.ownerRevision = workItem.revision
    entry.receipt = clone(receipt)
    session.appendAudit(entry, 'coordinator.committed', {
      previousAssignmentId: released.id,
      assignmentRevision: assigned.revision,
      ownerRevision: workItem.revision
    })
    session.persist()
    return receipt
  }

  private async requiredWorkItem(id: string): Promise<WorkItem> {
    const workItem = await this.projectStore.getWorkItem(id)
    if (!workItem) notFound(`WorkItem not found during reassignment: ${id}`)
    return workItem
  }

  private async checkpoint(point: AssignmentOwnerCrashPoint, entry: AssignmentOwnerJournalEntry): Promise<void> {
    if (!this.options.faultInjector) return
    try {
      await this.options.faultInjector(point, clone(entry))
    } catch (error) {
      throw new AssignmentOwnerCrashSimulationError(point, error)
    }
  }
}

function nextAssignmentInput(entry: AssignmentOwnerJournalEntry): AssignmentInput {
  return {
    id: entry.assignmentId,
    projectId: entry.projectId,
    workItemId: entry.workItemId,
    assigneeKind: entry.assigneeKind,
    assigneeId: entry.assigneeId,
    scope: clone(entry.scope),
    assignedBy: entry.assignedBy,
    assignedAt: entry.assignedAt,
    reason: entry.reason
  }
}

function assertNextMatches(assignment: DigitalWorkerAssignment, entry: AssignmentOwnerJournalEntry): void {
  if (!assignmentMatches(assignment, entry)) {
    pending(`Reassignment id collision: ${entry.assignmentId}`)
  }
}

function assertReplay(entry: AssignmentOwnerJournalEntry, digest: string): void {
  if (entry.operation !== 'reassign' || entry.requestDigest !== digest) {
    throw new AssignmentOwnerCoordinatorError(
      'REQUEST_CONFLICT',
      `requestId ${entry.requestId} was already used with a different operation or payload`
    )
  }
}

function ownerMatchesEntry(workItem: WorkItem, entry: AssignmentOwnerJournalEntry): boolean {
  return workItem.owner?.type === entry.assigneeKind && workItem.owner.id === entry.assigneeId
}

function validateWorker(worker: DigitalWorker | undefined, projectId: string, workerId: string): asserts worker is DigitalWorker {
  if (!worker) notFound(`DigitalWorker not found: ${workerId}`)
  if (worker.projectId !== projectId) {
    throw new AssignmentOwnerCoordinatorError(
      'PROJECT_SCOPE_CONFLICT',
      `DigitalWorker ${workerId} does not belong to Project ${projectId}`
    )
  }
  if (worker.status !== 'active') invariant(`DigitalWorker is not active: ${worker.id}`)
}

function markPhase(
  entry: AssignmentOwnerJournalEntry,
  phase: AssignmentOwnerJournalEntry['phase'],
  lastError?: string
): void {
  entry.phase = phase
  entry.updatedAt = Date.now()
  if (lastError === undefined) delete entry.lastError
  else entry.lastError = lastError
}

function assertRevision(actual: number, expected: number | undefined, label: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new AssignmentOwnerCoordinatorError(
      'REVISION_CONFLICT',
      `${label} is at revision ${actual}, expected ${expected}`
    )
  }
}

function assertNoActiveLease(
  workers: DigitalWorkerStoreDocument,
  assignment: DigitalWorkerAssignment
): void {
  const lease = workers.leases.find(
    (candidate) => candidate.assignmentId === assignment.id && candidate.status === 'active'
  )
  if (lease) invariant(`Assignment ${assignment.id} has active lease ${lease.id}; release the lease first`)
}

function mapError(error: unknown): AssignmentOwnerCoordinatorError {
  if (error instanceof AssignmentOwnerCoordinatorError) return error
  const text = errorText(error)
  if (/REVISION|stale_revision|revision/i.test(`${readErrorCode(error)}${text}`)) {
    return new AssignmentOwnerCoordinatorError('REVISION_CONFLICT', text)
  }
  return new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', text)
}

function compensated(entry: AssignmentOwnerJournalEntry, cause: unknown): AssignmentOwnerCoordinatorError {
  return new AssignmentOwnerCoordinatorError(
    'COMPENSATED',
    `Reassignment ${entry.requestId} restored the original Assignment owner`,
    { cause: errorText(cause) }
  )
}

function isTerminal(entry: AssignmentOwnerJournalEntry): boolean {
  return entry.phase === 'committed' || entry.phase === 'compensated' || entry.phase === 'failed'
}

function terminalError(entry: AssignmentOwnerJournalEntry): AssignmentOwnerCoordinatorError {
  return new AssignmentOwnerCoordinatorError(
    entry.phase === 'compensated' ? 'COMPENSATED' : 'REQUEST_CONFLICT',
    `request ${entry.requestId} is terminal in phase ${entry.phase}`
  )
}

function notFound(message: string): never {
  throw new AssignmentOwnerCoordinatorError('NOT_FOUND', message)
}

function invariant(message: string): never {
  throw new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', message)
}

function pending(message: string): never {
  throw new AssignmentOwnerCoordinatorError('RECOVERY_PENDING', message)
}
