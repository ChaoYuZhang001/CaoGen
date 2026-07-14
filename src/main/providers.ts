import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  EngineKind,
  OpenAIProtocol,
  Provider,
  ProviderApiKey,
  ProviderApiKeyInput,
  ProviderApiKeyUpdateInput,
  ProviderInput,
  ProviderModelErrorKind,
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderView
} from '../shared/types'
import { recordFailure, recordSuccess } from './scheduler'
import { pickNextProviderKey } from './providerKeyRouting'

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

const LEGACY_KEY_LABEL = '主密钥'

function legacyKeyId(providerId: string): string {
  return `${providerId}:legacy-primary`
}

function cleanKeyLabel(value: string | undefined, fallback: string): string {
  const label = value?.trim()
  return label || fallback
}

function createApiKey(input: ProviderApiKeyInput, fallbackLabel: string): ProviderApiKey | null {
  const token = input.token.trim()
  if (!token) return null
  return {
    id: randomUUID(),
    label: cleanKeyLabel(input.label, fallbackLabel),
    encryptedToken: encryptToken(token),
    createdAt: Date.now(),
    disabled: input.disabled === true
  }
}

function normalizedProviderKeys(provider: Provider): ProviderApiKey[] {
  const seen = new Set<string>()
  const keys: ProviderApiKey[] = []
  const storedKeys = Array.isArray(provider.apiKeys) ? provider.apiKeys : []
  for (const [index, key] of storedKeys.entries()) {
    if (!key || typeof key.encryptedToken !== 'string' || !key.encryptedToken) continue
    const id = typeof key.id === 'string' && key.id.trim() ? key.id : randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    keys.push({
      id,
      label: cleanKeyLabel(key.label, `Key ${index + 1}`),
      encryptedToken: key.encryptedToken,
      createdAt: Number.isFinite(key.createdAt) ? key.createdAt : Date.now(),
      lastUsedAt: Number.isFinite(key.lastUsedAt) ? key.lastUsedAt : undefined,
      lastFailureAt: Number.isFinite(key.lastFailureAt) ? key.lastFailureAt : undefined,
      lastFailureReason: typeof key.lastFailureReason === 'string' && key.lastFailureReason.trim()
        ? key.lastFailureReason.trim().slice(0, 80)
        : undefined,
      disabled: key.disabled === true
    })
  }
  if (keys.length === 0 && provider.encryptedToken) {
    keys.push({
      id: legacyKeyId(provider.id),
      label: LEGACY_KEY_LABEL,
      encryptedToken: provider.encryptedToken,
      createdAt: provider.createdAt || Date.now(),
      disabled: false
    })
  }
  return keys
}

function activeProviderKey(provider: Provider, keys = normalizedProviderKeys(provider)): ProviderApiKey | undefined {
  const activeId = provider.activeKeyId?.trim()
  const enabledKeys = keys.filter((key) => key.encryptedToken && !key.disabled)
  return enabledKeys.find((key) => key.id === activeId) ?? enabledKeys[0]
}

function activeKeyIdFor(provider: Provider, keys: ProviderApiKey[], requestedId?: string): string | undefined {
  const activeId = requestedId?.trim() || provider.activeKeyId?.trim()
  const enabledKeys = keys.filter((key) => key.encryptedToken && !key.disabled)
  return enabledKeys.find((key) => key.id === activeId)?.id ?? enabledKeys[0]?.id
}

function applyKeyUpdates(keys: ProviderApiKey[], updates: ProviderApiKeyUpdateInput[] | undefined): ProviderApiKey[] {
  if (!updates || updates.length === 0) return keys
  const byId = new Map(updates.filter((item) => item.id).map((item) => [item.id, item]))
  return keys.map((key, index) => {
    const update = byId.get(key.id)
    if (!update) return key
    return {
      ...key,
      label: update.label === undefined ? key.label : cleanKeyLabel(update.label, `Key ${index + 1}`),
      disabled: update.disabled === undefined ? key.disabled : update.disabled
    }
  })
}

