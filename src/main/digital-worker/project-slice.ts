import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerAuditEvent,
  DigitalWorkerLease,
  DigitalWorkerStoreDocument,
  RoleTemplate
} from '../../shared/digital-worker-types'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'
import { normalizeDocument } from './codec'
import { DigitalWorkerConflictError, DigitalWorkerValidationError } from './errors'

export interface DigitalWorkerProjectSliceInput {
  projectId: string
  roleTemplates: RoleTemplate[]
  workers: DigitalWorker[]
  assignments: DigitalWorkerAssignment[]
  leases: DigitalWorkerLease[]
  audit: DigitalWorkerAuditEvent[]
}

export interface DigitalWorkerProjectPurgeResult {
  workers: number
  assignments: number
  leases: number
  audit: number
}

export function purgeDigitalWorkerProjectSlice(
  document: DigitalWorkerStoreDocument,
  projectId: string
): DigitalWorkerProjectPurgeResult {
  const before = collectionCounts(document)
  document.leases = document.leases.filter((entry) => entry.projectId !== projectId)
  document.assignments = document.assignments.filter((entry) => entry.projectId !== projectId)
  document.workers = document.workers.filter((entry) => entry.projectId !== projectId)
  document.audit = document.audit.filter((entry) => entry.projectId !== projectId)
  const after = collectionCounts(document)
  return {
    workers: before.workers - after.workers,
    assignments: before.assignments - after.assignments,
    leases: before.leases - after.leases,
    audit: before.audit - after.audit
  }
}

export function projectSliceAlreadyImported(
  current: DigitalWorkerStoreDocument,
  input: DigitalWorkerProjectSliceInput,
  projectId: string
): boolean {
  resolveRoleTemplateDependencies(current.roleTemplates, input.roleTemplates, input.workers)
  const existing = workforceImportSlice(current, projectId)
  if (sliceTotal(existing) === 0) return false
  const incoming = workforceImportSlice({
    ...current,
    workers: input.workers,
    assignments: input.assignments,
    leases: input.leases,
    audit: input.audit
  }, projectId)
  if (projectAggregateCanonicalJson(existing) === projectAggregateCanonicalJson(incoming)) return true
  throw new DigitalWorkerConflictError(`Project import identity conflict: ${projectId}`)
}

export function mergeDigitalWorkerProjectSlice(
  document: DigitalWorkerStoreDocument,
  input: DigitalWorkerProjectSliceInput,
  projectId: string
): void {
  assertProjectOwnership(input, projectId)
  assertNoIdentityConflicts(document, input, projectId)
  const roleTemplates = resolveRoleTemplateDependencies(document.roleTemplates, input.roleTemplates, input.workers)
  const maxFence = input.leases.reduce((maximum, lease) => Math.max(maximum, lease.fencingToken), 0)
  const candidate = normalizeDocument({
    ...document,
    roleTemplates,
    workers: [...document.workers, ...structuredClone(input.workers)],
    assignments: [...document.assignments, ...structuredClone(input.assignments)],
    leases: [...document.leases, ...structuredClone(input.leases)],
    audit: [...document.audit, ...structuredClone(input.audit)],
    nextFencingToken: Math.max(document.nextFencingToken, maxFence + 1)
  })
  Object.assign(document, candidate)
}

function assertProjectOwnership(input: DigitalWorkerProjectSliceInput, projectId: string): void {
  for (const collection of [input.workers, input.assignments, input.leases, input.audit]) {
    if (collection.some((entry) => entry.projectId !== projectId)) {
      throw new DigitalWorkerValidationError(`Project import contains workforce data outside ${projectId}`)
    }
  }
}

function assertNoIdentityConflicts(
  document: DigitalWorkerStoreDocument,
  input: DigitalWorkerProjectSliceInput,
  projectId: string
): void {
  const conflicts = [
    ...identityConflicts(document.workers, input.workers),
    ...identityConflicts(document.assignments, input.assignments),
    ...identityConflicts(document.leases, input.leases),
    ...identityConflicts(document.audit, input.audit)
  ]
  if (conflicts.length > 0) {
    throw new DigitalWorkerConflictError(
      `Project import identity conflict: ${projectId}: ${[...new Set(conflicts)].sort().join(', ')}`
    )
  }
}

