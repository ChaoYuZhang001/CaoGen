import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ProviderProfileApplyResult,
  ProviderProfileImportDecision,
  ProviderProfileSyncHistoryEntry,
  ProviderProfileSyncHistoryPreview,
  ProviderProfileSyncRelation,
  ProviderProfileWebDavApplyResult,
  ProviderProfileWebDavConfigInput,
  ProviderProfileWebDavConfigView,
  ProviderProfileWebDavConnectionResult,
  ProviderProfileWebDavPreview,
  ProviderProfileWebDavPublishResult,
  ProviderProfileWebDavStatus
} from '../../shared/types'
import type { ProviderCredentialRecord } from '../providerCredentialBroker'
import {
  forgetProviderCredential,
  inspectProviderCredential,
  resolveProviderCredential,
  restoreProviderCredentials,
  snapshotProviderCredentials,
  storeProviderCredential
} from '../providerCredentialRuntime'
import {
  applyProviderProfilePreview,
  previewProviderProfileDocument,
  reconcileProviderProfileOperations
} from './providerProfileService'
import {
  createProviderProfileSyncEnvelope,
  currentProviderProfileSyncSnapshot
} from './providerProfileSync'
import {
  normalizeProviderWebDavConfig,
  listProviderWebDavHistory,
  providerWebDavEndpointLabel,
  publishProviderWebDavRemote,
  readProviderWebDavRemote,
  readProviderWebDavHistory,
  testProviderWebDavTransport,
  type ProviderWebDavRemoteSnapshot,
  type ProviderWebDavTransportConfig
} from './providerWebDavTransport'

const CONFIG_KIND = 'caogen-provider-profile-webdav-config'
const CONFIG_VERSION = 1
const PREVIEW_TTL_MS = 15 * 60 * 1_000
const MAX_CONFIG_BYTES = 128 * 1024
const CREDENTIAL_REF = { providerId: 'provider-profile-sync:webdav', keyId: 'password' }
const DEFAULT_INTERVAL_MINUTES = 15

interface WebDavConfigState {
  kind: typeof CONFIG_KIND
  schemaVersion: typeof CONFIG_VERSION
  configRevision: string
  deviceId: string
  baseUrl: string
  username: string
  password?: ProviderCredentialRecord
  remotePath: string
  autoSyncEnabled: boolean
  autoPullEnabled?: boolean
  autoSyncIntervalMinutes: number
  lastAppliedRevisionId?: string
  lastAppliedProfileDigest?: string
  lastSyncAt?: string
  lastError?: string
}

interface PendingWebDavPreview {
  createdAt: number
  configRevision: string
  localProfileDigest: string
  remoteFileDigest?: string
  remoteEtag?: string
  remoteRevisionId?: string
  importPreviewId?: string
  relation: ProviderProfileSyncRelation
}

interface PendingHistoryPreview {
  createdAt: number
  configRevision: string
  revisionId: string
  fileDigest: string
  importPreviewId: string
}

const pendingPreviews = new Map<string, PendingWebDavPreview>()
const pendingHistoryPreviews = new Map<string, PendingHistoryPreview>()
let operationTail: Promise<void> = Promise.resolve()
let autoSyncTimer: NodeJS.Timeout | undefined
let lastAutoSyncCheck = 0

export function getProviderProfileWebDavConfig(): ProviderProfileWebDavConfigView {
  const state = readState()
  return state ? configView(state) : emptyConfigView()
}

export function saveProviderProfileWebDavConfig(
  input: ProviderProfileWebDavConfigInput
): ProviderProfileWebDavConfigView {
  const previous = readState()
  const password = resolvedInputPassword(input.password, previous)
  const normalized = normalizeProviderWebDavConfig({
    baseUrl: input.baseUrl,
    username: input.username,
    password,
    remotePath: input.remotePath
  })
  const snapshot = snapshotProviderCredentials(CREDENTIAL_REF.providerId)
  try {
    const passwordRecord = input.password === undefined
      ? previous?.password
      : input.password ? storeProviderCredential(CREDENTIAL_REF, input.password) : undefined
    if (!passwordRecord) forgetProviderCredential(CREDENTIAL_REF)
    const state: WebDavConfigState = {
      kind: CONFIG_KIND,
      schemaVersion: CONFIG_VERSION,
      configRevision: randomUUID(),
      deviceId: previous?.deviceId ?? randomUUID(),
      baseUrl: normalized.baseUrl,
      username: normalized.username,
      password: passwordRecord,
      remotePath: normalized.remotePath,
      autoSyncEnabled: Boolean(input.autoSyncEnabled),
      autoPullEnabled: Boolean(input.autoPullEnabled),
      autoSyncIntervalMinutes: normalizedInterval(input.autoSyncIntervalMinutes),
      ...(sameTarget(previous, normalized)
        ? {
            lastAppliedRevisionId: previous?.lastAppliedRevisionId,
            lastAppliedProfileDigest: previous?.lastAppliedProfileDigest,
            lastSyncAt: previous?.lastSyncAt
          }
        : {})
    }
    writeState(state)
    pendingPreviews.clear()
    return configView(state)
  } catch (error) {
    restoreProviderCredentials(CREDENTIAL_REF.providerId, snapshot)
    throw error
  }
}

