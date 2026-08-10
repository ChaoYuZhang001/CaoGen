import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseToml } from '@iarna/toml'
import type {
  EngineKind,
  OpenAIProtocol,
  ProviderAdvancedConfig,
  ProviderInput,
  ProviderModelProfile,
  ProviderRuntimeConfig
} from '../../shared/types'
import type { ProviderReliabilityConfig } from '../../shared/provider-reliability-types'
import { ccSwitchSourceProviderId } from './ccSwitchIdentity'
import type { CcSwitchImportWarning, CcSwitchPricingRecord, CcSwitchSourceApp } from '../../shared/cc-switch-import-types'
import { normalizeModelIdForPricing } from '../../shared/provider-pricing-catalog'
import { normalizeBaseUrl } from './providerBaseUrl'

const MAX_DATABASE_BYTES = 512 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
const SUPPORTED_SOURCE_APPS = new Set<CcSwitchSourceApp>(['claude', 'codex'])

interface ProviderRow {
  id: string
  appType: CcSwitchSourceApp
  name: string
  settingsConfig: string
  notes?: string
  meta: string
  costMultiplier: string
  dailyLimit?: string
  monthlyLimit?: string
}

interface EndpointRow {
  providerId: string
  appType: string
  url: string
}

interface ProxyPolicyRow {
  appType: CcSwitchSourceApp
  reliability: ProviderReliabilityConfig
  warnings: CcSwitchImportWarning[]
}

export interface CcSwitchParsedProvider {
  sourceId: string
  sourceApp: CcSwitchSourceApp
  input?: ProviderInput
  token?: string
  dailyLimitUsd?: number
  costMultiplier: number
  pricedModelCount: number
  warnings: CcSwitchImportWarning[]
}

export interface CcSwitchSourceSnapshot {
  sourceDigest: string
  providerCount: number
  pricingCount: number
  providers: CcSwitchParsedProvider[]
}

export function readCcSwitchSourceSnapshot(): CcSwitchSourceSnapshot {
  const databasePath = ccSwitchDatabasePath()
  assertDatabaseFile(databasePath)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec('PRAGMA query_only = ON')
    const providerRows = readProviderRows(database)
    const endpointRows = readEndpointRows(database)
    const proxyPolicies = readProxyPolicies(database)
    const pricing = readPricing(database)
    const pricingByModel = new Map(pricing.map((entry) => [normalizeModelIdForPricing(entry.model), entry]))
    const policyByApp = new Map(proxyPolicies.map((policy) => [policy.appType, policy]))
    const providers = providerRows.map((row) => parseProvider(row, endpointRows, pricingByModel, policyByApp.get(row.appType)))
    return {
      sourceDigest: digest({ providerRows, endpointRows, proxyPolicies, pricing }),
      providerCount: providerRows.length,
      pricingCount: pricing.length,
      providers
    }
  } finally {
    database.close()
  }
}

