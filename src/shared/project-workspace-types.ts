/**
 * ProjectWorkspace is deliberately independent from the legacy path-centric
 * Project type. A workspace may have no resources at all; resources are
 * optional links and never form the workspace identity.
 */

export const PROJECT_WORKSPACE_SCHEMA_VERSION = 1 as const

export type ProjectWorkspaceSchemaVersion = typeof PROJECT_WORKSPACE_SCHEMA_VERSION

export type ProjectWorkspaceKind =
  | 'personal'
  | 'office'
  | 'education'
  | 'research'
  | 'software'
  | 'opc'
  | 'custom'

export type ProjectWorkspaceStatus = 'active' | 'archived' | 'deleted'

export type ProjectResourceKind =
  | 'directory'
  | 'file_set'
  | 'repository'
  | 'knowledge_base'
  | 'connector'
  | 'url'
  | 'custom'

export interface ProjectResource {
  id: string
  kind: ProjectResourceKind
  label?: string
  /** A source path is metadata only; deleting a workspace never removes it. */
  path?: string
  uri?: string
  metadata?: Record<string, unknown>
}

export interface ProjectResourceInput extends Omit<ProjectResource, 'id'> {
  id?: string
}

export type GoalRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface GoalBudget {
  amount?: number
  currency?: string
  maxTokens?: number
  maxRuns?: number
}

export interface AcceptanceSpec {
  id: string
  criterion: string
  required?: boolean
}

export type AcceptanceResultStatus = 'pending' | 'passed' | 'failed' | 'waived'

export interface AcceptanceResult {
  status: AcceptanceResultStatus
  evidenceRefs: string[]
  verifiedBy?: string
  verifiedAt?: number
  waiverReason?: string
}

export interface GoalContract {
  objective: string
  background?: string
  constraints: string[]
  successCriteria: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel: GoalRiskLevel
  forbiddenActions: string[]
  acceptance: AcceptanceSpec[]
}

export type GoalContractInput = Partial<GoalContract>

export type GoalStatus =
  | 'draft'
  | 'planned'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived'

export interface ProjectWorkspace {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  name: string
  kind: ProjectWorkspaceKind
  status: ProjectWorkspaceStatus
  ownerId?: string
  resources: ProjectResource[]
  rulesRef?: string
  budgetPolicy?: Record<string, unknown>
  permissionPolicy?: Record<string, unknown>
  retentionPolicy?: Record<string, unknown>
  createdAt: number
  updatedAt: number
  archivedAt?: number
  deletedAt?: number
  /** Entity revision, incremented exactly once for each persisted mutation. */
  revision: number
}

