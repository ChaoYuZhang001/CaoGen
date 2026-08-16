import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AcceptanceResult,
  Goal,
  ProjectWorkspace,
  WorkItem
} from '../../shared/project-workspace-types'
import { createProjectGoalTask } from '../project-workspace/goal-task-service'
import { ensureManagedPersonalWorkspace } from '../project-workspace/managed-personal-workspace'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { resolveWorkspaceSessionCwd } from '../project-workspace/workspace-session-cwd'
import { taskSnapshotsDbFile } from './task-snapshot'

const SYSTEM_OWNER = { type: 'human' as const, id: 'local-user', displayName: 'Local User' }
const DEFAULT_LEASE_DURATION_MS = 15 * 60 * 1_000
const MAX_MUTATION_ATTEMPTS = 8

export interface PrepareCanonicalSystemOperationInput {
  rootDir: string
  requestId: string
  objective: string
  workspaceId?: string
  cwd?: string
  leaseDurationMs?: number
}

export interface CanonicalSystemOperationContext {
  rootDir: string
  requestId: string
  cwd: string
  workspaceId: string
  projectId: string
  goalId: string
  workItemId: string
  leaseId: string
  ownerId: typeof SYSTEM_OWNER.id
}

export interface CanonicalSystemOperationSettlementContext {
  rootDir?: string
  goalId: string
  workItemId: string
}

export async function prepareCanonicalSystemOperation(
  rawInput: PrepareCanonicalSystemOperationInput
): Promise<CanonicalSystemOperationContext> {
  const input = normalizePrepareInput(rawInput)
  const scope = await resolveOperationScope(input)
  const created = await createProjectGoalTask({
    requestId: input.requestId,
    projectId: scope.workspace.id,
    objective: input.objective
  }, input.rootDir, { workItemOwner: SYSTEM_OWNER })
  const leaseId = systemLeaseId(scope.workspace.id, input.requestId)
  await makeWorkItemRunnable(
    input.rootDir,
    created.workItem.id,
    leaseId,
    input.leaseDurationMs
  )
  return {
    rootDir: input.rootDir,
    requestId: input.requestId,
    cwd: scope.cwd,
    workspaceId: scope.workspace.id,
    projectId: scope.workspace.id,
    goalId: created.goal.id,
    workItemId: created.workItem.id,
    leaseId,
    ownerId: SYSTEM_OWNER.id
  }
}

export async function settleCanonicalSystemOperation(
  context: CanonicalSystemOperationSettlementContext,
  input: {
    status: 'passed' | 'failed'
    evidenceRefs: string[]
    verifiedBy: string
  }
): Promise<{ goal: Goal; workItem: WorkItem }> {
  const resolvedContext = {
    ...context,
    rootDir: context.rootDir || dirname(taskSnapshotsDbFile())
  }
  const acceptance = operationAcceptance(input)
  const workItem = await settleWorkItem(resolvedContext, acceptance)
  const goal = await settleGoal(resolvedContext, acceptance)
  return { goal, workItem }
}

