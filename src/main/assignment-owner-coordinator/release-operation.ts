import { randomUUID } from 'node:crypto'
import type {
  AssignmentOwnerCommitReceipt,
  AssignmentOwnerJournalEntry,
  DigitalWorkerAssignment,
  DigitalWorkerStoreDocument
} from '../../shared/digital-worker-types'
import type { ProjectWorkspaceState, WorkItem } from '../../shared/project-workspace-types'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import type { ProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { ProjectWorkspaceStore } from '../project-workspace/store'
import type {
  AssignmentOwnerCoordinatorOptions,
  AssignmentOwnerReleaseRequest
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
  clone,
  coordinatorRequestDigest,
  errorText,
  normalizeReleaseRequest,
  ownerMatchesAssignment,
  ownersEqual,
  readErrorCode
} from './validation'

interface ReleasePreflight {
  project: ProjectWorkspaceState
  workers: DigitalWorkerStoreDocument
  workItem: WorkItem
  assignment: DigitalWorkerAssignment
}

export class AssignmentReleaseOperation {
  constructor(
    private readonly projectStore: ProjectWorkspaceStore,
    private readonly projectCommands: ProjectWorkspaceCommandService,
    private readonly workerStore: DigitalWorkerStore,
    private readonly journal: AssignmentOwnerJournal,
    private readonly options: AssignmentOwnerCoordinatorOptions
  ) {}

  async coordinate(rawRequest: AssignmentOwnerReleaseRequest | unknown): Promise<AssignmentOwnerCommitReceipt> {
    const request = normalizeReleaseRequest(rawRequest)
    const digest = coordinatorRequestDigest(request)
    return this.journal.withExclusive(async (session) => {
      let entry = session.document.entries.find((candidate) => candidate.requestId === request.requestId)
      if (entry) {
        assertReplay(entry, digest, 'release')
        if (entry.phase === 'committed' && entry.receipt) return clone(entry.receipt)
        if (isTerminal(entry)) throw terminalError(entry)
      } else {
        entry = this.prepare(request, digest, await this.preflight(request))
        session.document.entries.push(entry)
        session.appendAudit(entry, 'coordinator.prepared', {
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

  private async preflight(request: AssignmentOwnerReleaseRequest): Promise<ReleasePreflight> {
    const [project, workers] = await Promise.all([
      this.projectStore.getState(),
      Promise.resolve(this.workerStore.read())
    ])
    const assignment = workers.assignments.find((candidate) => candidate.id === request.assignmentId)
    if (!assignment) notFound(`Assignment not found: ${request.assignmentId}`)
    if (assignment.status !== 'active') invariant(`Assignment is already released: ${assignment.id}`)
    assertNoActiveLease(workers, assignment)
    assertRevision(assignment.revision, request.options?.expectedRevision, `Assignment ${assignment.id}`)
    assertRevision(workers.revision, request.options?.expectedStoreRevision, 'DigitalWorker store')
    const workspace = project.workspaces.find((candidate) => candidate.id === assignment.projectId)
    if (!workspace || workspace.status !== 'active') {
      invariant(`Assignment ProjectWorkspace is not active: ${assignment.projectId}`)
    }
    const workItem = project.workItems.find((candidate) => candidate.id === assignment.workItemId)
    if (!workItem || workItem.projectId !== assignment.projectId) {
      invariant(`Assignment WorkItem is outside its Project: ${assignment.workItemId}`)
    }
    if (!ownerMatchesAssignment(workItem, assignment)) {
      invariant(`WorkItem owner no longer matches Assignment ${assignment.id}`)
    }
    return { project, workers, assignment: clone(assignment), workItem: clone(workItem) }
  }

  private prepare(
    request: AssignmentOwnerReleaseRequest,
    requestDigest: string,
    preflight: ReleasePreflight
  ): AssignmentOwnerJournalEntry {
    const { assignment, workItem } = preflight
    const now = Date.now()
    return {
      schemaVersion: 1,
      operation: 'release',
      id: randomUUID(),
      requestId: request.requestId,
      requestDigest,
      projectId: assignment.projectId,
      workItemId: assignment.workItemId,
      assigneeKind: assignment.assigneeKind,
      assigneeId: assignment.assigneeId,
      ...(assignment.assigneeKind === 'digital_worker' ? { workerId: assignment.assigneeId } : {}),
      assignmentId: assignment.id,
      assignedBy: assignment.assignedBy,
      assignedAt: assignment.assignedAt,
      owner: clone(workItem.owner!),
      previousOwner: clone(workItem.owner),
      scope: clone(assignment.scope),
      reason: assignment.reason,
      releaseReason: request.releaseOptions?.reason,
      releasedAt: request.releaseOptions?.now ?? now,
      expectedWorkItemRevision: workItem.revision,
      expectedProjectStoreRevision: preflight.project.revision,
      expectedDigitalWorkerStoreRevision: request.options?.expectedStoreRevision ?? preflight.workers.revision,
      assignmentRevision: assignment.revision,
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
      let assignment = await this.requiredAssignment(entry.assignmentId)
      let workItem = await this.requiredWorkItem(entry.workItemId)
      if (assignment.status === 'released') {
        workItem = await this.finishReleasedOwner(entry, workItem)
        return this.commit(session, entry, assignment, workItem)
      }
      workItem = await this.clearOwner(entry, workItem)
      if (entry.phase === 'prepared') {
        markPhase(entry, 'owner_cleared')
        entry.ownerRevision = workItem.revision
        session.appendAudit(entry, 'coordinator.owner_cleared', { ownerRevision: workItem.revision })
        session.persist()
      }
      assignment = await this.workerStore.releaseAssignment(
        entry.assignmentId,
        {
          expectedRevision: entry.assignmentRevision,
          expectedStoreRevision: entry.expectedDigitalWorkerStoreRevision
        },
        { now: entry.releasedAt, reason: entry.releaseReason }
      )
      await this.checkpoint('after_assignment_release', entry)
      markPhase(entry, 'assignment_released')
      entry.assignmentRevision = assignment.revision
      session.appendAudit(entry, 'coordinator.assignment_released', {
        assignmentRevision: assignment.revision
      })
      session.persist()
      return this.commit(session, entry, assignment, workItem)
    } catch (error) {
      if (error instanceof AssignmentOwnerCrashSimulationError) throw error
      return this.resolveFailure(session, entry, error)
    }
  }

  private async clearOwner(entry: AssignmentOwnerJournalEntry, workItem: WorkItem): Promise<WorkItem> {
    if (!workItem.owner) return workItem
    if (!ownerMatchesEntry(workItem, entry)) {
      invariant(`WorkItem owner no longer matches Assignment ${entry.assignmentId}`)
    }
    const cleared = await this.projectCommands.updateWorkItem(
      workItem.id,
      { owner: null },
      {
        expectedRevision: entry.expectedWorkItemRevision,
        expectedStoreRevision: entry.expectedProjectStoreRevision
      }
    )
    await this.checkpoint('after_owner_clear', entry)
    return cleared
  }

  private async finishReleasedOwner(entry: AssignmentOwnerJournalEntry, workItem: WorkItem): Promise<WorkItem> {
    if (!workItem.owner) return workItem
    if (!ownerMatchesEntry(workItem, entry)) {
      pending(`Released Assignment ${entry.assignmentId} has a conflicting WorkItem owner`)
    }
    const storeRevision = await this.projectStore.getRevision()
    return this.projectCommands.updateWorkItem(workItem.id, { owner: null }, {
      expectedRevision: workItem.revision,
      expectedStoreRevision: storeRevision
    })
  }

  private async resolveFailure(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    cause: unknown
  ): Promise<AssignmentOwnerCommitReceipt> {
    const [assignment, workItem] = await Promise.all([
      this.workerStore.getAssignment(entry.assignmentId),
      this.projectStore.getWorkItem(entry.workItemId)
    ])
    if (assignment?.status === 'released' && workItem) {
      const cleared = await this.finishReleasedOwner(entry, workItem)
      return this.commit(session, entry, assignment, cleared)
    }
    if (!assignment || !workItem) pending(`Release recovery lost required state for ${entry.requestId}`)
    if (assignment.status === 'active' && ownersEqual(workItem.owner, entry.previousOwner)) {
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
    await this.restoreOwner(entry, workItem)
    markPhase(entry, 'compensated', errorText(cause))
    session.appendAudit(entry, 'coordinator.compensated', { error: errorText(cause) })
    session.persist()
    throw compensated(entry, cause)
  }

  private async finishCompensation(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry
  ): Promise<never> {
    const assignment = await this.requiredAssignment(entry.assignmentId)
    if (assignment.status !== 'active') pending(`Cannot compensate released Assignment ${assignment.id}`)
    const workItem = await this.requiredWorkItem(entry.workItemId)
    await this.restoreOwner(entry, workItem)
    markPhase(entry, 'compensated', entry.lastError)
    session.appendAudit(entry, 'coordinator.compensated', { recovery: true, error: entry.lastError ?? '' })
    session.persist()
    throw compensated(entry, entry.lastError)
  }

  private async restoreOwner(entry: AssignmentOwnerJournalEntry, workItem: WorkItem): Promise<void> {
    if (!entry.previousOwner) pending(`Release ${entry.requestId} has no owner to restore`)
    if (ownersEqual(workItem.owner, entry.previousOwner)) return
    if (workItem.owner) pending(`Release ${entry.requestId} cannot overwrite a conflicting owner`)
    const storeRevision = await this.projectStore.getRevision()
    try {
      await this.projectCommands.updateWorkItem(workItem.id, { owner: clone(entry.previousOwner) }, {
        expectedRevision: workItem.revision,
        expectedStoreRevision: storeRevision
      })
    } catch (error) {
      pending(`Release owner restoration remains pending: ${errorText(error)}`)
    }
  }

  private commit(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    assignment: DigitalWorkerAssignment,
    workItem: WorkItem
  ): AssignmentOwnerCommitReceipt {
    const receipt: AssignmentOwnerCommitReceipt = {
      operation: 'release',
      requestId: entry.requestId,
      journalId: entry.id,
      assignmentId: assignment.id,
      workItemId: workItem.id,
      assignment: clone(assignment),
      released: clone(assignment),
      workItem: clone(workItem),
      committedAt: Date.now()
    }
    markPhase(entry, 'committed')
    entry.assignmentRevision = assignment.revision
    entry.ownerRevision = workItem.revision
    entry.receipt = clone(receipt)
    session.appendAudit(entry, 'coordinator.committed', {
      assignmentRevision: assignment.revision,
      ownerRevision: workItem.revision
    })
    session.persist()
    return receipt
  }

  private async requiredAssignment(id: string): Promise<DigitalWorkerAssignment> {
    const assignment = await this.workerStore.getAssignment(id)
    if (!assignment) notFound(`Assignment not found during release: ${id}`)
    return assignment
  }

  private async requiredWorkItem(id: string): Promise<WorkItem> {
    const workItem = await this.projectStore.getWorkItem(id)
    if (!workItem) notFound(`WorkItem not found during release: ${id}`)
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

function assertReplay(entry: AssignmentOwnerJournalEntry, digest: string, operation: 'release'): void {
  if (entry.operation !== operation || entry.requestDigest !== digest) {
    throw new AssignmentOwnerCoordinatorError(
      'REQUEST_CONFLICT',
      `requestId ${entry.requestId} was already used with a different operation or payload`
    )
  }
}

function ownerMatchesEntry(workItem: WorkItem, entry: AssignmentOwnerJournalEntry): boolean {
  return workItem.owner?.type === entry.assigneeKind && workItem.owner.id === entry.assigneeId
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
    `Release ${entry.requestId} restored the original owner after Assignment release failed`,
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
