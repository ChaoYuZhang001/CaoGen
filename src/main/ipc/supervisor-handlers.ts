import { app, ipcMain } from 'electron'
import type {
  SupervisorApprovalInput,
  SupervisorLeaseOptions,
  SupervisorMutationOptions,
  SupervisorRunInput,
  SupervisorRunStatus
} from '../../shared/supervisor-types'
import { sessionManager } from '../sessionManager'
import { SupervisorStateStore } from '../task/supervisor-state'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

type SupervisorHandler = (store: SupervisorStateStore, payload: Record<string, unknown>) => unknown

const STATUSES = new Set<SupervisorRunStatus>([
  'queued', 'running', 'waiting_approval', 'waiting_reconciliation',
  'paused', 'blocked', 'failed', 'completed', 'cancelled'
])

const HANDLERS: Record<string, SupervisorHandler> = {
  list: (store, payload) => {
    assertAllowedKeys(payload, ['options'], 'Supervisor list request')
    return store.listRuns(normalizeListOptions(payload.options))
  },
  get: (store, payload) => {
    assertAllowedKeys(payload, ['id'], 'Supervisor get request')
    return store.getRun(requiredId(payload.id, 'run id'))
  },
  events: (store, payload) => {
    assertAllowedKeys(payload, ['runId'], 'Supervisor events request')
    return store.listEvents(optionalId(payload.runId, 'run id'))
  },
  create: (store, payload) => {
    assertAllowedKeys(payload, ['input', 'options'], 'Supervisor create request')
    return store.createRun(normalizeRunInput(payload.input), normalizeMutationOptions(payload.options))
  },
  'lease:acquire': leaseAction((store, id, options) => store.acquireLease(id, options)),
  'lease:heartbeat': leaseAction((store, id, options) => store.heartbeatLease(id, options)),
  'lease:release': leaseAction((store, id, options) => store.releaseLease(id, options)),
  start: leaseAction((store, id, options) => store.startRun(id, options)),
  pause: controlledLeaseAction('pause', (store, id, options) => store.pauseRun(id, options)),
  resume: controlledLeaseAction('resume', (store, id, options) => store.resumeRun(id, options)),
  block: leaseAction((store, id, options) => store.markBlocked(id, options)),
  reconcile: leaseAction((store, id, options) => store.markWaitingReconciliation(id, options)),
  complete: leaseAction((store, id, options) => store.completeRun(id, options)),
  fail: (store, payload) => {
    assertAllowedKeys(payload, ['id', 'error', 'options'], 'Supervisor fail request')
    return store.failRun(
      requiredId(payload.id, 'run id'),
      requiredText(payload.error, 'run error', 4_000),
      normalizeLeaseOptions(payload.options)
    )
  },
  cancel: controlledMutationAction('cancel', (store, id, options) => store.cancelRun(id, options)),
  retry: controlledMutationAction('retry', (store, id, options) => store.authorizeRetry(id, options)),
  'approval:request': (store, payload) => {
    assertAllowedKeys(payload, ['id', 'approval', 'options'], 'Supervisor approval request')
    const approval = requiredRecord(payload.approval, 'approval')
    assertAllowedKeys(approval, ['id', 'reason'], 'approval')
    return store.requestApproval(
      requiredId(payload.id, 'run id'),
      {
        id: requiredId(approval.id, 'approval id'),
        ...(approval.reason === undefined ? {} : { reason: requiredText(approval.reason, 'approval reason', 4_000) })
      },
      normalizeLeaseOptions(payload.options)
    )
  },
  'approval:resolve': (store, payload) => {
    assertAllowedKeys(payload, ['id', 'input'], 'Supervisor approval resolution')
    return store.resolveApproval(
      requiredId(payload.id, 'run id'),
      normalizeApprovalInput(payload.input)
    )
  },
  'lease:reassign': async (store, payload) => {
    assertAllowedKeys(payload, ['id', 'ownerId', 'options'], 'Supervisor lease reassign request')
    const id = requiredId(payload.id, 'run id')
    const newOwnerId = requiredId(payload.ownerId, 'new ownerId')
    const options = normalizeControlLeaseOptions(payload.options)
    const controlled = await sessionManager.controlSupervisorRun(store, {
      action: 'reassign', runId: id, newOwnerId, options
    })
    return controlled?.supervisorRun ?? store.reassignLease(id, newOwnerId, options)
  },
  recover: (store, payload) => {
    assertAllowedKeys(payload, [], 'Supervisor recovery request')
    return store.recoverExpiredLeases()
  }
}