export async function resolveCanonicalWorkspaceIdForPath(
  rootDir: string,
  rawPath: string
): Promise<string | undefined> {
  const target = resolve(requiredText(rawPath, 'path'))
  const workspaces = await (await openProjectWorkspaceStore(rootDir)).listWorkspaces()
  const matches = workspaces.flatMap((workspace) => workspace.status === 'active'
    ? workspace.resources.flatMap((resource) => resource.path
      ? [{ workspaceId: workspace.id, root: resolve(resource.path) }]
      : [])
    : [])
    .filter((candidate) => pathWithin(candidate.root, target))
    .sort((left, right) => right.root.length - left.root.length || left.workspaceId.localeCompare(right.workspaceId))
  const longest = matches[0]
  if (!longest) return undefined
  const ambiguous = matches.find((candidate) =>
    candidate.root.length === longest.root.length && candidate.workspaceId !== longest.workspaceId)
  if (ambiguous) throw new Error(`path belongs to multiple canonical Workspaces:${target}`)
  return longest.workspaceId
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function resolveOperationScope(
  input: ReturnType<typeof normalizePrepareInput>
): Promise<{ cwd: string; workspace: ProjectWorkspace }> {
  if (!input.workspaceId) {
    const managed = await ensureManagedPersonalWorkspace(input.rootDir)
    return { cwd: input.cwd ?? managed.cwd, workspace: managed.workspace }
  }
  const store = await openProjectWorkspaceStore(input.rootDir)
  const workspace = await store.getWorkspace(input.workspaceId)
  if (!workspace || workspace.status !== 'active') {
    throw new Error(`canonical system operation Workspace is unavailable:${input.workspaceId}`)
  }
  return {
    cwd: input.cwd ?? await resolveWorkspaceSessionCwd(workspace.id, input.rootDir),
    workspace
  }
}

async function makeWorkItemRunnable(
  rootDir: string,
  workItemId: string,
  leaseId: string,
  durationMs: number
): Promise<void> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const store = await openProjectWorkspaceStore(rootDir)
    const item = await store.getWorkItem(workItemId)
    if (!item) throw new Error(`canonical system operation WorkItem is missing:${workItemId}`)
    const commands = await openProjectWorkspaceCommandService(rootDir)
    try {
      if (!item.owner) {
        await commands.updateWorkItem(item.id, { owner: SYSTEM_OWNER }, { expectedRevision: item.revision })
        continue
      }
      if (item.owner.type !== SYSTEM_OWNER.type || item.owner.id !== SYSTEM_OWNER.id) {
        throw new Error(`canonical system operation WorkItem owner conflict:${item.id}`)
      }
      if (item.status === 'blocked') {
        await commands.transitionWorkItem(item.id, 'ready', { expectedRevision: item.revision })
        continue
      }
      if (item.status !== 'ready' && item.status !== 'running') {
        throw new Error(`canonical system operation WorkItem is not runnable:${item.id}:${item.status}`)
      }
      const now = Date.now()
      if (!item.lease || item.lease.expiresAt <= now) {
        await commands.acquireWorkItemLease(item.id, {
          expectedRevision: item.revision,
          leaseId,
          ownerId: SYSTEM_OWNER.id,
          durationMs
        })
        continue
      }
      if (item.lease.id !== leaseId || item.lease.ownerId !== SYSTEM_OWNER.id) {
        throw new Error(`canonical system operation WorkItem lease conflict:${item.id}`)
      }
      if (item.lease.expiresAt - now < durationMs / 2) {
        await commands.renewWorkItemLease(item.id, {
          expectedRevision: item.revision,
          leaseId,
          ownerId: SYSTEM_OWNER.id,
          fencingToken: item.lease.fencingToken,
          durationMs
        })
        continue
      }
      if (item.status === 'ready') {
        await commands.transitionWorkItem(item.id, 'running', { expectedRevision: item.revision })
      }
      return
    } catch (error) {
      if (attempt < MAX_MUTATION_ATTEMPTS - 1 && isStaleRevision(error)) continue
      throw error
    }
  }
  throw new Error(`canonical system operation WorkItem preparation retry exhausted:${workItemId}`)
}

async function settleWorkItem(
  context: CanonicalSystemOperationSettlementContext,
  acceptance: AcceptanceResult
): Promise<WorkItem> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const store = await openProjectWorkspaceStore(context.rootDir)
    const item = await store.getWorkItem(context.workItemId)
    if (!item) throw new Error(`canonical system operation WorkItem is missing:${context.workItemId}`)
    if (item.status === 'done' || item.status === 'failed') return item
    const commands = await openProjectWorkspaceCommandService(context.rootDir)
    try {
      if (acceptance.status === 'failed') {
        if (item.acceptance?.status !== 'failed') {
          await commands.setWorkItemAcceptance(item.id, acceptance, { expectedRevision: item.revision })
          continue
        }
        if (item.status === 'running') {
          await commands.transitionWorkItem(item.id, 'blocked', { expectedRevision: item.revision })
          continue
        }
        if (item.status === 'blocked') {
          return await commands.transitionWorkItem(item.id, 'failed', { expectedRevision: item.revision })
        }
        throw new Error(`canonical system operation WorkItem cannot fail from ${item.status}:${item.id}`)
      }
      if (item.status === 'running') {
        await commands.transitionWorkItem(item.id, 'verifying', { expectedRevision: item.revision })
        continue
      }
      if (item.acceptance?.status !== 'passed') {
        await commands.setWorkItemAcceptance(item.id, acceptance, { expectedRevision: item.revision })
        continue
      }
      if (item.status === 'verifying') {
        return await commands.transitionWorkItem(item.id, 'done', { expectedRevision: item.revision })
      }
      throw new Error(`canonical system operation WorkItem cannot complete from ${item.status}:${item.id}`)
    } catch (error) {
      if (attempt < MAX_MUTATION_ATTEMPTS - 1 && isStaleRevision(error)) continue
      throw error
    }
  }
  throw new Error(`canonical system operation WorkItem settlement retry exhausted:${context.workItemId}`)
}

