import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type FailureKind =
  | 'quota'
  | 'rate_limit'
  | 'model_unavailable'
  | 'auth'
  | 'forbidden'
  | 'server'
  | 'network'
  | 'engine'
  | 'execution'
  | 'unknown'

export interface FailureClass {
  kind: FailureKind
  switchable: boolean
  label: string
}

export interface ProviderFailureRecord {
  at: number
  kind: FailureKind
  label: string
  message: string
  switchable: boolean
}

export interface ProviderHealth {
  providerId: string
  successes: number
  failures: number
  consecutiveFailures: number
  lastLatencyMs?: number
  latencyEmaMs?: number
  lastError?: string
  lastSuccessAt?: number
  lastFailureAt?: number
  lastUsedAt?: number
  recentFailures: ProviderFailureRecord[]
  healthy: boolean
}

interface ProviderHealthFile {
  version: 1
  providers: Record<string, ProviderHealth>
}

const MAX_FAILURE_HISTORY = 12
const EMA_ALPHA = 0.3
let baseDir = ''
let cache: ProviderHealthFile | null = null

export function configureProviderHealthDir(dir: string): void {
  baseDir = dir
  cache = null
}

export function recordSuccess(providerId: string, latencyMs?: number): void {
  const health = ensure(providerId)
  const now = Date.now()
  health.successes += 1
  health.consecutiveFailures = 0
  health.healthy = true
  health.lastSuccessAt = now
  health.lastUsedAt = now
  delete health.lastError
  if (latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs > 0) {
    health.lastLatencyMs = Math.round(latencyMs)
    health.latencyEmaMs =
      health.latencyEmaMs === undefined
        ? health.lastLatencyMs
        : Math.round(health.latencyEmaMs * (1 - EMA_ALPHA) + health.lastLatencyMs * EMA_ALPHA)
  }
  persist()
}

export function recordFailure(providerId: string, error?: string): void {
  const health = ensure(providerId)
  const now = Date.now()
  const message = sanitizeFailureMessage(error)
  const failure = classifyFailure(message)
  health.failures += 1
  health.consecutiveFailures += 1
  health.healthy = health.consecutiveFailures < 3
  health.lastError = message
  health.lastFailureAt = now
  health.lastUsedAt = now
  health.recentFailures = [
    { at: now, kind: failure.kind, label: failure.label, message, switchable: failure.switchable },
    ...health.recentFailures
  ].slice(0, MAX_FAILURE_HISTORY)
  persist()
}

export function getHealth(providerId: string): ProviderHealth {
  return cloneHealth(ensure(providerId))
}

export function listHealth(): ProviderHealth[] {
  return Object.values(load().providers)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .map(cloneHealth)
}

export function classifyFailure(text: string | undefined): FailureClass {
  const value = (text || '').slice(0, 2000)
  if (/credit|balance|quota|insufficient|billing|余额|配额/i.test(value))
    return { kind: 'quota', switchable: true, label: '余额/配额不足' }
  if (/rate.?limit|too.?many.?requests|\b429\b|overloaded|限流|过载/i.test(value))
    return { kind: 'rate_limit', switchable: true, label: '限流/过载' }
  if (
    /model.{0,24}(not.?found|not.?exist|not.?support|unavailable|invalid)|(unknown|invalid|no such).{0,8}model|模型不存在|无此模型/i.test(
      value
    )
  )
    return { kind: 'model_unavailable', switchable: true, label: '模型不可用' }
  if (/unauthorized|authentication|invalid.{0,12}(api.?key|token)|\b401\b|鉴权/i.test(value))
    return { kind: 'auth', switchable: true, label: '鉴权失败' }
  if (/forbidden|permission.?denied|\b403\b/i.test(value))
    return { kind: 'forbidden', switchable: true, label: '访问被拒' }
  if (/\b(500|502|503|504|529)\b|internal.?server|bad.?gateway|service.?unavailable/i.test(value))
    return { kind: 'server', switchable: true, label: '服务端错误' }
  if (/econnrefused|enotfound|etimedout|econnreset|network|fetch.?failed|socket|dns/i.test(value))
    return { kind: 'network', switchable: true, label: '网络异常' }
  if (/exited with code|process exited|closed unexpectedly|spawn/i.test(value))
    return { kind: 'engine', switchable: true, label: '引擎异常退出' }
  return value && value !== '未知错误'
    ? { kind: 'execution', switchable: false, label: '执行错误' }
    : { kind: 'unknown', switchable: false, label: '未知错误' }
}

