import type {
  Goal,
  ProjectSquad,
  ProjectWorkspace,
  ProjectWorkspaceState,
  WorkItem,
  WorkItemComment
} from '../../shared/project-workspace-types'
import { ProjectWorkspaceError } from './errors'

export function workspaceFrom(state: ProjectWorkspaceState, id: string): ProjectWorkspace {
  const workspace = state.workspaces.find((item) => item.id === id)
  if (!workspace) throw new ProjectWorkspaceError('not_found', `workspace ${id} was not found`)
  return workspace
}
export function activeWorkspaceFrom(state: ProjectWorkspaceState, id: string): ProjectWorkspace {
  const workspace = workspaceFrom(state, id)
  if (workspace.status === 'deleted') throw new ProjectWorkspaceError('deleted', `workspace ${id} is deleted`)
  return workspace
}

export function goalFrom(state: ProjectWorkspaceState, id: string): Goal {
  const goal = state.goals.find((item) => item.id === id)
  if (!goal) throw new ProjectWorkspaceError('not_found', `goal ${id} was not found`)
  return goal
}

export function workItemFrom(state: ProjectWorkspaceState, id: string): WorkItem {
  const item = state.workItems.find((candidate) => candidate.id === id)
  if (!item) throw new ProjectWorkspaceError('not_found', `work item ${id} was not found`)
  return item
}

export function squadFrom(state: ProjectWorkspaceState, id: string): ProjectSquad {
  const squad = state.squads.find((candidate) => candidate.id === id)
  if (!squad) throw new ProjectWorkspaceError('not_found', `squad ${id} was not found`)
  return squad
}

export function commentFrom(state: ProjectWorkspaceState, id: string): WorkItemComment {
  const comment = state.comments.find((candidate) => candidate.id === id)
  if (!comment) throw new ProjectWorkspaceError('not_found', `comment ${id} was not found`)
  return comment
}

export function assertProject(state: ProjectWorkspaceState, projectId: string, allowDeleted = false): ProjectWorkspace {
  const workspace = workspaceFrom(state, projectId)
  if (!allowDeleted && workspace.status === 'deleted') {
    throw new ProjectWorkspaceError('deleted', `workspace ${projectId} is deleted`)
  }
  return workspace
}

export function assertSameProject(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) {
    throw new ProjectWorkspaceError('cross_project', `${label} crosses project boundary`, {
      expectedProjectId: expected,
      actualProjectId: actual
    })
  }
}
