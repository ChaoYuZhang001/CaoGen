import { app, ipcMain } from 'electron'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  openProjectWorkspaceStore,
  type DeleteOptions,
  type LeaseOptions,
  type ListOptions
} from '../project-workspace/store'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import {
  createProjectWorkspaceReadService,
  type ProjectWorkspaceReadService
} from '../project-workspace/canonical-read-service'
import {
  isGoalRiskLevel,
  isGoalStatus,
  isProjectWorkspaceKind,
  isWorkItemStatus,
  isWorkItemType,
  type AcceptanceResult,
  type GoalInput,
  type GoalPatch,
  type MutationOptions,
  type ProjectWorkspaceDeleteOptions,
  type ProjectWorkspaceInput,
  type ProjectWorkspaceLeaseOptions,
  type ProjectWorkspaceListOptions,
  type ProjectWorkspacePatch,
  type WorkItemInput,
  type WorkItemPatch,
  type WorkItemReorderPlacement
} from '../../shared/project-workspace-types'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import {
  startAssignmentOwnerReadiness,
  withAssignmentOwnerReadiness
} from '../assignment-owner-coordinator'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { normalizeOwner } from '../project-workspace/codec'
import {
  projectIdFromMutationResult,
  verifyProductionProjectMutation
} from '../project-aggregate/project-mutation-ingress'

const WORKSPACE_KEYS = new Set([
  'id', 'name', 'kind', 'ownerId', 'resources', 'rulesRef',
  'budgetPolicy', 'permissionPolicy', 'retentionPolicy', 'createdAt', 'updatedAt'
])
const WORKSPACE_PATCH_KEYS = new Set([
  'name', 'kind', 'ownerId', 'resources', 'rulesRef',
  'budgetPolicy', 'permissionPolicy', 'retentionPolicy'
])
const GOAL_KEYS = new Set([
  'id', 'projectId', 'title', 'objective', 'background', 'constraints',
  'successCriteria', 'budget', 'dueAt', 'riskLevel', 'forbiddenActions',
  'acceptance', 'acceptanceResult', 'contract', 'status', 'createdBy',
  'createdAt', 'updatedAt'
])
const GOAL_PATCH_KEYS = new Set([
  'title', 'objective', 'background', 'constraints', 'successCriteria',
  'budget', 'dueAt', 'riskLevel', 'forbiddenActions', 'acceptance',
  'acceptanceResult', 'contract', 'createdBy'
])
const WORK_ITEM_KEYS = new Set([
  'id', 'projectId', 'goalId', 'parentId', 'type', 'title', 'description',
  'dependencyIds', 'priority', 'owner', 'status', 'dueAt', 'acceptanceSpec',
  'artifactRefs', 'runRefs', 'createdAt', 'updatedAt'
])
const WORK_ITEM_PATCH_KEYS = new Set([
  'title', 'description', 'type', 'parentId', 'dependencyIds', 'priority',
  'owner', 'dueAt', 'acceptanceSpec', 'artifactRefs', 'runRefs'
])
const PROJECT_WORKSPACE_MUTATIONS = new Set([
  'create', 'update', 'archive', 'restore', 'delete', 'purge',
  'goals:create', 'goals:update', 'goals:transition', 'goals:archive', 'goals:restore', 'goals:acceptance',
  'workItems:create', 'workItems:update', 'workItems:reorder', 'workItems:transition', 'workItems:acceptance',
  'workItems:lease:acquire', 'workItems:lease:renew', 'workItems:lease:release'
])

type ProjectWorkspaceHandler = (...args: unknown[]) => unknown

