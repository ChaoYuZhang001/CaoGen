import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
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
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml'
import type {
  CodexNativeConfigApplyResult,
  CodexNativeConfigBackupView,
  CodexNativeConfigPreview,
  CodexNativeConfigRollbackResult,
  CodexNativeConfigSummary
} from '../../shared/types'
import { looksLikeProviderCredentialValue } from '../providerCredentialBroker'
import { protectedStorage } from '../security/protected-storage-runtime'

const PREVIEW_TTL_MS = 15 * 60 * 1_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_PENDING = 8
const BACKUP_KIND = 'caogen-codex-native-config-backup'
const BACKUP_VERSION = 1
const BACKUP_ID = /^[0-9TZ-]{19,40}-[0-9a-f-]{36}$/i
const PROTECTED_PREFIX = '__CAOGEN_PROTECTED_VALUE_'
const SENSITIVE_KEY = /(?:^|_)(?:api_?key|token|secret|password|authorization|cookie|credential|bearer)(?:$|_)/i

type TomlRecord = Record<string, unknown>
type ConfigPath = Array<string | number>

interface ProtectedConfigValue {
  path: ConfigPath
  placeholder: string
  value: string
}

interface PendingConfigEdit {
  createdAt: number
  source: CodexNativeConfigPreview['source']
  sourceDigest: string
  configPresent: boolean
  originalSource: string
  protectedValues: ProtectedConfigValue[]
  preview: CodexNativeConfigPreview
}

interface CodexNativeConfigBackupDocument {
  kind: typeof BACKUP_KIND
  schemaVersion: typeof BACKUP_VERSION
  id: string
  createdAt: string
  source: CodexNativeConfigPreview['source']
  configPresent: boolean
  encryptedSource?: string
  beforeDigest: string
  afterDigest: string
  rolledBackAt?: string
  payloadDigest: string
}

const pendingEdits = new Map<string, PendingConfigEdit>()

export function previewCodexNativeConfig(): CodexNativeConfigPreview {
  prunePendingEdits()
  const snapshot = readConfigSnapshot()
  const parsed = parseConfig(snapshot.source)
  const sanitized = cloneTomlValue(parsed) as TomlRecord
  const protectedValues: ProtectedConfigValue[] = []
  protectConfigValues(sanitized, [], protectedValues)
  const formattingNormalized = protectedValues.length > 0
  const previewId = randomUUID()
  const preview: CodexNativeConfigPreview = {
    previewId,
    source: snapshot.sourceKind,
    configPresent: snapshot.configPresent,
    text: formattingNormalized ? stringifyConfig(sanitized) : snapshot.source,
    protectedValueCount: protectedValues.length,
    formattingNormalized,
    summary: summarizeConfig(parsed),
    expiresAt: Date.now() + PREVIEW_TTL_MS
  }
  pendingEdits.set(previewId, {
    createdAt: Date.now(),
    source: snapshot.sourceKind,
    sourceDigest: snapshot.digest,
    configPresent: snapshot.configPresent,
    originalSource: snapshot.source,
    protectedValues,
    preview
  })
  return preview
}

export function applyCodexNativeConfig(
  previewId: string,
  editedText: string
): CodexNativeConfigApplyResult {
  prunePendingEdits()
  const pending = pendingEdits.get(previewId.trim())
  if (!pending) throw new Error('Codex configuration preview expired; reopen the configuration workspace')
  assertBoundedText(editedText)
  const current = readConfigSnapshot()
  if (current.digest !== pending.sourceDigest || current.configPresent !== pending.configPresent) {
    pendingEdits.delete(previewId)
    throw new Error('Codex config.toml changed after it was opened; reopen it before saving')
  }
  const parsed = parseConfig(editedText)
  const restored = restoreProtectedValues(parsed, pending.protectedValues)
  const nextSource = pending.protectedValues.length > 0 ? stringifyConfig(restored) : editedText
  parseConfig(nextSource)
  const afterDigest = configDigest(true, nextSource)
  if (afterDigest === pending.sourceDigest && pending.configPresent) {
    throw new Error('Codex config.toml has no changes to save')
  }
  const backup = createBackup(pending, afterDigest)
  try {
    writeConfigAtomic(nextSource)
  } catch (error) {
    removeBackupBestEffort(backup.id)
    throw error
  }
  pendingEdits.delete(previewId)
  const preview = previewCodexNativeConfig()
  return {
    operationId: randomUUID(),
    appliedAt: new Date().toISOString(),
    backup,
    preview
  }
}

