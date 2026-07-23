/**
 * Domain contracts for CaoGen's native DigitalWorker lane.
 *
 * A DigitalWorker is a project-scoped role instance.  It is intentionally
 * independent from provider/model routing; routing observations belong to a
 * Run/ModelAttempt owned by another domain.
 */

import type { WorkItem, WorkItemOwner } from './project-workspace-types'

export const DIGITAL_WORKER_SCHEMA_VERSION = 1 as const
export const DIGITAL_WORKER_STORE_VERSION = 2 as const

export type DigitalWorkerSchemaVersion = typeof DIGITAL_WORKER_SCHEMA_VERSION

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export type RoleTemplateSource = 'builtin' | 'user' | 'imported' | 'system'

export interface RoleTemplate {
  schemaVersion: DigitalWorkerSchemaVersion
  id: string
  name: string
  purpose: string
  instructions: string
  capabilityRefs: string[]
  skillRefs: string[]
  toolPolicy: JsonObject
  memoryPolicy: JsonObject
  routingRequirements: JsonObject
  verificationPolicy: JsonObject
  escalationPolicy: JsonObject
  version: number
  source: RoleTemplateSource
  createdAt: number
  updatedAt: number
  archivedAt?: number
  revision: number
}

export type DigitalWorkerStatus = 'proposed' | 'active' | 'paused' | 'retired'

export interface DigitalWorker {
  schemaVersion: DigitalWorkerSchemaVersion
  id: string
  projectId: string
  roleTemplateId: string
  roleTemplateVersion: number
  displayName: string
  avatarProfile: JsonObject
  status: DigitalWorkerStatus
  responsibilityScope: string[]
  capabilityOverrides: JsonObject
  toolPolicy: JsonObject
  dataScope: JsonObject
  memoryNamespace: string
  budgetPolicy: JsonObject
  concurrencyLimit: number
  acceptancePolicy: JsonObject
  schedulePolicy: JsonObject
  escalationPolicy: JsonObject
  performanceProfile: JsonObject
  createdAt: number
  updatedAt: number
  retiredAt?: number
  revision: number
}

export type AssignmentAssigneeKind = 'digital_worker' | 'human'
export type AssignmentStatus = 'active' | 'released'

export interface DigitalWorkerAssignment {
  schemaVersion: DigitalWorkerSchemaVersion
  id: string
  projectId: string
  workItemId: string
  assigneeKind: AssignmentAssigneeKind
  assigneeId: string
  scope: JsonObject
  assignedBy: string
  assignedAt: number
  releasedAt?: number
  reason?: string
  status: AssignmentStatus
  revision: number
}

/** Immutable Session/TaskRun identity captured before the first worker action. */
export type DigitalWorkerBinding =
  | { kind: 'unscoped' }
  | { kind: 'assigned'; workerId: string; assignmentId: string }

export type WorkerLeaseStatus = 'active' | 'released' | 'expired'

/** A fencing token makes stale writers fail closed after takeover. */
export interface DigitalWorkerLease {
  schemaVersion: DigitalWorkerSchemaVersion
  id: string
  projectId: string
  workItemId: string
  assignmentId: string
  workerId: string
  fencingToken: number
  acquiredAt: number
  expiresAt: number
  releasedAt?: number
  status: WorkerLeaseStatus
  revision: number
}

export interface DigitalWorkerAuditEvent {
  schemaVersion: DigitalWorkerSchemaVersion
  id: string
  kind:
    | 'role_template.created'
    | 'role_template.updated'
    | 'role_template.deleted'
    | 'worker.created'
    | 'worker.updated'
    | 'worker.lifecycle'
    | 'worker.deleted'
    | 'assignment.created'
    | 'assignment.released'
    | 'lease.acquired'
    | 'lease.heartbeat'
    | 'lease.released'
    | 'lease.expired'
  entityId: string
  projectId?: string
  occurredAt: number
  revision: number
  details: JsonObject
}