function resolveRoleTemplateDependencies(
  existing: readonly RoleTemplate[],
  incoming: readonly RoleTemplate[],
  workers: readonly DigitalWorker[]
): RoleTemplate[] {
  const requiredRoleIds = new Set(workers.map((worker) => worker.roleTemplateId))
  const incomingById = uniqueIncomingRoles(incoming)
  assertRoleDependencyClosure(requiredRoleIds, incomingById, workers)
  const merged = structuredClone([...existing])
  const existingById = new Map(merged.map((role) => [role.id, role]))
  for (const role of incoming) {
    const installed = existingById.get(role.id)
    if (installed && roleTemplateSemanticJson(installed) !== roleTemplateSemanticJson(role)) {
      throw new DigitalWorkerConflictError(`Installed RoleTemplate conflicts with Project import dependency: ${role.id}`)
    }
    if (!installed) merged.push(structuredClone(role))
  }
  return merged.sort((left, right) => left.id.localeCompare(right.id))
}

function uniqueIncomingRoles(incoming: readonly RoleTemplate[]): Map<string, RoleTemplate> {
  const roles = new Map<string, RoleTemplate>()
  for (const role of incoming) {
    if (roles.has(role.id)) {
      throw new DigitalWorkerConflictError(`Duplicate Project import RoleTemplate dependency: ${role.id}`)
    }
    roles.set(role.id, role)
  }
  return roles
}

function assertRoleDependencyClosure(
  requiredRoleIds: ReadonlySet<string>,
  incomingById: ReadonlyMap<string, RoleTemplate>,
  workers: readonly DigitalWorker[]
): void {
  const missing = [...requiredRoleIds].filter((id) => !incomingById.has(id)).sort()
  const unrelated = [...incomingById.keys()].filter((id) => !requiredRoleIds.has(id)).sort()
  if (missing.length > 0) throw new DigitalWorkerConflictError(`Project import is missing RoleTemplate dependencies: ${missing.join(', ')}`)
  if (unrelated.length > 0) throw new DigitalWorkerConflictError(`Project import contains unrelated RoleTemplate dependencies: ${unrelated.join(', ')}`)
  for (const worker of workers) {
    const role = incomingById.get(worker.roleTemplateId)
    if (!role || role.version < worker.roleTemplateVersion) {
      throw new DigitalWorkerConflictError(`RoleTemplate dependency is older than DigitalWorker ${worker.id}`)
    }
  }
}

function roleTemplateSemanticJson(role: RoleTemplate): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, revision: _revision, source: _source, ...semantic } = role
  return projectAggregateCanonicalJson(semantic)
}

function identityConflicts<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): string[] {
  const ids = new Set(existing.map((entry) => entry.id))
  return incoming.filter((entry) => ids.has(entry.id)).map((entry) => entry.id)
}

function workforceImportSlice(document: DigitalWorkerStoreDocument, projectId: string) {
  const byId = <T extends { id: string }>(left: T, right: T): number => left.id.localeCompare(right.id)
  return {
    workers: document.workers.filter((entry) => entry.projectId === projectId).sort(byId),
    assignments: document.assignments.filter((entry) => entry.projectId === projectId).sort(byId),
    leases: document.leases.filter((entry) => entry.projectId === projectId).sort(byId),
    audit: document.audit.filter((entry) => entry.projectId === projectId).sort((left, right) =>
      left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
  }
}

function collectionCounts(document: DigitalWorkerStoreDocument): DigitalWorkerProjectPurgeResult {
  return {
    workers: document.workers.length,
    assignments: document.assignments.length,
    leases: document.leases.length,
    audit: document.audit.length
  }
}

function sliceTotal(slice: ReturnType<typeof workforceImportSlice>): number {
  return slice.workers.length + slice.assignments.length + slice.leases.length + slice.audit.length
}
