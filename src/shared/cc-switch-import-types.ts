import type { EngineKind, OpenAIProtocol, ProviderModelPricing, ProviderView } from './types'
import type {
  ProviderProfileConflictKind,
  ProviderProfileImportAction,
  ProviderProfileImportDecision
} from './provider-profile-types'

export type CcSwitchSourceApp = 'claude' | 'codex'

export type CcSwitchImportWarning =
  | 'credential_missing'
  | 'existing_credential_preserved'
  | 'daily_limit_not_enforced'
  | 'proxy_transform_not_supported'
  | 'proxy_listener_not_imported'
  | 'proxy_takeover_not_imported'
  | 'proxy_logging_not_imported'
  | 'empty_provider_config'

export interface CcSwitchProviderImportItem {
  id: string
  sourceApp: CcSwitchSourceApp
  name: string
  baseUrl: string
  engine: EngineKind
  openaiProtocol?: OpenAIProtocol
  models: string[]
  credentialPresent: boolean
  credentialImportable: boolean
  monthlyBudgetUsd?: number
  dailyLimitUsd?: number
  costMultiplier: number
  pricedModelCount: number
  targetProviderId?: string
  targetProviderName?: string
  conflict: ProviderProfileConflictKind
  changedFields: string[]
  warnings: CcSwitchImportWarning[]
  defaultAction: ProviderProfileImportAction
  allowedActions: ProviderProfileImportAction[]
}

export interface CcSwitchProviderImportPreview {
  previewId: string
  databasePresent: true
  providerCount: number
  importableCount: number
  credentialCount: number
  pricedModelCount: number
  skippedCount: number
  items: CcSwitchProviderImportItem[]
  expiresAt: number
}

export interface CcSwitchProviderImportApplyResult {
  operationId: string
  created: number
  updated: number
  skipped: number
  providers: ProviderView[]
  backup: CcSwitchProviderImportBackupView
}

export interface CcSwitchProviderImportBackupView {
  id: string
  createdAt: string
  providerCount: number
  createdCount: number
  updatedCount: number
  importedCredentialCount: number
}

export interface CcSwitchProviderImportRollbackResult {
  operationId: string
  restoredBackupId: string
  providers: ProviderView[]
}

export interface CcSwitchPricingRecord {
  model: string
  displayName?: string
  pricing: ProviderModelPricing
}

export interface CcSwitchProviderImportApi {
  previewCcSwitchProviderImport(): Promise<CcSwitchProviderImportPreview>
  applyCcSwitchProviderImport(
    previewId: string,
    decisions: ProviderProfileImportDecision[]
  ): Promise<CcSwitchProviderImportApplyResult>
  listCcSwitchProviderImportBackups(): Promise<CcSwitchProviderImportBackupView[]>
  rollbackCcSwitchProviderImportBackup(backupId: string): Promise<CcSwitchProviderImportRollbackResult>
}
