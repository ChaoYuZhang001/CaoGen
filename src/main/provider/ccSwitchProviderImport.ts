import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  ProviderInput,
  ProviderProfileConflictKind,
  ProviderProfileImportAction,
  ProviderProfileImportDecision,
  ProviderView
} from '../../shared/types'
import type {
  CcSwitchProviderImportApplyResult,
  CcSwitchProviderImportBackupView,
  CcSwitchProviderImportItem,
  CcSwitchProviderImportPreview,
  CcSwitchProviderImportRollbackResult
} from '../../shared/cc-switch-import-types'
import {
  listProviders,
  readProviderProfileStoreDigestStrict
} from '../providers'
import { mergeCcSwitchAdvancedConfig } from './ccSwitchAdvancedConfigMerge'
import { readCcSwitchSourceSnapshot, type CcSwitchParsedProvider } from './ccSwitchProviderSource'
import {
  commitPreparedProviderStoreOperation,
  reconcileProviderProfileOperations,
  type ProviderProfileOperationTestOptions
} from './providerProfileService'
import { ProviderProfileOperationJournal } from './providerProfileOperationJournal'
import {
  prepareAtomicProviderBatch,
  type AtomicProviderBatchMutation
} from './providerAtomicBatch'

const PREVIEW_TTL_MS = 15 * 60 * 1_000
const MAX_PENDING = 12
const BACKUP_KIND = 'caogen-cc-switch-provider-import-backup'
const BACKUP_VERSION = 2
const LEGACY_BACKUP_VERSION = 1
const BACKUP_ID = /^[0-9TZ-]{19,40}-[0-9a-f-]{36}$/i
const SHA256 = /^[0-9a-f]{64}$/
const IMPORTED_KEY_LABEL = 'CC Switch import'

interface PlannedCcSwitchProvider {
  source: CcSwitchParsedProvider
  view: CcSwitchProviderImportItem
}

interface PendingCcSwitchImport {
  createdAt: number
  preview: CcSwitchProviderImportPreview
  items: PlannedCcSwitchProvider[]
  sourceDigest: string
  providerDigest: string
}

interface CcSwitchMutationBackup {
  action: 'create' | 'update'
  providerId: string
  providerName: string
  addedKeyIds: string[]
  afterDigest: string
  previous?: ProviderView
}

interface CcSwitchBackupBase {
  kind: typeof BACKUP_KIND
  id: string
  createdAt: string
  mutations: CcSwitchMutationBackup[]
}

interface LegacyCcSwitchBackupPayload extends CcSwitchBackupBase {
  schemaVersion: typeof LEGACY_BACKUP_VERSION
  rolledBackAt?: string
}

type DurableCcSwitchBackupState =
  | 'prepared'
  | 'applied'
  | 'rollback_prepared'
  | 'rolled_back'
  | 'aborted'
  | 'waiting_reconciliation'

interface DurableCcSwitchBackupPayload extends CcSwitchBackupBase {
  schemaVersion: typeof BACKUP_VERSION
  state: DurableCcSwitchBackupState
  applyOperationId: string
  beforeSnapshotDigest: string
  appliedSnapshotDigest: string
  rollbackOperationId?: string
  rollbackBeforeSnapshotDigest?: string
  rollbackDesiredSnapshotDigest?: string
  rolledBackAt?: string
}

type CcSwitchBackupPayload = LegacyCcSwitchBackupPayload | DurableCcSwitchBackupPayload

type CcSwitchBackupDocument = CcSwitchBackupPayload & {
  payloadDigest: string
}

const pendingImports = new Map<string, PendingCcSwitchImport>()

export function previewCcSwitchProviderImport(): CcSwitchProviderImportPreview {
  reconcileCcSwitchProviderImportOperations()
  prunePendingImports()
  const source = readCcSwitchSourceSnapshot()
  const providers = listProviders()
  const items = source.providers.map((candidate) => planCandidate(candidate, providers))
  const previewId = randomUUID()
  const preview: CcSwitchProviderImportPreview = {
    previewId,
    databasePresent: true,
    providerCount: source.providerCount,
    importableCount: items.filter((item) => item.source.input).length,
    credentialCount: items.filter((item) => item.source.token).length,
    pricedModelCount: items.reduce((total, item) => total + item.source.pricedModelCount, 0),
    skippedCount: items.filter((item) => item.view.defaultAction === 'skip').length,
    items: items.map((item) => item.view),
    expiresAt: Date.now() + PREVIEW_TTL_MS
  }
  pendingImports.set(previewId, {
    createdAt: Date.now(),
    preview,
    items,
    sourceDigest: source.sourceDigest,
    providerDigest: providerConfigurationDigest(providers)
  })
  return preview
}