const PROJECT_WORKSPACE_HANDLERS: Record<string, ProjectWorkspaceHandler> = {
  list: (rawOptions) => withStore((store) => store.listWorkspaces(normalizeListOptions(rawOptions))),
  get: (rawId) => withStore((store) => store.getWorkspace(requiredString(rawId, 'workspace id'))),
  create: (rawInput, rawOptions) => withStore((store) => store.createWorkspace(
    normalizeInput<ProjectWorkspaceInput>(rawInput, WORKSPACE_KEYS, 'workspace'),
    normalizeMutationOptions(rawOptions)
  )),
  update: (rawId, rawPatch, rawOptions) => withStore((store) => store.updateWorkspace(
    requiredString(rawId, 'workspace id'),
    normalizeInput<ProjectWorkspacePatch>(rawPatch, WORKSPACE_PATCH_KEYS, 'workspace patch'),
    normalizeMutationOptions(rawOptions)
  )),
  archive: (rawId, rawOptions) => mutateWorkspaceWithoutActiveAssignments(
    'archive', rawId, rawOptions
  ),
  restore: (rawId, rawOptions) => withStore((store) => store.restoreWorkspace(
    requiredString(rawId, 'workspace id'), normalizeMutationOptions(rawOptions)
  )),
  delete: (rawId, rawOptions) => mutateWorkspaceWithoutActiveAssignments(
    'delete', rawId, rawOptions
  ),
  purge: (rawId, rawOptions) => mutateWorkspaceWithoutActiveAssignments(
    'purge', rawId, rawOptions
  ),
  export: (rawId, rawDestination) => withStore((store) => store.exportManifest(
    requiredString(rawId, 'workspace id'), safeDestination(rawDestination)
  )),
  'goals:list': (rawProjectId, rawOptions) => withReadService((reads) => reads.listGoals(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'goals:get': (rawId) => withReadService((reads) => reads.getGoal(requiredString(rawId, 'goal id'))),
  'goals:create': (rawInput, rawOptions) => withCommandService((commands) => commands.createGoal(
    normalizeGoalInput(rawInput), normalizeMutationOptions(rawOptions)
  )),
  'goals:update': (rawId, rawPatch, rawOptions) => withCommandService((commands) => commands.updateGoal(
    requiredString(rawId, 'goal id'),
    normalizeInput<GoalPatch>(rawPatch, GOAL_PATCH_KEYS, 'goal patch'),
    normalizeMutationOptions(rawOptions)
  )),
  'goals:transition': (rawId, rawStatus, rawOptions) => transitionGoal(rawId, rawStatus, rawOptions),
  'goals:archive': (rawId, rawOptions) => withCommandService((commands) => commands.archiveGoal(
    requiredString(rawId, 'goal id'), normalizeMutationOptions(rawOptions)
  )),
  'goals:restore': (rawId, rawOptions) => withCommandService((commands) => commands.restoreGoal(
    requiredString(rawId, 'goal id'), normalizeMutationOptions(rawOptions)
  )),
  'goals:acceptance': (rawId, rawResult, rawOptions) => withCommandService((commands) => commands.setGoalAcceptance(
    requiredString(rawId, 'goal id'), normalizeAcceptance(rawResult), normalizeMutationOptions(rawOptions)
  )),
  'workItems:list': (rawProjectId, rawOptions) => withReadService((reads) => reads.listWorkItems(
    optionalString(rawProjectId), normalizeListOptions(rawOptions)
  )),
  'workItems:get': (rawId) => withReadService((reads) => reads.getWorkItem(requiredString(rawId, 'work item id'))),
  'workItems:create': (rawInput, rawOptions) => withCommandService((commands) => commands.createWorkItem(
    normalizeWorkItemInput(rawInput), normalizeMutationOptions(rawOptions)
  )),
  'workItems:update': (rawId, rawPatch, rawOptions) => updateWorkItem(rawId, rawPatch, rawOptions),
  'workItems:reorder': (rawId, rawTargetId, rawPlacement, rawOptions) => withCommandService((commands) =>
    commands.reorderWorkItem(
      requiredString(rawId, 'work item id'),
      requiredString(rawTargetId, 'work item reorder target id'),
      normalizeReorderPlacement(rawPlacement),
      normalizeMutationOptions(rawOptions)
    )),
  'workItems:transition': (rawId, rawStatus, rawOptions) => transitionWorkItem(rawId, rawStatus, rawOptions),
  'workItems:acceptance': (rawId, rawResult, rawOptions) => withCommandService((commands) => commands.setWorkItemAcceptance(
    requiredString(rawId, 'work item id'), normalizeAcceptance(rawResult), normalizeMutationOptions(rawOptions)
  )),
  'workItems:lease:acquire': (rawId, rawOptions) => withCommandService((commands) => commands.acquireWorkItemLease(
    requiredString(rawId, 'work item id'), normalizeLeaseOptions(rawOptions)
  )),
  'workItems:lease:renew': (rawId, rawOptions) => withCommandService((commands) => commands.renewWorkItemLease(
    requiredString(rawId, 'work item id'), normalizeLeaseOptions(rawOptions)
  )),
  'workItems:lease:release': (rawId, rawOptions) => withCommandService((commands) => commands.releaseWorkItemLease(
    requiredString(rawId, 'work item id'), normalizeLeaseOptions(rawOptions)
  ))
}

export function registerProjectWorkspaceIpc(): void {
  startAssignmentOwnerReadiness(app.getPath('userData'))
  ipcMain.handle('projectWorkspace:invoke', async (event, rawAction: unknown, ...args: unknown[]) => {
    assertTrustedWorkflowLedgerSender(event)
    const action = requiredString(rawAction, 'project workspace action')
    const handler = PROJECT_WORKSPACE_HANDLERS[action]
    if (!handler) throw new Error(`project workspace action is not supported: ${action}`)
    const result = await withAssignmentOwnerReadiness(app.getPath('userData'), () => handler(...args))
    if (PROJECT_WORKSPACE_MUTATIONS.has(action)) {
      await verifyProjectWorkspaceMutation(action, args, result)
    }
    return result
  })
}

async function verifyProjectWorkspaceMutation(action: string, args: unknown[], result: unknown): Promise<void> {
  const projectId = projectIdFromMutationResult(result) ?? workspaceMutationProjectId(action, args, result)
  if (!projectId) throw new Error(`project workspace mutation ${action} did not resolve a Project ID`)
  await verifyProductionProjectMutation(app.getPath('userData'), projectId, {
    allowMissingProject: action === 'purge' || action === 'delete'
  })
}

function workspaceMutationProjectId(action: string, args: unknown[], result: unknown): string | undefined {
  if (action === 'create') return recordId(result)
  if (['update', 'archive', 'restore', 'delete', 'purge'].includes(action)) {
    return optionalString(args[0])
  }
  if (action === 'goals:create' || action === 'workItems:create') {
    return isRecord(args[0]) ? optionalString(args[0].projectId) : undefined
  }
  return undefined
}

function recordId(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.id) : undefined
}

function transitionGoal(rawId: unknown, rawStatus: unknown, rawOptions: unknown): unknown {
  if (!isGoalStatus(rawStatus)) throw new Error('goal status is invalid')
  return withCommandService((commands) => commands.transitionGoal(
    requiredString(rawId, 'goal id'), rawStatus, normalizeMutationOptions(rawOptions)
  ))
}

function transitionWorkItem(rawId: unknown, rawStatus: unknown, rawOptions: unknown): unknown {
  if (!isWorkItemStatus(rawStatus)) throw new Error('work item status is invalid')
  const id = requiredString(rawId, 'work item id')
  if (rawStatus === 'done' || rawStatus === 'failed' || rawStatus === 'cancelled') {
    assertNoActiveWorkItemAssignment(id, `transition to ${rawStatus}`)
  }
  return withCommandService((commands) => commands.transitionWorkItem(
    id, rawStatus, normalizeMutationOptions(rawOptions)
  ))
}

async function updateWorkItem(rawId: unknown, rawPatch: unknown, rawOptions: unknown): Promise<unknown> {
  const id = requiredString(rawId, 'work item id')
  const patch = normalizeInput<WorkItemPatch>(rawPatch, WORK_ITEM_PATCH_KEYS, 'work item patch')
  if (Object.hasOwn(patch, 'owner')) assertActiveAssignmentOwner(id, patch.owner)
  return withCommandService((commands) => commands.updateWorkItem(id, patch, normalizeMutationOptions(rawOptions)))
}

function assertActiveAssignmentOwner(workItemId: string, rawOwner: WorkItemPatch['owner']): void {
  const assignments = new DigitalWorkerStore(app.getPath('userData')).read().assignments
  const active = assignments.find(
    (assignment) => assignment.workItemId === workItemId && assignment.status === 'active'
  )
  if (!active) return
  const owner = normalizeOwner(rawOwner)
  if (owner?.type !== active.assigneeKind || owner.id !== active.assigneeId) {
    throw new Error(`WorkItem ${workItemId} owner is controlled by active Assignment ${active.id}`)
  }
}

function mutateWorkspaceWithoutActiveAssignments(
  action: 'archive' | 'delete' | 'purge',
  rawId: unknown,
  rawOptions: unknown
): unknown {
  const id = requiredString(rawId, 'workspace id')
  assertNoActiveProjectAssignment(id, action)
  if (action === 'archive') {
    return withStore((store) => store.archiveWorkspace(id, normalizeMutationOptions(rawOptions)))
  }
  if (action === 'delete') {
    return withStore((store) => store.deleteWorkspace(id, normalizeDeleteOptions(rawOptions)))
  }
  return withStore((store) => store.purgeWorkspace(id, normalizeMutationOptions(rawOptions)))
}

function assertNoActiveProjectAssignment(projectId: string, action: string): void {
  const active = activeAssignments().find((assignment) => assignment.projectId === projectId)
  if (active) throw new Error(`Project ${projectId} cannot ${action} with active Assignment ${active.id}`)
}

function assertNoActiveWorkItemAssignment(workItemId: string, action: string): void {
  const active = activeAssignments().find((assignment) => assignment.workItemId === workItemId)
  if (active) throw new Error(`WorkItem ${workItemId} cannot ${action} with active Assignment ${active.id}`)
}

function activeAssignments() {
  return new DigitalWorkerStore(app.getPath('userData')).read().assignments
    .filter((assignment) => assignment.status === 'active')
}

async function withStore<T>(callback: (store: Awaited<ReturnType<typeof openProjectWorkspaceStore>>) => Promise<T> | T): Promise<T> {
  const store = await openProjectWorkspaceStore(app.getPath('userData'))
  return callback(store)
}

async function withCommandService<T>(
  callback: (commands: Awaited<ReturnType<typeof openProjectWorkspaceCommandService>>) => Promise<T> | T
): Promise<T> {
  const commands = await openProjectWorkspaceCommandService(app.getPath('userData'))
  return callback(commands)
}

function withReadService<T>(
  callback: (reads: ProjectWorkspaceReadService) => Promise<T> | T
): Promise<T> | T {
  return callback(createProjectWorkspaceReadService(app.getPath('userData')))
}

function normalizeInput<T>(value: unknown, keys: ReadonlySet<string>, label: string): T {
  const record = asRecord(value, `${label} input`)
  assertAllowedKeys(record, keys, label)
  return record as T
}

function normalizeGoalInput(value: unknown): GoalInput {
  const record = normalizeInput<GoalInput>(value, GOAL_KEYS, 'goal')
  if (!requiredString(record.projectId, 'goal projectId') || !requiredString(record.title, 'goal title')) {
    throw new Error('goal projectId and title are required')
  }
  if (record.riskLevel !== undefined && !isGoalRiskLevel(record.riskLevel)) throw new Error('goal riskLevel is invalid')
  if (record.status !== undefined && !isGoalStatus(record.status)) throw new Error('goal status is invalid')
  return record
}

function normalizeWorkItemInput(value: unknown): WorkItemInput {
  const record = normalizeInput<WorkItemInput>(value, WORK_ITEM_KEYS, 'work item')
  requiredString(record.projectId, 'work item projectId')
  requiredString(record.title, 'work item title')
  if (record.type !== undefined && !isWorkItemType(record.type)) throw new Error('work item type is invalid')
  if (record.status !== undefined && !isWorkItemStatus(record.status)) throw new Error('work item status is invalid')
  return record
}

function normalizeReorderPlacement(value: unknown): WorkItemReorderPlacement {
  if (value !== 'before' && value !== 'after') throw new Error('work item reorder placement must be before or after')
  return value
}

function normalizeListOptions(value: unknown): ListOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'list options')
  assertAllowedKeys(record, new Set(['includeArchived', 'includeDeleted', 'goalId']), 'list options')
  if (record.includeArchived !== undefined && typeof record.includeArchived !== 'boolean') throw new Error('includeArchived must be boolean')
  if (record.includeDeleted !== undefined && typeof record.includeDeleted !== 'boolean') throw new Error('includeDeleted must be boolean')
  return {
    includeArchived: record.includeArchived as boolean | undefined,
    includeDeleted: record.includeDeleted as boolean | undefined,
    goalId: optionalString(record.goalId)
  }
}

