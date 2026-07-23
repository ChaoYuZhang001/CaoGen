import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import type {
  SupervisorLeaseOptions,
  SupervisorMutationOptions,
  SupervisorRunRecord,
  SupervisorStateDocument
} from '../../shared/supervisor-types'
import { ensureSupervisorRunBinding } from './supervisor-taskrun-bridge'
import {
  SupervisorStateError,
  SupervisorStateStore
} from './supervisor-state'

export type SupervisorSessionControlRequest =
  | { action: 'pause'; runId: string; options: SupervisorLeaseOptions }
  | { action: 'resume'; runId: string; options: SupervisorLeaseOptions }
  | { action: 'cancel'; runId: string; options: SupervisorMutationOptions }
  | { action: 'retry'; runId: string; options: SupervisorMutationOptions }
  | {
      action: 'reassign'
      runId: string
      newOwnerId: string
      options: SupervisorLeaseOptions
    }

export type SupervisorSessionControlEffect =
  | 'cooperative_interrupt'
  | 'replay_dispatched'
  | 'retry_prepared'
  | 'lease_reassigned'

export interface SupervisorSessionControlBinding {
  session: { meta: SessionMeta }
  taskRun: TaskRunRecord
}

export interface SupervisorSessionControlResult {
  supervisorRun: SupervisorRunRecord
  sessionId: string
  taskRunId: string
  effect: SupervisorSessionControlEffect
}

export interface SupervisorSessionControlRuntime {
  /** Null means this is a legacy coordination-only Supervisor row. */
  resolve(runId: string): Promise<SupervisorSessionControlBinding | null>
  preflight?(
    request: SupervisorSessionControlRequest,
    binding: SupervisorSessionControlBinding
  ): Promise<void> | void
  pause(binding: SupervisorSessionControlBinding): Promise<void>
  cancel(binding: SupervisorSessionControlBinding): Promise<void>
  resume(binding: SupervisorSessionControlBinding): Promise<void>
  prepareRetry(binding: SupervisorSessionControlBinding): Promise<void>
  reassign(binding: SupervisorSessionControlBinding, newOwnerId: string): Promise<void> | void
  committed?(
    request: SupervisorSessionControlRequest,
    binding: SupervisorSessionControlBinding,
    supervisorRun: SupervisorRunRecord
  ): Promise<void> | void
  completed?(
    request: SupervisorSessionControlRequest,
    binding: SupervisorSessionControlBinding,
    supervisorRun: SupervisorRunRecord
  ): Promise<void> | void
  failed?(
    request: SupervisorSessionControlRequest,
    binding: SupervisorSessionControlBinding,
    supervisorRun: SupervisorRunRecord,
    error: unknown
  ): Promise<void> | void
}

/**
 * Apply a renderer-requested Supervisor action to its canonical active
 * TaskRun/session. Returning null is reserved for old coordination-only rows
 * that have no TaskRun anywhere.
 */
export async function executeSupervisorSessionControl(
  store: SupervisorStateStore,
  rootDir: string,
  request: SupervisorSessionControlRequest,
  runtime: SupervisorSessionControlRuntime
): Promise<SupervisorSessionControlResult | null> {
  const document = await store.read()
  const supervisor = findSupervisorRun(document, request.runId)
  assertExpectedRevisions(document, supervisor, request.options)

  const binding = await runtime.resolve(supervisor.id)
  if (!binding) return null
  assertCanonicalIdentity(supervisor, binding)
  assertControlPreconditions(supervisor, binding, request)
  await runtime.preflight?.(request, binding)
  await ensureSupervisorRunBinding(binding.session.meta, binding.taskRun, { rootDir, store })

  let supervisorRun: SupervisorRunRecord
  let effect: SupervisorSessionControlEffect
  let applyRuntime: () => Promise<void>
  if (request.action === 'pause') {
    supervisorRun = await store.pauseRun(supervisor.id, request.options)
    effect = 'cooperative_interrupt'
    applyRuntime = () => runtime.pause(binding)
  } else if (request.action === 'cancel') {
    supervisorRun = await store.cancelRun(supervisor.id, request.options)
    effect = 'cooperative_interrupt'
    applyRuntime = () => runtime.cancel(binding)
  } else if (request.action === 'resume') {
    supervisorRun = await store.resumeRun(supervisor.id, request.options)
    effect = 'replay_dispatched'
    applyRuntime = () => runtime.resume(binding)
  } else if (request.action === 'retry') {
    supervisorRun = await store.authorizeRetry(supervisor.id, request.options)
    effect = 'retry_prepared'
    applyRuntime = () => runtime.prepareRetry(binding)
  } else {
    supervisorRun = await store.reassignLease(supervisor.id, request.newOwnerId, request.options)
    effect = 'lease_reassigned'
    applyRuntime = async () => runtime.reassign(binding, request.newOwnerId)
  }
  await runtime.committed?.(request, binding, supervisorRun)
  try {
    await applyRuntime()
  } catch (error) {
    if (request.action === 'resume') {
      try {
        supervisorRun = await store.markBlocked(supervisor.id, {
          ...request.options,
          expectedRevision: supervisorRun.revision
        })
      } catch {
        // The SessionManager failure hook still closes the send gate if a
        // concurrent heartbeat prevents the best-effort blocked transition.
      }
    }
    await runtime.failed?.(request, binding, supervisorRun, error)
    throw error
  }
  await runtime.completed?.(request, binding, supervisorRun)
  return {
    supervisorRun,
    sessionId: binding.taskRun.sessionId,
    taskRunId: binding.taskRun.id,
    effect
  }
}

