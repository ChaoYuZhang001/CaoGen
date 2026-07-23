import type {
  OpenAIProtocol,
  ProviderModelErrorKind,
  ProviderModelFetchInput,
  ProviderModelFetchResult
} from '../../shared/types'
import { inspectProviderBaseUrl } from '../providerCredentialBroker'

interface ModelDiscoveryCredentials {
  token: string
  customHeaderRejections: string[]
  headers: Record<string, string>
}

interface ModelDiscoveryHealth {
  success(providerId: string, latencyMs: number): void
  failure(providerId: string, message: string): void
}

interface ModelDiscoveryContext {
  startedAt: number
  providerId?: string
  base: string
  publicBaseUrl: string
  cacheKey: string
  rejectedBaseUrlNames: string[]
}

type ResolveModelDiscoveryCredentials = (providerId: string | undefined) => ModelDiscoveryCredentials

const modelFetchCache = new Map<
  string,
  { models: string[]; fetchedAt: number; baseUrl: string; providerId?: string }
>()

export async function discoverProviderModels(
  opts: ProviderModelFetchInput,
  resolveCredentials: ResolveModelDiscoveryCredentials,
  health: ModelDiscoveryHealth
): Promise<ProviderModelFetchResult> {
  const context = createModelDiscoveryContext(opts)
  const invalidBase = invalidBaseUrlResult(context, health)
  if (invalidBase) return invalidBase

  const credentials = resolveCredentials(context.providerId)
  const invalidCredentials = invalidCredentialResult(context, credentials, health)
  if (invalidCredentials) return invalidCredentials

  try {
    const models = await fetchFirstModelList(context.base, credentials)
    if (models) return successfulModelFetchResult(context, models, health)
  } catch (err) {
    const tagged = taggedModelFetchError(err)
    return failedModelFetchResult(context, tagged.kind, tagged.message, health, tagged.status)
  }
  return failedModelFetchResult(
    context,
    'not_found',
    '未能获取模型列表:该端点可能不提供 /models 接口,请手动填写模型名',
    health
  )
}

export function parseProviderHeaderLines(value: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const colonIndex = line.indexOf(':')
    if (colonIndex <= 0) continue
    const name = line.slice(0, colonIndex).trim()
    const headerValue = line.slice(colonIndex + 1).trim()
    if (name) headers[name] = headerValue
  }
  return headers
}

function createModelDiscoveryContext(opts: ProviderModelFetchInput): ModelDiscoveryContext {
  const startedAt = Date.now()
  const rawBase = (opts.baseUrl || '').trim().replace(/\/+$/, '')
  const inspectedBase = inspectProviderBaseUrl(rawBase)
  const base = inspectedBase.safeValue.trim().replace(/\/+$/, '')
  const providerId = opts.providerId?.trim() || undefined
  return {
    startedAt,
    providerId,
    base,
    publicBaseUrl: redactBaseUrl(base),
    cacheKey: providerModelCacheKey(providerId, base, opts.openaiProtocol),
    rejectedBaseUrlNames: inspectedBase.rejectedNames
  }
}

function invalidBaseUrlResult(
  context: ModelDiscoveryContext,
  health: ModelDiscoveryHealth
): ProviderModelFetchResult | null {
  if (context.rejectedBaseUrlNames.length > 0) {
    return failedModelFetchResult(
      context,
      'gateway',
      `Base URL 包含不允许的凭据或参数: ${context.rejectedBaseUrlNames.join(', ')}`,
      health
    )
  }
  return context.base
    ? null
    : failedModelFetchResult(context, 'not_found', '请先填写 Base URL', health)
}

function invalidCredentialResult(
  context: ModelDiscoveryContext,
  credentials: ModelDiscoveryCredentials,
  health: ModelDiscoveryHealth
): ProviderModelFetchResult | null {
  if (/[\0-\x1F\x7F]/.test(credentials.token)) {
    return failedModelFetchResult(context, 'auth', 'API 密钥格式无效', health)
  }
  if (credentials.customHeaderRejections.length > 0) {
    return failedModelFetchResult(
      context,
      'gateway',
      `自定义请求头无效或包含凭据: ${credentials.customHeaderRejections.join(', ')}`,
      health
    )
  }
  return credentials.token
    ? null
    : failedModelFetchResult(context, 'auth', '请先填写 API 密钥', health)
}

async function fetchFirstModelList(
  base: string,
  credentials: ModelDiscoveryCredentials
): Promise<string[] | null> {
  for (const url of modelEndpointCandidates(base)) {
    const models = await tryFetchModelsFrom(url, credentials.token, credentials.headers)
    if (models) return models
  }
  return null
}

