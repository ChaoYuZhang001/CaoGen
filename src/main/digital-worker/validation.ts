import type {
  AssignmentStatus,
  DigitalWorkerStatus,
  DigitalWorkerStoreDocument,
  JsonObject,
  JsonValue,
  RoleTemplate,
  WorkerLeaseStatus
} from '../../shared/digital-worker-types'
import type {
  AssignmentListFilter,
  AuditListFilter,
  LeaseListFilter,
  RevisionOptions
} from './contracts'
import { DigitalWorkerPersistenceError, DigitalWorkerValidationError } from './errors'

const ROLE_TEMPLATE_SOURCES = new Set(['builtin', 'user', 'imported', 'system'])
export const WORKER_STATUSES = new Set<DigitalWorkerStatus>(['proposed', 'active', 'paused', 'retired'])
export const ASSIGNEE_KINDS = new Set(['digital_worker', 'human'])
const ASSIGNMENT_STATUSES = new Set<AssignmentStatus>(['active', 'released'])
const LEASE_STATUSES = new Set<WorkerLeaseStatus>(['active', 'released', 'expired'])
const DEFAULT_LEASE_TTL_MS = 60_000
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000

export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function cloneDocument(document: DigitalWorkerStoreDocument): DigitalWorkerStoreDocument {
  return cloneValue(document)
}

export function normalizeRevisionOptions(options: RevisionOptions | number | undefined): RevisionOptions {
  if (typeof options === 'number') return { expectedRevision: normalizeNonNegativeInteger(options, 'expectedRevision') }
  if (options === undefined) return {}
  const record = asRecord(options, 'revision options')
  return {
    ...(record.expectedRevision === undefined
      ? {}
      : { expectedRevision: normalizeNonNegativeInteger(record.expectedRevision, 'expectedRevision') }),
    ...(record.expectedStoreRevision === undefined
      ? {}
      : { expectedStoreRevision: normalizeNonNegativeInteger(record.expectedStoreRevision, 'expectedStoreRevision') })
  }
}

export function normalizeAssignmentFilter(filter: AssignmentListFilter): AssignmentListFilter {
  return {
    ...(filter.projectId === undefined ? {} : { projectId: requiredId(filter.projectId, 'projectId') }),
    ...(filter.workItemId === undefined ? {} : { workItemId: requiredId(filter.workItemId, 'workItemId') }),
    ...(filter.assigneeId === undefined ? {} : { assigneeId: requiredId(filter.assigneeId, 'assigneeId') }),
    ...(filter.assigneeKind === undefined ? {} : { assigneeKind: filter.assigneeKind }),
    ...(filter.status === undefined ? {} : { status: normalizeAssignmentStatus(filter.status) }),
    ...(filter.includeHistory === undefined ? {} : { includeHistory: filter.includeHistory })
  }
}

export function normalizeLeaseFilter(filter: LeaseListFilter): LeaseListFilter {
  return {
    ...(filter.projectId === undefined ? {} : { projectId: requiredId(filter.projectId, 'projectId') }),
    ...(filter.workItemId === undefined ? {} : { workItemId: requiredId(filter.workItemId, 'workItemId') }),
    ...(filter.workerId === undefined ? {} : { workerId: requiredId(filter.workerId, 'workerId') }),
    ...(filter.status === undefined ? {} : { status: normalizeLeaseStatus(filter.status) }),
    ...(filter.includeExpired === undefined ? {} : { includeExpired: filter.includeExpired })
  }
}

export function normalizeAuditFilter(filter: AuditListFilter): AuditListFilter {
  return {
    ...(filter.projectId === undefined ? {} : { projectId: requiredId(filter.projectId, 'projectId') }),
    ...(filter.entityId === undefined ? {} : { entityId: requiredId(filter.entityId, 'entityId') }),
    ...(filter.kind === undefined ? {} : { kind: filter.kind })
  }
}

export function normalizeRoleTemplateSource(value: unknown): RoleTemplate['source'] {
  if (typeof value !== 'string' || !ROLE_TEMPLATE_SOURCES.has(value)) {
    throw new DigitalWorkerValidationError(`Invalid RoleTemplate source: ${String(value)}`)
  }
  return value as RoleTemplate['source']
}

export function normalizeWorkerStatus(value: unknown): DigitalWorkerStatus {
  if (typeof value !== 'string' || !WORKER_STATUSES.has(value as DigitalWorkerStatus)) {
    throw new DigitalWorkerValidationError(`Invalid DigitalWorker status: ${String(value)}`)
  }
  return value as DigitalWorkerStatus
}

export function normalizeAssignmentStatus(value: unknown): AssignmentStatus {
  if (typeof value !== 'string' || !ASSIGNMENT_STATUSES.has(value as AssignmentStatus)) {
    throw new DigitalWorkerPersistenceError(`Invalid Assignment status: ${String(value)}`)
  }
  return value as AssignmentStatus
}

export function normalizeLeaseStatus(value: unknown): WorkerLeaseStatus {
  if (typeof value !== 'string' || !LEASE_STATUSES.has(value as WorkerLeaseStatus)) {
    throw new DigitalWorkerPersistenceError(`Invalid lease status: ${String(value)}`)
  }
  return value as WorkerLeaseStatus
}

export function normalizeResponsibilityScope(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [requiredText(value, 'responsibilityScope')]
  return normalizeStringArray(value, 'responsibilityScope')
}

