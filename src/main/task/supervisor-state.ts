import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  SupervisorApprovalInput,
  SupervisorEvent,
  SupervisorEventKind,
  SupervisorLease,
  SupervisorLeaseOptions,
  SupervisorMutationOptions,
  SupervisorRecoveryResult,
  SupervisorRunInput,
  SupervisorRunRecord,
  SupervisorRunStatus,
  SupervisorStateDocument
} from '../../shared/supervisor-types'
import { SUPERVISOR_SCHEMA_VERSION } from '../../shared/supervisor-types'

const STORE_FILE_NAME = 'supervisor-state.json'
const LOCK_SUFFIX = '.lock'
const LOCK_WAIT_MS = 15
const LOCK_TIMEOUT_MS = 15_000
const LOCK_STALE_MS = 120_000
const DEFAULT_TTL_MS = 30_000
const MAX_TTL_MS = 86_400_000
const TERMINAL = new Set<SupervisorRunStatus>(['failed', 'completed', 'cancelled'])

export type SupervisorStateErrorCode =
  | 'invalid_input'
  | 'already_exists'
  | 'not_found'
  | 'corrupt_store'
  | 'unsupported_schema'
  | 'stale_revision'
  | 'stale_store_revision'
  | 'invalid_transition'
  | 'lease_conflict'
  | 'lease_required'
  | 'lease_expired'
  | 'stale_lease'
  | 'lease_owner'
  | 'approval_required'
  | 'retry_limit'
  | 'lock_timeout'

