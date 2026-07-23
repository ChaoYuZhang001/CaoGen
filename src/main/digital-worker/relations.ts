import { randomUUID } from 'node:crypto'
import {
  DIGITAL_WORKER_SCHEMA_VERSION,
  DIGITAL_WORKER_STORE_VERSION,
  type AcquireLeaseInput,
  type DigitalWorker,
  type DigitalWorkerAssignment,
  type DigitalWorkerAuditEvent,
  type DigitalWorkerLease,
  type DigitalWorkerStatus,
  type DigitalWorkerStoreDocument,
  type JsonObject,
  type JsonValue
} from '../../shared/digital-worker-types'
import type { RevisionOptions } from './contracts'
import {
  DigitalWorkerConflictError,
  DigitalWorkerPersistenceError,
  notFound
} from './errors'
import { digitalWorkerPolicyContractError } from './action-policy-contract'
import { assertNoProviderModelFields, cloneValue, requiredId } from './validation'

export function verifyDocument(document: DigitalWorkerStoreDocument): void {
  verifyStoreHeader(document)
  const roleIds = verifyRoleTemplates(document)
  const workerIds = verifyWorkers(document, roleIds)
  const assignmentIds = verifyAssignments(document)
  verifyLeases(document, workerIds, assignmentIds)
  verifyAudit(document)
}

function verifyStoreHeader(document: DigitalWorkerStoreDocument): void {
  if (
    document.schemaVersion !== DIGITAL_WORKER_SCHEMA_VERSION ||
    document.storeVersion !== DIGITAL_WORKER_STORE_VERSION
  ) {
    throw new DigitalWorkerPersistenceError(
      'DigitalWorker store schema/version mismatch',
      undefined,
      'SCHEMA_UNSUPPORTED'
    )
  }
}

function verifyRoleTemplates(document: DigitalWorkerStoreDocument): Set<string> {
  const roleIds = new Set<string>()
  for (const roleTemplate of document.roleTemplates) {
    assertUniqueId(roleIds, roleTemplate.id, 'RoleTemplate')
  }
  return roleIds
}

function verifyWorkers(document: DigitalWorkerStoreDocument, roleIds: Set<string>): Set<string> {
  const workerIds = new Set<string>()
  for (const worker of document.workers) {
    assertUniqueId(workerIds, worker.id, 'DigitalWorker')
    if (!roleIds.has(worker.roleTemplateId)) {
      throw new DigitalWorkerPersistenceError(
        `DigitalWorker ${worker.id} references missing RoleTemplate ${worker.roleTemplateId}`
      )
    }
    assertNoProviderModelFields(worker, `DigitalWorker ${worker.id}`)
  }
  return workerIds
}

function verifyAssignments(document: DigitalWorkerStoreDocument): Set<string> {
  const assignmentIds = new Set<string>()
  for (const assignment of document.assignments) {
    assertUniqueId(assignmentIds, assignment.id, 'Assignment')
    assertAssignmentReferences(document, assignment, { enforceActiveWorker: false })
  }
  return assignmentIds
}

function verifyLeases(
  document: DigitalWorkerStoreDocument,
  workerIds: Set<string>,
  assignmentIds: Set<string>
): void {
  const leaseIds = new Set<string>()
  const activeWorkItems = new Set<string>()
  let highestFencingToken = 0
  for (const lease of document.leases) {
    assertUniqueId(leaseIds, lease.id, 'lease')
    highestFencingToken = Math.max(highestFencingToken, lease.fencingToken)
    if (!workerIds.has(lease.workerId) || !assignmentIds.has(lease.assignmentId)) {
      throw new DigitalWorkerPersistenceError(`Lease ${lease.id} references missing owner`)
    }
    verifyLeaseOwnership(document, lease)
    if (lease.status === 'active') verifyActiveLeaseUniqueness(activeWorkItems, lease)
  }
  if (document.nextFencingToken <= highestFencingToken) {
    throw new DigitalWorkerPersistenceError(
      `nextFencingToken ${document.nextFencingToken} is not above durable high-water mark ${highestFencingToken}`
    )
  }
}

