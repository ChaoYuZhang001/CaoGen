import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import type { ProviderGatewayUsageRecord } from '../../shared/provider-gateway-types'
import {
  PROVIDER_GATEWAY_DEFAULT_PORT,
  PROVIDER_GATEWAY_HOST
} from '../../shared/provider-gateway-types'
import type { ProviderCredentialRecord } from '../providerCredentialBroker'
import {
  inspectProviderCredential,
  resolveProviderCredential,
  storeProviderCredential
} from '../providerCredentialRuntime'

const CONFIG_FILE = 'provider-gateway.json'
const USAGE_FILE = 'provider-gateway-usage.json'
const GATEWAY_CREDENTIAL_REF = { providerId: 'caogen-local-gateway', keyId: 'listener-token' }
const MAX_USAGE_RECORDS = 10_000

interface ProviderGatewayDocument {
  schemaVersion: 1
  enabled: boolean
  port: number
  credential: ProviderCredentialRecord
}

interface ProviderGatewayUsageDocument {
  schemaVersion: 1
  records: ProviderGatewayUsageRecord[]
}

export interface ProviderGatewayStoredConfig {
  enabled: boolean
  host: typeof PROVIDER_GATEWAY_HOST
  port: number
  credential: ProviderCredentialRecord
}

export function readProviderGatewayConfig(): ProviderGatewayStoredConfig {
  const file = storeFile(CONFIG_FILE)
  if (!existsSync(file)) return defaultConfig()
  const value = readPrivateJson(file)
  if (!isGatewayDocument(value)) throw new Error('Local gateway configuration is damaged or unsupported')
  return { enabled: value.enabled, host: PROVIDER_GATEWAY_HOST, port: value.port, credential: value.credential }
}

export function writeProviderGatewayConfig(input: {
  enabled: boolean
  port: number
  regenerateToken?: boolean
}): ProviderGatewayStoredConfig {
  const previous = readProviderGatewayConfig()
  const credential = input.regenerateToken || !credentialAvailable(previous.credential)
    ? storeProviderCredential(GATEWAY_CREDENTIAL_REF, newGatewayToken())
    : previous.credential
  const next: ProviderGatewayDocument = {
    schemaVersion: 1,
    enabled: input.enabled,
    port: validPort(input.port),
    credential
  }
  atomicPrivateJsonWrite(storeFile(CONFIG_FILE), next)
  return { enabled: next.enabled, host: PROVIDER_GATEWAY_HOST, port: next.port, credential }
}

export function resolveProviderGatewayToken(config = readProviderGatewayConfig()): string {
  const resolved = resolveProviderCredential(GATEWAY_CREDENTIAL_REF, config.credential)
  if (!resolved.available || !resolved.token) throw new Error('Local gateway token is unavailable')
  return resolved.token
}

export function inspectProviderGatewayToken(config = readProviderGatewayConfig()): {
  configured: boolean
  storage: 'encrypted' | 'session' | 'unavailable' | 'missing'
} {
  const inspected = inspectProviderCredential(GATEWAY_CREDENTIAL_REF, config.credential)
  const storage = inspected.storage === 'legacy-b64' ? 'unavailable' : inspected.storage
  return { configured: inspected.available, storage }
}

export function appendProviderGatewayUsage(record: ProviderGatewayUsageRecord): void {
  const current = readProviderGatewayUsage()
  const records = [...current.filter((item) => item.id !== record.id), record]
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(-MAX_USAGE_RECORDS)
  atomicPrivateJsonWrite(storeFile(USAGE_FILE), { schemaVersion: 1, records })
}

export function readProviderGatewayUsage(): ProviderGatewayUsageRecord[] {
  const file = storeFile(USAGE_FILE)
  if (!existsSync(file)) return []
  const value = readPrivateJson(file)
  if (!isUsageDocument(value)) throw new Error('Local gateway usage ledger is damaged or unsupported')
  return value.records
}

function defaultConfig(): ProviderGatewayStoredConfig {
  return {
    enabled: false,
    host: PROVIDER_GATEWAY_HOST,
    port: PROVIDER_GATEWAY_DEFAULT_PORT,
    credential: { encryptedToken: '' }
  }
}

function storeFile(name: string): string {
  return join(app.getPath('userData'), 'private', name)
}

function readPrivateJson(file: string): unknown {
  const target = resolve(file)
  const info = lstatSync(target)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Local gateway store must be a regular file')
  return JSON.parse(readFileSync(target, 'utf8')) as unknown
}

function atomicPrivateJsonWrite(file: string, value: unknown): void {
  const target = resolve(file)
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (existsSync(target)) {
    const info = lstatSync(target)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing to replace unsafe local gateway store')
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const descriptor = openSync(temporary, constants.O_RDWR)
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    renameSync(temporary, target)
    fsyncDirectory(parent)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, constants.O_RDONLY)
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // Windows and some filesystems reject directory fsync after the file itself is durable.
  }
}

function newGatewayToken(): string {
  return `cg_${randomBytes(32).toString('base64url')}`
}

function credentialAvailable(record: ProviderCredentialRecord): boolean {
  return inspectProviderCredential(GATEWAY_CREDENTIAL_REF, record).available
}

function validPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error('Local gateway port must be an integer between 1024 and 65535')
  }
  return value
}

function isGatewayDocument(value: unknown): value is ProviderGatewayDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const credential = row.credential as Record<string, unknown> | undefined
  return row.schemaVersion === 1
    && typeof row.enabled === 'boolean'
    && Number.isSafeInteger(row.port)
    && Number(row.port) >= 1024
    && Number(row.port) <= 65535
    && Boolean(credential)
    && typeof credential?.encryptedToken === 'string'
    && (credential.sessionOnly === undefined || typeof credential.sessionOnly === 'boolean')
}

function isUsageDocument(value: unknown): value is ProviderGatewayUsageDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.schemaVersion === 1 && Array.isArray(row.records) && row.records.every(isUsageRecord)
}

function isUsageRecord(value: unknown): value is ProviderGatewayUsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.schemaVersion === 1
    && typeof row.id === 'string'
    && (row.requestId === undefined || typeof row.requestId === 'string')
    && (row.ordinal === undefined || (Number.isSafeInteger(row.ordinal) && Number(row.ordinal) >= 0))
    && (row.failoverFromAttemptId === undefined || typeof row.failoverFromAttemptId === 'string')
    && (row.routeReason === undefined || typeof row.routeReason === 'string')
    && typeof row.providerId === 'string'
    && typeof row.model === 'string'
    && (row.protocol === 'gateway.openai.chat-completions'
      || row.protocol === 'gateway.openai.responses'
      || row.protocol === 'gateway.anthropic.messages'
      || row.protocol === 'gateway.google.generative-language')
    && (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled')
    && Number.isFinite(row.startedAt)
    && Number.isFinite(row.completedAt)
    && Number.isFinite(row.latencyMs)
}
