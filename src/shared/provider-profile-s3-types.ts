import type {
  ProviderProfileApplyResult,
  ProviderProfileImportDecision,
  ProviderProfileImportPreview,
  ProviderProfileSyncHistoryEntry,
  ProviderProfileSyncHistoryPreview,
  ProviderProfileSyncRelation
} from './provider-profile-types'

export interface ProviderProfileS3ConfigInput {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  autoSyncEnabled: boolean
  autoPullEnabled: boolean
  autoSyncIntervalMinutes: number
}

export interface ProviderProfileS3ConfigView {
  configured: boolean
  endpoint?: string
  endpointLabel?: string
  region?: string
  bucket?: string
  prefix?: string
  forcePathStyle: boolean
  credentialsConfigured: boolean
  accessKeyLabel?: string
  sessionTokenConfigured: boolean
  autoSyncEnabled: boolean
  autoPullEnabled: boolean
  autoSyncIntervalMinutes: number
  lastSyncAt?: string
  lastError?: string
}

export interface ProviderProfileS3Status {
  relation: ProviderProfileSyncRelation
  localProviderCount: number
  remoteProviderCount?: number
  remoteCreatedAt?: string
  endpointLabel: string
}

export interface ProviderProfileS3Preview {
  previewId: string
  status: ProviderProfileS3Status
  importPreview?: ProviderProfileImportPreview
  canPublish: boolean
  canPull: boolean
  requiresConflictChoice: boolean
}

export interface ProviderProfileS3PublishResult {
  revisionId: string
  providerCount: number
  status: ProviderProfileS3Status
}

export interface ProviderProfileS3ApplyResult extends ProviderProfileApplyResult {
  status: ProviderProfileS3Status
}

export interface ProviderProfileS3ConnectionResult {
  ok: true
  endpointLabel: string
}

export interface ProviderProfileS3Api {
  getProviderProfileS3Config(): Promise<ProviderProfileS3ConfigView>
  saveProviderProfileS3Config(input: ProviderProfileS3ConfigInput): Promise<ProviderProfileS3ConfigView>
  removeProviderProfileS3Config(): Promise<ProviderProfileS3ConfigView>
  testProviderProfileS3Connection(): Promise<ProviderProfileS3ConnectionResult>
  previewProviderProfileS3Sync(): Promise<ProviderProfileS3Preview>
  publishProviderProfileS3Sync(previewId: string, allowDiverged: boolean): Promise<ProviderProfileS3PublishResult>
  applyProviderProfileS3Sync(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileS3ApplyResult>
  listProviderProfileS3History(): Promise<ProviderProfileSyncHistoryEntry[]>
  previewProviderProfileS3History(revisionId: string): Promise<ProviderProfileSyncHistoryPreview>
  applyProviderProfileS3History(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileApplyResult>
}
