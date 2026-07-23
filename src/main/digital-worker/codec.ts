import { randomUUID } from 'node:crypto'
import {
  DIGITAL_WORKER_SCHEMA_VERSION,
  DIGITAL_WORKER_STORE_VERSION,
  type AssignmentInput,
  type DigitalWorker,
  type DigitalWorkerAssignment,
  type DigitalWorkerAuditEvent,
  type DigitalWorkerInput,
  type DigitalWorkerLease,
  type DigitalWorkerPatch,
  type DigitalWorkerStoreDocument,
  type RoleTemplate,
  type RoleTemplateInput,
  type RoleTemplatePatch
} from '../../shared/digital-worker-types'
import { DigitalWorkerConflictError, DigitalWorkerPersistenceError, notFound } from './errors'
import { verifyDocument } from './relations'
import {
  ASSIGNEE_KINDS,
  asRecord,
  assertNoProviderModelFields,
  assertStoredFields,
  normalizeArray,
  normalizeAssignmentStatus,
  normalizeAcceptancePolicy,
  normalizeConcurrency,
  normalizeDataScopePolicy,
  normalizeJsonObject,
  normalizeLeaseStatus,
  normalizeMemoryNamespace,
  normalizeNonNegativeInteger,
  normalizeOptionalId,
  normalizeOptionalText,
  normalizePositiveInteger,
  normalizeResponsibilityScope,
  normalizeRoleTemplateSource,
  normalizeStringArray,
  normalizeTimestamp,
  normalizeWorkerStatus,
  requiredId,
  requiredText
} from './validation'

const AUDIT_KINDS = new Set<DigitalWorkerAuditEvent['kind']>([
  'role_template.created',
  'role_template.updated',
  'role_template.deleted',
  'worker.created',
  'worker.updated',
  'worker.lifecycle',
  'worker.deleted',
  'assignment.created',
  'assignment.released',
  'lease.acquired',
  'lease.heartbeat',
  'lease.released',
  'lease.expired'
])

export function emptyDocument(): DigitalWorkerStoreDocument {
  return {
    schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
    storeVersion: DIGITAL_WORKER_STORE_VERSION,
    revision: 0,
    nextFencingToken: 1,
    roleTemplates: [],
    workers: [],
    assignments: [],
    leases: [],
    audit: []
  }
}

export function normalizeDocument(value: unknown): DigitalWorkerStoreDocument {
  const record = asRecord(value, 'store')
  const schemaVersion = normalizePositiveInteger(record.schemaVersion, 'store schemaVersion')
  const sourceStoreVersion = normalizePositiveInteger(record.storeVersion, 'storeVersion')
  const storeVersion = migrateStoreVersion(schemaVersion, sourceStoreVersion)
  const document: DigitalWorkerStoreDocument = {
    schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
    storeVersion,
    revision: normalizeNonNegativeInteger(record.revision, 'store revision'),
    nextFencingToken: normalizePositiveInteger(record.nextFencingToken, 'nextFencingToken'),
    roleTemplates: normalizeArray(record.roleTemplates, 'roleTemplates').map(normalizeStoredRoleTemplate),
    workers: normalizeArray(record.workers, 'workers').map(normalizeStoredWorker),
    assignments: normalizeArray(record.assignments, 'assignments').map(normalizeStoredAssignment),
    leases: normalizeArray(record.leases, 'leases').map(normalizeStoredLease),
    audit: normalizeArray(record.audit, 'audit').map(normalizeStoredAudit)
  }
  verifyDocument(document)
  return document
}

function migrateStoreVersion(
  schemaVersion: number,
  storeVersion: number
): typeof DIGITAL_WORKER_STORE_VERSION {
  if (
    schemaVersion === DIGITAL_WORKER_SCHEMA_VERSION &&
    (storeVersion === 1 || storeVersion === DIGITAL_WORKER_STORE_VERSION)
  ) {
    // Version 1 already persisted both policies for valid workers. Requiring
    // those fields below makes migration explicit and rejects permissive gaps.
    return DIGITAL_WORKER_STORE_VERSION
  }
  throw new DigitalWorkerPersistenceError(
    `Unsupported DigitalWorker store schema/version ${schemaVersion}/${storeVersion}`,
    { schemaVersion, storeVersion },
    'SCHEMA_UNSUPPORTED'
  )
}