export function applyCcSwitchProviderImport(
  previewId: string,
  decisions: ProviderProfileImportDecision[],
  operationOptions: ProviderProfileOperationTestOptions = {}
): CcSwitchProviderImportApplyResult {
  reconcileCcSwitchProviderImportOperations()
  prunePendingImports()
  const pending = pendingImports.get(previewId.trim())
  if (!pending) throw new Error('CC Switch import preview expired; scan again')
  const selected = selectedActions(pending, decisions)
  const actionable = selected.filter((selection): selection is typeof selection & {
    action: Exclude<ProviderProfileImportAction, 'skip'>
  } => selection.action !== 'skip')
  if (actionable.length === 0) throw new Error('No CC Switch Provider changes were selected')
  if (readCcSwitchSourceSnapshot().sourceDigest !== pending.sourceDigest) {
    pendingImports.delete(previewId)
    throw new Error('CC Switch configuration changed after preview; scan again')
  }
  if (providerConfigurationDigest(listProviders()) !== pending.providerDigest) {
    pendingImports.delete(previewId)
    throw new Error('CaoGen Provider configuration changed after preview; scan again')
  }

  const batch = prepareAtomicProviderBatch(actionable.map(({ item, action }) => action === 'create'
    ? {
        action,
        input: {
          ...requireImportInput(item),
          ...(item.source.token ? { token: item.source.token, tokenLabel: IMPORTED_KEY_LABEL } : {})
        }
      }
    : {
        action,
        providerId: requireTargetProviderId(item),
        patch: updateInput(requireImportInput(item), requireTargetProvider(item), item.source.token)
      }))
  const mutations = batch.items.map((result, index): CcSwitchMutationBackup => ({
    action: actionable[index].action,
    providerId: result.providerId,
    providerName: result.provider?.name ?? actionable[index].item.view.name,
    addedKeyIds: result.addedKeyIds,
    afterDigest: providerDigest(requireBatchProvider(result.provider)),
    ...(result.previous ? { previous: result.previous } : {})
  }))
  const operationId = operationOptions.operationId ?? randomUUID()
  const preparedBackup = writePreparedBackup(
    mutations,
    operationId,
    batch.prepared.beforeSnapshotDigest,
    batch.prepared.desiredSnapshotDigest
  )
  try {
    const committed = commitPreparedProviderStoreOperation('import', batch.prepared, {
      ...operationOptions,
      operationId
    })
    const backup = updateBackup(preparedBackup, { state: 'applied' })
    pendingImports.delete(previewId)
    return {
      operationId: committed.operationId,
      created: mutations.filter((mutation) => mutation.action === 'create').length,
      updated: mutations.filter((mutation) => mutation.action === 'update').length,
      skipped: selected.filter((selection) => selection.action === 'skip').length,
      providers: committed.providers,
      backup: backupView(backup)
    }
  } catch (error) {
    if (readProviderProfileStoreDigestStrict() !== batch.prepared.desiredSnapshotDigest) {
      batch.restoreRuntimeCredentials()
    }
    try { reconcileCcSwitchProviderImportOperations() } catch { /* preserve the original operation error */ }
    throw error
  }
}