let singleton: SupervisorStateStore | undefined

export function registerSupervisorIpc(): void {
  ipcMain.handle('supervisor:invoke', (event, rawRequest: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const request = requiredRecord(rawRequest, 'Supervisor request')
    assertAllowedKeys(request, ['action', 'payload'], 'Supervisor request')
    const action = requiredId(request.action, 'Supervisor action')
    const handler = HANDLERS[action]
    if (!handler) throw new Error(`Supervisor action is not supported: ${action}`)
    const payload = request.payload === undefined ? {} : requiredRecord(request.payload, 'Supervisor payload')
    return handler(supervisorStore(), payload)
  })
}

function supervisorStore(): SupervisorStateStore {
  return singleton ??= new SupervisorStateStore(app.getPath('userData'))
}

function leaseAction(
  action: (store: SupervisorStateStore, id: string, options: SupervisorLeaseOptions) => unknown
): SupervisorHandler {
  return (store, payload) => {
    assertAllowedKeys(payload, ['id', 'options'], 'Supervisor lease action')
    return action(store, requiredId(payload.id, 'run id'), normalizeLeaseOptions(payload.options))
  }
}

function controlledLeaseAction(
  action: 'pause' | 'resume',
  fallback: (store: SupervisorStateStore, id: string, options: SupervisorLeaseOptions) => unknown
): SupervisorHandler {
  return async (store, payload) => {
    assertAllowedKeys(payload, ['id', 'options'], 'Supervisor lease action')
    const id = requiredId(payload.id, 'run id')
    const options = normalizeControlLeaseOptions(payload.options)
    const controlled = await sessionManager.controlSupervisorRun(store, { action, runId: id, options })
    return controlled?.supervisorRun ?? fallback(store, id, options)
  }
}

function controlledMutationAction(
  action: 'cancel' | 'retry',
  fallback: (store: SupervisorStateStore, id: string, options: SupervisorMutationOptions) => unknown
): SupervisorHandler {
  return async (store, payload) => {
    assertAllowedKeys(payload, ['id', 'options'], 'Supervisor mutation')
    const id = requiredId(payload.id, 'run id')
    const options = normalizeControlMutationOptions(payload.options)
    const controlled = await sessionManager.controlSupervisorRun(store, { action, runId: id, options })
    return controlled?.supervisorRun ?? fallback(store, id, options)
  }
}

function normalizeRunInput(value: unknown): SupervisorRunInput {
  const input = requiredRecord(value, 'Supervisor run input')
  assertAllowedKeys(input, ['id', 'projectId', 'goalId', 'workItemId', 'maxRetries', 'createdAt'], 'Supervisor run input')
  return {
    ...(input.id === undefined ? {} : { id: requiredId(input.id, 'run id') }),
    projectId: requiredId(input.projectId, 'projectId'),
    ...(input.goalId === undefined ? {} : { goalId: requiredId(input.goalId, 'goalId') }),
    workItemId: requiredId(input.workItemId, 'workItemId'),
    ...(input.maxRetries === undefined ? {} : { maxRetries: boundedInteger(input.maxRetries, 'maxRetries', 0, 100) }),
    ...(input.createdAt === undefined ? {} : { createdAt: nonNegativeNumber(input.createdAt, 'createdAt') })
  }
}

