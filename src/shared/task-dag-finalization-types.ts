import type { EffectStatus } from './effect-types'
import type {
  TaskDagExecutionView,
  TaskDagRuntimeAutoMergeOptions,
  TaskDagRuntimeMergeSession,
  WorktreeConflictRisk
} from './types'

export type TaskDagFinalizationPhase =
  | 'prepared'
  | 'merging'
  | 'verifying'
  | 'rollback_pending'
  | 'merge_settled'
  | 'summary_pending'
  | 'summary_delivered'
  | 'waiting_reconciliation'
  | 'completed'

export type TaskDagFinalizationResolution =
  | 'verification_passed'
  | 'verification_failed'
  | 'verification_not_started'
  | 'summary_not_delivered'
  | 'finalization_abandoned'

export interface TaskDagFinalizationSummary {
  messageId: string
  text: string
  digest: string
  deliveryAttempts: number
  lastAttemptAt?: number
  deliveredEventId?: string
  deliveredEventSeq?: number
  deliveredAt?: number
}

export interface TaskDagFinalizationVerification {
  status: 'not_started' | 'started' | 'settled'
  command?: string
  startedAt?: number
  result?: TaskDagAutoMergeVerification
}

export interface TaskDagFinalizationPatchPlan {
  executionId: string
  taskId: string
  sourceSessionId: string
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  patchPath: string
  patchSha256: string
  patchText: string
}

export interface TaskDagFinalizationView {
  executionId: string
  phase: TaskDagFinalizationPhase
  revision: number
  updatedAt: number
  summaryMessageId?: string
  deliveredAt?: number
  error?: string
}

export interface TaskDagFinalizationRecord {
  schemaVersion: 1
  executionId: string
  parentSessionId: string
  revision: number
  phase: TaskDagFinalizationPhase
  terminalExecution: TaskDagExecutionView
  autoMergeOptions?: TaskDagRuntimeAutoMergeOptions
  mergeSessions: TaskDagRuntimeMergeSession[]
  patchOperationIds: string[]
  rollbackOperationIds: string[]
  /** Frozen reverse-order compensation inputs for crash-safe rollback continuation. */
  rollbackPatches?: TaskDagFinalizationPatchPlan[]
  verification: TaskDagFinalizationVerification
  autoMergeResult?: TaskDagAutoMergeView
  summary?: TaskDagFinalizationSummary
  error?: string
  createdAt: number
  updatedAt: number
}

export type TaskDagAutoMergeStatus = 'running' | 'success' | 'partial' | 'failed' | 'rolled-back'

export type TaskDagAutoMergeEntryStatus =
  | 'merged'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'rolled-back'

export type TaskDagAutoMergeVerificationStatus = 'passed' | 'failed' | 'skipped' | 'not-run'

export interface TaskDagAutoMergeVerification {
  status: TaskDagAutoMergeVerificationStatus
  command?: string
  cwd?: string
  exitCode?: number | null
  durationMs?: number
  output?: string
  error?: string
}

export interface TaskDagAutoMergeConflict {
  path: string
  base: string
  worktree: string
  main: string
  baseMissing?: boolean
  worktreeMissing?: boolean
  mainMissing?: boolean
  truncated?: boolean
}

export interface TaskDagAutoMergeEntry {
  taskId: string
  sessionId?: string
  branch?: string
  worktreePath?: string
  status: TaskDagAutoMergeEntryStatus
  changedFiles?: number
  insertions?: number
  deletions?: number
  conflictRisk?: WorktreeConflictRisk
  patchSha256?: string
  patchPath?: string
  commitSha?: string
  /** Operation Effect receipt for deterministic DAG patch replay/reconciliation. */
  effectStatus?: EffectStatus
  operationId?: string
  reconciliationRequired?: boolean
  error?: string
  conflicts?: TaskDagAutoMergeConflict[]
  resolverPrompt?: string
}

export interface TaskDagAutoMergeRollback {
  attempted: boolean
  ok: boolean
  entries?: TaskDagAutoMergeRollbackEntry[]
  error?: string
}

export interface TaskDagAutoMergeRollbackEntry {
  taskId: string
  status: 'rolled-back' | 'failed'
  effectStatus?: EffectStatus
  operationId?: string
  reconciliationRequired?: boolean
  error?: string
}

export interface TaskDagAutoMergeView {
  enabled: true
  status: TaskDagAutoMergeStatus
  startedAt: number
  completedAt?: number
  repoRoot?: string
  entries: TaskDagAutoMergeEntry[]
  mergedCount: number
  blockedCount: number
  skippedCount: number
  verification?: TaskDagAutoMergeVerification
  rollback?: TaskDagAutoMergeRollback
  summary?: string
  error?: string
}
