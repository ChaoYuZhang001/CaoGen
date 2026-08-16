import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  Provider,
  ProviderProfileApplyResult,
  ProviderProfileBackupChange,
  ProviderProfileBackupPreview,
  ProviderProfileBackupView,
  ProviderProfileImportDecision,
  ProviderProfileImportPreview,
  ProviderProfileRollbackResult
} from '../../shared/types'
import {
  listProviders,
  readProviderProfileStoreDigestStrict,
  reloadProviderProfileStoreFromDisk,
} from '../providers'
import {
  commitPreparedProviderProfileStoreMutation,
  prepareProviderProfileMutations,
  prepareProviderStoreBackupRestore,
  sanitizeProviderStoreBackupCredentials,
  snapshotProviderStoreForBackup,
  type PreparedProviderProfileStoreMutation,
  type ProviderProfileMutation
} from './providerProfileStore'
import {
  ProviderProfileOperationJournal,
  type ProviderProfileOperationKind,
  type ProviderProfileOperationJournalEntry,
  type ProviderProfileOperationReconciliation
} from './providerProfileOperationJournal'
import { withProviderStoreMutationLock } from './providerStoreMutationLock'
import { providerBackupChangedFields } from './providerProfileBackupComparison'
import {
  protectedProviderProfileBackupIds,
  pruneProviderProfileBackups
} from './provider-profile-backup-retention'
import {
  parseProviderProfile,
  planProviderProfileImport,
  renderProviderProfile,
  type PlannedProviderProfileItem
} from './providerProfile'

const BACKUP_KIND = 'caogen-provider-profile-backup'
const BACKUP_VERSION = 1
const PREVIEW_TTL_MS = 15 * 60 * 1_000
const MAX_PENDING_PREVIEWS = 20
export const PROVIDER_PROFILE_BACKUP_MAX_COUNT = 50
export const PROVIDER_PROFILE_BACKUP_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000
const BACKUP_ID = /^[0-9TZ-]{19,40}-[0-9a-f-]{36}$/i

interface PendingProviderProfileImport {
  createdAt: number
  items: PlannedProviderProfileItem[]
  preview: ProviderProfileImportPreview
  providerConfigurationDigest: string
}

interface ProviderProfileBackupPayload {
  kind: typeof BACKUP_KIND
  schemaVersion: typeof BACKUP_VERSION
  id: string
  createdAt: string
  reason: ProviderProfileBackupView['reason']
  providerCount: number
  nonPersistentCredentialCount: number
  excludedCredentialCount: number
  providers: Provider[]
}

interface ProviderProfileBackupDocument extends ProviderProfileBackupPayload {
  payloadDigest: string
}

interface ProviderProfileOperationBackupBindings {
  safetyBackupId: string
  safetyBackupDigest: string
  sourceBackupId?: string
  sourceBackupDigest?: string
}

export interface ProviderProfileOperationTestOptions {
  operationId?: string
  faultAt?: 'after_prepare' | 'after_store_commit'
  onCheckpoint?: (checkpoint: 'after_prepare' | 'after_store_commit', operationId: string) => void
  onFault?: (checkpoint: 'after_prepare' | 'after_store_commit', operationId: string) => void
}

interface PendingProviderProfileBackup {
  createdAt: number
  backupId: string
  backupDigest: string
  providerConfigurationDigest: string
  preview: ProviderProfileBackupPreview
}

const pendingImports = new Map<string, PendingProviderProfileImport>()
const pendingBackups = new Map<string, PendingProviderProfileBackup>()

export function exportProviderProfileToFile(filePath: string): { fileName: string; providerCount: number } {
  reconcileProviderProfileOperations()
  const providers = listProviders()
  writeAtomicFile(filePath, renderProviderProfile(providers), 0o600, false)
  return { fileName: basename(filePath), providerCount: providers.length }
}

export function previewProviderProfileFile(filePath: string): ProviderProfileImportPreview {
  reconcileProviderProfileOperations()
  return previewProviderProfileDocument(readRegularFile(filePath), basename(filePath))
}