export class SupervisorStateError extends Error {
  constructor(
    readonly code: SupervisorStateErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}: ${message}`)
    this.name = 'SupervisorStateError'
  }
}

export interface SupervisorStateStoreOptions {
  now?: () => number
}

type Mutation<T> = (document: SupervisorStateDocument, now: number) => T

/**
 * Durable local Supervisor state. The store deliberately owns only run
 * coordination metadata; TaskRun/Effect ledgers remain the source of truth
 * for model turns and external side effects.
 */
export class SupervisorStateStore {
  readonly filePath: string
  private readonly lockPath: string
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(rootDir: string, options: SupervisorStateStoreOptions = {}) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new SupervisorStateError('invalid_input', 'rootDir is required')
    }
    this.filePath = join(rootDir, STORE_FILE_NAME)
    this.lockPath = `${this.filePath}${LOCK_SUFFIX}`
    this.now = options.now ?? (() => Date.now())
  }

  async read(): Promise<SupervisorStateDocument> {
    return cloneDocument(await readDocument(this.filePath))
  }

  async getRun(id: string): Promise<SupervisorRunRecord | undefined> {
    const normalized = requiredId(id, 'run id')
    const document = await readDocument(this.filePath)
    const run = document.runs.find((candidate) => candidate.id === normalized)
    return run ? clone(run) : undefined
  }

  async listRuns(options: { projectId?: string; status?: SupervisorRunStatus } = {}): Promise<SupervisorRunRecord[]> {
    if (options.projectId !== undefined) requiredId(options.projectId, 'projectId')
    if (options.status !== undefined && !isStatus(options.status)) {
      throw new SupervisorStateError('invalid_input', `unknown Supervisor status ${String(options.status)}`)
    }
    const document = await readDocument(this.filePath)
    return document.runs
      .filter((run) => options.projectId === undefined || run.projectId === options.projectId)
      .filter((run) => options.status === undefined || run.status === options.status)
      .map(clone)
  }

  async listEvents(runId?: string): Promise<SupervisorEvent[]> {
    const normalized = runId === undefined ? undefined : requiredId(runId, 'run id')
    const document = await readDocument(this.filePath)
    return document.events
      .filter((event) => normalized === undefined || event.runId === normalized)
      .map(clone)
  }

  async createRun(input: SupervisorRunInput, options: SupervisorMutationOptions = {}): Promise<SupervisorRunRecord> {
    const projectId = requiredId(input.projectId, 'projectId')
    const workItemId = requiredId(input.workItemId, 'workItemId')
    const id = input.id === undefined ? randomUUID() : requiredId(input.id, 'run id')
    const maxRetries = normalizeMaxRetries(input.maxRetries)
    return this.mutate(options, (document, now) => {
      assertStoreRevision(document, options)
      if (document.runs.some((run) => run.id === id)) {
        throw new SupervisorStateError('already_exists', `run ${id} already exists`)
      }
      const createdAt = normalizeTimestamp(input.createdAt, now, 'createdAt')
      const run: SupervisorRunRecord = {
        schemaVersion: SUPERVISOR_SCHEMA_VERSION,
        id,
        projectId,
        ...(input.goalId === undefined ? {} : { goalId: requiredId(input.goalId, 'goalId') }),
        workItemId,
        status: 'queued',
        revision: 1,
        fencingToken: 0,
        retryCount: 0,
        maxRetries,
        createdAt,
        updatedAt: createdAt
      }
      document.runs.push(run)
      appendEvent(document, run, 'run.created', options.actorId ?? 'system', createdAt, {
        projectId,
        workItemId,
        maxRetries
      })
      return clone(run)
    })
  }

  async acquireLease(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    const ownerId = requiredId(options.ownerId, 'lease ownerId')
    const ttlMs = normalizeTtl(options.ttlMs)
    return this.mutate(options, (document, now) => {
      const run = findRun(document, id)
      assertExpectedRevision(run, options)
      assertNotTerminal(run)
      const current = run.lease
      if (current && current.expiresAt > now) {
        if (current.ownerId !== ownerId || (options.leaseId !== undefined && current.id !== options.leaseId)) {
          throw new SupervisorStateError('lease_conflict', `run ${id} has an active lease`)
        }
        throw new SupervisorStateError('lease_conflict', `run ${id} lease must be heartbeated, not reacquired`)
      }
      if (options.fencingToken !== undefined && options.fencingToken !== run.fencingToken) {
        throw new SupervisorStateError('stale_lease', `run ${id} fencing token is stale`)
      }
      run.fencingToken += 1
      const lease: SupervisorLease = {
        id: options.leaseId === undefined ? randomUUID() : requiredId(options.leaseId, 'lease id'),
        ownerId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + ttlMs,
        fencingToken: run.fencingToken
      }
      run.lease = lease
      touch(run, now)
      appendEvent(document, run, 'lease.acquired', options.actorId ?? ownerId, now, {
        ownerId,
        takeover: Boolean(current),
        fencingToken: lease.fencingToken
      }, lease.fencingToken)
      return clone(run)
    })
  }

  async heartbeatLease(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    const ttlMs = normalizeTtl(options.ttlMs)
    return this.mutate(options, (document, now) => {
      const run = findRun(document, id)
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      run.lease!.heartbeatAt = now
      run.lease!.expiresAt = now + ttlMs
      touch(run, now)
      appendEvent(document, run, 'lease.heartbeat', options.actorId ?? options.ownerId, now, {
        expiresAt: run.lease!.expiresAt
      }, run.lease!.fencingToken)
      return clone(run)
    })
  }

  async releaseLease(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const id = requiredId(runId, 'run id')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, id)
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      const fencingToken = run.lease?.fencingToken
      const from = run.status
      if (run.status === 'running' || run.status === 'waiting_approval') {
        run.status = 'paused'
        run.approval = undefined
      }
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'lease.released', options.actorId ?? options.ownerId, now, {}, fencingToken, from, run.status)
      return clone(run)
    })
  }

  async startRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'running', options, 'run.started')
  }

  async pauseRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (run.status !== 'running' && run.status !== 'waiting_approval') {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot pause from ${run.status}`)
      }
      const from = run.status
      const fencingToken = run.lease?.fencingToken
      run.status = 'paused'
      run.approval = undefined
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'run.paused', options.actorId ?? options.ownerId, now, {}, fencingToken, from, 'paused')
      return clone(run)
    })
  }

  async resumeRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'running', options, 'run.resumed')
  }

  async requestApproval(
    runId: string,
    approval: { id: string; reason?: string },
    options: SupervisorLeaseOptions
  ): Promise<SupervisorRunRecord> {
    const approvalId = requiredId(approval.id, 'approval id')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (run.status !== 'running') {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot wait for approval from ${run.status}`)
      }
      run.status = 'waiting_approval'
      run.approval = {
        id: approvalId,
        requestedAt: now,
        requestedBy: options.actorId ?? options.ownerId,
        ...(approval.reason === undefined ? {} : { reason: requiredText(approval.reason, 'approval reason') })
      }
      touch(run, now)
      appendEvent(document, run, 'run.waiting_approval', options.actorId ?? options.ownerId, now, {
        approvalId,
        reason: approval.reason
      }, run.lease?.fencingToken)
      return clone(run)
    })
  }

  async resolveApproval(runId: string, input: SupervisorApprovalInput): Promise<SupervisorRunRecord> {
    const approvalId = requiredId(input.approvalId, 'approval id')
    return this.mutate(input, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, input)
      if (run.status !== 'waiting_approval' || run.approval?.id !== approvalId) {
        throw new SupervisorStateError('approval_required', `run ${run.id} has no matching pending approval`)
      }
      const from = run.status
      run.approval = undefined
      if (input.approved) {
        run.status = 'paused'
        run.lease = undefined
      } else {
        run.status = 'failed'
        run.error = input.reason?.trim() || 'approval denied'
        run.lease = undefined
      }
      touch(run, now)
      appendEvent(document, run, 'run.approval_resolved', input.actorId ?? 'user', now, {
        approvalId,
        approved: input.approved,
        reason: input.reason
      }, undefined, from, run.status)
      return clone(run)
    })
  }

  async markBlocked(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'blocked', options, 'run.blocked')
  }

  async markWaitingReconciliation(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.transitionWithLease(runId, 'waiting_reconciliation', options, 'run.waiting_reconciliation')
  }

  async failRun(runId: string, error: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    const message = requiredText(error, 'run error')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (TERMINAL.has(run.status)) throw new SupervisorStateError('invalid_transition', `run ${run.id} is terminal`)
      const from = run.status
      run.status = 'failed'
      run.error = message
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'run.failed', options.actorId ?? options.ownerId, now, { error: message }, undefined, from, 'failed')
      return clone(run)
    })
  }

  async completeRun(runId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (run.status !== 'running') {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot complete from ${run.status}`)
      }
      const from = run.status
      run.status = 'completed'
      run.lease = undefined
      touch(run, now)
      appendEvent(document, run, 'run.completed', options.actorId ?? options.ownerId, now, {}, undefined, from, 'completed')
      return clone(run)
    })
  }

  async cancelRun(runId: string, options: SupervisorMutationOptions = {}): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertNotTerminal(run)
      const from = run.status
      run.status = 'cancelled'
      run.lease = undefined
      run.approval = undefined
      touch(run, now)
      appendEvent(document, run, 'run.cancelled', options.actorId ?? 'user', now, {}, undefined, from, 'cancelled')
      return clone(run)
    })
  }

  async authorizeRetry(runId: string, options: SupervisorMutationOptions = {}): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      if (!['failed', 'blocked', 'waiting_reconciliation'].includes(run.status)) {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot retry from ${run.status}`)
      }
      if (run.retryCount >= run.maxRetries) {
        throw new SupervisorStateError('retry_limit', `run ${run.id} exhausted ${run.maxRetries} retries`)
      }
      const from = run.status
      run.status = 'queued'
      run.retryCount += 1
      run.error = undefined
      run.lease = undefined
      run.approval = undefined
      touch(run, now)
      appendEvent(document, run, 'run.retry_authorized', options.actorId ?? 'user', now, {
        retryCount: run.retryCount,
        maxRetries: run.maxRetries
      }, undefined, from, 'queued')
      return clone(run)
    })
  }

  async reassignLease(
    runId: string,
    newOwnerId: string,
    options: SupervisorLeaseOptions
  ): Promise<SupervisorRunRecord> {
    const ownerId = requiredId(newOwnerId, 'new ownerId')
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      const old = run.lease!
      const lease: SupervisorLease = {
        ...old,
        id: randomUUID(),
        ownerId,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + normalizeTtl(options.ttlMs),
        fencingToken: run.fencingToken + 1
      }
      run.fencingToken = lease.fencingToken
      run.lease = lease
      touch(run, now)
      appendEvent(document, run, 'lease.reassigned', options.actorId ?? old.ownerId, now, {
        previousOwnerId: old.ownerId,
        ownerId
      }, lease.fencingToken)
      return clone(run)
    })
  }

  async recoverExpiredLeases(now = this.now()): Promise<SupervisorRecoveryResult> {
    return this.mutate({ actorId: 'supervisor', now }, (document) => {
      const expiredRunIds: string[] = []
      const blockedRunIds: string[] = []
      for (const run of document.runs) {
        if (!run.lease || run.lease.expiresAt > now || TERMINAL.has(run.status)) continue
        const from = run.status
        const fencingToken = run.lease.fencingToken
        run.lease = undefined
        if (run.status === 'running' || run.status === 'waiting_approval') {
          run.status = 'blocked'
          run.approval = undefined
          blockedRunIds.push(run.id)
        }
        touch(run, now)
        expiredRunIds.push(run.id)
        appendEvent(document, run, 'lease.expired', 'supervisor', now, {
          previousStatus: from
        }, fencingToken, from, run.status)
      }
      return { expiredRunIds, blockedRunIds }
    })
  }

  private async transitionWithLease(
    runId: string,
    status: SupervisorRunStatus,
    options: SupervisorLeaseOptions,
    kind: Extract<SupervisorEventKind, 'run.started' | 'run.paused' | 'run.resumed' | 'run.blocked' | 'run.waiting_reconciliation'>
  ): Promise<SupervisorRunRecord> {
    return this.mutate(options, (document, now) => {
      const run = findRun(document, requiredId(runId, 'run id'))
      assertExpectedRevision(run, options)
      assertLease(run, options, now)
      if (!allowedTransition(run.status, status)) {
        throw new SupervisorStateError('invalid_transition', `run ${run.id} cannot transition ${run.status} -> ${status}`)
      }
      const from = run.status
      run.status = status
      if (status !== 'waiting_approval') run.approval = undefined
      touch(run, now)
      appendEvent(document, run, kind, options.actorId ?? options.ownerId, now, {}, run.lease?.fencingToken, from, status)
      return clone(run)
    })
  }

  private async mutate<T>(options: SupervisorMutationOptions, mutation: Mutation<T>): Promise<T> {
    const run = async (): Promise<T> => withFileLock(this.filePath, this.lockPath, async () => {
      const document = await readDocument(this.filePath)
      const now = options.now ?? this.now()
      const result = mutation(document, now)
      document.revision += 1
      await writeDocument(this.filePath, document)
      return result
    })
    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}

function allowedTransition(from: SupervisorRunStatus, to: SupervisorRunStatus): boolean {
  const table: Record<SupervisorRunStatus, ReadonlySet<SupervisorRunStatus>> = {
    queued: new Set(['running', 'cancelled']),
    running: new Set(['waiting_approval', 'waiting_reconciliation', 'paused', 'blocked', 'failed', 'completed', 'cancelled']),
    waiting_approval: new Set(['paused', 'failed', 'cancelled']),
    waiting_reconciliation: new Set(['blocked', 'failed', 'cancelled']),
    paused: new Set(['running', 'cancelled']),
    blocked: new Set(['running', 'cancelled', 'queued']),
    failed: new Set(['queued']),
    completed: new Set(),
    cancelled: new Set()
  }
  return from === to || table[from].has(to)
}

function assertNotTerminal(run: SupervisorRunRecord): void {
  if (TERMINAL.has(run.status)) throw new SupervisorStateError('invalid_transition', `run ${run.id} is terminal`)
}

function assertExpectedRevision(run: SupervisorRunRecord, options: SupervisorMutationOptions): void {
  if (options.expectedRevision !== undefined && run.revision !== options.expectedRevision) {
    throw new SupervisorStateError('stale_revision', `run ${run.id} revision is ${run.revision}, expected ${options.expectedRevision}`)
  }
}

function assertStoreRevision(document: SupervisorStateDocument, options: SupervisorMutationOptions): void {
  if (options.expectedStoreRevision !== undefined && document.revision !== options.expectedStoreRevision) {
    throw new SupervisorStateError('stale_store_revision', `store revision is ${document.revision}, expected ${options.expectedStoreRevision}`)
  }
}

function assertLease(run: SupervisorRunRecord, options: SupervisorLeaseOptions, now: number): void {
  const lease = run.lease
  if (!lease || lease.expiresAt <= now) throw new SupervisorStateError('lease_expired', `run ${run.id} lease is expired`)
  if (lease.ownerId !== options.ownerId) throw new SupervisorStateError('lease_owner', `run ${run.id} lease owner does not match`)
  if (options.leaseId !== undefined && options.leaseId !== lease.id) throw new SupervisorStateError('stale_lease', 'lease id is stale')
  if (options.fencingToken !== undefined && options.fencingToken !== lease.fencingToken) {
    throw new SupervisorStateError('stale_lease', 'lease fencing token is stale')
  }
}

function appendEvent(
  document: SupervisorStateDocument,
  run: SupervisorRunRecord,
  kind: SupervisorEventKind,
  actorId: string,
  occurredAt: number,
  payload: Record<string, unknown>,
  fencingToken?: number,
  fromStatus?: SupervisorRunStatus,
  toStatus?: SupervisorRunStatus
): void {
  const event: SupervisorEvent = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    id: randomUUID(),
    seq: document.events.length + 1,
    runId: run.id,
    kind,
    ...(fromStatus === undefined ? {} : { fromStatus }),
    ...(toStatus === undefined ? {} : { toStatus }),
    actorId,
    ...(fencingToken === undefined ? {} : { fencingToken }),
    occurredAt,
    payload: clone(payload)
  }
  document.events.push(event)
}

function findRun(document: SupervisorStateDocument, id: string): SupervisorRunRecord {
  const run = document.runs.find((candidate) => candidate.id === id)
  if (!run) throw new SupervisorStateError('not_found', `run ${id} was not found`)
  return run
}

function touch(run: SupervisorRunRecord, now: number): void {
  run.revision += 1
  run.updatedAt = now
}

function isStatus(value: unknown): value is SupervisorRunStatus {
  return value === 'queued' || value === 'running' || value === 'waiting_approval' ||
    value === 'waiting_reconciliation' || value === 'paused' || value === 'blocked' ||
    value === 'failed' || value === 'completed' || value === 'cancelled'
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new SupervisorStateError('invalid_input', `${label} is required`)
  return value.trim()
}

function requiredText(value: unknown, label: string): string {
  return requiredId(value, label)
}

function normalizeTimestamp(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SupervisorStateError('invalid_input', `${label} must be a finite non-negative number`)
  }
  return value
}

function normalizeMaxRetries(value: number | undefined): number {
  const retries = value ?? 3
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 100) {
    throw new SupervisorStateError('invalid_input', 'maxRetries must be an integer between 0 and 100')
  }
  return retries
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TTL_MS
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) {
    throw new SupervisorStateError('invalid_input', `ttlMs must be between 1 and ${MAX_TTL_MS}`)
  }
  return ttl
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function cloneDocument(document: SupervisorStateDocument): SupervisorStateDocument {
  return clone(document)
}

async function readDocument(filePath: string): Promise<SupervisorStateDocument> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    assertDocument(parsed)
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyDocument()
    if (error instanceof SupervisorStateError) throw error
    throw new SupervisorStateError('corrupt_store', `cannot read supervisor state: ${String(error)}`)
  }
}

function emptyDocument(): SupervisorStateDocument {
  return { schemaVersion: SUPERVISOR_SCHEMA_VERSION, revision: 0, runs: [], events: [] }
}

function assertDocument(value: unknown): asserts value is SupervisorStateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SupervisorStateError('corrupt_store', 'supervisor state must be an object')
  }
  const document = value as Partial<SupervisorStateDocument>
  if (document.schemaVersion !== SUPERVISOR_SCHEMA_VERSION) {
    throw new SupervisorStateError('unsupported_schema', `supervisor schema ${String(document.schemaVersion)} is unsupported`)
  }
  if (!Number.isSafeInteger(document.revision) || (document.revision as number) < 0 ||
      !Array.isArray(document.runs) || !Array.isArray(document.events)) {
    throw new SupervisorStateError('corrupt_store', 'supervisor state shape is invalid')
  }
  for (const run of document.runs) assertRun(run)
  for (const event of document.events) assertEvent(event)
}

function assertRun(value: unknown): asserts value is SupervisorRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupervisorStateError('corrupt_store', 'run record is invalid')
  const run = value as Partial<SupervisorRunRecord>
  assertRunCoreShape(run)
  if (run.lease !== undefined) assertLeaseShape(run.lease)
  if (run.approval !== undefined && (!run.approval || typeof run.approval.id !== 'string')) {
    throw new SupervisorStateError('corrupt_store', `run ${run.id} approval is invalid`)
  }
}

function assertRunCoreShape(run: Partial<SupervisorRunRecord>): void {
  if (run.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || typeof run.id !== 'string' ||
      typeof run.projectId !== 'string' || typeof run.workItemId !== 'string' || !isStatus(run.status)) {
    invalidRunShape(run)
  }
  if (!isSafeIntegerAtLeast(run.revision, 1) || !isSafeIntegerAtLeast(run.fencingToken, 0) ||
      !isSafeIntegerAtLeast(run.retryCount, 0) || !isSafeIntegerAtLeast(run.maxRetries, 0)) {
    invalidRunShape(run)
  }
  if (typeof run.createdAt !== 'number' || typeof run.updatedAt !== 'number') invalidRunShape(run)
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function invalidRunShape(run: Partial<SupervisorRunRecord>): never {
  throw new SupervisorStateError('corrupt_store', `run ${String(run.id)} is invalid`)
}

function assertLeaseShape(value: unknown): asserts value is SupervisorLease {
  if (!value || typeof value !== 'object') throw new SupervisorStateError('corrupt_store', 'lease is invalid')
  const lease = value as Partial<SupervisorLease>
  if (typeof lease.id !== 'string' || typeof lease.ownerId !== 'string' ||
      !Number.isFinite(lease.acquiredAt) || !Number.isFinite(lease.heartbeatAt) ||
      !Number.isFinite(lease.expiresAt) || !Number.isSafeInteger(lease.fencingToken) || (lease.fencingToken ?? 0) < 1) {
    throw new SupervisorStateError('corrupt_store', 'lease shape is invalid')
  }
}

function assertEvent(value: unknown): asserts value is SupervisorEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupervisorStateError('corrupt_store', 'supervisor event is invalid')
  const event = value as Partial<SupervisorEvent>
  if (event.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || typeof event.id !== 'string' ||
      !Number.isSafeInteger(event.seq) || (event.seq as number) < 1 || typeof event.runId !== 'string' ||
      typeof event.kind !== 'string' || typeof event.actorId !== 'string' ||
      typeof event.occurredAt !== 'number' || !event.payload || typeof event.payload !== 'object') {
    throw new SupervisorStateError('corrupt_store', 'supervisor event shape is invalid')
  }
}

async function withFileLock<T>(filePath: string, lockPath: string, callback: () => Promise<T>): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true })
  const owner = `${process.pid}:${randomUUID()}`
  const started = Date.now()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(owner, 'utf8')
      await handle.sync()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      await removeStaleLock(lockPath)
      await sleep(LOCK_WAIT_MS)
    }
  }
  if (!handle) throw new SupervisorStateError('lock_timeout', 'timed out waiting for supervisor state lock')
  try {
    return await callback()
  } finally {
    await handle.close().catch(() => undefined)
    const current = await readFile(lockPath, 'utf8').catch(() => undefined)
    if (current === owner) await unlink(lockPath).catch(() => undefined)
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath)
    const owner = await readFile(lockPath, 'utf8').catch(() => undefined)
    const pid = owner ? Number.parseInt(owner.split(':', 1)[0], 10) : Number.NaN
    const abandoned = Number.isSafeInteger(pid) && pid > 0
      ? !processIsAlive(pid)
      : Date.now() - lockStat.mtimeMs > LOCK_STALE_MS
    if (abandoned) await unlink(lockPath).catch(() => undefined)
  } catch {
    // Another writer may have released the lock.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function writeDocument(filePath: string, document: SupervisorStateDocument): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    await rename(temporary, filePath)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