function findSupervisorRun(document: SupervisorStateDocument, runId: string): SupervisorRunRecord {
  const run = document.runs.find((candidate) => candidate.id === runId)
  if (!run) throw new SupervisorStateError('not_found', `run ${runId} was not found`)
  return run
}

function assertExpectedRevisions(
  document: SupervisorStateDocument,
  run: SupervisorRunRecord,
  options: SupervisorMutationOptions
): void {
  if (options.expectedRevision === undefined) {
    throw new SupervisorStateError(
      'invalid_input',
      `run ${run.id} control requires expectedRevision`
    )
  }
  if (options.expectedRevision !== run.revision) {
    throw new SupervisorStateError(
      'stale_revision',
      `run ${run.id} revision is ${run.revision}, expected ${options.expectedRevision}`
    )
  }
  if (options.expectedStoreRevision !== undefined && options.expectedStoreRevision !== document.revision) {
    throw new SupervisorStateError(
      'stale_store_revision',
      `store revision is ${document.revision}, expected ${options.expectedStoreRevision}`
    )
  }
}

function assertCanonicalIdentity(
  supervisor: SupervisorRunRecord,
  binding: SupervisorSessionControlBinding
): void {
  const { meta } = binding.session
  const taskRun = binding.taskRun
  if (taskRun.id !== supervisor.id) identityConflict(supervisor.id, 'TaskRun id')
  if (taskRun.sessionId !== meta.id) identityConflict(supervisor.id, 'session ownership')
  if (meta.workspaceId !== supervisor.projectId) identityConflict(supervisor.id, 'Workspace ownership')
  if (meta.goalId !== supervisor.goalId) identityConflict(supervisor.id, 'Goal ownership')
  if (meta.workItemId !== supervisor.workItemId) identityConflict(supervisor.id, 'WorkItem ownership')
}

function assertControlPreconditions(
  supervisor: SupervisorRunRecord,
  binding: SupervisorSessionControlBinding,
  request: SupervisorSessionControlRequest
): void {
  const taskRun = binding.taskRun
  const sessionStatus = binding.session.meta.status
  assertSessionOpen(supervisor.id, sessionStatus)
  assertResolvedOutcome(supervisor.id, taskRun, request.action)

  switch (request.action) {
    case 'pause':
      assertPausePreconditions(supervisor, taskRun, request.options)
      return
    case 'cancel':
      assertCancelPreconditions(supervisor, taskRun)
      return
    case 'resume':
      assertResumePreconditions(supervisor, taskRun, sessionStatus, request.options)
      return
    case 'retry':
      assertRetryPreconditions(supervisor, taskRun, sessionStatus)
      return
    case 'reassign':
      assertReassignPreconditions(supervisor, taskRun, request.options)
  }
}

function assertSessionOpen(supervisorId: string, sessionStatus: SessionMeta['status']): void {
  if (sessionStatus === 'closed') {
    throw new SupervisorStateError('invalid_transition', `run ${supervisorId} session is closed`)
  }
}

function assertResolvedOutcome(
  supervisorId: string,
  taskRun: TaskRunRecord,
  action: SupervisorSessionControlRequest['action']
): void {
  if (action !== 'reassign' && hasUnresolvedOutcome(taskRun)) {
    throw new SupervisorStateError(
      'invalid_transition',
      `run ${supervisorId} has unresolved Effect or tool outcomes; reconcile before control`
    )
  }
}

function assertPausePreconditions(
  supervisor: SupervisorRunRecord,
  taskRun: TaskRunRecord,
  options: SupervisorLeaseOptions
): void {
  if (supervisor.status !== 'running' && supervisor.status !== 'waiting_approval') {
    invalidStatus(supervisor, 'pause')
  }
  assertTaskRunNonTerminal(taskRun, 'pause')
  assertLease(supervisor, options)
}