export function previewProviderProfileDocument(raw: string, fileName: string): ProviderProfileImportPreview {
  reconcileProviderProfileOperations()
  const parsed = parseProviderProfile(raw)
  const providers = listProviders()
  const items = planProviderProfileImport(parsed.entries, providers)
  const previewId = randomUUID()
  const preview: ProviderProfileImportPreview = {
    previewId,
    fileName,
    profileCount: items.length,
    createCount: items.filter((item) => item.view.defaultAction === 'create').length,
    updateCount: items.filter((item) => item.view.defaultAction === 'update').length,
    skipCount: items.filter((item) => item.view.defaultAction === 'skip').length,
    credentialFieldsIgnored: parsed.credentialFieldsIgnored,
    warnings: parsed.warnings,
    items: items.map((item) => item.view)
  }
  prunePendingImports()
  pendingImports.set(previewId, {
    createdAt: Date.now(),
    items,
    preview,
    providerConfigurationDigest: providerConfigurationDigest(providers)
  })
  return preview
}

export function applyProviderProfilePreview(
  previewId: string,
  decisions: ProviderProfileImportDecision[],
  operationOptions: ProviderProfileOperationTestOptions = {}
): ProviderProfileApplyResult {
  reconcileProviderProfileOperations()
  const pending = requirePendingImport(previewId)
  const selected = selectedImportActions(pending, decisions)
  const mutations: ProviderProfileMutation[] = selected.flatMap(({ item, action }) => {
    if (action === 'skip') return []
    return [{
      action,
      targetProviderId: action === 'update' ? item.view.targetProviderId : undefined,
      input: item.input
    }]
  })
  if (mutations.length === 0) throw new Error('没有需要应用的 Provider Profile 配置')
  const { backup, committed } = withProviderStoreMutationLock(app.getPath('userData'), () => {
    assertProviderProfileImportCurrent(pending)
    const backup = createProviderProfileBackup('import')
    const safetyBinding = readBackupBinding(backup.id)
    const committed = executeProviderProfileStoreOperation(
      'import',
      prepareProviderProfileMutations(mutations),
      {
        safetyBackupId: safetyBinding.id,
        safetyBackupDigest: safetyBinding.digest
      },
      operationOptions
    )
    return { backup, committed }
  })
  pendingImports.delete(previewId)
  return {
    operationId: committed.operationId,
    providers: committed.providers,
    backup,
    created: selected.filter((item) => item.action === 'create').length,
    updated: selected.filter((item) => item.action === 'update').length,
    skipped: selected.filter((item) => item.action === 'skip').length
  }
}

export function preflightProviderProfilePreview(
  previewId: string,
  decisions: ProviderProfileImportDecision[]
): void {
  reconcileProviderProfileOperations()
  const pending = requirePendingImport(previewId)
  const selected = selectedImportActions(pending, decisions)
  if (selected.every(({ action }) => action === 'skip')) {
    throw new Error('没有需要应用的 Provider Profile 配置')
  }
  assertProviderProfileImportCurrent(pending)
}

export function listProviderProfileBackups(): ProviderProfileBackupView[] {
  reconcileProviderProfileOperations()
  const root = backupRoot()
  if (!existsSync(root)) return []
  assertPrivateDirectory(root)
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        return [backupView(readBackup(join(root, name)))]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, PROVIDER_PROFILE_BACKUP_MAX_COUNT)
}

export function deleteProviderProfileBackup(backupId: string): { deletedBackupId: string } {
  reconcileProviderProfileOperations()
  const normalizedId = normalizedBackupId(backupId)
  const protectedIds = protectedProviderProfileBackupIds(
    pendingBackups.values(),
    providerProfileOperationJournal().list()
  )
  if (protectedIds.has(normalizedId)) {
    throw new Error('Provider Profile 备份正被未完成操作或预览引用，暂时不能删除')
  }
  const filePath = join(backupRoot(), `${normalizedId}.json`)
  readBackup(filePath)
  removeProviderProfileBackupFile(filePath)
  return { deletedBackupId: normalizedId }
}

