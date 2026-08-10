import type {
  ProviderProfileApplyResult,
  ProviderProfileImportDecision,
  ProviderProfileImportPreview,
  ProviderProfileSyncHistoryEntry,
  ProviderProfileSyncHistoryPreview,
  ProviderProfileSyncRelation
} from './provider-profile-types'

export interface ProviderProfileWebDavConfigInput {
  baseUrl: string
  username: string
  password?: string
  remotePath: string
  autoSyncEnabled: boolean
  autoPullEnabled: boolean
  autoSyncIntervalMinutes: number
}

export interface ProviderProfileWebDavConfigView {
  configured: boolean
  endpointLabel?: string
  baseUrl?: string
  username?: string
  remotePath?: string
  passwordConfigured: boolean
  autoSyncEnabled: boolean
  autoPullEnabled: boolean
  autoSyncIntervalMinutes: number
  lastSyncAt?: string
  lastError?: string
}

export interface ProviderProfileWebDavStatus {
  relation: ProviderProfileSyncRelation
  localProviderCount: number
  remoteProviderCount?: number
  remoteCreatedAt?: string
  endpointLabel: string
}

export interface ProviderProfileWebDavPreview {
  previewId: string
  status: ProviderProfileWebDavStatus
  importPreview?: ProviderProfileImportPreview
  canPublish: boolean
  canPull: boolean
  requiresConflictChoice: boolean
}

export interface ProviderProfileWebDavPublishResult {
  revisionId: string
  providerCount: number
  status: ProviderProfileWebDavStatus
}

export interface ProviderProfileWebDavApplyResult extends ProviderProfileApplyResult {
  status: ProviderProfileWebDavStatus
}

export interface ProviderProfileWebDavConnectionResult {
  ok: true
  endpointLabel: string
}

export interface ProviderProfileWebDavApi {
  getProviderProfileWebDavConfig(): Promise<ProviderProfileWebDavConfigView>
  saveProviderProfileWebDavConfig(input: ProviderProfileWebDavConfigInput): Promise<ProviderProfileWebDavConfigView>
  removeProviderProfileWebDavConfig(): Promise<ProviderProfileWebDavConfigView>
  testProviderProfileWebDavConnection(): Promise<ProviderProfileWebDavConnectionResult>
  previewProviderProfileWebDavSync(): Promise<ProviderProfileWebDavPreview>
  publishProviderProfileWebDavSync(
    previewId: string,
    allowDiverged: boolean
  ): Promise<ProviderProfileWebDavPublishResult>
  applyProviderProfileWebDavSync(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileWebDavApplyResult>
  listProviderProfileWebDavHistory(): Promise<ProviderProfileSyncHistoryEntry[]>
  previewProviderProfileWebDavHistory(revisionId: string): Promise<ProviderProfileSyncHistoryPreview>
  applyProviderProfileWebDavHistory(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileApplyResult>
}