export interface ProjectWorkspaceInput {
  id?: string
  name: string
  kind?: ProjectWorkspaceKind
  ownerId?: string
  resources?: ProjectResourceInput[]
  rulesRef?: string
  budgetPolicy?: Record<string, unknown>
  permissionPolicy?: Record<string, unknown>
  retentionPolicy?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

export interface ProjectWorkspacePatch {
  name?: string
  kind?: ProjectWorkspaceKind
  ownerId?: string
  resources?: ProjectResourceInput[]
  rulesRef?: string
  budgetPolicy?: Record<string, unknown>
  permissionPolicy?: Record<string, unknown>
  retentionPolicy?: Record<string, unknown>
}

export interface Goal {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  title: string
  /** Flattened fields are retained for simple consumers; contract is canonical. */
  objective: string
  background?: string
  constraints: string[]
  successCriteria: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel: GoalRiskLevel
  forbiddenActions: string[]
  acceptance: AcceptanceSpec[]
  acceptanceResult?: AcceptanceResult
  contract: GoalContract
  status: GoalStatus
  createdBy?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
  archivedAt?: number
  /** Status immediately before archive, used by restore. */
  archivedFromStatus?: Exclude<GoalStatus, 'archived'>
  revision: number
}

export interface GoalInput {
  id?: string
  projectId: string
  title: string
  objective?: string
  background?: string
  constraints?: string[]
  successCriteria?: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel?: GoalRiskLevel
  forbiddenActions?: string[]
  acceptance?: AcceptanceSpec[]
  acceptanceResult?: AcceptanceResult
  contract?: GoalContractInput
  status?: GoalStatus
  createdBy?: string
  createdAt?: number
  updatedAt?: number
}

export interface GoalPatch {
  title?: string
  objective?: string
  background?: string
  constraints?: string[]
  successCriteria?: string[]
  budget?: GoalBudget
  dueAt?: number
  riskLevel?: GoalRiskLevel
  forbiddenActions?: string[]
  acceptance?: AcceptanceSpec[]
  acceptanceResult?: AcceptanceResult
  contract?: GoalContractInput
  createdBy?: string
}

export type WorkItemType =
  | 'research'
  | 'analysis'
  | 'planning'
  | 'writing'
  | 'design'
  | 'coding'
  | 'review'
  | 'testing'
  | 'documentation'
  | 'operations'
  | 'delivery'
  | 'custom'

export type WorkItemStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export type WorkItemOwnerType = 'human' | 'digital_worker'

export interface WorkItemOwner {
  type: WorkItemOwnerType
  id: string
  displayName?: string
}

export interface WorkItemLease {
  id: string
  ownerId: string
  acquiredAt: number
  expiresAt: number
  fencingToken: number
}

export interface WorkItem {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  goalId?: string
  parentId?: string
  type: WorkItemType
  title: string
  description?: string
  dependencyIds: string[]
  priority: number
  /** Stable user-controlled order shared by List and Board projections. */
  boardOrder?: number
  owner?: WorkItemOwner
  status: WorkItemStatus
  dueAt?: number
  acceptanceSpec: AcceptanceSpec[]
  acceptance?: AcceptanceResult
  artifactRefs: string[]
  runRefs: string[]
  /** Immutable snapshot of the Goal Contract inherited at write time. */
  inheritedGoalContract?: GoalContract
  createdAt: number
  updatedAt: number
  revision: number
  lease?: WorkItemLease
}

export interface WorkItemInput {
  id?: string
  projectId: string
  goalId?: string
  parentId?: string
  type?: WorkItemType
  title: string
  description?: string
  dependencyIds?: string[]
  priority?: number
  owner?: WorkItemOwner | string
  status?: WorkItemStatus
  dueAt?: number
  acceptanceSpec?: AcceptanceSpec[]
  artifactRefs?: string[]
  runRefs?: string[]
  createdAt?: number
  updatedAt?: number
}

export interface WorkItemPatch {
  title?: string
  description?: string
  type?: WorkItemType
  parentId?: string
  dependencyIds?: string[]
  priority?: number
  owner?: WorkItemOwner | string | null
  dueAt?: number
  acceptanceSpec?: AcceptanceSpec[]
  artifactRefs?: string[]
  runRefs?: string[]
}

export type WorkItemReorderPlacement = 'before' | 'after'

export interface ProjectWorkspaceEvent {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  entityType: 'workspace' | 'goal' | 'work_item'
  entityId: string
  kind: string
  revision: number
  occurredAt: number
  payload: Record<string, unknown>
}

export interface ProjectWorkspaceState {
  schemaVersion: ProjectWorkspaceSchemaVersion
  revision: number
  workspaces: ProjectWorkspace[]
  goals: Goal[]
  workItems: WorkItem[]
  events: ProjectWorkspaceEvent[]
}

export interface ProjectWorkspaceManifest {
  schemaVersion: ProjectWorkspaceSchemaVersion
  format: 'caogen.project-workspace-manifest.v1'
  exportedAt: number
  projectId: string
  stateRevision: number
  workspace: ProjectWorkspace
  goals: Goal[]
  workItems: WorkItem[]
  events: ProjectWorkspaceEvent[]
  digest: string
}

export interface MutationOptions {
  /** Entity revision expected by the caller (optimistic concurrency). */
  expectedRevision?: number
  /** Optional global store revision CAS for callers coordinating a batch. */
  expectedStoreRevision?: number
}

/** Renderer-facing contract for the native ProjectWorkspace domain. */
export interface ProjectWorkspaceListOptions {
  includeArchived?: boolean
  includeDeleted?: boolean
  goalId?: string
}

export interface ProjectWorkspaceDeleteOptions extends MutationOptions {
  permanent?: boolean
}

export interface ProjectWorkspaceLeaseOptions extends MutationOptions {
  leaseId?: string
  ownerId?: string
  durationMs?: number
  fencingToken?: number
}

export interface ProjectWorkspaceApi {
  listProjectWorkspaces(options?: ProjectWorkspaceListOptions): Promise<ProjectWorkspace[]>
  getProjectWorkspace(id: string): Promise<ProjectWorkspace | undefined>
  createProjectWorkspace(input: ProjectWorkspaceInput, options?: MutationOptions): Promise<ProjectWorkspace>
  updateProjectWorkspace(id: string, patch: ProjectWorkspacePatch, options?: MutationOptions): Promise<ProjectWorkspace>
  archiveProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectWorkspace>
  restoreProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectWorkspace>
  deleteProjectWorkspace(id: string, options?: ProjectWorkspaceDeleteOptions): Promise<ProjectWorkspace | undefined>
  purgeProjectWorkspace(id: string, options?: MutationOptions): Promise<void>
  exportProjectWorkspaceManifest(id: string, destinationPath?: string): Promise<ProjectWorkspaceManifest>
  listProjectGoals(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<Goal[]>
  getProjectGoal(id: string): Promise<Goal | undefined>
  createProjectGoal(input: GoalInput, options?: MutationOptions): Promise<Goal>
  updateProjectGoal(id: string, patch: GoalPatch, options?: MutationOptions): Promise<Goal>
  transitionProjectGoal(id: string, status: GoalStatus, options?: MutationOptions): Promise<Goal>
  archiveProjectGoal(id: string, options?: MutationOptions): Promise<Goal>
  restoreProjectGoal(id: string, options?: MutationOptions): Promise<Goal>
  setProjectGoalAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions): Promise<Goal>
  listProjectWorkItems(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<WorkItem[]>
  getProjectWorkItem(id: string): Promise<WorkItem | undefined>
  createProjectWorkItem(input: WorkItemInput, options?: MutationOptions): Promise<WorkItem>
  updateProjectWorkItem(id: string, patch: WorkItemPatch, options?: MutationOptions): Promise<WorkItem>
  reorderProjectWorkItem(id: string, targetId: string, placement: WorkItemReorderPlacement, options?: MutationOptions): Promise<WorkItem>
  transitionProjectWorkItem(id: string, status: WorkItemStatus, options?: MutationOptions): Promise<WorkItem>
  setProjectWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions): Promise<WorkItem>
  acquireProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  renewProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  releaseProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
}

export function isProjectWorkspaceKind(value: unknown): value is ProjectWorkspaceKind {
  return value === 'personal' || value === 'office' || value === 'education' ||
    value === 'research' || value === 'software' || value === 'opc' || value === 'custom'
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return value === 'draft' || value === 'planned' || value === 'running' ||
    value === 'waiting_approval' || value === 'blocked' || value === 'verifying' ||
    value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'archived'
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return value === 'backlog' || value === 'ready' || value === 'running' ||
    value === 'waiting_approval' || value === 'blocked' || value === 'verifying' ||
    value === 'done' || value === 'failed' || value === 'cancelled'
}

export function isWorkItemType(value: unknown): value is WorkItemType {
  return value === 'research' || value === 'analysis' || value === 'planning' ||
    value === 'writing' || value === 'design' || value === 'coding' || value === 'review' ||
    value === 'testing' || value === 'documentation' || value === 'operations' ||
    value === 'delivery' || value === 'custom'
}

export function isGoalRiskLevel(value: unknown): value is GoalRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
}

export function isAcceptanceSatisfied(value: AcceptanceResult | undefined): boolean {
  return value?.status === 'passed' || value?.status === 'waived'
}