async function settleGoal(
  context: CanonicalSystemOperationSettlementContext,
  acceptance: AcceptanceResult
): Promise<Goal> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const store = await openProjectWorkspaceStore(context.rootDir)
    const goal = await store.getGoal(context.goalId)
    if (!goal) throw new Error(`canonical system operation Goal is missing:${context.goalId}`)
    if (goal.status === 'completed' || goal.status === 'failed') return goal
    const commands = await openProjectWorkspaceCommandService(context.rootDir)
    try {
      if (goal.acceptanceResult?.status !== acceptance.status) {
        await commands.setGoalAcceptance(goal.id, acceptance, { expectedRevision: goal.revision })
        continue
      }
      if (acceptance.status === 'failed') {
        if (goal.status === 'running') {
          await commands.transitionGoal(goal.id, 'blocked', { expectedRevision: goal.revision })
          continue
        }
        if (goal.status === 'blocked') {
          return await commands.transitionGoal(goal.id, 'failed', { expectedRevision: goal.revision })
        }
        throw new Error(`canonical system operation Goal cannot fail from ${goal.status}:${goal.id}`)
      }
      if (goal.status === 'running') {
        await commands.transitionGoal(goal.id, 'verifying', { expectedRevision: goal.revision })
        continue
      }
      if (goal.status === 'verifying') {
        return await commands.transitionGoal(goal.id, 'completed', { expectedRevision: goal.revision })
      }
      throw new Error(`canonical system operation Goal cannot complete from ${goal.status}:${goal.id}`)
    } catch (error) {
      if (attempt < MAX_MUTATION_ATTEMPTS - 1 && isStaleRevision(error)) continue
      throw error
    }
  }
  throw new Error(`canonical system operation Goal settlement retry exhausted:${context.goalId}`)
}

function operationAcceptance(input: {
  status: 'passed' | 'failed'
  evidenceRefs: string[]
  verifiedBy: string
}): AcceptanceResult {
  const evidenceRefs = [...new Set(input.evidenceRefs.map((value) => requiredText(value, 'evidenceRef')))]
  if (evidenceRefs.length === 0) throw new Error('canonical system operation settlement requires Evidence')
  return {
    status: input.status,
    evidenceRefs,
    verifiedBy: requiredText(input.verifiedBy, 'verifiedBy'),
    verifiedAt: Date.now()
  }
}

function normalizePrepareInput(input: PrepareCanonicalSystemOperationInput): {
  rootDir: string
  requestId: string
  objective: string
  workspaceId?: string
  cwd?: string
  leaseDurationMs: number
} {
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0 || leaseDurationMs > 86_400_000) {
    throw new Error('canonical system operation leaseDurationMs is invalid')
  }
  return {
    rootDir: resolve(requiredText(input.rootDir, 'rootDir')),
    requestId: requiredText(input.requestId, 'requestId'),
    objective: requiredText(input.objective, 'objective'),
    ...(input.workspaceId ? { workspaceId: requiredText(input.workspaceId, 'workspaceId') } : {}),
    ...(input.cwd ? { cwd: resolve(requiredText(input.cwd, 'cwd')) } : {}),
    leaseDurationMs
  }
}

function systemLeaseId(workspaceId: string, requestId: string): string {
  const digest = createHash('sha256')
    .update(`caogen.system-operation-lease.v1\0${workspaceId}\0${requestId}`)
    .digest('hex')
    .slice(0, 32)
  return `system-operation-lease-${digest}`
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const clean = value.trim()
  if (!clean || clean.length > 20_000 || /[\0-\x1f\x7f]/.test(clean)) throw new Error(`${label} is invalid`)
  return clean
}

function isStaleRevision(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'stale_revision')
}