export function removeProviderProfileWebDavConfig(): ProviderProfileWebDavConfigView {
  const filePath = configFilePath()
  if (existsSync(filePath)) {
    const info = lstatSync(filePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('WebDAV configuration file is invalid')
    unlinkSync(filePath)
    syncDirectory(dirname(filePath))
  }
  forgetProviderCredential(CREDENTIAL_REF)
  pendingPreviews.clear()
  pendingHistoryPreviews.clear()
  return emptyConfigView()
}

export function testProviderProfileWebDavConnection(): Promise<ProviderProfileWebDavConnectionResult> {
  return withOperationLock(async () => {
    const state = requireState()
    await testProviderWebDavTransport(transportConfig(state))
    return { ok: true, endpointLabel: providerWebDavEndpointLabel(state.baseUrl) }
  })
}

export function previewProviderProfileWebDavSync(): Promise<ProviderProfileWebDavPreview> {
  return withOperationLock(async () => previewUnlocked(requireState()))
}

export function publishProviderProfileWebDavSync(
  previewId: string,
  allowDiverged: boolean
): Promise<ProviderProfileWebDavPublishResult> {
  return withOperationLock(async () => {
    const state = requireState()
    const pending = requirePending(previewId, state)
    if ((pending.relation === 'diverged' || pending.relation === 'remote_ahead') && !allowDiverged) {
      throw new Error('WebDAV remote contains unmerged changes; explicitly choose this device before publishing')
    }
    const local = currentProviderProfileSyncSnapshot()
    if (local.providerCount === 0) throw new Error('There is no Provider configuration to publish')
    if (local.profileDigest !== pending.localProfileDigest) throw new Error('Local Provider configuration changed after preview')
    const remote = await readProviderWebDavRemote(transportConfig(state))
    assertRemoteUnchanged(pending, remote)
    const envelope = createProviderProfileSyncEnvelope(state.deviceId, remote?.envelope.revisionId)
    const published = await publishProviderWebDavRemote(transportConfig(state), envelope, remote)
    const next = syncedState(state, published.envelope)
    writeState(next)
    pendingPreviews.delete(previewId)
    return {
      revisionId: published.envelope.revisionId,
      providerCount: published.envelope.providerCount,
      status: statusView(next, local.providerCount, 'in_sync', published)
    }
  })
}

export function applyProviderProfileWebDavSync(
  previewId: string,
  decisions: ProviderProfileImportDecision[]
): Promise<ProviderProfileWebDavApplyResult> {
  return withOperationLock(async () => {
    const state = requireState()
    const pending = requirePending(previewId, state)
    const remote = await readProviderWebDavRemote(transportConfig(state))
    assertRemoteUnchanged(pending, remote)
    if (!remote || !pending.importPreviewId) throw new Error('There are no remote Provider changes to apply')
    const result = applyProviderProfilePreview(pending.importPreviewId, decisions)
    const local = currentProviderProfileSyncSnapshot()
    const aligned = local.profileDigest === remote.envelope.profileDigest
    const next = aligned ? syncedState(state, remote.envelope) : state
    if (aligned) writeState(next)
    pendingPreviews.delete(previewId)
    return {
      ...result,
      status: statusView(next, local.providerCount, aligned ? 'in_sync' : relation(next, local.profileDigest, remote.envelope.profileDigest), remote)
    }
  })
}

export function listProviderProfileWebDavHistory(): Promise<ProviderProfileSyncHistoryEntry[]> {
  return withOperationLock(async () => {
    const state = requireState()
    const history = await listProviderWebDavHistory(transportConfig(state))
    return history.map((snapshot) => historyEntry(snapshot))
  })
}

export function previewProviderProfileWebDavHistory(revisionId: string): Promise<ProviderProfileSyncHistoryPreview> {
  return withOperationLock(async () => {
    const state = requireState()
    const remote = await readProviderWebDavHistory(transportConfig(state), revisionId)
    if (!remote || remote.envelope.revisionId !== revisionId) throw new Error('WebDAV history revision was not found')
    const importPreview = previewProviderProfileDocument(
      `${JSON.stringify(remote.envelope.profile, null, 2)}\n`,
      'WebDAV Provider Profile history'
    )
    pruneHistoryPending()
    const previewId = randomUUID()
    pendingHistoryPreviews.set(previewId, {
      createdAt: Date.now(),
      configRevision: state.configRevision,
      revisionId,
      fileDigest: remote.fileDigest,
      importPreviewId: importPreview.previewId
    })
    return { previewId, entry: historyEntry(remote), importPreview }
  })
}

export function applyProviderProfileWebDavHistory(
  previewId: string,
  decisions: ProviderProfileImportDecision[]
): Promise<ProviderProfileApplyResult> {
  return withOperationLock(async () => {
    const state = requireState()
    const pending = requireHistoryPending(previewId, state)
    const remote = await readProviderWebDavHistory(transportConfig(state), pending.revisionId)
    if (!remote || remote.fileDigest !== pending.fileDigest || remote.envelope.revisionId !== pending.revisionId) {
      throw new Error('WebDAV history revision changed after preview')
    }
    const result = applyProviderProfilePreview(pending.importPreviewId, decisions)
    pendingHistoryPreviews.delete(previewId)
    return result
  })
}

export function startProviderProfileWebDavAutoSync(): void {
  if (autoSyncTimer) return
  autoSyncTimer = setInterval(() => { void runProviderProfileWebDavAutoSync() }, 60_000)
  autoSyncTimer.unref()
}

export function stopProviderProfileWebDavAutoSync(): void {
  if (autoSyncTimer) clearInterval(autoSyncTimer)
  autoSyncTimer = undefined
}

export function runProviderProfileWebDavAutoSync(now = Date.now()): Promise<'disabled' | 'waiting' | 'synced' | 'attention' | 'failed'> {
  return withOperationLock(async () => {
    const state = readState()
    if (!state?.autoSyncEnabled) return 'disabled'
    const intervalMs = state.autoSyncIntervalMinutes * 60_000
    if (now - lastAutoSyncCheck < intervalMs) return 'waiting'
    lastAutoSyncCheck = now
    try {
      const remote = await readProviderWebDavRemote(transportConfig(state))
      const local = currentProviderProfileSyncSnapshot()
      const currentRelation = relation(state, local.profileDigest, remote?.envelope.profileDigest)
      if (currentRelation === 'in_sync' && remote) {
        writeState(syncedState(state, remote.envelope))
        return 'synced'
      }
      if ((currentRelation === 'remote_missing' || currentRelation === 'local_ahead') && local.providerCount > 0) {
        const envelope = createProviderProfileSyncEnvelope(state.deviceId, remote?.envelope.revisionId)
        const published = await publishProviderWebDavRemote(transportConfig(state), envelope, remote)
        writeState(syncedState(state, published.envelope))
        return 'synced'
      }
      if (currentRelation === 'remote_ahead' && state.autoPullEnabled && remote) {
        if (applyRemoteAutomatically(remote)) {
          writeState(syncedState(state, remote.envelope))
          return 'synced'
        }
      }
      writeState({ ...state, lastError: 'Remote Provider changes require review before synchronization' })
      return 'attention'
    } catch (error) {
      writeState({ ...state, lastError: safeError(error) })
      return 'failed'
    }
  })
}

async function previewUnlocked(state: WebDavConfigState): Promise<ProviderProfileWebDavPreview> {
  reconcileProviderProfileOperations()
  const local = currentProviderProfileSyncSnapshot()
  const remote = await readProviderWebDavRemote(transportConfig(state))
  const currentRelation = relation(state, local.profileDigest, remote?.envelope.profileDigest)
  const effectiveState = currentRelation === 'in_sync' && remote ? syncedState(state, remote.envelope) : state
  if (effectiveState !== state) writeState(effectiveState)
  const previewId = randomUUID()
  const importPreview = remote && currentRelation !== 'in_sync'
    ? previewProviderProfileDocument(`${JSON.stringify(remote.envelope.profile, null, 2)}\n`, 'WebDAV Provider Profile')
    : undefined
  prunePending()
  pendingPreviews.set(previewId, {
    createdAt: Date.now(),
    configRevision: state.configRevision,
    localProfileDigest: local.profileDigest,
    remoteFileDigest: remote?.fileDigest,
    remoteEtag: remote?.etag,
    remoteRevisionId: remote?.envelope.revisionId,
    importPreviewId: importPreview?.previewId,
    relation: currentRelation
  })
  return {
    previewId,
    status: statusView(effectiveState, local.providerCount, currentRelation, remote),
    importPreview,
    canPublish: currentRelation !== 'in_sync' && local.providerCount > 0,
    canPull: Boolean(remote) && currentRelation !== 'in_sync',
    requiresConflictChoice: currentRelation === 'diverged'
  }
}

function transportConfig(state: WebDavConfigState): ProviderWebDavTransportConfig {
  const resolved = state.password ? resolveProviderCredential(CREDENTIAL_REF, state.password) : undefined
  if (state.password && (!resolved?.available || resolved.token === undefined)) {
    throw new Error('WebDAV password is unavailable; save the connection again')
  }
  return { baseUrl: state.baseUrl, username: state.username, password: resolved?.token ?? '', remotePath: state.remotePath }
}

function readState(): WebDavConfigState | undefined {
  const filePath = configFilePath()
  if (!existsSync(filePath)) return undefined
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error('WebDAV configuration file is invalid')
  let value: unknown
  try { value = JSON.parse(readFileSync(filePath, 'utf8')) } catch { throw new Error('WebDAV configuration is corrupted') }
  if (!validState(value)) throw new Error('WebDAV configuration is invalid')
  return value
}

function writeState(state: WebDavConfigState): void {
  if (!validState(state)) throw new Error('WebDAV configuration is invalid')
  const filePath = configFilePath()
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  try {
    const descriptor = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temp, filePath)
    if (process.platform !== 'win32') chmodSync(filePath, 0o600)
    syncDirectory(dirname(filePath))
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
}

function validState(value: unknown): value is WebDavConfigState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<WebDavConfigState>
  return state.kind === CONFIG_KIND
    && state.schemaVersion === CONFIG_VERSION
    && nonEmpty(state.configRevision)
    && nonEmpty(state.deviceId)
    && nonEmpty(state.baseUrl)
    && typeof state.username === 'string'
    && nonEmpty(state.remotePath)
    && typeof state.autoSyncEnabled === 'boolean'
    && (state.autoPullEnabled === undefined || typeof state.autoPullEnabled === 'boolean')
    && validInterval(state.autoSyncIntervalMinutes)
    && validPasswordRecord(state.password)
}