function normalizeMutationOptions(value: unknown): SupervisorMutationOptions {
  if (value === undefined || value === null) return { actorId: 'renderer-user' }
  const options = requiredRecord(value, 'Supervisor mutation options')
  assertAllowedKeys(options, ['expectedRevision', 'expectedStoreRevision'], 'Supervisor mutation options')
  return {
    ...(options.expectedRevision === undefined ? {} : { expectedRevision: nonNegativeInteger(options.expectedRevision, 'expectedRevision') }),
    ...(options.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: nonNegativeInteger(options.expectedStoreRevision, 'expectedStoreRevision') }),
    actorId: 'renderer-user'
  }
}

function normalizeControlMutationOptions(value: unknown): SupervisorMutationOptions {
  const options = normalizeMutationOptions(value)
  if (options.expectedRevision === undefined) {
    throw new Error('Supervisor control requires expectedRevision')
  }
  return options
}

function normalizeLeaseOptions(value: unknown): SupervisorLeaseOptions {
  const options = requiredRecord(value, 'Supervisor lease options')
  assertAllowedKeys(
    options,
    ['expectedRevision', 'expectedStoreRevision', 'ownerId', 'leaseId', 'fencingToken', 'ttlMs'],
    'Supervisor lease options'
  )
  const ownerId = requiredId(options.ownerId, 'lease ownerId')
  return {
    ...normalizeMutationOptions({
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      ...(options.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: options.expectedStoreRevision })
    }),
    actorId: ownerId,
    ownerId,
    ...(options.leaseId === undefined ? {} : { leaseId: requiredId(options.leaseId, 'lease id') }),
    ...(options.fencingToken === undefined ? {} : { fencingToken: positiveInteger(options.fencingToken, 'fencingToken') }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: positiveNumber(options.ttlMs, 'ttlMs') })
  }
}

function normalizeControlLeaseOptions(value: unknown): SupervisorLeaseOptions {
  const options = normalizeLeaseOptions(value)
  if (options.expectedRevision === undefined) {
    throw new Error('Supervisor control requires expectedRevision')
  }
  if (!options.leaseId || options.fencingToken === undefined) {
    throw new Error('Supervisor control requires leaseId and fencingToken')
  }
  return options
}

function normalizeApprovalInput(value: unknown): SupervisorApprovalInput {
  const input = requiredRecord(value, 'Supervisor approval input')
  assertAllowedKeys(input, ['approvalId', 'approved', 'reason', 'expectedRevision', 'expectedStoreRevision'], 'Supervisor approval input')
  if (typeof input.approved !== 'boolean') throw new Error('approved must be boolean')
  return {
    ...normalizeMutationOptions({
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: input.expectedStoreRevision })
    }),
    approvalId: requiredId(input.approvalId, 'approval id'),
    approved: input.approved,
    ...(input.reason === undefined ? {} : { reason: requiredText(input.reason, 'approval reason', 4_000) })
  }
}

function normalizeListOptions(value: unknown): { projectId?: string; status?: SupervisorRunStatus } {
  if (value === undefined || value === null) return {}
  const options = requiredRecord(value, 'Supervisor list options')
  assertAllowedKeys(options, ['projectId', 'status'], 'Supervisor list options')
  if (options.status !== undefined && (typeof options.status !== 'string' || !STATUSES.has(options.status as SupervisorRunStatus))) {
    throw new Error('Supervisor status is invalid')
  }
  return {
    ...(options.projectId === undefined ? {} : { projectId: requiredId(options.projectId, 'projectId') }),
    ...(options.status === undefined ? {} : { status: options.status as SupervisorRunStatus })
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown field: ${key}`)
}

function requiredId(value: unknown, label: string): string {
  return requiredText(value, label, 256)
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredId(value, label)
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) {
    throw new Error(`${label} has an invalid format`)
  }
  return normalized
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`)
  return value as number
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`)
  return value
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`)
  return value
}
