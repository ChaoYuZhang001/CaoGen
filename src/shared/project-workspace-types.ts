/**
 * ProjectWorkspace is deliberately independent from the legacy path-centric
 * Project type. A workspace may have no resources at all; resources are
 * optional links and never form the workspace identity.
 */

export const PROJECT_WORKSPACE_SCHEMA_VERSION = 1 as const
export const MANAGED_PERSONAL_WORKSPACE_ID = 'caogen-managed-personal-workspace' as const

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

export type OutboundDataClass = 'S0' | 'S1' | 'S2' | 'S3' | 'S4'

/**
 * allow: any configured Provider may receive the resource.
 * local_only: only a loopback Provider may receive it.
 * deny: the resource is omitted from every Provider request.
 */
export type ProjectResourceEgressPolicy = 'allow' | 'local_only' | 'deny'

export type ConnectorResourceUsage = 'resource' | 'knowledge_source' | 'tool'
export type ConnectorDataDirection = 'read' | 'write' | 'bidirectional'
export type ConnectorAuthorizationSubject = 'personal' | 'shared'
export type ConnectorAuthorizationStatus = 'active' | 'revoked'

export interface ConnectorResourceContract {
  schemaVersion: 1
  usage: ConnectorResourceUsage[]
  capabilities: string[]
  dataDirection: ConnectorDataDirection
  authorization: {
    subject: ConnectorAuthorizationSubject
    principalId: string
    scopes: string[]
    status: ConnectorAuthorizationStatus
    grantedAt?: number
    revokedAt?: number
  }
  version: string
  revocation: {
    behavior: 'deny_new_operations'
    purgeCachedData: boolean
  }
  writePolicy: {
    effect: 'required'
    reconciliation: 'queryable' | 'manual_only'
  }
}

export interface ConnectorSourceCitation {
  projectId: string
  resourceId: string
  source: string
  version: string
  retrievedAt: number
  contentDigest?: string
}

export interface ConnectorReadResult<T = unknown> {
  data: T
  citation: ConnectorSourceCitation
}

export interface ProjectResource {
  id: string
  kind: ProjectResourceKind
  label?: string
  /** A source path is metadata only; deleting a workspace never removes it. */
  path?: string
  uri?: string
  /** Defaults to S2 for local content and S1 for metadata-only remote links. */
  dataClass?: OutboundDataClass
  /** Defaults to allow for backward compatibility; S3 is always denied. */
  egressPolicy?: ProjectResourceEgressPolicy
  /** Required for connector resources; credentials are referenced, never stored here. */
  connector?: ConnectorResourceContract
  metadata?: Record<string, unknown>
}

export interface ProjectResourceInput extends Omit<ProjectResource, 'id'> {
  id?: string
}

export type OutboundContextItemKind =
  | 'user_prompt'
  | 'image_attachment'
  | 'document_attachment'
  | 'project_resource'
  | 'project_resource_metadata'
  | 'conversation_context'
  | 'memory_context'
  | 'ide_context'
  | 'workflow_context'
  | 'tool_result'

export type OutboundContextItemDecision = 'included' | 'excluded'

export interface OutboundContextItemView {
  id: string
  kind: OutboundContextItemKind
  label: string
  dataClass: OutboundDataClass
  egressPolicy: ProjectResourceEgressPolicy
  decision: OutboundContextItemDecision
  resourceId?: string
  bytes?: number
  digest?: string
  reason?: string
}

export type OutboundReceiverLocality = 'local' | 'remote' | 'unknown'

export interface OutboundContextReceiverView {
  providerId: string
  providerName: string
  engine: string
  model: string
  endpointOrigin: string
  locality: OutboundReceiverLocality
}

/** Serializable and content-free projection of one Provider-bound request. */
export interface OutboundContextManifest {
  schemaVersion: 1
  generatedAt: number
  sessionId: string
  projectId?: string
  projectRevision?: number
  projectPolicyDigest?: string
  resourceContextDigest?: string
  receiver: OutboundContextReceiverView
  dataClasses: OutboundDataClass[]
  items: OutboundContextItemView[]
  /** Remains partial until every engine-owned system/tool context is projected. */
  scopeCompleteness: 'partial' | 'complete'
  blocked: boolean
  blockReasons: string[]
  failoverAllowed: boolean
  routingMayChangeReceiver: boolean
  manifestDigest: string
}