export function listCcSwitchProviderImportBackups(): CcSwitchProviderImportBackupView[] {
  reconcileCcSwitchProviderImportOperations()
  const root = backupRoot()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const backup = readBackup(join(root, name))
        return backupIsApplied(backup) ? [backupView(backup)] : []
      } catch {
        return []
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function rollbackCcSwitchProviderImportBackup(
  backupId: string,
  operationOptions: ProviderProfileOperationTestOptions = {}
): CcSwitchProviderImportRollbackResult {
  reconcileCcSwitchProviderImportOperations()
  const normalizedId = backupId.trim()
  if (!BACKUP_ID.test(normalizedId)) throw new Error('CC Switch import backup id is invalid')
  const filePath = join(backupRoot(), `${normalizedId}.json`)
  const backup = readBackup(filePath)
  if (!backupIsApplied(backup)) throw new Error('CC Switch import backup is not available for rollback')
  assertRollbackTargetsUnchanged(backup.mutations)
  const batch = prepareAtomicProviderBatch(rollbackBatchMutations(backup.mutations))
  const operationId = operationOptions.operationId ?? randomUUID()
  const durable = durableBackup(backup)
  const prepared = updateBackup(durable, {
    state: 'rollback_prepared',
    rollbackOperationId: operationId,
    rollbackBeforeSnapshotDigest: batch.prepared.beforeSnapshotDigest,
    rollbackDesiredSnapshotDigest: batch.prepared.desiredSnapshotDigest,
    rolledBackAt: undefined
  })
  try {
    const committed = commitPreparedProviderStoreOperation('rollback', batch.prepared, {
      ...operationOptions,
      operationId
    })
    updateBackup(prepared, { state: 'rolled_back', rolledBackAt: new Date().toISOString() })
    return { operationId: committed.operationId, restoredBackupId: normalizedId, providers: committed.providers }
  } catch (error) {
    if (readProviderProfileStoreDigestStrict() !== batch.prepared.desiredSnapshotDigest) {
      batch.restoreRuntimeCredentials()
    }
    try { reconcileCcSwitchProviderImportOperations() } catch { /* preserve the original operation error */ }
    throw error
  }
}

export function reconcileCcSwitchProviderImportOperations(): Array<{
  backupId: string
  state: DurableCcSwitchBackupState
}> {
  let providerOperationError: unknown
  try {
    reconcileProviderProfileOperations()
  } catch (error) {
    providerOperationError = error
  }
  const root = backupRoot()
  if (!existsSync(root)) {
    if (providerOperationError) throw providerOperationError
    return []
  }
  const journal = new ProviderProfileOperationJournal(app.getPath('userData'))
  const currentDigest = readProviderProfileStoreDigestStrict()
  const results: Array<{ backupId: string; state: DurableCcSwitchBackupState }> = []
  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json'))) {
    const filePath = join(root, name)
    let document: CcSwitchBackupDocument
    try {
      document = readBackup(filePath)
    } catch {
      continue
    }
    if (document.schemaVersion !== BACKUP_VERSION
      || !['prepared', 'rollback_prepared', 'waiting_reconciliation'].includes(document.state)) continue
    const nextState = reconciledBackupState(document, journal, currentDigest)
    const updated = nextState === document.state
      ? document
      : updateBackup(document, {
          state: nextState,
          ...(nextState === 'rolled_back' ? { rolledBackAt: document.rolledBackAt ?? new Date().toISOString() } : {}),
          ...(nextState === 'applied' ? { rolledBackAt: undefined } : {})
        })
    results.push({ backupId: updated.id, state: updated.state })
  }
  if (providerOperationError) throw providerOperationError
  return results
}

function reconciledBackupState(
  document: DurableCcSwitchBackupPayload & { payloadDigest: string },
  journal: ProviderProfileOperationJournal,
  currentDigest: string
): DurableCcSwitchBackupState {
  const binding = recoveryBinding(document)
  const entry = journal.get(binding.operationId)
  if (entry && !journalEntryMatches(entry, binding)) return 'waiting_reconciliation'
  if (currentDigest === binding.desiredDigest && entry?.phase === 'committed') return binding.committedState
  if (currentDigest === binding.beforeDigest && (!entry || entry.phase === 'aborted')) return binding.abortedState
  return 'waiting_reconciliation'
}

