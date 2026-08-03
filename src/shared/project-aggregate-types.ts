import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerLease,
  RoleTemplate
} from './digital-worker-types'
import type { LearningAuditEvent, LearningRecord } from './learning-types'
import type {
  Goal,
  ProjectSquad,
  ProjectResource,
  ProjectWorkspace,
  ProjectWorkspaceEvent,
  WorkItem,
  WorkItemComment
} from './project-workspace-types'
import type { WorkflowLedgerExportSelection, WorkflowRunRecord } from './workflow-types'
import type { Routine, RoutineRunRecord } from './types'

export const PROJECT_AGGREGATE_SCHEMA_VERSION = 1 as const
export const PROJECT_AGGREGATE_FORMAT = 'caogen.project-aggregate.v1' as const
export const PROJECT_AGGREGATE_EXPORT_FORMAT = 'caogen.project-aggregate.export.v1' as const

export const PROJECT_AGGREGATE_OBJECT_KINDS = [
  'project',
  'resource',
  'goal',
  'work_item',
  'squad',
  'comment',
  'digital_worker',
  'assignment',
  'lease',
  'run',
  'artifact',
  'artifact_edge',
  'artifact_location',
  'evidence',
  'evidence_link',
  'acceptance',
  'memory',
  'budget',
  'policy',
  'audit'
] as const

export type ProjectAggregateObjectKind = typeof PROJECT_AGGREGATE_OBJECT_KINDS[number]

export type ProjectAggregateObjectCounts = Record<ProjectAggregateObjectKind, number>
export type ProjectAggregateObjectDigests = Record<ProjectAggregateObjectKind, Record<string, string>>

export interface ProjectAggregateMemoryRecord {
  id: string
  projectId: string
  namespace: 'project_id' | 'legacy_path'
  namespaceDigest: string
  record: LearningRecord
}

export interface ProjectAggregateLearningAudit {
  id: string
  projectId: string
  namespace: ProjectAggregateMemoryRecord['namespace']
  event: LearningAuditEvent
}

export interface ProjectAggregateBudgetRecord {
  id: string
  projectId: string
  ownerKind: 'project' | 'goal' | 'digital_worker'
  ownerId: string
  value: Record<string, unknown>
}

export interface ProjectAggregatePolicyRecord {
  id: string
  projectId: string
  ownerKind: 'project' | 'digital_worker'
  ownerId: string
  policyKind: string
  value: unknown
}

export interface ProjectAggregateAuditRecord {
  id: string
  projectId: string
  source: 'project_workspace' | 'workflow_ledger' | 'digital_worker' | 'learning'
  occurredAt: number | string
  value: unknown
}

export interface ProjectAggregateWorkflowSelection {
  /** Explicit Project export is restorable; credential fields are sanitized later. */
  runs: WorkflowRunRecord[]
  artifacts: WorkflowLedgerExportSelection['artifacts']['items']
  artifactEdges: WorkflowLedgerExportSelection['artifactEdges']['items']
  artifactLocations: WorkflowLedgerExportSelection['artifactLocations']['items']
  acceptances: WorkflowLedgerExportSelection['acceptances']['items']
  evidenceLinks: WorkflowLedgerExportSelection['evidenceLinks']['items']
  taskEvidence: WorkflowLedgerExportSelection['taskEvidence']['items']
  workflowEvidence: WorkflowLedgerExportSelection['workflowEvidence']['items']
}

export interface ProjectAggregateSnapshot {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  format: typeof PROJECT_AGGREGATE_FORMAT
  projectId: string
  identityDigest: string
  projectRevision: number
  workspace: ProjectWorkspace
  resources: ProjectResource[]
  goals: Goal[]
  workItems: WorkItem[]
  squads: ProjectSquad[]
  comments: WorkItemComment[]
  digitalWorkers: DigitalWorker[]
  assignments: DigitalWorkerAssignment[]
  leases: DigitalWorkerLease[]
  workflow: ProjectAggregateWorkflowSelection
  memory: ProjectAggregateMemoryRecord[]
  budgets: ProjectAggregateBudgetRecord[]
  policies: ProjectAggregatePolicyRecord[]
  audit: ProjectAggregateAuditRecord[]
  objectCounts: ProjectAggregateObjectCounts
  objectDigests: ProjectAggregateObjectDigests
  aggregateDigest: string
  sanitized: true
}

export interface ProjectAggregateSeal {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  projectId: string
  aggregateRevision: number
  projectRevision: number
  identityDigest: string
  aggregateDigest: string
  objectCounts: ProjectAggregateObjectCounts
  objectDigests: ProjectAggregateObjectDigests
  sealedAt: number
}

export interface ProjectAggregateVerification {
  valid: true
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  projectId: string
  aggregateRevision: number
  identityDigest: string
  aggregateDigest: string
  objectCounts: ProjectAggregateObjectCounts
  sanitized: true
  sealed: true
}

/** Global records required to make the Project-owned aggregate usable after import. */
export interface ProjectAggregateDependencies {
  roleTemplates: RoleTemplate[]
}

export interface ProjectAggregateAutomation {
  routines: Routine[]
  runs: RoutineRunRecord[]
}

export interface ProjectAggregateExportBundle {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  format: typeof PROJECT_AGGREGATE_EXPORT_FORMAT
  projectId: string
  aggregateRevision: number
  aggregate: ProjectAggregateSnapshot
  dependencies: ProjectAggregateDependencies
  /** Project-owned local automation. Optional only for backward-compatible v1 imports. */
  automation?: ProjectAggregateAutomation
  verification: ProjectAggregateVerification
  exportDigest: string
}

export interface ProjectAggregateExportResult {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  format: typeof PROJECT_AGGREGATE_EXPORT_FORMAT
  json: string
  exportDigest: string
  bundle: ProjectAggregateExportBundle
}

export interface ProjectAggregateReference {
  kind: ProjectAggregateObjectKind
  id: string
}

export interface ProjectAggregateAuthorization {
  projectId: string
  aggregateRevision: number
  aggregateDigest: string
  references: ProjectAggregateReference[]
}

export interface ProjectAggregateRoots {
  workspaceRoot: string
  workflowRoot: string
  digitalWorkerRoot: string
  routineRoot: string
  learningRoot: string
  aggregateRoot: string
  /** Optional path-based namespaces are read for compatibility, never as Project identity. */
  legacyLearningRoots?: Record<string, string[]>
}

export interface ProjectAggregateSealOptions {
  expectedAggregateRevision?: number
  now?: number
}

export interface ProjectAggregateQueryOptions {
  expectedAggregateRevision?: number
  expectedAggregateDigest?: string
}

export type ProjectAggregateWorkspaceAudit = ProjectWorkspaceEvent
