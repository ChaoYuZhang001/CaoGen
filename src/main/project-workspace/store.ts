import type {
  AcceptanceResult,
  Goal,
  GoalContract,
  GoalInput,
  GoalPatch,
  GoalStatus,
  MutationOptions,
  ProjectWorkspace,
  ProjectWorkspaceInput,
  ProjectWorkspaceManifest,
  ProjectWorkspacePatch,
  ProjectWorkspaceState,
  WorkItem,
  WorkItemInput,
  WorkItemPatch,
  WorkItemReorderPlacement,
  WorkItemStatus
} from '../../shared/project-workspace-types'
import { GoalRepository } from './goal-repository'
import {
  ProjectWorkspacePersistence,
  resolveProjectWorkspaceRoot
} from './persistence'
import type { ProjectWorkspaceBeforeCommit } from './persistence'
import type { DeleteOptions, LeaseOptions, ListOptions } from './repository-types'
import { WorkItemRepository } from './work-item-repository'
import { WorkspaceRepository } from './workspace-repository'

export { canonicalJson } from './codec'
export { ProjectWorkspaceError } from './errors'
export {
  PROJECT_WORKSPACE_FORMAT,
  projectWorkspaceFile,
  projectWorkspaceLockFile
} from './persistence'
export type { DeleteOptions, LeaseOptions, ListOptions } from './repository-types'

export class ProjectWorkspaceStore {
  readonly rootDir: string
  readonly filePath: string
  private readonly persistence: ProjectWorkspacePersistence
  private readonly workspaces: WorkspaceRepository
  private readonly goals: GoalRepository
  private readonly workItems: WorkItemRepository

  constructor(rootDir?: string) {
    this.persistence = new ProjectWorkspacePersistence(rootDir)
    this.rootDir = this.persistence.rootDir
    this.filePath = this.persistence.filePath
    this.workspaces = new WorkspaceRepository(this.persistence)
    this.goals = new GoalRepository(this.persistence)
    this.workItems = new WorkItemRepository(this.persistence)
  }

  async open(): Promise<this> {
    await this.persistence.open()
    return this
  }

  getState(): Promise<ProjectWorkspaceState> {
    return this.persistence.read()
  }

  getRevision(): Promise<number> {
    return this.persistence.revision()
  }

  createWorkspace(input: ProjectWorkspaceInput, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.create(input, options)
  }

  getWorkspace(id: string): Promise<ProjectWorkspace | undefined> {
    return this.workspaces.get(id)
  }

  listWorkspaces(options?: ListOptions): Promise<ProjectWorkspace[]> {
    return this.workspaces.list(options)
  }

  updateWorkspace(id: string, patch: ProjectWorkspacePatch, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.update(id, patch, options)
  }

  archiveWorkspace(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.archive(id, options)
  }

  restoreWorkspace(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.restore(id, options)
  }

  deleteWorkspace(id: string, options?: DeleteOptions): Promise<ProjectWorkspace | undefined> {
    return this.workspaces.delete(id, options)
  }

  purgeWorkspace(id: string, options?: MutationOptions | number): Promise<undefined> {
    return this.workspaces.purge(id, options)
  }

  reopenWorkspace(id: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
    return this.workspaces.restore(id, options)
  }

  exportManifest(id: string, destinationPath?: string): Promise<ProjectWorkspaceManifest> {
    return this.workspaces.exportManifest(id, destinationPath)
  }

  exportWorkspaceManifest(id: string, destinationPath?: string): Promise<ProjectWorkspaceManifest> {
    return this.workspaces.exportManifest(id, destinationPath)
  }

  createGoal(input: GoalInput, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.create(input, options)
  }

  getGoal(id: string): Promise<Goal | undefined> {
    return this.goals.get(id)
  }

  listGoals(projectId?: string, options?: ListOptions): Promise<Goal[]> {
    return this.goals.list(projectId, options)
  }

  updateGoal(id: string, patch: GoalPatch, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.update(id, patch, options)
  }

  setGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.setAcceptance(id, result, options)
  }

  recordGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.setAcceptance(id, result, options)
  }

  transitionGoal(id: string, status: GoalStatus, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.transition(id, status, options)
  }

  archiveGoal(id: string, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.archive(id, options)
  }

  restoreGoal(id: string, options?: MutationOptions | number): Promise<Goal> {
    return this.goals.restore(id, options)
  }

  createWorkItem(input: WorkItemInput, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.create(input, options)
  }

  getWorkItem(id: string): Promise<WorkItem | undefined> {
    return this.workItems.get(id)
  }

  listWorkItems(projectId?: string, options?: ListOptions): Promise<WorkItem[]> {
    return this.workItems.list(projectId, options)
  }

  updateWorkItem(id: string, patch: WorkItemPatch, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.update(id, patch, options)
  }

  reorderWorkItem(
    id: string,
    targetId: string,
    placement: WorkItemReorderPlacement,
    options?: MutationOptions | number
  ): Promise<WorkItem> {
    return this.workItems.reorder(id, targetId, placement, options)
  }

  setWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.setAcceptance(id, result, options)
  }

  recordWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.setAcceptance(id, result, options)
  }

  transitionWorkItem(id: string, status: WorkItemStatus, options?: MutationOptions | number): Promise<WorkItem> {
    return this.workItems.transition(id, status, options)
  }

  acquireWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    return this.workItems.acquireLease(id, options)
  }

  renewWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    return this.workItems.renewLease(id, options)
  }

  releaseWorkItemLease(id: string, options?: LeaseOptions): Promise<WorkItem> {
    return this.workItems.releaseLease(id, options)
  }

  getEffectiveWorkItemContract(id: string): Promise<GoalContract | undefined> {
    return this.workItems.effectiveContract(id)
  }

  withBeforeCommit<T>(hook: ProjectWorkspaceBeforeCommit, callback: () => Promise<T>): Promise<T> {
    return this.persistence.withBeforeCommit(hook, callback)
  }
}

