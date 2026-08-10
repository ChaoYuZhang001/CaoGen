import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ProviderAdvancedConfig,
  ProviderCircuitBreakerSettings,
  ProviderCircuitState
} from '../shared/types'
import { redactProviderErrorText } from './provider/openai-provider-utils'

export type FailureKind =
  | 'quota'
  | 'rate_limit'
  | 'model_unavailable'
  | 'protocol_unavailable'
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
  probeSuccesses: number
  probeFailures: number
  lastProbeLatencyMs?: number
  lastProbeError?: string
  lastProbeSuccessAt?: number
  lastProbeFailureAt?: number
  lastLatencyMs?: number
  latencyEmaMs?: number
  lastError?: string
  lastSuccessAt?: number
  lastFailureAt?: number
  lastUsedAt?: number
  circuitState: ProviderCircuitState
  circuitOpenedAt?: number
  halfOpenSuccesses: number
  circuitTotalRequests: number
  circuitFailedRequests: number
  recentFailures: ProviderFailureRecord[]
  healthy: boolean
}

interface ProviderHealthFile {
  version: 1
  providers: Record<string, ProviderHealth>
}

const MAX_FAILURE_HISTORY = 12
const EMA_ALPHA = 0.3
export const DEFAULT_PROVIDER_CIRCUIT_BREAKER: ProviderCircuitBreakerSettings = {
  failureThreshold: 4,
  successThreshold: 2,
  timeoutSeconds: 60,
  errorRateThreshold: 0.6,
  minRequests: 10
}
let baseDir = ''
let cache: ProviderHealthFile | null = null
let circuitConfig = { ...DEFAULT_PROVIDER_CIRCUIT_BREAKER }
const providerCircuitConfigs = new Map<string, ProviderCircuitBreakerSettings>()
const halfOpenInFlight = new Set<string>()

export function configureProviderHealthDir(
  dir: string,
  config: ProviderCircuitBreakerSettings = DEFAULT_PROVIDER_CIRCUIT_BREAKER
): void {
  baseDir = dir
  cache = null
  halfOpenInFlight.clear()
  providerCircuitConfigs.clear()
  configureProviderCircuitBreaker(config)
}

export function configureProviderCircuitBreaker(config: ProviderCircuitBreakerSettings): void {
  circuitConfig = normalizeCircuitConfig(config)
}

export function synchronizeProviderReliabilityPolicies(
  providers: Array<{ id: string; advancedConfig?: ProviderAdvancedConfig }>
): void {
  providerCircuitConfigs.clear()
  for (const provider of providers) {
    const config = provider.advancedConfig?.reliability?.circuitBreaker
    if (config) providerCircuitConfigs.set(key(provider.id), normalizeCircuitConfig(config))
  }
}

export function configureProviderReliabilityPolicy(
  provider: { id: string; advancedConfig?: ProviderAdvancedConfig }
): void {
  const config = provider.advancedConfig?.reliability?.circuitBreaker
  if (config) providerCircuitConfigs.set(key(provider.id), normalizeCircuitConfig(config))
  else providerCircuitConfigs.delete(key(provider.id))
}

export function recordSuccess(providerId: string, latencyMs?: number): void {
  const health = ensure(providerId)
  const config = circuitConfigFor(health.providerId)
  const now = Date.now()
  refreshCircuitState(health, now)
  halfOpenInFlight.delete(health.providerId)
  health.successes += 1
  health.consecutiveFailures = 0
  health.lastSuccessAt = now
  health.lastUsedAt = now
  delete health.lastError
  health.circuitTotalRequests += 1
  if (health.circuitState === 'open') transitionToHalfOpen(health)
  if (health.circuitState === 'half_open') {
    health.halfOpenSuccesses += 1
    if (health.halfOpenSuccesses >= config.successThreshold) transitionToClosed(health)
  }
  health.healthy = health.circuitState !== 'open'
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
  const config = circuitConfigFor(health.providerId)
  const now = Date.now()
  const message = sanitizeFailureMessage(error)
  const failure = classifyFailure(message)
  refreshCircuitState(health, now)
  halfOpenInFlight.delete(health.providerId)
  health.failures += 1
  health.lastError = message
  health.lastFailureAt = now
  health.lastUsedAt = now
  health.circuitTotalRequests += 1
  if (failure.switchable) {
    health.circuitFailedRequests += 1
    if (health.circuitState === 'half_open') {
      transitionToOpen(health, now)
    } else if (health.circuitState === 'closed') {
      health.consecutiveFailures += 1
      const errorRate = health.circuitFailedRequests / Math.max(1, health.circuitTotalRequests)
      if (health.consecutiveFailures >= config.failureThreshold || (
        health.circuitTotalRequests >= config.minRequests && errorRate >= config.errorRateThreshold
      )) transitionToOpen(health, now)
    }
  }
  health.healthy = health.circuitState !== 'open'
  health.recentFailures = [
    { at: now, kind: failure.kind, label: failure.label, message, switchable: failure.switchable },
    ...health.recentFailures
  ].slice(0, MAX_FAILURE_HISTORY)
  persist()
}