export function normalizeRoleTemplateInput(input: RoleTemplateInput): RoleTemplate {
  const record = asRecord(input, 'RoleTemplate input')
  const now = Date.now()
  const createdAt = normalizeTimestamp(record.createdAt ?? now, 'RoleTemplate createdAt')
  const purpose = requiredText(record.purpose, 'RoleTemplate purpose')
  return {
    schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
    id: normalizeOptionalId(record.id) ?? randomUUID(),
    name: requiredText(record.name, 'RoleTemplate name'),
    purpose,
    instructions: normalizeOptionalText(record.instructions, 'RoleTemplate instructions') ?? purpose,
    capabilityRefs: normalizeStringArray(record.capabilityRefs, 'capabilityRefs'),
    skillRefs: normalizeStringArray(record.skillRefs, 'skillRefs'),
    toolPolicy: normalizeJsonObject(record.toolPolicy, 'toolPolicy'),
    memoryPolicy: normalizeJsonObject(record.memoryPolicy, 'memoryPolicy'),
    routingRequirements: normalizeJsonObject(record.routingRequirements, 'routingRequirements'),
    verificationPolicy: normalizeJsonObject(record.verificationPolicy, 'verificationPolicy'),
    escalationPolicy: normalizeJsonObject(record.escalationPolicy, 'escalationPolicy'),
    version: 1,
    source: normalizeRoleTemplateSource(record.source ?? 'user'),
    createdAt,
    updatedAt: normalizeTimestamp(record.updatedAt ?? createdAt, 'RoleTemplate updatedAt'),
    revision: 1
  }
}

export function normalizeRoleTemplatePatch(current: RoleTemplate, patch: RoleTemplatePatch): RoleTemplate {
  const record = asRecord(patch, 'RoleTemplate patch')
  return {
    ...current,
    name: record.name === undefined ? current.name : requiredText(record.name, 'RoleTemplate name'),
    purpose: record.purpose === undefined ? current.purpose : requiredText(record.purpose, 'RoleTemplate purpose'),
    instructions: record.instructions === undefined
      ? current.instructions
      : requiredText(record.instructions, 'RoleTemplate instructions'),
    capabilityRefs: record.capabilityRefs === undefined
      ? current.capabilityRefs
      : normalizeStringArray(record.capabilityRefs, 'capabilityRefs'),
    skillRefs: record.skillRefs === undefined
      ? current.skillRefs
      : normalizeStringArray(record.skillRefs, 'skillRefs'),
    toolPolicy: record.toolPolicy === undefined
      ? current.toolPolicy
      : normalizeJsonObject(record.toolPolicy, 'toolPolicy'),
    memoryPolicy: record.memoryPolicy === undefined
      ? current.memoryPolicy
      : normalizeJsonObject(record.memoryPolicy, 'memoryPolicy'),
    routingRequirements: record.routingRequirements === undefined
      ? current.routingRequirements
      : normalizeJsonObject(record.routingRequirements, 'routingRequirements'),
    verificationPolicy: record.verificationPolicy === undefined
      ? current.verificationPolicy
      : normalizeJsonObject(record.verificationPolicy, 'verificationPolicy'),
    escalationPolicy: record.escalationPolicy === undefined
      ? current.escalationPolicy
      : normalizeJsonObject(record.escalationPolicy, 'escalationPolicy'),
    source: record.source === undefined ? current.source : normalizeRoleTemplateSource(record.source),
    archivedAt: normalizeArchivedAt(record.archivedAt, current.archivedAt),
    version: current.version + 1,
    updatedAt: Date.now(),
    revision: current.revision + 1
  }
}

function normalizeArchivedAt(value: unknown, current: number | undefined): number | undefined {
  if (value === null) return undefined
  if (value === undefined) return current
  return normalizeTimestamp(value, 'archivedAt')
}

export function normalizeDigitalWorkerInput(
  input: DigitalWorkerInput,
  document: DigitalWorkerStoreDocument
): DigitalWorker {
  const record = asRecord(input, 'DigitalWorker input')
  assertNoProviderModelFields(record, 'DigitalWorker input')
  const projectId = requiredId(record.projectId, 'projectId')
  const roleTemplateId = requiredId(record.roleTemplateId, 'roleTemplateId')
  const roleTemplate = document.roleTemplates.find((entry) => entry.id === roleTemplateId)
  if (!roleTemplate) throw notFound(`RoleTemplate not found: ${roleTemplateId}`)
  if (roleTemplate.archivedAt !== undefined) {
    throw new DigitalWorkerConflictError(`RoleTemplate is archived: ${roleTemplateId}`)
  }
  return buildDigitalWorker(record, projectId, roleTemplate)
}

