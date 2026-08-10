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
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  ProviderProfileImportDecision,
  ProviderProfileSyncApplyResult,
  ProviderProfileSyncPreview,
  ProviderProfileSyncPublishResult,
  ProviderProfileSyncRelation,
  ProviderProfileSyncStatus
} from '../../shared/types'
import { listProviders } from '../providers'
import { parseProviderProfile, renderProviderProfile } from './providerProfile'
import {
  applyProviderProfilePreview,
  previewProviderProfileDocument,
  reconcileProviderProfileOperations
} from './providerProfileService'

const SYNC_KIND = 'caogen-provider-profile-sync'
const SYNC_SCHEMA_VERSION = 1
const STATE_KIND = 'caogen-provider-profile-sync-state'
const STATE_SCHEMA_VERSION = 1
const CURRENT_FILE = 'caogen-provider-sync.json'
const HISTORY_DIRECTORY = '.caogen-provider-history'
export const MAX_PROVIDER_SYNC_BYTES = 4 * 1024 * 1024
const PREVIEW_TTL_MS = 15 * 60 * 1_000

export interface PortableProfileDocument {
  kind: 'caogen-provider-profile'
  schemaVersion: 1
  providers: unknown[]
}

export interface SyncEnvelopePayload {
  kind: typeof SYNC_KIND
  schemaVersion: typeof SYNC_SCHEMA_VERSION
  revisionId: string
  parentRevisionId?: string
  createdAt: string
  deviceId: string
  profileDigest: string
  providerCount: number
  profile: PortableProfileDocument
}

export interface SyncEnvelope extends SyncEnvelopePayload {
  payloadDigest: string
}

interface SyncState {
  kind: typeof STATE_KIND
  schemaVersion: typeof STATE_SCHEMA_VERSION
  deviceId: string
  directoryPath: string
  lastAppliedRevisionId?: string
  lastAppliedProfileDigest?: string
  lastSyncAt?: string
}

interface RemoteSnapshot {
  envelope: SyncEnvelope
  fileDigest: string
  raw: string
}

interface PendingSyncPreview {
  createdAt: number
  directoryPath: string
  localProfileDigest: string
  remoteFileDigest?: string
  remoteRevisionId?: string
  importPreviewId?: string
  relation: ProviderProfileSyncRelation
}

const pendingPreviews = new Map<string, PendingSyncPreview>()

export function createProviderProfileSyncEnvelope(
  deviceId: string,
  parentRevisionId?: string,
  createdAt = new Date().toISOString()
): SyncEnvelope {
  const local = currentProviderProfileSyncSnapshot()
  const payload: SyncEnvelopePayload = {
    kind: SYNC_KIND,
    schemaVersion: SYNC_SCHEMA_VERSION,
    revisionId: randomUUID(),
    parentRevisionId,
    createdAt,
    deviceId,
    profileDigest: local.profileDigest,
    providerCount: local.providerCount,
    profile: local.profile
  }
  return { ...payload, payloadDigest: digestValue(payload) }
}

export function currentProviderProfileSyncSnapshot(): {
  profile: PortableProfileDocument
  profileDigest: string
  providerCount: number
} {
  return currentProfile()
}

export function parseProviderProfileSyncEnvelope(raw: string): SyncEnvelope {
  return parseEnvelope(raw)
}

export function serializeProviderProfileSyncEnvelope(envelope: SyncEnvelope): string {
  parseEnvelope(JSON.stringify(envelope))
  return `${JSON.stringify(envelope, null, 2)}\n`
}

export function providerProfileSyncTextDigest(value: string): string {
  return digestText(value)
}

export function reconcileProviderProfileSyncAtStartup(): void {
  try {
    getProviderProfileSyncStatus()
  } catch (error) {
    console.warn('[caogen] Provider profile sync requires attention:', error instanceof Error ? error.message : String(error))
  }
}

export function getProviderProfileSyncStatus(): ProviderProfileSyncStatus {
  reconcileProviderProfileOperations()
  const state = readState()
  const local = currentProfile()
  if (!state) return unconfiguredStatus(local.providerCount)
  const remote = readRemoteSnapshot(state.directoryPath, true)
  const relation = syncRelation(state, local.profileDigest, remote?.envelope.profileDigest)
  const nextState = relation === 'in_sync' && remote
    ? reconcileEqualState(state, remote.envelope)
    : state
  return statusView(nextState, local.providerCount, relation, remote?.envelope)
}