export function previewProviderProfileBackup(backupId: string): ProviderProfileBackupPreview {
  reconcileProviderProfileOperations()
  const normalizedId = normalizedBackupId(backupId)
  const backup = readBackup(join(backupRoot(), `${normalizedId}.json`))
  const providers = listProviders()
  const items = backupChangeItems(backup.providers, providers)
  const previewId = randomUUID()
  const preview: ProviderProfileBackupPreview = {
    previewId,
    backup: backupView(backup),
    createCount: items.filter((item) => item.action === 'create').length,
    updateCount: items.filter((item) => item.action === 'update').length,
    deleteCount: items.filter((item) => item.action === 'delete').length,
    unchangedCount: items.filter((item) => item.action === 'unchanged').length,
    credentialReentryCount: backup.excludedCredentialCount,
    items
  }
  prunePendingBackups()
  pendingBackups.set(previewId, {
    createdAt: Date.now(),
    backupId: backup.id,
    backupDigest: backup.payloadDigest,
    providerConfigurationDigest: providerConfigurationDigest(providers),
    preview
  })
  return preview
}

export function applyProviderProfileBackupPreview(
  previewId: string,
  operationOptions: ProviderProfileOperationTestOptions = {}
): ProviderProfileRollbackResult {
  reconcileProviderProfileOperations()
  const pending = requirePendingBackup(previewId)
  const committed = withProviderStoreMutationLock(app.getPath('userData'), () => {
    if (providerConfigurationDigest(listProviders()) !== pending.providerConfigurationDigest) {
      pendingBackups.delete(previewId)
      throw new Error('Provider configuration changed after preview; preview the version again before rollback')
    }
    const backup = readBackup(join(backupRoot(), `${pending.backupId}.json`))
    if (backup.payloadDigest !== pending.backupDigest) {
      pendingBackups.delete(previewId)
      throw new Error('Provider Profile backup changed after preview')
    }
    const safetyBackup = createProviderProfileBackup('manual')
    const safetyBinding = readBackupBinding(safetyBackup.id)
    return executeProviderProfileStoreOperation(
      'rollback',
      prepareProviderStoreBackupRestore(backup.providers),
      {
        safetyBackupId: safetyBinding.id,
        safetyBackupDigest: safetyBinding.digest,
        sourceBackupId: backup.id,
        sourceBackupDigest: backup.payloadDigest
      },
      operationOptions
    )
  })
  pendingBackups.delete(previewId)
  return {
    operationId: committed.operationId,
    providers: committed.providers,
    restoredBackupId: pending.backupId
  }
}

export function rollbackProviderProfileBackup(
  backupId: string,
  operationOptions: ProviderProfileOperationTestOptions = {}
): ProviderProfileRollbackResult {
  reconcileProviderProfileOperations()
  const normalizedId = backupId.trim()
  if (!BACKUP_ID.test(normalizedId)) throw new Error('Provider Profile 备份 ID 无效')
  const committed = withProviderStoreMutationLock(app.getPath('userData'), () => {
    const backup = readBackup(join(backupRoot(), `${normalizedId}.json`))
    const safetyBackup = createProviderProfileBackup('manual')
    const safetyBinding = readBackupBinding(safetyBackup.id)
    return executeProviderProfileStoreOperation(
      'rollback',
      prepareProviderStoreBackupRestore(backup.providers),
      {
        safetyBackupId: safetyBinding.id,
        safetyBackupDigest: safetyBinding.digest,
        sourceBackupId: backup.id,
        sourceBackupDigest: backup.payloadDigest
      },
      operationOptions
    )
  })
  return {
    operationId: committed.operationId,
    providers: committed.providers,
    restoredBackupId: normalizedId
  }
}

export function commitPreparedProviderStoreOperation(
  operation: ProviderProfileOperationKind,
  prepared: PreparedProviderProfileStoreMutation,
  operationOptions: ProviderProfileOperationTestOptions = {}
): { operationId: string; providers: ProviderProfileApplyResult['providers'] } {
  reconcileProviderProfileOperations()
  return withProviderStoreMutationLock(app.getPath('userData'), () => {
    const safetyBackup = createProviderProfileBackup(operation === 'import' ? 'import' : 'manual')
    const safetyBinding = readBackupBinding(safetyBackup.id)
    const sourceBinding = operation === 'rollback'
      ? readBackupBinding(createProviderProfileBackup('manual').id)
      : undefined
    return executeProviderProfileStoreOperation(
      operation,
      prepared,
      {
        safetyBackupId: safetyBinding.id,
        safetyBackupDigest: safetyBinding.digest,
        ...(sourceBinding
          ? { sourceBackupId: sourceBinding.id, sourceBackupDigest: sourceBinding.digest }
          : {})
      },
      operationOptions
    )
  })
}