export function _resetProviderHealthCacheForTest(): void {
  cache = null
}

function key(providerId: string): string {
  return providerId || 'local-login'
}

function healthFile(): string {
  return join(baseDir, 'provider-health.json')
}

function load(): ProviderHealthFile {
  if (cache) return cache
  if (!baseDir) {
    cache = { version: 1, providers: {} }
    return cache
  }
  try {
    const parsed = JSON.parse(readFileSync(healthFile(), 'utf8')) as Partial<ProviderHealthFile>
    if (parsed.version === 1 && parsed.providers && typeof parsed.providers === 'object') {
      const providers: Record<string, ProviderHealth> = {}
      for (const [providerId, value] of Object.entries(parsed.providers)) {
        providers[providerId] = normalizeHealth(providerId, value)
      }
      cache = { version: 1, providers }
      return cache
    }
  } catch {
    // Missing or damaged state starts from an empty health store.
  }
  cache = { version: 1, providers: {} }
  return cache
}

function ensure(providerId: string): ProviderHealth {
  const id = key(providerId)
  const store = load()
  let health = store.providers[id]
  if (!health) {
    health = {
      providerId: id,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      recentFailures: [],
      healthy: true
    }
    store.providers[id] = health
  }
  return health
}

function persist(): void {
  if (!baseDir || !cache) return
  try {
    const file = healthFile()
    const tempFile = `${file}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tempFile, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
    renameSync(tempFile, file)
  } catch {
    // Health persistence must never block the active model request.
  }
}

function normalizeHealth(providerId: string, value: unknown): ProviderHealth {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const consecutiveFailures = nonNegativeInt(raw.consecutiveFailures)
  const storedLastError = optionalString(raw.lastError)
  const recentFailures = Array.isArray(raw.recentFailures)
    ? raw.recentFailures.map(normalizeFailureRecord).filter((item): item is ProviderFailureRecord => Boolean(item)).slice(0, MAX_FAILURE_HISTORY)
    : []
  return {
    providerId,
    successes: nonNegativeInt(raw.successes),
    failures: nonNegativeInt(raw.failures),
    consecutiveFailures,
    lastLatencyMs: positiveNumber(raw.lastLatencyMs),
    latencyEmaMs: positiveNumber(raw.latencyEmaMs),
    lastError: storedLastError ? sanitizeFailureMessage(storedLastError) : undefined,
    lastSuccessAt: positiveNumber(raw.lastSuccessAt),
    lastFailureAt: positiveNumber(raw.lastFailureAt),
    lastUsedAt: positiveNumber(raw.lastUsedAt),
    recentFailures,
    healthy: consecutiveFailures < 3
  }
}

function normalizeFailureRecord(value: unknown): ProviderFailureRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const at = positiveNumber(raw.at)
  const label = optionalString(raw.label)
  const message = optionalString(raw.message)
  if (!at || !label || !message) return null
  const failure = classifyFailure(message)
  const kind = isFailureKind(raw.kind) ? raw.kind : failure.kind
  return { at, kind, label, message: sanitizeFailureMessage(message), switchable: raw.switchable === true }
}

function cloneHealth(health: ProviderHealth): ProviderHealth {
  return { ...health, recentFailures: health.recentFailures.map((failure) => ({ ...failure })) }
}

function sanitizeFailureMessage(error: string | undefined): string {
  const compact = (error ?? '未知错误').replace(/\s+/g, ' ').trim().slice(0, 500)
  return compact
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isFailureKind(value: unknown): value is FailureKind {
  return [
    'quota',
    'rate_limit',
    'model_unavailable',
    'auth',
    'forbidden',
    'server',
    'network',
    'engine',
    'execution',
    'unknown'
  ].includes(typeof value === 'string' ? value : '')
}