function verifyLeaseOwnership(document: DigitalWorkerStoreDocument, lease: DigitalWorkerLease): void {
  const assignment = document.assignments.find((entry) => entry.id === lease.assignmentId)
  const worker = document.workers.find((entry) => entry.id === lease.workerId)
  if (!assignment || !worker) throw new DigitalWorkerPersistenceError(`Lease ${lease.id} references missing owner`)
  if (assignment.projectId !== lease.projectId || worker.projectId !== lease.projectId) {
    throw new DigitalWorkerPersistenceError(`Lease ${lease.id} crosses Project ownership`)
  }
  if (assignment.workItemId !== lease.workItemId || assignment.assigneeId !== lease.workerId) {
    throw new DigitalWorkerPersistenceError(`Lease ${lease.id} does not match Assignment ownership`)
  }
}

function verifyActiveLeaseUniqueness(activeWorkItems: Set<string>, lease: DigitalWorkerLease): void {
  const key = `${lease.projectId}\u0000${lease.workItemId}`
  if (activeWorkItems.has(key)) {
    throw new DigitalWorkerPersistenceError(`Duplicate active lease for WorkItem ${lease.workItemId}`)
  }
  activeWorkItems.add(key)
}

function verifyAudit(document: DigitalWorkerStoreDocument): void {
  const auditIds = new Set<string>()
  for (const event of document.audit) assertUniqueId(auditIds, event.id, 'audit')
}

function assertUniqueId(ids: Set<string>, id: string, label: string): void {
  if (ids.has(id)) throw new DigitalWorkerPersistenceError(`Duplicate ${label} id: ${id}`)
  ids.add(id)
}

export function appendAudit(
  document: DigitalWorkerStoreDocument,
  kind: DigitalWorkerAuditEvent['kind'],
  entityId: string,
  projectId: string | undefined,
  occurredAt: number,
  details: JsonObject
): void {
  document.audit.push({
    schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
    id: randomUUID(),
    kind,
    entityId,
    ...(projectId === undefined ? {} : { projectId }),
    occurredAt,
    revision: document.revision + 1,
    details: cloneValue(details)
  })
}

export function assertAssignmentReferences(
  document: DigitalWorkerStoreDocument,
  assignment: DigitalWorkerAssignment,
  options: { enforceActiveWorker?: boolean; enforcePolicy?: boolean } = {}
): void {
  const foreignProjectAssignment = document.assignments.find(
    (entry) =>
      entry.id !== assignment.id &&
      entry.workItemId === assignment.workItemId &&
      entry.projectId !== assignment.projectId
  )
  if (foreignProjectAssignment) {
    throw new DigitalWorkerConflictError(
      `WorkItem ${assignment.workItemId} is already owned by Project ${foreignProjectAssignment.projectId}`,
      undefined,
      'PROJECT_SCOPE_CONFLICT'
    )
  }
  if (assignment.assigneeKind !== 'digital_worker') return
  const worker = document.workers.find((entry) => entry.id === assignment.assigneeId)
  if (!worker) throw notFound(`DigitalWorker not found: ${assignment.assigneeId}`)
  if (worker.projectId !== assignment.projectId) {
    throw new DigitalWorkerConflictError(
      `Assignment ${assignment.id} crosses Project ownership`,
      undefined,
      'PROJECT_SCOPE_CONFLICT'
    )
  }
  if (options.enforceActiveWorker !== false && assignment.status === 'active' && worker.status !== 'active') {
    throw new DigitalWorkerConflictError(
      `DigitalWorker ${worker.id} is ${worker.status}; it cannot receive an Assignment`
    )
  }
  if (options.enforcePolicy !== false && assignment.status === 'active') {
    assertDigitalWorkerAssignmentPolicy(worker, assignment)
  }
}

