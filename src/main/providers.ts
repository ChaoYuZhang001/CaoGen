import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  OpenAIProtocol,
  Provider,
  ProviderInput,
  ProviderModelErrorKind,
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderView
} from '../shared/types'

let cache: Provider[] | null = null
const modelFetchCache = new Map<string, { models: string[]; fetchedAt: number; baseUrl: string; providerId?: string }>()

function providersFile(): string {
  return join(app.getPath('userData'), 'providers.json')
}

function load(): Provider[] {
  if (cache) return cache
  const file = providersFile()
  const firstRun = !existsSync(file)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    cache = Array.isArray(raw) ? (raw as Provider[]) : []
  } catch {
    cache = []
    if (firstRun) persist()
  }
  return cache
}

function persist(): void {
  try {
    mkdirSync(dirname(providersFile()), { recursive: true })
    writeFileSync(providersFile(), JSON.stringify(cache ?? [], null, 2))
  } catch (err) {
    console.error('[agent-desk] 保存 Provider 失败:', err)
  }
}

/** 明文 token → 加密串(safeStorage 不可用时退回 base64,并标记前缀) */
function encryptToken(token: string): string {
  if (!token) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(token).toString('base64')}`
  }
  // 退化路径:仅 base64(明确标记,便于排查),不至于明文落盘
  return `b64:${Buffer.from(token, 'utf8').toString('base64')}`
}

/** 加密串 → 明文 token,仅在主进程注入 SDK env 时使用,不回传渲染进程 */
export function decryptToken(encrypted: string): string {
  if (!encrypted) return ''
  try {
    if (encrypted.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(encrypted.slice(4), 'base64'))
    }
    if (encrypted.startsWith('b64:')) {
      return Buffer.from(encrypted.slice(4), 'base64').toString('utf8')
    }
  } catch (err) {
    console.error('[agent-desk] 解密 Provider token 失败:', err)
  }
  return ''
}

function toView(p: Provider): ProviderView {
  const { encryptedToken, ...rest } = p
  return { ...rest, budgetUsd: normalizeBudget(p.budgetUsd), hasToken: encryptedToken.length > 0 }
}

export function listProviders(): ProviderView[] {
  return load().map(toView)
}

/** 主进程内部用:取完整 Provider(含加密 token) */
export function getProvider(id: string): Provider | undefined {
  return load().find((p) => p.id === id)
}

/**
 * 已知厂商端点的 Anthropic 兼容 API 在 /anthropic 子路径下(如 DeepSeek/Kimi/智谱)。
 * 用户常误填裸域名(如 https://api.deepseek.com),导致 SDK 打到 /v1/messages
 * 而非 /anthropic/v1/messages,对话必然失败。此处防御性补全 /anthropic 后缀。
 */
const ANTHROPIC_SUBPATH_HOSTS = [
  'api.deepseek.com',
  'api.moonshot.cn',
  'api.moonshot.ai',
  'open.bigmodel.cn' // 智谱 GLM
]

function normalizeBaseUrl(baseUrl: string, openaiProtocol?: OpenAIProtocol): string {
  const url = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return url
  // chat 协议走 OpenAI 引擎的 /v1/chat/completions,裸域名才是对的;
  // /anthropic 补全仅服务 Claude 引擎的 Anthropic 兼容路径。
  if (openaiProtocol === 'chat') return url
  try {
    const parsed = new URL(url)
    const needsSubpath = ANTHROPIC_SUBPATH_HOSTS.some((h) => parsed.host === h)
    if (needsSubpath && !/\/anthropic($|\/)/.test(parsed.pathname)) {
      return `${url}/anthropic`
    }
  } catch {
    // 非法 URL 原样返回,交由后续请求报错
  }
  return url
}

export function createProvider(input: ProviderInput): ProviderView {
  const provider: Provider = {
    id: randomUUID(),
    name: input.name,
    baseUrl: normalizeBaseUrl(input.baseUrl, input.openaiProtocol),
    encryptedToken: encryptToken(input.token),
    models: input.models,
    customHeaders: input.customHeaders,
    budgetUsd: normalizeBudget(input.budgetUsd),
    openaiProtocol: input.openaiProtocol,
    note: input.note,
    createdAt: Date.now()
  }
  cache = [...load(), provider]
  persist()
  return toView(provider)
}

export function updateProvider(id: string, patch: Partial<ProviderInput>): ProviderView {
  const list = load()
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1) throw new Error('Provider 不存在')
  const prev = list[idx]
  const next: Provider = {
    ...prev,
    name: patch.name ?? prev.name,
    baseUrl: patch.baseUrl === undefined ? prev.baseUrl : normalizeBaseUrl(patch.baseUrl, patch.openaiProtocol ?? prev.openaiProtocol),
    models: patch.models ?? prev.models,
    customHeaders: patch.customHeaders ?? prev.customHeaders,
    budgetUsd: patch.budgetUsd === undefined ? normalizeBudget(prev.budgetUsd) : normalizeBudget(patch.budgetUsd),
    openaiProtocol: patch.openaiProtocol ?? prev.openaiProtocol,
    note: patch.note ?? prev.note,
    encryptedToken: patch.token === undefined ? prev.encryptedToken : encryptToken(patch.token)
  }
  cache = [...list.slice(0, idx), next, ...list.slice(idx + 1)]
  persist()
  return toView(next)
}

function normalizeBudget(value: unknown): number {
  if (value === undefined || value === null) return 0
  const budget = Number(value)
  return Number.isFinite(budget) && budget > 0 ? budget : 0
}

export function deleteProvider(id: string): void {
  cache = load().filter((p) => p.id !== id)
  persist()
}

/**
 * 用 API key 从端点拉取模型列表(GET {baseUrl}/v1/models)。
 * 同时带 x-api-key 与 Authorization: Bearer,兼容 Anthropic / OpenAI 两种鉴权。
 * token 显式传入(新建时),或经 providerId 取已存密钥(编辑时)。
 */
/** 从一个候选 URL 拉模型;返回 null 表示该 URL 不适用(404/JSON 非法),交由下一候选 */
async function tryFetchModelsFrom(url: string, token: string): Promise<string[] | null> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'x-api-key': token,
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01'
      }
    })
  } catch (err) {
    throw modelFetchError('network', `连接失败:${errText(err)}`)
  }
  // 401/403 是鉴权问题,不是端点不对 —— 直接抛,别再试其它候选
  if (res.status === 401 || res.status === 403) {
    throw modelFetchError('auth', `端点返回 ${res.status}(密钥无效或权限不足)`, res.status)
  }
  if (res.status === 429) throw modelFetchError('rate_limit', '端点返回 429(限流或余额不足)', res.status)
  if (res.status >= 500) throw modelFetchError('server', `端点返回 ${res.status}(网关或上游服务错误)`, res.status)
  if (res.status === 404) return null // 此路径无模型端点,试下一候选
  if (!res.ok) return null
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return null
  }
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as Record<string, unknown>)?.data)
      ? ((json as Record<string, unknown>).data as unknown[])
      : []
  const ids = arr
    .map((m) => {
      const o = m as Record<string, unknown> | string
      if (typeof o === 'string') return o
      return typeof o?.id === 'string' ? o.id : ''
    })
    .filter(Boolean)
  return ids.length > 0 ? [...new Set(ids)] : null
}

/**
 * 用 API key 拉取模型列表。按多个候选端点依次尝试,兼容不同厂商布局:
 * - Anthropic 兼容:{base}/v1/models
 * - OpenAI 风格 / 部分厂商(如 DeepSeek):{base}/models
 * - base 含 /anthropic 子路径时(如 https://api.deepseek.com/anthropic),
 *   模型列表常在根域:{root}/v1/models、{root}/models
 * 401/403 立即抛(密钥问题);全部 404/无果才报"端点不支持"。
 */
export async function fetchModels(opts: ProviderModelFetchInput): Promise<ProviderModelFetchResult> {
  const base = (opts.baseUrl || '').trim().replace(/\/+$/, '')
  const providerId = opts.providerId?.trim() || undefined
  const publicBaseUrl = redactBaseUrl(base)
  const cacheKey = providerModelCacheKey(providerId, base, opts.openaiProtocol)
  if (!base) {
    const result = failureModelFetchResult(cacheKey, providerId, publicBaseUrl, 'not_found', '请先填写 Base URL')
    modelFetchCache.delete(cacheKey)
    return result
  }
  let token = opts.token?.trim() || ''
  if (!token && opts.providerId) {
    const p = getProvider(opts.providerId)
    if (p) token = decryptToken(p.encryptedToken)
  }
  if (!token) {
    const result = failureModelFetchResult(cacheKey, providerId, publicBaseUrl, 'auth', '请先填写 API 密钥')
    modelFetchCache.delete(cacheKey)
    return result
  }

  // 候选端点(去重,保序)
  const root = base.replace(/\/anthropic$/, '')
  const candidates = [...new Set([`${base}/v1/models`, `${base}/models`, `${root}/v1/models`, `${root}/models`])]

  try {
    for (const url of candidates) {
      const models = await tryFetchModelsFrom(url, token) // 401/403/429/5xx/network 会向上抛
      if (models) {
        const fetchedAt = Date.now()
        modelFetchCache.set(cacheKey, { models, fetchedAt, baseUrl: publicBaseUrl, providerId })
        return {
          ok: true,
          providerId,
          baseUrl: publicBaseUrl,
          cacheKey,
          models,
          fetchedAt,
          stale: false
        }
      }
    }
  } catch (err) {
    const tagged = taggedModelFetchError(err)
    modelFetchCache.delete(cacheKey)
    return failureModelFetchResult(cacheKey, providerId, publicBaseUrl, tagged.kind, tagged.message, tagged.status)
  }
  modelFetchCache.delete(cacheKey)
  return failureModelFetchResult(
    cacheKey,
    providerId,
    publicBaseUrl,
    'not_found',
    '未能获取模型列表:该端点可能不提供 /models 接口,请手动填写模型名'
  )
}

function providerModelCacheKey(providerId: string | undefined, baseUrl: string, protocol?: OpenAIProtocol): string {
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

function failureModelFetchResult(
  cacheKey: string,
  providerId: string | undefined,
  baseUrl: string,
  kind: ProviderModelErrorKind,
  message: string,
  status?: number
): ProviderModelFetchResult {
  return {
    ok: false,
    providerId,
    baseUrl,
    cacheKey,
    models: [],
    stale: true,
    error: {
      kind,
      message,
      status,
      providerId,
      baseUrl
    }
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