export function recordProbeSuccess(providerId: string, latencyMs?: number): void {
  const health = ensure(providerId)
  health.probeSuccesses += 1
  health.lastProbeSuccessAt = Date.now()
  delete health.lastProbeError
  if (latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs > 0) {
    health.lastProbeLatencyMs = Math.round(latencyMs)
  }
  persist()
}

export function recordProbeFailure(providerId: string, error?: string): void {
  const health = ensure(providerId)
  health.probeFailures += 1
  health.lastProbeFailureAt = Date.now()
  health.lastProbeError = sanitizeFailureMessage(error)
  persist()
}

export function getHealth(providerId: string): ProviderHealth {
  const health = ensure(providerId)
  if (refreshCircuitState(health, Date.now())) persist()
  return cloneHealth(health)
}

export function listHealth(): ProviderHealth[] {
  const providers = Object.values(load().providers)
  const now = Date.now()
  let changed = false
  for (const health of providers) {
    if (refreshCircuitState(health, now)) changed = true
  }
  if (changed) persist()
  return providers
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .map(cloneHealth)
}

export function isProviderAvailable(providerId: string, now = Date.now()): boolean {
  const health = ensure(providerId)
  if (refreshCircuitState(health, now)) persist()
  return health.circuitState !== 'open'
}

export function acquireProviderRequest(providerId: string, now = Date.now()): boolean {
  const health = ensure(providerId)
  if (refreshCircuitState(health, now)) persist()
  if (health.circuitState === 'open') return false
  if (health.circuitState !== 'half_open') return true
  if (halfOpenInFlight.has(health.providerId)) return false
  halfOpenInFlight.add(health.providerId)
  return true
}

export function releaseProviderRequest(providerId: string): void {
  halfOpenInFlight.delete(key(providerId))
}

export function classifyFailure(text: string | undefined): FailureClass {
  const value = (text || '').slice(0, 2000)
  if (/circuit.{0,16}open|provider.{0,16}circuit|熔断/i.test(value))
    return { kind: 'server', switchable: true, label: 'Provider 熔断' }
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
  if (
    /(?:responses?\s*(?:api|endpoint|protocol).{0,32}(?:not.?support|not.?found|unavailable|unknown)|(?:unsupported|unknown).{0,24}responses?)/i.test(value) ||
    (/\b(?:404|405|501)\b/.test(value) && /protocol\s*:\s*responses/i.test(value))
  )
    return { kind: 'protocol_unavailable', switchable: true, label: 'Responses 协议不可用' }
  if (/unauthorized|authentication|invalid.{0,12}(api.?key|token)|\b401\b|鉴权/i.test(value))
    return { kind: 'auth', switchable: true, label: '鉴权失败' }
  if (/forbidden|permission.?denied|\b403\b/i.test(value))
    return { kind: 'forbidden', switchable: true, label: '访问被拒' }
  if (/\b(500|502|503|504|529)\b|internal.?server|bad.?gateway|service.?unavailable/i.test(value))
    return { kind: 'server', switchable: true, label: '服务端错误' }
  if (/econnrefused|enotfound|etimedout|econnreset|network|fetch.?failed|socket|dns|timed?.?out|timeout/i.test(value))
    return { kind: 'network', switchable: true, label: '网络异常' }
  if (/exited with code|process exited|closed unexpectedly|spawn/i.test(value))
    return { kind: 'engine', switchable: true, label: '引擎异常退出' }
  return value && value !== '未知错误'
    ? { kind: 'execution', switchable: false, label: '执行错误' }
    : { kind: 'unknown', switchable: false, label: '未知错误' }
}