export function reconcileProviderProfileOperations(): ProviderProfileOperationReconciliation[] {
  return withProviderStoreMutationLock(app.getPath('userData'), () => {
    const journal = providerProfileOperationJournal()
    const entries = journal.list()
    scrubProviderProfileBackups(protectedProviderProfileBackupIds(pendingBackups.values(), entries))
    for (const entry of entries) {
      if (entry.phase !== 'prepared' && entry.phase !== 'waiting_reconciliation') continue
      try {
        assertOperationBackupBindings(entry)
      } catch (error) {
        journal.markWaitingReconciliation(entry.operationId)
        throw error
      }
    }
    const reconciliations = journal.reconcile(readProviderProfileStoreDigestStrict)
    if (reconciliations.length > 0) reloadProviderProfileStoreFromDisk()
    return reconciliations
  })
}

function executeProviderProfileStoreOperation(
  operation: ProviderProfileOperationKind,
  prepared: PreparedProviderProfileStoreMutation,
  backupBindings: ProviderProfileOperationBackupBindings,
  options: ProviderProfileOperationTestOptions
): { operationId: string; providers: ProviderProfileApplyResult['providers'] } {
  const journal = providerProfileOperationJournal()
  const entry = journal.prepare({
    operationId: options.operationId,
    operation,
    beforeSnapshotDigest: prepared.beforeSnapshotDigest,
    desiredSnapshotDigest: prepared.desiredSnapshotDigest,
    ...backupBindings
  }, readProviderProfileStoreDigestStrict)
  try {
    operationCheckpoint(options, 'after_prepare', entry.operationId)
    assertOperationBackupBindings(entry)
    const providers = commitPreparedProviderProfileStoreMutation(prepared, entry.operationId)
    operationCheckpoint(options, 'after_store_commit', entry.operationId)
    assertOperationBackupBindings(entry)
    journal.markCommitted(entry.operationId, readProviderProfileStoreDigestStrict)
    return { operationId: entry.operationId, providers }
  } catch (error) {
    try {
      reconcileProviderProfileOperations()
    } catch (reconciliationError) {
      throw new AggregateError(
        [error, reconciliationError],
        `Provider Profile ${entry.operationId} 需要人工对账`
      )
    }
    throw error
  }
}

function operationCheckpoint(
  options: ProviderProfileOperationTestOptions,
  checkpoint: NonNullable<ProviderProfileOperationTestOptions['faultAt']>,
  operationId: string
): void {
  options.onCheckpoint?.(checkpoint, operationId)
  if (options.faultAt !== checkpoint) return
  options.onFault?.(checkpoint, operationId)
  throw new Error(`Provider Profile fault injected at ${checkpoint}`)
}

function providerProfileOperationJournal(): ProviderProfileOperationJournal {
  return new ProviderProfileOperationJournal(app.getPath('userData'))
}

function selectedImportActions(
  pending: PendingProviderProfileImport,
  decisions: ProviderProfileImportDecision[]
): Array<{ item: PlannedProviderProfileItem; action: ProviderProfileImportDecision['action'] }> {
  if (!Array.isArray(decisions)) throw new Error('Provider Profile 导入选择无效')
  const byItem = new Map<string, ProviderProfileImportDecision['action']>()
  for (const decision of decisions) {
    if (!decision || typeof decision.itemId !== 'string' || byItem.has(decision.itemId)) {
      throw new Error('Provider Profile 导入选择重复或无效')
    }
    byItem.set(decision.itemId, decision.action)
  }
  return pending.items.map((item) => {
    const action = byItem.get(item.view.id) ?? item.view.defaultAction
    if (!item.view.allowedActions.includes(action)) throw new Error('Provider Profile 导入操作不允许')
    if (action === 'update' && !item.view.targetProviderId) throw new Error('Provider Profile 缺少更新目标')
    return { item, action }
  })
}