function recoveryBinding(document: DurableCcSwitchBackupPayload): {
  operationId: string
  beforeDigest: string
  desiredDigest: string
  committedState: DurableCcSwitchBackupState
  abortedState: DurableCcSwitchBackupState
} {
  if (document.rollbackOperationId
    && document.rollbackBeforeSnapshotDigest
    && document.rollbackDesiredSnapshotDigest) {
    return {
      operationId: document.rollbackOperationId,
      beforeDigest: document.rollbackBeforeSnapshotDigest,
      desiredDigest: document.rollbackDesiredSnapshotDigest,
      committedState: 'rolled_back',
      abortedState: 'applied'
    }
  }
  return {
    operationId: document.applyOperationId,
    beforeDigest: document.beforeSnapshotDigest,
    desiredDigest: document.appliedSnapshotDigest,
    committedState: 'applied',
    abortedState: 'aborted'
  }
}

function journalEntryMatches(
  entry: ReturnType<ProviderProfileOperationJournal['get']> & {},
  binding: ReturnType<typeof recoveryBinding>
): boolean {
  return entry.beforeSnapshotDigest === binding.beforeDigest
    && entry.desiredSnapshotDigest === binding.desiredDigest
}

function planCandidate(source: CcSwitchParsedProvider, providers: ProviderView[]): PlannedCcSwitchProvider {
  if (!source.input) {
    return {
      source,
      view: {
        id: source.sourceId,
        sourceApp: source.sourceApp,
        name: 'Unsupported CC Switch Provider',
        baseUrl: '',
        engine: 'openai',
        openaiProtocol: 'responses',
        models: [],
        credentialPresent: Boolean(source.token),
        credentialImportable: false,
        dailyLimitUsd: source.dailyLimitUsd,
        costMultiplier: source.costMultiplier,
        pricedModelCount: 0,
        conflict: 'none',
        changedFields: [],
        warnings: source.warnings,
        defaultAction: 'skip',
        allowedActions: ['skip']
      }
    }
  }
  const match = matchProvider(source.input, providers)
  const canUpdate = match.conflict === 'same_provider' && Boolean(match.target)
  const changedFields = changedProviderFields(source.input, match.target)
  const warnings = [...source.warnings]
  if (match.target?.hasToken && source.token) warnings.push('existing_credential_preserved')
  const defaultAction: ProviderProfileImportAction = canUpdate
    ? changedFields.length > 0 || (!match.target?.hasToken && Boolean(source.token)) ? 'update' : 'skip'
    : match.conflict === 'none' ? 'create' : 'skip'
  return {
    source,
    view: {
      id: source.sourceId,
      sourceApp: source.sourceApp,
      name: source.input.name,
      baseUrl: source.input.baseUrl,
      engine: source.input.engine ?? 'openai',
      openaiProtocol: source.input.openaiProtocol,
      models: source.input.models,
      credentialPresent: Boolean(source.token),
      credentialImportable: Boolean(source.token) && !Boolean(match.target?.hasToken),
      monthlyBudgetUsd: source.input.budgetUsd,
      dailyLimitUsd: source.dailyLimitUsd,
      costMultiplier: source.costMultiplier,
      pricedModelCount: source.pricedModelCount,
      targetProviderId: match.target?.id,
      targetProviderName: match.target?.name,
      conflict: match.conflict,
      changedFields,
      warnings: [...new Set(warnings)],
      defaultAction,
      allowedActions: canUpdate ? ['update', 'create', 'skip'] : ['create', 'skip']
    }
  }
}

function updateInput(input: ProviderInput, target: ProviderView, token: string | undefined): Partial<ProviderInput> {
  return {
    name: target.name,
    baseUrl: input.baseUrl,
    models: input.models.length > 0 ? input.models : target.models,
    engine: input.engine,
    openaiProtocol: input.openaiProtocol,
    authMode: target.authMode,
    customHeaders: target.customHeaders ?? '',
    credentialHeaderNames: target.credentialHeaderNames,
    budgetUsd: input.budgetUsd ?? target.budgetUsd,
    note: input.note ?? target.note ?? '',
    authorization: target.authorization,
    advancedConfig: mergeCcSwitchAdvancedConfig(target.advancedConfig, input.advancedConfig ?? undefined),
    credentialRoutingMode: target.credentialRoutingMode,
    ...(!target.hasToken && token ? { token, tokenLabel: IMPORTED_KEY_LABEL } : {})
  }
}