function normalizeMutationOptions(value: unknown): MutationOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'mutation options')
  assertAllowedKeys(record, new Set(['expectedRevision', 'expectedStoreRevision']), 'mutation options')
  return {
    ...(record.expectedRevision === undefined ? {} : { expectedRevision: nonNegativeInteger(record.expectedRevision, 'expectedRevision') }),
    ...(record.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: nonNegativeInteger(record.expectedStoreRevision, 'expectedStoreRevision') })
  }
}

function normalizeDeleteOptions(value: unknown): DeleteOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'delete options')
  assertAllowedKeys(record, new Set(['expectedRevision', 'expectedStoreRevision', 'permanent']), 'delete options')
  const mutation = normalizeMutationOptions(record)
  if (record.permanent !== undefined && typeof record.permanent !== 'boolean') throw new Error('permanent must be boolean')
  return { ...mutation, permanent: record.permanent as boolean | undefined }
}

function normalizeLeaseOptions(value: unknown): LeaseOptions {
  if (value === undefined || value === null) return {}
  const record = asRecord(value, 'lease options')
  assertAllowedKeys(record, new Set(['expectedRevision', 'expectedStoreRevision', 'leaseId', 'ownerId', 'durationMs', 'fencingToken']), 'lease options')
  const mutation = normalizeMutationOptions({
    ...(record.expectedRevision === undefined ? {} : { expectedRevision: record.expectedRevision }),
    ...(record.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: record.expectedStoreRevision })
  })
  return {
    ...mutation,
    leaseId: optionalString(record.leaseId),
    ownerId: optionalString(record.ownerId),
    ...(record.durationMs === undefined ? {} : { durationMs: positiveNumber(record.durationMs, 'durationMs') }),
    ...(record.fencingToken === undefined ? {} : { fencingToken: positiveInteger(record.fencingToken, 'fencingToken') })
  }
}