export interface DigitalWorkerStoreDocument {
  schemaVersion: DigitalWorkerSchemaVersion
  storeVersion: typeof DIGITAL_WORKER_STORE_VERSION
  revision: number
  nextFencingToken: number
  roleTemplates: RoleTemplate[]
  workers: DigitalWorker[]
  assignments: DigitalWorkerAssignment[]
  leases: DigitalWorkerLease[]
  audit: DigitalWorkerAuditEvent[]
}

export interface RoleTemplateInput {
  id?: string
  name: string
  purpose: string
  instructions?: string
  capabilityRefs?: string[]
  skillRefs?: string[]
  toolPolicy?: JsonObject
  memoryPolicy?: JsonObject
  routingRequirements?: JsonObject
  verificationPolicy?: JsonObject
  escalationPolicy?: JsonObject
  source?: RoleTemplateSource
  createdAt?: number
  updatedAt?: number
}

export interface RoleTemplatePatch {
  name?: string
  purpose?: string
  instructions?: string
  capabilityRefs?: string[]
  skillRefs?: string[]
  toolPolicy?: JsonObject
  memoryPolicy?: JsonObject
  routingRequirements?: JsonObject
  verificationPolicy?: JsonObject
  escalationPolicy?: JsonObject
  source?: RoleTemplateSource
  archivedAt?: number | null
}

export interface DigitalWorkerInput {
  id?: string
  projectId: string
  roleTemplateId: string
  roleTemplateVersion?: number
  displayName: string
  avatarProfile?: JsonObject
  status?: DigitalWorkerStatus
  responsibilityScope?: string[] | string
  capabilityOverrides?: JsonObject
  toolPolicy?: JsonObject
  dataScope?: JsonObject
  memoryNamespace?: string
  budgetPolicy?: JsonObject
  concurrencyLimit?: number
  acceptancePolicy?: JsonObject
  schedulePolicy?: JsonObject
  escalationPolicy?: JsonObject
  performanceProfile?: JsonObject
  createdAt?: number
  updatedAt?: number
}

export interface DigitalWorkerPatch {
  displayName?: string
  avatarProfile?: JsonObject
  responsibilityScope?: string[] | string
  capabilityOverrides?: JsonObject
  toolPolicy?: JsonObject
  dataScope?: JsonObject
  memoryNamespace?: string
  budgetPolicy?: JsonObject
  concurrencyLimit?: number
  acceptancePolicy?: JsonObject
  schedulePolicy?: JsonObject
  escalationPolicy?: JsonObject
  performanceProfile?: JsonObject
}

export interface AssignmentInput {
  id?: string
  projectId: string
  workItemId: string
  assigneeKind: AssignmentAssigneeKind
  assigneeId: string
  scope?: JsonObject
  assignedBy: string
  assignedAt?: number
  reason?: string
}

export interface AcquireLeaseInput {
  projectId: string
  workItemId: string
  workerId: string
  assignmentId?: string
  ttlMs?: number
  now?: number
}

export interface LeaseTokenInput {
  leaseId: string
  fencingToken: number
  now?: number
}

/** Renderer-facing options are deliberately separate from the main-process store types. */
export interface DigitalWorkerRevisionOptions {
  expectedRevision?: number
  expectedStoreRevision?: number
}

export interface DigitalWorkerLifecycleOptions extends DigitalWorkerRevisionOptions {
  now?: number
}

export interface DigitalWorkerReleaseOptions {
  now?: number
  reason?: string
}

export interface DigitalWorkerRoleTemplateListOptions {
  includeArchived?: boolean
}

export interface DigitalWorkerListOptions {
  projectId?: string
  status?: DigitalWorkerStatus
  includeRetired?: boolean
}

export interface DigitalWorkerAssignmentListFilter {
  projectId?: string
  workItemId?: string
  assigneeId?: string
  assigneeKind?: AssignmentAssigneeKind
  status?: AssignmentStatus
  includeHistory?: boolean
}

export interface DigitalWorkerLeaseListFilter {
  projectId?: string
  workItemId?: string
  workerId?: string
  status?: WorkerLeaseStatus
  includeExpired?: boolean
}

export interface DigitalWorkerAuditListFilter {
  projectId?: string
  entityId?: string
  kind?: DigitalWorkerAuditEvent['kind']
}

