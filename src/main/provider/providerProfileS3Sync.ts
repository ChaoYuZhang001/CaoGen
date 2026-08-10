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
  ProviderProfileS3ApplyResult,
  ProviderProfileS3ConfigInput,
  ProviderProfileS3ConfigView,
  ProviderProfileS3ConnectionResult,
  ProviderProfileS3Preview,
  ProviderProfileS3PublishResult,
  ProviderProfileS3Status,
  ProviderProfileSyncRelation
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
  normalizeProviderS3Config,
  listProviderS3History,
  providerS3EndpointLabel,
  publishProviderS3Remote,
  readProviderS3Remote,
  readProviderS3History,
  testProviderS3Transport,
  type ProviderS3RemoteSnapshot,
  type ProviderS3TransportConfig
} from './providerS3Transport'

const CONFIG_KIND = 'caogen-provider-profile-s3-config'
const CONFIG_VERSION = 1
const PREVIEW_TTL_MS = 15 * 60 * 1_000
const MAX_CONFIG_BYTES = 160 * 1024
const CREDENTIAL_PROVIDER_ID = 'provider-profile-sync:s3'
const ACCESS_KEY_REF = { providerId: CREDENTIAL_PROVIDER_ID, keyId: 'access-key-id' }
const SECRET_KEY_REF = { providerId: CREDENTIAL_PROVIDER_ID, keyId: 'secret-access-key' }
const SESSION_TOKEN_REF = { providerId: CREDENTIAL_PROVIDER_ID, keyId: 'session-token' }
const DEFAULT_INTERVAL_MINUTES = 15

interface S3ConfigState {
  kind: typeof CONFIG_KIND
  schemaVersion: typeof CONFIG_VERSION
  configRevision: string
  deviceId: string
  endpoint: string
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
  accessKeyId: ProviderCredentialRecord
  secretAccessKey: ProviderCredentialRecord
  sessionToken?: ProviderCredentialRecord
  autoSyncEnabled: boolean
  autoPullEnabled?: boolean
  autoSyncIntervalMinutes: number
  lastAppliedRevisionId?: string
  lastAppliedProfileDigest?: string
  lastSyncAt?: string
  lastError?: string
}

