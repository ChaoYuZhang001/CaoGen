import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Goal, GoalStatus, WorkItem, WorkItemStatus } from '../../shared/project-workspace-types'
import { AssignmentOwnerCoordinator } from '../assignment-owner-coordinator/coordinator'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { resolveWorkspaceSessionCwd } from '../project-workspace/workspace-session-cwd'
import type { Routine } from '../routineStore'
import type { RoutineRunRecord } from './routine-runner'

export interface RoutineProjectExecution {
  cwd: string
  projectId?: string
  goalId?: string
  workItemId?: string
}

export type RoutineProjectExecutionPlanned = (execution: Readonly<RoutineProjectExecution>) => Promise<void>

const ROUTINE_LEASE_MS = 86_400_000

export async function prepareRoutineProjectExecution(
  workspaceRoot: string,
  routine: Routine,
  run: Pick<RoutineRunRecord, 'id'>,
  onPlanned?: RoutineProjectExecutionPlanned
): Promise<RoutineProjectExecution> {
  if (!routine.projectId) {
    const cwd = routine.projectCwd?.trim()
    if (!cwd) throw new Error(`Routine ${routine.id} has neither canonical Project nor execution directory`)
    const execution = { cwd }
    await onPlanned?.(execution)
    return execution
  }

  const store = await openProjectWorkspaceStore(workspaceRoot)
  const workspace = await store.getWorkspace(routine.projectId)
  if (!workspace) throw new Error(`Routine Project does not exist:${routine.projectId}`)
  if (workspace.status !== 'active') {
    throw new Error(`Routine Project is not active:${routine.projectId}:${workspace.status}`)
  }
  const cwd = routine.projectCwd?.trim() || await resolveWorkspaceSessionCwd(workspace.id, workspaceRoot)
  const workItemId = routineWorkItemId(workspace.id, routine.id, run.id)
  const goalId = routine.goalTemplateId ? routineGoalId(workspace.id, routine.id, run.id) : undefined
  const execution = { cwd, projectId: workspace.id, goalId, workItemId }
  await onPlanned?.(execution)
  const goal = routine.goalTemplateId
    ? await instantiateRoutineGoal(workspaceRoot, routine, goalId!)
    : undefined
  const existing = await store.getWorkItem(workItemId)
  let workItem = existing ?? await createRoutineWorkItem(
    workspaceRoot,
    routine,
    run.id,
    workItemId,
    workspace.ownerId,
    goal?.id
  )
  assertRoutineWorkItem(workItem, routine, workItemId, goal?.id)

  if (routine.digitalWorkerId) {
    const coordinator = new AssignmentOwnerCoordinator({ rootDir: workspaceRoot })
    const result = await coordinator.createAssignment({
      requestId: `routine-assignment:${run.id}`,
      input: {
        id: `routine-assignment-${digestId(workspace.id, routine.id, run.id)}`,
        projectId: workspace.id,
        workItemId: workItem.id,
        assigneeKind: 'digital_worker',
        assigneeId: routine.digitalWorkerId,
        assignedBy: `routine:${routine.id}`,
        scope: { routineId: routine.id, routineRunId: run.id },
        reason: `Routine ${routine.name}`
      }
    })
    workItem = result.workItem
  }

  workItem = await ensureRoutineLease(workspaceRoot, workItem, run.id)
  return execution
}