export function assertDigitalWorkerAssignmentPolicy(
  worker: DigitalWorker,
  assignment: DigitalWorkerAssignment
): void {
  if (
    assignment.assigneeKind !== 'digital_worker' ||
    assignment.assigneeId !== worker.id ||
    assignment.projectId !== worker.projectId
  ) {
    throw new DigitalWorkerConflictError(
      `Assignment ${assignment.id} does not belong to DigitalWorker ${worker.id}`,
      { workerId: worker.id, assignmentId: assignment.id },
      'PROJECT_SCOPE_CONFLICT'
    )
  }
  if (assignment.status !== 'active') return
  const actionPolicyError = digitalWorkerPolicyContractError(worker)
  if (actionPolicyError) denyAssignmentPolicy(worker.id, assignment.id, actionPolicyError, 'actionPolicy')
  assertAssignmentDataScope(worker.id, worker.dataScope, assignment)
}

function assertAssignmentDataScope(
  workerId: string,
  policy: JsonObject,
  assignment: DigitalWorkerAssignment
): void {
  const dataClass = optionalScopeText(assignment.scope.dataClass, workerId, assignment.id, 'scope.dataClass')
  const resourceIds = optionalScopeIds(assignment.scope.resourceIds, workerId, assignment.id)
  const allowedDataClasses = policyIds(policy.allowedDataClasses)
  const deniedDataClasses = policyIds(policy.deniedDataClasses)
  const allowedResourceIds = policyIds(policy.allowedResourceIds)
  if ((policy.requireExplicitScope === true || allowedDataClasses.length > 0 || deniedDataClasses.length > 0) && !dataClass) {
    denyAssignmentPolicy(workerId, assignment.id, 'explicit data scope is required')
  }
  if (dataClass && deniedDataClasses.includes(dataClass)) {
    denyAssignmentPolicy(workerId, assignment.id, `data class ${dataClass} is denied`)
  }
  if (allowedDataClasses.length > 0 && (!dataClass || !allowedDataClasses.includes(dataClass))) {
    denyAssignmentPolicy(workerId, assignment.id, `data class ${dataClass ?? '<missing>'} is not allowed`)
  }
  if (allowedResourceIds.length > 0 && resourceIds.length === 0) {
    denyAssignmentPolicy(workerId, assignment.id, 'explicit resource scope is required')
  }
  const disallowedResource = resourceIds.find((resourceId) =>
    allowedResourceIds.length > 0 && !allowedResourceIds.includes(resourceId)
  )
  if (disallowedResource) {
    denyAssignmentPolicy(workerId, assignment.id, `resource ${disallowedResource} is not allowed`)
  }
}