function requireImportInput(item: PlannedCcSwitchProvider): ProviderInput {
  if (!item.source.input) throw new Error('CC Switch Provider is not importable')
  return item.source.input
}

function requireTargetProviderId(item: PlannedCcSwitchProvider): string {
  const providerId = item.view.targetProviderId?.trim()
  if (!providerId) throw new Error('CC Switch import target Provider is unavailable')
  return providerId
}

function requireTargetProvider(item: PlannedCcSwitchProvider): ProviderView {
  const providerId = requireTargetProviderId(item)
  const provider = listProviders().find((candidate) => candidate.id === providerId)
  if (!provider) throw new Error('CC Switch import target Provider is unavailable')
  return provider
}

function requireBatchProvider(provider: ProviderView | undefined): ProviderView {
  if (!provider) throw new Error('CC Switch Provider batch result is incomplete')
  return provider
}

function matchProvider(input: ProviderInput, providers: ProviderView[]): {
  target?: ProviderView
  conflict: ProviderProfileConflictKind
} {
  const engine = input.engine ?? 'openai'
  const exact = providers.filter((provider) => normalizedUrl(provider.baseUrl) === normalizedUrl(input.baseUrl)
    && provider.engine === engine
    && (engine !== 'openai' || (provider.openaiProtocol ?? 'responses') === (input.openaiProtocol ?? 'responses')))
  if (exact.length === 1) return { target: exact[0], conflict: 'same_provider' }
  if (exact.length > 1) return { conflict: 'ambiguous' }
  const byName = providers.filter((provider) => provider.name.trim().toLowerCase() === input.name.trim().toLowerCase())
  if (byName.length === 1) return { target: byName[0], conflict: 'name' }
  if (byName.length > 1) return { conflict: 'ambiguous' }
  return { conflict: 'none' }
}

function changedProviderFields(input: ProviderInput, target: ProviderView | undefined): string[] {
  if (!target) return ['name', 'baseUrl', 'engine', 'protocol', 'models', 'pricing', 'budget']
  const incomingModels = input.models.length > 0 ? input.models : target.models
  const incomingAdvanced = mergeCcSwitchAdvancedConfig(target.advancedConfig, input.advancedConfig ?? undefined)
  const comparisons: Array<[string, boolean]> = [
    ['baseUrl', normalizedUrl(target.baseUrl) !== normalizedUrl(input.baseUrl)],
    ['engine', target.engine !== (input.engine ?? 'openai')],
    ['protocol', (target.openaiProtocol ?? 'responses') !== (input.openaiProtocol ?? 'responses')],
    ['models', JSON.stringify(target.models) !== JSON.stringify(incomingModels)],
    ['budget', (target.budgetUsd || 0) !== (input.budgetUsd ?? target.budgetUsd ?? 0)],
    ['reliability', digest(target.advancedConfig?.reliability ?? {}) !== digest(incomingAdvanced.reliability ?? {})],
    ['pricing', digest(target.advancedConfig ?? {}) !== digest(incomingAdvanced)]
  ]
  return comparisons.filter(([, changed]) => changed).map(([field]) => field)
}

function selectedActions(
  pending: PendingCcSwitchImport,
  decisions: ProviderProfileImportDecision[]
): Array<{ item: PlannedCcSwitchProvider; action: ProviderProfileImportAction }> {
  if (!Array.isArray(decisions)) throw new Error('CC Switch import decisions are invalid')
  const byId = new Map<string, ProviderProfileImportAction>()
  for (const decision of decisions) {
    if (!decision || typeof decision.itemId !== 'string' || byId.has(decision.itemId)
      || !['create', 'update', 'skip'].includes(decision.action)) {
      throw new Error('CC Switch import decisions are invalid or duplicated')
    }
    byId.set(decision.itemId, decision.action)
  }
  return pending.items.map((item) => {
    const action = byId.get(item.view.id) ?? item.view.defaultAction
    if (!item.view.allowedActions.includes(action)) throw new Error('CC Switch import action is not allowed')
    return { item, action }
  })
}