interface PendingS3Preview {
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

const pendingPreviews = new Map<string, PendingS3Preview>()
const pendingHistoryPreviews = new Map<string, PendingHistoryPreview>()
let operationTail: Promise<void> = Promise.resolve()
let autoSyncTimer: NodeJS.Timeout | undefined
let lastAutoSyncCheck = 0

export function getProviderProfileS3Config(): ProviderProfileS3ConfigView {
  const state = readState()
  return state ? configView(state) : emptyConfigView()
}

export function saveProviderProfileS3Config(input: ProviderProfileS3ConfigInput): ProviderProfileS3ConfigView {
  const previous = readState()
  const credentials = resolvedInputCredentials(input, previous)
  const normalized = normalizeProviderS3Config({
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix,
    forcePathStyle: input.forcePathStyle,
    ...credentials
  })
  const snapshot = snapshotProviderCredentials(CREDENTIAL_PROVIDER_ID)
  try {
    const state: S3ConfigState = {
      kind: CONFIG_KIND,
      schemaVersion: CONFIG_VERSION,
      configRevision: randomUUID(),
      deviceId: previous?.deviceId ?? randomUUID(),
      endpoint: normalized.endpoint,
      region: normalized.region,
      bucket: normalized.bucket,
      prefix: normalized.prefix,
      forcePathStyle: normalized.forcePathStyle,
      accessKeyId: input.accessKeyId === undefined
        ? previous?.accessKeyId as ProviderCredentialRecord
        : storeProviderCredential(ACCESS_KEY_REF, normalized.accessKeyId),
      secretAccessKey: input.secretAccessKey === undefined
        ? previous?.secretAccessKey as ProviderCredentialRecord
        : storeProviderCredential(SECRET_KEY_REF, normalized.secretAccessKey),
      sessionToken: sessionTokenRecord(input.sessionToken, normalized.sessionToken, previous),
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
    restoreProviderCredentials(CREDENTIAL_PROVIDER_ID, snapshot)
    throw error
  }
}

export function removeProviderProfileS3Config(): ProviderProfileS3ConfigView {
  const filePath = configFilePath()
  if (existsSync(filePath)) {
    const info = lstatSync(filePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('S3 configuration file is invalid')
    unlinkSync(filePath)
    syncDirectory(dirname(filePath))
  }
  forgetProviderCredential(ACCESS_KEY_REF)
  forgetProviderCredential(SECRET_KEY_REF)
  forgetProviderCredential(SESSION_TOKEN_REF)
  pendingPreviews.clear()
  pendingHistoryPreviews.clear()
  return emptyConfigView()
}

export function testProviderProfileS3Connection(): Promise<ProviderProfileS3ConnectionResult> {
  return withOperationLock(async () => {
    const state = requireState()
    await testProviderS3Transport(transportConfig(state))
    return { ok: true, endpointLabel: providerS3EndpointLabel(state) }
  })
}

export function previewProviderProfileS3Sync(): Promise<ProviderProfileS3Preview> {
  return withOperationLock(async () => previewUnlocked(requireState()))
}

export function publishProviderProfileS3Sync(
  previewId: string,
  allowDiverged: boolean
): Promise<ProviderProfileS3PublishResult> {
  return withOperationLock(async () => {
    const state = requireState()
    const pending = requirePending(previewId, state)
    if ((pending.relation === 'diverged' || pending.relation === 'remote_ahead') && !allowDiverged) {
      throw new Error('S3 contains unmerged changes; explicitly choose this device before publishing')
    }
    const local = currentProviderProfileSyncSnapshot()
    if (local.providerCount === 0) throw new Error('There is no Provider configuration to publish')
    if (local.profileDigest !== pending.localProfileDigest) throw new Error('Local Provider configuration changed after preview')
    const remote = await readProviderS3Remote(transportConfig(state))
    assertRemoteUnchanged(pending, remote)
    const envelope = createProviderProfileSyncEnvelope(state.deviceId, remote?.envelope.revisionId)
    const published = await publishProviderS3Remote(transportConfig(state), envelope, remote)
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

export function applyProviderProfileS3Sync(
  previewId: string,
  decisions: ProviderProfileImportDecision[]
): Promise<ProviderProfileS3ApplyResult> {
  return withOperationLock(async () => {
    const state = requireState()
    const pending = requirePending(previewId, state)
    const remote = await readProviderS3Remote(transportConfig(state))
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
      status: statusView(
        next,
        local.providerCount,
        aligned ? 'in_sync' : relation(next, local.profileDigest, remote.envelope.profileDigest),
        remote
      )
    }
  })
}

export function listProviderProfileS3History(): Promise<ProviderProfileSyncHistoryEntry[]> {
  return withOperationLock(async () => {
    const state = requireState()
    const history = await listProviderS3History(transportConfig(state))
    return history.map((snapshot) => historyEntry(snapshot))
  })
}

export function previewProviderProfileS3History(revisionId: string): Promise<ProviderProfileSyncHistoryPreview> {
  return withOperationLock(async () => {
    const state = requireState()
    const remote = await readProviderS3History(transportConfig(state), revisionId)
    if (!remote || remote.envelope.revisionId !== revisionId) throw new Error('S3 history revision was not found')
    const importPreview = previewProviderProfileDocument(
      `${JSON.stringify(remote.envelope.profile, null, 2)}\n`,
      'S3 Provider Profile history'
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

export function applyProviderProfileS3History(
  previewId: string,
  decisions: ProviderProfileImportDecision[]
): Promise<ProviderProfileApplyResult> {
  return withOperationLock(async () => {
    const state = requireState()
    const pending = requireHistoryPending(previewId, state)
    const remote = await readProviderS3History(transportConfig(state), pending.revisionId)
    if (!remote || remote.fileDigest !== pending.fileDigest || remote.envelope.revisionId !== pending.revisionId) {
      throw new Error('S3 history revision changed after preview')
    }
    const result = applyProviderProfilePreview(pending.importPreviewId, decisions)
    pendingHistoryPreviews.delete(previewId)
    return result
  })
}

export function startProviderProfileS3AutoSync(): void {
  if (autoSyncTimer) return
  autoSyncTimer = setInterval(() => { void runProviderProfileS3AutoSync() }, 60_000)
  autoSyncTimer.unref()
}

export function stopProviderProfileS3AutoSync(): void {
  if (autoSyncTimer) clearInterval(autoSyncTimer)
  autoSyncTimer = undefined
}

export function runProviderProfileS3AutoSync(now = Date.now()): Promise<'disabled' | 'waiting' | 'synced' | 'attention' | 'failed'> {
  return withOperationLock(async () => {
    const state = readState()
    if (!state?.autoSyncEnabled) return 'disabled'
    const intervalMs = state.autoSyncIntervalMinutes * 60_000
    if (now - lastAutoSyncCheck < intervalMs) return 'waiting'
    lastAutoSyncCheck = now
    try {
      const remote = await readProviderS3Remote(transportConfig(state))
      const local = currentProviderProfileSyncSnapshot()
      const currentRelation = relation(state, local.profileDigest, remote?.envelope.profileDigest)
      if (currentRelation === 'in_sync' && remote) {
        writeState(syncedState(state, remote.envelope))
        return 'synced'
      }
      if ((currentRelation === 'remote_missing' || currentRelation === 'local_ahead') && local.providerCount > 0) {
        const envelope = createProviderProfileSyncEnvelope(state.deviceId, remote?.envelope.revisionId)
        const published = await publishProviderS3Remote(transportConfig(state), envelope, remote)
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

async function previewUnlocked(state: S3ConfigState): Promise<ProviderProfileS3Preview> {
  reconcileProviderProfileOperations()
  const local = currentProviderProfileSyncSnapshot()
  const remote = await readProviderS3Remote(transportConfig(state))
  const currentRelation = relation(state, local.profileDigest, remote?.envelope.profileDigest)
  const effectiveState = currentRelation === 'in_sync' && remote ? syncedState(state, remote.envelope) : state
  if (effectiveState !== state) writeState(effectiveState)
  const previewId = randomUUID()
  const importPreview = remote && currentRelation !== 'in_sync'
    ? previewProviderProfileDocument(`${JSON.stringify(remote.envelope.profile, null, 2)}\n`, 'S3 Provider Profile')
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

function transportConfig(state: S3ConfigState): ProviderS3TransportConfig {
  const accessKeyId = resolvedCredential(ACCESS_KEY_REF, state.accessKeyId, 'S3 Access Key ID')
  const secretAccessKey = resolvedCredential(SECRET_KEY_REF, state.secretAccessKey, 'S3 Secret Access Key')
  const sessionToken = state.sessionToken
    ? resolvedCredential(SESSION_TOKEN_REF, state.sessionToken, 'S3 session token')
    : ''
  return {
    endpoint: state.endpoint,
    region: state.region,
    bucket: state.bucket,
    prefix: state.prefix,
    forcePathStyle: state.forcePathStyle,
    accessKeyId,
    secretAccessKey,
    sessionToken
  }
}

function readState(): S3ConfigState | undefined {
  const filePath = configFilePath()
  if (!existsSync(filePath)) return undefined
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error('S3 configuration file is invalid')
  let value: unknown
  try { value = JSON.parse(readFileSync(filePath, 'utf8')) } catch { throw new Error('S3 configuration is corrupted') }
  if (!validState(value)) throw new Error('S3 configuration is invalid')
  return value
}

function writeState(state: S3ConfigState): void {
  if (!validState(state)) throw new Error('S3 configuration is invalid')
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

function validState(value: unknown): value is S3ConfigState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<S3ConfigState>
  return validStateIdentity(state)
    && validStateTarget(state)
    && validStateCredentials(state)
    && typeof state.autoSyncEnabled === 'boolean'
    && (state.autoPullEnabled === undefined || typeof state.autoPullEnabled === 'boolean')
    && validInterval(state.autoSyncIntervalMinutes)
}

function validStateIdentity(state: Partial<S3ConfigState>): boolean {
  return state.kind === CONFIG_KIND
    && state.schemaVersion === CONFIG_VERSION
    && nonEmpty(state.configRevision)
    && nonEmpty(state.deviceId)
}

function validStateTarget(state: Partial<S3ConfigState>): boolean {
  return typeof state.endpoint === 'string'
    && nonEmpty(state.region)
    && nonEmpty(state.bucket)
    && nonEmpty(state.prefix)
    && typeof state.forcePathStyle === 'boolean'
}

function validStateCredentials(state: Partial<S3ConfigState>): boolean {
  return validCredentialRecord(state.accessKeyId)
    && validCredentialRecord(state.secretAccessKey)
    && validOptionalCredentialRecord(state.sessionToken)
}

function configView(state: S3ConfigState): ProviderProfileS3ConfigView {
  const access = inspectProviderCredential(ACCESS_KEY_REF, state.accessKeyId)
  const secret = inspectProviderCredential(SECRET_KEY_REF, state.secretAccessKey)
  const session = state.sessionToken ? inspectProviderCredential(SESSION_TOKEN_REF, state.sessionToken) : undefined
  const accessToken = access.available ? resolveProviderCredential(ACCESS_KEY_REF, state.accessKeyId).token : undefined
  return {
    configured: true,
    endpoint: state.endpoint,
    endpointLabel: providerS3EndpointLabel(state),
    region: state.region,
    bucket: state.bucket,
    prefix: state.prefix,
    forcePathStyle: state.forcePathStyle,
    credentialsConfigured: Boolean(access.available && secret.available),
    accessKeyLabel: accessToken ? `••••${accessToken.slice(-4)}` : undefined,
    sessionTokenConfigured: Boolean(session?.available),
    autoSyncEnabled: state.autoSyncEnabled,
    autoPullEnabled: Boolean(state.autoPullEnabled),
    autoSyncIntervalMinutes: state.autoSyncIntervalMinutes,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError
  }
}

function emptyConfigView(): ProviderProfileS3ConfigView {
  return {
    configured: false,
    forcePathStyle: false,
    credentialsConfigured: false,
    sessionTokenConfigured: false,
    autoSyncEnabled: false,
    autoPullEnabled: false,
    autoSyncIntervalMinutes: DEFAULT_INTERVAL_MINUTES
  }
}

function statusView(
  state: S3ConfigState,
  localProviderCount: number,
  currentRelation: ProviderProfileSyncRelation,
  remote?: ProviderS3RemoteSnapshot
): ProviderProfileS3Status {
  return {
    relation: currentRelation,
    localProviderCount,
    remoteProviderCount: remote?.envelope.providerCount,
    remoteCreatedAt: remote?.envelope.createdAt,
    endpointLabel: providerS3EndpointLabel(state)
  }
}

function applyRemoteAutomatically(remote: ProviderS3RemoteSnapshot): boolean {
  reconcileProviderProfileOperations()
  const preview = previewProviderProfileDocument(
    `${JSON.stringify(remote.envelope.profile, null, 2)}\n`,
    'S3 Provider Profile automatic pull'
  )
  if (preview.items.length === 0 || preview.items.some((item) => item.defaultAction === 'skip')) return false
  applyProviderProfilePreview(preview.previewId, preview.items.map((item) => ({
    itemId: item.id,
    action: item.defaultAction
  })))
  return currentProviderProfileSyncSnapshot().profileDigest === remote.envelope.profileDigest
}

function relation(state: S3ConfigState, localDigest: string, remoteDigest?: string): ProviderProfileSyncRelation {
  if (!remoteDigest) return 'remote_missing'
  if (localDigest === remoteDigest) return 'in_sync'
  if (state.lastAppliedProfileDigest === remoteDigest) return 'local_ahead'
  if (state.lastAppliedProfileDigest === localDigest) return 'remote_ahead'
  return 'diverged'
}

function syncedState(state: S3ConfigState, envelope: ProviderS3RemoteSnapshot['envelope']): S3ConfigState {
  return {
    ...state,
    lastAppliedRevisionId: envelope.revisionId,
    lastAppliedProfileDigest: envelope.profileDigest,
    lastSyncAt: new Date().toISOString(),
    lastError: undefined
  }
}

function requireState(): S3ConfigState {
  const state = readState()
  if (!state) throw new Error('Configure S3 Provider sync first')
  return state
}

function requirePending(previewId: string, state: S3ConfigState): PendingS3Preview {
  prunePending()
  const pending = pendingPreviews.get(String(previewId).trim())
  if (!pending || pending.configRevision !== state.configRevision) throw new Error('S3 sync preview expired')
  return pending
}

function assertRemoteUnchanged(pending: PendingS3Preview, remote: ProviderS3RemoteSnapshot | undefined): void {
  if (remote?.fileDigest !== pending.remoteFileDigest || remote?.etag !== pending.remoteEtag
    || remote?.envelope.revisionId !== pending.remoteRevisionId) {
    throw new Error('S3 remote configuration changed after preview')
  }
}

function historyEntry(remote: ProviderS3RemoteSnapshot): ProviderProfileSyncHistoryEntry {
  return {
    revisionId: remote.envelope.revisionId,
    parentRevisionId: remote.envelope.parentRevisionId,
    createdAt: remote.envelope.createdAt,
    providerCount: remote.envelope.providerCount,
    deviceId: remote.envelope.deviceId
  }
}

function requireHistoryPending(previewId: string, state: S3ConfigState): PendingHistoryPreview {
  pruneHistoryPending()
  const pending = pendingHistoryPreviews.get(String(previewId).trim())
  if (!pending || pending.configRevision !== state.configRevision) throw new Error('S3 history preview expired')
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

function resolvedInputCredentials(
  input: ProviderProfileS3ConfigInput,
  previous: S3ConfigState | undefined
): Pick<ProviderS3TransportConfig, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'> {
  return {
    accessKeyId: input.accessKeyId === undefined
      ? resolvedPreviousCredential(previous?.accessKeyId, ACCESS_KEY_REF, 'S3 Access Key ID')
      : input.accessKeyId,
    secretAccessKey: input.secretAccessKey === undefined
      ? resolvedPreviousCredential(previous?.secretAccessKey, SECRET_KEY_REF, 'S3 Secret Access Key')
      : input.secretAccessKey,
    sessionToken: input.sessionToken === undefined
      ? resolvedPreviousCredential(previous?.sessionToken, SESSION_TOKEN_REF, 'S3 session token', true)
      : input.sessionToken
  }
}

function resolvedPreviousCredential(
  record: ProviderCredentialRecord | undefined,
  ref: typeof ACCESS_KEY_REF,
  label: string,
  optional = false
): string {
  if (!record) {
    if (optional) return ''
    throw new Error(`${label} is required`)
  }
  return resolvedCredential(ref, record, label)
}

function resolvedCredential(ref: typeof ACCESS_KEY_REF, record: ProviderCredentialRecord, label: string): string {
  const resolved = resolveProviderCredential(ref, record)
  if (!resolved.available || resolved.token === undefined) throw new Error(`${label} is unavailable; save the connection again`)
  return resolved.token
}

function sessionTokenRecord(
  input: string | undefined,
  normalized: string,
  previous: S3ConfigState | undefined
): ProviderCredentialRecord | undefined {
  if (input === undefined) return previous?.sessionToken
  if (!normalized) {
    forgetProviderCredential(SESSION_TOKEN_REF)
    return undefined
  }
  return storeProviderCredential(SESSION_TOKEN_REF, normalized)
}

function sameTarget(previous: S3ConfigState | undefined, normalized: ProviderS3TransportConfig): boolean {
  return Boolean(previous)
    && previous?.endpoint === normalized.endpoint
    && previous.region === normalized.region
    && previous.bucket === normalized.bucket
    && previous.prefix === normalized.prefix
    && previous.forcePathStyle === normalized.forcePathStyle
}

function normalizedInterval(value: number): number {
  if (!validInterval(value)) throw new Error('S3 auto-sync interval must be between 5 and 1440 minutes')
  return value
}

function validInterval(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 5 && Number(value) <= 1_440
}

function validCredentialRecord(value: unknown): value is ProviderCredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof (value as Partial<ProviderCredentialRecord>).encryptedToken === 'string'
}

function validOptionalCredentialRecord(value: unknown): boolean {
  return value === undefined || validCredentialRecord(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value)
}

function configFilePath(): string {
  return join(app.getPath('userData'), 'provider-profile-s3', 'config.json')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'S3 synchronization failed'
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