function readProxyPolicies(database: DatabaseSync): ProxyPolicyRow[] {
  const exists = database.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'proxy_config'
  `).get() as Record<string, unknown> | undefined
  if (!exists) return []
  const rows = database.prepare(`
    SELECT app_type, proxy_enabled, listen_address, listen_port, enable_logging, enabled,
      auto_failover_enabled, max_retries, streaming_first_byte_timeout, streaming_idle_timeout,
      non_streaming_timeout, circuit_failure_threshold, circuit_success_threshold,
      circuit_timeout_seconds, circuit_error_rate_threshold, circuit_min_requests,
      live_takeover_active
    FROM proxy_config
    WHERE app_type IN ('claude', 'codex')
    ORDER BY app_type
  `).all() as Record<string, unknown>[]
  return rows.flatMap((row) => {
    const appType = text(row.app_type)
    if (!SUPPORTED_SOURCE_APPS.has(appType as CcSwitchSourceApp)) return []
    const warnings: CcSwitchImportWarning[] = []
    if (text(row.listen_address) || positiveInteger(row.listen_port, 65_535) !== undefined) {
      warnings.push('proxy_listener_not_imported')
    }
    if (sqliteBoolean(row.proxy_enabled) || sqliteBoolean(row.enabled) || sqliteBoolean(row.live_takeover_active)) {
      warnings.push('proxy_takeover_not_imported', 'proxy_transform_not_supported')
    }
    if (sqliteBoolean(row.enable_logging)) warnings.push('proxy_logging_not_imported')
    const streamingFirstByteTimeoutSeconds = positiveInteger(row.streaming_first_byte_timeout, 3_600)
    const streamingIdleTimeoutSeconds = positiveInteger(row.streaming_idle_timeout, 3_600)
    const circuitBreaker = circuitPolicy(row)
    return [{
      appType: appType as CcSwitchSourceApp,
      reliability: {
        failoverEnabled: sqliteBoolean(row.auto_failover_enabled),
        maxRetries: nonNegativeInteger(row.max_retries, 20),
        streamingFirstByteTimeoutSeconds,
        streamingIdleTimeoutSeconds,
        requestTimeoutSeconds: positiveInteger(row.non_streaming_timeout, 3_600),
        ...(circuitBreaker ? { circuitBreaker } : {})
      },
      warnings: unique(warnings)
    }]
  })
}

function circuitPolicy(row: Record<string, unknown>): ProviderReliabilityConfig['circuitBreaker'] | undefined {
  const failureThreshold = positiveInteger(row.circuit_failure_threshold, 20)
  const successThreshold = positiveInteger(row.circuit_success_threshold, 10)
  const timeoutSeconds = nonNegativeInteger(row.circuit_timeout_seconds, 300)
  const errorRateThreshold = ranged(row.circuit_error_rate_threshold, 0.01, 1)
  const minRequests = positiveInteger(row.circuit_min_requests, 100)
  if (failureThreshold === undefined || successThreshold === undefined || timeoutSeconds === undefined
    || errorRateThreshold === undefined || minRequests === undefined) return undefined
  return { failureThreshold, successThreshold, timeoutSeconds, errorRateThreshold, minRequests }
}

function readProviderRows(database: DatabaseSync): ProviderRow[] {
  const rows = database.prepare(`
    SELECT id, app_type, name, settings_config, notes, meta,
      cost_multiplier, limit_daily_usd, limit_monthly_usd
    FROM providers
    WHERE app_type IN ('claude', 'codex')
    ORDER BY app_type, sort_index, id
  `).all() as Record<string, unknown>[]
  return rows.map((row) => {
    const appType = text(row.app_type)
    if (!SUPPORTED_SOURCE_APPS.has(appType as CcSwitchSourceApp)) throw new Error('CC Switch provider app type is unsupported')
    return {
      id: requiredText(row.id, 'provider id'),
      appType: appType as CcSwitchSourceApp,
      name: requiredText(row.name, 'provider name'),
      settingsConfig: boundedText(row.settings_config, 'provider settings'),
      notes: optionalText(row.notes),
      meta: boundedText(row.meta, 'provider metadata'),
      costMultiplier: text(row.cost_multiplier) || '1',
      dailyLimit: optionalText(row.limit_daily_usd),
      monthlyLimit: optionalText(row.limit_monthly_usd)
    }
  })
}

function readEndpointRows(database: DatabaseSync): EndpointRow[] {
  const rows = database.prepare(`
    SELECT provider_id, app_type, url
    FROM provider_endpoints
    WHERE app_type IN ('claude', 'codex')
    ORDER BY provider_id, app_type, id
  `).all() as Record<string, unknown>[]
  return rows.map((row) => ({
    providerId: requiredText(row.provider_id, 'endpoint provider id'),
    appType: requiredText(row.app_type, 'endpoint app type'),
    url: requiredText(row.url, 'endpoint URL')
  }))
}

function readPricing(database: DatabaseSync): CcSwitchPricingRecord[] {
  const rows = database.prepare(`
    SELECT model_id, display_name, input_cost_per_million, output_cost_per_million,
      cache_read_cost_per_million, cache_creation_cost_per_million
    FROM model_pricing
    ORDER BY model_id
  `).all() as Record<string, unknown>[]
  return rows.flatMap((row) => {
    const model = text(row.model_id)
    const input = nonNegative(row.input_cost_per_million)
    const output = nonNegative(row.output_cost_per_million)
    if (!model || input === undefined || output === undefined) return []
    return [{
      model,
      displayName: optionalText(row.display_name),
      pricing: {
        currency: 'USD' as const,
        inputPerMillion: input,
        outputPerMillion: output,
        cacheReadPerMillion: nonNegative(row.cache_read_cost_per_million),
        cacheWritePerMillion: nonNegative(row.cache_creation_cost_per_million),
        source: 'user' as const
      }
    }]
  })
}

function parseProvider(
  row: ProviderRow,
  endpoints: EndpointRow[],
  pricingByModel: Map<string, CcSwitchPricingRecord>,
  proxyPolicy: ProxyPolicyRow | undefined
): CcSwitchParsedProvider {
  const settings = parseJsonRecord(row.settingsConfig, 'provider settings')
  const meta = parseJsonRecord(row.meta, 'provider metadata')
  const parsed = row.appType === 'codex'
    ? parseCodexSettings(settings, meta)
    : parseClaudeSettings(settings, meta)
  const dailyLimitUsd = positive(row.dailyLimit)
  const monthlyLimitUsd = positive(row.monthlyLimit)
  const costMultiplier = positive(row.costMultiplier) ?? 1
  const warnings: CcSwitchImportWarning[] = [...parsed.warnings, ...(proxyPolicy?.warnings ?? [])]
  if (!parsed.token) warnings.push('credential_missing')
  if (dailyLimitUsd !== undefined) warnings.push('daily_limit_not_enforced')
  if (!parsed.baseUrl) {
    warnings.push('empty_provider_config')
    return {
      sourceId: sourceItemId(row),
      sourceApp: row.appType,
      dailyLimitUsd,
      costMultiplier,
      pricedModelCount: 0,
      warnings: unique(warnings)
    }
  }
  const baseUrl = normalizeBaseUrl(parsed.baseUrl, parsed.engine, parsed.openaiProtocol)
  const modelProfiles = buildModelProfiles(parsed.models, pricingByModel, costMultiplier)
  const endpointProfiles = endpoints
    .filter((endpoint) => endpoint.providerId === row.id && endpoint.appType === row.appType)
    .flatMap((endpoint, index) => {
      try {
        return [{ id: `cc-switch-${index + 1}`, url: normalizeBaseUrl(endpoint.url, parsed.engine, parsed.openaiProtocol) }]
      } catch {
        return []
      }
    })
  const advancedConfig: ProviderAdvancedConfig = {
    schemaVersion: 1,
    ...(endpointProfiles.length > 0 ? { endpoints: endpointProfiles } : {}),
    ...(modelProfiles.length > 0 ? { modelProfiles } : {}),
    ...(parsed.runtime ? { runtime: parsed.runtime } : {}),
    ...(proxyPolicy ? { reliability: proxyPolicy.reliability } : {}),
    metadata: {
      importedFrom: 'cc-switch',
      sourceApp: row.appType,
      sourceProviderId: sourceItemId(row),
      costMultiplier: String(costMultiplier),
      ...(dailyLimitUsd === undefined ? {} : { sourceDailyLimitUsd: String(dailyLimitUsd) })
    }
  }
  return {
    sourceId: sourceItemId(row),
    sourceApp: row.appType,
    input: {
      name: row.name,
      baseUrl,
      models: parsed.models,
      engine: parsed.engine,
      openaiProtocol: parsed.openaiProtocol,
      authMode: 'api-key',
      budgetUsd: monthlyLimitUsd,
      note: row.notes,
      advancedConfig
    },
    token: parsed.token,
    dailyLimitUsd,
    costMultiplier,
    pricedModelCount: modelProfiles.filter((profile) => profile.pricing).length,
    warnings: unique(warnings)
  }
}

function parseCodexSettings(settings: Record<string, unknown>, meta: Record<string, unknown>) {
  const configText = text(settings.config)
  if (!configText) return emptyParsedProvider()
  let config: Record<string, unknown>
  try {
    config = record(parseToml(configText)) ?? {}
  } catch {
    throw new Error('CC Switch Codex provider contains invalid TOML')
  }
  const providerKey = text(config.model_provider)
  const providers = record(config.model_providers)
  const active = providerKey && providers ? record(providers[providerKey]) ?? config : config
  const apiFormat = text(meta.apiFormat)
  const protocol: OpenAIProtocol = apiFormat === 'openai_chat'
    ? 'chat'
    : wireProtocol(text(active.wire_api) || text(config.wire_api))
  const auth = record(settings.auth)
  return {
    baseUrl: text(active.base_url) || text(config.base_url),
    engine: 'openai' as EngineKind,
    openaiProtocol: protocol,
    models: uniqueStrings([text(config.model)]),
    token: text(auth?.OPENAI_API_KEY),
    runtime: codexRuntime(config),
    warnings: [] as CcSwitchImportWarning[]
  }
}

function parseClaudeSettings(settings: Record<string, unknown>, meta: Record<string, unknown>) {
  const env = record(settings.env) ?? {}
  const apiFormat = text(meta.apiFormat)
  const openAi = apiFormat === 'openai_chat' || apiFormat === 'openai_responses'
  return {
    baseUrl: text(env.ANTHROPIC_BASE_URL),
    engine: (openAi ? 'openai' : 'anthropic') as EngineKind,
    openaiProtocol: openAi ? (apiFormat === 'openai_chat' ? 'chat' : 'responses') as OpenAIProtocol : undefined,
    models: uniqueStrings([
      text(env.ANTHROPIC_MODEL),
      text(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      text(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      text(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    ]),
    token: text(env.ANTHROPIC_AUTH_TOKEN) || text(env.ANTHROPIC_API_KEY),
    runtime: undefined,
    warnings: [] as CcSwitchImportWarning[]
  }
}

function emptyParsedProvider() {
  return {
    baseUrl: '',
    engine: 'openai' as EngineKind,
    openaiProtocol: 'responses' as OpenAIProtocol,
    models: [] as string[],
    token: '',
    runtime: undefined,
    warnings: [] as CcSwitchImportWarning[]
  }
}

function buildModelProfiles(
  models: string[],
  pricingByModel: Map<string, CcSwitchPricingRecord>,
  multiplier: number
): ProviderModelProfile[] {
  return models.map((model) => {
    const pricing = pricingByModel.get(normalizeModelIdForPricing(model))
    if (!pricing) return { model }
    return {
      model,
      displayName: pricing.displayName,
      pricing: {
        ...pricing.pricing,
        inputPerMillion: scaled(pricing.pricing.inputPerMillion, multiplier),
        outputPerMillion: scaled(pricing.pricing.outputPerMillion, multiplier),
        cacheReadPerMillion: scaledOptional(pricing.pricing.cacheReadPerMillion, multiplier),
        cacheWritePerMillion: scaledOptional(pricing.pricing.cacheWritePerMillion, multiplier)
      }
    }
  })
}

function codexRuntime(config: Record<string, unknown>): ProviderRuntimeConfig | undefined {
  const disableStorage = bool(config.disable_response_storage)
  const runtime: ProviderRuntimeConfig = {
    reasoningEffort: enumeration(config.model_reasoning_effort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const),
    verbosity: enumeration(config.model_verbosity, ['low', 'medium', 'high'] as const),
    temperature: ranged(config.temperature, 0, 2),
    topP: ranged(config.top_p, 0, 1),
    maxOutputTokens: integer(config.max_output_tokens),
    parallelToolCalls: bool(config.parallel_tool_calls),
    storeResponses: disableStorage === undefined ? undefined : !disableStorage,
    serviceTier: enumeration(config.service_tier, ['auto', 'default', 'flex', 'priority'] as const)
  }
  return Object.values(runtime).some((value) => value !== undefined) ? runtime : undefined
}

function ccSwitchDatabasePath(): string {
  const override = process.env.CAOGEN_CC_SWITCH_HOME?.trim()
  return resolve(override || join(app.getPath('home'), '.cc-switch'), 'cc-switch.db')
}

function assertDatabaseFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error('CC Switch database was not found')
  const info = lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_DATABASE_BYTES) {
    throw new Error('CC Switch database is invalid')
  }
}

function sourceItemId(row: ProviderRow): string {
  return ccSwitchSourceProviderId(row.appType, row.id)
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    const result = record(parsed)
    if (!result) throw new Error('not an object')
    return result
  } catch {
    throw new Error(`CC Switch ${label} is invalid JSON`)
  }
}

function boundedText(value: unknown, label: string): string {
  const result = requiredText(value, label)
  if (Buffer.byteLength(result, 'utf8') > MAX_JSON_BYTES) throw new Error(`CC Switch ${label} is too large`)
  return result
}

function requiredText(value: unknown, label: string): string {
  const result = text(value)
  if (!result) throw new Error(`CC Switch ${label} is missing`)
  return result
}

function optionalText(value: unknown): string | undefined {
  return text(value) || undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function positive(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function nonNegative(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function ranged(value: unknown, minimum: number, maximum: number): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : undefined
}

function integer(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function nonNegativeInteger(value: unknown, maximum: number): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : undefined
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  const number = nonNegativeInteger(value, maximum)
  return number !== undefined && number > 0 ? number : undefined
}

function sqliteBoolean(value: unknown): boolean | undefined {
  return value === 0 ? false : value === 1 ? true : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function enumeration<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return values.includes(value as T) ? value as T : undefined
}

function wireProtocol(value: string): OpenAIProtocol {
  return value === 'chat' || value === 'chat_completions' ? 'chat' : 'responses'
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function scaled(value: number, multiplier: number): number {
  return Math.round(value * multiplier * 1_000_000) / 1_000_000
}

function scaledOptional(value: number | undefined, multiplier: number): number | undefined {
  return value === undefined ? undefined : scaled(value, multiplier)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
