import type { TaskRunRecord, TaskRunStatus } from './types'
export type WorkflowGoalStatus =
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
export type WorkflowWorkItemStatus =
  | 'backlog'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'
export type WorkflowWorkItemType =
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

export type WorkflowProjectionSource = 'explicit' | 'dag' | 'legacy-derived' | 'recovery'

export type WorkflowEventEntityType = 'goal' | 'work_item' | 'run' | 'artifact' | 'acceptance' | 'system'

export type WorkflowArtifactKind =
  | 'report'
  | 'source'
  | 'requirement'
  | 'design'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'code'
  | 'patch'
  | 'diff'
  | 'test_report'
  | 'screenshot'
  | 'pull_request'
  | 'issue'
  | 'release_package'
  | 'custom'

export type WorkflowAcceptanceStatus = 'pending' | 'verifying' | 'passed' | 'failed' | 'waived'

export type WorkflowEvidenceKind =
  | 'research_source'
  | 'review_result'
  | 'test_result'
  | 'approval'
  | 'observation'
  | 'metric'
  | 'security_scan'
  | 'delivery_check'
  | 'custom'

export type WorkflowEvidenceSource = 'runtime' | 'human' | 'imported' | 'recovery'

export interface WorkflowEvidenceInput {
  evidenceId: string
  projectId: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  kind: WorkflowEvidenceKind
  source?: WorkflowEvidenceSource
  title: string
  summary?: string
  uri?: string
  mediaType?: string
  verifier: string
  observedAt?: number
  contentDigest: string
  metadata?: Record<string, unknown>
}

/** Renderer-safe evidence input. Trusted provenance is assigned in main. */
export type WorkflowEvidenceCreateInput = Omit<
  WorkflowEvidenceInput,
  'source' | 'verifier' | 'observedAt'
>

export interface WorkflowEvidenceRecord extends WorkflowEvidenceInput {
  schemaVersion: 1
  seq: number
  id: string
  source: WorkflowEvidenceSource
  observedAt: number
  createdAt: number
  prevDigest: string
  digest: string
}

export interface WorkflowEvidenceScope {
  evidenceId?: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
  kind?: WorkflowEvidenceKind
  limit?: number
  /** Opaque decimal offset returned as nextCursor. */
  cursor?: string
}

export interface WorkflowEvidenceVerification {
  valid: true
  count: number
  lastSeq: number
  lastDigest: string
}
export interface WorkflowAcceptanceCriterionEvidence {
  criterionId: string
  criterionIndex: number
  evidenceRefs: string[]
}

export interface WorkflowAcceptanceCriterionPolicy {
  criterionId: string; criterionIndex: number
  evidenceKind: WorkflowEvidenceKind; allowedSources: WorkflowEvidenceSource[]
}
export interface WorkflowArtifactRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactKind
  title: string
  uri?: string
  version: number
  digest: string
  mediaType?: string
  provenance: WorkflowProjectionSource
  createdAt: number
  updatedAt: number
  supersedesId?: string
  metadata?: Record<string, unknown>
}

export type WorkflowArtifactEdgeRelation =
  | 'derived_from'
  | 'produced_from'
  | 'input_to'
  | 'output_of'
  | 'supports'
  | 'verifies'
  | 'supersedes'
  | 'annotates'
  | 'references'
  | 'depends_on'
  | 'related_to'
  | 'custom'

export type WorkflowArtifactLocationKind =
  | 'blob'
  | 'file'
  | 'workspace'
  | 'url'
  | 'git'
  | 'attachment'
  | 'preview'
  | 'external'
  | 'custom'

export type WorkflowArtifactLocationAvailability =
  | 'available'
  | 'pending'
  | 'unavailable'
  | 'deleted'
  | 'unknown'

export interface WorkflowArtifactGraphScope {
  projectId?: string
  artifactId?: string
  fromArtifactId?: string
  toArtifactId?: string
  relation?: WorkflowArtifactEdgeRelation
  kind?: WorkflowArtifactLocationKind
  availability?: WorkflowArtifactLocationAvailability
  cursor?: string
  limit?: number
}