export type GoalRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface GoalBudget {
  amount?: number
  currency?: string
  maxTokens?: number
  maxRuns?: number
  /** Maximum non-terminal Runs owned by this Goal. Undefined means unlimited. */
  maxConcurrentRuns?: number
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

export type WorkItemActorType = 'local_user' | WorkItemOwnerType

export interface WorkItemActor {
  type: WorkItemActorType
  id: string
  displayName?: string
}

export type WorkItemCapability = 'view' | 'edit' | 'execute' | 'approve' | 'transfer'

export interface WorkItemAuthorizationView {
  projectId: string
  workItemId: string
  actor: WorkItemActor
  owner?: WorkItemOwner
  authorizationRevision: number
  projectAdministrator: boolean
  currentOwner: boolean
  capabilities: WorkItemCapability[]
}

export interface WorkItemTransferInput {
  requestId: string
  workItemId: string
  target: WorkItemOwner
  reason: string
  expectedRevision: number
}

export interface WorkItemTransferResult {
  requestId: string
  projectId: string
  workItemId: string
  previousOwner?: WorkItemOwner
  owner: WorkItemOwner
  previousAssignmentId?: string
  assignmentId: string
  workItem: WorkItem
  authorization: WorkItemAuthorizationView
  auditEventIds: string[]
  idempotentReplay: boolean
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

export type ProjectSquadStatus = 'active' | 'archived'

export interface ProjectSquadMember {
  type: WorkItemOwnerType
  id: string
  displayName?: string
  role?: string
  joinedAt: number
}

export interface ProjectSquadMemberInput {
  type: WorkItemOwnerType
  id: string
  displayName?: string
  role?: string
  joinedAt?: number
}

export interface ProjectSquad {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  name: string
  description?: string
  members: ProjectSquadMember[]
  status: ProjectSquadStatus
  createdBy?: WorkItemActor
  createdAt: number
  updatedAt: number
  archivedAt?: number
  revision: number
}

export interface ProjectSquadInput {
  id?: string
  projectId: string
  name: string
  description?: string
  members?: ProjectSquadMemberInput[]
  createdBy?: WorkItemActor
  createdAt?: number
  updatedAt?: number
}

export interface ProjectSquadPatch {
  name?: string
  description?: string
}

export type ProjectSquadCreateInput = Omit<ProjectSquadInput, 'createdBy'>

export type WorkItemCommentStatus = 'active' | 'deleted'

export interface WorkItemComment {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  workItemId: string
  author: WorkItemActor
  body: string
  mentions: WorkItemActor[]
  status: WorkItemCommentStatus
  createdAt: number
  updatedAt: number
  deletedAt?: number
  revision: number
}

export interface WorkItemCommentInput {
  id?: string
  projectId: string
  workItemId: string
  author: WorkItemActor
  body: string
  mentions?: WorkItemActor[]
  createdAt?: number
  updatedAt?: number
}

export interface WorkItemCommentPatch {
  body?: string
  mentions?: WorkItemActor[]
}

export type ProjectWorkItemCommentCreateInput = Omit<WorkItemCommentInput, 'author'>

export type WorkItemReorderPlacement = 'before' | 'after'

export interface ProjectWorkspaceEvent {
  schemaVersion: ProjectWorkspaceSchemaVersion
  id: string
  projectId: string
  entityType: 'workspace' | 'goal' | 'work_item' | 'squad' | 'comment'
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
  squads: ProjectSquad[]
  comments: WorkItemComment[]
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
  squads: ProjectSquad[]
  comments: WorkItemComment[]
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

export interface ProjectGoalTaskInput {
  /** Stable across retries of one user action; never reused for a different objective. */
  requestId: string
  projectId: string
  objective: string
}

export interface ProjectGoalTaskResult {
  requestId: string
  goal: Goal
  workItem: WorkItem
  recovered: boolean
}

export interface ProjectWorkspaceTemplateResourceSuggestion {
  kind: ProjectResourceKind
  label: string
  dataClass: OutboundDataClass
  egressPolicy: ProjectResourceEgressPolicy
  reason: string
}

export interface ProjectWorkspaceTemplateWorkItemPreset {
  key: string
  type: WorkItemType
  title: string
  description: string
  dependencyKeys: string[]
  expectedArtifactKinds: import('./workflow-types').WorkflowArtifactKind[]
  acceptance: string[]
}

export interface ProjectWorkspaceTemplateDefinition {
  schemaVersion: 1
  id: ProjectWorkspaceKind
  name: string
  summary: string
  goal: {
    title: string
    objective: string
    constraints: string[]
    successCriteria: string[]
    forbiddenActions: string[]
    riskLevel: GoalRiskLevel
    acceptance: string[]
  }
  workItems: ProjectWorkspaceTemplateWorkItemPreset[]
  resourceSuggestions: ProjectWorkspaceTemplateResourceSuggestion[]
}

export interface ProjectWorkspaceTemplateApplyInput {
  requestId: string
  projectId: string
  templateId: ProjectWorkspaceKind
}

export interface ProjectWorkspaceTemplateApplyResult {
  requestId: string
  projectId: string
  templateId: ProjectWorkspaceKind
  templateDigest: string
  goal: Goal
  workItems: WorkItem[]
  resourceSuggestions: ProjectWorkspaceTemplateResourceSuggestion[]
}

export interface ProjectDeletionResult {
  operationId: string
  projectId: string
  phase: 'completed'
  backupPath: string
  backupDigest: string
  exportDigest: string
  proofPath: string
  proofDigest: string
  sessionIds: string[]
  sdkSessionIds: string[]
  residuals: Record<string, number>
}

export interface ProjectWorkspaceApi {
  listProjectWorkspaces(options?: ProjectWorkspaceListOptions): Promise<ProjectWorkspace[]>
  getProjectWorkspace(id: string): Promise<ProjectWorkspace | undefined>
  createProjectWorkspace(input: ProjectWorkspaceInput, options?: MutationOptions): Promise<ProjectWorkspace>
  applyProjectWorkspaceTemplate(input: ProjectWorkspaceTemplateApplyInput): Promise<ProjectWorkspaceTemplateApplyResult>
  updateProjectWorkspace(id: string, patch: ProjectWorkspacePatch, options?: MutationOptions): Promise<ProjectWorkspace>
  archiveProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectWorkspace>
  restoreProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectWorkspace>
  deleteProjectWorkspace(id: string, options?: ProjectWorkspaceDeleteOptions): Promise<ProjectWorkspace | undefined>
  purgeProjectWorkspace(id: string, options?: MutationOptions): Promise<ProjectDeletionResult>
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
  createProjectGoalTask(input: ProjectGoalTaskInput): Promise<ProjectGoalTaskResult>
  updateProjectWorkItem(id: string, patch: WorkItemPatch, options?: MutationOptions): Promise<WorkItem>
  transferProjectWorkItem(input: WorkItemTransferInput): Promise<WorkItemTransferResult>
  reorderProjectWorkItem(id: string, targetId: string, placement: WorkItemReorderPlacement, options?: MutationOptions): Promise<WorkItem>
  transitionProjectWorkItem(id: string, status: WorkItemStatus, options?: MutationOptions): Promise<WorkItem>
  setProjectWorkItemAcceptance(id: string, result: AcceptanceResult, options?: MutationOptions): Promise<WorkItem>
  acquireProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  renewProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  releaseProjectWorkItemLease(id: string, options?: ProjectWorkspaceLeaseOptions): Promise<WorkItem>
  listProjectSquads(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<ProjectSquad[]>
  getProjectSquad(id: string): Promise<ProjectSquad | undefined>
  createProjectSquad(input: ProjectSquadCreateInput, options?: MutationOptions): Promise<ProjectSquad>
  updateProjectSquad(id: string, patch: ProjectSquadPatch, options?: MutationOptions): Promise<ProjectSquad>
  archiveProjectSquad(id: string, options?: MutationOptions): Promise<ProjectSquad>
  restoreProjectSquad(id: string, options?: MutationOptions): Promise<ProjectSquad>
  addProjectSquadMember(id: string, member: ProjectSquadMemberInput, options?: MutationOptions): Promise<ProjectSquad>
  removeProjectSquadMember(id: string, memberType: WorkItemOwnerType, memberId: string, options?: MutationOptions): Promise<ProjectSquad>
  listProjectComments(projectId?: string, options?: ProjectWorkspaceListOptions): Promise<WorkItemComment[]>
  listProjectWorkItemComments(workItemId: string, options?: ProjectWorkspaceListOptions): Promise<WorkItemComment[]>
  createProjectWorkItemComment(input: ProjectWorkItemCommentCreateInput, options?: MutationOptions): Promise<WorkItemComment>
  updateProjectWorkItemComment(id: string, patch: WorkItemCommentPatch, options?: MutationOptions): Promise<WorkItemComment>
  deleteProjectWorkItemComment(id: string, options?: MutationOptions): Promise<WorkItemComment>
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