function rollbackBatchMutations(mutations: CcSwitchMutationBackup[]): AtomicProviderBatchMutation[] {
  return [...mutations].reverse().map((mutation) => {
    if (mutation.action === 'create') return { action: 'delete', providerId: mutation.providerId }
    if (!mutation.previous) throw new Error('CC Switch import rollback backup is incomplete')
    const previous = mutation.previous
    return {
      action: 'update',
      providerId: previous.id,
      patch: {
        name: previous.name,
        baseUrl: previous.baseUrl,
        models: previous.models,
        engine: previous.engine,
        authMode: previous.authMode,
        customHeaders: previous.customHeaders ?? '',
        credentialHeaderNames: previous.credentialHeaderNames,
        budgetUsd: previous.budgetUsd,
        openaiProtocol: previous.openaiProtocol,
        note: previous.note ?? '',
        authorization: previous.authorization,
        advancedConfig: previous.advancedConfig ?? null,
        removeKeyIds: mutation.addedKeyIds,
        activeKeyId: previous.activeKeyId,
        credentialRoutingMode: previous.credentialRoutingMode
      }
    }
  })
}

function assertRollbackTargetsUnchanged(mutations: CcSwitchMutationBackup[]): void {
  const providers = listProviders()
  for (const mutation of mutations) {
    const current = providers.find((provider) => provider.id === mutation.providerId)
    if (!current || providerDigest(current) !== mutation.afterDigest) {
      throw new Error(`Imported Provider changed after CC Switch import: ${mutation.providerName}`)
    }
  }
}

