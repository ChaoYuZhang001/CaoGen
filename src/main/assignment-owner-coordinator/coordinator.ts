import { randomUUID } from 'node:crypto'
import type {
  AssignmentOwnerCommitReceipt,
  AssignmentOwnerCoordinateInput,
  AssignmentOwnerCoordinateResult,
  AssignmentOwnerCoordinatorAuditEvent,
  AssignmentOwnerJournalEntry,
  AssignmentOwnerRecoveryResult,
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerStoreDocument
} from '../../shared/digital-worker-types'
import type { ProjectWorkspaceState, WorkItem } from '../../shared/project-workspace-types'
import { digitalWorkerPolicyContractError } from '../digital-worker/action-policy-contract'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import {
  createProjectWorkspaceCommandService,
  type ProjectWorkspaceCommandService
} from '../project-workspace/command-service'
import { ProjectWorkspaceStore } from '../project-workspace/store'
import type {
  AssignmentOwnerCoordinatorOptions,
  AssignmentOwnerCreateRequest,
  AssignmentOwnerReassignRequest,
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
  assignmentMatches,
  clone,
  coordinatorRequestDigest,
  desiredOwner,
  errorText,
  normalizeAssignmentOwnerInput,
  normalizeCreateRequest,
  normalizeRequestId,
  ownerMatches,
  readErrorCode
} from './validation'
import { AssignmentReleaseOperation } from './release-operation'
import { AssignmentReassignOperation } from './reassign-operation'

interface PreflightState {
  project: ProjectWorkspaceState
  workers: DigitalWorkerStoreDocument
  workItem: WorkItem
  worker?: DigitalWorker
}

export class AssignmentOwnerCoordinator {
  private readonly projectStore: ProjectWorkspaceStore
  private readonly projectCommands: ProjectWorkspaceCommandService
  private readonly workerStore: DigitalWorkerStore
  private readonly journal: AssignmentOwnerJournal
  private readonly releaseOperation: AssignmentReleaseOperation
  private readonly reassignOperation: AssignmentReassignOperation
  private initialized = false

  constructor(private readonly options: AssignmentOwnerCoordinatorOptions) {
    this.projectStore = new ProjectWorkspaceStore(options.rootDir)
    this.projectCommands = createProjectWorkspaceCommandService(this.projectStore)
    this.workerStore = new DigitalWorkerStore(options.rootDir)
    this.journal = new AssignmentOwnerJournal(options.rootDir)
    this.releaseOperation = new AssignmentReleaseOperation(
      this.projectStore,
      this.projectCommands,
      this.workerStore,
      this.journal,
      options
    )
    this.reassignOperation = new AssignmentReassignOperation(
      this.projectStore,
      this.projectCommands,
      this.workerStore,
      this.journal,
      options
    )
  }

  async initialize(): Promise<this> {
    if (!this.initialized) {
      await this.projectStore.open()
      this.initialized = true
    }
    return this
  }