function modelEndpointCandidates(base: string): string[] {
  const root = base.replace(/\/anthropic$/, '')
  return [...new Set([`${base}/v1/models`, `${base}/models`, `${root}/v1/models`, `${root}/models`])]
}

async function tryFetchModelsFrom(
  url: string,
  token: string,
  headers: Record<string, string>
): Promise<string[] | null> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        'x-api-key': token,
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        ...headers
      }
    })
  } catch (err) {
    throw modelFetchError('network', `连接失败:${errText(err)}`)
  }
  assertUsableModelResponse(response)
  if (response.status === 404 || !response.ok) return null
  const json = await parseModelResponse(response)
  return modelIds(json)
}

function assertUsableModelResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw modelFetchError('auth', `端点返回 ${response.status}(密钥无效或权限不足)`, response.status)
  }
  if (response.status === 429) {
    throw modelFetchError('rate_limit', '端点返回 429(限流或余额不足)', response.status)
  }
  if (response.status >= 500) {
    throw modelFetchError('server', `端点返回 ${response.status}(网关或上游服务错误)`, response.status)
  }
}

async function parseModelResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function modelIds(json: unknown): string[] | null {
  const records = Array.isArray(json)
    ? json
    : Array.isArray((json as Record<string, unknown>)?.data)
      ? ((json as Record<string, unknown>).data as unknown[])
      : []
  const ids = records.map(modelId).filter(Boolean)
  return ids.length > 0 ? [...new Set(ids)] : null
}

function modelId(model: unknown): string {
  if (typeof model === 'string') return model
  const record = model as Record<string, unknown> | null
  return typeof record?.id === 'string' ? record.id : ''
}

function successfulModelFetchResult(
  context: ModelDiscoveryContext,
  models: string[],
  health: ModelDiscoveryHealth
): ProviderModelFetchResult {
  const fetchedAt = Date.now()
  const latencyMs = fetchedAt - context.startedAt
  modelFetchCache.set(context.cacheKey, {
    models,
    fetchedAt,
    baseUrl: context.publicBaseUrl,
    providerId: context.providerId
  })
  if (context.providerId) health.success(context.providerId, latencyMs)
  return {
    ok: true,
    providerId: context.providerId,
    baseUrl: context.publicBaseUrl,
    cacheKey: context.cacheKey,
    models,
    fetchedAt,
    latencyMs,
    stale: false
  }
}

function failedModelFetchResult(
  context: ModelDiscoveryContext,
  kind: ProviderModelErrorKind,
  message: string,
  health: ModelDiscoveryHealth,
  status?: number
): ProviderModelFetchResult {
  const latencyMs = Date.now() - context.startedAt
  if (context.providerId) health.failure(context.providerId, message)
  modelFetchCache.delete(context.cacheKey)
  return {
    ok: false,
    providerId: context.providerId,
    baseUrl: context.publicBaseUrl,
    cacheKey: context.cacheKey,
    models: [],
    latencyMs,
    stale: true,
    error: {
      kind,
      message,
      status,
      providerId: context.providerId,
      baseUrl: context.publicBaseUrl
    }
  }
}

function providerModelCacheKey(
  providerId: string | undefined,
  baseUrl: string,
  protocol?: OpenAIProtocol
): string {
  return [providerId || 'new-provider', normalizeCacheBaseUrl(baseUrl), protocol || 'default'].join('|')
}

function normalizeCacheBaseUrl(value: string): string {
  const clean = (value || '').trim().replace(/\/+$/, '')
  try {
    const url = new URL(clean)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return clean
  }
}

function redactBaseUrl(value: string): string {
  const clean = (value || '').trim().replace(/\/+$/, '')
  try {
    const url = new URL(clean)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return clean.replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&]+/gi, '$1[redacted]')
  }
}

function modelFetchError(kind: ProviderModelErrorKind, message: string, status?: number): Error {
  const err = new Error(message) as Error & { kind?: ProviderModelErrorKind; status?: number }
  err.kind = kind
  err.status = status
  return err
}

function taggedModelFetchError(err: unknown): { kind: ProviderModelErrorKind; message: string; status?: number } {
  const record = err as { kind?: ProviderModelErrorKind; status?: number; message?: string } | null
  if (record?.kind) {
    return {
      kind: record.kind,
      message: record.message || '模型列表获取失败',
      status: record.status
    }
  }
  return { kind: 'unknown', message: errText(err) }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