function normalizeAcceptance(value: unknown): AcceptanceResult {
  const record = asRecord(value, 'acceptance')
  assertAllowedKeys(record, new Set(['status', 'evidenceRefs', 'verifiedBy', 'verifiedAt', 'waiverReason']), 'acceptance')
  if (record.status !== 'pending' && record.status !== 'passed' && record.status !== 'failed' && record.status !== 'waived') throw new Error('acceptance status is invalid')
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('acceptance evidenceRefs must be non-empty strings')
  return {
    status: record.status,
    evidenceRefs: record.evidenceRefs.map((item) => item.trim()),
    ...(record.verifiedBy === undefined ? {} : { verifiedBy: requiredString(record.verifiedBy, 'verifiedBy') }),
    ...(record.verifiedAt === undefined ? {} : { verifiedAt: finiteNumber(record.verifiedAt, 'verifiedAt') }),
    ...(record.waiverReason === undefined ? {} : { waiverReason: requiredString(record.waiverReason, 'waiverReason') })
  }
}

function safeDestination(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const candidate = requiredString(value, 'destinationPath')
  const root = resolve(app.getPath('userData'))
  const target = resolve(candidate)
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('destinationPath must remain inside CaoGen user data')
  return target
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function assertAllowedKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new Error(`${label} contains unknown field: ${key}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown, label = 'value'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, label)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`)
  return value as number
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`)
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}
