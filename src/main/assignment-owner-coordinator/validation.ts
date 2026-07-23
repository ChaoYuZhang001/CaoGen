import { createHash } from 'node:crypto'
import type {
  AssignmentOwnerCoordinateInput,
  AssignmentOwnerJournalEntry,
  AssignmentInput,
  DigitalWorkerAssignment,
  JsonObject,
  JsonValue
} from '../../shared/digital-worker-types'
import type { WorkItem, WorkItemOwner } from '../../shared/project-workspace-types'
import { canonicalJson } from '../project-workspace/codec'
import { AssignmentOwnerCoordinatorError } from './errors'
import type {
  AssignmentOwnerCreateRequest,
  AssignmentOwnerReassignRequest,
  AssignmentOwnerReleaseRequest
} from './contracts'

const INPUT_FIELDS = new Set([
  'requestId',
  'projectId',
  'workItemId',
  'workerId',
  'assignedBy',
  'expectedWorkItemRevision',
  'expectedProjectStoreRevision',
  'expectedDigitalWorkerStoreRevision',
  'ownerDisplayName',
  'scope',
  'reason',
  'assignedAt'
])

export function normalizeAssignmentOwnerInput(value: unknown): AssignmentOwnerCoordinateInput {
  const record = requiredRecord(value, 'assignment owner input')
  for (const key of Object.keys(record)) {
    if (!INPUT_FIELDS.has(key)) invalid(`assignment owner input contains an unknown field: ${key}`)
  }
  return {
    requestId: requiredText(record.requestId, 'requestId', 256),
    projectId: requiredText(record.projectId, 'projectId', 512),
    workItemId: requiredText(record.workItemId, 'workItemId', 512),
    workerId: requiredText(record.workerId, 'workerId', 512),
    assignedBy: requiredText(record.assignedBy, 'assignedBy', 512),
    expectedWorkItemRevision: positiveInteger(record.expectedWorkItemRevision, 'expectedWorkItemRevision'),
    ...(record.expectedProjectStoreRevision === undefined
      ? {}
      : { expectedProjectStoreRevision: nonNegativeInteger(record.expectedProjectStoreRevision, 'expectedProjectStoreRevision') }),
    ...(record.expectedDigitalWorkerStoreRevision === undefined
      ? {}
      : { expectedDigitalWorkerStoreRevision: nonNegativeInteger(record.expectedDigitalWorkerStoreRevision, 'expectedDigitalWorkerStoreRevision') }),
    ...(record.ownerDisplayName === undefined
      ? {}
      : { ownerDisplayName: requiredText(record.ownerDisplayName, 'ownerDisplayName', 2_048) }),
    ...(record.scope === undefined ? {} : { scope: jsonObject(record.scope, 'scope') }),
    ...(record.reason === undefined ? {} : { reason: requiredContent(record.reason, 'reason', 8_192) }),
    ...(record.assignedAt === undefined ? {} : { assignedAt: timestamp(record.assignedAt, 'assignedAt') })
  }
}

export function normalizeRequestId(value: unknown): string {
  return requiredText(value, 'requestId', 256)
}

export function normalizeCreateRequest(value: unknown): AssignmentOwnerCreateRequest {
  const record = exactRecord(value, [
    'requestId', 'input', 'expectedWorkItemRevision', 'expectedProjectStoreRevision',
    'expectedDigitalWorkerStoreRevision', 'ownerDisplayName'
  ], 'assignment create request')
  return {
    requestId: normalizeRequestId(record.requestId),
    input: normalizeCoordinatorAssignmentInput(record.input),
    ...optionalRevision(record, 'expectedWorkItemRevision'),
    ...optionalRevision(record, 'expectedProjectStoreRevision', true),
    ...optionalRevision(record, 'expectedDigitalWorkerStoreRevision', true),
    ...(record.ownerDisplayName === undefined
      ? {}
      : { ownerDisplayName: requiredText(record.ownerDisplayName, 'ownerDisplayName', 2_048) })
  }
}

export function normalizeReleaseRequest(value: unknown): AssignmentOwnerReleaseRequest {
  const record = exactRecord(
    value,
    ['requestId', 'assignmentId', 'options', 'releaseOptions'],
    'assignment release request'
  )
  const options = optionalRecord(record.options, 'assignment release options')
  const releaseOptions = optionalRecord(record.releaseOptions, 'assignment release metadata')
  assertExactKeys(options, ['expectedRevision', 'expectedStoreRevision'], 'assignment release options')
  assertExactKeys(releaseOptions, ['now', 'reason'], 'assignment release metadata')
  return {
    requestId: normalizeRequestId(record.requestId),
    assignmentId: requiredText(record.assignmentId, 'assignmentId', 512),
    options: {
      ...optionalRevision(options, 'expectedRevision'),
      ...optionalRevision(options, 'expectedStoreRevision', true)
    },
    releaseOptions: {
      ...(releaseOptions.now === undefined ? {} : { now: timestamp(releaseOptions.now, 'release now') }),
      ...(releaseOptions.reason === undefined
        ? {}
        : { reason: requiredContent(releaseOptions.reason, 'release reason', 8_192) })
    }
  }
}

