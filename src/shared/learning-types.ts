export type LearningKind = 'memory' | 'skill'

export type LearningStatus =
  | 'draft'
  | 'active'
  | 'rejected'
  | 'superseded'
  | 'revoked'
  | 'expired'
  | 'deleted'

export type LearningActorType = 'user' | 'agent' | 'model' | 'runtime' | 'system'

export interface LearningActor {
  type: LearningActorType
  id: string
  source: string
}

export interface LearningDiff {
  summary: string
  previousDigest?: string
  currentDigest: string
  changedFields: string[]
}

export interface MemoryLearningPayload {
  type: 'memory'
  memoryKind: string
  title: string
  body: string
  reason: string
}

export interface SkillLearningPayload {
  type: 'skill'
  name: string
  description: string
  markdown: string
  /** POSIX-style path relative to <project>/.caogen/skills. */
  relativePath: string
}

export type LearningPayload = MemoryLearningPayload | SkillLearningPayload

export interface LearningRecord {
  schemaVersion: 1
  id: string
  logicalId: string
  kind: LearningKind
  /** Stable project hash. Raw project paths are never persisted here. */
  project: string
  scope: 'project'
  source: string
  confidence: number
  digest: string
  diff: LearningDiff
  status: LearningStatus
  version: number
  supersedes?: string
  actor: LearningActor
  createdAt: string
  updatedAt: string
  decidedAt?: string
  expiresAt?: string
  payload: LearningPayload
}

export type LearningAuditAction =
  | 'proposed'
  | 'imported'
  | 'approved'
  | 'rejected'
  | 'rolled_back'
  | 'revoked'
  | 'expired'
  | 'deleted'

export interface LearningAuditEvent {
  id: string
  recordId: string
  logicalId: string
  action: LearningAuditAction
  actor: LearningActor
  at: string
  fromStatus?: LearningStatus
  toStatus: LearningStatus
  detail?: string
}

export interface LearningProjectSnapshot {
  schemaVersion: 1
  project: string
  records: LearningRecord[]
  active: LearningRecord[]
  drafts: LearningRecord[]
  history: LearningRecord[]
  audit: LearningAuditEvent[]
}

export interface LearningDraftInput {
  kind: LearningKind
  source: string
  confidence?: number
  supersedes?: string
  expiresAt?: string
  payload: LearningPayload
}

export interface LearningApi {
  listLearning(sessionId: string): Promise<LearningProjectSnapshot>
  approveLearning(sessionId: string, recordId: string): Promise<LearningRecord>
  rejectLearning(sessionId: string, recordId: string): Promise<LearningRecord>
  rollbackLearning(sessionId: string, recordId: string): Promise<LearningRecord>
  revokeLearning(sessionId: string, recordId: string): Promise<LearningRecord>
  deleteLearning(sessionId: string, recordId: string): Promise<LearningRecord>
}