export function listCodexNativeConfigBackups(): CodexNativeConfigBackupView[] {
  const root = backupRoot()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const backup = readBackup(join(root, name))
        return backup.rolledBackAt ? [] : [backupView(backup)]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function rollbackCodexNativeConfigBackup(backupId: string): CodexNativeConfigRollbackResult {
  const id = backupId.trim()
  if (!BACKUP_ID.test(id)) throw new Error('Codex configuration backup id is invalid')
  const backupPath = join(backupRoot(), `${id}.json`)
  const backup = readBackup(backupPath)
  if (backup.rolledBackAt) throw new Error('Codex configuration backup was already rolled back')
  const current = readConfigSnapshot()
  if (current.digest !== backup.afterDigest) {
    throw new Error('Codex config.toml changed after this backup was created; rollback was refused')
  }
  if (backup.configPresent) {
    const source = decryptBackupSource(backup.encryptedSource)
    parseConfig(source)
    if (configDigest(true, source) !== backup.beforeDigest) {
      throw new Error('Codex configuration backup integrity check failed')
    }
    writeConfigAtomic(source)
  } else {
    removeConfigFile()
  }
  const rolledBack = withDigest({ ...withoutDigest(backup), rolledBackAt: new Date().toISOString() })
  writeAtomicJson(backupPath, rolledBack, false)
  pendingEdits.clear()
  return { operationId: randomUUID(), restoredBackupId: id, configPresent: backup.configPresent }
}

function readConfigSnapshot(): {
  sourceKind: CodexNativeConfigPreview['source']
  configPresent: boolean
  source: string
  digest: string
} {
  const sourceKind = process.env.CODEX_HOME?.trim() ? 'CODEX_HOME' : 'user-profile'
  const configPath = codexConfigPath()
  const configPresent = existsSync(configPath)
  const source = configPresent ? readRegularFile(configPath) : ''
  return { sourceKind, configPresent, source, digest: configDigest(configPresent, source) }
}

function parseConfig(source: string): TomlRecord {
  if (!source.trim()) return {}
  try {
    const parsed = parseToml(source)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as TomlRecord
      : {}
  } catch (error) {
    const location = tomlErrorLocation(error)
    throw new Error(`Codex config.toml has invalid TOML syntax${location}`)
  }
}

function tomlErrorLocation(error: unknown): string {
  const value = error as { line?: unknown; col?: unknown }
  const line = typeof value?.line === 'number' && Number.isFinite(value.line) ? value.line + 1 : undefined
  const column = typeof value?.col === 'number' && Number.isFinite(value.col) ? value.col + 1 : undefined
  return line ? ` near line ${line}${column ? `, column ${column}` : ''}` : ''
}

function stringifyConfig(value: TomlRecord): string {
  try {
    const text = stringifyToml(value as never)
    return text.endsWith('\n') ? text : `${text}\n`
  } catch {
    throw new Error('Codex config.toml could not be serialized safely')
  }
}

function protectConfigValues(
  value: unknown,
  path: ConfigPath,
  protectedValues: ProtectedConfigValue[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => protectConfigValues(item, [...path, index], protectedValues))
    return
  }
  if (!isTomlRecord(value) || value instanceof Date) return
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key]
    if (typeof item === 'string' && isSensitiveConfigValue(key, item)) {
      const placeholder = `${PROTECTED_PREFIX}${String(protectedValues.length + 1).padStart(4, '0')}__`
      protectedValues.push({ path: nextPath, placeholder, value: item })
      value[key] = placeholder
      continue
    }
    protectConfigValues(item, nextPath, protectedValues)
  }
}

