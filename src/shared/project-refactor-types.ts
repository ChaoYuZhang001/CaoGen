export interface ProjectRefactorInput {
  path: string
  content: string
  line: number
  column: number
  newName: string
}

export interface ProjectRefactorLine {
  line: number
  kind: 'context' | 'removed' | 'added'
  text: string
}

export interface ProjectRefactorFileChange {
  path: string
  editCount: number
  beforeDigest: string
  afterDigest: string
  lines: ProjectRefactorLine[]
}

export interface ProjectRefactorPreview {
  previewId: string
  kind: 'typescript-rename'
  sourcePath: string
  newName: string
  files: ProjectRefactorFileChange[]
  totalEdits: number
  expiresAt: string
}

export interface ProjectRefactorApplyResult {
  ok: true
  operationId: string
  kind: 'typescript-rename'
  files: string[]
  appliedAt: string
  workflowArtifactId?: string
  workflowEvidenceId?: string
  workflowAcceptanceId?: string
  evidenceError?: string
}

export interface ProjectRefactorRollbackResult {
  ok: true
  operationId: string
  files: string[]
  rolledBackAt: string
  workflowArtifactId?: string
  workflowEvidenceId?: string
  workflowAcceptanceId?: string
  evidenceError?: string
}

export type ProjectRefactorRecoveryStatus = 'none' | 'rollback_available' | 'auto_rolled_back' | 'blocked'

export interface ProjectRefactorRecovery {
  status: ProjectRefactorRecoveryStatus
  operationId?: string
  files: string[]
  occurredAt?: string
  message?: string
}

export interface ProjectRefactorApi {
  previewTypeScriptRename(sessionId: string, input: ProjectRefactorInput): Promise<ProjectRefactorPreview>
  applyProjectRefactor(sessionId: string, previewId: string): Promise<ProjectRefactorApplyResult>
  rollbackProjectRefactor(sessionId: string, operationId: string): Promise<ProjectRefactorRollbackResult>
  getProjectRefactorRecovery(sessionId: string): Promise<ProjectRefactorRecovery>
  dismissProjectRefactorRecovery(sessionId: string, operationId: string): Promise<void>
}