function optionalScopeText(
  value: JsonValue | undefined,
  workerId: string,
  assignmentId: string,
  field: string
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    denyAssignmentPolicy(workerId, assignmentId, `${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalScopeIds(value: JsonValue | undefined, workerId: string, assignmentId: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    denyAssignmentPolicy(workerId, assignmentId, 'scope.resourceIds must be non-empty strings')
  }
  return [...new Set(value.map((entry) => (entry as string).trim()))]
}

function policyIds(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : []
}

function denyAssignmentPolicy(
  workerId: string,
  assignmentId: string,
  reason: string,
  policy = 'dataScope'
): never {
  throw new DigitalWorkerConflictError(
    `DigitalWorker ${workerId} policy denied Assignment ${assignmentId}: ${reason}`,
    { workerId, assignmentId, policy, reason },
    'POLICY_DENIED'
  )
}

export function assertNoActiveAssignment(
  document: DigitalWorkerStoreDocument,
  projectId: string,
  workItemId: string
): void {
  const existing = document.assignments.find(
    (assignment) =>
      assignment.projectId === projectId &&
      assignment.workItemId === workItemId &&
      assignment.status === 'active'
  )
  if (!existing) return
  throw new DigitalWorkerConflictError(
    `WorkItem ${workItemId} already has an active Assignment`,
    { assignmentId: existing.id, assigneeId: existing.assigneeId },
    'CONFLICT'
  )
}

export function resolveLeaseAssignment(
  document: DigitalWorkerStoreDocument,
  input: AcquireLeaseInput,
  projectId: string,
  workItemId: string,
  workerId: string
): DigitalWorkerAssignment {
  const assignment = input.assignmentId === undefined
    ? findWorkerAssignment(document, projectId, workItemId, workerId)
    : document.assignments.find((entry) => entry.id === requiredId(input.assignmentId, 'assignmentId'))
  if (!assignment) {
    throw notFound(`Active Assignment not found for WorkItem ${workItemId} and DigitalWorker ${workerId}`)
  }
  assertLeaseAssignmentOwnership(assignment, projectId, workItemId, workerId)
  return assignment
}

function findWorkerAssignment(
  document: DigitalWorkerStoreDocument,
  projectId: string,
  workItemId: string,
  workerId: string
): DigitalWorkerAssignment | undefined {
  return document.assignments.find(
    (entry) =>
      entry.projectId === projectId &&
      entry.workItemId === workItemId &&
      entry.assigneeId === workerId &&
      entry.status === 'active'
  )
}

function assertLeaseAssignmentOwnership(
  assignment: DigitalWorkerAssignment,
  projectId: string,
  workItemId: string,
  workerId: string
): void {
  const matches =
    assignment.projectId === projectId &&
    assignment.workItemId === workItemId &&
    assignment.assigneeKind === 'digital_worker' &&
    assignment.assigneeId === workerId &&
    assignment.status === 'active'
  if (matches) return
  throw new DigitalWorkerConflictError(
    'Lease Assignment does not match Project/WorkItem/DigitalWorker ownership',
    undefined,
    'PROJECT_SCOPE_CONFLICT'
  )
}

export function expireLeases(document: DigitalWorkerStoreDocument, now: number): void {
  for (let index = 0; index < document.leases.length; index += 1) {
    const lease = document.leases[index]
    if (lease.status !== 'active' || lease.expiresAt > now) continue
    document.leases[index] = expireLease(lease, now)
    appendAudit(document, 'lease.expired', lease.id, lease.projectId, now, {
      workerId: lease.workerId,
      fencingToken: lease.fencingToken
    })
  }
}

export function expireLease(lease: DigitalWorkerLease, now: number): DigitalWorkerLease {
  return { ...lease, status: 'expired', releasedAt: now, revision: lease.revision + 1 }
}

export function assertFence(lease: DigitalWorkerLease, fencingToken: number): void {
  if (lease.fencingToken === fencingToken) return
  throw new DigitalWorkerConflictError(
    `Stale fencing token for lease ${lease.id}`,
    { expected: lease.fencingToken, received: fencingToken },
    'STALE_FENCE'
  )
}

export function assertExpectedStoreRevision(
  document: DigitalWorkerStoreDocument,
  options: RevisionOptions
): void {
  if (options.expectedStoreRevision === undefined || document.revision === options.expectedStoreRevision) return
  throw new DigitalWorkerConflictError(
    `Store revision conflict: expected ${options.expectedStoreRevision}, got ${document.revision}`,
    { expected: options.expectedStoreRevision, actual: document.revision },
    'REVISION_CONFLICT'
  )
}

export function assertExpectedRecordRevision(
  actual: number,
  options: RevisionOptions,
  label: string
): void {
  if (options.expectedRevision === undefined || actual === options.expectedRevision) return
  throw new DigitalWorkerConflictError(
    `${label} revision conflict: expected ${options.expectedRevision}, got ${actual}`,
    { expected: options.expectedRevision, actual },
    'REVISION_CONFLICT'
  )
}

export function lifecycleTransitionAllowed(from: DigitalWorkerStatus, to: DigitalWorkerStatus): boolean {
  if (from === to) return true
  if (from === 'proposed') return to === 'active' || to === 'retired'
  if (from === 'active') return to === 'paused' || to === 'retired'
  if (from === 'paused') return to === 'active' || to === 'retired'
  return false
}