export async function transitionRoutineWorkItem(
  workspaceRoot: string,
  workItemId: string | undefined,
  target: 'running' | 'waiting_approval' | 'verifying' | 'failed'
): Promise<WorkItem | undefined> {
  if (!workItemId) return undefined
  const store = await openProjectWorkspaceStore(workspaceRoot)
  let item = await store.getWorkItem(workItemId)
  if (!item) throw new Error(`Routine WorkItem does not exist:${workItemId}`)
  const commands = await openProjectWorkspaceCommandService(workspaceRoot)
  const transitionGoal = async (): Promise<void> => {
    if (!item?.goalId) return
    await transitionRoutineGoal(workspaceRoot, item.goalId, target)
  }
  if (target === 'running') {
    if (item.status === 'blocked') {
      item = await commands.transitionWorkItem(item.id, 'ready', { expectedRevision: item.revision })
    }
    if (item.status === 'waiting_approval' || item.status === 'ready') {
      if (item.status === 'ready') item = await ensureRoutineLease(workspaceRoot, item, item.id)
      item = await commands.transitionWorkItem(item.id, 'running', { expectedRevision: item.revision })
      await transitionGoal()
      return item
    }
    await transitionGoal()
    return item
  }
  if (target === 'waiting_approval') {
    if (item.status === 'running') {
      item = await commands.transitionWorkItem(item.id, 'waiting_approval', { expectedRevision: item.revision })
    }
    await transitionGoal()
    return item
  }
  if (target === 'verifying') {
    if (item.status === 'waiting_approval') {
      item = await commands.transitionWorkItem(item.id, 'running', { expectedRevision: item.revision })
    }
    if (item.status === 'running') {
      item = await commands.transitionWorkItem(item.id, 'verifying', { expectedRevision: item.revision })
    }
    await transitionGoal()
    return item
  }
  if (item.status === 'ready') {
    item = await ensureRoutineLease(workspaceRoot, item, item.id)
    item = await commands.transitionWorkItem(item.id, 'running', { expectedRevision: item.revision })
  }
  if (item.status === 'running' || item.status === 'waiting_approval') {
    item = await commands.transitionWorkItem(item.id, 'blocked', { expectedRevision: item.revision })
  }
  if (item.status === 'blocked') {
    item = await commands.transitionWorkItem(item.id, 'failed', { expectedRevision: item.revision })
  }
  await transitionGoal()
  return item
}

async function instantiateRoutineGoal(
  workspaceRoot: string,
  routine: Routine,
  goalId: string
): Promise<Goal> {
  const store = await openProjectWorkspaceStore(workspaceRoot)
  const template = await store.getGoal(routine.goalTemplateId!)
  if (!template) throw new Error(`Routine Goal template does not exist:${routine.goalTemplateId}`)
  if (template.projectId !== routine.projectId) {
    throw new Error(`Routine Goal template belongs to another Project:${template.id}`)
  }
  const existing = await store.getGoal(goalId)
  if (existing) {
    assertRoutineGoal(existing, routine, template, goalId)
    return existing
  }
  const commands = await openProjectWorkspaceCommandService(workspaceRoot)
  try {
    return await commands.createGoal({
      id: goalId,
      projectId: template.projectId,
      title: routineGoalTitle(routine.name, template.title),
      contract: structuredClone(template.contract),
      status: 'running',
      createdBy: `routine:${routine.id}`
    })
  } catch (error) {
    const recovered = await (await openProjectWorkspaceStore(workspaceRoot)).getGoal(goalId)
    if (!recovered) throw error
    assertRoutineGoal(recovered, routine, template, goalId)
    return recovered
  }
}

export async function transitionRoutineGoal(
  workspaceRoot: string,
  goalId: string,
  target: 'running' | 'waiting_approval' | 'verifying' | 'failed'
): Promise<void> {
  const store = await openProjectWorkspaceStore(workspaceRoot)
  let goal = await store.getGoal(goalId)
  if (!goal) throw new Error(`Routine Goal does not exist:${goalId}`)
  const commands = await openProjectWorkspaceCommandService(workspaceRoot)
  if (target === 'running') {
    if (goal.status === 'waiting_approval' || goal.status === 'blocked') {
      await commands.transitionGoal(goal.id, 'running', { expectedRevision: goal.revision })
    }
    return
  }
  if (target === 'waiting_approval') {
    if (goal.status === 'running') {
      await commands.transitionGoal(goal.id, 'waiting_approval', { expectedRevision: goal.revision })
    }
    return
  }
  if (target === 'verifying') {
    if (goal.status === 'waiting_approval') {
      goal = await commands.transitionGoal(goal.id, 'running', { expectedRevision: goal.revision })
    }
    if (goal.status === 'running') {
      await commands.transitionGoal(goal.id, 'verifying', { expectedRevision: goal.revision })
    }
    return
  }
  if (goal.status === 'running' || goal.status === 'waiting_approval') {
    goal = await commands.transitionGoal(goal.id, 'blocked', { expectedRevision: goal.revision })
  }
  if (goal.status === 'blocked' || goal.status === 'verifying') {
    await commands.transitionGoal(goal.id, 'failed', { expectedRevision: goal.revision })
  }
}