const stores = new Map<string, ProjectWorkspaceStore>()

export function getProjectWorkspaceStore(rootDir?: string): ProjectWorkspaceStore {
  const normalizedRoot = resolveProjectWorkspaceRoot(rootDir)
  const existing = stores.get(normalizedRoot)
  if (existing) return existing
  const store = new ProjectWorkspaceStore(normalizedRoot)
  stores.set(normalizedRoot, store)
  return store
}

export async function openProjectWorkspaceStore(rootDir?: string): Promise<ProjectWorkspaceStore> {
  return getProjectWorkspaceStore(rootDir).open()
}

export async function createProjectWorkspace(
  input: ProjectWorkspaceInput,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).createWorkspace(input, options)
}

export async function getProjectWorkspace(id: string, rootDir?: string): Promise<ProjectWorkspace | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getWorkspace(id)
}

export async function listProjectWorkspaces(rootDir?: string, options?: ListOptions): Promise<ProjectWorkspace[]> {
  return (await openProjectWorkspaceStore(rootDir)).listWorkspaces(options)
}

export async function updateProjectWorkspace(
  id: string,
  patch: ProjectWorkspacePatch,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).updateWorkspace(id, patch, options)
}

export async function archiveProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).archiveWorkspace(id, options)
}

export async function restoreProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
  return (await openProjectWorkspaceStore(rootDir)).restoreWorkspace(id, options)
}

export async function reopenProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<ProjectWorkspace> {
  return restoreProjectWorkspace(id, rootDir, options)
}

export async function deleteProjectWorkspace(id: string, rootDir?: string, options?: DeleteOptions): Promise<ProjectWorkspace | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).deleteWorkspace(id, options)
}

export async function purgeProjectWorkspace(id: string, rootDir?: string, options?: MutationOptions | number): Promise<undefined> {
  return (await openProjectWorkspaceStore(rootDir)).purgeWorkspace(id, options)
}

export async function exportProjectWorkspaceManifest(
  id: string,
  rootDir?: string,
  destinationPath?: string
): Promise<ProjectWorkspaceManifest> {
  return (await openProjectWorkspaceStore(rootDir)).exportManifest(id, destinationPath)
}

export async function createGoal(input: GoalInput, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).createGoal(input, options)
}

export async function getGoal(id: string, rootDir?: string): Promise<Goal | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getGoal(id)
}

export async function listGoals(projectId?: string, rootDir?: string, options?: ListOptions): Promise<Goal[]> {
  return (await openProjectWorkspaceStore(rootDir)).listGoals(projectId, options)
}

export async function updateGoal(id: string, patch: GoalPatch, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).updateGoal(id, patch, options)
}

export async function transitionGoal(id: string, status: GoalStatus, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).transitionGoal(id, status, options)
}

export async function archiveGoal(id: string, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).archiveGoal(id, options)
}

export async function restoreGoal(id: string, rootDir?: string, options?: MutationOptions | number): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).restoreGoal(id, options)
}

export async function setGoalAcceptance(
  id: string,
  result: AcceptanceResult,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<Goal> {
  return (await openProjectWorkspaceStore(rootDir)).setGoalAcceptance(id, result, options)
}

export async function createWorkItem(input: WorkItemInput, rootDir?: string, options?: MutationOptions | number): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).createWorkItem(input, options)
}

export async function getWorkItem(id: string, rootDir?: string): Promise<WorkItem | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getWorkItem(id)
}

export async function listWorkItems(projectId?: string, rootDir?: string, options?: ListOptions): Promise<WorkItem[]> {
  return (await openProjectWorkspaceStore(rootDir)).listWorkItems(projectId, options)
}

export async function updateWorkItem(
  id: string,
  patch: WorkItemPatch,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).updateWorkItem(id, patch, options)
}

export async function reorderWorkItem(
  id: string,
  targetId: string,
  placement: WorkItemReorderPlacement,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).reorderWorkItem(id, targetId, placement, options)
}

export async function transitionWorkItem(
  id: string,
  status: WorkItemStatus,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).transitionWorkItem(id, status, options)
}

export async function setWorkItemAcceptance(
  id: string,
  result: AcceptanceResult,
  rootDir?: string,
  options?: MutationOptions | number
): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).setWorkItemAcceptance(id, result, options)
}

export async function acquireWorkItemLease(id: string, rootDir?: string, options?: LeaseOptions): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).acquireWorkItemLease(id, options)
}

export async function renewWorkItemLease(id: string, rootDir?: string, options?: LeaseOptions): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).renewWorkItemLease(id, options)
}

export async function releaseWorkItemLease(id: string, rootDir?: string, options?: LeaseOptions): Promise<WorkItem> {
  return (await openProjectWorkspaceStore(rootDir)).releaseWorkItemLease(id, options)
}

export async function getEffectiveWorkItemContract(id: string, rootDir?: string): Promise<GoalContract | undefined> {
  return (await openProjectWorkspaceStore(rootDir)).getEffectiveWorkItemContract(id)
}

export { ProjectWorkspaceStore as ProjectWorkspaceRepository }