export function configureProviderProfileSyncDirectory(directoryPath: string): ProviderProfileSyncStatus {
  const normalized = validateSyncDirectory(directoryPath)
  const previous = readState()
  const state: SyncState = {
    kind: STATE_KIND,
    schemaVersion: STATE_SCHEMA_VERSION,
    deviceId: previous?.deviceId ?? randomUUID(),
    directoryPath: normalized,
    ...(previous?.directoryPath === normalized
      ? {
          lastAppliedRevisionId: previous.lastAppliedRevisionId,
          lastAppliedProfileDigest: previous.lastAppliedProfileDigest,
          lastSyncAt: previous.lastSyncAt
        }
      : {})
  }
  writeState(state)
  return getProviderProfileSyncStatus()
}

export function disconnectProviderProfileSync(): ProviderProfileSyncStatus {
  const filePath = stateFilePath()
  if (existsSync(filePath)) {
    if (lstatSync(filePath).isSymbolicLink()) throw new Error('Provider 同步状态文件无效')
    unlinkSync(filePath)
    fsyncDirectory(dirname(filePath))
  }
  pendingPreviews.clear()
  return unconfiguredStatus(currentProfile().providerCount)
}

export function previewProviderProfileSync(): ProviderProfileSyncPreview {
  const state = requireState()
  const local = currentProfile()
  const remote = readRemoteSnapshot(state.directoryPath, true)
  const relation = syncRelation(state, local.profileDigest, remote?.envelope.profileDigest)
  const previewId = randomUUID()
  let importPreview: ProviderProfileSyncPreview['importPreview']
  if (remote && relation !== 'in_sync') {
    importPreview = previewProviderProfileDocument(
      `${JSON.stringify(remote.envelope.profile, null, 2)}\n`,
      CURRENT_FILE
    )
  }
  prunePendingPreviews()
  pendingPreviews.set(previewId, {
    createdAt: Date.now(),
    directoryPath: state.directoryPath,
    localProfileDigest: local.profileDigest,
    remoteFileDigest: remote?.fileDigest,
    remoteRevisionId: remote?.envelope.revisionId,
    importPreviewId: importPreview?.previewId,
    relation
  })
  return {
    previewId,
    status: statusView(state, local.providerCount, relation, remote?.envelope),
    importPreview,
    canPublish: relation !== 'in_sync' && local.providerCount > 0,
    canPull: Boolean(remote) && relation !== 'in_sync',
    requiresConflictChoice: relation === 'diverged'
  }
}

export function publishProviderProfileSync(
  previewId: string,
  allowDiverged: boolean
): ProviderProfileSyncPublishResult {
  const pending = requirePendingPreview(previewId)
  const state = requireState()
  if (state.directoryPath !== pending.directoryPath) throw new Error('同步目录在预览后已变化，请重新预览')
  if ((pending.relation === 'diverged' || pending.relation === 'remote_ahead') && !allowDiverged) {
    throw new Error('远端包含未合并的变化，必须明确选择保留本机后才能发布')
  }
  const local = currentProfile()
  if (local.providerCount === 0) throw new Error('没有可发布的 Provider 配置')
  if (local.profileDigest !== pending.localProfileDigest) throw new Error('本机 Provider 在预览后已变化，请重新预览')
  const remote = readRemoteSnapshot(state.directoryPath, true)
  if (remote?.fileDigest !== pending.remoteFileDigest) throw new Error('同步文件在预览后已变化，请重新预览')
  const createdAt = new Date().toISOString()
  const envelope = createProviderProfileSyncEnvelope(state.deviceId, remote?.envelope.revisionId, createdAt)
  writeRemoteEnvelope(state.directoryPath, envelope)
  const nextState: SyncState = {
    ...state,
    lastAppliedRevisionId: envelope.revisionId,
    lastAppliedProfileDigest: envelope.profileDigest,
    lastSyncAt: createdAt
  }
  writeState(nextState)
  pendingPreviews.delete(previewId)
  return {
    revisionId: envelope.revisionId,
    providerCount: envelope.providerCount,
    status: statusView(nextState, local.providerCount, 'in_sync', envelope)
  }
}