export interface DigitalWorkerHeartbeatInput extends LeaseTokenInput {
  ttlMs?: number
}

export interface DigitalWorkerReassignInput {
  currentAssignmentId: string
  nextInput: AssignmentInput
  expectedRevision?: number
  expectedStoreRevision?: number
  now?: number
  reason?: string
}

export interface DigitalWorkerReassignmentResult {
  released: DigitalWorkerAssignment
  assigned: DigitalWorkerAssignment
}

export interface DigitalWorkerStoreVerification {
  valid: true
  schemaVersion: number
  revision: number
  counts: {
    roleTemplates: number
    workers: number
    assignments: number
    leases: number
    audit: number
  }
}

export type AssignmentOwnerOperation = 'assign' | 'release' | 'reassign'

export type AssignmentOwnerJournalPhase =
  | 'prepared'
  | 'assignment_written'
  | 'owner_written'
  | 'owner_cleared'
  | 'assignment_released'
  | 'reassignment_written'
  | 'committed'
  | 'compensation_pending'
  | 'compensated'
  | 'failed'

export interface AssignmentOwnerCoordinateInput {
  requestId: string
  projectId: string
  workItemId: string
  workerId: string
  assignedBy: string
  expectedWorkItemRevision: number
  expectedProjectStoreRevision?: number
  expectedDigitalWorkerStoreRevision?: number
  ownerDisplayName?: string
  scope?: JsonObject
  reason?: string
  assignedAt?: number
}

export interface AssignmentOwnerCommitReceipt {
  operation: AssignmentOwnerOperation
  requestId: string
  journalId: string
  assignmentId: string
  previousAssignmentId?: string
  workItemId: string
  assignment: DigitalWorkerAssignment
  released?: DigitalWorkerAssignment
  assigned?: DigitalWorkerAssignment
  workItem: WorkItem
  committedAt: number
}

export interface AssignmentOwnerCoordinateResult extends AssignmentOwnerCommitReceipt {
  idempotentReplay: boolean
  recovered: boolean
}

export interface AssignmentOwnerJournalEntry {
  schemaVersion: 1
  operation: AssignmentOwnerOperation
  id: string
  requestId: string
  requestDigest: string
  projectId: string
  workItemId: string
  assigneeKind: AssignmentAssigneeKind
  assigneeId: string
  /** Compatibility alias for assignment journals written before operation generalization. */
  workerId?: string
  assignmentId: string
  previousAssignmentId?: string
  assignedBy: string
  assignedAt: number
  owner: WorkItemOwner
  previousOwner?: WorkItemOwner
  scope: JsonObject
  reason?: string
  releaseReason?: string
  releasedAt?: number
  expectedWorkItemRevision: number
  expectedProjectStoreRevision: number
  expectedDigitalWorkerStoreRevision: number
  phase: AssignmentOwnerJournalPhase
  assignmentRevision?: number
  ownerRevision?: number
  createdAt: number
  updatedAt: number
  lastError?: string
  receipt?: AssignmentOwnerCommitReceipt
}

export type AssignmentOwnerCoordinatorAuditKind =
  | 'coordinator.prepared'
  | 'coordinator.assignment_written'
  | 'coordinator.owner_written'
  | 'coordinator.owner_cleared'
  | 'coordinator.assignment_released'
  | 'coordinator.reassignment_written'
  | 'coordinator.committed'
  | 'coordinator.compensation_pending'
  | 'coordinator.compensated'
  | 'coordinator.failed'

export interface AssignmentOwnerCoordinatorAuditEvent {
  schemaVersion: 1
  id: string
  kind: AssignmentOwnerCoordinatorAuditKind
  operation: AssignmentOwnerOperation
  requestId: string
  journalId: string
  projectId: string
  workItemId: string
  assignmentId: string
  previousAssignmentId?: string
  occurredAt: number
  revision: number
  details: JsonObject
}

export interface AssignmentOwnerRecoveryResult {
  operation: AssignmentOwnerOperation
  requestId: string
  journalId: string
  phase: AssignmentOwnerJournalPhase
  assignmentId: string
  previousAssignmentId?: string
  workItemId: string
  recovered: boolean
  error?: string
}

