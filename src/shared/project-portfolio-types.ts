import type {
  MutationOptions,
  ProjectWorkspaceKind,
  ProjectWorkspaceStatus,
  WorkItemOwnerType
} from './project-workspace-types'

export const PROJECT_PORTFOLIO_SCHEMA_VERSION = 1 as const

export type ProjectPortfolioSchemaVersion = typeof PROJECT_PORTFOLIO_SCHEMA_VERSION
export type ProjectDependencyStatus = 'active' | 'removed'
export type ProjectPortfolioDependencyState = 'satisfied' | 'waiting' | 'blocked'
export type ProjectMilestoneStatus = 'planned' | 'reached' | 'missed' | 'cancelled'
export type ProjectTimelineEntryKind = 'goal' | 'work_item' | 'milestone'

export interface ProjectDependency {
  schemaVersion: ProjectPortfolioSchemaVersion
  id: string
  fromProjectId: string
  toProjectId: string
  fromWorkItemId?: string
  toWorkItemId?: string
  label?: string
  status: ProjectDependencyStatus
  createdAt: number
  updatedAt: number
  removedAt?: number
  revision: number
}

export interface ProjectDependencyInput {
  id?: string
  fromProjectId: string
  toProjectId: string
  fromWorkItemId?: string
  toWorkItemId?: string
  label?: string
}

export interface ProjectMilestone {
  schemaVersion: ProjectPortfolioSchemaVersion
  id: string
  projectId: string
  goalId?: string
  workItemId?: string
  title: string
  dueAt: number
  status: ProjectMilestoneStatus
  createdAt: number
  updatedAt: number
  revision: number
}

export interface ProjectMilestoneInput {
  id?: string
  projectId: string
  goalId?: string
  workItemId?: string
  title: string
  dueAt: number
}

export interface ProjectMilestonePatch {
  title?: string
  dueAt?: number
  status?: ProjectMilestoneStatus
}

export interface ProjectPortfolioState {
  schemaVersion: ProjectPortfolioSchemaVersion
  revision: number
  dependencies: ProjectDependency[]
  milestones: ProjectMilestone[]
}

export interface ProjectPortfolioStatusCounts {
  total: number
  active: number
  blocked: number
  completed: number
  overdue: number
}

export interface ProjectPortfolioProjectSummary {
  projectId: string
  name: string
  kind: ProjectWorkspaceKind
  status: ProjectWorkspaceStatus
  ownerId?: string
  goalCounts: ProjectPortfolioStatusCounts
  workItemCounts: ProjectPortfolioStatusCounts
  milestoneCount: number
  dependencyCount: number
  waitingDependencyCount: number
  blockedDependencyCount: number
  timelineStart: number
  timelineEnd: number
  progress: number
}

export interface ProjectPortfolioTimelineEntry {
  id: string
  kind: ProjectTimelineEntryKind
  projectId: string
  title: string
  status: string
  startAt: number
  endAt: number
  dueAt?: number
  progress: number
  overdue: boolean
  /** Same-Project WorkItem dependency IDs. */
  dependencyIds: string[]
  /** Cross-Project dependency records targeting this WorkItem. */
  crossProjectDependencyIds: string[]
  waitingOnCrossProjectDependencyIds: string[]
  blockedByCrossProjectDependencyIds: string[]
}

export interface ProjectPortfolioDependencyHealth {
  dependencyId: string
  state: ProjectPortfolioDependencyState
  /** Renderer-safe upstream state such as a WorkItem status or project aggregate state. */
  sourceStatus: string
}

export interface ProjectPortfolioResourceLoad {
  ownerType: WorkItemOwnerType
  ownerId: string
  displayName?: string
  projectIds: string[]
  activeWorkItems: number
  blockedWorkItems: number
  overdueWorkItems: number
}

export interface ProjectPortfolioSnapshot {
  schemaVersion: ProjectPortfolioSchemaVersion
  portfolioRevision: number
  workspaceRevision: number
  generatedAt: number
  rangeStart: number
  rangeEnd: number
  projects: ProjectPortfolioProjectSummary[]
  dependencies: ProjectDependency[]
  dependencyHealth: ProjectPortfolioDependencyHealth[]
  milestones: ProjectMilestone[]
  timeline: ProjectPortfolioTimelineEntry[]
  resourceLoad: ProjectPortfolioResourceLoad[]
  snapshotDigest: string
}

export interface ProjectPortfolioApi {
  getProjectPortfolio(): Promise<ProjectPortfolioSnapshot>
  createProjectDependency(input: ProjectDependencyInput, options?: MutationOptions): Promise<ProjectDependency>
  removeProjectDependency(id: string, options?: MutationOptions): Promise<ProjectDependency>
  createProjectMilestone(input: ProjectMilestoneInput, options?: MutationOptions): Promise<ProjectMilestone>
  updateProjectMilestone(id: string, patch: ProjectMilestonePatch, options?: MutationOptions): Promise<ProjectMilestone>
  deleteProjectMilestone(id: string, options?: MutationOptions): Promise<boolean>
}