function restoreProtectedValues(parsed: TomlRecord, expected: ProtectedConfigValue[]): TomlRecord {
  const expectedByPath = new Map(expected.map((item) => [pathKey(item.path), item]))
  const submittedProtected: ProtectedConfigValue[] = []
  const clone = cloneTomlValue(parsed) as TomlRecord
  protectConfigValues(clone, [], submittedProtected)
  for (const candidate of submittedProtected) {
    const expectedValue = expectedByPath.get(pathKey(candidate.path))
    if (!expectedValue) {
      throw new Error('Credential-like Codex settings must be managed through CaoGen authorization')
    }
  }
  const seenPlaceholders = collectPlaceholders(parsed)
  if (seenPlaceholders.some((item) => !expectedByPath.has(pathKey(item.path)))) {
    throw new Error('Protected Codex configuration placeholders cannot be moved')
  }
  for (const item of expected) {
    if (valueAtPath(parsed, item.path) !== item.placeholder) {
      throw new Error('Protected Codex configuration values cannot be changed in the raw editor')
    }
    setValueAtPath(parsed, item.path, item.value)
  }
  return parsed
}

function collectPlaceholders(value: unknown, path: ConfigPath = [], result: Array<{ path: ConfigPath; value: string }> = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPlaceholders(item, [...path, index], result))
  } else if (isTomlRecord(value) && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value)) collectPlaceholders(item, [...path, key], result)
  } else if (typeof value === 'string' && value.startsWith(PROTECTED_PREFIX)) {
    result.push({ path, value })
  }
  return result
}

function summarizeConfig(config: TomlRecord): CodexNativeConfigSummary {
  return {
    modelProviders: objectSize(config.model_providers),
    mcpServers: objectSize(config.mcp_servers),
    projects: objectSize(config.projects),
    features: objectSize(config.features),
    plugins: collectionSize(config.plugins)
  }
}

function objectSize(value: unknown): number {
  return isTomlRecord(value) && !(value instanceof Date) ? Object.keys(value).length : 0
}

function collectionSize(value: unknown): number {
  return Array.isArray(value) ? value.length : objectSize(value)
}

function createBackup(pending: PendingConfigEdit, afterDigest: string): CodexNativeConfigBackupView {
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`
  const encryptedSource = pending.configPresent ? encryptBackupSource(pending.originalSource) : undefined
  const document = withDigest({
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_VERSION,
    id,
    createdAt,
    source: pending.source,
    configPresent: pending.configPresent,
    encryptedSource,
    beforeDigest: pending.sourceDigest,
    afterDigest
  })
  writeAtomicJson(join(backupRoot(), `${id}.json`), document, true)
  return backupView(document)
}

function encryptBackupSource(source: string): string {
  if (!protectedStorage.isEncryptionAvailable()) {
    throw new Error('System credential encryption is unavailable; Codex configuration was not changed')
  }
  return `enc:${protectedStorage.encryptString(source).toString('base64')}`
}

function decryptBackupSource(value: string | undefined): string {
  if (!value?.startsWith('enc:') || !protectedStorage.isEncryptionAvailable()) {
    throw new Error('Codex configuration backup cannot be decrypted')
  }
  try {
    return protectedStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
  } catch {
    throw new Error('Codex configuration backup cannot be decrypted')
  }
}

function readBackup(filePath: string): CodexNativeConfigBackupDocument {
  let value: Partial<CodexNativeConfigBackupDocument>
  try {
    value = JSON.parse(readRegularFile(filePath)) as Partial<CodexNativeConfigBackupDocument>
  } catch {
    throw new Error('Codex configuration backup is invalid')
  }
  if (value.kind !== BACKUP_KIND || value.schemaVersion !== BACKUP_VERSION
    || typeof value.id !== 'string' || !BACKUP_ID.test(value.id)
    || basename(filePath, '.json') !== value.id || typeof value.createdAt !== 'string'
    || (value.source !== 'CODEX_HOME' && value.source !== 'user-profile')
    || typeof value.configPresent !== 'boolean' || typeof value.beforeDigest !== 'string'
    || typeof value.afterDigest !== 'string' || typeof value.payloadDigest !== 'string'
    || (value.configPresent && typeof value.encryptedSource !== 'string')) {
    throw new Error('Codex configuration backup is invalid')
  }
  const document = value as CodexNativeConfigBackupDocument
  const { payloadDigest, ...payload } = document
  if (digest(payload) !== payloadDigest) throw new Error('Codex configuration backup integrity check failed')
  return document
}

function backupView(document: CodexNativeConfigBackupDocument): CodexNativeConfigBackupView {
  return {
    id: document.id,
    createdAt: document.createdAt,
    source: document.source,
    configPresent: document.configPresent
  }
}

function writeConfigAtomic(source: string): void {
  writeAtomicText(codexConfigPath(), source, false)
}

function removeConfigFile(): void {
  const path = codexConfigPath()
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Codex config.toml is not a regular file')
  unlinkSync(path)
}

function writeAtomicJson(filePath: string, value: CodexNativeConfigBackupDocument, exclusive: boolean): void {
  writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`, exclusive)
}