function appendNewKeys(keys: ProviderApiKey[], additions: ProviderApiKeyInput[] | undefined): ProviderApiKey[] {
  if (!additions || additions.length === 0) return keys
  const next = [...keys]
  for (const input of additions) {
    const key = createApiKey(input, `Key ${next.length + 1}`)
    if (key) next.push(key)
  }
  return next
}

function withPrimaryToken(keys: ProviderApiKey[], provider: Provider, patch: Partial<ProviderInput>): ProviderApiKey[] {
  const tokenWasProvided = patch.token !== undefined
  const active = activeProviderKey(provider, keys)
  if (tokenWasProvided) {
    const token = patch.token?.trim() ?? ''
    if (!token) return []
    const nextKey: ProviderApiKey = {
      id: active?.id ?? randomUUID(),
      label: cleanKeyLabel(patch.tokenLabel ?? active?.label, LEGACY_KEY_LABEL),
      encryptedToken: encryptToken(token),
      createdAt: active?.createdAt ?? Date.now(),
      disabled: false
    }
    if (active) return keys.map((key) => key.id === active.id ? nextKey : key)
    return [nextKey, ...keys]
  }
  if (patch.tokenLabel !== undefined && active) {
    return keys.map((key) =>
      key.id === active.id ? { ...key, label: cleanKeyLabel(patch.tokenLabel, LEGACY_KEY_LABEL) } : key
    )
  }
  return keys
}

function providerKeyCount(provider: Provider): number {
  return normalizedProviderKeys(provider).filter((key) => key.encryptedToken && !key.disabled).length
}

export function providerHasToken(provider: Provider | undefined): boolean {
  return provider ? providerKeyCount(provider) > 0 : false
}

/** 取 Provider 当前活动 API Key。只在主进程内部使用,不回传渲染进程。 */
export function decryptProviderToken(provider: Provider | undefined): string {
  return resolveProviderToken(provider).token
}

export interface ProviderTokenSelection {
  providerId?: string
  keyId?: string
  keyLabel?: string
  token: string
}

export interface ProviderKeyRotation {
  providerId: string
  providerName: string
  fromKeyId: string
  fromKeyLabel: string
  toKeyId: string
  toKeyLabel: string
}

export function resolveProviderToken(provider: Provider | undefined): ProviderTokenSelection {
  if (!provider) return { token: '' }
  const active = activeProviderKey(provider)
  return {
    providerId: provider.id,
    keyId: active?.id,
    keyLabel: active?.label,
    token: active ? decryptToken(active.encryptedToken) : ''
  }
}

export function markProviderKeyUsed(providerId: string, keyId: string | undefined, now = Date.now()): void {
  updateProviderKeyRuntime(providerId, keyId, (key) => ({ ...key, lastUsedAt: now }))
}

export function recordProviderKeySuccess(providerId: string, keyId: string | undefined, now = Date.now()): void {
  updateProviderKeyRuntime(providerId, keyId, (key) => {
    const next = { ...key, lastUsedAt: now }
    delete next.lastFailureAt
    delete next.lastFailureReason
    return next
  })
}

export function rotateProviderKey(input: {
  providerId: string
  failedKeyId?: string
  excludedKeyIds?: ReadonlySet<string>
  reason: string
  now?: number
}): ProviderKeyRotation | null {
  const list = load()
  const index = list.findIndex((provider) => provider.id === input.providerId)
  if (index < 0) return null
  const provider = list[index]
  const now = input.now ?? Date.now()
  const keys = normalizedProviderKeys(provider)
  const active = activeProviderKey(provider, keys)
  const failedKeyId = input.failedKeyId || active?.id
  const failed = keys.find((key) => key.id === failedKeyId)
  const marked = keys.map((key) =>
    key.id === failedKeyId
      ? { ...key, lastFailureAt: now, lastFailureReason: input.reason.trim().slice(0, 80) }
      : key
  )
  const next = pickNextProviderKey(marked, {
    activeKeyId: provider.activeKeyId,
    failedKeyId,
    excludedKeyIds: input.excludedKeyIds,
    now
  })
  const nextProvider: Provider = {
    ...provider,
    apiKeys: next ? marked.map((key) => key.id === next.id ? { ...key, lastUsedAt: now } : key) : marked,
    activeKeyId: next?.id ?? provider.activeKeyId,
    encryptedToken: next?.encryptedToken ?? provider.encryptedToken
  }
  cache = [...list.slice(0, index), nextProvider, ...list.slice(index + 1)]
  persist()
  if (!failed || !next) return null
  return {
    providerId: provider.id,
    providerName: provider.name,
    fromKeyId: failed.id,
    fromKeyLabel: failed.label,
    toKeyId: next.id,
    toKeyLabel: next.label
  }
}