  async coordinate(rawInput: AssignmentOwnerCoordinateInput | unknown): Promise<AssignmentOwnerCoordinateResult> {
    const input = normalizeAssignmentOwnerInput(rawInput)
    return this.createAssignment({
      requestId: input.requestId,
      input: {
        projectId: input.projectId,
        workItemId: input.workItemId,
        assigneeKind: 'digital_worker',
        assigneeId: input.workerId,
        assignedBy: input.assignedBy,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.assignedAt === undefined ? {} : { assignedAt: input.assignedAt })
      },
      expectedWorkItemRevision: input.expectedWorkItemRevision,
      expectedProjectStoreRevision: input.expectedProjectStoreRevision,
      expectedDigitalWorkerStoreRevision: input.expectedDigitalWorkerStoreRevision,
      ownerDisplayName: input.ownerDisplayName
    })
  }

  async createAssignment(rawRequest: AssignmentOwnerCreateRequest | unknown): Promise<AssignmentOwnerCoordinateResult> {
    await this.initialize()
    const request = normalizeCreateRequest(rawRequest)
    const requestDigest = coordinatorRequestDigest(request)
    return this.journal.withExclusive(async (session) => {
      let entry = session.document.entries.find((candidate) => candidate.requestId === request.requestId)
      const idempotentReplay = entry !== undefined
      if (entry) {
        if (entry.operation !== 'assign' || entry.requestDigest !== requestDigest) {
          throw new AssignmentOwnerCoordinatorError(
            'REQUEST_CONFLICT',
            `requestId ${request.requestId} was already used with a different operation or payload`
          )
        }
        if (entry.phase === 'committed' && entry.receipt) {
          return resultFromReceipt(entry.receipt, true, false)
        }
        if (entry.phase === 'compensated' || entry.phase === 'failed') throw terminalEntryError(entry)
      } else {
        const preflight = await this.preflightCreate(request)
        entry = this.buildPreparedEntry(request, requestDigest, preflight)
        session.document.entries.push(entry)
        session.appendAudit(entry, 'coordinator.prepared', {
          expectedWorkItemRevision: entry.expectedWorkItemRevision,
          expectedProjectStoreRevision: entry.expectedProjectStoreRevision,
          expectedDigitalWorkerStoreRevision: entry.expectedDigitalWorkerStoreRevision
        })
        session.persist()
        await this.checkpoint('after_prepare', entry)
      }
      const receipt = await this.advance(session, entry, idempotentReplay)
      return resultFromReceipt(receipt, idempotentReplay, idempotentReplay)
    })
  }

  async releaseAssignment(
    rawRequest: AssignmentOwnerReleaseRequest | unknown
  ): Promise<AssignmentOwnerCommitReceipt> {
    await this.initialize()
    return this.releaseOperation.coordinate(rawRequest)
  }

  async reassignAssignment(
    rawRequest: AssignmentOwnerReassignRequest | unknown
  ): Promise<AssignmentOwnerCommitReceipt> {
    await this.initialize()
    return this.reassignOperation.coordinate(rawRequest)
  }

  async recoverPending(): Promise<AssignmentOwnerRecoveryResult[]> {
    await this.initialize()
    return this.journal.withExclusive(async (session) => {
      const pending = session.document.entries.filter((entry) => !isTerminal(entry))
      const outcomes: AssignmentOwnerRecoveryResult[] = []
      for (const entry of pending) {
        try {
          await this.advanceEntry(session, entry, true)
          outcomes.push(recoveryResult(entry, true))
        } catch (error) {
          outcomes.push(recoveryResult(entry, isTerminal(entry), errorText(error)))
        }
      }
      return outcomes
    })
  }

  async getJournalEntry(requestId: string): Promise<AssignmentOwnerJournalEntry | null> {
    return this.journal.getEntry(normalizeRequestId(requestId))
  }

  async listAudit(requestId?: string): Promise<AssignmentOwnerCoordinatorAuditEvent[]> {
    return this.journal.listAudit(requestId === undefined ? undefined : normalizeRequestId(requestId))
  }

  private advanceEntry(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    recovering: boolean
  ): Promise<AssignmentOwnerCommitReceipt> {
    if (entry.operation === 'assign') return this.advance(session, entry, recovering)
    if (entry.operation === 'release') return this.releaseOperation.recover(session, entry)
    return this.reassignOperation.recover(session, entry)
  }

  private async preflightCreate(request: AssignmentOwnerCreateRequest): Promise<PreflightState> {
    const input = request.input
    const [project, workers] = await Promise.all([
      this.projectStore.getState(),
      Promise.resolve(this.workerStore.read())
    ])
    const workItem = resolveCreateWorkItem(project, input)
    assertCreateRevisions(request, project, workers, workItem)
    const worker = resolveCreateWorker(workers, input)
    assertCreateAssignmentAvailable(workers, workItem, input)
    return {
      project,
      workers,
      workItem: clone(workItem),
      ...(worker === undefined ? {} : { worker: clone(worker) })
    }
  }

  private buildPreparedEntry(
    request: AssignmentOwnerCreateRequest,
    requestDigest: string,
    preflight: PreflightState
  ): AssignmentOwnerJournalEntry {
    const input = request.input
    const now = Date.now()
    return {
      schemaVersion: 1,
      operation: 'assign',
      id: randomUUID(),
      requestId: request.requestId,
      requestDigest,
      projectId: input.projectId,
      workItemId: input.workItemId,
      assigneeKind: input.assigneeKind,
      assigneeId: input.assigneeId,
      ...(input.assigneeKind === 'digital_worker' ? { workerId: input.assigneeId } : {}),
      assignmentId: input.id ?? randomUUID(),
      assignedBy: input.assignedBy,
      assignedAt: input.assignedAt ?? now,
      owner: {
        type: input.assigneeKind,
        id: input.assigneeId,
        displayName: request.ownerDisplayName ?? preflight.worker?.displayName ?? input.assigneeId
      },
      previousOwner: clone(preflight.workItem.owner),
      scope: clone(input.scope ?? {}),
      reason: input.reason,
      expectedWorkItemRevision: request.expectedWorkItemRevision ?? preflight.workItem.revision,
      expectedProjectStoreRevision: request.expectedProjectStoreRevision ?? preflight.project.revision,
      expectedDigitalWorkerStoreRevision: request.expectedDigitalWorkerStoreRevision ?? preflight.workers.revision,
      phase: 'prepared',
      createdAt: now,
      updatedAt: now
    }
  }

  private async advance(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    recovering: boolean
  ): Promise<AssignmentOwnerCommitReceipt> {
    try {
      if (entry.phase === 'compensation_pending') return await this.finishCompensation(session, entry)
      let assignment = await this.workerStore.getAssignment(entry.assignmentId)
      if (assignment && !assignmentMatches(assignment, entry)) {
        throw new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', `Assignment id collision: ${entry.assignmentId}`)
      }
      const currentItem = await this.projectStore.getWorkItem(entry.workItemId)
      if (!currentItem) notFound(`WorkItem not found during coordination: ${entry.workItemId}`)
      if (assignment?.status === 'active' && ownerMatches(currentItem, entry)) {
        return this.commit(session, entry, assignment, currentItem)
      }
      if (assignment?.status === 'released') {
        throw new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', `Assignment was released before owner commit: ${assignment.id}`)
      }
      if (!assignment) {
        assignment = await this.workerStore.createAssignment(
          assignmentInput(entry),
          { expectedStoreRevision: entry.expectedDigitalWorkerStoreRevision }
        )
        await this.checkpoint('after_assignment_write', entry)
      }
      if (entry.phase === 'prepared') {
        markPhase(entry, 'assignment_written')
        entry.assignmentRevision = assignment.revision
        session.appendAudit(entry, 'coordinator.assignment_written', {
          assignmentRevision: assignment.revision,
          recovered: recovering
        })
        session.persist()
      }
      const refreshedItem = await this.projectStore.getWorkItem(entry.workItemId)
      if (!refreshedItem) notFound(`WorkItem not found during owner write: ${entry.workItemId}`)
      const workItem = ownerMatches(refreshedItem, entry)
        ? refreshedItem
        : await this.projectCommands.updateWorkItem(
          entry.workItemId,
          { owner: desiredOwner(entry) },
          {
            expectedRevision: entry.expectedWorkItemRevision,
            expectedStoreRevision: entry.expectedProjectStoreRevision
          }
        )
      await this.checkpoint('after_owner_write', entry)
      markPhase(entry, 'owner_written')
      entry.ownerRevision = workItem.revision
      session.appendAudit(entry, 'coordinator.owner_written', {
        ownerRevision: workItem.revision,
        recovered: recovering
      })
      session.persist()
      return this.commit(session, entry, assignment, workItem)
    } catch (error) {
      if (error instanceof AssignmentOwnerCrashSimulationError) throw error
      return this.resolveFailure(session, entry, error)
    }
  }

  private async resolveFailure(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    error: unknown
  ): Promise<AssignmentOwnerCommitReceipt> {
    const [assignment, workItem] = await Promise.all([
      this.workerStore.getAssignment(entry.assignmentId),
      this.projectStore.getWorkItem(entry.workItemId)
    ])
    if (assignment && assignmentMatches(assignment, entry) && assignment.status === 'active' &&
        workItem && ownerMatches(workItem, entry)) {
      return this.commit(session, entry, assignment, workItem)
    }
    if (!assignment) {
      markPhase(entry, 'failed', errorText(error))
      session.appendAudit(entry, 'coordinator.failed', { error: errorText(error) })
      session.persist()
      throw mapCoordinatorError(error)
    }
    if (!assignmentMatches(assignment, entry)) {
      markPhase(entry, 'failed', errorText(error))
      session.appendAudit(entry, 'coordinator.failed', { error: errorText(error), assignmentMismatch: true })
      session.persist()
      throw new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', `Assignment id collision: ${entry.assignmentId}`)
    }
    return this.compensate(session, entry, assignment, error)
  }

  private async compensate(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    assignment: DigitalWorkerAssignment,
    cause: unknown
  ): Promise<never> {
    markPhase(entry, 'compensation_pending', errorText(cause))
    session.appendAudit(entry, 'coordinator.compensation_pending', { error: errorText(cause) })
    session.persist()
    await this.checkpoint('before_compensation', entry)
    await this.releaseForCompensation(assignment, entry)
    markPhase(entry, 'compensated', errorText(cause))
    session.appendAudit(entry, 'coordinator.compensated', { error: errorText(cause) })
    session.persist()
    throw new AssignmentOwnerCoordinatorError(
      'COMPENSATED',
      `Assignment ${entry.assignmentId} was released after owner coordination failed`,
      { requestId: entry.requestId, journalId: entry.id, cause: errorText(cause) }
    )
  }

  private async finishCompensation(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry
  ): Promise<never> {
    const assignment = await this.workerStore.getAssignment(entry.assignmentId)
    if (assignment?.status === 'active') await this.releaseForCompensation(assignment, entry)
    markPhase(entry, 'compensated', entry.lastError)
    session.appendAudit(entry, 'coordinator.compensated', { recovery: true, error: entry.lastError ?? '' })
    session.persist()
    throw new AssignmentOwnerCoordinatorError('COMPENSATED', `Recovered compensation for request ${entry.requestId}`)
  }

  private async releaseForCompensation(
    assignment: DigitalWorkerAssignment,
    entry: AssignmentOwnerJournalEntry
  ): Promise<void> {
    try {
      await this.workerStore.releaseAssignment(
        assignment.id,
        { expectedRevision: assignment.revision },
        { reason: `assignment-owner coordinator compensation (${entry.requestId})` }
      )
    } catch (error) {
      entry.lastError = errorText(error)
      throw new AssignmentOwnerCoordinatorError(
        'RECOVERY_PENDING',
        `Assignment compensation remains pending: ${entry.assignmentId}`,
        { cause: errorText(error) }
      )
    }
  }

  private commit(
    session: AssignmentOwnerJournalSession,
    entry: AssignmentOwnerJournalEntry,
    assignment: DigitalWorkerAssignment,
    workItem: WorkItem
  ): AssignmentOwnerCommitReceipt {
    const receipt: AssignmentOwnerCommitReceipt = {
      operation: 'assign',
      requestId: entry.requestId,
      journalId: entry.id,
      assignmentId: assignment.id,
      workItemId: workItem.id,
      assignment: clone(assignment),
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

  private async checkpoint(point: AssignmentOwnerCrashPoint, entry: AssignmentOwnerJournalEntry): Promise<void> {
    if (!this.options.faultInjector) return
    try {
      await this.options.faultInjector(point, clone(entry))
    } catch (error) {
      throw new AssignmentOwnerCrashSimulationError(point, error)
    }
  }
}

function assignmentInput(entry: AssignmentOwnerJournalEntry) {
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

function resultFromReceipt(
  receipt: AssignmentOwnerCommitReceipt,
  idempotentReplay: boolean,
  recovered: boolean
): AssignmentOwnerCoordinateResult {
  return { ...clone(receipt), idempotentReplay, recovered }
}

function recoveryResult(
  entry: AssignmentOwnerJournalEntry,
  recovered: boolean,
  error?: string
): AssignmentOwnerRecoveryResult {
  return {
    operation: entry.operation,
    requestId: entry.requestId,
    journalId: entry.id,
    phase: entry.phase,
    assignmentId: entry.assignmentId,
    ...(entry.previousAssignmentId === undefined ? {} : { previousAssignmentId: entry.previousAssignmentId }),
    workItemId: entry.workItemId,
    recovered,
    ...(error === undefined ? {} : { error })
  }
}

function isTerminal(entry: AssignmentOwnerJournalEntry): boolean {
  return entry.phase === 'committed' || entry.phase === 'compensated' || entry.phase === 'failed'
}

function terminalEntryError(entry: AssignmentOwnerJournalEntry): AssignmentOwnerCoordinatorError {
  return new AssignmentOwnerCoordinatorError(
    entry.phase === 'compensated' ? 'COMPENSATED' : 'REQUEST_CONFLICT',
    `request ${entry.requestId} is terminal in phase ${entry.phase}`,
    { lastError: entry.lastError ?? '' }
  )
}

function assertRevision(actual: number, expected: number, label: string, allowZero = false): void {
  const valid = Number.isSafeInteger(expected) && (allowZero ? expected >= 0 : expected >= 1)
  if (!valid || actual !== expected) {
    throw new AssignmentOwnerCoordinatorError(
      'REVISION_CONFLICT',
      `${label} is at revision ${actual}, expected ${expected}`,
      { actualRevision: actual, expectedRevision: expected }
    )
  }
}

function notFound(message: string): never {
  throw new AssignmentOwnerCoordinatorError('NOT_FOUND', message)
}

function validateWorker(
  worker: DigitalWorker | undefined,
  projectId: string,
  workerId: string
): asserts worker is DigitalWorker {
  if (!worker) notFound(`DigitalWorker not found: ${workerId}`)
  if (worker.projectId !== projectId) {
    throw new AssignmentOwnerCoordinatorError(
      'PROJECT_SCOPE_CONFLICT',
      `DigitalWorker ${workerId} does not belong to Project ${projectId}`
    )
  }
  if (worker.status !== 'active') {
    throw new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', `DigitalWorker is not active: ${worker.id}`)
  }
}

function resolveCreateWorkItem(
  project: ProjectWorkspaceState,
  input: AssignmentOwnerCreateRequest['input']
): WorkItem {
  const workspace = project.workspaces.find((candidate) => candidate.id === input.projectId)
  if (!workspace) notFound(`ProjectWorkspace not found: ${input.projectId}`)
  if (workspace.status !== 'active') {
    throw new AssignmentOwnerCoordinatorError('PROJECT_SCOPE_CONFLICT', `ProjectWorkspace is not active: ${input.projectId}`)
  }
  const workItem = project.workItems.find((candidate) => candidate.id === input.workItemId)
  if (!workItem) notFound(`WorkItem not found: ${input.workItemId}`)
  if (workItem.projectId !== input.projectId) {
    throw new AssignmentOwnerCoordinatorError(
      'PROJECT_SCOPE_CONFLICT',
      `WorkItem ${input.workItemId} does not belong to Project ${input.projectId}`
    )
  }
  if (workItem.status === 'done' || workItem.status === 'cancelled') {
    throw new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', `WorkItem is terminal: ${workItem.id}`)
  }
  return workItem
}

function assertCreateRevisions(
  request: AssignmentOwnerCreateRequest,
  project: ProjectWorkspaceState,
  workers: DigitalWorkerStoreDocument,
  workItem: WorkItem
): void {
  if (request.expectedWorkItemRevision !== undefined) {
    assertRevision(workItem.revision, request.expectedWorkItemRevision, `WorkItem ${workItem.id}`)
  }
  if (request.expectedProjectStoreRevision !== undefined) {
    assertRevision(project.revision, request.expectedProjectStoreRevision, 'ProjectWorkspace store', true)
  }
  if (request.expectedDigitalWorkerStoreRevision !== undefined) {
    assertRevision(workers.revision, request.expectedDigitalWorkerStoreRevision, 'DigitalWorker store', true)
  }
}

function resolveCreateWorker(
  workers: DigitalWorkerStoreDocument,
  input: AssignmentOwnerCreateRequest['input']
): DigitalWorker | undefined {
  if (input.assigneeKind !== 'digital_worker') return undefined
  const worker = workers.workers.find((candidate) => candidate.id === input.assigneeId)
  validateWorker(worker, input.projectId, input.assigneeId)
  const policyError = digitalWorkerPolicyContractError(worker)
  if (policyError) {
    throw new AssignmentOwnerCoordinatorError(
      'INVARIANT_VIOLATION',
      `DigitalWorker ${worker.id} action policy is invalid: ${policyError}`,
      { workerId: worker.id, policy: 'actionPolicy' }
    )
  }
  return worker
}

function assertCreateAssignmentAvailable(
  workers: DigitalWorkerStoreDocument,
  workItem: WorkItem,
  input: AssignmentOwnerCreateRequest['input']
): void {
  const active = workers.assignments.find(
    (assignment) => assignment.projectId === input.projectId &&
      assignment.workItemId === input.workItemId && assignment.status === 'active'
  )
  if (active) {
    throw new AssignmentOwnerCoordinatorError(
      'INVARIANT_VIOLATION',
      `WorkItem ${input.workItemId} already has an active Assignment`,
      { assignmentId: active.id }
    )
  }
  if (workItem.owner && (
    workItem.owner.type !== input.assigneeKind || workItem.owner.id !== input.assigneeId
  )) {
    throw new AssignmentOwnerCoordinatorError(
      'INVARIANT_VIOLATION',
      `WorkItem ${input.workItemId} already has a different owner`
    )
  }
}

function mapCoordinatorError(error: unknown): AssignmentOwnerCoordinatorError {
  if (error instanceof AssignmentOwnerCoordinatorError) return error
  const code = readErrorCode(error)
  if (/REVISION|stale_revision/i.test(code) || /revision/i.test(errorText(error))) {
    return new AssignmentOwnerCoordinatorError('REVISION_CONFLICT', errorText(error))
  }
  if (/PROJECT_SCOPE|cross_project/i.test(code)) {
    return new AssignmentOwnerCoordinatorError('PROJECT_SCOPE_CONFLICT', errorText(error))
  }
  return new AssignmentOwnerCoordinatorError('INVARIANT_VIOLATION', errorText(error))
}