function writePreparedBackup(
  mutations: CcSwitchMutationBackup[],
  operationId: string,
  beforeSnapshotDigest: string,
  appliedSnapshotDigest: string
): CcSwitchBackupDocument {
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`
  const document = withDigest({
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_VERSION,
    id,
    createdAt,
    mutations,
    state: 'prepared',
    applyOperationId: operationId,
    beforeSnapshotDigest,
    appliedSnapshotDigest
  })
  writeAtomicJson(join(backupRoot(), `${id}.json`), document, true)
  return document
}

function readBackup(filePath: string): CcSwitchBackupDocument {
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('CC Switch import backup is invalid')
  const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<CcSwitchBackupDocument>
  assertBackupIdentity(value, filePath)
  const document = value as CcSwitchBackupDocument
  const { payloadDigest, ...payload } = document
  if (digest(payload) !== payloadDigest) throw new Error('CC Switch import backup integrity check failed')
  if (document.schemaVersion === BACKUP_VERSION && !validDurableBackup(document)) {
    throw new Error('CC Switch import backup recovery metadata is invalid')
  }
  return document
}

function assertBackupIdentity(
  value: Partial<CcSwitchBackupDocument>,
  filePath: string
): asserts value is CcSwitchBackupDocument {
  if (value.kind !== BACKUP_KIND || !knownBackupVersion(value.schemaVersion)) invalidBackup()
  if (typeof value.id !== 'string' || !BACKUP_ID.test(value.id)) invalidBackup()
  if (basename(filePath, '.json') !== value.id) invalidBackup()
  if (typeof value.createdAt !== 'string' || !Array.isArray(value.mutations)) invalidBackup()
  if (typeof value.payloadDigest !== 'string') invalidBackup()
}

function knownBackupVersion(value: unknown): boolean {
  return value === LEGACY_BACKUP_VERSION || value === BACKUP_VERSION
}

function invalidBackup(): never {
  throw new Error('CC Switch import backup is invalid')
}

function validDurableBackup(document: CcSwitchBackupDocument): document is DurableCcSwitchBackupPayload & { payloadDigest: string } {
  if (document.schemaVersion !== BACKUP_VERSION) return false
  const states: DurableCcSwitchBackupState[] = [
    'prepared', 'applied', 'rollback_prepared', 'rolled_back', 'aborted', 'waiting_reconciliation'
  ]
  return states.includes(document.state)
    && typeof document.applyOperationId === 'string'
    && SHA256.test(document.beforeSnapshotDigest)
    && SHA256.test(document.appliedSnapshotDigest)
    && (document.rollbackOperationId === undefined || typeof document.rollbackOperationId === 'string')
    && (document.rollbackBeforeSnapshotDigest === undefined || SHA256.test(document.rollbackBeforeSnapshotDigest))
    && (document.rollbackDesiredSnapshotDigest === undefined || SHA256.test(document.rollbackDesiredSnapshotDigest))
}

function durableBackup(document: CcSwitchBackupDocument): DurableCcSwitchBackupPayload & { payloadDigest: string } {
  if (document.schemaVersion === BACKUP_VERSION) return document
  const snapshotDigest = readProviderProfileStoreDigestStrict()
  return withDigest({
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_VERSION,
    id: document.id,
    createdAt: document.createdAt,
    mutations: document.mutations,
    state: document.rolledBackAt ? 'rolled_back' : 'applied',
    applyOperationId: `legacy:${digest({ id: document.id }).slice(0, 40)}`,
    beforeSnapshotDigest: snapshotDigest,
    appliedSnapshotDigest: snapshotDigest,
    ...(document.rolledBackAt ? { rolledBackAt: document.rolledBackAt } : {})
  })
}

function updateBackup(
  document: CcSwitchBackupDocument,
  patch: Partial<DurableCcSwitchBackupPayload>
): DurableCcSwitchBackupPayload & { payloadDigest: string } {
  const durable = durableBackup(document)
  const payload = {
    ...withoutDigest(durable),
    ...patch,
    schemaVersion: BACKUP_VERSION
  } as DurableCcSwitchBackupPayload
  const next = withDigest(payload)
  if (next.schemaVersion !== BACKUP_VERSION || !validDurableBackup(next)) {
    throw new Error('CC Switch import backup recovery transition is invalid')
  }
  writeAtomicJson(join(backupRoot(), `${next.id}.json`), next, false)
  return next
}

function backupIsApplied(document: CcSwitchBackupDocument): boolean {
  return document.schemaVersion === LEGACY_BACKUP_VERSION
    ? !document.rolledBackAt
    : document.state === 'applied'
}

function writeAtomicJson(filePath: string, document: CcSwitchBackupDocument, exclusive: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    if (exclusive && existsSync(filePath)) throw new Error('CC Switch import backup already exists')
    renameSync(temporary, filePath)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

function backupView(document: CcSwitchBackupPayload): CcSwitchProviderImportBackupView {
  return {
    id: document.id,
    createdAt: document.createdAt,
    providerCount: document.mutations.length,
    createdCount: document.mutations.filter((mutation) => mutation.action === 'create').length,
    updatedCount: document.mutations.filter((mutation) => mutation.action === 'update').length,
    importedCredentialCount: document.mutations.reduce((total, mutation) => total + mutation.addedKeyIds.length, 0)
  }
}

function providerConfigurationDigest(providers: ProviderView[]): string {
  return digest(providers.map(providerDigestInput))
}

function providerDigest(provider: ProviderView): string {
  return digest(providerDigestInput(provider))
}

function providerDigestInput(provider: ProviderView): unknown {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models,
    engine: provider.engine,
    authMode: provider.authMode,
    customHeaders: provider.customHeaders,
    credentialHeaderNames: provider.credentialHeaderNames,
    budgetUsd: provider.budgetUsd,
    openaiProtocol: provider.openaiProtocol,
    note: provider.note,
    authorization: provider.authorization,
    advancedConfig: provider.advancedConfig,
    credentialRoutingMode: provider.credentialRoutingMode,
    activeKeyId: provider.activeKeyId,
    keys: provider.apiKeys?.map((key) => ({ id: key.id, label: key.label, disabled: key.disabled, policy: key.policy }))
  }
}

function prunePendingImports(): void {
  const expired = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingImports) if (pending.createdAt < expired) pendingImports.delete(id)
  while (pendingImports.size >= MAX_PENDING) {
    const first = pendingImports.keys().next().value as string | undefined
    if (!first) break
    pendingImports.delete(first)
  }
}

function backupRoot(): string {
  return join(app.getPath('userData'), 'cc-switch-provider-import-backups')
}

function normalizedUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function withDigest<T extends CcSwitchBackupPayload>(value: T): T & { payloadDigest: string } {
  return { ...value, payloadDigest: digest(value) }
}

function withoutDigest(value: CcSwitchBackupDocument): CcSwitchBackupPayload {
  const { payloadDigest: _payloadDigest, ...payload } = value
  return payload
}