function requirePendingImport(previewId: string): PendingProviderProfileImport {
  prunePendingImports()
  const pending = pendingImports.get(previewId.trim())
  if (!pending) throw new Error('Provider Profile 预览已失效，请重新选择文件')
  return pending
}

function assertProviderProfileImportCurrent(pending: PendingProviderProfileImport): void {
  if (providerConfigurationDigest(listProviders()) === pending.providerConfigurationDigest) return
  pendingImports.delete(pending.preview.previewId)
  throw new Error('Provider 配置在预览后已变化，请重新预览后再应用')
}

function prunePendingImports(): void {
  const expiredBefore = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingImports) {
    if (pending.createdAt < expiredBefore) pendingImports.delete(id)
  }
  while (pendingImports.size >= MAX_PENDING_PREVIEWS) {
    const oldest = pendingImports.keys().next().value as string | undefined
    if (!oldest) break
    pendingImports.delete(oldest)
  }
}

function requirePendingBackup(previewId: string): PendingProviderProfileBackup {
  prunePendingBackups()
  const pending = pendingBackups.get(previewId.trim())
  if (!pending) throw new Error('Provider Profile backup preview expired; preview the version again')
  return pending
}

function prunePendingBackups(): void {
  const expiredBefore = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingBackups) {
    if (pending.createdAt < expiredBefore) pendingBackups.delete(id)
  }
  while (pendingBackups.size >= MAX_PENDING_PREVIEWS) {
    const oldest = pendingBackups.keys().next().value as string | undefined
    if (!oldest) break
    pendingBackups.delete(oldest)
  }
}

function normalizedBackupId(backupId: string): string {
  const normalizedId = backupId.trim()
  if (!BACKUP_ID.test(normalizedId)) throw new Error('Provider Profile backup ID is invalid')
  return normalizedId
}

function backupChangeItems(
  backupProviders: Provider[],
  currentProviders: ReturnType<typeof listProviders>
): ProviderProfileBackupChange[] {
  const currentById = new Map(currentProviders.map((provider) => [provider.id, provider]))
  const backupIds = new Set(backupProviders.map((provider) => provider.id))
  const items: ProviderProfileBackupChange[] = backupProviders.map((provider) => {
    const current = currentById.get(provider.id)
    if (!current) {
      return { id: provider.id, providerName: provider.name, action: 'create', changedFields: [] }
    }
    const changedFields = providerBackupChangedFields(provider, current)
    return {
      id: provider.id,
      providerName: provider.name,
      action: changedFields.length > 0 ? 'update' : 'unchanged',
      changedFields
    }
  })
  for (const provider of currentProviders) {
    if (backupIds.has(provider.id)) continue
    items.push({ id: provider.id, providerName: provider.name, action: 'delete', changedFields: [] })
  }
  return items.sort((left, right) => {
    const actionOrder = { create: 0, update: 1, delete: 2, unchanged: 3 }
    return actionOrder[left.action] - actionOrder[right.action]
      || left.providerName.localeCompare(right.providerName)
  })
}