function configView(state: WebDavConfigState): ProviderProfileWebDavConfigView {
  const password = state.password ? inspectProviderCredential(CREDENTIAL_REF, state.password) : undefined
  return {
    configured: true,
    endpointLabel: providerWebDavEndpointLabel(state.baseUrl),
    baseUrl: state.baseUrl,
    username: state.username,
    remotePath: state.remotePath,
    passwordConfigured: Boolean(password?.available),
    autoSyncEnabled: state.autoSyncEnabled,
    autoPullEnabled: Boolean(state.autoPullEnabled),
    autoSyncIntervalMinutes: state.autoSyncIntervalMinutes,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError
  }
}

function emptyConfigView(): ProviderProfileWebDavConfigView {
  return {
    configured: false,
    passwordConfigured: false,
    autoSyncEnabled: false,
    autoPullEnabled: false,
    autoSyncIntervalMinutes: DEFAULT_INTERVAL_MINUTES
  }
}

function statusView(
  state: WebDavConfigState,
  localProviderCount: number,
  currentRelation: ProviderProfileSyncRelation,
  remote?: ProviderWebDavRemoteSnapshot
): ProviderProfileWebDavStatus {
  return {
    relation: currentRelation,
    localProviderCount,
    remoteProviderCount: remote?.envelope.providerCount,
    remoteCreatedAt: remote?.envelope.createdAt,
    endpointLabel: providerWebDavEndpointLabel(state.baseUrl)
  }
}