function buildDigitalWorker(
  record: Record<string, unknown>,
  projectId: string,
  roleTemplate: RoleTemplate
): DigitalWorker {
  const now = Date.now()
  const status = normalizeWorkerStatus(record.status ?? 'proposed')
  if (status === 'retired') throw new DigitalWorkerConflictError('A new DigitalWorker cannot start retired')
  const id = normalizeOptionalId(record.id) ?? randomUUID()
  return {
    schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
    id,
    projectId,
    roleTemplateId: roleTemplate.id,
    roleTemplateVersion: normalizePositiveInteger(
      record.roleTemplateVersion ?? roleTemplate.version,
      'roleTemplateVersion'
    ),
    displayName: requiredText(record.displayName, 'displayName'),
    avatarProfile: normalizeJsonObject(record.avatarProfile, 'avatarProfile'),
    status,
    responsibilityScope: normalizeResponsibilityScope(record.responsibilityScope),
    capabilityOverrides: normalizeJsonObject(record.capabilityOverrides, 'capabilityOverrides'),
    toolPolicy: record.toolPolicy === undefined
      ? normalizeJsonObject(roleTemplate.toolPolicy, 'toolPolicy')
      : normalizeJsonObject(record.toolPolicy, 'toolPolicy'),
    dataScope: normalizeDataScopePolicy(record.dataScope),
    memoryNamespace: normalizeMemoryNamespace(record.memoryNamespace ?? `project:${projectId}:worker:${id}`),
    budgetPolicy: normalizeJsonObject(record.budgetPolicy, 'budgetPolicy'),
    concurrencyLimit: normalizeConcurrency(record.concurrencyLimit),
    acceptancePolicy: normalizeAcceptancePolicy(record.acceptancePolicy),
    schedulePolicy: normalizeJsonObject(record.schedulePolicy, 'schedulePolicy'),
    escalationPolicy: record.escalationPolicy === undefined
      ? normalizeJsonObject(roleTemplate.escalationPolicy, 'escalationPolicy')
      : normalizeJsonObject(record.escalationPolicy, 'escalationPolicy'),
    performanceProfile: normalizeJsonObject(record.performanceProfile, 'performanceProfile'),
    createdAt: normalizeTimestamp(record.createdAt ?? now, 'DigitalWorker createdAt'),
    updatedAt: normalizeTimestamp(record.updatedAt ?? now, 'DigitalWorker updatedAt'),
    revision: 1
  }
}

export function normalizeDigitalWorkerPatch(current: DigitalWorker, patch: DigitalWorkerPatch): DigitalWorker {
  const record = asRecord(patch, 'DigitalWorker patch')
  return {
    ...current,
    displayName: record.displayName === undefined
      ? current.displayName
      : requiredText(record.displayName, 'displayName'),
    avatarProfile: record.avatarProfile === undefined
      ? current.avatarProfile
      : normalizeJsonObject(record.avatarProfile, 'avatarProfile'),
    responsibilityScope: record.responsibilityScope === undefined
      ? current.responsibilityScope
      : normalizeResponsibilityScope(record.responsibilityScope),
    capabilityOverrides: record.capabilityOverrides === undefined
      ? current.capabilityOverrides
      : normalizeJsonObject(record.capabilityOverrides, 'capabilityOverrides'),
    toolPolicy: record.toolPolicy === undefined
      ? current.toolPolicy
      : normalizeJsonObject(record.toolPolicy, 'toolPolicy'),
    dataScope: record.dataScope === undefined
      ? current.dataScope
      : normalizeDataScopePolicy(record.dataScope),
    memoryNamespace: record.memoryNamespace === undefined
      ? current.memoryNamespace
      : normalizeMemoryNamespace(record.memoryNamespace),
    budgetPolicy: record.budgetPolicy === undefined
      ? current.budgetPolicy
      : normalizeJsonObject(record.budgetPolicy, 'budgetPolicy'),
    concurrencyLimit: record.concurrencyLimit === undefined
      ? current.concurrencyLimit
      : normalizeConcurrency(record.concurrencyLimit),
    acceptancePolicy: record.acceptancePolicy === undefined
      ? current.acceptancePolicy
      : normalizeAcceptancePolicy(record.acceptancePolicy),
    schedulePolicy: record.schedulePolicy === undefined
      ? current.schedulePolicy
      : normalizeJsonObject(record.schedulePolicy, 'schedulePolicy'),
    escalationPolicy: record.escalationPolicy === undefined
      ? current.escalationPolicy
      : normalizeJsonObject(record.escalationPolicy, 'escalationPolicy'),
    performanceProfile: record.performanceProfile === undefined
      ? current.performanceProfile
      : normalizeJsonObject(record.performanceProfile, 'performanceProfile'),
    updatedAt: Date.now(),
    revision: current.revision + 1
  }
}