function toView(p: Provider): ProviderView {
  const { encryptedToken, apiKeys: _apiKeys, activeKeyId: _activeKeyId, ...rest } = p
  const keys = normalizedProviderKeys(p)
  const active = activeProviderKey(p, keys)
  const apiKeys = keys.map((key) => ({
    id: key.id,
    label: key.label,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    lastFailureAt: key.lastFailureAt,
    lastFailureReason: key.lastFailureReason,
    disabled: key.disabled === true,
    active: active?.id === key.id
  }))
  const keyCount = keys.filter((key) => key.encryptedToken && !key.disabled).length
  return {
    ...rest,
    engine: resolveProviderEngine(p),
    budgetUsd: normalizeBudget(p.budgetUsd),
    hasToken: keyCount > 0,
    keyCount,
    activeKeyId: active?.id,
    activeKeyLabel: active?.label,
    apiKeys
  }
}

function updateProviderKeyRuntime(
  providerId: string,
  keyId: string | undefined,
  update: (key: ProviderApiKey) => ProviderApiKey
): void {
  if (!keyId) return
  const list = load()
  const index = list.findIndex((provider) => provider.id === providerId)
  if (index < 0) return
  const provider = list[index]
  const keys = normalizedProviderKeys(provider)
  if (!keys.some((key) => key.id === keyId)) return
  const apiKeys = keys.map((key) => key.id === keyId ? update(key) : key)
  const active = activeProviderKey({ ...provider, apiKeys }, apiKeys)
  const next = {
    ...provider,
    apiKeys,
    activeKeyId: active?.id,
    encryptedToken: active?.encryptedToken ?? ''
  }
  cache = [...list.slice(0, index), next, ...list.slice(index + 1)]
  persist()
}

export function listProviders(): ProviderView[] {
  return load().map(toView)
}

/** 主进程内部用:取完整 Provider(含加密 token) */
export function getProvider(id: string): Provider | undefined {
  return load().find((p) => p.id === id)
}