async function createRoutineWorkItem(
  workspaceRoot: string,
  routine: Routine,
  runId: string,
  workItemId: string,
  projectOwnerId: string | undefined,
  goalId: string | undefined
): Promise<WorkItem> {
  const commands = await openProjectWorkspaceCommandService(workspaceRoot)
  const owner = routine.digitalWorkerId
    ? undefined
    : { type: 'human' as const, id: projectOwnerId?.trim() || 'local-user', displayName: 'Local user' }
  try {
    return await commands.createWorkItem({
      id: workItemId,
      projectId: routine.projectId!,
      ...(goalId ? { goalId } : {}),
      type: 'operations',
      title: routineWorkItemTitle(routine.name),
      description: routine.prompt,
      status: 'ready',
      owner,
      ...(goalId ? {} : { acceptanceSpec: [] })
    })
  } catch (error) {
    const recovered = await (await openProjectWorkspaceStore(workspaceRoot)).getWorkItem(workItemId)
    if (!recovered) throw error
    assertRoutineWorkItem(recovered, routine, workItemId, goalId)
    return recovered
  }
}

async function ensureRoutineLease(
  workspaceRoot: string,
  item: WorkItem,
  runId: string
): Promise<WorkItem> {
  if (!item.owner) throw new Error(`Routine WorkItem has no owner:${item.id}`)
  if (item.status !== 'ready' && item.status !== 'running') return item
  const now = Date.now()
  if (item.lease && item.lease.expiresAt > now && item.lease.ownerId === item.owner.id) return item
  const commands = await openProjectWorkspaceCommandService(workspaceRoot)
  return commands.acquireWorkItemLease(item.id, {
    ownerId: item.owner.id,
    leaseId: `routine-lease-${digestId(item.projectId, item.id, runId)}`,
    durationMs: ROUTINE_LEASE_MS,
    expectedRevision: item.revision
  })
}

function assertRoutineWorkItem(
  item: WorkItem,
  routine: Routine,
  expectedId: string,
  expectedGoalId: string | undefined
): void {
  if (item.id !== expectedId || item.projectId !== routine.projectId || item.title !== routineWorkItemTitle(routine.name) ||
      item.description !== routine.prompt || item.type !== 'operations' || item.goalId !== expectedGoalId) {
    throw new Error(`Routine WorkItem identity conflict:${expectedId}`)
  }
  if (isTerminal(item.status)) throw new Error(`Routine WorkItem is terminal:${item.id}:${item.status}`)
}

function assertRoutineGoal(goal: Goal, routine: Routine, template: Goal, expectedId: string): void {
  if (goal.id !== expectedId || goal.projectId !== routine.projectId ||
      goal.title !== routineGoalTitle(routine.name, template.title) ||
      goal.createdBy !== `routine:${routine.id}` ||
      !isDeepStrictEqual(goal.contract, template.contract)) {
    throw new Error(`Routine Goal identity conflict:${expectedId}`)
  }
  if (isTerminalGoal(goal.status)) throw new Error(`Routine Goal is terminal:${goal.id}:${goal.status}`)
}

function routineWorkItemId(projectId: string, routineId: string, runId: string): string {
  return `routine-work-item-${digestId(projectId, routineId, runId)}`
}

function routineGoalId(projectId: string, routineId: string, runId: string): string {
  return `routine-goal-${digestId(projectId, routineId, runId)}`
}

function digestId(...parts: string[]): string {
  return createHash('sha256').update(['caogen.routine-run.v1', ...parts].join('\0')).digest('hex').slice(0, 24)
}

function routineWorkItemTitle(name: string): string {
  const title = `Routine: ${name}`.replace(/\s+/g, ' ').trim()
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`
}

function routineGoalTitle(routineName: string, templateTitle: string): string {
  const title = `${routineName}: ${templateTitle}`.replace(/\s+/g, ' ').trim()
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`
}

function isTerminal(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function isTerminalGoal(status: GoalStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'archived'
}