export function normalizeAssignmentInput(input: AssignmentInput): DigitalWorkerAssignment {
  const record = asRecord(input, 'Assignment input')
  const assigneeKind = record.assigneeKind
  if (typeof assigneeKind !== 'string' || !ASSIGNEE_KINDS.has(assigneeKind)) {
    throw new DigitalWorkerConflictError(`Invalid assigneeKind: ${String(assigneeKind)}`)
  }
  return {
    schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
    id: normalizeOptionalId(record.id) ?? randomUUID(),
    projectId: requiredId(record.projectId, 'projectId'),
    workItemId: requiredId(record.workItemId, 'workItemId'),
    assigneeKind: assigneeKind as 'digital_worker' | 'human',
    assigneeId: requiredId(record.assigneeId, 'assigneeId'),
    scope: normalizeJsonObject(record.scope, 'assignment scope'),
    assignedBy: requiredId(record.assignedBy, 'assignedBy'),
    assignedAt: normalizeTimestamp(record.assignedAt ?? Date.now(), 'assignedAt'),
    ...(record.reason === undefined ? {} : { reason: normalizeOptionalText(record.reason, 'reason') }),
    status: 'active',
    revision: 1
  }
}

function normalizeStoredRoleTemplate(value: unknown): RoleTemplate {
  const record = asRecord(value, 'stored RoleTemplate')
  assertStoredFields(record, [
    'schemaVersion', 'id', 'name', 'purpose', 'instructions', 'capabilityRefs', 'skillRefs',
    'toolPolicy', 'memoryPolicy', 'routingRequirements', 'verificationPolicy', 'escalationPolicy',
    'version', 'source', 'createdAt', 'updatedAt', 'revision'
  ], 'stored RoleTemplate')
  return {
    ...normalizeRoleTemplateInput(record as unknown as RoleTemplateInput),
    schemaVersion: normalizeSchemaVersion(record.schemaVersion, 'RoleTemplate schemaVersion'),
    version: normalizePositiveInteger(record.version, 'RoleTemplate version'),
    revision: normalizePositiveInteger(record.revision, 'RoleTemplate revision'),
    archivedAt: record.archivedAt === undefined
      ? undefined
      : normalizeTimestamp(record.archivedAt, 'RoleTemplate archivedAt')
  }
}

function normalizeStoredWorker(value: unknown): DigitalWorker {
  const record = asRecord(value, 'stored DigitalWorker')
  assertStoredFields(record, [
    'schemaVersion', 'id', 'projectId', 'roleTemplateId', 'roleTemplateVersion', 'displayName',
    'avatarProfile', 'status', 'responsibilityScope', 'capabilityOverrides', 'toolPolicy',
    'dataScope', 'memoryNamespace', 'budgetPolicy', 'concurrencyLimit', 'acceptancePolicy',
    'schedulePolicy', 'escalationPolicy', 'performanceProfile', 'createdAt', 'updatedAt', 'revision'
  ], 'stored DigitalWorker')
  assertNoProviderModelFields(record, 'stored DigitalWorker')
  const status = normalizeWorkerStatus(record.status)
  const roleTemplate = storedRoleFixture(record)
  const normalized = buildDigitalWorker(
    { ...record, status: status === 'retired' ? 'paused' : status },
    requiredId(record.projectId, 'projectId'),
    roleTemplate
  )
  return {
    ...normalized,
    schemaVersion: normalizeSchemaVersion(record.schemaVersion, 'DigitalWorker schemaVersion'),
    status,
    roleTemplateVersion: normalizePositiveInteger(record.roleTemplateVersion, 'roleTemplateVersion'),
    revision: normalizePositiveInteger(record.revision, 'DigitalWorker revision'),
    retiredAt: record.retiredAt === undefined ? undefined : normalizeTimestamp(record.retiredAt, 'retiredAt')
  }
}