function createProviderProfileBackup(reason: ProviderProfileBackupView['reason']): ProviderProfileBackupView {
  const snapshot = snapshotProviderStoreForBackup()
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`
  const payload: ProviderProfileBackupPayload = {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_VERSION,
    id,
    createdAt,
    reason,
    providerCount: snapshot.providers.length,
    nonPersistentCredentialCount: snapshot.nonPersistentCredentialCount,
    excludedCredentialCount: snapshot.excludedCredentialCount,
    providers: snapshot.providers
  }
  const document: ProviderProfileBackupDocument = {
    ...payload,
    payloadDigest: digestPayload(payload)
  }
  const filePath = join(backupRoot(), `${id}.json`)
  writeAtomicFile(filePath, `${JSON.stringify(document, null, 2)}\n`, 0o600, true)
  return backupView(readBackup(filePath))
}

function readBackup(filePath: string): ProviderProfileBackupDocument {
  const document = validateBackupDocument(parseBackup(filePath))
  if (basename(filePath, '.json') !== document.id) {
    throw new Error('Provider Profile 备份文件与内嵌 ID 不匹配')
  }
  const { payloadDigest, ...payload } = document
  if (digestPayload(payload) !== payloadDigest) throw new Error('Provider Profile 备份完整性校验失败')
  return migrateBackupCredentials(filePath, document)
}

function parseBackup(filePath: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(readRegularFile(filePath, true, 16 * 1024 * 1024))
  } catch {
    throw new Error('Provider Profile 备份损坏')
  }
  return value
}

function validateBackupDocument(value: unknown): ProviderProfileBackupDocument {
  const document = value as Partial<ProviderProfileBackupDocument>
  if (!hasValidBackupIdentity(document)
    || !hasValidBackupCounts(document)
    || !hasValidBackupPayload(document)) {
    throw new Error('Provider Profile 备份格式无效')
  }
  return document as ProviderProfileBackupDocument
}

function hasValidBackupIdentity(document: Partial<ProviderProfileBackupDocument> | null): boolean {
  return Boolean(document)
    && document?.kind === BACKUP_KIND
    && document.schemaVersion === BACKUP_VERSION
    && typeof document.id === 'string'
    && BACKUP_ID.test(document.id)
    && typeof document.createdAt === 'string'
    && Number.isFinite(Date.parse(document.createdAt))
    && [
      'import',
      'manual',
      'provider-create',
      'provider-update',
      'provider-delete'
    ].includes(String(document.reason))
}

function hasValidBackupCounts(document: Partial<ProviderProfileBackupDocument>): boolean {
  return isNonNegativeInteger(document.providerCount)
    && isNonNegativeInteger(document.nonPersistentCredentialCount)
    && (document.excludedCredentialCount === undefined
      || isNonNegativeInteger(document.excludedCredentialCount))
}

function hasValidBackupPayload(document: Partial<ProviderProfileBackupDocument>): boolean {
  return Array.isArray(document.providers)
    && document.providerCount === document.providers.length
    && typeof document.payloadDigest === 'string'
}

function readBackupBinding(backupId: string): { id: string; digest: string } {
  const backup = readBackup(join(backupRoot(), `${backupId}.json`))
  return { id: backup.id, digest: backup.payloadDigest }
}

function assertOperationBackupBindings(entry: ProviderProfileOperationJournalEntry): void {
  const safety = readBackupBinding(entry.safetyBackupId)
  if (safety.id !== entry.safetyBackupId || safety.digest !== entry.safetyBackupDigest) {
    throw new Error(`Provider Profile ${entry.operationId} safety backup digest 不匹配`)
  }
  if (entry.operation !== 'rollback') return
  if (!entry.sourceBackupId || !entry.sourceBackupDigest) {
    throw new Error(`Provider Profile ${entry.operationId} 缺少 rollback source backup digest`)
  }
  const source = readBackupBinding(entry.sourceBackupId)
  if (source.id !== entry.sourceBackupId || source.digest !== entry.sourceBackupDigest) {
    throw new Error(`Provider Profile ${entry.operationId} source backup digest 不匹配`)
  }
}

function migrateBackupCredentials(
  filePath: string,
  document: ProviderProfileBackupDocument
): ProviderProfileBackupDocument {
  const sanitized = sanitizeProviderStoreBackupCredentials(document.providers)
  const hasExclusionCount = isNonNegativeInteger(document.excludedCredentialCount)
  const providersChanged = JSON.stringify(sanitized.providers) !== JSON.stringify(document.providers)
  if (hasExclusionCount && sanitized.excludedCredentialCount === 0 && !providersChanged) return document
  const { payloadDigest: _oldDigest, ...oldPayload } = document
  const payload: ProviderProfileBackupPayload = {
    ...oldPayload,
    excludedCredentialCount: (hasExclusionCount ? document.excludedCredentialCount : 0)
      + sanitized.excludedCredentialCount,
    providers: sanitized.providers
  }
  const migrated = { ...payload, payloadDigest: digestPayload(payload) }
  writeAtomicFile(filePath, `${JSON.stringify(migrated, null, 2)}\n`, 0o600, true)
  return migrated
}

function scrubProviderProfileBackups(protectedIds: ReadonlySet<string>): void {
  const root = backupRoot()
  if (!existsSync(root)) return
  assertPrivateDirectory(root)
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue
    try { readBackup(join(root, name)) } catch { /* unusable backups stay excluded from rollback */ }
  }
  pruneProviderProfileBackups(root, protectedIds, {
    maxCount: PROVIDER_PROFILE_BACKUP_MAX_COUNT,
    maxAgeMs: PROVIDER_PROFILE_BACKUP_MAX_AGE_MS,
    readBackup,
    backupId: (backup) => backup.id,
    createdAt: (backup) => backup.createdAt,
    removeFile: removeProviderProfileBackupFile
  })
}

function backupView(document: ProviderProfileBackupPayload): ProviderProfileBackupView {
  const createdAt = Date.parse(document.createdAt)
  return {
    id: document.id,
    createdAt: document.createdAt,
    expiresAt: new Date(createdAt + PROVIDER_PROFILE_BACKUP_MAX_AGE_MS).toISOString(),
    providerCount: document.providerCount,
    reason: document.reason,
    nonPersistentCredentialCount: document.nonPersistentCredentialCount,
    excludedCredentialCount: document.excludedCredentialCount
  }
}

function removeProviderProfileBackupFile(filePath: string): void {
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Provider Profile 备份必须是可删除的常规文件')
  }
  unlinkSync(filePath)
  fsyncDirectory(dirname(filePath))
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function digestPayload(payload: ProviderProfileBackupPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function providerConfigurationDigest(providers: ReturnType<typeof listProviders>): string {
  const configuration = [...providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models,
      authMode: provider.authMode,
      engine: provider.engine,
      customHeaders: provider.customHeaders,
      credentialHeaderNames: provider.credentialHeaderNames,
      credentialRoutingMode: provider.credentialRoutingMode,
      budgetUsd: provider.budgetUsd,
      openaiProtocol: provider.openaiProtocol,
      note: provider.note,
      authorization: provider.authorization,
      advancedConfig: provider.advancedConfig,
      keyCount: provider.keyCount,
      activeKeyId: provider.activeKeyId,
      credentialMigrationRequired: provider.credentialMigrationRequired
    }))
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
}

function backupRoot(): string {
  return join(app.getPath('userData'), 'provider-profile-backups')
}

function readRegularFile(filePath: string, privateFile = false, maxBytes = 2 * 1024 * 1024): string {
  if (!existsSync(filePath)) throw new Error('Provider Profile 文件不存在')
  if (process.platform === 'win32') {
    try {
      const pathInfo = lstatSync(filePath)
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
        throw new Error('Provider Profile 必须是常规文件')
      }
    } catch {
      throw new Error('Provider Profile 必须是可读的常规文件')
    }
  }
  let descriptor: number
  try {
    const defensiveFlags = process.platform === 'win32'
      ? 0
      : constants.O_NOFOLLOW | constants.O_NONBLOCK
    descriptor = openSync(filePath, constants.O_RDONLY | defensiveFlags)
  } catch {
    throw new Error('Provider Profile 必须是可读的常规文件')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile()) throw new Error('Provider Profile 必须是常规文件')
    if (info.size > maxBytes) throw new Error('Provider Profile 文件过大')
    if (privateFile && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error('Provider Profile 备份权限不安全')
    }
    return readBoundedUtf8(descriptor, maxBytes)
  } finally {
    closeSync(descriptor)
  }
}

function readBoundedUtf8(descriptor: number, maxBytes: number): string {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    total += bytesRead
  }
  if (total > maxBytes) throw new Error('Provider Profile 文件过大')
  return Buffer.concat(chunks, total).toString('utf8')
}

function assertPrivateDirectory(directory: string): void {
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Provider Profile 备份目录无效')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('Provider Profile 备份目录权限不安全')
  }
}

function writeAtomicFile(filePath: string, content: string, mode: number, privateDirectory: boolean): void {
  const directory = dirname(filePath)
  if (privateDirectory) ensurePrivateDirectory(directory)
  else mkdirSync(directory, { recursive: true })
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) throw new Error('拒绝写入符号链接')
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', mode)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, filePath)
    if (process.platform !== 'win32') chmodSync(filePath, mode)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* best effort */ }
    }
    throw error
  }
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  assertPrivateDirectory(directory)
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // Some filesystems do not support directory fsync; the file itself is already durable.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
