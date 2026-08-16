import type {
  ProjectAggregateExportBundle,
  ProjectAggregateDeliveryExportResult,
  ProjectAggregateObjectCounts
} from './project-aggregate-types'

export interface ProjectImportResult {
  operationId: string
  projectId: string
  phase: 'completed'
  sourcePath: string
  sourceDigest: string
  exportDigest: string
  sourceAggregateDigest: string
  importedAggregateDigest: string
  semanticDigest: string
  aggregateRevision: number
  sourceEquivalent: true
  objectCounts: ProjectAggregateObjectCounts
}

export type DataRetentionSubjectKind = 'application' | 'project' | 'session'

export interface DataRetentionSubject {
  kind: DataRetentionSubjectKind
  /** Application-wide holds omit the ID; Project and Session subjects require it. */
  id?: string
}

export interface DataRetentionSubjectOverride {
  subject: DataRetentionSubject & { kind: 'project' | 'session'; id: string }
  minimumRetentionMs: number
}

export interface DataRetentionPolicy {
  projectMinimumRetentionMs: number
  sessionMinimumRetentionMs: number
  subjectOverrides: DataRetentionSubjectOverride[]
  updatedAt: number
  updatedBy: string
}

export interface DataRetentionPolicyUpdateInput {
  requestId: string
  expectedRevision: number
  projectMinimumRetentionMs: number
  sessionMinimumRetentionMs: number
  subjectOverrides?: DataRetentionSubjectOverride[]
}

export type DataLegalHoldStatus = 'active' | 'released'

export interface DataLegalHold {
  id: string
  requestId: string
  subject: DataRetentionSubject
  reason: string
  status: DataLegalHoldStatus
  createdAt: number
  createdBy: string
  createdRevision: number
  releasedAt?: number
  releasedBy?: string
  releaseReason?: string
  releasedRevision?: number
}

export interface DataLegalHoldCreateInput {
  requestId: string
  expectedRevision: number
  subject: DataRetentionSubject
  reason: string
}

export interface DataLegalHoldReleaseInput {
  requestId: string
  expectedRevision: number
  holdId: string
  reason: string
}

export type DataRetentionAuditAction =
  | 'policy_updated'
  | 'legal_hold_created'
  | 'legal_hold_released'

export interface DataRetentionAuditEvent {
  seq: number
  revision: number
  requestId: string
  requestDigest: string
  action: DataRetentionAuditAction
  actorId: string
  createdAt: number
  subject?: DataRetentionSubject
  holdId?: string
  previousDigest: string
  nextDigest: string
}

export interface DataRetentionAuthorityView {
  schemaVersion: 1
  revision: number
  policy: DataRetentionPolicy
  legalHolds: DataLegalHold[]
  audit: DataRetentionAuditEvent[]
}

export interface DataRetentionExportSubject {
  kind: DataRetentionSubjectKind
  idDigest?: string
}

export interface DataRetentionAuthorityExport {
  schemaVersion: 1
  format: 'caogen.data-retention-authority.export.v1'
  exportedAt: number
  authorityRevision: number
  authorityDigest: string
  policy: {
    projectMinimumRetentionMs: number
    sessionMinimumRetentionMs: number
    subjectOverrides: Array<{
      subject: DataRetentionExportSubject
      minimumRetentionMs: number
    }>
    updatedAt: number
    updatedByDigest: string
  }
  legalHolds: Array<{
    holdIdDigest: string
    requestIdDigest: string
    subject: DataRetentionExportSubject
    reason: string
    status: DataLegalHoldStatus
    createdAt: number
    createdByDigest: string
    createdRevision: number
    releasedAt?: number
    releasedByDigest?: string
    releaseReason?: string
    releasedRevision?: number
  }>
  audit: Array<{
    seq: number
    revision: number
    requestIdDigest: string
    requestDigest: string
    action: DataRetentionAuditAction
    actorIdDigest: string
    createdAt: number
    subject?: DataRetentionExportSubject
    holdIdDigest?: string
    previousDigest: string
    nextDigest: string
  }>
  exportDigest: string
}

export interface DataRetentionAuthorityExportResult {
  canceled: boolean
  filePath?: string
  exportDigest?: string
  authorityRevision?: number
}

export interface DataPurgeTarget {
  subject: DataRetentionSubject & { kind: 'project' | 'session'; id: string }
  /** Project deletedAt or Session updatedAt; all retention windows use this frozen clock. */
  retentionAnchorAt: number
}

export interface DataPurgeEvaluationInput {
  targets: DataPurgeTarget[]
  /** Ancestors or descendants that contribute legal holds but no retention deadline. */
  relatedLegalHoldSubjects?: DataRetentionSubject[]
}

export type DataPurgeBlocker =
  | {
      kind: 'legal_hold'
      subject: DataRetentionSubject
      holdId: string
      reason: string
    }
  | {
      kind: 'minimum_retention'
      subject: DataPurgeTarget['subject']
      retentionAnchorAt: number
      minimumRetentionMs: number
      earliestPurgeAt: number
    }

export interface DataPurgeDecision {
  allowed: boolean
  evaluatedAt: number
  authorityRevision: number
  blockers: DataPurgeBlocker[]
}

export interface DataRetentionPendingDeletion {
  kind: 'project' | 'session'
  id: string
  operationId: string
  phase: string
  requestedAt: number
  decision: DataPurgeDecision
}

export interface DataRetentionPendingDeletionView {
  generatedAt: number
  items: DataRetentionPendingDeletion[]
}

export interface ProjectDataLifecycleApi {
  /** Export the complete sanitized Project aggregate, not only Workspace metadata. */
  exportProjectWorkspaceData(projectId: string): Promise<ProjectAggregateDeliveryExportResult>
  /** Import one verified export directly; no empty Project needs to be created first. */
  importProjectWorkspaceData(source: string | ProjectAggregateExportBundle): Promise<ProjectImportResult>
  getDataRetentionAuthority(): Promise<DataRetentionAuthorityView>
  updateDataRetentionPolicy(input: DataRetentionPolicyUpdateInput): Promise<DataRetentionAuthorityView>
  createDataLegalHold(input: DataLegalHoldCreateInput): Promise<DataRetentionAuthorityView>
  releaseDataLegalHold(input: DataLegalHoldReleaseInput): Promise<DataRetentionAuthorityView>
  evaluateDataPurge(input: DataPurgeEvaluationInput): Promise<DataPurgeDecision>
  saveDataRetentionAuthorityExport(): Promise<DataRetentionAuthorityExportResult>
  getDataRetentionPendingDeletions(): Promise<DataRetentionPendingDeletionView>
}
