import { ipcRenderer } from 'electron'
import type {
  AcceptanceResult,
  AgentDeskApi,
  GoalInput,
  GoalPatch,
  GoalStatus,
  MutationOptions,
  ProjectGoalTaskInput,
  ProjectSquadCreateInput,
  ProjectSquadMemberInput,
  ProjectSquadPatch,
  ProjectWorkItemCommentCreateInput,
  ProjectWorkspaceDeleteOptions,
  ProjectWorkspaceInput,
  ProjectWorkspaceLeaseOptions,
  ProjectWorkspaceListOptions,
  ProjectWorkspacePatch,
  WorkItemInput,
  WorkItemCommentPatch,
  WorkItemOwnerType,
  WorkItemTransferInput,
  WorkItemPatch,
  WorkItemReorderPlacement,
  WorkItemStatus
} from '../shared/types'

const invokeProjectWorkspace = (action: string, ...args: unknown[]) =>
  ipcRenderer.invoke('projectWorkspace:invoke', action, ...args)

/** Renderer-safe bridge for the native ProjectWorkspace domain. */
export const projectWorkspaceApi: Pick<AgentDeskApi,
  | 'listProjectWorkspaces' | 'getProjectWorkspace' | 'createProjectWorkspace'
  | 'updateProjectWorkspace' | 'archiveProjectWorkspace' | 'restoreProjectWorkspace'
  | 'deleteProjectWorkspace' | 'purgeProjectWorkspace' | 'exportProjectWorkspaceManifest'
  | 'exportProjectWorkspaceData'
  | 'importProjectWorkspaceData'
  | 'listProjectGoals' | 'getProjectGoal' | 'createProjectGoal' | 'updateProjectGoal'
  | 'transitionProjectGoal' | 'archiveProjectGoal' | 'restoreProjectGoal'
  | 'setProjectGoalAcceptance' | 'listProjectWorkItems' | 'getProjectWorkItem'
  | 'createProjectWorkItem' | 'updateProjectWorkItem' | 'transitionProjectWorkItem'
  | 'transferProjectWorkItem'
  | 'createProjectGoalTask'
  | 'reorderProjectWorkItem'
  | 'setProjectWorkItemAcceptance' | 'acquireProjectWorkItemLease'
  | 'renewProjectWorkItemLease' | 'releaseProjectWorkItemLease'
  | 'listProjectSquads' | 'getProjectSquad' | 'createProjectSquad' | 'updateProjectSquad'
  | 'archiveProjectSquad' | 'restoreProjectSquad' | 'addProjectSquadMember' | 'removeProjectSquadMember'
  | 'listProjectComments' | 'listProjectWorkItemComments' | 'createProjectWorkItemComment'
  | 'updateProjectWorkItemComment' | 'deleteProjectWorkItemComment'
> = {
  listProjectWorkspaces: (options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('list', options),
  getProjectWorkspace: (id: string) => invokeProjectWorkspace('get', id),
  createProjectWorkspace: (input: ProjectWorkspaceInput, options?: MutationOptions) =>
    invokeProjectWorkspace('create', input, options),
  updateProjectWorkspace: (id: string, patch: ProjectWorkspacePatch, options?: MutationOptions) =>
    invokeProjectWorkspace('update', id, patch, options),
  archiveProjectWorkspace: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('archive', id, options),
  restoreProjectWorkspace: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('restore', id, options),
  deleteProjectWorkspace: (id: string, options?: ProjectWorkspaceDeleteOptions) =>
    invokeProjectWorkspace('delete', id, options),
  purgeProjectWorkspace: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('purge', id, options),
  exportProjectWorkspaceManifest: (id: string, destinationPath?: string) =>
    invokeProjectWorkspace('export', id, destinationPath),
  exportProjectWorkspaceData: (projectId: string) =>
    invokeProjectWorkspace('export:data', projectId),
  importProjectWorkspaceData: (source) =>
    invokeProjectWorkspace('import:data', source),
  listProjectGoals: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('goals:list', projectId, options),
  getProjectGoal: (id: string) => invokeProjectWorkspace('goals:get', id),
  createProjectGoal: (input: GoalInput, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:create', input, options),
  updateProjectGoal: (id: string, patch: GoalPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:update', id, patch, options),
  transitionProjectGoal: (id: string, status: GoalStatus, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:transition', id, status, options),
  archiveProjectGoal: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:archive', id, options),
  restoreProjectGoal: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:restore', id, options),
  setProjectGoalAcceptance: (id: string, result: AcceptanceResult, options?: MutationOptions) =>
    invokeProjectWorkspace('goals:acceptance', id, result, options),
  listProjectWorkItems: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('workItems:list', projectId, options),
  getProjectWorkItem: (id: string) => invokeProjectWorkspace('workItems:get', id),
  createProjectWorkItem: (input: WorkItemInput, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:create', input, options),
  createProjectGoalTask: (input: ProjectGoalTaskInput) =>
    invokeProjectWorkspace('goalTask:create', input),
  updateProjectWorkItem: (id: string, patch: WorkItemPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:update', id, patch, options),
  transferProjectWorkItem: (input: WorkItemTransferInput) =>
    invokeProjectWorkspace('workItems:transfer', input),
  reorderProjectWorkItem: (id: string, targetId: string, placement: WorkItemReorderPlacement, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:reorder', id, targetId, placement, options),
  transitionProjectWorkItem: (id: string, status: WorkItemStatus, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:transition', id, status, options),
  setProjectWorkItemAcceptance: (id: string, result: AcceptanceResult, options?: MutationOptions) =>
    invokeProjectWorkspace('workItems:acceptance', id, result, options),
  acquireProjectWorkItemLease: (id: string, options?: ProjectWorkspaceLeaseOptions) =>
    invokeProjectWorkspace('workItems:lease:acquire', id, options),
  renewProjectWorkItemLease: (id: string, options?: ProjectWorkspaceLeaseOptions) =>
    invokeProjectWorkspace('workItems:lease:renew', id, options),
  releaseProjectWorkItemLease: (id: string, options?: ProjectWorkspaceLeaseOptions) =>
    invokeProjectWorkspace('workItems:lease:release', id, options),
  listProjectSquads: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('squads:list', projectId, options),
  getProjectSquad: (id: string) => invokeProjectWorkspace('squads:get', id),
  createProjectSquad: (input: ProjectSquadCreateInput, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:create', input, options),
  updateProjectSquad: (id: string, patch: ProjectSquadPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:update', id, patch, options),
  archiveProjectSquad: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:archive', id, options),
  restoreProjectSquad: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:restore', id, options),
  addProjectSquadMember: (id: string, member: ProjectSquadMemberInput, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:members:add', id, member, options),
  removeProjectSquadMember: (id: string, memberType: WorkItemOwnerType, memberId: string, options?: MutationOptions) =>
    invokeProjectWorkspace('squads:members:remove', id, memberType, memberId, options),
  listProjectWorkItemComments: (workItemId: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('comments:list', workItemId, options),
  listProjectComments: (projectId?: string, options?: ProjectWorkspaceListOptions) =>
    invokeProjectWorkspace('comments:listProject', projectId, options),
  createProjectWorkItemComment: (input: ProjectWorkItemCommentCreateInput, options?: MutationOptions) =>
    invokeProjectWorkspace('comments:create', input, options),
  updateProjectWorkItemComment: (id: string, patch: WorkItemCommentPatch, options?: MutationOptions) =>
    invokeProjectWorkspace('comments:update', id, patch, options),
  deleteProjectWorkItemComment: (id: string, options?: MutationOptions) =>
    invokeProjectWorkspace('comments:delete', id, options)
}