function writeAtomicText(filePath: string, source: string, exclusive: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    const descriptor = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(descriptor, source, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    if (exclusive && existsSync(filePath)) throw new Error('Codex configuration backup already exists')
    renameSync(temp, filePath)
    if (process.platform !== 'win32') chmodSync(filePath, 0o600)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
}

function readRegularFile(filePath: string): string {
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
    throw new Error('Codex configuration file is invalid')
  }
  return readFileSync(filePath, 'utf8')
}

function codexConfigPath(): string {
  const root = resolve(process.env.CODEX_HOME?.trim() || join(app.getPath('home'), '.codex'))
  return join(root, 'config.toml')
}

function backupRoot(): string {
  return join(app.getPath('userData'), 'codex-native-config-backups')
}

function configDigest(present: boolean, source: string): string {
  return digest({ present, source })
}

function assertBoundedText(value: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Codex config.toml cannot exceed 2 MB')
  }
}

function isSensitiveConfigValue(key: string, value: string): boolean {
  return SENSITIVE_KEY.test(key) || looksLikeProviderCredentialValue(value)
}

function cloneTomlValue<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (Array.isArray(value)) return value.map((item) => cloneTomlValue(item)) as T
  if (isTomlRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTomlValue(item)])) as T
  }
  return value
}

function isTomlRecord(value: unknown): value is TomlRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function valueAtPath(root: unknown, path: ConfigPath): unknown {
  let current = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (!isTomlRecord(current)) return undefined
      current = current[segment]
    }
  }
  return current
}

function setValueAtPath(root: unknown, path: ConfigPath, value: string): void {
  if (path.length === 0) throw new Error('Protected Codex configuration path is invalid')
  const parent = valueAtPath(root, path.slice(0, -1))
  const leaf = path[path.length - 1]
  if (typeof leaf === 'number' && Array.isArray(parent)) parent[leaf] = value
  else if (typeof leaf === 'string' && isTomlRecord(parent)) parent[leaf] = value
  else throw new Error('Protected Codex configuration path is invalid')
}

function pathKey(path: ConfigPath): string {
  return JSON.stringify(path)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function withDigest<T extends Omit<CodexNativeConfigBackupDocument, 'payloadDigest'>>(
  value: T
): CodexNativeConfigBackupDocument {
  return { ...value, payloadDigest: digest(value) }
}

function withoutDigest(
  value: CodexNativeConfigBackupDocument
): Omit<CodexNativeConfigBackupDocument, 'payloadDigest'> {
  const { payloadDigest: _payloadDigest, ...payload } = value
  return payload
}

function prunePendingEdits(): void {
  const expired = Date.now() - PREVIEW_TTL_MS
  for (const [id, pending] of pendingEdits) if (pending.createdAt < expired) pendingEdits.delete(id)
  while (pendingEdits.size >= MAX_PENDING) {
    const first = pendingEdits.keys().next().value as string | undefined
    if (!first) break
    pendingEdits.delete(first)
  }
}

function removeBackupBestEffort(id: string): void {
  try { unlinkSync(join(backupRoot(), `${id}.json`)) } catch { /* best effort */ }
}