export function applyProviderProfileSync(
  previewId: string,
  decisions: ProviderProfileImportDecision[]
): ProviderProfileSyncApplyResult {
  const pending = requirePendingPreview(previewId)
  const state = requireState()
  if (state.directoryPath !== pending.directoryPath) throw new Error('同步目录在预览后已变化，请重新预览')
  const remote = readRemoteSnapshot(state.directoryPath, false)
  if (!remote || remote.fileDigest !== pending.remoteFileDigest || remote.envelope.revisionId !== pending.remoteRevisionId) {
    throw new Error('同步文件在预览后已变化，请重新预览')
  }
  if (!pending.importPreviewId) throw new Error('没有可应用的远端 Provider 变化')
  const result = applyProviderProfilePreview(pending.importPreviewId, decisions)
  const local = currentProfile()
  const fullyAligned = local.profileDigest === remote.envelope.profileDigest
  const nextState = fullyAligned
    ? {
        ...state,
        lastAppliedRevisionId: remote.envelope.revisionId,
        lastAppliedProfileDigest: remote.envelope.profileDigest,
        lastSyncAt: new Date().toISOString()
      }
    : state
  if (fullyAligned) writeState(nextState)
  pendingPreviews.delete(previewId)
  return {
    ...result,
    status: statusView(
      nextState,
      local.providerCount,
      fullyAligned ? 'in_sync' : syncRelation(nextState, local.profileDigest, remote.envelope.profileDigest),
      remote.envelope
    )
  }
}

function currentProfile(): { profile: PortableProfileDocument; profileDigest: string; providerCount: number } {
  const providers = [...listProviders()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.baseUrl.localeCompare(right.baseUrl))
  const rendered = JSON.parse(renderProviderProfile(providers, '1970-01-01T00:00:00.000Z')) as {
    kind: PortableProfileDocument['kind']
    schemaVersion: PortableProfileDocument['schemaVersion']
    providers: unknown[]
  }
  const profile: PortableProfileDocument = {
    kind: rendered.kind,
    schemaVersion: rendered.schemaVersion,
    providers: rendered.providers
  }
  return { profile, profileDigest: digestValue(profile), providerCount: providers.length }
}

function syncRelation(
  state: SyncState,
  localDigest: string,
  remoteDigest: string | undefined
): ProviderProfileSyncRelation {
  if (!remoteDigest) return 'remote_missing'
  if (localDigest === remoteDigest) return 'in_sync'
  if (state.lastAppliedProfileDigest === remoteDigest) return 'local_ahead'
  if (state.lastAppliedProfileDigest === localDigest) return 'remote_ahead'
  return 'diverged'
}

function reconcileEqualState(state: SyncState, remote: SyncEnvelope): SyncState {
  if (state.lastAppliedRevisionId === remote.revisionId && state.lastAppliedProfileDigest === remote.profileDigest) {
    return state
  }
  const reconciled = {
    ...state,
    lastAppliedRevisionId: remote.revisionId,
    lastAppliedProfileDigest: remote.profileDigest,
    lastSyncAt: remote.createdAt
  }
  writeState(reconciled)
  return reconciled
}

function statusView(
  state: SyncState,
  localProviderCount: number,
  relation: ProviderProfileSyncRelation,
  remote?: SyncEnvelope
): ProviderProfileSyncStatus {
  return {
    configured: true,
    directoryName: basename(state.directoryPath),
    relation,
    localProviderCount,
    remoteProviderCount: remote?.providerCount,
    remoteCreatedAt: remote?.createdAt,
    lastSyncAt: state.lastSyncAt
  }
}

function unconfiguredStatus(localProviderCount: number): ProviderProfileSyncStatus {
  return { configured: false, relation: 'unconfigured', localProviderCount }
}

function writeRemoteEnvelope(directoryPath: string, envelope: SyncEnvelope): void {
  validateSyncDirectory(directoryPath)
  const raw = `${JSON.stringify(envelope, null, 2)}\n`
  const historyRoot = join(directoryPath, HISTORY_DIRECTORY)
  ensureDirectory(historyRoot)
  const historyName = `${envelope.createdAt.replace(/[:.]/g, '-')}-${envelope.revisionId}.json`
  writeAtomicFile(join(historyRoot, historyName), raw, 0o600, false)
  writeAtomicFile(join(directoryPath, CURRENT_FILE), raw, 0o600, false)
}

function readRemoteSnapshot(directoryPath: string, optional: boolean): RemoteSnapshot | undefined {
  validateSyncDirectory(directoryPath)
  const filePath = join(directoryPath, CURRENT_FILE)
  if (!existsSync(filePath)) {
    if (optional) return undefined
    throw new Error('同步目录中没有 Provider 同步文件')
  }
  const raw = readRegularFile(filePath, MAX_PROVIDER_SYNC_BYTES)
  const envelope = parseEnvelope(raw)
  return { envelope, fileDigest: digestText(raw), raw }
}

function parseEnvelope(raw: string): SyncEnvelope {
  let value: unknown
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { throw new Error('Provider 同步文件不是有效 JSON') }
  if (!validEnvelope(value as Partial<SyncEnvelope>)) throw new Error('Provider 同步文件格式无效')
  const complete = value as SyncEnvelope
  validateEnvelopeIntegrity(complete)
  validateEnvelopeProfile(complete)
  return complete
}

