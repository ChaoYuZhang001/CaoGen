import type {
  EngineInfo,
  EngineKind,
  OpenAIProtocol,
  ProviderHealthView,
  ProviderInput,
  ProviderAuthMode,
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderView
} from './types'

export type ProviderProfileImportAction = 'create' | 'update' | 'skip'

export type ProviderProfileConflictKind =
  | 'none'
  | 'same_provider'
  | 'name'
  | 'target'
  | 'ambiguous'

export interface ProviderProfileImportItem {
  id: string
  name: string
  baseUrl: string
  models: string[]
  engine: EngineKind
  openaiProtocol?: OpenAIProtocol
  authMode: ProviderAuthMode
  targetProviderId?: string
  targetProviderName?: string
  targetKeyCount?: number
  targetActiveKeyLabel?: string
  targetCredentialMigrationRequired?: boolean
  targetCredentialBindingChanged: boolean
  conflict: ProviderProfileConflictKind
  changedFields: string[]
  defaultAction: ProviderProfileImportAction
  allowedActions: ProviderProfileImportAction[]
}

export interface ProviderProfileImportPreview {
  previewId: string
  fileName: string
  profileCount: number
  createCount: number
  updateCount: number
  skipCount: number
  credentialFieldsIgnored: number
  warnings: string[]
  items: ProviderProfileImportItem[]
}

export interface ProviderProfileImportDecision {
  itemId: string
  action: ProviderProfileImportAction
}

export interface ProviderProfileBackupView {
  id: string
  createdAt: string
  providerCount: number
  reason: 'import' | 'manual'
  nonPersistentCredentialCount: number
  excludedCredentialCount: number
}

export interface ProviderProfileExportResult {
  canceled: boolean
  fileName?: string
  providerCount: number
}

export interface ProviderProfileApplyResult {
  operationId: string
  providers: ProviderView[]
  backup: ProviderProfileBackupView
  created: number
  updated: number
  skipped: number
}

export interface ProviderProfileRollbackResult {
  operationId: string
  providers: ProviderView[]
  restoredBackupId: string
}

export interface ProviderManagementApi {
  listProviders(): Promise<ProviderView[]>
  createProvider(provider: ProviderInput): Promise<ProviderView>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderView>
  deleteProvider(id: string): Promise<void>
  fetchProviderModels(opts: ProviderModelFetchInput): Promise<ProviderModelFetchResult>
  activateLocalCompute(): Promise<LocalComputeActivationResult>
  listProviderHealth(): Promise<ProviderHealthView[]>
  listEngines(): Promise<EngineInfo[]>
}

export type LocalComputeService = 'ollama' | 'lm-studio' | 'vllm'

export interface LocalComputeActivationResult {
  status: 'activated' | 'unavailable'
  checkedAt: number
  service?: LocalComputeService
  provider?: ProviderView
}

export interface ProviderProfileApi extends ProviderManagementApi {
  exportProviderProfile(): Promise<ProviderProfileExportResult>
  previewProviderProfileImport(): Promise<ProviderProfileImportPreview | null>
  applyProviderProfileImport(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<ProviderProfileApplyResult>
  listProviderProfileBackups(): Promise<ProviderProfileBackupView[]>
  rollbackProviderProfileBackup(backupId: string): Promise<ProviderProfileRollbackResult>
}