function applyRemoteAutomatically(remote: ProviderWebDavRemoteSnapshot): boolean {
  reconcileProviderProfileOperations()
  const preview = previewProviderProfileDocument(
    `${JSON.stringify(remote.envelope.profile, null, 2)}\n`,
    'WebDAV Provider Profile automatic pull'
  )
  if (preview.items.length === 0 || preview.items.some((item) => item.defaultAction === 'skip')) return false
  applyProviderProfilePreview(preview.previewId, preview.items.map((item) => ({
    itemId: item.id,
    action: item.defaultAction
  })))
  return currentProviderProfileSyncSnapshot().profileDigest === remote.envelope.profileDigest
}

function relation(state: WebDavConfigState, localDigest: string, remoteDigest?: string): ProviderProfileSyncRelation {
  if (!remoteDigest) return 'remote_missing'
  if (localDigest === remoteDigest) return 'in_sync'
  if (state.lastAppliedProfileDigest === remoteDigest) return 'local_ahead'
  if (state.lastAppliedProfileDigest === localDigest) return 'remote_ahead'
  return 'diverged'
}

function syncedState(state: WebDavConfigState, envelope: ProviderWebDavRemoteSnapshot['envelope']): WebDavConfigState {
  return {
    ...state,
    lastAppliedRevisionId: envelope.revisionId,
    lastAppliedProfileDigest: envelope.profileDigest,
    lastSyncAt: new Date().toISOString(),
    lastError: undefined
  }
}