function validEnvelope(envelope: Partial<SyncEnvelope> | null): envelope is SyncEnvelope {
  return Boolean(envelope)
    && envelope?.kind === SYNC_KIND
    && envelope.schemaVersion === SYNC_SCHEMA_VERSION
    && nonEmptyString(envelope.revisionId)
    && typeof envelope.createdAt === 'string'
    && Number.isFinite(Date.parse(envelope.createdAt))
    && nonEmptyString(envelope.deviceId)
    && sha256(envelope.profileDigest)
    && Number.isSafeInteger(envelope.providerCount)
    && Number(envelope.providerCount) >= 0
    && sha256(envelope.payloadDigest)
    && Boolean(envelope.profile && typeof envelope.profile === 'object')
}

function validateEnvelopeIntegrity(complete: SyncEnvelope): void {
  const { payloadDigest, ...payload } = complete
  if (digestValue(payload) !== payloadDigest) throw new Error('Provider 同步文件完整性校验失败')
  if (digestValue(complete.profile) !== complete.profileDigest) throw new Error('Provider 同步内容摘要不匹配')
}

function validateEnvelopeProfile(complete: SyncEnvelope): void {
  const parsed = parseProviderProfile(`${JSON.stringify(complete.profile)}\n`)
  if (parsed.credentialFieldsIgnored > 0) throw new Error('Provider 同步文件不得包含凭据字段')
  if (parsed.entries.length !== complete.providerCount) throw new Error('Provider 同步文件数量不匹配')
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value)
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function validateSyncDirectory(directoryPath: string): string {
  if (typeof directoryPath !== 'string' || !directoryPath.trim()) throw new Error('同步目录无效')
  const normalized = resolve(directoryPath)
  let info
  try { info = lstatSync(normalized) } catch { throw new Error('同步目录不存在') }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('同步位置必须是常规目录')
  return normalized
}

function requireState(): SyncState {
  const state = readState()
  if (!state) throw new Error('请先选择 Provider 同步目录')
  validateSyncDirectory(state.directoryPath)
  return state
}

function readState(): SyncState | undefined {
  const filePath = stateFilePath()
  if (!existsSync(filePath)) return undefined
  let value: unknown
  try { value = JSON.parse(readRegularFile(filePath, 64 * 1024)) } catch { throw new Error('Provider 同步状态损坏') }
  const state = value as Partial<SyncState>
  if (!state || state.kind !== STATE_KIND || state.schemaVersion !== STATE_SCHEMA_VERSION
    || typeof state.deviceId !== 'string' || !state.deviceId
    || typeof state.directoryPath !== 'string' || !state.directoryPath) {
    throw new Error('Provider 同步状态格式无效')
  }
  return state as SyncState
}

function writeState(state: SyncState): void {
  writeAtomicFile(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`, 0o600, true)
}

function stateFilePath(): string {
  return join(app.getPath('userData'), 'provider-profile-sync', 'state.json')
}

function requirePendingPreview(previewId: string): PendingSyncPreview {
  prunePendingPreviews()
  const pending = pendingPreviews.get(String(previewId).trim())
  if (!pending) throw new Error('同步预览已失效，请重新检查')
  return pending
}

function prunePendingPreviews(): void {
  const cutoff = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingPreviews) {
    if (pending.createdAt < cutoff) pendingPreviews.delete(id)
  }
  while (pendingPreviews.size >= 20) {
    const oldest = pendingPreviews.keys().next().value as string | undefined
    if (!oldest) break
    pendingPreviews.delete(oldest)
  }
}

function readRegularFile(filePath: string, maxBytes: number): string {
  let info
  try { info = lstatSync(filePath) } catch { throw new Error('Provider 同步文件不可读') }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Provider 同步文件无效或过大')
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
  const descriptor = openSync(filePath, flags)
  try {
    const current = fstatSync(descriptor)
    if (!current.isFile() || current.size > maxBytes) throw new Error('Provider 同步文件无效或过大')
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function writeAtomicFile(filePath: string, content: string, mode: number, privateDirectory: boolean): void {
  const directory = dirname(filePath)
  if (privateDirectory) ensurePrivateDirectory(directory)
  else ensureDirectory(directory)
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
    if (descriptor !== undefined) try { closeSync(descriptor) } catch { /* best effort */ }
    if (existsSync(temporary)) try { unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Provider 同步目录无效')
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Provider 同步状态目录无效')
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // The file has already been fsynced; some filesystems reject directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function digestValue(value: unknown): string {
  return digestText(JSON.stringify(value))
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