export function _resetProviderHealthCacheForTest(): void {
  cache = null
  halfOpenInFlight.clear()
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
      probeSuccesses: 0,
      probeFailures: 0,
      circuitState: 'closed',
      halfOpenSuccesses: 0,
      circuitTotalRequests: 0,
      circuitFailedRequests: 0,
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
  const circuitState = normalizeCircuitState(raw.circuitState, consecutiveFailures, circuitConfigFor(providerId))
  const health: ProviderHealth = {
    providerId,
    successes: nonNegativeInt(raw.successes),
    failures: nonNegativeInt(raw.failures),
    consecutiveFailures,
    probeSuccesses: nonNegativeInt(raw.probeSuccesses),
    probeFailures: nonNegativeInt(raw.probeFailures),
    lastProbeLatencyMs: positiveNumber(raw.lastProbeLatencyMs),
    lastProbeError: optionalString(raw.lastProbeError)
      ? sanitizeFailureMessage(optionalString(raw.lastProbeError))
      : undefined,
    lastProbeSuccessAt: positiveNumber(raw.lastProbeSuccessAt),
    lastProbeFailureAt: positiveNumber(raw.lastProbeFailureAt),
    lastLatencyMs: positiveNumber(raw.lastLatencyMs),
    latencyEmaMs: positiveNumber(raw.latencyEmaMs),
    lastError: storedLastError ? sanitizeFailureMessage(storedLastError) : undefined,
    lastSuccessAt: positiveNumber(raw.lastSuccessAt),
    lastFailureAt: positiveNumber(raw.lastFailureAt),
    lastUsedAt: positiveNumber(raw.lastUsedAt),
    circuitState,
    circuitOpenedAt: positiveNumber(raw.circuitOpenedAt),
    halfOpenSuccesses: nonNegativeInt(raw.halfOpenSuccesses),
    circuitTotalRequests: nonNegativeInt(raw.circuitTotalRequests),
    circuitFailedRequests: nonNegativeInt(raw.circuitFailedRequests),
    recentFailures,
    healthy: circuitState !== 'open'
  }
  if (health.circuitState === 'open' && !health.circuitOpenedAt) health.circuitOpenedAt = health.lastFailureAt
  return health
}

function refreshCircuitState(health: ProviderHealth, now: number): boolean {
  if (health.circuitState !== 'open' || !health.circuitOpenedAt) return false
  if (now - health.circuitOpenedAt < circuitConfigFor(health.providerId).timeoutSeconds * 1000) return false
  transitionToHalfOpen(health)
  return true
}

function transitionToOpen(health: ProviderHealth, now: number): void {
  health.circuitState = 'open'
  health.circuitOpenedAt = now
  health.consecutiveFailures = 0
  health.halfOpenSuccesses = 0
  health.healthy = false
  halfOpenInFlight.delete(health.providerId)
}

function transitionToHalfOpen(health: ProviderHealth): void {
  health.circuitState = 'half_open'
  health.halfOpenSuccesses = 0
  health.healthy = true
  halfOpenInFlight.delete(health.providerId)
}

function transitionToClosed(health: ProviderHealth): void {
  health.circuitState = 'closed'
  delete health.circuitOpenedAt
  health.consecutiveFailures = 0
  health.halfOpenSuccesses = 0
  health.circuitTotalRequests = 0
  health.circuitFailedRequests = 0
  health.healthy = true
  halfOpenInFlight.delete(health.providerId)
}

function normalizeCircuitState(
  value: unknown,
  consecutiveFailures: number,
  config: ProviderCircuitBreakerSettings
): ProviderCircuitState {
  if (value === 'closed' || value === 'open' || value === 'half_open') return value
  return consecutiveFailures >= config.failureThreshold ? 'open' : 'closed'
}

function circuitConfigFor(providerId: string): ProviderCircuitBreakerSettings {
  return providerCircuitConfigs.get(key(providerId)) ?? circuitConfig
}

function normalizeCircuitConfig(value: ProviderCircuitBreakerSettings): ProviderCircuitBreakerSettings {
  return {
    failureThreshold: boundedInt(value?.failureThreshold, 1, 20, DEFAULT_PROVIDER_CIRCUIT_BREAKER.failureThreshold),
    successThreshold: boundedInt(value?.successThreshold, 1, 10, DEFAULT_PROVIDER_CIRCUIT_BREAKER.successThreshold),
    timeoutSeconds: boundedInt(value?.timeoutSeconds, 0, 300, DEFAULT_PROVIDER_CIRCUIT_BREAKER.timeoutSeconds),
    errorRateThreshold: boundedNumber(
      value?.errorRateThreshold,
      0.01,
      1,
      DEFAULT_PROVIDER_CIRCUIT_BREAKER.errorRateThreshold
    ),
    minRequests: boundedInt(value?.minRequests, 1, 100, DEFAULT_PROVIDER_CIRCUIT_BREAKER.minRequests)
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
  const compact = redactProviderErrorText(error ?? '未知错误').replace(/\s+/g, ' ').trim().slice(0, 500)
  return compact
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(boundedNumber(value, min, max, fallback))
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, numeric))
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
    'protocol_unavailable',
    'auth',
    'forbidden',
    'server',
    'network',
    'engine',
    'execution',
    'unknown'
  ].includes(typeof value === 'string' ? value : '')
}