export function normalizeReassignRequest(value: unknown): AssignmentOwnerReassignRequest {
  const record = exactRecord(value, [
    'requestId', 'currentAssignmentId', 'nextInput', 'expectedRevision',
    'expectedStoreRevision', 'now', 'reason', 'ownerDisplayName'
  ], 'assignment reassign request')
  return {
    requestId: normalizeRequestId(record.requestId),
    currentAssignmentId: requiredText(record.currentAssignmentId, 'currentAssignmentId', 512),
    nextInput: normalizeCoordinatorAssignmentInput(record.nextInput),
    ...optionalRevision(record, 'expectedRevision'),
    ...optionalRevision(record, 'expectedStoreRevision', true),
    ...(record.now === undefined ? {} : { now: timestamp(record.now, 'reassign now') }),
    ...(record.reason === undefined ? {} : { reason: requiredContent(record.reason, 'reassign reason', 8_192) }),
    ...(record.ownerDisplayName === undefined
      ? {}
      : { ownerDisplayName: requiredText(record.ownerDisplayName, 'ownerDisplayName', 2_048) })
  }
}

export function assignmentOwnerRequestDigest(input: AssignmentOwnerCoordinateInput): string {
  return coordinatorRequestDigest(input)
}

export function coordinatorRequestDigest(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

export function desiredOwner(entry: AssignmentOwnerJournalEntry): WorkItemOwner {
  if (!entry.owner) invalid(`journal entry ${entry.id} has no desired owner`)
  return clone(entry.owner)
}

export function ownerMatches(item: WorkItem, entry: AssignmentOwnerJournalEntry): boolean {
  return item.owner?.type === entry.assigneeKind && item.owner.id === entry.assigneeId
}

export function ownerMatchesAssignment(item: WorkItem, assignment: DigitalWorkerAssignment): boolean {
  return item.owner?.type === assignment.assigneeKind && item.owner.id === assignment.assigneeId
}

export function ownersEqual(left?: WorkItemOwner, right?: WorkItemOwner): boolean {
  if (!left || !right) return left === right
  return left.type === right.type && left.id === right.id
}

export function assignmentMatches(
  assignment: DigitalWorkerAssignment,
  entry: AssignmentOwnerJournalEntry
): boolean {
  return assignment.id === entry.assignmentId &&
    assignment.projectId === entry.projectId &&
    assignment.workItemId === entry.workItemId &&
    assignment.assigneeKind === entry.assigneeKind &&
    assignment.assigneeId === entry.assigneeId &&
    assignment.assignedBy === entry.assignedBy &&
    assignment.assignedAt === entry.assignedAt
}

export function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return `${readErrorCode(error)}${error.message}`.slice(0, 4_096)
  return String(error).slice(0, 4_096)
}

export function readErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
  return code ? `${code}: ` : ''
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  const record = requiredRecord(value, label)
  assertExactKeys(record, fields, label)
  return record
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  return requiredRecord(value, label)
}

function assertExactKeys(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields)
  for (const key of Object.keys(record)) if (!allowed.has(key)) invalid(`${label} contains an unknown field: ${key}`)
}

function normalizeCoordinatorAssignmentInput(value: unknown): AssignmentInput {
  const record = exactRecord(value, [
    'id', 'projectId', 'workItemId', 'assigneeKind', 'assigneeId', 'scope',
    'assignedBy', 'assignedAt', 'reason'
  ], 'Assignment input')
  if (record.assigneeKind !== 'digital_worker' && record.assigneeKind !== 'human') {
    invalid('assigneeKind is invalid')
  }
  return {
    ...(record.id === undefined ? {} : { id: requiredText(record.id, 'Assignment id', 512) }),
    projectId: requiredText(record.projectId, 'projectId', 512),
    workItemId: requiredText(record.workItemId, 'workItemId', 512),
    assigneeKind: record.assigneeKind,
    assigneeId: requiredText(record.assigneeId, 'assigneeId', 512),
    ...(record.scope === undefined ? {} : { scope: jsonObject(record.scope, 'scope') }),
    assignedBy: requiredText(record.assignedBy, 'assignedBy', 512),
    ...(record.assignedAt === undefined ? {} : { assignedAt: timestamp(record.assignedAt, 'assignedAt') }),
    ...(record.reason === undefined ? {} : { reason: requiredContent(record.reason, 'reason', 8_192) })
  }
}

function optionalRevision(
  record: Record<string, unknown>,
  field: string,
  allowZero = false
): Record<string, number> {
  if (record[field] === undefined) return {}
  const value = allowZero
    ? nonNegativeInteger(record[field], field)
    : positiveInteger(record[field], field)
  return { [field]: value }
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0-\x1F\x7F]/.test(normalized)) {
    invalid(`${label} has an invalid format`)
  }
  return normalized
}

function requiredContent(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) {
    invalid(`${label} has an invalid format`)
  }
  return normalized
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} must be a positive safe integer`)
  return value as number
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} must be a non-negative safe integer`)
  return value as number
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`${label} must be a finite timestamp`)
  return value
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  validateJson(value, label, 0)
  return clone(value) as JsonObject
}

function validateJson(value: unknown, label: string, depth: number): asserts value is JsonValue {
  if (depth > 32) invalid(`${label} is too deeply nested`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJson(entry, `${label}[${index}]`, depth + 1))
    return
  }
  if (!value || typeof value !== 'object') invalid(`${label} contains an unsupported value`)
  for (const [key, entry] of Object.entries(value)) {
    if (!key || /[\0-\x1F\x7F]/.test(key)) invalid(`${label} contains an invalid key`)
    validateJson(entry, `${label}.${key}`, depth + 1)
  }
}

function invalid(message: string): never {
  throw new AssignmentOwnerCoordinatorError('INVALID_INPUT', message)
}