function assertCancelPreconditions(supervisor: SupervisorRunRecord, taskRun: TaskRunRecord): void {
  if (supervisor.status === 'failed' || supervisor.status === 'completed' || supervisor.status === 'cancelled') {
    invalidStatus(supervisor, 'cancel')
  }
  assertTaskRunNonTerminal(taskRun, 'cancel')
}

function assertResumePreconditions(
  supervisor: SupervisorRunRecord,
  taskRun: TaskRunRecord,
  sessionStatus: SessionMeta['status'],
  options: SupervisorLeaseOptions
): void {
  if (supervisor.status !== 'paused' && supervisor.status !== 'queued' && supervisor.status !== 'blocked') {
    invalidStatus(supervisor, 'resume')
  }
  if (sessionStatus === 'running') {
    throw new SupervisorStateError('invalid_transition', `run ${supervisor.id} session is already running`)
  }
  if (taskRun.status !== 'recovering' && taskRun.status !== 'queued') {
    throw new SupervisorStateError(
      'invalid_transition',
      `run ${supervisor.id} TaskRun cannot resume from ${taskRun.status}`
    )
  }
  assertLease(supervisor, options)
}

function assertRetryPreconditions(
  supervisor: SupervisorRunRecord,
  taskRun: TaskRunRecord,
  sessionStatus: SessionMeta['status']
): void {
  if (
    supervisor.status !== 'failed' &&
    supervisor.status !== 'blocked' &&
    supervisor.status !== 'waiting_reconciliation'
  ) {
    invalidStatus(supervisor, 'retry')
  }
  if (sessionStatus === 'running') {
    throw new SupervisorStateError('invalid_transition', `run ${supervisor.id} session is still running`)
  }
  if (taskRun.status !== 'failed' && taskRun.status !== 'waiting_reconciliation') {
    throw new SupervisorStateError(
      'invalid_transition',
      `run ${supervisor.id} TaskRun cannot retry from ${taskRun.status}`
    )
  }
}

function assertReassignPreconditions(
  supervisor: SupervisorRunRecord,
  taskRun: TaskRunRecord,
  options: SupervisorLeaseOptions
): void {
  if (supervisor.status === 'failed' || supervisor.status === 'completed' || supervisor.status === 'cancelled') {
    invalidStatus(supervisor, 'reassign')
  }
  assertTaskRunNonTerminal(taskRun, 'reassign')
  assertLease(supervisor, options)
}

function assertTaskRunNonTerminal(taskRun: TaskRunRecord, action: string): void {
  if (taskRun.status === 'completed' || taskRun.status === 'failed' || taskRun.status === 'cancelled') {
    throw new SupervisorStateError(
      'invalid_transition',
      `run ${taskRun.id} TaskRun is ${taskRun.status}; cannot ${action}`
    )
  }
}

function assertLease(run: SupervisorRunRecord, options: SupervisorLeaseOptions): void {
  const lease = run.lease
  const now = options.now ?? Date.now()
  if (!lease || lease.expiresAt <= now) {
    throw new SupervisorStateError('lease_expired', `run ${run.id} lease is expired`)
  }
  if (lease.ownerId !== options.ownerId) {
    throw new SupervisorStateError('lease_owner', `run ${run.id} lease owner does not match`)
  }
  if (!options.leaseId || options.fencingToken === undefined) {
    throw new SupervisorStateError(
      'invalid_input',
      `run ${run.id} control requires leaseId and fencingToken`
    )
  }
  if (options.leaseId !== lease.id) {
    throw new SupervisorStateError('stale_lease', `run ${run.id} lease id is stale`)
  }
  if (options.fencingToken !== lease.fencingToken) {
    throw new SupervisorStateError('stale_lease', `run ${run.id} fencing token is stale`)
  }
}

function hasUnresolvedOutcome(run: TaskRunRecord): boolean {
  if (run.status === 'waiting_reconciliation') return true
  if ((run.effects ?? []).some((effect) =>
    effect.status === 'prepared' ||
    effect.status === 'executing' ||
    effect.status === 'waiting_reconciliation')) return true
  return (run.toolExecutions ?? []).some((execution) => execution.status === 'unknown_outcome')
}

function identityConflict(runId: string, boundary: string): never {
  throw new SupervisorStateError(
    'invalid_input',
    `run ${runId} canonical ${boundary} does not match the active session`
  )
}

function invalidStatus(run: SupervisorRunRecord, action: string): never {
  throw new SupervisorStateError(
    'invalid_transition',
    `run ${run.id} cannot ${action} from ${run.status}`
  )
}