/** Complete renderer bridge for the persistent, project-scoped worker domain. */
export interface DigitalWorkerApi {
  verifyDigitalWorkerStore(): Promise<DigitalWorkerStoreVerification>
  getDigitalWorkerStoreSnapshot(): Promise<DigitalWorkerStoreDocument>
  listDigitalWorkerRoleTemplates(options?: DigitalWorkerRoleTemplateListOptions): Promise<RoleTemplate[]>
  getDigitalWorkerRoleTemplate(id: string): Promise<RoleTemplate | null>
  createDigitalWorkerRoleTemplate(input: RoleTemplateInput): Promise<RoleTemplate>
  updateDigitalWorkerRoleTemplate(
    id: string,
    patch: RoleTemplatePatch,
    options?: DigitalWorkerRevisionOptions
  ): Promise<RoleTemplate>
  deleteDigitalWorkerRoleTemplate(id: string, options?: DigitalWorkerRevisionOptions): Promise<boolean>
  listDigitalWorkers(options?: DigitalWorkerListOptions): Promise<DigitalWorker[]>
  getDigitalWorker(id: string): Promise<DigitalWorker | null>
  createDigitalWorker(input: DigitalWorkerInput): Promise<DigitalWorker>
  updateDigitalWorker(
    id: string,
    patch: DigitalWorkerPatch,
    options?: DigitalWorkerRevisionOptions
  ): Promise<DigitalWorker>
  activateDigitalWorker(id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker>
  pauseDigitalWorker(id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker>
  resumeDigitalWorker(id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker>
  retireDigitalWorker(id: string, options?: DigitalWorkerLifecycleOptions): Promise<DigitalWorker>
  deleteDigitalWorker(id: string, options?: DigitalWorkerRevisionOptions): Promise<boolean>
  getDigitalWorkerAssignment(id: string): Promise<DigitalWorkerAssignment | null>
  listDigitalWorkerAssignments(filter?: DigitalWorkerAssignmentListFilter): Promise<DigitalWorkerAssignment[]>
  listDigitalWorkerAssignmentHistory(
    filter?: Omit<DigitalWorkerAssignmentListFilter, 'includeHistory'>
  ): Promise<DigitalWorkerAssignment[]>
  createDigitalWorkerAssignment(input: AssignmentInput): Promise<DigitalWorkerAssignment>
  releaseDigitalWorkerAssignment(
    id: string,
    options?: DigitalWorkerRevisionOptions,
    releaseOptions?: DigitalWorkerReleaseOptions
  ): Promise<DigitalWorkerAssignment>
  reassignDigitalWorkerAssignment(input: DigitalWorkerReassignInput): Promise<DigitalWorkerReassignmentResult>
  coordinateDigitalWorkerAssignmentOwner(input: AssignmentOwnerCoordinateInput): Promise<AssignmentOwnerCoordinateResult>
  recoverDigitalWorkerAssignmentOwners(): Promise<AssignmentOwnerRecoveryResult[]>
  getDigitalWorkerAssignmentOwnerJournal(requestId: string): Promise<AssignmentOwnerJournalEntry | null>
  listDigitalWorkerAssignmentOwnerAudit(requestId?: string): Promise<AssignmentOwnerCoordinatorAuditEvent[]>
  getDigitalWorkerLease(id: string): Promise<DigitalWorkerLease | null>
  listDigitalWorkerLeases(filter?: DigitalWorkerLeaseListFilter): Promise<DigitalWorkerLease[]>
  acquireDigitalWorkerLease(input: AcquireLeaseInput): Promise<DigitalWorkerLease>
  heartbeatDigitalWorkerLease(input: DigitalWorkerHeartbeatInput): Promise<DigitalWorkerLease>
  releaseDigitalWorkerLease(input: LeaseTokenInput): Promise<DigitalWorkerLease>
  listDigitalWorkerAuditEvents(filter?: DigitalWorkerAuditListFilter): Promise<DigitalWorkerAuditEvent[]>
}