function storedRoleFixture(record: Record<string, unknown>): RoleTemplate {
  const timestamp = normalizeTimestamp(record.createdAt, 'DigitalWorker createdAt')
  return {
    schemaVersion: DIGITAL_WORKER_SCHEMA_VERSION,
    id: requiredId(record.roleTemplateId, 'roleTemplateId'),
    name: 'stored',
    purpose: 'stored',
    instructions: 'stored',
    capabilityRefs: [],
    skillRefs: [],
    toolPolicy: {},
    memoryPolicy: {},
    routingRequirements: {},
    verificationPolicy: {},
    escalationPolicy: {},
    version: normalizePositiveInteger(record.roleTemplateVersion, 'roleTemplateVersion'),
    source: 'system',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1
  }
}

function normalizeStoredAssignment(value: unknown): DigitalWorkerAssignment {
  const record = asRecord(value, 'stored Assignment')
  assertStoredFields(record, [
    'schemaVersion', 'id', 'projectId', 'workItemId', 'assigneeKind', 'assigneeId', 'scope',
    'assignedBy', 'assignedAt', 'status', 'revision'
  ], 'stored Assignment')
  return {
    ...normalizeAssignmentInput(record as unknown as AssignmentInput),
    schemaVersion: normalizeSchemaVersion(record.schemaVersion, 'Assignment schemaVersion'),
    status: normalizeAssignmentStatus(record.status),
    revision: normalizePositiveInteger(record.revision, 'Assignment revision'),
    releasedAt: record.releasedAt === undefined ? undefined : normalizeTimestamp(record.releasedAt, 'releasedAt')
  }
}

function normalizeStoredLease(value: unknown): DigitalWorkerLease {
  const record = asRecord(value, 'stored lease')
  const lease: DigitalWorkerLease = {
    schemaVersion: normalizeSchemaVersion(record.schemaVersion, 'lease schemaVersion'),
    id: requiredId(record.id, 'lease id'),
    projectId: requiredId(record.projectId, 'lease projectId'),
    workItemId: requiredId(record.workItemId, 'lease workItemId'),
    assignmentId: requiredId(record.assignmentId, 'lease assignmentId'),
    workerId: requiredId(record.workerId, 'lease workerId'),
    fencingToken: normalizePositiveInteger(record.fencingToken, 'fencingToken'),
    acquiredAt: normalizeTimestamp(record.acquiredAt, 'lease acquiredAt'),
    expiresAt: normalizeTimestamp(record.expiresAt, 'lease expiresAt'),
    ...(record.releasedAt === undefined
      ? {}
      : { releasedAt: normalizeTimestamp(record.releasedAt, 'lease releasedAt') }),
    status: normalizeLeaseStatus(record.status),
    revision: normalizePositiveInteger(record.revision, 'lease revision')
  }
  if (lease.expiresAt < lease.acquiredAt) {
    throw new DigitalWorkerPersistenceError(`Lease ${lease.id} expires before acquisition`)
  }
  return lease
}

function normalizeStoredAudit(value: unknown): DigitalWorkerAuditEvent {
  const record = asRecord(value, 'stored audit')
  assertStoredFields(
    record,
    ['schemaVersion', 'id', 'kind', 'entityId', 'occurredAt', 'revision', 'details'],
    'stored audit'
  )
  const kind = record.kind
  if (typeof kind !== 'string' || !AUDIT_KINDS.has(kind as DigitalWorkerAuditEvent['kind'])) {
    throw new DigitalWorkerPersistenceError(`Invalid audit kind: ${String(kind)}`)
  }
  return {
    schemaVersion: normalizeSchemaVersion(record.schemaVersion, 'audit schemaVersion'),
    id: requiredId(record.id, 'audit id'),
    kind: kind as DigitalWorkerAuditEvent['kind'],
    entityId: requiredId(record.entityId, 'audit entityId'),
    ...(record.projectId === undefined ? {} : { projectId: requiredId(record.projectId, 'audit projectId') }),
    occurredAt: normalizeTimestamp(record.occurredAt, 'audit occurredAt'),
    revision: normalizePositiveInteger(record.revision, 'audit revision'),
    details: normalizeJsonObject(record.details, 'audit details')
  }
}

function normalizeSchemaVersion(value: unknown, field: string): typeof DIGITAL_WORKER_SCHEMA_VERSION {
  const version = normalizePositiveInteger(value, field)
  if (version !== DIGITAL_WORKER_SCHEMA_VERSION) {
    throw new DigitalWorkerPersistenceError(`${field} is unsupported: ${version}`, undefined, 'SCHEMA_UNSUPPORTED')
  }
  return DIGITAL_WORKER_SCHEMA_VERSION
}