export function normalizeMemoryNamespace(value: unknown): string {
  const namespace = requiredText(value, 'memoryNamespace')
  if (/(?:^|[-_:])(?:provider|model)(?:[-_:]|$)/i.test(namespace)) {
    throw new DigitalWorkerValidationError('memoryNamespace cannot bind a Provider or model identity')
  }
  return namespace
}

export function normalizeConcurrency(value: unknown): number {
  if (value === undefined) return 1
  const limit = normalizePositiveInteger(value, 'concurrencyLimit')
  if (limit > 10_000) throw new DigitalWorkerValidationError('concurrencyLimit is too large')
  return limit
}

export function normalizeDataScopePolicy(value: unknown): JsonObject {
  const record = optionalPolicyRecord(value, 'dataScope')
  assertPolicyKeys(record, [
    'requireExplicitScope', 'allowedDataClasses', 'deniedDataClasses', 'allowedResourceIds'
  ], 'dataScope')
  const allowedDataClasses = normalizeStringArray(record.allowedDataClasses, 'dataScope.allowedDataClasses')
  const deniedDataClasses = normalizeStringArray(record.deniedDataClasses, 'dataScope.deniedDataClasses')
  const overlap = allowedDataClasses.find((entry) => deniedDataClasses.includes(entry))
  if (overlap) throw new DigitalWorkerValidationError(`dataScope cannot both allow and deny data class ${overlap}`)
  return {
    requireExplicitScope: optionalBoolean(record.requireExplicitScope, false, 'dataScope.requireExplicitScope'),
    allowedDataClasses,
    deniedDataClasses,
    allowedResourceIds: normalizeStringArray(record.allowedResourceIds, 'dataScope.allowedResourceIds')
  }
}

export function normalizeAcceptancePolicy(value: unknown): JsonObject {
  const record = optionalPolicyRecord(value, 'acceptancePolicy')
  assertPolicyKeys(record, ['minimumEvidenceCount', 'requireUserApproval'], 'acceptancePolicy')
  const minimumEvidenceCount = record.minimumEvidenceCount === undefined
    ? 1
    : normalizeNonNegativeInteger(record.minimumEvidenceCount, 'acceptancePolicy.minimumEvidenceCount')
  if (minimumEvidenceCount > 10_000) {
    throw new DigitalWorkerValidationError('acceptancePolicy.minimumEvidenceCount is too large')
  }
  return {
    minimumEvidenceCount,
    requireUserApproval: optionalBoolean(record.requireUserApproval, false, 'acceptancePolicy.requireUserApproval')
  }
}

export function normalizeTtl(value: unknown): number {
  const ttl = value === undefined ? DEFAULT_LEASE_TTL_MS : normalizePositiveInteger(value, 'ttlMs')
  if (ttl > MAX_LEASE_TTL_MS) throw new DigitalWorkerValidationError('ttlMs is too large')
  return ttl
}

export function normalizeTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DigitalWorkerValidationError(`${field} must be a finite non-negative number`)
  }
  return Math.floor(value)
}

export function normalizePositiveInteger(value: unknown, field: string): number {
  const number = normalizeTimestamp(value, field)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new DigitalWorkerValidationError(`${field} must be a positive integer`)
  }
  return number
}

export function normalizeNonNegativeInteger(value: unknown, field: string): number {
  const number = normalizeTimestamp(value, field)
  if (!Number.isSafeInteger(number)) throw new DigitalWorkerValidationError(`${field} must be a safe integer`)
  return number
}

export function requiredId(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (text.length > 256) throw new DigitalWorkerValidationError(`${field} is too long`)
  return text
}

export function normalizeOptionalId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredId(value, 'id')
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DigitalWorkerValidationError(`${field} is required`)
  }
  return value.trim()
}

export function normalizeOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, field)
}

export function normalizeStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new DigitalWorkerValidationError(`${field} must be an array`)
  return [...new Set(value.map((entry) => requiredText(entry, field)))]
}

export function normalizeJsonObject(value: unknown, field: string): JsonObject {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new DigitalWorkerValidationError(`${field} must be an object`)
  assertJsonValue(value, field)
  return cloneValue(value) as JsonObject
}

export function assertNoProviderModelFields(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProviderModelFields(entry, `${field}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:provider|model)(?:id|name|key|ref)?$/i.test(key) || /^(?:engine)(?:id|name)?$/i.test(key)) {
      throw new DigitalWorkerValidationError(`${field} cannot contain Provider/model identity field: ${key}`)
    }
    assertNoProviderModelFields(entry, `${field}.${key}`)
  }
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DigitalWorkerValidationError(`${field} must be an object`)
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new DigitalWorkerPersistenceError(`${field} must be an array`)
  return value
}

export function assertStoredFields(record: Record<string, unknown>, fields: string[], label: string): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new DigitalWorkerPersistenceError(`${label} is missing required field ${field}`)
    }
  }
}

function optionalPolicyRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  return asRecord(value, field)
}

function assertPolicyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const keys = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new DigitalWorkerValidationError(`${field} contains unsupported field ${key}`)
  }
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new DigitalWorkerValidationError(`${field} must be a boolean`)
  return value
}

function assertJsonValue(value: unknown, field: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new DigitalWorkerValidationError(`${field} contains a non-finite number`)
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, field)
    return
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new DigitalWorkerValidationError(`${field}.${key} is undefined`)
      assertJsonValue(entry, `${field}.${key}`)
    }
    return
  }
  throw new DigitalWorkerValidationError(`${field} contains an unsupported value`)
}
