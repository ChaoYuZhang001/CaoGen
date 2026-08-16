import type {
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactKind,
  WorkflowArtifactLocationRecord,
  WorkflowArtifactRecord,
  WorkflowProjectionSource
} from '../../shared/workflow-types'

export const REQUIRED_ARTIFACT_KINDS: readonly WorkflowArtifactKind[] = [
  'report',
  'source',
  'requirement',
  'design',
  'document',
  'spreadsheet',
  'presentation',
  'pdf',
  'code',
  'patch',
  'diff',
  'test_report',
  'screenshot',
  'pull_request',
  'issue',
  'release_package',
  'custom'
]

export type ArtifactRetentionPolicy =
  | { mode: 'retain' }
  | { mode: 'expire'; retainUntil: number }

export interface ArtifactRetentionRevisionRecord {
  schemaVersion: 1
  artifactId: string
  projectId: string
  revision: number
  policy: ArtifactRetentionPolicy
  reason: string
  createdAt: number
}

export interface ArtifactRetentionRevisionInput {
  artifactId: string
  projectId: string
  policy: ArtifactRetentionPolicy
  reason: string
  createdAt?: number
}

export type ArtifactContentInput =
  | {
      storageKind: 'blob'
      bytes: Uint8Array
      expectedDigest?: string
    }
  | {
      storageKind: 'source_ref'
      sourceRef: string
      expectedDigest?: string
    }

export interface ArtifactLifecycleRegistrationInput {
  id: string
  projectId: string
  goalId?: string
  workItemId?: string
  runId: string
  lineageId: string
  kind: WorkflowArtifactKind
  title: string
  version: number
  provenance: WorkflowProjectionSource
  mediaType?: string
  supersedesId?: string
  retention: ArtifactRetentionPolicy
  content: ArtifactContentInput
  metadata?: Record<string, unknown>
  createdAt?: number
}

export type PreparedArtifactContent =
  | {
      storageKind: 'blob'
      digest: string
      sizeBytes: number
      bytes: Uint8Array
      blobRef: string
      locationPath: string
    }
  | {
      storageKind: 'source_ref'
      digest: string
      sizeBytes: number
      sourceRef: string
      locationPath: string
    }

export interface ArtifactProjectOwnership {
  projectId: string
  projectRevision: number
  goalId?: string
  workItemId: string
}

export interface ArtifactLifecycleRecord {
  schemaVersion: 1
  artifactId: string
  projectId: string
  projectRevision: number
  goalId?: string
  workItemId: string
  runId: string
  runRevision: number
  lineageId: string
  kind: WorkflowArtifactKind
  version: number
  provenance: WorkflowProjectionSource
  supersedesId?: string
  storageKind: 'blob' | 'source_ref'
  sourceRef?: string
  blobRef?: string
  digest: string
  sizeBytes: number
  locationId: string
  retention: ArtifactRetentionPolicy
  createdAt: number
}

export type ArtifactPurgeDisposition = 'blob_deleted' | 'shared_blob_retained' | 'source_detached'

export interface ArtifactPurgeRecord {
  schemaVersion: 1
  artifactId: string
  projectId: string
  purgedAt: number
  reason: string
  disposition: ArtifactPurgeDisposition
}

export interface ArtifactLifecycleRegistrationResult {
  artifact: WorkflowArtifactRecord
  lifecycle: ArtifactLifecycleRecord
  location: WorkflowArtifactLocationRecord
  supersedesEdge?: WorkflowArtifactEdgeRecord
}

export interface ArtifactLifecyclePurgeInput {
  artifactId: string
  projectId: string
  reason: string
  purgedAt?: number
}

export interface ArtifactLifecyclePurgeResult {
  lifecycle: ArtifactLifecycleRecord
  purge: ArtifactPurgeRecord
  tombstone: WorkflowArtifactLocationRecord
}

export interface ArtifactEffectiveRetention {
  policy: ArtifactRetentionPolicy
  revision: number
  revisedAt?: number
}

export interface ArtifactLifecycleVerification {
  valid: true
  artifacts: number
  available: number
  purged: number
  blobs: number
  sourceRefs: number
  kinds: WorkflowArtifactKind[]
}

export interface ArtifactLifecycleRoots {
  workflowRoot?: string
  workspaceRoot?: string
}

export type ArtifactLifecycleRootInput = string | ArtifactLifecycleRoots