export interface WorkflowArtifactEdgeInput {
  id: string
  fromArtifactId: string
  toArtifactId: string
  relation: WorkflowArtifactEdgeRelation
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  metadata?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

export interface WorkflowArtifactEdgeRecord {
  schemaVersion: 1
  id: string
  fromArtifactId: string
  toArtifactId: string
  relation: WorkflowArtifactEdgeRelation
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface WorkflowArtifactLocationInput {
  id?: string
  artifactId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactLocationKind
  uri?: string
  path?: string
  availability?: WorkflowArtifactLocationAvailability
  checksum?: string
  sizeBytes?: number
  mediaType?: string
  metadata?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

export interface WorkflowArtifactLocationRecord {
  schemaVersion: 1
  id: string
  artifactId: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactLocationKind
  uri?: string
  path?: string
  availability: WorkflowArtifactLocationAvailability
  checksum?: string
  sizeBytes?: number
  mediaType?: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface WorkflowArtifactNeighborhood {
  artifact: WorkflowArtifactRecord
  inbound: WorkflowArtifactEdgeRecord[]
  outbound: WorkflowArtifactEdgeRecord[]
  locations: WorkflowArtifactLocationRecord[]
}

export interface WorkflowArtifactGraphVerification {
  valid: true
  artifacts: number
  edges: number
  locations: number
  events: number
  lastSeq: number
  lastDigest: string
}

export interface WorkflowArtifactGraphSelection {
  edges: WorkflowLedgerPage<WorkflowArtifactEdgeRecord>
  locations: WorkflowLedgerPage<WorkflowArtifactLocationRecord>
}

export interface WorkflowAcceptanceRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  criteria: string[]
  criterionPolicies?: WorkflowAcceptanceCriterionPolicy[]
  status: WorkflowAcceptanceStatus
  evidenceRefs: string[]
  criterionEvidence?: WorkflowAcceptanceCriterionEvidence[]
  verifier?: string
  verifiedAt?: number
  waiverReason?: string
  waivedBy?: string
  notes?: string
  revision: number
  createdAt: number
  updatedAt: number
}
export interface WorkflowEvidenceLinkRecord {
  schemaVersion: 1
  id: string
  evidenceId: string
  projectId?: string
  runId?: string
  artifactId?: string
  acceptanceId?: string
  /** Criterion covered by this link when relation is `verifies`. */
  criterionId?: string
  /** Omitted legacy records always reference TaskRun Effect evidence. */
  evidenceOrigin?: 'task_effect' | 'workflow'
  relation: 'supports' | 'verifies' | 'supersedes'
  createdAt: number
}

export interface WorkflowGoalRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  title: string
  objective: string
  status: WorkflowGoalStatus
  revision: number
  source: WorkflowProjectionSource
  createdAt: number
  updatedAt: number
  dueAt?: number
  archivedAt?: number
}

export interface WorkflowWorkItemRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  parentId?: string
  type: WorkflowWorkItemType
  title: string
  description?: string
  role?: string
  status: WorkflowWorkItemStatus
  revision: number
  source: WorkflowProjectionSource
  runIds: string[]
  currentRunId?: string
  createdAt: number
  updatedAt: number
  dueAt?: number
}

export interface WorkflowRunRecord {
  schemaVersion: 1
  id: string
  projectId?: string
  goalId?: string
  workItemId: string
  sessionId: string
  taskId: string
  /** Acceptance revision that owned this Run when first projected. */ acceptanceId?: string; acceptanceRevision?: number
  status: TaskRunStatus
  revision: number
  attempt: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  /** Full validated TaskRun payload remains available for recovery/effect readers. */
  taskRun: TaskRunRecord
}

export interface WorkflowProjectionContext {
  projectId?: string
  goalId?: string
  workItemId?: string
  workItemTitle?: string
  workItemDescription?: string
  workItemType?: WorkflowWorkItemType
  parentWorkItemId?: string
  role?: string
  source?: WorkflowProjectionSource
  /** The rich ProjectWorkspace source, not TaskRun projection, owns WorkItem mutations. */
  canonicalSourceAuthority?: boolean
  goalTitle?: string
  goalObjective?: string
  event?: WorkflowEventInput
}

export interface WorkflowGoalProjectionInput {
  id: string
  projectId?: string
  title: string
  objective: string
  status?: WorkflowGoalStatus
  revision?: number
  source?: WorkflowProjectionSource
  createdAt?: number
  updatedAt?: number
  dueAt?: number
  archivedAt?: number
}

export interface WorkflowArtifactInput {
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  kind: WorkflowArtifactKind
  title: string
  uri?: string
  version?: number
  digest: string
  mediaType?: string
  provenance?: WorkflowProjectionSource
  createdAt?: number
  updatedAt?: number
  supersedesId?: string
  metadata?: Record<string, unknown>
}

export interface WorkflowAcceptanceInput {
  id: string
  projectId?: string
  goalId?: string
  workItemId?: string
  criteria: string[]
  criterionPolicies?: WorkflowAcceptanceCriterionPolicy[]
  status?: WorkflowAcceptanceStatus
  evidenceRefs?: string[]
  criterionEvidence?: WorkflowAcceptanceCriterionEvidence[]
  verifier?: string
  verifiedAt?: number
  waiverReason?: string
  waivedBy?: string
  notes?: string
  revision?: number
  createdAt?: number
  updatedAt?: number
}

export type WorkflowAcceptanceReviewDecision = 'passed' | 'failed' | 'retest' | 'waived'
/** Renderer selection only; criterion identity and authority are assigned in main. */
export interface WorkflowAcceptanceCriterionSelection {
  criterionIndex: number
  evidenceRefs: string[]
}

export interface WorkflowAcceptanceReviewInput {
  acceptanceId: string
  criterionEvidence: WorkflowAcceptanceCriterionSelection[]
  decision: WorkflowAcceptanceReviewDecision
  notes?: string
  waiverReason?: string
}

export interface WorkflowAcceptanceReviewAudit {
  gate: 'workflow_acceptance_review'
  authority: 'user'
  acceptanceId: string
  acceptanceRevision: number
  projectId?: string
  decision: WorkflowAcceptanceReviewDecision
  actorId: string
  evidenceRefs: string[]
  verifier?: string
  verifiedAt?: number
  waivedBy?: string
}

export interface WorkflowAcceptanceReviewResult {
  acceptance: WorkflowAcceptanceRecord
  evidenceLinks: WorkflowEvidenceLinkRecord[]
  audit: WorkflowAcceptanceReviewAudit
  repair?: { workItemId: string; acceptanceId: string; failedAcceptanceRevision: number; disposition: 'created' | 'existing' | 'completed' }
}

export interface WorkflowEvidenceLinkInput {
  id: string
  evidenceId: string
  projectId?: string
  runId?: string
  artifactId?: string
  acceptanceId?: string
  criterionId?: string
  evidenceOrigin?: WorkflowEvidenceLinkRecord['evidenceOrigin']
  relation: WorkflowEvidenceLinkRecord['relation']
  createdAt?: number
}

export interface WorkflowWorkItemProjectionInput {
  id: string
  projectId?: string
  goalId?: string
  parentId?: string
  type?: WorkflowWorkItemType
  title: string
  description?: string
  role?: string
  status?: WorkflowWorkItemStatus
  revision?: number
  source?: WorkflowProjectionSource
  runIds?: string[]
  currentRunId?: string
  createdAt?: number
  updatedAt?: number
  dueAt?: number
}

export interface WorkflowEventInput {
  eventId: string
  streamId: string
  entityType: WorkflowEventEntityType
  entityId: string
  kind: string
  payload: Record<string, unknown>
  occurredAt?: number
  seq?: number
  schemaVersion?: 1
  causationId?: string
  correlationId?: string
}

export interface WorkflowEventRecord extends WorkflowEventInput {
  schemaVersion: 1
  seq: number
  occurredAt: number
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  sessionId?: string
  prevDigest: string
  digest: string
}

export interface WorkflowLedgerScope {
  projectId?: string
  goalId?: string
  workItemId?: string
  runId?: string
  sessionId?: string
  entityType?: WorkflowEventEntityType
  entityId?: string
  eventKind?: string
  artifactId?: string
  acceptanceId?: string
  limit?: number
  /** Opaque decimal offset returned as nextCursor. */
  cursor?: string
}

export interface WorkflowLedgerPage<T> {
  items: T[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export interface WorkflowLedgerSelection {
  goals: WorkflowLedgerPage<WorkflowGoalRecord>
  workItems: WorkflowLedgerPage<WorkflowWorkItemRecord>
  runs: WorkflowLedgerPage<WorkflowRunRecord>
  artifacts: WorkflowLedgerPage<WorkflowArtifactRecord>
  acceptances: WorkflowLedgerPage<WorkflowAcceptanceRecord>
  evidenceLinks: WorkflowLedgerPage<WorkflowEvidenceLinkRecord>
  events: WorkflowLedgerPage<WorkflowEventRecord>
}

/**
 * Renderer-safe Run projection.  The full TaskRun remains an internal
 * recovery/effect record; renderer IPC receives only immutable run metadata
 * plus a digest binding the omitted payload.
 */
export type WorkflowRunSummary = Omit<WorkflowRunRecord, 'taskRun' | 'error'> & {
  taskRunDigest: string
  /** Error text can contain provider material; expose only its digest. */
  errorDigest?: string
}

export type WorkflowLedgerRendererSelection = Omit<WorkflowLedgerSelection, 'runs'> & {
  runs: WorkflowLedgerPage<WorkflowRunSummary>
}

export interface WorkflowLedgerVerification {
  valid: true
  goals: number
  workItems: number
  runs: number
  artifacts: number
  acceptances: number
  evidenceLinks: number
  workflowEvidence: number
  events: number
  lastSeq: number
  lastDigest: string
  /** Additive verification for the Artifact Graph shadow tables. */
  artifactGraph?: WorkflowArtifactGraphVerification
}

/**
 * A scope accepted by the maintenance/export surface. Pagination is
 * deliberately excluded. Unlike table-local list filters, export treats the
 * matching records as seeds and includes their project-safe owner/related
 * closure so exported events and evidence do not dangle.
 */
export type WorkflowLedgerExportScope = Omit<WorkflowLedgerScope, 'limit' | 'cursor'>

export interface WorkflowLedgerExportOptions {
  scope?: WorkflowLedgerExportScope
}

/**
 * TaskRun payloads may contain prompts, tool arguments, or provider material.
 * The user-auditable export keeps the projection metadata but never carries
 * the full TaskRun payload.
 */
export type WorkflowLedgerExportRunRecord = Omit<WorkflowRunRecord, 'taskRun'> & {
  /** Digest binds the omitted TaskRun payload without exposing it. */
  taskRunDigest: string
}

/** Evidence-chain metadata suitable for export; raw TaskRun/effect payloads are omitted. */
export interface WorkflowLedgerExportTaskEvidenceRecord {
  schemaVersion: 1
  seq: number
  id: string
  evidenceId: string
  sessionId: string
  runId: string
  taskId: string
  effectId: string
  operationId?: string
  projectId?: string
  kind?: string
  generation: number
  observedAt: number
  verifier: string
  evidenceDigest: string
  effectKey: string
  targetDigest: string
  prevDigest: string
  digest: string
}

export interface WorkflowLedgerExportSelection {
  goals: WorkflowLedgerPage<WorkflowGoalRecord>
  workItems: WorkflowLedgerPage<WorkflowWorkItemRecord>
  runs: WorkflowLedgerPage<WorkflowLedgerExportRunRecord>
  artifacts: WorkflowLedgerPage<WorkflowArtifactRecord>
  /** Immutable Artifact Graph relations included in a complete export. */
  artifactEdges: WorkflowLedgerPage<WorkflowArtifactEdgeRecord>
  /** Immutable Artifact Graph locators included in a complete export. */
  artifactLocations: WorkflowLedgerPage<WorkflowArtifactLocationRecord>
  acceptances: WorkflowLedgerPage<WorkflowAcceptanceRecord>
  evidenceLinks: WorkflowLedgerPage<WorkflowEvidenceLinkRecord>
  events: WorkflowLedgerPage<WorkflowEventRecord>
  taskEvidence: WorkflowLedgerPage<WorkflowLedgerExportTaskEvidenceRecord>
  workflowEvidence: WorkflowLedgerPage<WorkflowEvidenceRecord>
}

export interface WorkflowLedgerExportVerification {
  valid: true
  /** Verification of the Workflow Ledger event/projection tables. */
  ledger: WorkflowLedgerVerification
  /** Verification of the additive Artifact Graph tables and their events. */
  artifactGraph: WorkflowArtifactGraphVerification
  /** Verification of the independent TaskRun Effect evidence chain. */
  taskEvidence: WorkflowLedgerTaskEvidenceVerification
  /** Verification of the independent general Workflow evidence chain. */
  workflowEvidence: WorkflowEvidenceVerification
  sanitized: true
  exportDigest: string
}

export interface WorkflowLedgerTaskEvidenceVerification {
  valid: true
  count: number
  lastSeq: number
  lastDigest: string
}

export interface WorkflowLedgerExportBundle {
  schemaVersion: 1
  format: 'caogen.workflow-ledger.export.v1'
  scope: WorkflowLedgerExportScope
  ledger: WorkflowLedgerExportSelection
  verification: WorkflowLedgerExportVerification
  exportDigest: string
}

export interface WorkflowLedgerExportResult {
  schemaVersion: 1
  format: 'caogen.workflow-ledger.export.v1'
  json: string
  exportDigest: string
  ledger: WorkflowLedgerExportSelection
  verification: WorkflowLedgerExportVerification
}

export type WorkflowLedgerRepairStatus = 'healthy' | 'repair_required' | 'unavailable'
export type WorkflowLedgerRepairSeverity = 'error' | 'warning' | 'info'

export interface WorkflowLedgerRepairDiagnostic {
  code: string
  severity: WorkflowLedgerRepairSeverity
  message: string
  table?: string
  rowId?: string
  seq?: number
}

export type WorkflowLedgerRepairActionKind =
  | 'backup_database'
  | 'restore_verified_backup'
  | 'rebuild_shadow_projection'
  | 'manual_review'

export interface WorkflowLedgerRepairAction {
  kind: WorkflowLedgerRepairActionKind
  mode: 'recommendation'
  requiresExplicitApproval: true
  mutatesLedger: false
  reason: string
}

export interface WorkflowLedgerBackupRecommendation {
  recommended: true
  sourcePath: string
  suggestedPath: string
  reason: string
}

/**
 * Repair is intentionally a plan/diagnostic result. No implementation of
 * this contract may rewrite rows, recompute a digest, or append to the chain.
 */
export interface WorkflowLedgerRepairPlan {
  schemaVersion: 1
  format: 'caogen.workflow-ledger.repair-plan.v1'
  status: WorkflowLedgerRepairStatus
  readOnly: true
  canAutoRepair: false
  writesPerformed: false
  chainPreserved: true
  digestRecomputed: false
  eventsAppended: false
  databaseExists: boolean
  databasePath: string
  verification?: {
    ledger: WorkflowLedgerVerification
    taskEvidence: WorkflowLedgerTaskEvidenceVerification
    workflowEvidence: WorkflowEvidenceVerification
    artifactGraph: WorkflowArtifactGraphVerification
  }
  verificationError?: {
    code: string
    message: string
    seq?: number
  }
  taskEvidenceVerificationError?: {
    code: string
    message: string
    seq?: number
  }
  workflowEvidenceVerificationError?: {
    code: string
    message: string
    seq?: number
  }
  artifactGraphVerificationError?: {
    code: string
    message: string
    seq?: number
  }
  diagnostics: WorkflowLedgerRepairDiagnostic[]
  backupRecommendation: WorkflowLedgerBackupRecommendation
  proposedActions: WorkflowLedgerRepairAction[]
  mutations: []
}

export interface WorkflowLedgerApi {
  listWorkflowLedger(scope?: WorkflowLedgerScope): Promise<WorkflowLedgerRendererSelection>
  verifyWorkflowLedger(): Promise<WorkflowLedgerVerification>
  exportWorkflowLedger(options?: WorkflowLedgerExportOptions): Promise<WorkflowLedgerExportResult>
  diagnoseWorkflowLedger(): Promise<WorkflowLedgerRepairPlan>
  planWorkflowLedgerRepair(): Promise<WorkflowLedgerRepairPlan>
  saveWorkflowAcceptance(input: WorkflowAcceptanceInput): Promise<WorkflowAcceptanceRecord>
  createWorkflowArtifact(input: WorkflowArtifactInput): Promise<WorkflowArtifactRecord>
  createWorkflowArtifactEdge(input: WorkflowArtifactEdgeInput): Promise<WorkflowArtifactEdgeRecord>
  createWorkflowArtifactLocation(input: WorkflowArtifactLocationInput): Promise<WorkflowArtifactLocationRecord>
  listWorkflowArtifactEdges(scope?: WorkflowArtifactGraphScope): Promise<WorkflowLedgerPage<WorkflowArtifactEdgeRecord>>
  listWorkflowArtifactLocations(scope?: WorkflowArtifactGraphScope): Promise<WorkflowLedgerPage<WorkflowArtifactLocationRecord>>
  queryWorkflowArtifactGraph(artifactId: string): Promise<WorkflowArtifactNeighborhood>
  verifyWorkflowArtifactGraph(): Promise<WorkflowArtifactGraphVerification>
  createWorkflowEvidence(input: WorkflowEvidenceCreateInput): Promise<WorkflowEvidenceRecord>
  listWorkflowEvidence(scope?: WorkflowEvidenceScope): Promise<WorkflowEvidenceRecord[]>
  queryWorkflowEvidence(scope?: WorkflowEvidenceScope): Promise<WorkflowLedgerPage<WorkflowEvidenceRecord>>
  verifyWorkflowEvidence(): Promise<WorkflowEvidenceVerification>
  reviewWorkflowAcceptance(input: WorkflowAcceptanceReviewInput): Promise<WorkflowAcceptanceReviewResult>
  createWorkflowEvidenceLink(input: WorkflowEvidenceLinkInput): Promise<WorkflowEvidenceLinkRecord>
}
