export const SUPERVISOR_SCHEMA_VERSION = 1 as const

/** Persistent state owned by the local Supervisor. */
export type SupervisorRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_reconciliation'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled'

export interface SupervisorLease {
  id: string
  ownerId: string
  acquiredAt: number
  heartbeatAt: number
  expiresAt: number
  fencingToken: number
}

export interface SupervisorApproval {
  id: string
  requestedAt: number
  requestedBy: string
  reason?: string
}

export interface SupervisorRunRecord {
  schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION
  id: string
  projectId: string
  goalId?: string
  workItemId: string
  status: SupervisorRunStatus
  revision: number
  /** Highest fencing token ever issued for this Run; never decreases on release/expiry. */
  fencingToken: number
  retryCount: number
  maxRetries: number
  createdAt: number
  updatedAt: number
  lease?: SupervisorLease
  approval?: SupervisorApproval
  error?: string
}

export type SupervisorEventKind =
  | 'run.created'
  | 'run.started'
  | 'run.paused'
  | 'run.resumed'
  | 'run.blocked'
  | 'run.waiting_approval'
  | 'run.approval_resolved'
  | 'run.waiting_reconciliation'
  | 'run.failed'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.retry_authorized'
  | 'lease.acquired'
  | 'lease.heartbeat'
  | 'lease.reassigned'
  | 'lease.expired'
  | 'lease.released'

export interface SupervisorEvent {
  schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION
  id: string
  seq: number
  runId: string
  kind: SupervisorEventKind
  fromStatus?: SupervisorRunStatus
  toStatus?: SupervisorRunStatus
  actorId: string
  fencingToken?: number
  occurredAt: number
  payload: Record<string, unknown>
}

export interface SupervisorStateDocument {
  schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION
  revision: number
  runs: SupervisorRunRecord[]
  events: SupervisorEvent[]
}

export interface SupervisorRunInput {
  id?: string
  projectId: string
  goalId?: string
  workItemId: string
  maxRetries?: number
  createdAt?: number
}

export interface SupervisorMutationOptions {
  expectedRevision?: number
  expectedStoreRevision?: number
  actorId?: string
  now?: number
}

export interface SupervisorLeaseOptions extends SupervisorMutationOptions {
  ownerId: string
  leaseId?: string
  fencingToken?: number
  ttlMs?: number
}

export interface SupervisorApprovalInput extends SupervisorMutationOptions {
  approvalId: string
  approved: boolean
  reason?: string
}

export interface SupervisorRecoveryResult {
  expiredRunIds: string[]
  blockedRunIds: string[]
}

export interface SupervisorStateApi {
  listSupervisorRuns(options?: { projectId?: string; status?: SupervisorRunStatus }): Promise<SupervisorRunRecord[]>
  getSupervisorRun(id: string): Promise<SupervisorRunRecord | undefined>
  listSupervisorEvents(runId?: string): Promise<SupervisorEvent[]>
  createSupervisorRun(input: SupervisorRunInput, options?: SupervisorMutationOptions): Promise<SupervisorRunRecord>
  acquireSupervisorLease(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  heartbeatSupervisorLease(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  releaseSupervisorLease(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  startSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  pauseSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  resumeSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  requestSupervisorApproval(
    id: string,
    approval: { id: string; reason?: string },
    options: SupervisorLeaseOptions
  ): Promise<SupervisorRunRecord>
  resolveSupervisorApproval(id: string, input: SupervisorApprovalInput): Promise<SupervisorRunRecord>
  blockSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  reconcileSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  failSupervisorRun(id: string, error: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  completeSupervisorRun(id: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  cancelSupervisorRun(id: string, options?: SupervisorMutationOptions): Promise<SupervisorRunRecord>
  retrySupervisorRun(id: string, options?: SupervisorMutationOptions): Promise<SupervisorRunRecord>
  reassignSupervisorLease(id: string, ownerId: string, options: SupervisorLeaseOptions): Promise<SupervisorRunRecord>
  recoverSupervisorLeases(now?: number): Promise<SupervisorRecoveryResult>
}