export function resolveProviderEngine(provider: Pick<Provider, 'engine' | 'name' | 'baseUrl' | 'models' | 'openaiProtocol'>): EngineKind {
  if (provider.engine === 'claude' || provider.engine === 'openai') return provider.engine
  if (provider.openaiProtocol === 'chat') return 'openai'
  const identity = `${provider.name}\n${provider.baseUrl}\n${provider.models.join('\n')}`.toLowerCase()
  return /anthropic|claude|\/anthropic(?:\/|$)/.test(identity) ? 'claude' : 'openai'
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

function normalizeBaseUrl(baseUrl: string, engine: EngineKind, openaiProtocol?: OpenAIProtocol): string {
  const url = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return url
  // chat 协议走 OpenAI 引擎的 /v1/chat/completions,裸域名才是对的;
  // /anthropic 补全仅服务 Claude 引擎的 Anthropic 兼容路径。
  if (engine === 'openai') return url
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
  const primary = typeof input.token === 'string' && input.token.trim()
    ? createApiKey({ label: input.tokenLabel, token: input.token }, LEGACY_KEY_LABEL)
    : null
  const apiKeys = appendNewKeys(primary ? [primary] : [], input.additionalTokens)
  const activeKeyId = apiKeys.find((key) => key.encryptedToken && !key.disabled)?.id
  const activeKey = apiKeys.find((key) => key.id === activeKeyId)
  const provider: Provider = {
    id: randomUUID(),
    name: input.name,
    baseUrl: normalizeBaseUrl(input.baseUrl, input.engine ?? 'openai', input.openaiProtocol),
    encryptedToken: activeKey?.encryptedToken ?? '',
    apiKeys,
    activeKeyId,
    models: input.models,
    engine: input.engine ?? 'openai',
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
  let apiKeys = normalizedProviderKeys(prev)
  apiKeys = withPrimaryToken(apiKeys, prev, patch)
  apiKeys = applyKeyUpdates(apiKeys, patch.keyUpdates)
  const removeIds = new Set((patch.removeKeyIds ?? []).filter(Boolean))
  if (removeIds.size > 0) apiKeys = apiKeys.filter((key) => !removeIds.has(key.id))
  apiKeys = appendNewKeys(apiKeys, patch.additionalTokens)
  const activeKeyId = activeKeyIdFor(prev, apiKeys, patch.activeKeyId)
  const activeKey = apiKeys.find((key) => key.id === activeKeyId)
  const next: Provider = {
    ...prev,
    name: patch.name ?? prev.name,
    baseUrl: patch.baseUrl === undefined
      ? prev.baseUrl
      : normalizeBaseUrl(patch.baseUrl, patch.engine ?? resolveProviderEngine(prev), patch.openaiProtocol ?? prev.openaiProtocol),
    models: patch.models ?? prev.models,
    engine: patch.engine ?? resolveProviderEngine(prev),
    customHeaders: patch.customHeaders ?? prev.customHeaders,
    budgetUsd: patch.budgetUsd === undefined ? normalizeBudget(prev.budgetUsd) : normalizeBudget(patch.budgetUsd),
    openaiProtocol: patch.openaiProtocol ?? prev.openaiProtocol,
    note: patch.note ?? prev.note,
    encryptedToken: activeKey?.encryptedToken ?? '',
    apiKeys,
    activeKeyId
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
  const startedAt = Date.now()
  const base = (opts.baseUrl || '').trim().replace(/\/+$/, '')
  const providerId = opts.providerId?.trim() || undefined
  const publicBaseUrl = redactBaseUrl(base)
  const cacheKey = providerModelCacheKey(providerId, base, opts.openaiProtocol)
  const finishFailure = (
    kind: ProviderModelErrorKind,
    message: string,
    status?: number
  ): ProviderModelFetchResult => {
    const latencyMs = Date.now() - startedAt
    if (providerId) recordFailure(providerId, message)
    return failureModelFetchResult(cacheKey, providerId, publicBaseUrl, kind, message, status, latencyMs)
  }
  if (!base) {
    const result = finishFailure('not_found', '请先填写 Base URL')
    modelFetchCache.delete(cacheKey)
    return result
  }
  let token = opts.token?.trim() || ''
  if (!token && opts.providerId) {
    const p = getProvider(opts.providerId)
    if (p) token = decryptProviderToken(p)
  }
  if (!token) {
    const result = finishFailure('auth', '请先填写 API 密钥')
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
        const latencyMs = fetchedAt - startedAt
        modelFetchCache.set(cacheKey, { models, fetchedAt, baseUrl: publicBaseUrl, providerId })
        if (providerId) recordSuccess(providerId, latencyMs)
        return {
          ok: true,
          providerId,
          baseUrl: publicBaseUrl,
          cacheKey,
          models,
          fetchedAt,
          latencyMs,
          stale: false
        }
      }
    }
  } catch (err) {
    const tagged = taggedModelFetchError(err)
    modelFetchCache.delete(cacheKey)
    return finishFailure(tagged.kind, tagged.message, tagged.status)
  }
  modelFetchCache.delete(cacheKey)
  return finishFailure(
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
  status?: number,
  latencyMs?: number
): ProviderModelFetchResult {
  return {
    ok: false,
    providerId,
    baseUrl,
    cacheKey,
    models: [],
    latencyMs,
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
