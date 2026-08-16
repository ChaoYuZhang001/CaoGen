import type {
  EngineKind,
  PermissionModeId,
  SessionStatus,
  TaskStrategy,
  TaskRunStatus,
  TaskSnapshotReason,
  TranscriptSearchHit
} from './types'

export type SessionQueryPresence = 'active' | 'history' | 'recovery'

export interface SessionQueryInput {
  query?: string
  statuses?: SessionStatus[]
  presence?: SessionQueryPresence[]
  workspaceId?: string
  projectId?: string
  goalId?: string
  workItemId?: string
  parentSessionId?: string
  rootsOnly?: boolean
  includeArchived?: boolean
  updatedAfter?: number
  updatedBefore?: number
  limit?: number
  cursor?: string
}

export interface SessionQueryLineage {
  rootSessionId: string
  ancestorSessionIds: string[]
  childSessionIds: string[]
  depth: number
  cycleDetected: boolean
}

export interface SessionQueryRecovery {
  snapshotId: string
  reason: TaskSnapshotReason
  updatedAt: number
  runStatus?: TaskRunStatus
}

export interface SessionQueryItem {
  id: string
  sdkSessionId?: string
  title: string
  cwd: string
  sourceCwd?: string
  status: SessionStatus
  presence: SessionQueryPresence[]
  createdAt: number
  updatedAt: number
  archived: boolean
  pinned: boolean
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  model: string
  providerId: string
  engine?: EngineKind
  taskStrategy: TaskStrategy
  permissionMode: PermissionModeId
  costUsd: number
  lineage: SessionQueryLineage
  recovery?: SessionQueryRecovery
  transcriptHits: TranscriptSearchHit[]
}

export interface SessionQueryPage {
  schemaVersion: 1
  items: SessionQueryItem[]
  nextCursor?: string
  totalMatched: number
}