function requireState(): WebDavConfigState {
  const state = readState()
  if (!state) throw new Error('Configure WebDAV Provider sync first')
  return state
}

function requirePending(previewId: string, state: WebDavConfigState): PendingWebDavPreview {
  prunePending()
  const pending = pendingPreviews.get(String(previewId).trim())
  if (!pending || pending.configRevision !== state.configRevision) throw new Error('WebDAV sync preview expired')
  return pending
}

function assertRemoteUnchanged(pending: PendingWebDavPreview, remote: ProviderWebDavRemoteSnapshot | undefined): void {
  if (remote?.fileDigest !== pending.remoteFileDigest || remote?.etag !== pending.remoteEtag
    || remote?.envelope.revisionId !== pending.remoteRevisionId) {
    throw new Error('WebDAV remote configuration changed after preview')
  }
}

function historyEntry(remote: ProviderWebDavRemoteSnapshot): ProviderProfileSyncHistoryEntry {
  return {
    revisionId: remote.envelope.revisionId,
    parentRevisionId: remote.envelope.parentRevisionId,
    createdAt: remote.envelope.createdAt,
    providerCount: remote.envelope.providerCount,
    deviceId: remote.envelope.deviceId
  }
}

function requireHistoryPending(previewId: string, state: WebDavConfigState): PendingHistoryPreview {
  pruneHistoryPending()
  const pending = pendingHistoryPreviews.get(String(previewId).trim())
  if (!pending || pending.configRevision !== state.configRevision) throw new Error('WebDAV history preview expired')
  return pending
}

function pruneHistoryPending(): void {
  const cutoff = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingHistoryPreviews) if (pending.createdAt < cutoff) pendingHistoryPreviews.delete(id)
  while (pendingHistoryPreviews.size >= 20) pendingHistoryPreviews.delete(pendingHistoryPreviews.keys().next().value as string)
}

function prunePending(): void {
  const cutoff = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingPreviews) if (pending.createdAt < cutoff) pendingPreviews.delete(id)
  while (pendingPreviews.size >= 20) pendingPreviews.delete(pendingPreviews.keys().next().value as string)
}

function resolvedInputPassword(value: string | undefined, previous: WebDavConfigState | undefined): string {
  if (value !== undefined) return value
  if (!previous?.password) return ''
  const resolved = resolveProviderCredential(CREDENTIAL_REF, previous.password)
  if (!resolved.available || resolved.token === undefined) throw new Error('Existing WebDAV password is unavailable')
  return resolved.token
}

function sameTarget(previous: WebDavConfigState | undefined, normalized: ProviderWebDavTransportConfig): boolean {
  return Boolean(previous)
    && previous?.baseUrl === normalized.baseUrl
    && previous.username === normalized.username
    && previous.remotePath === normalized.remotePath
}

function normalizedInterval(value: number): number {
  if (!validInterval(value)) throw new Error('WebDAV auto-sync interval must be between 5 and 1440 minutes')
  return value
}

function validInterval(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 5 && Number(value) <= 1_440
}

function validPasswordRecord(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ProviderCredentialRecord>
  return typeof record.encryptedToken === 'string'
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value)
}

function configFilePath(): string {
  return join(app.getPath('userData'), 'provider-profile-webdav', 'config.json')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'WebDAV synchronization failed'
  return message.slice(0, 500)
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // File fsync completed; some platforms do not support directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

async function withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = operationTail
  let release = (): void => undefined
  operationTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try { return await operation() } finally { release() }
}
